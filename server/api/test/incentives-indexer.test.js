// Incentives indexer: SafetyIncentives events are
// stored idempotently, update incidents/bonds, emit realtime, honour confirmations and
// keep their own checkpoint; pendingSettlement() fills coverage and deadlines.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createIncentivesIndexer, incidentEffect } from '../src/chain/incentives-indexer.js';
import { OPERATOR_BOND_ID } from '../src/chain/incentives.js';
import { DEVICE_ID, createIncidentDb } from './helpers/incident-fixtures.js';
import {
    ASAFE,
    DEFAULT_PARAMS,
    INCENTIVES_ADDRESS,
    KEEPER,
    OWNER,
    createFakeIncentivesChain,
    incidentIncentive,
    insertChainIncident,
    settlementFor,
    silentLog,
} from './helpers/incentive-fixtures.js';

const NOW = 1_900_000_000;
const CONFIG = Object.freeze({ confirmations: 2, logBatchBlocks: 2_000, batchSize: 20, stateRefreshMs: 60_000 });

async function setup() {
    const store = await createIncidentDb();
    const fake = createFakeIncentivesChain({ now: NOW, head: 50 });
    const indexer = createIncentivesIndexer({ db: store, chain: fake.chain, config: CONFIG, startBlock: 10, log: silentLog });
    return { store, fake, indexer };
}

async function withSetup(run) {
    const ctx = await setup();
    try {
        await run(ctx);
    } finally {
        await ctx.store.close();
    }
}

async function incident(store, sequence) {
    return incidentIncentive(store, sequence);
}

async function bond(store, hash) {
    const { rows } = await store.query('SELECT * FROM device_bonds WHERE contract = $1 AND device_id_hash = $2', [INCENTIVES_ADDRESS.toLowerCase(), hash]);
    return rows[0] ?? null;
}

test('incidentEffect maps every settlement event to flags and reward_status', () => {
    assert.deepEqual(incidentEffect('AckRewarded', {}), { flags: 3, status: 'ack_rewarded' });
    assert.deepEqual(incidentEffect('ResolveRewarded', {}), { flags: 4, status: 'resolved_rewarded' });
    assert.deepEqual(incidentEffect('RewardSkipped', { rule: '1', reason: '0' }), { flags: 1, status: 'over_cap' });
    assert.deepEqual(incidentEffect('RewardSkipped', { rule: '1', reason: '2' }), { flags: 1, status: null });
    assert.deepEqual(incidentEffect('RewardSkipped', { rule: '2', reason: '3' }), { flags: 4, status: null });
    assert.deepEqual(incidentEffect('MissedAckSlashed', {}), { flags: 8, status: 'slashed' });
    assert.deepEqual(incidentEffect('LateRelaySlashed', {}), { flags: 16, status: 'late_relay_slashed' });
    assert.equal(incidentEffect('Staked', {}), null);
});

