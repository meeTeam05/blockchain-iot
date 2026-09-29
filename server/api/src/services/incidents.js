// Read side of the incident store: list/detail formatting and on-demand re-verification.
import { getSignerRecord } from './device-signers.js';
import {
    EVIDENCE_FIELDS,
    computeAttestationDigest,
    computeDeviceIdHash,
    computeEvidenceHash,
    computeFirmwareVersionHash,
    computeIncidentId,
    normalizeIncidentDomain,
    parseIncidentPayload,
    recoverIncidentSigner,
} from './incident-verify.js';

const LEVEL_NAMES = Object.freeze({ 0: 'SAFE', 1: 'EARLY_WARNING', 2: 'EXCEEDED' });
const SEVERITY_NAMES = Object.freeze({ 1: 'warning', 2: 'danger', 3: 'critical' });
const INCIDENT_KIND_NAMES = Object.freeze({ 1: 'EARLY_WARNING_ENTERED', 2: 'THRESHOLD_EXCEEDED_ENTERED' });
const TIME_SOURCE_NAMES = Object.freeze({ 1: 'sntp', 2: 'rtc' });

const INCIDENT_SELECT = `
    SELECT i.*,
           o.status AS chain_status,
           o.attempts AS chain_attempts,
           o.tx_hash AS chain_tx_hash,
           o.block_number AS chain_block_number,
           o.confirmations AS chain_confirmations,
           o.confirmed_at AS chain_confirmed_at,
           o.last_error AS chain_last_error,
           o.fail_reason AS chain_fail_reason,
           o.verifying_contract AS chain_verifying_contract,
           o.updated_at AS chain_updated_at,
           d.owner_address AS owner_address
    FROM incidents i
    LEFT JOIN blockchain_outbox o ON o.incident_row_id = i.id
    LEFT JOIN devices d ON d.id = i.device_id`;

function hasBit(mask, bit) {
    return (Number(mask) & (1 << bit)) !== 0;
}

function scaled(value, valid, divisor) {
    return valid ? Number(value) / divisor : null;
}

function sources(mask) {
    return {
        rule: hasBit(mask, 0),
        projection: hasBit(mask, 1),
        model: hasBit(mask, 2),
    };
}

function isoOrNull(value) {
    return value ? new Date(value).toISOString() : null;
}

// Evidence exactly as signed: uint64 as decimal strings, bytes32 as hex, the rest as integers.
export function evidenceFromRow(row) {
    const evidence = {};
    for (const [, type, key] of EVIDENCE_FIELDS) {
        if (type === 'uint64') evidence[key] = String(row[key]);
        else if (type === 'bytes32') evidence[key] = row[key];
        else evidence[key] = Number(row[key]);
    }
    return evidence;
}

function chainFromRow(row) {
    return {
        status: row.chain_status ?? null,
        attempts: row.chain_attempts ?? 0,
        tx_hash: row.chain_tx_hash ?? null,
        block_number: row.chain_block_number != null ? String(row.chain_block_number) : null,
        confirmations: row.chain_confirmations ?? null,
        confirmed_at: isoOrNull(row.chain_confirmed_at),
        last_error: row.chain_last_error ?? null,
        // Why a row is not (yet) on chain: legacy_domain / waiting_signer / stale_signer / failed.
        fail_reason: row.chain_fail_reason ?? null,
        verifying_contract: row.chain_verifying_contract ?? null,
        updated_at: isoOrNull(row.chain_updated_at),
    };
}

export function formatIncidentSummary(row) {
    return {
        device_id: row.device_id,
        incident_id: row.incident_id,
        sequence: String(row.sequence),
        observed_at: String(row.observed_at),
        received_at: isoOrNull(row.received_at),
        severity: SEVERITY_NAMES[row.severity] ?? null,
        overall_level: LEVEL_NAMES[row.overall_level] ?? null,
        co_level: LEVEL_NAMES[row.co_level] ?? null,
        no2_level: LEVEL_NAMES[row.no2_level] ?? null,
        verify_status: row.verify_status,
        owner_status: row.owner_status,
        chain_status: row.chain_status ?? null,
        tx_hash: row.chain_tx_hash ?? null,
    };
}

