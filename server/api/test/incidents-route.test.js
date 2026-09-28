import test from 'node:test';
import assert from 'node:assert/strict';

import Fastify from 'fastify';

import incidentsRoutes from '../src/routes/incidents.js';
import { handleIncident } from '../src/services/incident-intake.js';
import {
    DEVICE_ID,
    OTHER_DEVICE_ID,
    OUTSIDER_ID,
    USER_ID,
    createIncidentDb,
    createIntakeFastify,
    loadVector,
    rawBytes,
} from './helpers/incident-fixtures.js';

const INCIDENT_CONFIG = Object.freeze({ maxPayloadBytes: 4096, clockSkewSeconds: 600 });

async function setup() {
    const early = await loadVector('earlyWarning');
    const exceeded = await loadVector('exceeded');
    const store = await createIncidentDb({ signerAddress: early.vector.expected.signer });
    const intake = createIntakeFastify(store);
    for (const { domain, payload } of [early, exceeded]) {
        const result = await handleIncident(intake, DEVICE_ID, payload, rawBytes(payload), {
            domain,
            incidentConfig: INCIDENT_CONFIG,
            now: () => new Date((Number(payload.observed_at) + 5) * 1000),
        });
        assert.equal(result.accepted, true);
    }

    const app = Fastify({ logger: false });
    app.decorate('db', store.db);
    app.decorate('authenticate', async (request) => {
        request.user = { sub: request.headers['x-test-user'] ?? USER_ID };
    });
    await app.register(incidentsRoutes, { prefix: '/api' });
    await app.ready();
    return { app, store, early, exceeded };
}

async function withSetup(run) {
    const ctx = await setup();
    try {
        await run(ctx);
    } finally {
        await ctx.app.close();
        await ctx.store.close();
    }
}

test('GET /devices/:id/incidents lists newest first with chain status and paginates by sequence', async () => {
    await withSetup(async ({ app, early, exceeded }) => {
        const res = await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incidents` });
        assert.equal(res.statusCode, 200);
        const body = res.json();
        assert.deepEqual(body.map((i) => i.sequence), ['44', '43']);
        assert.equal(body[0].incident_id, exceeded.payload.incident_id);
        assert.equal(body[0].severity, 'danger');
        assert.equal(body[0].overall_level, 'EXCEEDED');
        assert.equal(body[0].chain_status, 'queued');
        assert.equal(body[1].severity, 'warning');

        const page = await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incidents?before_sequence=44&limit=1` });
        assert.deepEqual(page.json().map((i) => i.incident_id), [early.payload.incident_id]);

        const bad = await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incidents?before_sequence=044` });
        assert.equal(bad.statusCode, 400);

        const empty = await app.inject({ method: 'GET', url: `/api/devices/${OTHER_DEVICE_ID}/incidents` });
        assert.deepEqual(empty.json(), []);
    });
});

test('GET detail reports values only when valid and keeps raw evidence', async () => {
    await withSetup(async ({ app, early, exceeded }) => {
        const earlyRes = await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incidents/${early.payload.incident_id}` });
        assert.equal(earlyRes.statusCode, 200);
        const detail = earlyRes.json();
        assert.equal(detail.incident_kind, 'EARLY_WARNING_ENTERED');
        assert.equal(detail.time_source, 'sntp');
        assert.deepEqual(detail.sensors, { temperature_c: 30.47, humidity_pct: 74.45, co_ppm: 52, no2_ppm: 0.323 });
        assert.deepEqual(detail.model, { co_probability: 0.9102, no2_probability: 0.0039 });
        assert.deepEqual(detail.alarm_sources.co, { rule: false, projection: false, model: true });
        assert.equal(detail.firmware.version, '0.1.1-gas-ews');
        assert.equal(detail.calibration.revision, 3);
        assert.equal(detail.calibration.canonical, null);
        assert.equal(detail.calibration.independently_recomputable, false);
        assert.equal(detail.evidence_hash, early.vector.expected.evidence_hash);
        assert.equal(detail.chain.status, 'queued');
        assert.equal(detail.owner_status, 'open');
        assert.deepEqual(detail.evidence, early.vector.evidence);

        // Model output unavailable: probabilities are null, not 0.
        const exceededRes = await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incidents/${exceeded.payload.incident_id}` });
        const exceededDetail = exceededRes.json();
        assert.deepEqual(exceededDetail.model, { co_probability: null, no2_probability: null });
        assert.deepEqual(exceededDetail.alarm_sources.co, { rule: true, projection: false, model: false });
        assert.equal(exceededDetail.evidence.co_model_probability_bps, 0);
    });
});

test('GET verify recomputes hashes and signature from the stored raw payload', async () => {
    await withSetup(async ({ app, early }) => {
        const res = await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incidents/${early.payload.incident_id}/verify` });
        assert.equal(res.statusCode, 200);
        const body = res.json();
        assert.equal(body.valid, true);
        assert.equal(body.db.stored, true);
        assert.equal(body.db.columns_match_raw_payload, true);
        for (const [name, check] of Object.entries(body.hashes)) {
            assert.equal(check.match, true, name);
        }
        assert.equal(body.hashes.evidence_hash.computed, early.vector.expected.evidence_hash);
        assert.equal(body.hashes.eip712_digest.computed, early.vector.expected.eip712_digest);
        assert.equal(body.hashes.calibration_hash.computed, null);
        assert.equal(body.hashes.calibration_hash.independently_recomputable, false);
        assert.deepEqual(body.signature, {
            valid: true,
            recovered_signer: early.vector.expected.signer.toLowerCase(),
            stored_signer: early.vector.expected.signer.toLowerCase(),
            registered: true,
            signer_status: 'active',
            error: null,
        });
        assert.equal(body.domain.chain_id, '11155111');
        assert.equal(body.chain.status, 'queued');
    });
});

