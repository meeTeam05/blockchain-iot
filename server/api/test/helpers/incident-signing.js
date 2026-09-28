// Firmware-equivalent incident signing for tests (no DB dependencies).
import { SigningKey } from 'ethers';

import {
    computeAttestationDigest,
    computeDeviceIdHash,
    computeEvidenceHash,
    computeIncidentId,
} from '../../src/services/incident-verify.js';

export function testSigningKey(vector) {
    return new SigningKey(vector.test_private_key_only);
}

// Rebuilds identity hashes, evidence hash and signature after applying overrides,
// exactly as correct firmware would.
export function signIncident({ vector, domain, payload, overrides = {}, signingKey = testSigningKey(vector) }) {
    const next = { ...payload, ...overrides };
    next.device_id_hash = computeDeviceIdHash(next.device_id);
    next.incident_id = computeIncidentId(next.device_id_hash, next.sequence);
    next.evidence_hash = computeEvidenceHash(next);
    const digest = computeAttestationDigest(domain, {
        deviceIdHash: next.device_id_hash,
        incidentId: next.incident_id,
        sequence: next.sequence,
        observedAt: next.observed_at,
        severity: next.severity,
        evidenceHash: next.evidence_hash,
    });
    next.signature = signingKey.sign(digest).serialized;
    return next;
}

