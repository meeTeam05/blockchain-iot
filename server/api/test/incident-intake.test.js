import test from 'node:test';
import assert from 'node:assert/strict';

import { handleIncident, incidentAckTopic, publishIncidentAck } from '../src/services/incident-intake.js';
import { INCIDENT_ERROR } from '../src/services/incident-verify.js';
import { SigningKey } from 'ethers';
import { registerSigner, revokeSigner } from '../src/services/device-signers.js';
import {
    DEVICE_ID,
    OTHER_DEVICE_ID,
    countRows,
    createIncidentDb,
    createIntakeFastify,
    loadVector,
    rawBytes,
    signIncident,
} from './helpers/incident-fixtures.js';

const INCIDENT_CONFIG = Object.freeze({
    maxPayloadBytes: 4096,
    clockSkewSeconds: 600,
});

async function setup({ withSigner = true } = {}) {
    const early = await loadVector('earlyWarning');
    const exceeded = await loadVector('exceeded');
    const store = await createIncidentDb({ signerAddress: withSigner ? early.vector.expected.signer : null });
    const fastify = createIntakeFastify(store);
    return { early, exceeded, store, fastify };
}

function nowAt(observedAt, offsetSeconds = 5) {
    return () => new Date((Number(observedAt) + offsetSeconds) * 1000);
}

// Mirrors the MQTT plugin: handle (commit), ack the inbound packet, then publish the ACK.
async function deliver(fastify, { domain, payload }, { deviceId = DEVICE_ID, now, raw } = {}) {
    const result = await handleIncident(fastify, deviceId, payload, raw ?? rawBytes(payload), {
        domain,
        incidentConfig: INCIDENT_CONFIG,
        now: now ?? nowAt(payload.observed_at),
    });
    if (result.ack) await publishIncidentAck(fastify, deviceId, result.ack);
    return result;
}

async function securityEventTypes(store) {
    const { rows } = await store.db.query('SELECT type FROM security_events ORDER BY id');
    return rows.map((row) => row.type);
}

test('vector v2 is stored, queued in the outbox, announced and ACKed after commit', async () => {
    const { early, store, fastify } = await setup();
    try {
        const raw = rawBytes(early.payload);
        const result = await deliver(fastify, early, { raw });
        assert.equal(result.accepted, true);

        const { rows } = await store.db.query('SELECT * FROM incidents WHERE device_id = $1', [DEVICE_ID]);
        assert.equal(rows.length, 1);
        const row = rows[0];
        assert.equal(row.incident_id, early.vector.evidence.incident_id);
        assert.equal(String(row.sequence), '43');
        assert.equal(row.evidence_hash, early.vector.expected.evidence_hash);
        assert.equal(row.eip712_digest, early.vector.expected.eip712_digest);
        assert.equal(row.signer_address, early.vector.expected.signer.toLowerCase());
        assert.equal(row.verify_status, 'valid');
        assert.equal(row.owner_status, 'open');
        assert.deepEqual(Buffer.from(row.raw_payload), raw, 'raw payload bytes are stored unchanged');

        const outbox = await store.db.query('SELECT status, attempts, sequence FROM blockchain_outbox WHERE device_id = $1', [DEVICE_ID]);
        assert.deepEqual(outbox.rows.map((r) => [r.status, r.attempts, String(r.sequence)]), [['queued', 0, '43']]);

        const events = await store.db.query('SELECT type, payload FROM realtime_events WHERE device_id = $1', [DEVICE_ID]);
        assert.equal(events.rows.length, 1);
        assert.equal(events.rows[0].type, 'incident.created');
        assert.equal(events.rows[0].payload.severity, 'warning');
        assert.equal(events.rows[0].payload.chain_status, 'queued');

        const notifications = await store.db.query('SELECT type, severity, title FROM notification_events');
        assert.deepEqual(notifications.rows, [{ type: 'incident.warning', severity: 'warning', title: 'Gas early warning' }]);

        assert.equal(fastify.published.length, 1);
        const [{ topic, message, options }] = fastify.published;
        assert.equal(topic, incidentAckTopic(DEVICE_ID));
        assert.equal(options.qos, 1);
        assert.deepEqual(message, {
            schema_version: 2,
            incident_id: early.vector.evidence.incident_id,
            evidence_hash: early.vector.expected.evidence_hash,
            accepted: true,
            error_code: '',
            received_at: String(Number(early.payload.observed_at) + 5),
        });
    } finally {
        await store.close();
    }
});

