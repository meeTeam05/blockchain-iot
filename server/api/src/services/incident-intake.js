// MQTT intake for device/{id}/incident (docs/tasks/Blockchain_task.md, Task 3).
// Order: dedupe -> domain-independent verify (format, semantics, hashes, signature format)
// -> authenticate by (domain, signer) against the device's signer history -> time policy/
// sequence uniqueness -> one DB transaction (incident + outbox + realtime) -> MQTT packet
// ack -> ACK publish. Any thrown error leaves the QoS1 packet unacked so EMQX redelivers it.
//
// ACK accepted:true means "valid evidence, committed". Whether it can go on-chain is
// decided here and recorded as outbox.status (queued / waiting_signer / stale_signer /
// legacy_domain), so firmware never keeps a record in its queue for chain reasons.
//
// handleIncident() only builds the ACK; the MQTT plugin publishes it after acking the
// inbound packet. mqtt.js processes inbound packets one at a time, so awaiting a QoS1
// PUBACK from inside the message handler would deadlock until the publish timeout.
import { config } from '../config.js';
import { advisoryLockId } from '../utils/advisory-lock.js';
import { createRealtimeEvent } from './realtime-events.js';
import { AbiCoder, keccak256 } from 'ethers';

import { getSignerHistory } from './device-signers.js';
import { domainsFromSingle, resolveIncidentDomains } from './incident-domains.js';
import {
    EVIDENCE_FIELDS,
    INCIDENT_ERROR,
    SECURITY_ERROR_CODES,
    authenticateIncident,
    buildIncidentAck,
    checkIncidentOrdering,
    isBytes32,
    normalizeIncidentDomain,
    recoverForDomain,
    verifyIncidentEvidence,
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

// AirSafetyLog.computeIncidentKey(deviceIdHash, incidentId).
export function computeIncidentKey(deviceIdHash, incidentId) {
    return keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32'], [deviceIdHash, incidentId]));
}

function toUnixSeconds(date) {
    return Math.floor(date.getTime() / 1000);
}

// Called after the inbound packet is acked. If it fails the device retries the same
// incident and the dedupe branch answers with the same ACK.
export async function publishIncidentAck(fastify, deviceId, ack) {
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
        `SELECT evidence_hash, signer_address, raw_payload, received_at,
                domain_name, domain_version, domain_chain_id, domain_verifying_contract
         FROM incidents
         WHERE device_id = $1 AND incident_id = $2`,
        [deviceId, incidentId]
    );
    return rows[0] ?? null;
}

// Decides how to answer a delivery whose incident_id is already stored. The claimed
// evidence_hash alone is not trusted: firmware retries the exact persisted bytes, and any
// other encoding must verify to the stored evidence and signer before it is re-ACKed.
// A retry is only checked against the domain and signer stored on the row; the domain
// loop is never re-run, so a legacy_domain incident stays exactly what it was.
function classifyExisting(existing, { identity, payload, rawBuffer }) {
    if (existing.evidence_hash !== identity.evidenceHash) {
        return {
            kind: 'reject',
            errorCode: INCIDENT_ERROR.INCIDENT_HASH_CONFLICT,
            reason: 'incident_id already stored with a different evidence_hash',
            extra: { stored_evidence_hash: existing.evidence_hash },
        };
    }
    if (Buffer.from(existing.raw_payload).equals(rawBuffer)) {
        return { kind: 'duplicate', existing };
    }

    const check = verifyIncidentEvidence(payload);
    if (!check.ok) {
        return {
            kind: 'reject',
            errorCode: check.errorCode,
            reason: `retry of a stored incident does not verify: ${check.reason}`,
            extra: check.field ? { field: check.field } : {},
        };
    }
    const storedDomain = normalizeIncidentDomain({
        name: existing.domain_name,
        version: existing.domain_version,
        chainId: String(existing.domain_chain_id),
        verifyingContract: existing.domain_verifying_contract,
    });
    const recovered = recoverForDomain(check, storedDomain);
    if (!recovered.ok || recovered.signer !== existing.signer_address) {
        return {
            kind: 'reject',
            errorCode: recovered.ok ? INCIDENT_ERROR.SIGNER_NOT_ACTIVE : recovered.errorCode,
            reason: 'retry of a stored incident does not verify to the stored domain and signer',
            extra: { domain: existing.domain_verifying_contract },
        };
    }
    return { kind: 'duplicate', existing };
}

function incidentRealtimePayload(row, chainStatus) {
    return {
        incident_id: row.incident_id,
        sequence: String(row.sequence),
        severity: SEVERITY_NAMES[row.severity] ?? null,
        overall_level: row.overall_level,
        co_level: row.co_level,
        no2_level: row.no2_level,
        observed_at: String(row.observed_at),
        chain_status: chainStatus,
    };
}

