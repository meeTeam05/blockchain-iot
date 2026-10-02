// Task 4 relayer behaviour on the incident outbox: bounded retries, blocked/failed alerts,
// operator requeue, RPC timeouts and dropped transactions. Rows are created through the
// real intake so they carry real signatures, incident keys and signer gates.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createRelayer } from '../src/chain/relayer.js';
import { computeIncidentKey, handleIncident } from '../src/services/incident-intake.js';
import { requeueDeviceOps, requeueOutbox } from '../src/services/chain-ops-admin.js';
import { DEVICE_ID, createIncidentDb, createIntakeFastify, loadVector, rawBytes, signIncident } from './helpers/incident-fixtures.js';

const CONFIG = { maxAttempts: 2, maxRetryAgeHours: 24, batchSize: 20, confirmations: 1 };
const LOG = { info() {}, warn() {}, error() {} };
const TX_HASH = `0x${'ab'.repeat(32)}`;
const ZERO_HASH = `0x${'00'.repeat(32)}`;

async function seed(sequences) {
    const early = await loadVector('earlyWarning');
    const store = await createIncidentDb({ signerAddress: early.vector.expected.signer });
    const fastify = createIntakeFastify(store);
    for (const sequence of sequences) {
        const payload = signIncident({ ...early, overrides: { sequence: String(sequence) } });
        const result = await handleIncident(fastify, DEVICE_ID, payload, rawBytes(payload), {
            domain: early.domain,
            incidentConfig: { maxPayloadBytes: 4096, clockSkewSeconds: 600 },
            now: () => new Date((Number(payload.observed_at) + 5) * 1000),
        });
        assert.equal(result.accepted, true);
    }
    return { early, store };
}

// In-memory AirSafetyLog: `logged` is the chain state, `sends` every broadcast attempt.
function mockChain(early, { staticCall = async () => {}, send = async () => ({ hash: TX_HASH }) } = {}) {
    const logged = new Map();
    const sends = [];
    const logIncident = async (claim, signature) => {
        sends.push(claim);
        return send(claim, signature, logged);
    };
    logIncident.staticCall = async (claim) => staticCall(claim);
    return {
        logged,
        sends,
        address: early.domain.verifyingContract,
        read: {
            getDevice: async () => ({ exists: true, active: true, signer: early.vector.expected.signer, hasLogged: false, lastSequence: 0n }),
            getIncident: async (key) => (logged.has(key)
                ? { status: 1n, evidenceHash: logged.get(key) }
                : { status: 0n, evidenceHash: ZERO_HASH }),
        },
        relayer: { logIncident },
        provider: {
            getBlockNumber: async () => 100,
            getTransactionReceipt: async () => null,
            getTransaction: async () => null,
        },
    };
}

async function outbox(store) {
    const { rows } = await store.query(
        `SELECT id, sequence::text AS sequence, status, attempts, next_attempt_at, tx_hash, fail_reason, incident_key
         FROM blockchain_outbox ORDER BY sequence`
    );
    return Object.fromEntries(rows.map((row) => [row.sequence, row]));
}

async function alerts(store) {
    const { rows } = await store.query('SELECT kind, severity, subject_id, device_id, message FROM chain_ops_alerts ORDER BY id');
    return rows;
}

function relayer(store, chain, config = CONFIG) {
    return createRelayer({ db: store, chain, config, log: LOG });
}

test('a transient RPC failure backs off, then blocks with one alert, while a later sequence of the same device is still sent', async () => {
    const { early, store } = await seed([1, 2]);
    try {
        const chain = mockChain(early, {
            staticCall: async (claim) => {
                if (claim.sequence === 1n) throw new Error('RPC unavailable');
            },
        });
        await relayer(store, chain).submitOutbox();
        let rows = await outbox(store);
        assert.equal(rows['1'].status, 'queued');
        assert.equal(rows['1'].attempts, 1);
        assert.ok(new Date(rows['1'].next_attempt_at).getTime() > Date.now() + 60_000, 'first retry is backed off');
        assert.equal(rows['2'].status, 'pending', 'sequence 2 does not wait behind sequence 1');

        await store.query("UPDATE blockchain_outbox SET next_attempt_at = NOW() WHERE sequence = 1");
        await relayer(store, chain).submitOutbox();
        rows = await outbox(store);
        assert.equal(rows['1'].status, 'blocked');
        assert.equal(rows['1'].attempts, 2);
        assert.equal(rows['2'].status, 'pending');

        const raised = await alerts(store);
        assert.equal(raised.length, 1);
        assert.equal(raised[0].kind, 'outbox_blocked');
        assert.equal(raised[0].severity, 'critical');
        assert.equal(raised[0].device_id, DEVICE_ID);
        assert.equal(raised[0].subject_id, String(rows['1'].id));
        assert.match(raised[0].message, /sequence 1 .* blocked/);
        assert.equal(chain.sends.length, 1, 'only sequence 2 was ever broadcast');
    } finally {
        await store.close();
    }
});