test('one day of events: bonds, rewards, penalties, realtime, idempotent and confirmation-aware', async () => {
    await withSetup(async ({ store, fake, indexer }) => {
        const t = NOW - 7_200;
        const i1 = await insertChainIncident(store, { sequence: 1, observedAt: t, ownerStatus: 'resolved' });
        const i2 = await insertChainIncident(store, { sequence: 2, severity: 2, observedAt: t + 100 });
        const i3 = await insertChainIncident(store, { sequence: 3, observedAt: t + 200, loggedAt: t + 200 + 1_500 });
        const i4 = await insertChainIncident(store, { sequence: 4, observedAt: t + 300 });
        const h = i1.hash;
        const A = (n) => BigInt(n) * ASAFE;

        fake.emit('ParamsUpdated', [Object.values(DEFAULT_PARAMS)], { blockNumber: 10, time: t - 100 });
        fake.emit('Staked', [OPERATOR_BOND_ID, OWNER, A(1000), A(1000)], { blockNumber: 11, time: t - 90 });
        fake.emit('Staked', [h, OWNER, A(100), A(100)], { blockNumber: 12, time: t - 80 });
        fake.emit('AckRewarded', [i1.key, OWNER, A(5)], { blockNumber: 20, time: t + 400 });
        fake.emit('ResolveRewarded', [i1.key, OWNER, A(5)], { blockNumber: 21, time: t + 500 });
        fake.emit('BondExhausted', [h], { blockNumber: 30, time: t + 800 }); // not realistic here, just mapped
        fake.emit('MissedAckSlashed', [i2.key, h, A(20), KEEPER], { blockNumber: 30, time: t + 800 });
        fake.emit('LateRelaySlashed', [i3.key, 1_500, A(20), KEEPER], { blockNumber: 40, time: t + 1_800 });
        fake.emit('AckRewarded', [i3.key, OWNER, A(5)], { blockNumber: 41, time: t + 1_900 });
        fake.emit('RewardSkipped', [i4.key, OWNER, 1, 0], { blockNumber: 50, time: t + 2_000 }); // too shallow (head 50, 2 confs: safe head 49)

        await indexer.catchUp();
        assert.deepEqual(await incident(store, 1).then((r) => [r.reward_status, r.incentive_flags]), ['resolved_rewarded', 7]);
        assert.deepEqual(await incident(store, 2).then((r) => [r.reward_status, r.incentive_flags]), ['slashed', 8]);
        // Late relay first, then a timely ack reward: ack_rewarded wins, relay_slashed stays in the flags.
        assert.deepEqual(await incident(store, 3).then((r) => [r.reward_status, r.incentive_flags]), ['ack_rewarded', 19]);
        assert.deepEqual(await incident(store, 4).then((r) => [r.reward_status, r.incentive_flags]), ['none', 0], 'block 50 is not confirmed yet');

        const deviceBond = await bond(store, h);
        assert.equal(deviceBond.amount, String(A(80)));
        assert.equal(deviceBond.staker, OWNER);
        assert.equal(deviceBond.device_id, DEVICE_ID);
        assert.equal(new Date(deviceBond.since).getTime(), (t - 80) * 1000);
        const operatorBond = await bond(store, OPERATOR_BOND_ID);
        assert.equal(operatorBond.amount, String(A(980)));
        assert.equal(operatorBond.staker, null);

        const { rows: events } = await store.query('SELECT name, incident_key, device_id_hash, account, amount FROM incentive_events ORDER BY id');
        assert.equal(events.length, 9);
        assert.ok(events.filter((e) => e.incident_key).every((e) => e.device_id_hash === h), 'incident events carry the device hash');
        assert.deepEqual(events.find((e) => e.name === 'MissedAckSlashed').account, KEEPER);

        const { rows: realtime } = await store.query(`SELECT payload FROM realtime_events WHERE type = 'incentive.updated' ORDER BY id`);
        assert.deepEqual(realtime.map((r) => r.payload.event), [
            'Staked', 'AckRewarded', 'ResolveRewarded', 'BondExhausted', 'MissedAckSlashed', 'LateRelaySlashed', 'AckRewarded',
        ]);
        assert.equal(realtime[1].payload.incident_id, i1.incidentId);
        assert.equal(realtime[1].payload.reward_status, 'ack_rewarded');

        // Own checkpoint, keyed by the incentives address.
        const { rows: [cp] } = await store.query('SELECT last_block FROM chain_checkpoints WHERE contract_address = $1', [INCENTIVES_ADDRESS.toLowerCase()]);
        assert.equal(Number(cp.last_block), 49);

        // Re-delivering the same logs (restart before checkpoint) changes nothing.
        await store.query('UPDATE chain_checkpoints SET last_block = 9');
        await indexer.catchUp();
        assert.equal((await store.query('SELECT COUNT(*)::int AS n FROM incentive_events')).rows[0].n, 9);
        assert.equal((await bond(store, h)).amount, String(A(80)), 'a slash is applied once');

        // Block 50 becomes deep enough.
        fake.state.head = 51;
        await indexer.catchUp();
        assert.deepEqual(await incident(store, 4).then((r) => [r.reward_status, r.incentive_flags]), ['over_cap', 1]);
    });
});

test('unstake and withdraw, and a later restake resets the bond period', async () => {
    await withSetup(async ({ store, fake, indexer }) => {
        const h = (await insertChainIncident(store, { sequence: 1, observedAt: NOW - 1_000 })).hash;
        const A = (n) => BigInt(n) * ASAFE;
        fake.emit('Staked', [h, OWNER, A(100), A(100)], { blockNumber: 11, time: NOW - 900 });
        fake.emit('UnstakeRequested', [h, OWNER, NOW - 800 + 604_800], { blockNumber: 12, time: NOW - 800 });
        await indexer.catchUp();
        let row = await bond(store, h);
        assert.equal(new Date(row.unstake_requested_at).getTime(), (NOW - 800) * 1000);
        assert.equal(new Date(row.unstake_available_at).getTime(), (NOW - 800 + 604_800) * 1000);

        fake.emit('Withdrawn', [h, OWNER, A(100)], { blockNumber: 51, time: NOW - 700 });
        fake.state.head = 52;
        await indexer.catchUp();
        row = await bond(store, h);
        assert.deepEqual([row.amount, row.staker, row.unstake_requested_at], ['0', null, null]);

        fake.emit('Staked', [h, OWNER, A(150), A(150)], { blockNumber: 53, time: NOW - 600 });
        fake.state.head = 54;
        await indexer.catchUp();
        row = await bond(store, h);
        assert.equal(row.amount, String(A(150)));
        assert.equal(new Date(row.since).getTime(), (NOW - 600) * 1000);
    });
});