test('both vectors in order are accepted; the danger vector projects a danger notification', async () => {
    const { early, exceeded, store, fastify } = await setup();
    try {
        assert.equal((await deliver(fastify, early)).accepted, true);
        assert.equal((await deliver(fastify, exceeded)).accepted, true);
        assert.equal(await countRows(store, 'incidents'), 2);
        assert.equal(await countRows(store, 'blockchain_outbox'), 2);
        const { rows } = await store.db.query(
            `SELECT severity, title, body FROM notification_events ORDER BY source_event_id`
        );
        assert.deepEqual(rows[1], {
            severity: 'danger',
            title: 'Gas threshold exceeded',
            body: 'CO exceeded the QCVN 03:2019/BYT limit.',
        });
    } finally {
        await store.close();
    }
});

test('sequence boundaries: zero is rejected; one and UINT64_MAX are accepted', async () => {
    const { early, store, fastify } = await setup();
    try {
        const zero = signIncident({ ...early, overrides: { sequence: '0' } });
        const rejected = await deliver(fastify, { ...early, payload: zero });
        assert.equal(rejected.accepted, false);
        assert.equal(rejected.errorCode, INCIDENT_ERROR.INVALID_SEMANTICS);
        assert.equal(await countRows(store, 'incidents'), 0);

        for (const sequence of ['1', '18446744073709551615']) {
            const payload = signIncident({ ...early, overrides: { sequence } });
            assert.equal((await deliver(fastify, { ...early, payload })).accepted, true);
        }
        assert.equal(await countRows(store, 'incidents'), 2);
    } finally {
        await store.close();
    }
});

test('duplicate delivery with the same hash is ACKed again without a new row (idempotent)', async () => {
    const { early, exceeded, store, fastify } = await setup();
    try {
        await deliver(fastify, early);
        await deliver(fastify, exceeded);

        // Retry of #43 hours later (after reboot): dedupe runs before the time window.
        const retry = await deliver(fastify, early, { now: nowAt(early.payload.observed_at, 6 * 3600) });
        assert.equal(retry.accepted, true);
        assert.equal(retry.duplicate, true);
        assert.equal(retry.ack.received_at, String(Number(early.payload.observed_at) + 5), 'ACK keeps the original received_at');

        assert.equal(await countRows(store, 'incidents'), 2);
        assert.equal(await countRows(store, 'blockchain_outbox'), 2);
        assert.equal(await countRows(store, 'realtime_events'), 2);
        assert.deepEqual(await securityEventTypes(store), []);
    } finally {
        await store.close();
    }
});

test('same incident_id with a different evidence_hash is a security event, never overwritten or accepted', async () => {
    const { early, store, fastify } = await setup();
    try {
        await deliver(fastify, early);
        const conflicting = signIncident({ ...early, overrides: { co_ppm_x1000: 52001 } });
        assert.equal(conflicting.incident_id, early.payload.incident_id);
        assert.notEqual(conflicting.evidence_hash, early.payload.evidence_hash);

        const result = await deliver(fastify, { ...early, payload: conflicting });
        assert.equal(result.accepted, false);
        assert.equal(result.errorCode, INCIDENT_ERROR.INCIDENT_HASH_CONFLICT);
        assert.equal(result.ack.evidence_hash, conflicting.evidence_hash);

        const { rows } = await store.db.query('SELECT evidence_hash, co_ppm_x1000 FROM incidents');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].evidence_hash, early.payload.evidence_hash);
        assert.equal(Number(rows[0].co_ppm_x1000), 52000);
        assert.deepEqual(await securityEventTypes(store), ['INCIDENT_HASH_CONFLICT']);
    } finally {
        await store.close();
    }
});

test('tampered payload is rejected with HASH_MISMATCH, logged as a security event and not stored', async () => {
    const { early, store, fastify } = await setup();
    try {
        const tampered = { ...early.payload, co_ppm_x1000: 1 };
        const result = await deliver(fastify, { ...early, payload: tampered });
        assert.equal(result.accepted, false);
        assert.equal(result.errorCode, INCIDENT_ERROR.HASH_MISMATCH);
        assert.equal(fastify.published[0].message.accepted, false);
        assert.equal(fastify.published[0].message.error_code, INCIDENT_ERROR.HASH_MISMATCH);
        assert.equal(await countRows(store, 'incidents'), 0);
        assert.equal(await countRows(store, 'blockchain_outbox'), 0);

        const { rows } = await store.db.query('SELECT type, incident_id, raw_payload FROM security_events');
        assert.equal(rows[0].type, 'HASH_MISMATCH');
        assert.equal(rows[0].incident_id, early.payload.incident_id);
        assert.deepEqual(Buffer.from(rows[0].raw_payload), rawBytes(tampered));
    } finally {
        await store.close();
    }
});

