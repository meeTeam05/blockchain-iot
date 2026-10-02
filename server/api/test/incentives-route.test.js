// Incentives API (Task5_8_plan.md, Task 7, step 7.5), over data written by the real
// incentives indexer: per-device history (members only), public overdue list without
// device ids or measurements, params snapshot, leaderboard, and the incident detail block.
import test from 'node:test';
import assert from 'node:assert/strict';

import Fastify from 'fastify';

import incentivesRoutes from '../src/routes/incentives.js';
import incidentsRoutes from '../src/routes/incidents.js';
import { createIncentivesIndexer } from '../src/chain/incentives-indexer.js';
import { OPERATOR_BOND_ID } from '../src/chain/incentives.js';
import { DEVICE_ID, OTHER_DEVICE_ID, OUTSIDER_ID, USER_ID, createIncidentDb } from './helpers/incident-fixtures.js';
import {
    ASAFE,
    DEFAULT_PARAMS,
    KEEPER,
    INCENTIVES_ADDRESS,
    OWNER,
    createFakeIncentivesChain,
    insertChainIncident,
    silentLog,
} from './helpers/incentive-fixtures.js';

const NOW = 1_900_000_000;
const A = (n) => String(BigInt(n) * ASAFE);

async function buildApp(store, contractAddress = INCENTIVES_ADDRESS) {
    const app = Fastify({ logger: false });
    app.decorate('db', store.db);
    if (contractAddress) app.decorate('incentivesContractAddress', contractAddress.toLowerCase());
    app.decorate('authenticate', async (request, reply) => {
        const user = request.headers['x-test-user'];
        if (!user) return reply.code(401).send({ error: 'Unauthorized' });
        request.user = { sub: user };
    });
    await app.register(incidentsRoutes, { prefix: '/api' });
    await app.register(incentivesRoutes, { prefix: '/api' });
    await app.ready();
    return app;
}

// 09:00-style rewarded incident, 13:00-style slashed one, an overdue open one,
// a late-relayed one and a timely-but-unrecorded one, all on DEVICE_ID.
async function seed(store, { shareAfterMissed = null } = {}) {
    const fake = createFakeIncentivesChain({ now: NOW, head: 100 });
    const indexer = createIncentivesIndexer({ db: store, chain: fake.chain, config: { confirmations: 1, logBatchBlocks: 2_000, batchSize: 20 }, log: silentLog });
    const t = NOW - 7_200;
    const rewarded = await insertChainIncident(store, { sequence: 1, observedAt: t, ownerStatus: 'resolved', resolvedAt: t + 600 });
    const slashed = await insertChainIncident(store, { sequence: 2, severity: 2, observedAt: t + 1_000 });
    const overdue = await insertChainIncident(store, { sequence: 3, severity: 2, observedAt: NOW - 1_500 });
    const lateRelay = await insertChainIncident(store, { sequence: 4, observedAt: NOW - 2_000, loggedAt: NOW - 2_000 + 1_500 });
    const relaySlashed = await insertChainIncident(store, { sequence: 5, observedAt: t + 2_000, loggedAt: t + 2_000 + 1_200 });
    const pending = await insertChainIncident(store, { sequence: 6, observedAt: NOW - 100 });
    const h = rewarded.hash;

    fake.emit('ParamsUpdated', [Object.values(DEFAULT_PARAMS)], { blockNumber: 1, time: t - 200 });
    fake.emit('Staked', [OPERATOR_BOND_ID, OWNER, BigInt(A(1000)), BigInt(A(1000))], { blockNumber: 2, time: t - 100 });
    fake.emit('Staked', [h, OWNER, BigInt(A(100)), BigInt(A(100))], { blockNumber: 3, time: t - 50 });
    fake.emit('AckRewarded', [rewarded.key, OWNER, BigInt(A(5))], { blockNumber: 10, time: t + 300 });
    fake.emit('ResolveRewarded', [rewarded.key, OWNER, BigInt(A(5))], { blockNumber: 11, time: t + 600 });
    fake.emit('MissedAckSlashed', [slashed.key, h, BigInt(A(20)), KEEPER], { blockNumber: 20, time: t + 1_800 });
    if (shareAfterMissed !== null) {
        const changed = { ...DEFAULT_PARAMS, keeperShareBps: BigInt(shareAfterMissed) };
        fake.emit('ParamsUpdated', [Object.values(changed)], { blockNumber: 25, time: t + 2_000 });
        fake.state.params = changed;
    }
    fake.emit('LateRelaySlashed', [relaySlashed.key, 1_200, BigInt(A(20)), KEEPER], { blockNumber: 30, time: t + 3_300 });
    fake.state.operatorBond = BigInt(A(980));
    await indexer.catchUp();
    return { fake, indexer, rewarded, slashed, overdue, lateRelay, relaySlashed, pending, h };
}

