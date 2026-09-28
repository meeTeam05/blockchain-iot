// Incident Schema v2 verification (docs/BLOCKCHAIN_INCIDENT_SCHEMA.md).
// Pure functions only: no DB, no MQTT. Every hash is recomputed from the
// transport payload; nothing the device claims is trusted as-is.
import { createHash } from 'node:crypto';
import {
    AbiCoder,
    TypedDataEncoder,
    getAddress,
    isAddress,
    keccak256,
    recoverAddress,
    solidityPackedKeccak256,
    toUtf8Bytes,
} from 'ethers';

export const INCIDENT_SCHEMA_VERSION = 2;
export const INCIDENT_ID_PREFIX = 'AIR-INCIDENT-2';

export const INCIDENT_ERROR = Object.freeze({
    INVALID_PAYLOAD: 'INVALID_PAYLOAD',
    DEVICE_MISMATCH: 'DEVICE_MISMATCH',
    UNKNOWN_DEVICE: 'UNKNOWN_DEVICE',
    INVALID_SEMANTICS: 'INVALID_SEMANTICS',
    HASH_MISMATCH: 'HASH_MISMATCH',
    INVALID_SIGNATURE: 'INVALID_SIGNATURE',
    SIGNER_NOT_ACTIVE: 'SIGNER_NOT_ACTIVE',
    OBSERVED_AT_OUT_OF_WINDOW: 'OBSERVED_AT_OUT_OF_WINDOW',
    OBSERVED_AT_REGRESSED: 'OBSERVED_AT_REGRESSED',
    SEQUENCE_NOT_INCREASING: 'SEQUENCE_NOT_INCREASING',
    INCIDENT_HASH_CONFLICT: 'INCIDENT_HASH_CONFLICT',
});

// Rejections that indicate tampering or a key problem are also written to security_events.
export const SECURITY_ERROR_CODES = new Set([
    INCIDENT_ERROR.DEVICE_MISMATCH,
    INCIDENT_ERROR.HASH_MISMATCH,
    INCIDENT_ERROR.INVALID_SIGNATURE,
    INCIDENT_ERROR.SIGNER_NOT_ACTIVE,
    INCIDENT_ERROR.INCIDENT_HASH_CONFLICT,
]);

// [solidity name, ABI type, transport key] in exact IncidentEvidence order.
export const EVIDENCE_FIELDS = Object.freeze([
    ['schemaVersion', 'uint16', 'schema_version'],
    ['deviceIdHash', 'bytes32', 'device_id_hash'],
    ['incidentId', 'bytes32', 'incident_id'],
    ['sequence', 'uint64', 'sequence'],
    ['observedAt', 'uint64', 'observed_at'],
    ['timeSource', 'uint8', 'time_source'],
    ['sensorValidMask', 'uint8', 'sensor_valid_mask'],
    ['detectionMethod', 'uint8', 'detection_method'],
    ['temperatureCx100', 'int32', 'temperature_c_x100'],
    ['humidityPctX100', 'uint16', 'humidity_pct_x100'],
    ['coPpmX1000', 'uint32', 'co_ppm_x1000'],
    ['no2PpmX1000', 'uint32', 'no2_ppm_x1000'],
    ['overallLevel', 'uint8', 'overall_level'],
    ['coLevel', 'uint8', 'co_level'],
    ['no2Level', 'uint8', 'no2_level'],
    ['coAlarmSourceMask', 'uint8', 'co_alarm_source_mask'],
    ['no2AlarmSourceMask', 'uint8', 'no2_alarm_source_mask'],
    ['derivedValidMask', 'uint8', 'derived_valid_mask'],
    ['coStel15PpmX1000', 'uint32', 'co_stel15_ppm_x1000'],
    ['no2Stel15PpmX1000', 'uint32', 'no2_stel15_ppm_x1000'],
    ['coTwa8hPpmX1000', 'uint32', 'co_twa8h_ppm_x1000'],
    ['no2Twa8hPpmX1000', 'uint32', 'no2_twa8h_ppm_x1000'],
    ['coProj10PpmX1000', 'uint32', 'co_proj10_ppm_x1000'],
    ['no2Proj10PpmX1000', 'uint32', 'no2_proj10_ppm_x1000'],
    ['modelProbabilityValidMask', 'uint8', 'model_probability_valid_mask'],
    ['coModelProbabilityBps', 'uint16', 'co_model_probability_bps'],
    ['no2ModelProbabilityBps', 'uint16', 'no2_model_probability_bps'],
    ['incidentKind', 'uint8', 'incident_kind'],
    ['severity', 'uint8', 'severity'],
    ['firmwareVersionHash', 'bytes32', 'firmware_version_hash'],
    ['modelSha256', 'bytes32', 'model_sha256'],
    ['calibrationRevision', 'uint32', 'calibration_revision'],
    ['calibrationHash', 'bytes32', 'calibration_hash'],
]);