test('an expired retry window blocks on the first failure; an operator requeue opens a fresh window and the row is sent', async () => {
    const { early, store } = await seed([1]);
    try {
        await store.query("UPDATE blockchain_outbox SET created_at = NOW() - INTERVAL '25 hours'");
        const failing = mockChain(early, { staticCall: async () => { throw new Error('ETIMEDOUT'); } });
        await relayer(store, failing).submitOutbox();
        let row = (await outbox(store))['1'];
        assert.equal(row.status, 'blocked');
        assert.equal(row.attempts, 1);

        await assert.rejects(requeueOutbox(store, { ids: [] }), TypeError);
        const requeued = await requeueOutbox(store, { ids: [row.id] });
        assert.equal(requeued.length, 1);
        row = (await outbox(store))['1'];
        assert.equal(row.status, 'queued');
        assert.equal(row.attempts, 0);
        assert.deepEqual(await requeueOutbox(store, { allBlocked: true }), [], 'requeue only touches blocked rows');

        // Same failure again: now inside a fresh window, so it is retried, not blocked.
        await relayer(store, failing).submitOutbox();
        assert.equal((await outbox(store))['1'].status, 'queued');

        await store.query('UPDATE blockchain_outbox SET next_attempt_at = NOW()');
        await relayer(store, mockChain(early)).submitOutbox();
        assert.equal((await outbox(store))['1'].status, 'pending');
    } finally {
        await store.close();
    }
});

test('an RPC timeout after the transaction was broadcast never produces a second transaction', async () => {
    const { early, store } = await seed([1]);
    try {
        // The node accepted and mined the tx, but the client saw a timeout.
        const chain = mockChain(early, {
            send: async (claim, _signature, logged) => {
                logged.set(computeIncidentKey(claim.deviceIdHash, claim.incidentId), claim.evidenceHash);
                throw new Error('request timeout');
            },
        });
        await relayer(store, chain).submitOutbox();
        assert.equal((await outbox(store))['1'].status, 'queued');

        await store.query('UPDATE blockchain_outbox SET next_attempt_at = NOW()');
        await relayer(store, chain).submitOutbox();
        const row = (await outbox(store))['1'];
        assert.equal(row.status, 'confirmed', 'the pre-check found the incident on chain');
        assert.equal(chain.sends.length, 1, 'logIncident was broadcast exactly once');
        assert.deepEqual(await alerts(store), []);
    } finally {
        await store.close();
    }
});

test('a dropped transaction at the attempt bound is blocked instead of being requeued forever', async () => {
    const { early, store } = await seed([1]);
    try {
        await store.query("UPDATE blockchain_outbox SET status = 'pending', attempts = 2, tx_hash = $1", [TX_HASH]);
        await relayer(store, mockChain(early)).reconcileOutbox();
        const row = (await outbox(store))['1'];
        assert.equal(row.status, 'blocked');
        assert.equal(row.tx_hash, null);
        assert.equal((await alerts(store))[0].kind, 'outbox_blocked');

        // Below the bound the same drop is simply requeued for a fresh pre-check.
        await requeueOutbox(store, { allBlocked: true });
        await store.query("UPDATE blockchain_outbox SET status = 'pending', attempts = 1, tx_hash = $1", [TX_HASH]);
        await relayer(store, mockChain(early)).reconcileOutbox();
        assert.equal((await outbox(store))['1'].status, 'queued');
    } finally {
        await store.close();
    }
});

test('an on-chain conflict fails the row, records CHAIN_CONFLICT and raises outbox_failed', async () => {
    const { early, store } = await seed([1]);
    try {
        const chain = mockChain(early, {
            staticCall: async () => { throw { revert: { name: 'SequenceAlreadyUsed', args: [early.payload.device_id_hash, 1n] } }; },
        });
        await relayer(store, chain).submitOutbox();
        const row = (await outbox(store))['1'];
        assert.equal(row.status, 'failed');
        assert.match(row.fail_reason, /SequenceAlreadyUsed/);
        const { rows } = await store.query("SELECT type FROM security_events WHERE type = 'CHAIN_CONFLICT'");
        assert.equal(rows.length, 1);
        const raised = await alerts(store);
        assert.equal(raised.length, 1);
        assert.equal(raised[0].kind, 'outbox_failed');
        assert.deepEqual(await requeueOutbox(store, { allBlocked: true }), [], 'failed rows need --include-failed');
    } finally {
        await store.close();
    }
});

test('a blocked device op raises device_op_blocked and an operator requeue releases it', async () => {
    const { early, store } = await seed([]);
    try {
        const signer = `0x${'11'.repeat(20)}`;
        const { rows: [op] } = await store.query(
            `INSERT INTO device_chain_ops (device_id, op, signer_address, owner_address) VALUES ($1, 'register', $2, $2) RETURNING id`,
            [DEVICE_ID, signer]
        );
        const registerDevice = async () => { throw new Error('RPC unavailable'); };
        registerDevice.staticCall = registerDevice;
        const chain = {
            ...mockChain(early),
            read: { getDevice: async () => ({ exists: false, active: false }) },
            manager: { registerDevice },
        };
        await relayer(store, chain, { ...CONFIG, maxAttempts: 1 }).submitOps();
        const state = async () => (await store.query('SELECT status, attempts FROM device_chain_ops WHERE id = $1', [op.id])).rows[0];
        assert.equal((await state()).status, 'blocked');
        const raised = await alerts(store);
        assert.equal(raised.length, 1);
        assert.equal(raised[0].kind, 'device_op_blocked');
        assert.match(raised[0].message, /later ops of this device wait/);

        assert.equal((await requeueDeviceOps(store, { ids: [op.id] })).length, 1);
        assert.deepEqual(await state(), { status: 'queued', attempts: 0 });
    } finally {
        await store.close();
    }
});