test('syncIncidents: coverage and deadlines from pendingSettlement; ParamsUpdated moves deadlines', async () => {
    await withSetup(async ({ store, fake, indexer }) => {
        const covered = await insertChainIncident(store, { sequence: 1, severity: 2, observedAt: NOW - 500, covered: null });
        const before = await insertChainIncident(store, { sequence: 2, observedAt: NOW - 500, covered: null });
        const queued = await insertChainIncident(store, { sequence: 3, observedAt: NOW - 500, covered: null, outboxStatus: 'queued' });
        fake.state.settlements.set(covered.key, settlementFor(covered));
        fake.state.settlements.set(before.key, settlementFor(before, { covered: false }));
        fake.state.settlements.set(queued.key, settlementFor(queued));

        assert.equal(await indexer.syncIncidents(), 2);
        const c = await incident(store, 1);
        assert.equal(c.incentive_covered, true);
        assert.equal(new Date(c.logged_at).getTime(), covered.loggedAt * 1000);
        assert.equal(new Date(c.ack_deadline_at).getTime(), covered.ackDeadline * 1000);
        const b = await incident(store, 2);
        assert.deepEqual([b.incentive_covered, b.ack_deadline_at], [false, null]);
        assert.equal((await incident(store, 3)).incentive_covered, null, 'not on chain yet');
        assert.equal(await indexer.syncIncidents(), 0, 'checked incidents are not read again');

        const longer = { ...DEFAULT_PARAMS, ackDeadlineDanger: 1_200n, resolveDeadline: 172_800n };
        fake.emit('ParamsUpdated', [Object.values(longer)], { blockNumber: 20, time: NOW });
        await indexer.catchUp();
        const moved = await incident(store, 1);
        assert.equal(new Date(moved.ack_deadline_at).getTime(), (covered.loggedAt + 1_200) * 1000);
        assert.equal(new Date(moved.resolve_deadline_at).getTime(), (covered.loggedAt + 172_800) * 1000);
        assert.equal((await incident(store, 2)).ack_deadline_at, null, 'uncovered incidents keep no deadline');

        const { rows: [event] } = await store.query(`SELECT data FROM incentive_events WHERE name = 'ParamsUpdated'`);
        assert.equal(event.data.params.ackDeadlineDanger, '1200');
    });
});

test('refreshState snapshots params, fund and operator bond for the API', async () => {
    await withSetup(async ({ store, indexer }) => {
        await indexer.refreshState();
        const { rows: [state] } = await store.query('SELECT * FROM incentive_state');
        assert.equal(state.contract, INCENTIVES_ADDRESS.toLowerCase());
        assert.equal(state.params.ack_deadline_danger, '600');
        assert.equal(state.params.keeper_share_bps, 5000);
        assert.equal(state.params.daily_reward_cap, 3);
        assert.equal(state.reward_fund, String(50_000n * ASAFE));
        assert.equal(state.operator_bond.amount, String(1_000n * ASAFE));
        assert.equal(Number(state.current_day), Math.floor(NOW / 86_400));
        assert.equal(new Date(state.block_time).getTime(), NOW * 1000);
    });
});