export const EVIDENCE_TYPE_STRING = `IncidentEvidence(${EVIDENCE_FIELDS.map(([name, type]) => `${type} ${name}`).join(',')})`;
export const EVIDENCE_TYPEHASH = keccak256(toUtf8Bytes(EVIDENCE_TYPE_STRING));

export const ATTESTATION_TYPES = Object.freeze({
    IncidentAttestation: [
        { name: 'deviceIdHash', type: 'bytes32' },
        { name: 'incidentId', type: 'bytes32' },
        { name: 'sequence', type: 'uint64' },
        { name: 'observedAt', type: 'uint64' },
        { name: 'severity', type: 'uint8' },
        { name: 'evidenceHash', type: 'bytes32' },
    ],
});

export const TRANSPORT_EXTRA_KEYS = Object.freeze([
    'device_id',
    'firmware_version',
    'calibration_canonical',
    'evidence_hash',
    'signature',
]);

const ALLOWED_KEYS = new Set([...EVIDENCE_FIELDS.map(([, , key]) => key), ...TRANSPORT_EXTRA_KEYS]);

const UINT_MAX = { uint8: 0xff, uint16: 0xffff, uint32: 0xffff_ffff };
const INT32_MIN = -0x8000_0000;
const INT32_MAX = 0x7fff_ffff;
const UINT64_MAX = (1n << 64n) - 1n;
const SECP256K1_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const SECP256K1_HALF_N = SECP256K1_N >> 1n;

const BYTES32_RE = /^0x[0-9a-f]{64}$/;
const UINT64_DEC_RE = /^(0|[1-9][0-9]{0,19})$/;
const SIGNATURE_RE = /^0x[0-9a-fA-F]{130}$/;
const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/;
const MAX_FIRMWARE_VERSION_LENGTH = 64;
const MAX_CALIBRATION_CANONICAL_LENGTH = 256;
const CALIBRATION_PREFIX = 'AIR-CAL-1|';
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]+$/;
const BPS_MAX = 10_000;
const HUMIDITY_MAX = 10_000;

// Gas index 0 = CO, 1 = NO2. Bit positions come from schema section 2.
const GASES = Object.freeze([
    {
        name: 'co',
        levelKey: 'co_level',
        sourceMaskKey: 'co_alarm_source_mask',
        sensorBit: 2,
        stelBit: 0,
        twaBit: 2,
        projBit: 4,
        modelBit: 0,
    },
    {
        name: 'no2',
        levelKey: 'no2_level',
        sourceMaskKey: 'no2_alarm_source_mask',
        sensorBit: 3,
        stelBit: 1,
        twaBit: 3,
        projBit: 5,
        modelBit: 1,
    },
]);

// A cleared valid bit means the value must be encoded as 0.
const SENSOR_VALUE_BITS = Object.freeze([
    ['temperature_c_x100', 0],
    ['humidity_pct_x100', 1],
    ['co_ppm_x1000', 2],
    ['no2_ppm_x1000', 3],
]);
const DERIVED_VALUE_BITS = Object.freeze([
    ['co_stel15_ppm_x1000', 0],
    ['no2_stel15_ppm_x1000', 1],
    ['co_twa8h_ppm_x1000', 2],
    ['no2_twa8h_ppm_x1000', 3],
    ['co_proj10_ppm_x1000', 4],
    ['no2_proj10_ppm_x1000', 5],
]);
const MODEL_VALUE_BITS = Object.freeze([
    ['co_model_probability_bps', 0],
    ['no2_model_probability_bps', 1],
]);