test('GET verify flags DB-side tampering of parsed columns or stored hashes', async () => {
    await withSetup(async ({ app, store, early }) => {
        await store.db.query('UPDATE incidents SET co_ppm_x1000 = 1 WHERE incident_id = $1', [early.payload.incident_id]);
        const columns = (await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incidents/${early.payload.incident_id}/verify` })).json();
        assert.equal(columns.valid, false);
        assert.deepEqual(columns.db.mismatched_columns, ['co_ppm_x1000']);

        await store.db.query(
            'UPDATE incidents SET co_ppm_x1000 = 52000, evidence_hash = $2 WHERE incident_id = $1',
            [early.payload.incident_id, `0x${'0'.repeat(64)}`]
        );
        const hash = (await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incidents/${early.payload.incident_id}/verify` })).json();
        assert.equal(hash.valid, false);
        assert.equal(hash.hashes.evidence_hash.match, false);

        await store.db.query('UPDATE incidents SET evidence_hash = $2 WHERE incident_id = $1', [
            early.payload.incident_id,
            early.vector.expected.evidence_hash,
        ]);
        await store.db.query(`UPDATE device_signers SET status = 'revoked', revoked_at = NOW()`);
        const revoked = (await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incidents/${early.payload.incident_id}/verify` })).json();
        assert.equal(revoked.valid, true, 'an incident signed before revocation stays valid');
        assert.equal(revoked.signature.signer_status, 'revoked');
    });
});

test('incident routes enforce device access and validate ids', async () => {
    await withSetup(async ({ app, early }) => {
        const id = early.payload.incident_id;
        for (const url of [
            `/api/devices/${DEVICE_ID}/incidents`,
            `/api/devices/${DEVICE_ID}/incidents/${id}`,
            `/api/devices/${DEVICE_ID}/incidents/${id}/verify`,
        ]) {
            const res = await app.inject({ method: 'GET', url, headers: { 'x-test-user': OUTSIDER_ID } });
            assert.equal(res.statusCode, 403, url);
        }

        assert.equal((await app.inject({ method: 'GET', url: '/api/devices/not-a-mac/incidents' })).statusCode, 400);
        assert.equal((await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incidents/0x1234` })).statusCode, 400);
        assert.equal((await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incidents/0x${'0'.repeat(64)}` })).statusCode, 404);
        // Upper-case ids are normalized.
        assert.equal((await app.inject({ method: 'GET', url: `/api/devices/${DEVICE_ID}/incidents/0x${id.slice(2).toUpperCase()}` })).statusCode, 200);
        // Another device of the same home cannot read this incident through its own path.
        assert.equal((await app.inject({ method: 'GET', url: `/api/devices/${OTHER_DEVICE_ID}/incidents/${id}` })).statusCode, 404);
    });
});
