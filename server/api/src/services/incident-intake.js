// MQTT intake for device/{id}/incident (Blockchain_task.md, Task 3).
// Order: dedupe -> stateless verify -> signer registry -> time/sequence policy ->
// one DB transaction (incident + outbox + realtime) -> ACK publish -> MQTT packet ack.
// Any thrown error leaves the QoS1 packet unacked so EMQX redelivers it.
import { config } from '../config.js';
import { advisoryLockId } from '../utils/advisory-lock.js';
import { createRealtimeEvent } from './realtime-events.js';
import { getActiveSigner } from './device-signers.js';
import {
    EVIDENCE_FIELDS,
    INCIDENT_ERROR,
    SECURITY_ERROR_CODES,
    buildIncidentAck,
    checkIncidentOrdering,
    domainFromConfig,
    isBytes32,
    verifyIncidentPayload,
} from './incident-verify.js';

export const INCIDENT_CREATED_EVENT = 'incident.created';

const SEVERITY_NAMES = Object.freeze({ 1: 'warning', 2: 'danger' });

export function incidentAckTopic(deviceId) {
    return `device/${deviceId}/incident/ack`;
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ACK can only be addressed when the payload carries a well-formed id/hash pair.
function ackIdentity(payload) {
    if (!isPlainObject(payload)) return null;
    const { incident_id: incidentId, evidence_hash: evidenceHash } = payload;
    return isBytes32(incidentId) && isBytes32(evidenceHash) ? { incidentId, evidenceHash } : null;
}

function toUnixSeconds(date) {
    return Math.floor(date.getTime() / 1000);
}

async function publishAck(fastify, deviceId, ack) {
    await fastify.mqttPublish(incidentAckTopic(deviceId), JSON.stringify(ack), { qos: 1 });
}

async function recordSecurityEvent(db, { deviceId, type, identity, details, rawPayload }) {
    await db.query(
        `INSERT INTO security_events (device_id, type, incident_id, evidence_hash, details, raw_payload)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [
            deviceId,
            type,
            identity?.incidentId ?? null,
            identity?.evidenceHash ?? null,
            JSON.stringify(details ?? {}),
            rawPayload ?? null,
        ]
    );
}

async function findExisting(db, deviceId, incidentId) {
    const { rows } = await db.query(
        `SELECT evidence_hash, received_at
         FROM incidents
         WHERE device_id = $1 AND incident_id = $2`,
        [deviceId, incidentId]
    );
    return rows[0] ?? null;
}

function incidentRealtimePayload(row) {
    return {
        incident_id: row.incident_id,
        sequence: String(row.sequence),
        severity: SEVERITY_NAMES[row.severity] ?? null,
        overall_level: row.overall_level,
        co_level: row.co_level,
        no2_level: row.no2_level,
        observed_at: String(row.observed_at),
        chain_status: 'queued',
    };
}

async function insertIncident(client, { deviceId, verified, domain, rawPayload, payload, receivedAt }) {
    const { evidence, transport, computed, signer } = verified;
    const evidenceKeys = EVIDENCE_FIELDS.map(([, , key]) => key);
    const columns = [
        'device_id',
        ...evidenceKeys,
        'firmware_version',
        'calibration_canonical',
        'evidence_hash',
        'eip712_digest',
        'signature',
        'signer_address',
        'domain_name',
        'domain_version',
        'domain_chain_id',
        'domain_verifying_contract',
        'raw_payload',
        'payload',
        'observed_at_ts',
        'received_at',
    ];
    const values = [
        deviceId,
        ...evidenceKeys.map((key) => evidence[key]),
        transport.firmwareVersion,
        transport.calibrationCanonical,
        computed.evidenceHash,
        computed.digest,
        transport.signature,
        signer,
        domain.name,
        domain.version,
        domain.chainId,
        domain.verifyingContract.toLowerCase(),
        rawPayload,
        JSON.stringify(payload),
        new Date(Number(evidence.observed_at) * 1000),
        receivedAt,
    ];
    const placeholders = values.map((_, index) => `$${index + 1}`);
    placeholders[columns.indexOf('payload')] += '::jsonb';

    const { rows } = await client.query(
        `INSERT INTO incidents (${columns.join(', ')})
         VALUES (${placeholders.join(', ')})
         RETURNING id, incident_id, sequence, observed_at, severity, overall_level, co_level, no2_level, received_at`,
        values
    );
    return rows[0];
}

// Returns { accepted, errorCode, ack } for tests/logging; publishes the ACK itself.
export async function handleIncident(fastify, deviceId, payload, rawPayload, options = {}) {
    const incidentConfig = options.incidentConfig ?? config.incident;
    const receivedAt = options.now ? options.now() : new Date();
    const receivedAtSec = toUnixSeconds(receivedAt);
    const rawBuffer = Buffer.isBuffer(rawPayload) ? rawPayload : Buffer.from(JSON.stringify(payload ?? null));
    const identity = ackIdentity(payload);

    const reject = async (errorCode, reason, extra = {}) => {
        fastify.log.warn({ deviceId, errorCode, reason, incidentId: identity?.incidentId }, 'incident rejected');
        if (SECURITY_ERROR_CODES.has(errorCode)) {
            await recordSecurityEvent(fastify.db, {
                deviceId,
                type: errorCode,
                identity,
                details: { reason, ...extra },
                rawPayload: rawBuffer,
            });
        }
        if (!identity) {
            return { accepted: false, errorCode, ack: null };
        }
        const ack = buildIncidentAck({ ...identity, accepted: false, errorCode, receivedAtSec });
        await publishAck(fastify, deviceId, ack);
        return { accepted: false, errorCode, ack };
    };

    const acceptDuplicate = async (existing) => {
        const ack = buildIncidentAck({
            ...identity,
            accepted: true,
            receivedAtSec: toUnixSeconds(new Date(existing.received_at)),
        });
        fastify.log.info({ deviceId, incidentId: identity.incidentId }, 'duplicate incident re-acknowledged');
        await publishAck(fastify, deviceId, ack);
        return { accepted: true, errorCode: null, ack, duplicate: true };
    };

    if (!isPlainObject(payload)) {
        return reject(INCIDENT_ERROR.INVALID_PAYLOAD, 'payload must be a plain JSON object');
    }
    if (rawBuffer.length > incidentConfig.maxPayloadBytes) {
        return reject(INCIDENT_ERROR.INVALID_PAYLOAD, 'payload exceeds incident size limit');
    }
    if (payload.device_id !== deviceId) {
        return reject(INCIDENT_ERROR.DEVICE_MISMATCH, 'device_id does not match topic', {
            payload_device_id: typeof payload.device_id === 'string' ? payload.device_id : null,
        });
    }

    const device = await fastify.db.query('SELECT 1 FROM devices WHERE id = $1', [deviceId]);
    if (device.rows.length === 0) {
        return reject(INCIDENT_ERROR.UNKNOWN_DEVICE, 'device is not registered');
    }

    // Dedupe runs before time checks so a retry after reboot still gets its ACK.
    if (identity) {
        const existing = await findExisting(fastify.db, deviceId, identity.incidentId);
        if (existing) {
            if (existing.evidence_hash === identity.evidenceHash) return acceptDuplicate(existing);
            return reject(INCIDENT_ERROR.INCIDENT_HASH_CONFLICT, 'incident_id already stored with a different evidence_hash', {
                stored_evidence_hash: existing.evidence_hash,
            });
        }
    }

    const domain = options.domain ?? domainFromConfig(incidentConfig);
    const verified = verifyIncidentPayload(payload, domain);
    if (!verified.ok) {
        return reject(verified.errorCode, verified.reason, verified.field ? { field: verified.field } : {});
    }

    const outcome = await fastify.withTransaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [advisoryLockId(`incident:${deviceId}`)]);

        // Re-check under the per-device lock: a concurrent delivery may have committed first.
        const existing = await findExisting(client, deviceId, identity.incidentId);
        if (existing) {
            return existing.evidence_hash === identity.evidenceHash
                ? { kind: 'duplicate', existing }
                : { kind: 'reject', errorCode: INCIDENT_ERROR.INCIDENT_HASH_CONFLICT, reason: 'incident_id already stored with a different evidence_hash' };
        }

        const activeSigner = await getActiveSigner(client, deviceId);
        if (activeSigner !== verified.signer) {
            return {
                kind: 'reject',
                errorCode: INCIDENT_ERROR.SIGNER_NOT_ACTIVE,
                reason: activeSigner ? 'signature is not from the active device signer' : 'device has no active signer',
                extra: { recovered_signer: verified.signer },
            };
        }

        const { rows } = await client.query(
            `SELECT MAX(sequence)::text AS last_sequence, MAX(observed_at)::text AS last_observed_at
             FROM incidents
             WHERE device_id = $1`,
            [deviceId]
        );
        const ordering = checkIncidentOrdering({
            sequence: verified.evidence.sequence,
            observedAt: verified.evidence.observed_at,
            receivedAtSec,
            lastSequence: rows[0]?.last_sequence ?? null,
            lastObservedAt: rows[0]?.last_observed_at ?? null,
            clockSkewSeconds: incidentConfig.clockSkewSeconds,
            maxRegressionSeconds: incidentConfig.maxRegressionSeconds,
        });
        if (!ordering.ok) {
            return { kind: 'reject', errorCode: ordering.errorCode, reason: ordering.reason };
        }

        const row = await insertIncident(client, { deviceId, verified, domain, rawPayload: rawBuffer, payload, receivedAt });
        await client.query(
            `INSERT INTO blockchain_outbox (incident_row_id, device_id, incident_id, sequence, status)
             VALUES ($1, $2, $3, $4, 'queued')`,
            [row.id, deviceId, row.incident_id, row.sequence]
        );
        await createRealtimeEvent(client, {
            type: INCIDENT_CREATED_EVENT,
            deviceId,
            occurredAt: row.received_at,
            payload: incidentRealtimePayload(row),
            idempotencyKey: `${INCIDENT_CREATED_EVENT}:${deviceId}:${row.incident_id}`,
        });
        return { kind: 'stored', row };
    });

    if (outcome.kind === 'duplicate') return acceptDuplicate(outcome.existing);
    if (outcome.kind === 'reject') return reject(outcome.errorCode, outcome.reason, outcome.extra);

    // ACK only after COMMIT; a publish failure throws so the packet is redelivered
    // and the retry is answered by the dedupe branch above.
    const ack = buildIncidentAck({ ...identity, accepted: true, receivedAtSec });
    fastify.log.info(
        { deviceId, incidentId: identity.incidentId, sequence: verified.evidence.sequence },
        'incident stored and queued for chain'
    );
    await publishAck(fastify, deviceId, ack);
    return { accepted: true, errorCode: null, ack, duplicate: false };
}