// Canonical level -> incidentKind/severity mapping (EARLY_WARNING -> warning, EXCEEDED -> danger).
const LEVEL_KIND_SEVERITY = Object.freeze({
    1: { incidentKind: 1, severity: 1 },
    2: { incidentKind: 2, severity: 2 },
});

function fail(errorCode, reason, extra = {}) {
    return { ok: false, errorCode, reason, ...extra };
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasBit(mask, bit) {
    return (mask & (1 << bit)) !== 0;
}

export function isBytes32(value) {
    return typeof value === 'string' && BYTES32_RE.test(value);
}

export function isUint64String(value) {
    return typeof value === 'string' && UINT64_DEC_RE.test(value) && BigInt(value) <= UINT64_MAX;
}

function checkField(type, key, value) {
    if (type === 'bytes32') {
        return isBytes32(value) ? null : `${key} must be lowercase 0x-prefixed bytes32 hex`;
    }
    if (type === 'uint64') {
        return isUint64String(value) ? null : `${key} must be a uint64 decimal string without leading zeros`;
    }
    if (!Number.isInteger(value)) return `${key} must be an integer`;
    if (type === 'int32') {
        return value >= INT32_MIN && value <= INT32_MAX ? null : `${key} is out of int32 range`;
    }
    return value >= 0 && value <= UINT_MAX[type] ? null : `${key} is out of ${type} range`;
}

export function parseCalibrationRevision(canonical) {
    if (typeof canonical !== 'string' || !canonical.startsWith(CALIBRATION_PREFIX)) return null;
    const revisions = canonical
        .split('|')
        .slice(1)
        .filter((segment) => segment.startsWith('revision='))
        .map((segment) => segment.slice('revision='.length));
    if (revisions.length !== 1 || !/^(0|[1-9][0-9]{0,9})$/.test(revisions[0])) return null;
    const revision = Number(revisions[0]);
    return revision <= UINT_MAX.uint32 ? revision : null;
}

// Step 1: shape/format. Returns the payload split into evidence + transport fields.
export function parseIncidentPayload(payload) {
    if (!isPlainObject(payload)) {
        return fail(INCIDENT_ERROR.INVALID_PAYLOAD, 'payload must be a plain JSON object');
    }
    for (const key of Object.keys(payload)) {
        if (!ALLOWED_KEYS.has(key)) {
            return fail(INCIDENT_ERROR.INVALID_PAYLOAD, `unknown field ${key}`);
        }
    }

    const evidence = {};
    for (const [, type, key] of EVIDENCE_FIELDS) {
        if (!Object.hasOwn(payload, key)) {
            return fail(INCIDENT_ERROR.INVALID_PAYLOAD, `missing field ${key}`);
        }
        const reason = checkField(type, key, payload[key]);
        if (reason) return fail(INCIDENT_ERROR.INVALID_PAYLOAD, reason);
        evidence[key] = payload[key];
    }

    const { device_id: deviceId, firmware_version: firmwareVersion } = payload;
    const { calibration_canonical: calibrationCanonical, evidence_hash: evidenceHash, signature } = payload;
    if (typeof deviceId !== 'string' || !MAC_RE.test(deviceId)) {
        return fail(INCIDENT_ERROR.INVALID_PAYLOAD, 'device_id must be a lowercase MAC address');
    }
    if (typeof firmwareVersion !== 'string'
        || firmwareVersion.length > MAX_FIRMWARE_VERSION_LENGTH
        || !PRINTABLE_ASCII_RE.test(firmwareVersion)) {
        return fail(INCIDENT_ERROR.INVALID_PAYLOAD, 'firmware_version must be printable ASCII (1..64 chars)');
    }
    if (typeof calibrationCanonical !== 'string'
        || calibrationCanonical.length > MAX_CALIBRATION_CANONICAL_LENGTH
        || !PRINTABLE_ASCII_RE.test(calibrationCanonical)) {
        return fail(INCIDENT_ERROR.INVALID_PAYLOAD, 'calibration_canonical must be printable ASCII (1..256 chars)');
    }
    if (!isBytes32(evidenceHash)) {
        return fail(INCIDENT_ERROR.INVALID_PAYLOAD, 'evidence_hash must be lowercase 0x-prefixed bytes32 hex');
    }
    if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) {
        return fail(INCIDENT_ERROR.INVALID_PAYLOAD, 'signature must be 65-byte 0x-prefixed hex');
    }

    return {
        ok: true,
        evidence,
        transport: {
            deviceId,
            firmwareVersion,
            calibrationCanonical,
            evidenceHash,
            signature: signature.toLowerCase(),
        },
    };
}

