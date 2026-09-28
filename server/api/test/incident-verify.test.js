import test from 'node:test';
import assert from 'node:assert/strict';

import {
    EVIDENCE_FIELDS,
    EVIDENCE_TYPE_STRING,
    INCIDENT_ERROR,
    buildIncidentAck,
    checkIncidentOrdering,
    computeCalibrationHash,
    computeDeviceIdHash,
    computeEvidenceHash,
    computeFirmwareVersionHash,
    computeIncidentId,
    normalizeIncidentDomain,
    parseCalibrationRevision,
    recoverIncidentSigner,
    verifyIncidentPayload,
} from '../src/services/incident-verify.js';
import { VECTOR_FILES, loadVector, signIncident, testSigningKey } from './helpers/incident-fixtures.js';

const SECP256K1_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

for (const name of Object.keys(VECTOR_FILES)) {
    test(`vector ${name}: every identity hash, evidence hash, digest and signer match`, async () => {
        const { vector, domain, payload } = await loadVector(name);
        const { evidence, transport, expected } = vector;

        assert.equal(EVIDENCE_TYPE_STRING, vector.type_strings.incident_evidence);
        assert.equal(computeDeviceIdHash(transport.device_id), evidence.device_id_hash);
        assert.equal(computeIncidentId(evidence.device_id_hash, evidence.sequence), evidence.incident_id);
        assert.equal(computeFirmwareVersionHash(transport.firmware_version), evidence.firmware_version_hash);
        assert.equal(computeCalibrationHash(transport.calibration_canonical), evidence.calibration_hash);
        assert.equal(computeEvidenceHash(evidence), expected.evidence_hash);

        const result = verifyIncidentPayload(payload, domain);
        assert.equal(result.ok, true, result.reason);
        assert.equal(result.computed.digest, expected.eip712_digest);
        assert.equal(result.signer, expected.signer.toLowerCase());
    });

    test(`vector ${name}: re-signing with the test key reproduces the published signature`, async () => {
        const { vector, domain, payload } = await loadVector(name);
        assert.equal(signIncident({ vector, domain, payload }).signature, vector.expected.signature);
    });

    test(`vector ${name}: changing any single evidence field is rejected`, async () => {
        const { domain, payload } = await loadVector(name);
        for (const [, type, key] of EVIDENCE_FIELDS) {
            const tampered = { ...payload };
            if (type === 'bytes32') {
                tampered[key] = `0x${(BigInt(payload[key]) ^ 1n).toString(16).padStart(64, '0')}`;
            } else if (type === 'uint64') {
                tampered[key] = String(BigInt(payload[key]) + 1n);
            } else {
                tampered[key] = payload[key] === 0 ? 1 : payload[key] - 1;
            }
            const result = verifyIncidentPayload(tampered, domain);
            assert.equal(result.ok, false, `tampering ${key} must fail`);
            assert.ok(
                [INCIDENT_ERROR.HASH_MISMATCH, INCIDENT_ERROR.INVALID_SEMANTICS, INCIDENT_ERROR.INVALID_PAYLOAD].includes(result.errorCode),
                `${key}: unexpected ${result.errorCode}`
            );
        }
    });
}

test('value-only tampering that keeps semantics valid is caught as HASH_MISMATCH', async () => {
    const { domain, payload } = await loadVector('earlyWarning');
    for (const key of ['temperature_c_x100', 'co_ppm_x1000', 'co_stel15_ppm_x1000', 'co_model_probability_bps', 'observed_at']) {
        const tampered = { ...payload, [key]: typeof payload[key] === 'string' ? String(BigInt(payload[key]) + 1n) : payload[key] + 1 };
        const result = verifyIncidentPayload(tampered, domain);
        assert.equal(result.errorCode, INCIDENT_ERROR.HASH_MISMATCH, key);
        assert.equal(result.field, 'evidence_hash', key);
    }
});

