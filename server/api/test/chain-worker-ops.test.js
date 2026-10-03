// Task 4 operations: worker heartbeat + worker-level alerts, alert webhook delivery,
// metrics/health evaluation and the /api/health/chain + /api/metrics/chain routes.
import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { parseEther } from 'ethers';

import { chainErrorText } from '../src/chain/air-safety-log.js';
import { createAlertDelivery, raiseOpsAlert } from '../src/chain/ops-alerts.js';
import { createWorkerStatus } from '../src/chain/worker-status.js';
import chainHealthRoutes from '../src/routes/chain-health.js';
import { acknowledgeAlerts, listAlerts } from '../src/services/chain-ops-admin.js';
import { collectChainMetrics, evaluateChainHealth, renderPrometheus } from '../src/services/chain-metrics.js';
import { DEVICE_ID, createIncidentDb } from './helpers/incident-fixtures.js';

const CONTRACT = '0x45CF175ffd4B1Ad77E87389d1e92945f9Bc88d3A';
const RELAYER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const LOG = { info() {}, warn() {}, error() {} };
const THRESHOLDS = Object.freeze({
    maxTickAgeSeconds: 120,
    maxQueuedAgeSeconds: 900,
    maxLagBlocks: 50,
    minRelayerBalanceWei: parseEther('0.05'),
    failureStreak: 3,
});

function fakeChain({ head = 1_000, balance = parseEther('1') } = {}) {
    return {
        address: CONTRACT,
        relayerWallet: { address: RELAYER },
        provider: { getBlockNumber: async () => head, getBalance: async () => balance },
    };
}

function workerStatus(store, chain, { at = () => new Date(), streak = 3 } = {}) {
    return createWorkerStatus({
        db: store,
        chain,
        config: { alertFailureStreak: streak, balanceCheckIntervalMs: 60_000, minRelayerBalanceWei: THRESHOLDS.minRelayerBalanceWei },
        log: LOG,
        now: at,
    });
}

async function alertKinds(store) {
    return (await store.query('SELECT kind FROM chain_ops_alerts ORDER BY id')).rows.map((r) => r.kind);
}

test('chainErrorText falls through empty ethers messages to something readable', () => {
    assert.equal(chainErrorText({ shortMessage: '', message: '', code: 'ECONNREFUSED' }), 'ECONNREFUSED');
    assert.equal(chainErrorText({ shortMessage: 'could not coalesce error', message: 'long' }), 'could not coalesce error');
    assert.equal(chainErrorText(new Error('boom')), 'boom');
    assert.equal(chainErrorText({ shortMessage: '', message: '' }), 'unknown error');
    assert.equal(chainErrorText('plain string'), 'plain string');
});

test('heartbeat: success records head + balance; a failure streak alerts once per streak', async () => {
    const store = await createIncidentDb();
    try {
        const status = workerStatus(store, fakeChain());
        await status.start();
        await status.success();
        let { rows: [w] } = await store.query('SELECT * FROM chain_worker_status');
        assert.equal(w.contract_address, CONTRACT.toLowerCase());
        assert.equal(w.relayer_address, RELAYER.toLowerCase());
        assert.equal(Number(w.head_block), 1_000);
        assert.equal(String(w.relayer_balance_wei), parseEther('1').toString());

        for (let i = 0; i < 4; i++) await status.failure(new Error('RPC 429 Too Many Requests'));
        ({ rows: [w] } = await store.query('SELECT * FROM chain_worker_status'));
        assert.equal(w.consecutive_failures, 4);
        assert.equal(Number(w.rpc_errors_total), 4);
        assert.match(w.last_error, /429/);
        assert.deepEqual(await alertKinds(store), ['worker_failing'], 'failures 3 and 4 share one streak alert');

        await status.success();
        ({ rows: [w] } = await store.query('SELECT consecutive_failures FROM chain_worker_status'));
        assert.equal(w.consecutive_failures, 0);
        for (let i = 0; i < 3; i++) await status.failure(new Error('ECONNRESET'));
        assert.deepEqual(await alertKinds(store), ['worker_failing', 'worker_failing'], 'a new streak alerts again');

        await status.stopped(new Error('relayer lost its role'));
        assert.equal((await alertKinds(store)).at(-1), 'worker_stopped');
    } finally {
        await store.close();
    }
});