// Step 2: enum/mask/level rules from schema sections 2-3.
export function validateIncidentSemantics(evidence) {
    const e = evidence;
    if (e.schema_version !== INCIDENT_SCHEMA_VERSION) return 'schema_version must be 2';
    if (e.time_source !== 1 && e.time_source !== 2) return 'time_source must be 1 (SNTP) or 2 (RTC)';
    if (e.detection_method !== 2) return 'detection_method must be 2 (GAS_EWS_HYBRID)';
    if (e.overall_level !== 1 && e.overall_level !== 2) return 'overall_level must be 1 or 2';

    const mapping = LEVEL_KIND_SEVERITY[e.overall_level];
    if (e.incident_kind !== mapping.incidentKind) return 'incident_kind does not match overall_level';
    if (e.severity !== mapping.severity) return 'severity does not match overall_level';

    if (e.sensor_valid_mask > 0x0f) return 'sensor_valid_mask has undefined bits';
    if (e.derived_valid_mask > 0x3f) return 'derived_valid_mask has undefined bits';
    if (e.model_probability_valid_mask > 0x03) return 'model_probability_valid_mask has undefined bits';
    if (e.humidity_pct_x100 > HUMIDITY_MAX) return 'humidity_pct_x100 must be <= 10000';
    if (e.co_model_probability_bps > BPS_MAX) return 'co_model_probability_bps must be <= 10000';
    if (e.no2_model_probability_bps > BPS_MAX) return 'no2_model_probability_bps must be <= 10000';

    for (const [key, bit] of SENSOR_VALUE_BITS) {
        if (!hasBit(e.sensor_valid_mask, bit) && e[key] !== 0) return `${key} must be 0 when its sensor valid bit is clear`;
    }
    for (const [key, bit] of DERIVED_VALUE_BITS) {
        if (!hasBit(e.derived_valid_mask, bit) && e[key] !== 0) return `${key} must be 0 when its derived valid bit is clear`;
    }
    for (const [key, bit] of MODEL_VALUE_BITS) {
        if (!hasBit(e.model_probability_valid_mask, bit) && e[key] !== 0) {
            return `${key} must be 0 when its model valid bit is clear`;
        }
    }

    let maxGasLevel = 0;
    for (const gas of GASES) {
        const level = e[gas.levelKey];
        const sourceMask = e[gas.sourceMaskKey];
        if (level > 2) return `${gas.levelKey} must be 0, 1 or 2`;
        if (sourceMask > 0x07) return `${gas.sourceMaskKey} has undefined bits`;
        maxGasLevel = Math.max(maxGasLevel, level);

        if (level === 0) {
            if (sourceMask !== 0) return `${gas.sourceMaskKey} must be 0 when ${gas.levelKey} is SAFE`;
            continue;
        }
        if (!hasBit(e.sensor_valid_mask, gas.sensorBit)) return `${gas.name} is alarming without a valid sensor reading`;
        if (sourceMask === 0) return `${gas.sourceMaskKey} must name at least one alarm source`;
        if (hasBit(sourceMask, 0)
            && !hasBit(e.derived_valid_mask, gas.stelBit)
            && !hasBit(e.derived_valid_mask, gas.twaBit)) {
            return `${gas.name} QCVN rule source requires a valid STEL or TWA value`;
        }
        if (hasBit(sourceMask, 1) && !hasBit(e.derived_valid_mask, gas.projBit)) {
            return `${gas.name} projection source requires a valid projection value`;
        }
        if (hasBit(sourceMask, 2) && !hasBit(e.model_probability_valid_mask, gas.modelBit)) {
            return `${gas.name} model source requires a valid model probability`;
        }
    }
    if (maxGasLevel !== e.overall_level) return 'overall_level must equal the highest gas level';

    return null;
}

export function computeDeviceIdHash(deviceId) {
    return keccak256(toUtf8Bytes(deviceId));
}

