import test from 'node:test';
import assert from 'node:assert/strict';

import { createRelayer } from '../src/chain/relayer.js';
import { createIncidentDb, DEVICE_ID, OTHER_DEVICE_ID } from './helpers/incident-fixtures.js';

const ADDRESS = `0x${'11'.repeat(20)}`;
const TX_HASH = `0x${'22'.repeat(32)}`;
const CONFIG = { maxAttempts: 2, maxRetryAgeHours: 24, batchSize: 20, confirmations: 1 };
const LOG = { info() {}, warn() {}, error() {} };

function chain(register, provider = {}) {
    const registerDevice = async () => register();
    registerDevice.staticCall = async () => register({ preflight: true });
    return {
        address: ADDRESS,
        read: { getDevice: async () => ({ exists: false, active: false }) },
        manager: { registerDevice },
        provider: {
            getBlockNumber: async () => 1,
            getTransactionReceipt: async () => null,
            getTransaction: async () => null,
            ...provider,
        },
    };
}

async function insertRegister(store, deviceId = DEVICE_ID, createdAt = null) {
    const { rows } = await store.query(
        `INSERT INTO device_chain_ops (device_id, op, signer_address, owner_address, created_at)
         VALUES ($1, 'register', $2, $2, COALESCE($3::timestamptz, NOW())) RETURNING id`,
        [deviceId, ADDRESS, createdAt]
    );
    return rows[0].id;
}

async function opState(store, id) {
    const { rows } = await store.query('SELECT status, attempts, last_error, next_attempt_at, tx_hash FROM device_chain_ops WHERE id = $1', [id]);
    return rows[0];
}

test('transient lifecycle failure backs off, survives restart, then blocks at max attempts without blocking another device', async () => {
    const store = await createIncidentDb();
    try {
        const first = await insertRegister(store);
        const second = await insertRegister(store); // same device must wait behind blocked first op
        const failing = chain(() => { throw new Error('RPC unavailable'); });
        await createRelayer({ db: store, chain: failing, config: CONFIG, log: LOG }).submitOps();
        const retry = await opState(store, first);
        assert.equal(retry.status, 'queued');
        assert.equal(retry.attempts, 1);
        assert.match(retry.last_error, /RPC unavailable/);
        assert.ok(new Date(retry.next_attempt_at).getTime() > Date.now() + 60_000);
        assert.equal((await opState(store, second)).attempts, 0);

        await store.query('UPDATE device_chain_ops SET next_attempt_at = NOW() WHERE id = $1', [first]);
        await createRelayer({ db: store, chain: failing, config: CONFIG, log: LOG }).submitOps();
        assert.equal((await opState(store, first)).status, 'blocked');
        assert.equal((await opState(store, first)).attempts, 2);

        const other = await insertRegister(store, OTHER_DEVICE_ID);
        const healthy = chain(() => ({ hash: TX_HASH }));
        await createRelayer({ db: store, chain: healthy, config: CONFIG, log: LOG }).submitOps();
        assert.equal((await opState(store, second)).status, 'queued');
        assert.equal((await opState(store, other)).status, 'pending');
    } finally {
        await store.close();
    }
});

test('expired lifecycle operation blocks without submitting; deterministic revert fails immediately', async () => {
    const store = await createIncidentDb();
    try {
        const expired = await insertRegister(store, DEVICE_ID, new Date(Date.now() - 25 * 3_600_000).toISOString());
        let calls = 0;
        const noSubmit = chain(() => { calls++; return { hash: TX_HASH }; });
        await createRelayer({ db: store, chain: noSubmit, config: CONFIG, log: LOG }).submitOps();
        assert.equal((await opState(store, expired)).status, 'blocked');
        assert.equal(calls, 0);

        const other = await insertRegister(store, OTHER_DEVICE_ID);
        const deterministic = chain(() => { throw { revert: { name: 'SignerAlreadyUsed', args: [ADDRESS] } }; });
        await createRelayer({ db: store, chain: deterministic, config: CONFIG, log: LOG }).submitOps();
        const state = await opState(store, other);
        assert.equal(state.status, 'failed');
        assert.match(state.last_error, /SignerAlreadyUsed/);
    } finally {
        await store.close();
    }
});

test('dropped pending transaction reaches the retry bound and remains blocked after restart', async () => {
    const store = await createIncidentDb();
    try {
        const id = await insertRegister(store);
        await store.query("UPDATE device_chain_ops SET status = 'pending', attempts = 2, tx_hash = $2 WHERE id = $1", [id, TX_HASH]);
        const mock = chain(() => ({ hash: TX_HASH }));
        await createRelayer({ db: store, chain: mock, config: CONFIG, log: LOG }).reconcileOps();
        const state = await opState(store, id);
        assert.equal(state.status, 'blocked');
        assert.equal(state.attempts, 2);
        assert.equal(state.tx_hash, null);
        await createRelayer({ db: store, chain: mock, config: CONFIG, log: LOG }).submitOps();
        assert.equal((await opState(store, id)).status, 'blocked');
    } finally {
        await store.close();
    }
});
