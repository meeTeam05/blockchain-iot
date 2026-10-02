// Keeper (Task5_8_plan.md, Task 7, step 7.6): picks the right incidents, never processes
// one twice, treats AlreadySettled / AckDeadlinePassed as normal, backs off on RPC errors
// and never calls slashLateRelay.
import test from 'node:test';
import assert from 'node:assert/strict';

import { KEEPER_ACTIONS, createKeeper, decideAction } from '../src/chain/keeper.js';
import { SETTLEMENT_FLAGS as F } from '../src/chain/incentives.js';
import { createIncidentDb } from './helpers/incident-fixtures.js';
import {
    ASAFE,
    createFakeIncentivesChain,
    insertChainIncident,
    revertError,
    settlementFor,
    silentLog,
} from './helpers/incentive-fixtures.js';

const NOW = 1_900_000_000;
const CONFIG = Object.freeze({ batchSize: 20, confirmations: 1, maxAttempts: 3 });

async function setup({ config = CONFIG } = {}) {
    const store = await createIncidentDb();
    const fake = createFakeIncentivesChain({ now: NOW });
    const keeper = createKeeper({ db: store, chain: fake.chain, config, log: silentLog });
    return { store, fake, keeper };
}

async function withSetup(run, options) {
    const ctx = await setup(options);
    try {
        await run(ctx);
    } finally {
        await ctx.store.close();
    }
}

async function actions(store) {
    const { rows } = await store.query(
        `SELECT i.sequence::int AS sequence, k.action, k.status, k.attempts, k.tx_hash, k.last_error
         FROM keeper_actions k JOIN incidents i ON i.id = k.incident_row_id ORDER BY i.sequence, k.action`
    );
    return rows;
}

test('decideAction follows the on-chain settlement', () => {
    const inc = { hash: `0x${'a'.repeat(64)}`, severity: 1, observedAt: NOW - 600, loggedAt: NOW - 540, ackDeadline: NOW + 1260, resolveDeadline: NOW + 85_860 };
    const s = (o) => settlementFor(inc, o);

    assert.deepEqual(decideAction('record_ack', s({ exists: false }), {}, NOW), { kind: 'wait', reason: 'IncidentNotFound' });
    assert.deepEqual(decideAction('record_ack', s({ covered: false }), {}, NOW), { kind: 'skip', reason: 'IncidentNotCovered' });
    assert.deepEqual(decideAction('record_ack', s({ status: 2, canRecordAck: true }), {}, NOW), { kind: 'call' });
    assert.deepEqual(decideAction('record_ack', s({ flags: F.TIMELY_ACK }), {}, NOW), { kind: 'skip', reason: 'AlreadySettled' });
    assert.deepEqual(decideAction('record_ack', s({ flags: F.ACK_SLASHED }), {}, NOW), { kind: 'skip', reason: 'AlreadySettled' });
    assert.deepEqual(decideAction('record_ack', s({ status: 2 }), {}, inc.ackDeadline + 1), { kind: 'skip', reason: 'AckDeadlinePassed' });
    assert.equal(decideAction('record_ack', s({ status: 2, canRecordAck: true }), {}, inc.ackDeadline).kind, 'call', 'deadline itself is still in time');

    const acked = F.TIMELY_ACK | F.ACK_REWARDED;
    assert.deepEqual(decideAction('record_resolve', s({ status: 3, flags: acked, canRecordResolve: true }), {}, NOW), { kind: 'call' });
    assert.deepEqual(decideAction('record_resolve', s({ status: 3, flags: F.TIMELY_ACK }), {}, NOW), { kind: 'skip', reason: 'AckNotRewarded' });
    assert.deepEqual(decideAction('record_resolve', s({ status: 3 }), {}, NOW), { kind: 'wait', reason: 'NotAcknowledged' });
    assert.deepEqual(decideAction('record_resolve', s({ status: 3, flags: acked | F.RESOLVE_SETTLED }), {}, NOW), { kind: 'skip', reason: 'AlreadySettled' });
    assert.deepEqual(decideAction('record_resolve', s({ status: 3, flags: acked }), {}, inc.resolveDeadline + 1), { kind: 'skip', reason: 'ResolveDeadlinePassed' });

    const late = inc.ackDeadline + 30;
    assert.deepEqual(decideAction('slash_missed_ack', s(), {}, late), { kind: 'call' });
    assert.deepEqual(decideAction('slash_missed_ack', s(), {}, inc.ackDeadline), { kind: 'wait', reason: 'AckDeadlineNotPassed' });
    assert.deepEqual(decideAction('slash_missed_ack', s({ flags: F.TIMELY_ACK }), {}, late), { kind: 'skip', reason: 'AlreadySettled' });
    // Acknowledged on chain: slash only when the indexed acknowledgement was late.
    assert.equal(decideAction('slash_missed_ack', s({ status: 2 }), { reacted_at: null }, late).kind, 'wait');
    assert.deepEqual(
        decideAction('slash_missed_ack', s({ status: 2 }), { reacted_at: new Date((inc.ackDeadline - 5) * 1000) }, late),
        { kind: 'skip', reason: 'owner acknowledged in time' }
    );
    assert.equal(decideAction('slash_missed_ack', s({ status: 2 }), { reacted_at: new Date((inc.ackDeadline + 5) * 1000) }, late).kind, 'call');
});