test('transport tampering: device_id, firmware_version, calibration_canonical and evidence_hash', async () => {
    const { domain, payload } = await loadVector('earlyWarning');
    const cases = [
        [{ device_id: '11:22:33:44:55:66' }, 'device_id_hash'],
        [{ firmware_version: '0.1.2-gas-ews' }, 'firmware_version_hash'],
        [{ calibration_canonical: 'AIR-CAL-1|co_r0_q10000=98766|no2_r0_q10000=43210|revision=3' }, 'calibration_hash'],
        [{ evidence_hash: `0x${'0'.repeat(64)}` }, 'evidence_hash'],
    ];
    for (const [override, field] of cases) {
        const result = verifyIncidentPayload({ ...payload, ...override }, domain);
        assert.equal(result.errorCode, INCIDENT_ERROR.HASH_MISMATCH, field);
        assert.equal(result.field, field);
    }
});

test('calibration revision in the canonical string must equal calibration_revision', async () => {
    const { domain, payload } = await loadVector('earlyWarning');
    const result = verifyIncidentPayload({
        ...payload,
        calibration_canonical: 'AIR-CAL-1|co_r0_q10000=98765|no2_r0_q10000=43210|revision=4',
    }, domain);
    assert.equal(result.errorCode, INCIDENT_ERROR.HASH_MISMATCH);
    assert.equal(parseCalibrationRevision('AIR-CAL-1|revision=3'), 3);
    assert.equal(parseCalibrationRevision('AIR-CAL-2|revision=3'), null);
    assert.equal(parseCalibrationRevision('AIR-CAL-1|revision=03'), null);
    assert.equal(parseCalibrationRevision('AIR-CAL-1|revision=1|revision=2'), null);
});

test('attestation tampering: signature bytes, domain and signer', async () => {
    const { vector, domain, payload } = await loadVector('exceeded');

    const flipped = `${payload.signature.slice(0, 10)}${payload.signature[10] === '0' ? '1' : '0'}${payload.signature.slice(11)}`;
    const flippedResult = verifyIncidentPayload({ ...payload, signature: flipped }, domain);
    assert.ok(!flippedResult.ok || flippedResult.signer !== vector.expected.signer.toLowerCase());

    // The domain is config-only: the same payload verified under another chain recovers a different signer.
    const otherDomain = normalizeIncidentDomain({ ...domain, chainId: '1' });
    const otherResult = verifyIncidentPayload(payload, otherDomain);
    assert.notEqual(otherResult.signer, vector.expected.signer.toLowerCase());

    // Another key produces a valid signature from a different signer; the registry check rejects it later.
    const resigned = signIncident({
        vector,
        domain,
        payload,
        signingKey: testSigningKey({ test_private_key_only: `0x${'11'.repeat(32)}` }),
    });
    const resignedResult = verifyIncidentPayload(resigned, domain);
    assert.equal(resignedResult.ok, true);
    assert.notEqual(resignedResult.signer, vector.expected.signer.toLowerCase());
});

test('signature must be canonical: v in {27,28}, low-s, non-zero r', async () => {
    const { domain, payload } = await loadVector('earlyWarning');
    const hex = payload.signature.slice(2);
    const r = hex.slice(0, 64);
    const s = BigInt(`0x${hex.slice(64, 128)}`);
    const v = hex.slice(128);

    const highS = (SECP256K1_N - s).toString(16).padStart(64, '0');
    const flippedV = v === '1b' ? '1c' : '1b';
    const malleable = `0x${r}${highS}${flippedV}`;
    const result = verifyIncidentPayload({ ...payload, signature: malleable }, domain);
    assert.equal(result.errorCode, INCIDENT_ERROR.INVALID_SIGNATURE);
    assert.match(result.reason, /low half/);

    for (const badV of ['00', '01', '1d']) {
        assert.equal(verifyIncidentPayload({ ...payload, signature: `0x${r}${hex.slice(64, 128)}${badV}` }, domain).errorCode,
            INCIDENT_ERROR.INVALID_SIGNATURE);
    }
    assert.equal(recoverIncidentSigner(`0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}${hex.slice(64)}`).ok, false);
    assert.equal(verifyIncidentPayload({ ...payload, signature: payload.signature.slice(0, 130) }, domain).errorCode,
        INCIDENT_ERROR.INVALID_PAYLOAD);
});

