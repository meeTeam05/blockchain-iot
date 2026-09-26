// End-to-end: real API + EMQX + TimescaleDB from server/docker-compose.yml.
// Skipped unless E2E_API_URL and E2E_MQTT_URL are set. Run inside the compose network:
//
//   docker run --rm --network smart-air_sa-net --env-file server/.env \
//     -e E2E_API_URL=http://api:3000 -e E2E_MQTT_URL=mqtt://emqx:1883 \
//     -v "<repo>:/repo" -w /repo/server/api node:20-alpine \
//     node --test test/e2e/incident-mqtt.e2e.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import mqtt from 'mqtt';
import pg from 'pg';
import { SigningKey, computeAddress } from 'ethers';

import { domainFromConfig } from '../../src/services/incident-verify.js';
import { clearEmqxAuthorizationCache, syncDeviceRules } from '../../src/services/emqx.js';
import { registerSigner } from '../../src/services/device-signers.js';
import { config } from '../../src/config.js';
import { signIncident } from '../helpers/incident-signing.js';

const API_URL = process.env.E2E_API_URL;
const MQTT_URL = process.env.E2E_MQTT_URL;
const skip = !API_URL || !MQTT_URL ? 'set E2E_API_URL and E2E_MQTT_URL to run against docker compose' : false;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VECTOR_PATH = path.resolve(__dirname, '../../../../docs/test-vectors/incident-v2-model-early-warning.json');

function randomMac() {
    return [...randomBytes(6)].map((b, i) => (i === 0 ? b & 0xfe : b).toString(16).padStart(2, '0')).join(':');
}