async function withApp(run) {
    const store = await createIncidentDb();
    const app = await buildApp(store);
    try {
        await run({ store, app });
    } finally {
        await app.close();
        await store.close();
    }
}

test('public incentive routes answer 404 until the worker indexed incentives', async () => {
    await withApp(async ({ app }) => {
        for (const url of ['/api/incentives/params', '/api/incentives/overdue', '/api/incentives/leaderboard']) {
            const res = await app.inject({ method: 'GET', url });
            assert.equal(res.statusCode, 404, url);
            assert.deepEqual(res.json(), { error: 'Incentives are not available' });
        }
        const device = await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incentives`, headers: { 'x-test-user': USER_ID } });
        assert.equal(device.statusCode, 200);
        assert.equal(device.json().enabled, false);
        assert.equal(device.json().bond, null);
    });
});

test('API resolves the configured generated deployment and never falls back to an arbitrary snapshot', async () => {
    const previous = process.env.INCENTIVES_DEPLOYMENT;
    const store = await createIncidentDb();
    const app = await buildApp(store, null);
    try {
        await seed(store);
        process.env.INCENTIVES_DEPLOYMENT = 'localhost';
        const params = await app.inject({ method: 'GET', url: '/api/incentives/params' });
        assert.equal(params.statusCode, 200);
        assert.equal(params.json().contract, INCENTIVES_ADDRESS.toLowerCase());
        process.env.INCENTIVES_DEPLOYMENT = 'unavailable-deployment';
        assert.equal((await app.inject({ method: 'GET', url: '/api/incentives/params' })).statusCode, 404);
    } finally {
        if (previous === undefined) delete process.env.INCENTIVES_DEPLOYMENT;
        else process.env.INCENTIVES_DEPLOYMENT = previous;
        await app.close();
        await store.close();
    }
});

test('GET /devices/:id/incentives: members only; bond, today count, totals, warnings, history', async () => {
    await withApp(async ({ store, app }) => {
        const { rewarded, slashed, h } = await seed(store);
        const headers = { 'x-test-user': USER_ID };

        assert.equal((await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incentives` })).statusCode, 401);
        assert.equal((await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incentives`, headers: { 'x-test-user': OUTSIDER_ID } })).statusCode, 403);
        assert.equal((await app.inject({ method: 'GET', url: '/api/devices/not-a-mac/incentives', headers })).statusCode, 400);
        assert.equal((await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incentives?limit=0`, headers })).statusCode, 400);
        assert.equal((await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incentives?before_id=abc`, headers })).statusCode, 400);

        const res = await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incentives`, headers });
        assert.equal(res.statusCode, 200);
        const body = res.json();
        assert.equal(body.device_id_hash, h);
        assert.equal(body.enabled, true);
        assert.equal(body.bond.amount, A(80));
        assert.equal(body.bond.staker, OWNER);
        assert.equal(body.bond.unstake_requested_at, null);
        assert.deepEqual(body.rewards_today, { day: Math.floor(NOW / 86_400), count: 1, cap: 3 });
        assert.deepEqual(body.totals, { rewarded: A(10), slashed: A(20) });
        assert.deepEqual(body.warnings, ['bond_below_owner_bond']);
        assert.equal(body.params.owner_bond, A(100));
        assert.deepEqual(body.events.map((e) => e.name), ['LateRelaySlashed', 'MissedAckSlashed', 'ResolveRewarded', 'AckRewarded', 'Staked']);
        const ack = body.events.find((e) => e.name === 'AckRewarded');
        assert.equal(ack.incident_id, rewarded.incidentId);
        assert.equal(ack.amount, A(5));
        assert.equal(ack.account, OWNER);
        assert.equal(body.events.find((e) => e.name === 'MissedAckSlashed').incident_key, slashed.key);

        const page = (await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incentives?limit=2&before_id=${body.events[1].id}`, headers })).json();
        assert.deepEqual(page.events.map((e) => e.name), ['ResolveRewarded', 'AckRewarded']);

        const other = (await app.inject({ method: 'GET', url: `/api/devices/${OTHER_DEVICE_ID}/incentives`, headers })).json();
        assert.equal(other.bond, null);
        assert.deepEqual(other.events, []);
        assert.deepEqual(other.warnings, ['no_bond']);
    });
});

test('GET /incentives/overdue is public and lists only slashable incidents, without device ids or measurements', async () => {
    await withApp(async ({ store, app }) => {
        const { overdue, lateRelay, relaySlashed, h } = await seed(store);
        const res = await app.inject({ method: 'GET', url: '/api/incentives/overdue' });
        assert.equal(res.statusCode, 200);
        const body = res.json();
        assert.equal(body.as_of, new Date(NOW * 1000).toISOString(), 'chain time when it runs ahead of the wall clock');
        assert.equal(body.keeper_share_bps, 5000);

        // #1 rewarded, #2 slashed, #6 still in time. #5 had its operator slashed but the owner never
        // acknowledged, so it is overdue too. #4 was relayed late, but the owner's deadline counts
        // from loggedAt and has not passed.
        assert.deepEqual(body.slash_missed_ack.map((r) => r.incident_key), [relaySlashed.key, overdue.key]);
        const row = body.slash_missed_ack.find((r) => r.incident_key === overdue.key);
        assert.equal(row.device_id_hash, h);
        assert.equal(row.severity, 2);
        assert.equal(row.deadline_at, new Date(overdue.ackDeadline * 1000).toISOString());
        assert.equal(row.owner_acknowledged_late, false);
        assert.equal(row.penalty, A(20));
        assert.equal(row.bond_available, A(80));
        assert.equal(row.bounty, A(10));

        assert.deepEqual(body.slash_late_relay.map((r) => r.incident_key), [lateRelay.key]);
        assert.equal(body.slash_late_relay[0].relay_delay_seconds, '1500');
        assert.equal(body.slash_late_relay[0].max_relay_delay, '900');
        assert.equal(body.slash_late_relay[0].bond_available, A(980));
        assert.equal(body.slash_late_relay[0].bounty, A(10));

        const raw = res.body;
        assert.ok(!raw.includes(DEVICE_ID), 'no device id');
        for (const field of ['co_ppm', 'no2_ppm', 'temperature', 'humidity', 'sensors', 'evidence']) {
            assert.ok(!raw.includes(field), `no ${field}`);
        }
        assert.equal((await app.inject({ method: 'GET', url: '/api/incentives/overdue?limit=1' })).json().slash_missed_ack.length, 1);
        assert.equal((await app.inject({ method: 'GET', url: '/api/incentives/overdue?limit=-1' })).statusCode, 400);
    });
});

test('GET /incentives/params and /leaderboard are public snapshots', async () => {
    await withApp(async ({ store, app }) => {
        await seed(store);
        const params = (await app.inject({ method: 'GET', url: '/api/incentives/params' })).json();
        assert.equal(params.params.ack_deadline_warning, '1800');
        assert.equal(params.params.missed_ack_penalty, A(20));
        assert.equal(params.reward_fund, A(50_000));
        assert.equal(params.low_reward_fund, false);
        assert.equal(params.operator_bond.amount, A(980));
        assert.equal(params.operator_bond.unstake_requested_at, null);
        assert.equal(params.params_history.length, 1);
        assert.equal(params.params_history[0].data.params.keeperShareBps, '5000');

        await store.query(`UPDATE incentive_state SET reward_fund = $1`, [A(999)]);
        assert.equal((await app.inject({ method: 'GET', url: '/api/incentives/params' })).json().low_reward_fund, true);

        const board = (await app.inject({ method: 'GET', url: '/api/incentives/leaderboard' })).json();
        assert.deepEqual(board.owners, [{ account: OWNER, rewarded: A(10), rewards: 2 }]);
        assert.deepEqual(board.keepers, [{ account: KEEPER, slashed: A(20), slashes: 2 }]);
    });
});

test('incident detail carries the incentive block (deadline, reward_status, flags, events)', async () => {
    await withApp(async ({ store, app }) => {
        const { rewarded, relaySlashed, pending } = await seed(store);
        const headers = { 'x-test-user': USER_ID };
        const detail = (await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incidents/${rewarded.incidentId}`, headers })).json();
        assert.equal(detail.incident_id, rewarded.incidentId, 'existing fields are unchanged');
        assert.deepEqual(Object.keys(detail.incentive), ['incident_key', 'covered', 'logged_at', 'deadline_at', 'resolve_deadline_at', 'reward_status', 'flags', 'events']);
        assert.equal(detail.incentive.incident_key, rewarded.key);
        assert.equal(detail.incentive.reward_status, 'resolved_rewarded');
        assert.equal(detail.incentive.deadline_at, new Date(rewarded.ackDeadline * 1000).toISOString());
        assert.deepEqual(detail.incentive.flags, { timely_ack: true, ack_rewarded: true, resolve_settled: true, ack_slashed: false, relay_slashed: false });
        assert.deepEqual(detail.incentive.events.map((e) => e.name), ['AckRewarded', 'ResolveRewarded']);

        const relay = (await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incidents/${relaySlashed.incidentId}`, headers })).json();
        assert.equal(relay.incentive.reward_status, 'late_relay_slashed');
        assert.equal(relay.incentive.flags.relay_slashed, true);

        const open = (await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incidents/${pending.incidentId}`, headers })).json();
        assert.equal(open.incentive.reward_status, 'none');
        assert.equal(open.incentive.covered, true);
        assert.deepEqual(open.incentive.events, []);
    });
});