test('the keeper never calls slashLateRelay', () => {
    assert.deepEqual(Object.values(KEEPER_ACTIONS).sort(), ['recordTimelyAck', 'recordTimelyResolve', 'slashMissedAck']);
});

test('candidates: only covered, chain-confirmed incidents in the right state and time window', async () => {
    await withSetup(async ({ store, keeper }) => {
        const t = NOW - 300;
        // record_ack
        await insertChainIncident(store, { sequence: 1, observedAt: t, ownerStatus: 'acknowledged', acknowledgedAt: t + 120 });
        await insertChainIncident(store, { sequence: 2, observedAt: t, ownerStatus: 'resolved', resolvedAt: t + 120 });
        await insertChainIncident(store, { sequence: 3, observedAt: t }); // open, in time: nothing to do yet
        await insertChainIncident(store, { sequence: 4, observedAt: t, ownerStatus: 'acknowledged', acknowledgedAt: t + 120, flags: F.TIMELY_ACK | F.ACK_REWARDED, rewardStatus: 'ack_rewarded' });
        await insertChainIncident(store, { sequence: 5, observedAt: t, ownerStatus: 'acknowledged', acknowledgedAt: t + 120, covered: false });
        await insertChainIncident(store, { sequence: 6, observedAt: t, ownerStatus: 'acknowledged', acknowledgedAt: t + 120, outboxStatus: 'pending' });
        await insertChainIncident(store, { sequence: 7, observedAt: t, ownerStatus: 'acknowledged', acknowledgedAt: t + 120, covered: null });
        // record_resolve
        await insertChainIncident(store, { sequence: 8, observedAt: t, ownerStatus: 'resolved', resolvedAt: t + 200, flags: F.TIMELY_ACK | F.ACK_REWARDED });
        await insertChainIncident(store, { sequence: 9, observedAt: t, ownerStatus: 'resolved', resolvedAt: t + 200, flags: F.TIMELY_ACK }); // over cap
        // slash_missed_ack (danger, 10 min deadline from loggedAt)
        const old = NOW - 3_600;
        await insertChainIncident(store, { sequence: 10, severity: 2, observedAt: old });
        await insertChainIncident(store, { sequence: 11, severity: 2, observedAt: old, ownerStatus: 'acknowledged', acknowledgedAt: old + 60 + 900 }); // late ack
        await insertChainIncident(store, { sequence: 12, severity: 2, observedAt: old, ownerStatus: 'acknowledged', acknowledgedAt: old + 120 }); // ack in time, unrecorded
        await insertChainIncident(store, { sequence: 13, severity: 2, observedAt: old, flags: F.ACK_SLASHED, rewardStatus: 'slashed' });
        await insertChainIncident(store, { sequence: 14, severity: 1, observedAt: old, ownerStatus: 'resolved', resolvedAt: old + 2_500 }); // resolved late, never acked

        const now = new Date(NOW * 1000);
        const seqs = async (action) => (await keeper.candidates(action, now, 50)).map((r) => Number(r.sequence)).sort((a, b) => a - b);
        assert.deepEqual(await seqs('record_ack'), [1, 2]);
        assert.deepEqual(await seqs('record_resolve'), [8]);
        assert.deepEqual(await seqs('slash_missed_ack'), [10, 11, 14]);
        assert.equal((await keeper.candidates('record_ack', now, 1)).length, 1, 'batch limit');
    });
});