test('delayed first delivery is accepted; zero and too-far-future timestamps are rejected', async () => {
    const { early, store, fastify } = await setup();
    try {
        assert.equal((await deliver(fastify, early, { now: nowAt(early.payload.observed_at, 86_400) })).accepted, true);

        const future = signIncident({ ...early, overrides: { sequence: '45', observed_at: '1790395301' } });
        const futureResult = await deliver(fastify, { ...early, payload: future }, {
            now: () => new Date(1790394700 * 1000),
        });
        assert.equal(futureResult.errorCode, INCIDENT_ERROR.OBSERVED_AT_OUT_OF_WINDOW);

        const zero = signIncident({ ...early, overrides: { sequence: '46', observed_at: '0' } });
        assert.equal((await deliver(fastify, { ...early, payload: zero })).errorCode,
            INCIDENT_ERROR.OBSERVED_AT_OUT_OF_WINDOW);
        assert.equal(await countRows(store, 'incidents'), 1);
        assert.deepEqual(await securityEventTypes(store), []);
    } finally {
        await store.close();
    }
});

test('unseen incidents may arrive out of sequence; same-sequence conflicting evidence is rejected', async () => {
    const { early, exceeded, store, fastify } = await setup();
    try {
        const seq4 = signIncident({ ...exceeded, overrides: { sequence: '4', observed_at: '1790394700' } });
        const seq3 = signIncident({ ...early, overrides: { sequence: '3', observed_at: '1790394600' } });
        assert.equal((await deliver(fastify, { ...exceeded, payload: seq4 }, { now: nowAt(seq4.observed_at) })).accepted, true);
        assert.equal((await deliver(fastify, { ...early, payload: seq3 }, { now: nowAt(seq4.observed_at) })).accepted, true);

        const seq3Conflict = signIncident({ ...exceeded, overrides: { sequence: '3', observed_at: '1790394690' } });
        const conflict = await deliver(fastify, { ...exceeded, payload: seq3Conflict }, { now: nowAt(seq4.observed_at) });
        // incident_id is derived from device_id_hash + sequence, so a same-sequence
        // conflict necessarily reaches the existing-ID/different-hash guard.
        assert.equal(conflict.errorCode, INCIDENT_ERROR.INCIDENT_HASH_CONFLICT);
        assert.equal(await countRows(store, 'incidents'), 2);
        assert.deepEqual(await securityEventTypes(store), ['INCIDENT_HASH_CONFLICT']);
    } finally {
        await store.close();
    }
});

test('signer must be the registered active signer; revoked and rotated-away keys are rejected', async () => {
    const { early, exceeded, store, fastify } = await setup({ withSigner: false });
    try {
        const noSigner = await deliver(fastify, early);
        assert.equal(noSigner.errorCode, INCIDENT_ERROR.SIGNER_NOT_ACTIVE);

        const pool = { connect: async () => poolClient(store) };
        await registerSigner(pool, DEVICE_ID, early.vector.expected.signer);
        assert.equal((await deliver(fastify, early)).accepted, true);

        await revokeSigner(store.db, DEVICE_ID, 'explicit_operator_revoke');
        const revoked = await deliver(fastify, exceeded);
        assert.equal(revoked.errorCode, INCIDENT_ERROR.SIGNER_NOT_ACTIVE);

        await registerSigner(pool, DEVICE_ID, `0x${'ab'.repeat(20)}`);
        await assert.rejects(registerSigner(pool, DEVICE_ID, `0x${'cd'.repeat(20)}`), /already has an active signer/);
        await registerSigner(pool, DEVICE_ID, `0x${'cd'.repeat(20)}`, { rotate: true });
        const rotated = await deliver(fastify, exceeded);
        assert.equal(rotated.errorCode, INCIDENT_ERROR.SIGNER_NOT_ACTIVE);

        // A revoked key can never be registered again.
        await assert.rejects(registerSigner(pool, DEVICE_ID, early.vector.expected.signer, { rotate: true }));

        assert.deepEqual(await securityEventTypes(store), ['SIGNER_NOT_ACTIVE', 'SIGNER_NOT_ACTIVE', 'SIGNER_NOT_ACTIVE']);
        const { rows } = await store.db.query(
            `SELECT status, revoke_reason FROM device_signers WHERE device_id = $1 ORDER BY id`,
            [DEVICE_ID]
        );
        assert.deepEqual(rows.map((r) => r.status), ['revoked', 'revoked', 'active']);
        assert.deepEqual(rows.map((r) => r.revoke_reason), ['explicit_operator_revoke', 'rotated', null]);
    } finally {
        await store.close();
    }
});