test('leaderboard pays keeper the historical share for each P1/P2 slash', async () => {
    await withApp(async ({ store, app }) => {
        await seed(store, { shareAfterMissed: 2500 });
        const board = (await app.inject({ method: 'GET', url: '/api/incentives/leaderboard' })).json();
        assert.deepEqual(board.owners, [{ account: OWNER, rewarded: A(10), rewards: 2 }]);
        assert.deepEqual(board.keepers, [{ account: KEEPER, slashed: A(15), slashes: 2 }],
            'P1 pays 10 at 50%; P2 pays 5 at 25%; treasury retains the other 25');
        const params = (await app.inject({ method: 'GET', url: '/api/incentives/params' })).json();
        assert.equal(params.params.keeper_share_bps, 2500);
        assert.equal(params.params_history.length, 2);
    });
});

test('all incentives APIs ignore a newer snapshot, events and bond from another deployment', async () => {
    await withApp(async ({ store, app }) => {
        const { rewarded, overdue, lateRelay, h } = await seed(store);
        const oldContract = `0x${'a'.repeat(40)}`;
        const oldIncident = await insertChainIncident(store, {
            sequence: 70, observedAt: 1_600_000_000, loggedAt: 1_600_000_060,
            severity: 2, flags: 8, rewardStatus: 'slashed',
        });
        await store.query(
            `INSERT INTO incentive_state (contract, token, air_safety_log, treasury, operator, params,
                                          reward_fund, total_bonded, operator_bond, activated_at,
                                          current_day, block_number, block_time, updated_at)
             SELECT $1, token, air_safety_log, treasury, operator, params, 1, total_bonded,
                    operator_bond, to_timestamp(1500000000), current_day, block_number,
                    block_time, NOW() + INTERVAL '1 day'
             FROM incentive_state WHERE contract = $2`,
            [oldContract, INCENTIVES_ADDRESS.toLowerCase()]
        );
        await store.query(
            `INSERT INTO device_bonds (contract, device_id_hash, device_id, staker, amount, updated_block)
             VALUES ($1, $2, $3, $4, $5, 200)`,
            [oldContract, h, DEVICE_ID, OWNER, A(999)]
        );
        for (const [index, key, name] of [[1, rewarded.key, 'AckRewarded'], [2, oldIncident.key, 'MissedAckSlashed'],
            [3, overdue.key, 'MissedAckSlashed'], [4, lateRelay.key, 'LateRelaySlashed']]) {
            await store.query(
                `INSERT INTO incentive_events (contract, tx_hash, log_index, block_number, block_hash,
                                               block_time, name, incident_key, device_id_hash, account, amount)
                 VALUES ($1, $2, 0, 200, $3, to_timestamp(1600001000), $4, $5, $6, $7, $8)`,
                [oldContract, `0x${String(index).padStart(64, 'd')}`, `0x${'b'.repeat(64)}`,
                    name, key, h, KEEPER, A(999)]
            );
        }
        // These shared incident columns may have been projected by deployment A.
        // B must reconstruct its own settlement and deadlines from scoped data.
        await store.query(
            `UPDATE incidents SET incentive_flags = 31, incentive_covered = FALSE,
                                  reward_status = 'slashed', ack_deadline_at = to_timestamp(2000000000)
             WHERE id = ANY($1::bigint[])`, [[rewarded.id, overdue.id, lateRelay.id]]
        );

        const params = (await app.inject({ method: 'GET', url: '/api/incentives/params' })).json();
        assert.equal(params.contract, INCENTIVES_ADDRESS.toLowerCase());
        assert.equal(params.reward_fund, A(50_000));
        assert.equal(params.params_history.length, 1);

        const headers = { 'x-test-user': USER_ID };
        const device = (await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incentives`, headers })).json();
        assert.equal(device.contract, INCENTIVES_ADDRESS.toLowerCase());
        assert.equal(device.bond.amount, A(80));
        assert.equal(device.totals.rewarded, A(10));
        assert.equal(device.events.length, 5);

        const board = (await app.inject({ method: 'GET', url: '/api/incentives/leaderboard' })).json();
        assert.deepEqual(board.owners, [{ account: OWNER, rewarded: A(10), rewards: 2 }]);
        assert.deepEqual(board.keepers, [{ account: KEEPER, slashed: A(20), slashes: 2 }]);

        const overdueBody = (await app.inject({ method: 'GET', url: '/api/incentives/overdue' })).json();
        assert.equal(overdueBody.contract, INCENTIVES_ADDRESS.toLowerCase());
        assert.ok(overdueBody.slash_missed_ack.some((r) => r.incident_key === overdue.key));
        assert.equal(overdueBody.slash_missed_ack.find((r) => r.incident_key === overdue.key).deadline_at,
            new Date(overdue.ackDeadline * 1000).toISOString());
        assert.ok(overdueBody.slash_late_relay.some((r) => r.incident_key === lateRelay.key));
        assert.ok(!overdueBody.slash_missed_ack.some((r) => r.incident_key === oldIncident.key));

        const detail = (await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incidents/${rewarded.incidentId}`, headers })).json();
        assert.deepEqual(detail.incentive.events.map((e) => e.name), ['AckRewarded', 'ResolveRewarded']);
        assert.equal(detail.incentive.reward_status, 'resolved_rewarded');
        assert.equal(detail.incentive.covered, true);
        assert.equal(detail.incentive.deadline_at, new Date(rewarded.ackDeadline * 1000).toISOString());
        assert.equal(detail.incentive.flags.ack_slashed, false);
        const oldDetail = (await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incidents/${oldIncident.incidentId}`, headers })).json();
        assert.equal(oldDetail.incentive.covered, false);
        assert.equal(oldDetail.incentive.reward_status, 'none');
        assert.deepEqual(oldDetail.incentive.events, []);

        await store.query('DELETE FROM incentive_state WHERE contract = $1', [INCENTIVES_ADDRESS.toLowerCase()]);
        assert.equal((await app.inject({ method: 'GET', url: '/api/incentives/params' })).statusCode, 404);
        assert.equal((await app.inject({ method: 'GET', url: '/api/incentives/overdue' })).statusCode, 404);
        assert.equal((await app.inject({ method: 'GET', url: '/api/incentives/leaderboard' })).statusCode, 404);
        assert.equal((await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incentives`, headers })).json().enabled, false);
    });
});