test('a low relayer balance raises one warning per day', async () => {
    const store = await createIncidentDb();
    try {
        let clock = new Date('2026-10-02T08:00:00Z');
        const status = workerStatus(store, fakeChain({ balance: parseEther('0.01') }), { at: () => clock });
        await status.start();
        await status.success();
        clock = new Date('2026-10-02T09:00:00Z');
        await status.success();
        clock = new Date('2026-10-03T08:00:00Z');
        await status.success();
        const { rows } = await store.query('SELECT kind, severity FROM chain_ops_alerts ORDER BY id');
        assert.deepEqual(rows, [
            { kind: 'relayer_low_balance', severity: 'warning' },
            { kind: 'relayer_low_balance', severity: 'warning' },
        ]);
    } finally {
        await store.close();
    }
});

test('webhook delivery: in order, stops at the first failure, retries later; acknowledge closes alerts', async () => {
    const store = await createIncidentDb();
    try {
        for (const n of [1, 2, 3]) {
            await raiseOpsAlert(store, { kind: 'outbox_blocked', dedupeKey: `k${n}`, deviceId: DEVICE_ID, subjectId: n, message: `row ${n} blocked` });
        }
        assert.equal(await raiseOpsAlert(store, { kind: 'outbox_blocked', dedupeKey: 'k1', message: 'dup' }), null, 'dedupe_key is idempotent');

        const posted = [];
        let up = false;
        const fetchImpl = async (url, init) => {
            posted.push(JSON.parse(init.body));
            return { ok: up || posted.length === 1, status: 503 };
        };
        const delivery = createAlertDelivery({ db: store, webhookUrl: 'https://hooks.example/x', fetchImpl, log: LOG });
        assert.equal(await delivery.deliverPending(), 1, 'first delivered, second failed, third not tried');
        assert.deepEqual(posted.map((b) => b.alert.message), ['row 1 blocked', 'row 2 blocked']);
        assert.equal(posted[0].text, '[CRITICAL] outbox_blocked: row 1 blocked');
        assert.equal(posted[0].content, posted[0].text);

        up = true;
        assert.equal(await delivery.deliverPending(), 2);
        const { rows } = await store.query('SELECT delivered_at IS NOT NULL AS delivered, delivery_attempts FROM chain_ops_alerts ORDER BY id');
        assert.deepEqual(rows, [{ delivered: true, delivery_attempts: 1 }, { delivered: true, delivery_attempts: 2 }, { delivered: true, delivery_attempts: 1 }]);

        assert.equal(await createAlertDelivery({ db: store, webhookUrl: '', log: LOG }).deliverPending(), 0, 'no webhook configured');
        assert.equal((await listAlerts(store)).length, 3);
        assert.equal((await acknowledgeAlerts(store, { all: true })).length, 3);
        assert.equal((await listAlerts(store)).length, 0);
    } finally {
        await store.close();
    }
});

async function seedQueues(store) {
    await store.query(
        `INSERT INTO chain_worker_status (contract_address, relayer_address, started_at, last_tick_at, last_success_at, head_block, relayer_balance_wei)
         VALUES ($1, $2, NOW(), NOW(), NOW(), 1000, $3)`,
        [CONTRACT.toLowerCase(), RELAYER.toLowerCase(), parseEther('1').toString()]
    );
    await store.query('INSERT INTO chain_checkpoints (contract_address, last_block) VALUES ($1, 998)', [CONTRACT.toLowerCase()]);
}