// Values whose valid bit is clear are reported as null; raw integers stay in `evidence`.
export function formatIncidentDetail(row) {
    const sensorMask = Number(row.sensor_valid_mask);
    const derivedMask = Number(row.derived_valid_mask);
    const modelMask = Number(row.model_probability_valid_mask);

    return {
        ...formatIncidentSummary(row),
        observed_at_iso: isoOrNull(row.observed_at_ts),
        incident_kind: INCIDENT_KIND_NAMES[row.incident_kind] ?? null,
        time_source: TIME_SOURCE_NAMES[row.time_source] ?? null,
        sensors: {
            temperature_c: scaled(row.temperature_c_x100, hasBit(sensorMask, 0), 100),
            humidity_pct: scaled(row.humidity_pct_x100, hasBit(sensorMask, 1), 100),
            co_ppm: scaled(row.co_ppm_x1000, hasBit(sensorMask, 2), 1000),
            no2_ppm: scaled(row.no2_ppm_x1000, hasBit(sensorMask, 3), 1000),
        },
        derived: {
            co_stel15_ppm: scaled(row.co_stel15_ppm_x1000, hasBit(derivedMask, 0), 1000),
            no2_stel15_ppm: scaled(row.no2_stel15_ppm_x1000, hasBit(derivedMask, 1), 1000),
            co_twa8h_ppm: scaled(row.co_twa8h_ppm_x1000, hasBit(derivedMask, 2), 1000),
            no2_twa8h_ppm: scaled(row.no2_twa8h_ppm_x1000, hasBit(derivedMask, 3), 1000),
            co_proj10_ppm: scaled(row.co_proj10_ppm_x1000, hasBit(derivedMask, 4), 1000),
            no2_proj10_ppm: scaled(row.no2_proj10_ppm_x1000, hasBit(derivedMask, 5), 1000),
        },
        model: {
            co_probability: scaled(row.co_model_probability_bps, hasBit(modelMask, 0), 10_000),
            no2_probability: scaled(row.no2_model_probability_bps, hasBit(modelMask, 1), 10_000),
        },
        alarm_sources: {
            co: sources(row.co_alarm_source_mask),
            no2: sources(row.no2_alarm_source_mask),
        },
        firmware: {
            version: row.firmware_version,
            version_hash: row.firmware_version_hash,
            model_sha256: row.model_sha256,
        },
        calibration: {
            revision: Number(row.calibration_revision),
            hash: row.calibration_hash,
            canonical: row.calibration_canonical,
            independently_recomputable: false,
        },
        evidence_hash: row.evidence_hash,
        eip712_digest: row.eip712_digest,
        signature: row.signature,
        signer_address: row.signer_address,
        owner_address: row.owner_address ?? null,
        owner: {
            acknowledged_at: isoOrNull(row.acknowledged_at),
            acknowledged_by: row.acknowledged_by ?? null,
            acknowledged_tx_hash: row.acknowledged_tx_hash ?? null,
            resolved_at: isoOrNull(row.resolved_at),
            resolved_by: row.resolved_by ?? null,
            resolved_tx_hash: row.resolved_tx_hash ?? null,
        },
        chain: chainFromRow(row),
        evidence: evidenceFromRow(row),
    };
}

export async function listIncidents(fastify, deviceId, { beforeSequence = null, limit = 50 } = {}) {
    const { rows } = await fastify.db.query(
        `${INCIDENT_SELECT}
         WHERE i.device_id = $1
           AND ($2::numeric IS NULL OR i.sequence < $2::numeric)
         ORDER BY i.sequence DESC
         LIMIT $3`,
        [deviceId, beforeSequence, limit]
    );
    return rows.map(formatIncidentSummary);
}

export async function getIncidentRow(fastify, deviceId, incidentId) {
    const { rows } = await fastify.db.query(
        `${INCIDENT_SELECT}
         WHERE i.device_id = $1 AND i.incident_id = $2`,
        [deviceId, incidentId]
    );
    return rows[0] ?? null;
}