async function api(method, url, { token, body } = {}) {
    const res = await fetch(`${API_URL}${url}`, {
        method,
        headers: {
            ...(body ? { 'Content-Type': 'application/json' } : {}),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
}

function connectDevice(deviceId, secretKey) {
    return new Promise((resolve, reject) => {
        const client = mqtt.connect(MQTT_URL, {
            username: deviceId,
            password: secretKey,
            clientId: `e2e-${deviceId}`,
            reconnectPeriod: 0,
            connectTimeout: 10_000,
        });
        client.once('connect', () => resolve(client));
        client.once('error', reject);
    });
}

function nextAck(client, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no incident ACK received')), timeoutMs);
        client.once('message', (topic, message) => {
            clearTimeout(timer);
            resolve({ topic, ack: JSON.parse(message.toString()) });
        });
    });
}

async function publishAndAwaitAck(client, deviceId, payload) {
    const ack = nextAck(client);
    await client.publishAsync(`device/${deviceId}/incident`, JSON.stringify(payload), { qos: 1 });
    return ack;
}

async function emqxPutRules(deviceId, rules) {
    const auth = Buffer.from(`${config.emqx.apiKey}:${config.emqx.apiSecret}`).toString('base64');
    const res = await fetch(
        `${config.emqx.apiUrl}/api/v5/authorization/sources/built_in_database/rules/users/${encodeURIComponent(deviceId)}`,
        {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
            body: JSON.stringify({ username: deviceId, rules }),
        }
    );
    assert.ok(res.ok, `EMQX rule update failed: ${res.status}`);
    await fetch(`${config.emqx.apiUrl}/api/v5/authorization/cache`, { method: 'DELETE', headers: { Authorization: `Basic ${auth}` } });
}

test('device publishes a signed incident through EMQX and receives an idempotent ACK', { skip, timeout: 120_000 }, async () => {
    const vector = JSON.parse(await readFile(VECTOR_PATH, 'utf8'));
    const domain = domainFromConfig(config.incident);
    const signingKey = new SigningKey(`0x${randomBytes(32).toString('hex')}`);
    const deviceId = randomMac();

    // 1. User, home and device through the real API (EMQX user + ACL provisioned by the API).
    const email = `e2e-${Date.now()}@example.com`;
    assert.equal((await api('POST', '/api/auth/register', { body: { email, password: 'e2e-password-123' } })).status, 201);
    const login = await api('POST', '/api/auth/login', { body: { email, password: 'e2e-password-123' } });
    const token = login.body.accessToken;
    const home = await api('POST', '/api/homes', { token, body: { name: 'E2E home' } });
    assert.equal(home.status, 201);
    const device = await api('POST', '/api/devices', { token, body: { device_id: deviceId, name: 'E2E sensor', home_id: home.body.id } });
    assert.equal(device.status, 201, JSON.stringify(device.body));

    // 2. Register the device signer (operator path).
    const pool = new pg.Pool({
        host: config.db.host,
        port: config.db.port,
        database: config.db.database,
        user: config.db.user,
        password: config.db.password,
    });
    const client = await connectDevice(deviceId, device.body.secret_key);
    try {
        await registerSigner(pool, deviceId, computeAddress(signingKey));
        await client.subscribeAsync(`device/${deviceId}/incident/ack`, { qos: 1 });

        const now = Math.floor(Date.now() / 1000);
        const payload = signIncident({
            vector,
            domain,
            signingKey,
            payload: {
                ...vector.evidence,
                device_id: deviceId,
                firmware_version: vector.transport.firmware_version,
                calibration_canonical: vector.transport.calibration_canonical,
            },
            overrides: { sequence: '1', observed_at: String(now) },
        });

        // 3. First delivery: stored + ACK accepted.
        const first = await publishAndAwaitAck(client, deviceId, payload);
        assert.equal(first.topic, `device/${deviceId}/incident/ack`);
        assert.equal(first.ack.accepted, true, JSON.stringify(first.ack));
        assert.equal(first.ack.incident_id, payload.incident_id);
        assert.equal(first.ack.evidence_hash, payload.evidence_hash);

        // 4. Retry of the same bytes: ACK accepted again, same received_at, no new row.
        const retry = await publishAndAwaitAck(client, deviceId, payload);
        assert.equal(retry.ack.accepted, true);
        assert.equal(retry.ack.received_at, first.ack.received_at);

        // 5. Tampered evidence: rejected, nothing stored.
        const tampered = await publishAndAwaitAck(client, deviceId, { ...payload, co_ppm_x1000: 1 });
        assert.equal(tampered.ack.accepted, false);
        assert.equal(tampered.ack.error_code, 'HASH_MISMATCH');

        const counts = await pool.query(
            `SELECT (SELECT COUNT(*) FROM incidents WHERE device_id = $1)::int AS incidents,
                    (SELECT COUNT(*) FROM blockchain_outbox WHERE device_id = $1 AND status = 'queued')::int AS queued,
                    (SELECT COUNT(*) FROM security_events WHERE device_id = $1 AND type = 'HASH_MISMATCH')::int AS security`,
            [deviceId]
        );
        assert.deepEqual(counts.rows[0], { incidents: 1, queued: 1, security: 1 });

        // 6. API verify recomputes everything from the stored raw payload.
        const verify = await api('GET', `/api/devices/${deviceId}/incidents/${payload.incident_id}/verify`, { token });
        assert.equal(verify.status, 200);
        assert.equal(verify.body.valid, true, JSON.stringify(verify.body));
        assert.equal(verify.body.signature.signer_status, 'active');
        assert.equal(verify.body.chain.status, 'queued');

        const list = await api('GET', `/api/devices/${deviceId}/incidents`, { token });
        assert.deepEqual(list.body.map((i) => [i.sequence, i.severity, i.chain_status]), [['1', 'warning', 'queued']]);
    } finally {
        await client.endAsync();
        await pool.end();
    }
});

test('a device registered before the incident ACL is disconnected until sync-device-acl runs', { skip, timeout: 120_000 }, async () => {
    const deviceId = randomMac();
    const email = `e2e-acl-${Date.now()}@example.com`;
    await api('POST', '/api/auth/register', { body: { email, password: 'e2e-password-123' } });
    const token = (await api('POST', '/api/auth/login', { body: { email, password: 'e2e-password-123' } })).body.accessToken;
    const home = await api('POST', '/api/homes', { token, body: { name: 'E2E ACL home' } });
    const device = await api('POST', '/api/devices', { token, body: { device_id: deviceId, name: 'Legacy sensor', home_id: home.body.id } });
    assert.equal(device.status, 201);

    // Simulate a legacy ACL without the incident topics.
    await emqxPutRules(deviceId, [
        { topic: `device/${deviceId}/status`, action: 'publish', permission: 'allow' },
        { topic: `device/${deviceId}/telemetry`, action: 'publish', permission: 'allow' },
    ]);
    const legacy = await connectDevice(deviceId, device.body.secret_key);
    const closed = new Promise((resolve) => legacy.once('close', resolve));
    legacy.publish(`device/${deviceId}/incident`, '{}', { qos: 1 });
    await closed;
    legacy.end(true);

    // Same calls as scripts/sync-device-acl.js.
    await syncDeviceRules(deviceId);
    await clearEmqxAuthorizationCache();
    const synced = await connectDevice(deviceId, device.body.secret_key);
    try {
        await synced.subscribeAsync(`device/${deviceId}/incident/ack`, { qos: 1 });
        // '{}' carries no incident_id, so no ACK is expected: only check the session survives.
        await synced.publishAsync(`device/${deviceId}/incident`, '{}', { qos: 1 });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        assert.equal(synced.connected, true);
    } finally {
        await synced.endAsync();
    }
});