test('deployment isolation: indexers of deployments A and B keep separate coverage, deadlines, flags and checkpoints', async () => {
    const store = await createIncidentDb();
    try {
        const A_ADDRESS = '0x' + 'a'.repeat(40);
        const i1 = await insertChainIncident(store, { sequence: 1, observedAt: NOW - 3_000, covered: null });
        const fakeA = createFakeIncentivesChain({ now: NOW, head: 50 });
        fakeA.chain.address = A_ADDRESS;
        const fakeB = createFakeIncentivesChain({ now: NOW, head: 50 });
        const B_ADDRESS = fakeB.chain.address.toLowerCase();
        const indexerA = createIncentivesIndexer({ db: store, chain: fakeA.chain, config: CONFIG, startBlock: 10, log: silentLog });
        const indexerB = createIncentivesIndexer({ db: store, chain: fakeB.chain, config: CONFIG, startBlock: 10, log: silentLog });

        fakeA.state.settlements.set(i1.key, settlementFor(i1));
        fakeA.emit('AckRewarded', [i1.key, OWNER, 5n * ASAFE], { blockNumber: 20, time: NOW - 2_000 });
        await indexerA.catchUp();
        assert.deepEqual(await incidentIncentive(store, 1, A_ADDRESS).then((r) => [r.incentive_covered, r.incentive_flags, r.reward_status]),
            [true, 3, 'ack_rewarded']);

        // B activated later: the incident predates it. A's projection must not leak into B.
        assert.deepEqual(await incidentIncentive(store, 1, B_ADDRESS).then((r) => [r.incentive_covered, r.incentive_flags, r.reward_status]),
            [null, 0, 'none']);
        fakeB.state.settlements.set(i1.key, settlementFor(i1, { covered: false }));
        assert.equal(await indexerB.syncIncidents(), 1, 'B checks the incident itself even though A already did');
        assert.deepEqual(await incidentIncentive(store, 1, B_ADDRESS).then((r) => [r.incentive_covered, r.ack_deadline_at]), [false, null]);
        assert.equal((await incidentIncentive(store, 1, A_ADDRESS)).incentive_covered, true, 'B never rewrites A');

        // B's own events and checkpoint.
        fakeB.emit('MissedAckSlashed', [i1.key, i1.hash, 0n, KEEPER], { blockNumber: 30, time: NOW - 1_000 });
        await indexerB.catchUp();
        assert.deepEqual(await incidentIncentive(store, 1, B_ADDRESS).then((r) => [r.incentive_flags, r.reward_status]), [8, 'slashed']);
        assert.deepEqual(await incidentIncentive(store, 1, A_ADDRESS).then((r) => [r.incentive_flags, r.reward_status]), [3, 'ack_rewarded']);
        const { rows: checkpoints } = await store.query('SELECT contract_address FROM chain_checkpoints ORDER BY contract_address');
        assert.deepEqual(checkpoints.map((r) => r.contract_address), [A_ADDRESS, B_ADDRESS].sort());
        const { rows: realtime } = await store.query(`SELECT payload FROM realtime_events WHERE type = 'incentive.updated' ORDER BY id`);
        assert.deepEqual(realtime.map((r) => r.payload.contract), [A_ADDRESS, B_ADDRESS], 'realtime events name their deployment');
    } finally {
        await store.close();
    }
});

test('INCENTIVES_START_BLOCK after the deployment block: the ParamsUpdated of the gap are backfilled once, before other events', async () => {
    await withSetup(async ({ store, fake }) => {
        const changed = { ...DEFAULT_PARAMS, keeperShareBps: 2_500n };
        fake.emit('ParamsUpdated', [Object.values(DEFAULT_PARAMS)], { blockNumber: 3, time: NOW - 5_000 }); // constructor
        fake.emit('Staked', [OPERATOR_BOND_ID, OWNER, 1_000n * ASAFE, 1_000n * ASAFE], { blockNumber: 4, time: NOW - 4_900 });
        fake.emit('ParamsUpdated', [Object.values(changed)], { blockNumber: 6, time: NOW - 4_000 });
        fake.emit('LateRelaySlashed', [`0x${'9'.repeat(64)}`, 1_200, 20n * ASAFE, KEEPER], { blockNumber: 20, time: NOW - 1_000 });
        const indexer = createIncentivesIndexer({
            db: store, chain: fake.chain, config: CONFIG, startBlock: 10, deploymentBlock: 3, log: silentLog,
        });
        await indexer.catchUp();
        const { rows } = await store.query('SELECT name, block_number::int AS block FROM incentive_events ORDER BY block_number, log_index');
        assert.deepEqual(rows, [
            { name: 'ParamsUpdated', block: 3 },
            { name: 'ParamsUpdated', block: 6 },
            { name: 'LateRelaySlashed', block: 20 },
        ], 'only params are taken from the gap; the Staked at block 4 stays skipped as configured');

        // Idempotent: a restarted indexer does not duplicate them.
        const again = createIncentivesIndexer({
            db: store, chain: fake.chain, config: CONFIG, startBlock: 10, deploymentBlock: 3, log: silentLog,
        });
        await again.catchUp();
        assert.equal((await store.query(`SELECT COUNT(*)::int AS n FROM incentive_events WHERE name = 'ParamsUpdated'`)).rows[0].n, 2);
    });
});

test('params backfill refuses to index events when the deployment block has no ParamsUpdated', async () => {
    await withSetup(async ({ store, fake }) => {
        fake.emit('LateRelaySlashed', [`0x${'9'.repeat(64)}`, 1_200, 20n * ASAFE, KEEPER], { blockNumber: 20, time: NOW - 1_000 });
        const indexer = createIncentivesIndexer({
            db: store, chain: fake.chain, config: CONFIG, startBlock: 10, deploymentBlock: 3, log: silentLog,
        });
        await assert.rejects(indexer.tick(), /no ParamsUpdated found between deployment block 3 and start block 10/);
        assert.equal((await store.query('SELECT COUNT(*)::int AS n FROM incentive_events')).rows[0].n, 0);
    });
});
