// Shared fixtures for incident tests: the two Schema v2 vectors, a re-signer using the
// public Hardhat test key from those vectors, and an in-process Postgres (PGlite)
// loaded with the real 017 migration.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

import { normalizeIncidentDomain } from '../../src/services/incident-verify.js';
import { signIncident, testSigningKey } from './incident-signing.js';

export { signIncident, testSigningKey };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VECTOR_DIR = path.resolve(__dirname, '../../../../docs/test-vectors');
const MIGRATION_017 = path.resolve(__dirname, '../../../db/migrations/017_blockchain_incidents.sql');
const MIGRATION_018 = path.resolve(__dirname, '../../../db/migrations/018_task1_task3_wire_compat.sql');
const MIGRATION_019 = path.resolve(__dirname, '../../../db/migrations/019_outbox_domain_and_signer_gate.sql');
const MIGRATION_020 = path.resolve(__dirname, '../../../db/migrations/020_incentives.sql');

export const VECTOR_FILES = Object.freeze({
    earlyWarning: 'incident-v2-model-early-warning.json',
    exceeded: 'incident-v2-qcvn-exceeded.json',
});

export const DEVICE_ID = 'aa:bb:cc:dd:ee:ff';
export const OTHER_DEVICE_ID = '11:22:33:44:55:66';
export const USER_ID = '00000000-0000-4000-8000-000000000001';
export const OUTSIDER_ID = '00000000-0000-4000-8000-000000000002';
export const HOME_ID = '00000000-0000-4000-8000-0000000000aa';

export async function loadVector(name) {
    const vector = JSON.parse(await readFile(path.join(VECTOR_DIR, VECTOR_FILES[name]), 'utf8'));
    const d = vector.domain;
    const domain = normalizeIncidentDomain({
        name: d.name,
        version: d.version,
        chainId: d.chain_id,
        verifyingContract: d.verifying_contract,
    });
    return { vector, domain, payload: vectorPayload(vector) };
}

// MQTT transport payload: every evidence field + transport extras (schema section 6).
export function vectorPayload(vector) {
    return {
        ...vector.evidence,
        device_id: vector.transport.device_id,
        firmware_version: vector.transport.firmware_version,
        evidence_hash: vector.expected.evidence_hash,
        signature: vector.expected.signature,
    };
}

export function rawBytes(payload) {
    return Buffer.from(JSON.stringify(payload), 'utf8');
}

// Minimal slice of the existing schema that 017 and the incident code depend on.
const BASE_SCHEMA = `
CREATE TABLE users (
    id UUID PRIMARY KEY,
    is_active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE homes (
    id UUID PRIMARY KEY
);
CREATE TABLE home_members (
    home_id UUID REFERENCES homes(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'owner',
    PRIMARY KEY (home_id, user_id)
);
CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    home_id UUID REFERENCES homes(id),
    name VARCHAR NOT NULL,
    online BOOLEAN DEFAULT FALSE
);
CREATE TABLE commands (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    payload JSONB NOT NULL,
    status VARCHAR DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    executed_at TIMESTAMPTZ
);
CREATE TABLE realtime_events (
    id BIGSERIAL PRIMARY KEY,
    type TEXT NOT NULL,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    idempotency_key TEXT
);
CREATE UNIQUE INDEX realtime_events_idempotency_key_idx
    ON realtime_events (idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE notification_events (
    source_event_id BIGINT PRIMARY KEY REFERENCES realtime_events(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    device_name_snapshot VARCHAR NOT NULL,
    title VARCHAR NOT NULL,
    body VARCHAR NOT NULL,
    severity TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

function queryAdapter(target) {
    return {
        async query(sql, params = []) {
            const result = await target.query(sql, params);
            return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length };
        },
    };
}

export async function createIncidentDb({ signerAddress = null } = {}) {
    const pg = new PGlite();
    await pg.exec(BASE_SCHEMA);
    await pg.exec(await readFile(MIGRATION_017, 'utf8'));
    await pg.exec(await readFile(MIGRATION_018, 'utf8'));
    await pg.exec(await readFile(MIGRATION_019, 'utf8'));
    await pg.exec(await readFile(MIGRATION_020, 'utf8'));

    await pg.query('INSERT INTO users (id) VALUES ($1), ($2)', [USER_ID, OUTSIDER_ID]);
    await pg.query('INSERT INTO homes (id) VALUES ($1)', [HOME_ID]);
    await pg.query('INSERT INTO home_members (home_id, user_id) VALUES ($1, $2)', [HOME_ID, USER_ID]);
    await pg.query('INSERT INTO devices (id, home_id, name) VALUES ($1, $2, $3)', [DEVICE_ID, HOME_ID, 'Kitchen']);
    await pg.query('INSERT INTO devices (id, home_id, name) VALUES ($1, $2, $3)', [OTHER_DEVICE_ID, HOME_ID, 'Garage']);
    if (signerAddress) {
        await pg.query(
            `INSERT INTO device_signers (device_id, signer_address) VALUES ($1, $2)`,
            [DEVICE_ID, signerAddress.toLowerCase()]
        );
    }

    const db = queryAdapter(pg);
    return {
        pg,
        db,
        // Same { query, withTransaction } shape as the worker's pool adapter.
        query: (sql, params) => db.query(sql, params),
        async withTransaction(fn) {
            return pg.transaction(async (tx) => fn(queryAdapter(tx)));
        },
        async close() {
            await pg.close();
        },
    };
}

// fastify-shaped object for handleIncident(); records ACK publishes.
export function createIntakeFastify(store, { publishError = null } = {}) {
    const published = [];
    const warnings = [];
    return {
        published,
        warnings,
        db: store.db,
        withTransaction: store.withTransaction,
        log: {
            info() {},
            error() {},
            warn(obj, msg) {
                warnings.push({ obj, msg });
            },
        },
        async mqttPublish(topic, message, options) {
            if (publishError) throw publishError;
            published.push({ topic, message: JSON.parse(message), options });
        },
    };
}

export async function countRows(store, table, deviceId = DEVICE_ID) {
    const { rows } = await store.db.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE device_id = $1`, [deviceId]);
    return rows[0].n;
}