export function computeIncidentId(deviceIdHash, sequence) {
    return solidityPackedKeccak256(['string', 'bytes32', 'uint64'], [INCIDENT_ID_PREFIX, deviceIdHash, BigInt(sequence)]);
}

export function computeFirmwareVersionHash(firmwareVersion) {
    return keccak256(toUtf8Bytes(firmwareVersion));
}

export function computeCalibrationHash(calibrationCanonical) {
    return `0x${createHash('sha256').update(calibrationCanonical, 'utf8').digest('hex')}`;
}

export function computeEvidenceHash(evidence) {
    const types = ['bytes32', ...EVIDENCE_FIELDS.map(([, type]) => type)];
    const values = [EVIDENCE_TYPEHASH, ...EVIDENCE_FIELDS.map(([, type, key]) => (
        type === 'uint64' ? BigInt(evidence[key]) : evidence[key]
    ))];
    return keccak256(AbiCoder.defaultAbiCoder().encode(types, values));
}

export function normalizeIncidentDomain(domain) {
    if (!isPlainObject(domain)) throw new TypeError('incident EIP-712 domain is required');
    const { name, version, chainId, verifyingContract } = domain;
    if (typeof name !== 'string' || name === '') throw new TypeError('incident domain name is required');
    if (typeof version !== 'string' || version === '') throw new TypeError('incident domain version is required');
    if (!/^[1-9][0-9]*$/.test(String(chainId ?? ''))) throw new TypeError('incident domain chainId must be a positive integer');
    if (typeof verifyingContract !== 'string' || !isAddress(verifyingContract)) {
        throw new TypeError('incident domain verifyingContract must be an address');
    }
    return Object.freeze({
        name,
        version,
        chainId: String(chainId),
        verifyingContract: getAddress(verifyingContract),
    });
}

export function domainFromConfig(incidentConfig) {
    return normalizeIncidentDomain({
        name: incidentConfig.domainName,
        version: incidentConfig.domainVersion,
        chainId: incidentConfig.chainId,
        verifyingContract: incidentConfig.verifyingContract,
    });
}

export function computeAttestationDigest(domain, attestation) {
    return TypedDataEncoder.hash(
        {
            name: domain.name,
            version: domain.version,
            chainId: BigInt(domain.chainId),
            verifyingContract: domain.verifyingContract,
        },
        ATTESTATION_TYPES,
        {
            deviceIdHash: attestation.deviceIdHash,
            incidentId: attestation.incidentId,
            sequence: BigInt(attestation.sequence),
            observedAt: BigInt(attestation.observedAt),
            severity: attestation.severity,
            evidenceHash: attestation.evidenceHash,
        }
    );
}

// Returns { ok, signer } or a failure. Enforces r||s||v, v in {27,28}, low-s.
export function recoverIncidentSigner(digest, signature) {
    if (typeof signature !== 'string' || !SIGNATURE_RE.test(signature)) {
        return fail(INCIDENT_ERROR.INVALID_SIGNATURE, 'signature must be 65-byte 0x-prefixed hex');
    }
    const hex = signature.slice(2).toLowerCase();
    const r = BigInt(`0x${hex.slice(0, 64)}`);
    const s = BigInt(`0x${hex.slice(64, 128)}`);
    const v = Number.parseInt(hex.slice(128, 130), 16);
    if (v !== 27 && v !== 28) return fail(INCIDENT_ERROR.INVALID_SIGNATURE, 'signature v must be 27 or 28');
    if (r === 0n || r >= SECP256K1_N) return fail(INCIDENT_ERROR.INVALID_SIGNATURE, 'signature r is out of range');
    if (s === 0n || s > SECP256K1_HALF_N) return fail(INCIDENT_ERROR.INVALID_SIGNATURE, 'signature s must be in the low half order');

    try {
        return { ok: true, signer: recoverAddress(digest, `0x${hex}`) };
    } catch {
        return fail(INCIDENT_ERROR.INVALID_SIGNATURE, 'signature does not recover to a public key');
    }
}