test('metrics: an idle healthy worker is ok; blocked rows, lag, stale heartbeat and low balance degrade it', async () => {
    const store = await createIncidentDb();
    try {
        let health = evaluateChainHealth(await collectChainMetrics(store), THRESHOLDS);
        assert.deepEqual(health, { status: 'degraded', reasons: ['chain worker has never reported a heartbeat'] });

        await seedQueues(store);
        let metrics = await collectChainMetrics(store);
        assert.equal(metrics.worker.index_lag_blocks, 2);
        assert.equal(metrics.outbox.by_status.blocked, 0);
        assert.deepEqual(evaluateChainHealth(metrics, THRESHOLDS), { status: 'ok', reasons: [] });

        await store.query(
            `INSERT INTO device_chain_ops (device_id, op, status, attempts, created_at) VALUES ($1, 'revoke', 'blocked', 10, NOW() - INTERVAL '2 hours'),
                                                                                           ($1, 'revoke', 'queued', 0, NOW() - INTERVAL '1 hour')`,
            [DEVICE_ID]
        );
        await store.query(`UPDATE chain_worker_status SET last_tick_at = NOW() - INTERVAL '10 minutes', head_block = 1100,
                                  consecutive_failures = 3, relayer_balance_wei = $1`, [parseEther('0.001').toString()]);
        metrics = await collectChainMetrics(store);
        assert.equal(metrics.device_ops.by_status.blocked, 1);
        assert.ok(metrics.device_ops.oldest_queued_age_seconds >= 3_599);
        health = evaluateChainHealth(metrics, THRESHOLDS);
        assert.equal(health.status, 'degraded');
        for (const pattern of [/heartbeat is \d+s old/, /failed 3 iterations/, /102 blocks behind/, /relayer balance 0.001 ETH/, /1 device op item\(s\) blocked/, /oldest queued device op item/]) {
            assert.ok(health.reasons.some((r) => pattern.test(r)), `missing reason ${pattern}: ${health.reasons.join(' | ')}`);
        }

        const text = renderPrometheus(metrics, health);
        assert.match(text, /^smartair_chain_healthy 0$/m);
        assert.match(text, /^smartair_chain_device_ops_items\{status="blocked"\} 1$/m);
        assert.match(text, /^smartair_chain_index_lag_blocks 102$/m);
        assert.match(text, /^smartair_chain_relayer_balance_eth 0.001$/m);
        assert.match(text, /^# TYPE smartair_chain_worker_rpc_errors_total counter$/m);
    } finally {
        await store.close();
    }
});

async function app(store, options) {
    const fastify = Fastify({ logger: false });
    fastify.decorate('db', store.db);
    await fastify.register(chainHealthRoutes, { prefix: '/api', thresholds: THRESHOLDS, ...options });
    return fastify;
}

test('routes: public summary, operator-only metrics behind OPS_METRICS_TOKEN, closed in production without a token', async () => {
    const store = await createIncidentDb();
    try {
        await seedQueues(store);
        const withToken = await app(store, { metricsToken: 's3cret', isProduction: true });
        let res = await withToken.inject({ method: 'GET', url: '/api/health/chain' });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(Object.keys(res.json()).sort(), ['checked_at', 'reasons', 'status']);
        res = await withToken.inject({ method: 'GET', url: '/api/health/chain', headers: { authorization: 'Bearer s3cret' } });
        assert.equal(res.json().metrics.worker.head_block, 1000);
        assert.equal((await withToken.inject({ method: 'GET', url: '/api/metrics/chain' })).statusCode, 401);
        assert.equal((await withToken.inject({ method: 'GET', url: '/api/metrics/chain', headers: { authorization: 'Bearer wrong!' } })).statusCode, 401);
        res = await withToken.inject({ method: 'GET', url: '/api/metrics/chain', headers: { authorization: 'Bearer s3cret' } });
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /text\/plain/);
        assert.match(res.body, /^smartair_chain_healthy 1$/m);

        await store.query("INSERT INTO device_chain_ops (device_id, op, status) VALUES ($1, 'revoke', 'failed')", [DEVICE_ID]);
        res = await withToken.inject({ method: 'GET', url: '/api/health/chain' });
        assert.equal(res.statusCode, 503);
        assert.deepEqual(res.json().reasons, ['1 device op item(s) failed']);
        await withToken.close();

        const prodNoToken = await app(store, { metricsToken: '', isProduction: true });
        assert.equal((await prodNoToken.inject({ method: 'GET', url: '/api/metrics/chain' })).statusCode, 404);
        assert.equal((await prodNoToken.inject({ method: 'GET', url: '/api/health/chain' })).json().metrics, undefined);
        await prodNoToken.close();

        const dev = await app(store, { metricsToken: '', isProduction: false });
        assert.equal((await dev.inject({ method: 'GET', url: '/api/metrics/chain' })).statusCode, 200);
        await dev.close();
    } finally {
        await store.close();
    }
});