test('R1/R2: simulate then send, pending -> done after confirmations, never processed twice', async () => {
    await withSetup(async ({ store, fake, keeper }) => {
        const t = NOW - 300;
        const ack = await insertChainIncident(store, { sequence: 1, observedAt: t, ownerStatus: 'acknowledged', acknowledgedAt: t + 120 });
        const res = await insertChainIncident(store, { sequence: 2, observedAt: t, ownerStatus: 'resolved', resolvedAt: t + 200, flags: F.TIMELY_ACK | F.ACK_REWARDED });
        fake.state.settlements.set(ack.key, settlementFor(ack, { status: 2, canRecordAck: true }));
        fake.state.settlements.set(res.key, settlementFor(res, { status: 3, flags: F.TIMELY_ACK | F.ACK_REWARDED, canRecordResolve: true }));

        const first = await keeper.tick();
        assert.deepEqual(first, { confirmed: 0, sent: 2, skipped: 0 });
        assert.deepEqual(fake.state.calls.map((c) => [c.method, c.key]), [['recordTimelyAck', ack.key], ['recordTimelyResolve', res.key]]);
        assert.deepEqual((await actions(store)).map((a) => [a.sequence, a.action, a.status, a.attempts]), [
            [1, 'record_ack', 'pending', 1],
            [2, 'record_resolve', 'pending', 1],
        ]);

        // Still in the mempool: nothing changes and nothing is re-sent.
        assert.deepEqual(await keeper.tick(), { confirmed: 0, sent: 0, skipped: 0 });
        assert.equal(fake.state.calls.length, 2);

        for (const call of fake.state.calls) fake.mine(call.hash, { blockNumber: 100 });
        assert.equal((await keeper.tick()).confirmed, 2);
        const rows = await actions(store);
        assert.deepEqual(rows.map((a) => a.status), ['done', 'done']);
        assert.equal(rows[0].tx_hash, fake.state.calls[0].hash);

        // Even if the indexer has not caught up yet, a done action is not sent again.
        await keeper.tick();
        assert.equal(fake.state.calls.length, 2);
    });
});

test('P1: overdue open incident is slashed; no covering bond or in-time ack is skipped', async () => {
    await withSetup(async ({ store, fake, keeper }) => {
        const old = NOW - 3_600;
        const open = await insertChainIncident(store, { sequence: 10, severity: 2, observedAt: old });
        const unbonded = await insertChainIncident(store, { deviceId: '11:22:33:44:55:66', sequence: 11, severity: 2, observedAt: old });
        fake.state.settlements.set(open.key, settlementFor(open, { canSlashMissedAck: true }));
        fake.state.settlements.set(unbonded.key, settlementFor(unbonded, { canSlashMissedAck: true }));
        fake.state.bonds.set(open.hash, { amount: 100n * ASAFE, since: old - 100 });

        const result = await keeper.tick();
        assert.equal(result.sent, 1);
        assert.deepEqual(fake.state.calls.map((c) => [c.method, c.key]), [['slashMissedAck', open.key]]);
        const rows = await actions(store);
        assert.deepEqual(rows.map((a) => [a.sequence, a.status, a.last_error]), [
            [10, 'pending', null],
            [11, 'skipped', 'no covering bond'],
        ]);

        // A bond staked after the incident was logged does not cover it either.
        const later = await insertChainIncident(store, { sequence: 12, severity: 2, observedAt: old });
        fake.state.settlements.set(later.key, settlementFor(later, { canSlashMissedAck: true }));
        fake.state.bonds.set(later.hash, { amount: 100n * ASAFE, since: later.loggedAt + 1 });
        fake.state.bonds.set(open.hash, { amount: 100n * ASAFE, since: later.loggedAt + 1 });
        await keeper.tick();
        assert.equal((await actions(store)).find((a) => a.sequence === 12).last_error, 'no covering bond');
    });
});