// registerSigner() uses pool.connect(); emulate a pg client on top of PGlite.
function poolClient(store) {
    return {
        query: (sql, params) => store.db.query(sql, params),
        release() {},
    };
}

test('topic/device mismatch, unknown device and oversized payload are rejected', async () => {
    const { early, store, fastify } = await setup();
    try {
        const mismatch = await deliver(fastify, early, { deviceId: OTHER_DEVICE_ID });
        assert.equal(mismatch.errorCode, INCIDENT_ERROR.DEVICE_MISMATCH);
        assert.equal(fastify.published[0].topic, incidentAckTopic(OTHER_DEVICE_ID));

        const unknownPayload = signIncident({ ...early, overrides: { device_id: '99:99:99:99:99:99' } });
        const unknown = await deliver(fastify, { ...early, payload: unknownPayload }, { deviceId: '99:99:99:99:99:99' });
        assert.equal(unknown.errorCode, INCIDENT_ERROR.UNKNOWN_DEVICE);

        const oversized = await deliver(fastify, early, { raw: Buffer.alloc(4097, 0x20) });
        assert.equal(oversized.errorCode, INCIDENT_ERROR.INVALID_PAYLOAD);

        assert.equal(await countRows(store, 'incidents'), 0);
        assert.deepEqual(await securityEventTypes(store), ['DEVICE_MISMATCH']);
    } finally {
        await store.close();
    }
});

test('payload without a well-formed incident_id/evidence_hash is dropped without ACK', async () => {
    const { early, store, fastify } = await setup();
    try {
        const result = await deliver(fastify, { ...early, payload: { ...early.payload, incident_id: 'nope' } });
        assert.equal(result.errorCode, INCIDENT_ERROR.INVALID_PAYLOAD);
        assert.equal(result.ack, null);
        assert.equal(fastify.published.length, 0);
    } finally {
        await store.close();
    }
});

test('DB failure throws before any ACK so the MQTT packet stays unacked', async () => {
    const { early, store } = await setup();
    try {
        const fastify = createIntakeFastify(store);
        fastify.withTransaction = async () => {
            throw new Error('connection terminated');
        };
        await assert.rejects(deliver(fastify, early), /connection terminated/);
        assert.equal(fastify.published.length, 0);
        assert.equal(await countRows(store, 'incidents'), 0);
    } finally {
        await store.close();
    }
});

test('insert failure rolls back incident, outbox and realtime event together', async () => {
    const { early, store } = await setup();
    try {
        const fastify = createIntakeFastify(store);
        fastify.withTransaction = (fn) => store.withTransaction(async (client) => fn({
            async query(sql, params) {
                if (sql.includes('INSERT INTO realtime_events')) throw new Error('realtime insert failed');
                return client.query(sql, params);
            },
        }));
        await assert.rejects(deliver(fastify, early), /realtime insert failed/);
        assert.equal(await countRows(store, 'incidents'), 0);
        assert.equal(await countRows(store, 'blockchain_outbox'), 0);
        assert.equal(fastify.published.length, 0);
    } finally {
        await store.close();
    }
});