test('format rules: uint64 strings, lowercase bytes32, integer ranges, unknown/missing fields', async () => {
    const { domain, payload } = await loadVector('earlyWarning');
    const cases = [
        { sequence: 43 },
        { sequence: '043' },
        { sequence: '18446744073709551616' },
        { observed_at: '-1' },
        { incident_id: payload.incident_id.toUpperCase().replace('0X', '0x') },
        { model_sha256: payload.model_sha256.slice(0, 64) },
        { temperature_c_x100: 2 ** 31 },
        { temperature_c_x100: 30.47 },
        { co_ppm_x1000: -1 },
        { severity: 256 },
        { device_id: 'AA:BB:CC:DD:EE:FF' },
        { firmware_version: '' },
        { extra_field: 1 },
    ];
    for (const override of cases) {
        const result = verifyIncidentPayload({ ...payload, ...override }, domain);
        assert.equal(result.errorCode, INCIDENT_ERROR.INVALID_PAYLOAD, JSON.stringify(override));
    }
    const missing = { ...payload };
    delete missing.calibration_canonical;
    assert.equal(verifyIncidentPayload(missing, domain).errorCode, INCIDENT_ERROR.INVALID_PAYLOAD);
    assert.equal(verifyIncidentPayload([], domain).errorCode, INCIDENT_ERROR.INVALID_PAYLOAD);
    assert.equal(verifyIncidentPayload(null, domain).errorCode, INCIDENT_ERROR.INVALID_PAYLOAD);
});

test('semantic rules: enums, level/kind/severity mapping and transitions', async () => {
    const { vector, domain, payload } = await loadVector('earlyWarning');
    const cases = [
        { schema_version: 1 },
        { time_source: 0 },
        { time_source: 3 },
        { detection_method: 1 },
        { overall_level: 0, co_level: 0, co_alarm_source_mask: 0, incident_kind: 1, severity: 1 },
        { incident_kind: 2 },
        { severity: 2 },
        { severity: 3 },
        { overall_level: 2, incident_kind: 2, severity: 2 },
        { co_level: 3 },
    ];
    for (const override of cases) {
        const signed = signIncident({ vector, domain, payload, overrides: override });
        const result = verifyIncidentPayload(signed, domain);
        assert.equal(result.errorCode, INCIDENT_ERROR.INVALID_SEMANTICS, JSON.stringify(override));
    }
});

test('mask rules: source bits need matching valid bits and invalid values must be zero', async () => {
    const { vector, domain, payload } = await loadVector('earlyWarning');
    const cases = [
        // CO alarm from model while CO model output is marked invalid.
        { model_probability_valid_mask: 2, co_model_probability_bps: 0 },
        // Model output invalid but a non-zero probability was encoded.
        { model_probability_valid_mask: 1 },
        // Projection source without a valid projection value.
        { co_alarm_source_mask: 2, derived_valid_mask: 0b101111, co_proj10_ppm_x1000: 0 },
        // Rule source without valid STEL/TWA.
        { co_alarm_source_mask: 1, derived_valid_mask: 0b111010, co_stel15_ppm_x1000: 0, co_twa8h_ppm_x1000: 0 },
        // CO alarming without a valid CO reading.
        { sensor_valid_mask: 0b1011, co_ppm_x1000: 0 },
        // Sensor invalid but value non-zero.
        { sensor_valid_mask: 0b1110 },
        // Gas at SAFE must not carry alarm sources.
        { no2_alarm_source_mask: 4 },
        // Alarming gas must name a source.
        { co_alarm_source_mask: 0 },
        // Undefined bits.
        { sensor_valid_mask: 0x1f },
        { derived_valid_mask: 0x7f },
        { model_probability_valid_mask: 7 },
        { co_alarm_source_mask: 12 },
        { co_model_probability_bps: 10_001 },
        { humidity_pct_x100: 10_001 },
    ];
    for (const override of cases) {
        const signed = signIncident({ vector, domain, payload, overrides: override });
        const result = verifyIncidentPayload(signed, domain);
        assert.equal(result.errorCode, INCIDENT_ERROR.INVALID_SEMANTICS, JSON.stringify(override));
    }
});