test('AlreadySettled and AckDeadlinePassed are normal outcomes: skipped, not errors, not retried', async () => {
    await withSetup(async ({ store, fake, keeper }) => {
        const t = NOW - 300;
        const raced = await insertChainIncident(store, { sequence: 1, observedAt: t, ownerStatus: 'acknowledged', acknowledgedAt: t + 120 });
        const passed = await insertChainIncident(store, { sequence: 2, observedAt: t, ownerStatus: 'acknowledged', acknowledgedAt: t + 120 });
        // The DB still thinks both are claimable; the chain says otherwise.
        fake.state.settlements.set(raced.key, settlementFor(raced, { status: 2, canRecordAck: true }));
        fake.state.reverts.set(raced.key, revertError('AlreadySettled', [raced.key]));
        fake.state.settlements.set(passed.key, settlementFor(passed, { status: 2, canRecordAck: true }));
        fake.state.reverts.set(passed.key, revertError('AckDeadlinePassed', [passed.key, passed.ackDeadline]));

        const errors = [];
        const keeper2 = createKeeper({
            db: store,
            chain: fake.chain,
            config: CONFIG,
            log: { info() {}, warn() {}, error: (o, m) => errors.push(m) },
        });
        const result = await keeper2.tick();
        assert.deepEqual(result, { confirmed: 0, sent: 0, skipped: 2 });
        assert.deepEqual(errors, []);
        const rows = await actions(store);
        assert.deepEqual(rows.map((a) => [a.sequence, a.status]), [[1, 'skipped'], [2, 'skipped']]);
        assert.match(rows[0].last_error, /^AlreadySettled\(/);
        assert.match(rows[1].last_error, /^AckDeadlinePassed\(/);
        assert.equal(fake.state.calls.length, 0);

        await keeper2.tick();
        assert.equal((await actions(store)).length, 2, 'skipped incidents are not picked again');

        // Settled by someone else and already visible in pendingSettlement: skipped before simulating.
        const other = await insertChainIncident(store, { sequence: 3, observedAt: t, ownerStatus: 'acknowledged', acknowledgedAt: t + 120 });
        fake.state.settlements.set(other.key, settlementFor(other, { status: 2, flags: F.TIMELY_ACK }));
        await keeper2.tick();
        const row = (await actions(store)).find((a) => a.sequence === 3);
        assert.deepEqual([row.status, row.last_error], ['skipped', 'AlreadySettled']);
    });
});

test('RPC errors back off with attempts and end as failed; chain-state waits write nothing', async () => {
    await withSetup(async ({ store, fake, keeper }) => {
        const t = NOW - 300;
        await insertChainIncident(store, { sequence: 1, observedAt: t, ownerStatus: 'acknowledged', acknowledgedAt: t + 120 });
        fake.state.rpcError = new Error('getaddrinfo ENOTFOUND rpc');

        await keeper.tick();
        let [row] = await actions(store);
        assert.deepEqual([row.status, row.attempts], ['retry', 1]);
        assert.match(row.last_error, /ENOTFOUND/);
        const { rows: [{ delay }] } = await store.query(
            `SELECT EXTRACT(EPOCH FROM next_attempt_at - NOW())::int AS delay FROM keeper_actions`
        );
        assert.ok(delay >= 25 && delay <= 31, `backoff ~30 s, got ${delay}`);

        // Not due yet: not picked.
        await keeper.tick();
        assert.equal((await actions(store))[0].attempts, 1);

        // Due again: retried until maxAttempts (3).
        for (let attempt = 2; attempt <= 3; attempt++) {
            await store.query(`UPDATE keeper_actions SET next_attempt_at = NOW() - INTERVAL '1 second'`);
            await keeper.tick();
        }
        [row] = await actions(store);
        assert.deepEqual([row.status, row.attempts], ['failed', 3]);

        // A send that fails at the transport level also backs off.
        fake.state.rpcError = null;
        const sendFail = await insertChainIncident(store, { sequence: 2, observedAt: t, ownerStatus: 'acknowledged', acknowledgedAt: t + 120 });
        fake.state.settlements.set(sendFail.key, settlementFor(sendFail, { status: 2, canRecordAck: true }));
        fake.state.sendErrors.set(sendFail.key, Object.assign(new Error('insufficient funds for gas'), { code: 'INSUFFICIENT_FUNDS' }));
        await keeper.tick();
        assert.equal((await actions(store)).find((a) => a.sequence === 2).status, 'retry');

        // Chain lagging behind the DB (NotAcknowledged): re-evaluated later, no row written.
        const lag = await insertChainIncident(store, { sequence: 3, observedAt: t, ownerStatus: 'acknowledged', acknowledgedAt: t + 120 });
        fake.state.settlements.set(lag.key, settlementFor(lag, { status: 2, canRecordAck: true }));
        fake.state.reverts.set(lag.key, revertError('NotAcknowledged', [lag.key]));
        await keeper.tick();
        assert.equal((await actions(store)).find((a) => a.sequence === 3), undefined);
    });
});

test('dropped or reverted keeper transactions are re-evaluated from chain', async () => {
    await withSetup(async ({ store, fake, keeper }) => {
        const t = NOW - 300;
        const a = await insertChainIncident(store, { sequence: 1, observedAt: t, ownerStatus: 'acknowledged', acknowledgedAt: t + 120 });
        const b = await insertChainIncident(store, { sequence: 2, observedAt: t, ownerStatus: 'acknowledged', acknowledgedAt: t + 120 });
        for (const inc of [a, b]) fake.state.settlements.set(inc.key, settlementFor(inc, { status: 2, canRecordAck: true }));
        await keeper.tick();
        const [txA, txB] = fake.state.calls;
        fake.state.mempool.delete(txA.hash); // dropped
        fake.mine(txB.hash, { status: 0 }); // reverted (lost a race)
        // Meanwhile another keeper recorded b.
        fake.state.settlements.set(b.key, settlementFor(b, { status: 2, flags: F.TIMELY_ACK | F.ACK_REWARDED }));

        await keeper.tick();
        const rows = await actions(store);
        assert.deepEqual(rows.map((r) => [r.sequence, r.status]), [[1, 'pending'], [2, 'skipped']]);
        assert.equal(fake.state.calls.length, 3, 'only the dropped one is re-sent');
        assert.equal(fake.state.calls[2].key, a.key);
    });
});

test('KEEPER_BATCH_SIZE bounds the incidents handled per tick, rewards first', async () => {
    await withSetup(async ({ store, fake, keeper }) => {
        const t = NOW - 300;
        const old = NOW - 3_600;
        for (let seq = 1; seq <= 3; seq++) {
            const inc = await insertChainIncident(store, { sequence: seq, observedAt: t, ownerStatus: 'acknowledged', acknowledgedAt: t + 120 });
            fake.state.settlements.set(inc.key, settlementFor(inc, { status: 2, canRecordAck: true }));
        }
        const overdue = await insertChainIncident(store, { sequence: 4, severity: 2, observedAt: old });
        fake.state.settlements.set(overdue.key, settlementFor(overdue, { canSlashMissedAck: true }));
        fake.state.bonds.set(overdue.hash, { amount: 100n * ASAFE, since: 0 });

        await keeper.tick();
        assert.deepEqual(fake.state.calls.map((c) => c.method), ['recordTimelyAck', 'recordTimelyAck']);
        await keeper.tick();
        assert.deepEqual(fake.state.calls.map((c) => c.method), ['recordTimelyAck', 'recordTimelyAck', 'recordTimelyAck', 'slashMissedAck']);
    }, { config: { ...CONFIG, batchSize: 2 } });
});