test('handleIncident never publishes itself; a lost ACK is recovered by the device retry', async () => {
    const { early, store } = await setup();
    try {
        const failing = createIntakeFastify(store, { publishError: new Error('MQTT bridge is not ready') });
        const result = await handleIncident(failing, DEVICE_ID, early.payload, rawBytes(early.payload), {
            domain: early.domain,
            incidentConfig: INCIDENT_CONFIG,
            now: nowAt(early.payload.observed_at),
        });
        assert.equal(result.accepted, true, 'no publish happens inside the handler');
        assert.equal(await countRows(store, 'incidents'), 1, 'commit happened before the ACK attempt');
        await assert.rejects(publishIncidentAck(failing, DEVICE_ID, result.ack), /not ready/);

        const healthy = createIntakeFastify(store);
        const redelivered = await deliver(healthy, early);
        assert.equal(redelivered.accepted, true);
        assert.equal(redelivered.duplicate, true);
        assert.equal(await countRows(store, 'incidents'), 1);
        assert.equal(await countRows(store, 'blockchain_outbox'), 1);
    } finally {
        await store.close();
    }
});

test('concurrent deliveries of the same incident store exactly one row', async () => {
    const { early, store, fastify } = await setup();
    try {
        const results = await Promise.all([deliver(fastify, early), deliver(fastify, early), deliver(fastify, early)]);
        assert.ok(results.every((r) => r.accepted));
        assert.equal(await countRows(store, 'incidents'), 1);
        assert.equal(await countRows(store, 'blockchain_outbox'), 1);
        assert.equal(fastify.published.length, 3);
    } finally {
        await store.close();
    }
});

test('evidence survives device deletion (no cascade) and outbox enforces one row per sequence', async () => {
    const { early, store, fastify } = await setup();
    try {
        await deliver(fastify, early);
        await store.db.query('DELETE FROM realtime_events WHERE device_id = $1', [DEVICE_ID]);
        await store.db.query('DELETE FROM notification_events WHERE device_id = $1', [DEVICE_ID]);
        await store.db.query('DELETE FROM devices WHERE id = $1', [DEVICE_ID]);
        assert.equal(await countRows(store, 'incidents'), 1);

        await assert.rejects(store.db.query(
            `INSERT INTO blockchain_outbox (incident_row_id, device_id, incident_id, sequence)
             SELECT id, device_id, incident_id, sequence FROM incidents`
        ));
        await assert.rejects(store.db.query(`UPDATE blockchain_outbox SET status = 'sent'`));
    } finally {
        await store.close();
    }
});

test('tampered retry of a stored incident (same id and claimed hash) is rejected, not re-ACKed', async () => {
    const { early, store, fastify } = await setup();
    try {
        await deliver(fastify, early);
        const tampered = { ...early.payload, co_ppm_x1000: 1 };
        const result = await deliver(fastify, { ...early, payload: tampered });
        assert.equal(result.accepted, false);
        assert.equal(result.errorCode, INCIDENT_ERROR.HASH_MISMATCH);
        assert.deepEqual(await securityEventTypes(store), ['HASH_MISMATCH']);
        const { rows } = await store.db.query('SELECT co_ppm_x1000 FROM incidents');
        assert.equal(Number(rows[0].co_ppm_x1000), 52000);
    } finally {
        await store.close();
    }
});

test('retry with different JSON encoding of the same signed evidence is still a duplicate', async () => {
    const { early, store, fastify } = await setup();
    try {
        await deliver(fastify, early);
        const reordered = Object.fromEntries(Object.entries(early.payload).reverse());
        const raw = Buffer.from(JSON.stringify(reordered, null, 2));
        const result = await deliver(fastify, { ...early, payload: reordered }, { raw });
        assert.equal(result.accepted, true);
        assert.equal(result.duplicate, true);
        assert.equal(await countRows(store, 'incidents'), 1);
    } finally {
        await store.close();
    }
});

test('same evidence re-signed by another key is not accepted as a duplicate', async () => {
    const { early, store, fastify } = await setup();
    try {
        await deliver(fastify, early);
        const other = signIncident({ ...early, signingKey: new SigningKey(`0x${'22'.repeat(32)}`) });
        assert.equal(other.evidence_hash, early.payload.evidence_hash);
        const result = await deliver(fastify, { ...early, payload: other });
        assert.equal(result.errorCode, INCIDENT_ERROR.SIGNER_NOT_ACTIVE);
    } finally {
        await store.close();
    }
});

test('missing device_id is INVALID_PAYLOAD, not a security event', async () => {
    const { early, store, fastify } = await setup();
    try {
        const payload = { ...early.payload };
        delete payload.device_id;
        const result = await deliver(fastify, { ...early, payload });
        assert.equal(result.errorCode, INCIDENT_ERROR.INVALID_PAYLOAD);
        assert.deepEqual(await securityEventTypes(store), []);
    } finally {
        await store.close();
    }
});