test('model-unavailable vector is valid: bps 0 with valid bit clear is not a zero probability', async () => {
    const { domain, payload } = await loadVector('exceeded');
    assert.equal(payload.model_probability_valid_mask, 0);
    assert.equal(payload.co_model_probability_bps, 0);
    assert.equal(verifyIncidentPayload(payload, domain).ok, true);

    // Claiming the model ran (mask bit set) changes the evidence hash.
    const claimed = verifyIncidentPayload({ ...payload, model_probability_valid_mask: 1 }, domain);
    assert.equal(claimed.errorCode, INCIDENT_ERROR.HASH_MISMATCH);
});

test('checkIncidentOrdering enforces the +/-10 minute window, 60s regression and increasing sequence', () => {
    const base = { clockSkewSeconds: 600, maxRegressionSeconds: 60 };
    assert.equal(checkIncidentOrdering({ ...base, sequence: '5', observedAt: '1000', receivedAtSec: 1600 }).ok, true);
    assert.equal(checkIncidentOrdering({ ...base, sequence: '5', observedAt: '1000', receivedAtSec: 1601 }).errorCode,
        INCIDENT_ERROR.OBSERVED_AT_OUT_OF_WINDOW);
    assert.equal(checkIncidentOrdering({ ...base, sequence: '5', observedAt: '2201', receivedAtSec: 1600 }).errorCode,
        INCIDENT_ERROR.OBSERVED_AT_OUT_OF_WINDOW);
    assert.equal(checkIncidentOrdering({ ...base, sequence: '5', observedAt: '1000', receivedAtSec: 1000, lastSequence: '4', lastObservedAt: '1060' }).ok,
        true);
    assert.equal(checkIncidentOrdering({ ...base, sequence: '5', observedAt: '1000', receivedAtSec: 1000, lastSequence: '4', lastObservedAt: '1061' }).errorCode,
        INCIDENT_ERROR.OBSERVED_AT_REGRESSED);
    assert.equal(checkIncidentOrdering({ ...base, sequence: '4', observedAt: '1000', receivedAtSec: 1000, lastSequence: '4', lastObservedAt: '990' }).errorCode,
        INCIDENT_ERROR.SEQUENCE_NOT_INCREASING);
    assert.equal(checkIncidentOrdering({ ...base, sequence: '18446744073709551615', observedAt: '1000', receivedAtSec: 1000, lastSequence: '18446744073709551614' }).ok,
        true);
});

test('buildIncidentAck produces the agreed ACK shape', () => {
    const id = `0x${'a'.repeat(64)}`;
    const hash = `0x${'b'.repeat(64)}`;
    assert.deepEqual(buildIncidentAck({ incidentId: id, evidenceHash: hash, accepted: true, errorCode: 'X', receivedAtSec: 1790394605 }), {
        schema_version: 2,
        incident_id: id,
        evidence_hash: hash,
        accepted: true,
        error_code: null,
        received_at: '1790394605',
    });
    assert.equal(buildIncidentAck({ incidentId: id, evidenceHash: hash, accepted: false, errorCode: 'HASH_MISMATCH', receivedAtSec: 1 }).error_code,
        'HASH_MISMATCH');
});

test('normalizeIncidentDomain rejects missing or malformed config', () => {
    assert.throws(() => normalizeIncidentDomain({ name: 'AirSafetyLog', version: '1', chainId: '11155111', verifyingContract: '' }));
    assert.throws(() => normalizeIncidentDomain({ name: 'AirSafetyLog', version: '1', chainId: '0', verifyingContract: `0x${'c'.repeat(40)}` }));
    assert.throws(() => normalizeIncidentDomain(null));
});