function hashCheck(stored, computed) {
    return { stored, computed, match: stored === computed };
}

// Recomputes identity/firmware/evidence/EIP-712 hashes and the signature from
// stored raw bytes, using the intake domain, then cross-checks DB columns.
// calibration_hash has no canonical preimage on the Task 1 wire and is checked
// as signed evidence rather than independently recomputed.
export async function verifyStoredIncident(fastify, row) {
    const domain = normalizeIncidentDomain({
        name: row.domain_name,
        version: row.domain_version,
        chainId: String(row.domain_chain_id),
        verifyingContract: row.domain_verifying_contract,
    });

    let payload = null;
    try {
        payload = JSON.parse(Buffer.from(row.raw_payload).toString('utf8'));
    } catch {
        payload = null;
    }
    const parsed = parseIncidentPayload(payload);
    if (!parsed.ok) {
        return {
            device_id: row.device_id,
            incident_id: row.incident_id,
            valid: false,
            db: { stored: true, received_at: isoOrNull(row.received_at), verify_status: row.verify_status, raw_payload_parsed: false },
            error: parsed.reason,
            chain: chainFromRow(row),
        };
    }

    const { evidence, transport } = parsed;
    const storedEvidence = evidenceFromRow(row);
    const mismatchedColumns = EVIDENCE_FIELDS
        .map(([, , key]) => key)
        .filter((key) => storedEvidence[key] !== evidence[key]);
    if (transport.deviceId !== row.device_id) mismatchedColumns.push('device_id');
    if (transport.signature !== row.signature) mismatchedColumns.push('signature');

    const deviceIdHash = computeDeviceIdHash(transport.deviceId);
    const evidenceHash = computeEvidenceHash(evidence);
    const hashes = {
        device_id_hash: hashCheck(evidence.device_id_hash, deviceIdHash),
        incident_id: hashCheck(evidence.incident_id, computeIncidentId(deviceIdHash, evidence.sequence)),
        firmware_version_hash: hashCheck(evidence.firmware_version_hash, computeFirmwareVersionHash(transport.firmwareVersion)),
        calibration_hash: {
            stored: row.calibration_hash,
            computed: null,
            match: row.calibration_hash === evidence.calibration_hash,
            independently_recomputable: false,
        },
        evidence_hash: hashCheck(row.evidence_hash, evidenceHash),
    };
    const digest = computeAttestationDigest(domain, {
        deviceIdHash,
        incidentId: evidence.incident_id,
        sequence: evidence.sequence,
        observedAt: evidence.observed_at,
        severity: evidence.severity,
        evidenceHash,
    });
    hashes.eip712_digest = hashCheck(row.eip712_digest, digest);

    const recovered = recoverIncidentSigner(digest, transport.signature);
    const recoveredSigner = recovered.ok ? recovered.signer.toLowerCase() : null;
    const signerRecord = recoveredSigner ? await getSignerRecord(fastify, row.device_id, recoveredSigner) : null;
    const signature = {
        valid: recovered.ok && recoveredSigner === row.signer_address,
        recovered_signer: recoveredSigner,
        stored_signer: row.signer_address,
        registered: signerRecord !== null,
        signer_status: signerRecord?.status ?? null,
        error: recovered.ok ? null : recovered.reason,
    };

    const hashesMatch = Object.values(hashes).every((check) => check.match);
    return {
        device_id: row.device_id,
        incident_id: row.incident_id,
        valid: hashesMatch && signature.valid && signature.registered && mismatchedColumns.length === 0,
        db: {
            stored: true,
            received_at: isoOrNull(row.received_at),
            verify_status: row.verify_status,
            raw_payload_parsed: true,
            columns_match_raw_payload: mismatchedColumns.length === 0,
            mismatched_columns: mismatchedColumns,
        },
        hashes,
        signature,
        domain: {
            name: domain.name,
            version: domain.version,
            chain_id: domain.chainId,
            verifying_contract: domain.verifyingContract,
        },
        chain: chainFromRow(row),
    };
}