// Full stateless verification: format -> semantics -> hashes -> signature.
// DB-dependent checks (signer registry, time/sequence policy, dedupe) live in incident-intake.js.
export function verifyIncidentPayload(payload, domain) {
    const parsed = parseIncidentPayload(payload);
    if (!parsed.ok) return parsed;
    const { evidence, transport } = parsed;

    const semanticError = validateIncidentSemantics(evidence);
    if (semanticError) return fail(INCIDENT_ERROR.INVALID_SEMANTICS, semanticError, { evidence, transport });

    const calibrationRevision = parseCalibrationRevision(transport.calibrationCanonical);
    if (calibrationRevision === null) {
        return fail(INCIDENT_ERROR.INVALID_PAYLOAD, 'calibration_canonical must be AIR-CAL-1|...|revision=N', { evidence, transport });
    }
    if (calibrationRevision !== evidence.calibration_revision) {
        return fail(INCIDENT_ERROR.HASH_MISMATCH, 'calibration_canonical revision does not match calibration_revision', {
            evidence,
            transport,
        });
    }

    const deviceIdHash = computeDeviceIdHash(transport.deviceId);
    const computed = {
        deviceIdHash,
        incidentId: computeIncidentId(deviceIdHash, evidence.sequence),
        firmwareVersionHash: computeFirmwareVersionHash(transport.firmwareVersion),
        calibrationHash: computeCalibrationHash(transport.calibrationCanonical),
        evidenceHash: computeEvidenceHash(evidence),
    };
    const hashChecks = [
        ['device_id_hash', evidence.device_id_hash, computed.deviceIdHash],
        ['incident_id', evidence.incident_id, computed.incidentId],
        ['firmware_version_hash', evidence.firmware_version_hash, computed.firmwareVersionHash],
        ['calibration_hash', evidence.calibration_hash, computed.calibrationHash],
        ['evidence_hash', transport.evidenceHash, computed.evidenceHash],
    ];
    for (const [field, claimed, actual] of hashChecks) {
        if (claimed !== actual) {
            return fail(INCIDENT_ERROR.HASH_MISMATCH, `${field} does not match recomputed value`, {
                evidence,
                transport,
                computed,
                field,
            });
        }
    }

    computed.digest = computeAttestationDigest(domain, {
        deviceIdHash: computed.deviceIdHash,
        incidentId: computed.incidentId,
        sequence: evidence.sequence,
        observedAt: evidence.observed_at,
        severity: evidence.severity,
        evidenceHash: computed.evidenceHash,
    });

    const recovered = recoverIncidentSigner(computed.digest, transport.signature);
    if (!recovered.ok) return { ...recovered, evidence, transport, computed };

    return {
        ok: true,
        evidence,
        transport,
        computed,
        signer: recovered.signer.toLowerCase(),
    };
}

// Step 3 (needs DB state): schema section 6 time policy + strictly increasing sequence.
export function checkIncidentOrdering({
    sequence,
    observedAt,
    receivedAtSec,
    lastSequence = null,
    lastObservedAt = null,
    clockSkewSeconds,
    maxRegressionSeconds,
}) {
    const observed = BigInt(observedAt);
    const received = BigInt(receivedAtSec);
    const skew = observed > received ? observed - received : received - observed;
    if (skew > BigInt(clockSkewSeconds)) {
        return fail(INCIDENT_ERROR.OBSERVED_AT_OUT_OF_WINDOW, `observed_at differs from receive time by ${skew}s`);
    }
    if (lastObservedAt !== null && observed + BigInt(maxRegressionSeconds) < BigInt(lastObservedAt)) {
        return fail(INCIDENT_ERROR.OBSERVED_AT_REGRESSED, 'observed_at regressed more than allowed from the last incident');
    }
    if (lastSequence !== null && BigInt(sequence) <= BigInt(lastSequence)) {
        return fail(INCIDENT_ERROR.SEQUENCE_NOT_INCREASING, 'sequence must be greater than the last accepted sequence');
    }
    return { ok: true };
}

export function buildIncidentAck({ incidentId, evidenceHash, accepted, errorCode = null, receivedAtSec }) {
    return {
        schema_version: INCIDENT_SCHEMA_VERSION,
        incident_id: incidentId,
        evidence_hash: evidenceHash,
        accepted,
        error_code: accepted ? null : errorCode,
        received_at: String(receivedAtSec),
    };
}