async function insertIncident(client, { deviceId, verified, auth, rawPayload, payload, receivedAt }) {
    const { evidence, transport, computed } = verified;
    const { domain, digest, signer } = auth;
    const evidenceKeys = EVIDENCE_FIELDS.map(([, , key]) => key);
    const columns = [
        'device_id',
        ...evidenceKeys,
        'firmware_version',
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
        computed.evidenceHash,
        digest,
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

// Returns { accepted, errorCode, ack, duplicate }. `ack` is null when the payload has no
// well-formed incident_id/evidence_hash to address it; otherwise the caller publishes it.
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
        return { accepted: false, errorCode, ack };
    };

    const acceptDuplicate = async (existing) => {
        const ack = buildIncidentAck({
            ...identity,
            accepted: true,
            receivedAtSec: toUnixSeconds(new Date(existing.received_at)),
        });
        fastify.log.info({ deviceId, incidentId: identity.incidentId }, 'duplicate incident re-acknowledged');
        return { accepted: true, errorCode: null, ack, duplicate: true };
    };

    if (!isPlainObject(payload)) {
        return reject(INCIDENT_ERROR.INVALID_PAYLOAD, 'payload must be a plain JSON object');
    }
    if (rawBuffer.length > incidentConfig.maxPayloadBytes) {
        return reject(INCIDENT_ERROR.INVALID_PAYLOAD, 'payload exceeds incident size limit');
    }
    if (typeof payload.device_id !== 'string') {
        return reject(INCIDENT_ERROR.INVALID_PAYLOAD, 'device_id is required');
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

    // options.domain (single domain, tests/tools) or options.domains ({ current, legacy }).
    const domains = options.domains
        ?? (options.domain ? domainsFromSingle(options.domain) : resolveIncidentDomains(incidentConfig));
    const dedupeContext = { identity, payload, rawBuffer };

    // Dedupe runs before time checks so a retry after reboot still gets its ACK.
    if (identity) {
        const existing = await findExisting(fastify.db, deviceId, identity.incidentId);
        if (existing) {
            const outcome = classifyExisting(existing, dedupeContext);
            if (outcome.kind === 'duplicate') return acceptDuplicate(existing);
            return reject(outcome.errorCode, outcome.reason, outcome.extra);
        }
    }

    const verified = verifyIncidentEvidence(payload);
    if (!verified.ok) {
        return reject(verified.errorCode, verified.reason, verified.field ? { field: verified.field } : {});
    }

    const outcome = await fastify.withTransaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [advisoryLockId(`incident:${deviceId}`)]);

        // Re-check under the per-device lock: a concurrent delivery may have committed first.
        const existing = await findExisting(client, deviceId, identity.incidentId);
        if (existing) return classifyExisting(existing, dedupeContext);

        const signerHistory = await getSignerHistory(client, deviceId);
        const auth = authenticateIncident(verified, { domains, signerHistory });
        if (!auth.ok) {
            return { kind: 'reject', errorCode: auth.errorCode, reason: auth.reason, extra: auth.security ?? {} };
        }

        const ordering = checkIncidentOrdering({
            observedAt: verified.evidence.observed_at,
            receivedAtSec,
            clockSkewSeconds: incidentConfig.clockSkewSeconds,
        });
        if (!ordering.ok) {
            return { kind: 'reject', errorCode: ordering.errorCode, reason: ordering.reason };
        }

        const row = await insertIncident(client, { deviceId, verified, auth, rawPayload: rawBuffer, payload, receivedAt });
        await client.query(
            `INSERT INTO blockchain_outbox
                 (incident_row_id, device_id, incident_id, sequence, status,
                  verifying_contract, signer_address, incident_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                row.id,
                deviceId,
                row.incident_id,
                row.sequence,
                auth.outboxStatus,
                auth.domain.verifyingContract.toLowerCase(),
                auth.signer,
                computeIncidentKey(verified.computed.deviceIdHash, verified.computed.incidentId),
            ]
        );
        await createRealtimeEvent(client, {
            type: INCIDENT_CREATED_EVENT,
            deviceId,
            occurredAt: row.received_at,
            payload: incidentRealtimePayload(row, auth.outboxStatus),
            idempotencyKey: `${INCIDENT_CREATED_EVENT}:${deviceId}:${row.incident_id}`,
        });
        return { kind: 'stored', row, auth };
    });

    if (outcome.kind === 'duplicate') return acceptDuplicate(outcome.existing);
    if (outcome.kind === 'reject') return reject(outcome.errorCode, outcome.reason, outcome.extra);

    // ACK is only built after COMMIT.
    const ack = buildIncidentAck({ ...identity, accepted: true, receivedAtSec });
    fastify.log.info(
        {
            deviceId,
            incidentId: identity.incidentId,
            sequence: verified.evidence.sequence,
            chainStatus: outcome.auth.outboxStatus,
            domain: outcome.auth.domainKind,
        },
        'incident stored'
    );
    return { accepted: true, errorCode: null, ack, duplicate: false };
}
