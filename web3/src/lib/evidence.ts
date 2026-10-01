// B4 (decision #1): OWN independent reimplementation of the evidence hash --
// not a passthrough to the contract's hashEvidence(). Field list, type
// string and encoding order are ported from
// server/api/src/services/incident-verify.js (EVIDENCE_FIELDS /
// EVIDENCE_TYPE_STRING / computeEvidenceHash) and
// docs/BLOCKCHAIN_INCIDENT_SCHEMA.md section 4 -- both must stay in sync if
// the schema ever changes.
import { encodeAbiParameters, keccak256, toBytes } from 'viem'

// [solidity name, ABI type, API/transport key] in exact IncidentEvidence order.
export const EVIDENCE_FIELDS = [
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
] as const

export type EvidenceRecord = Record<(typeof EVIDENCE_FIELDS)[number][2], string | number>

export const EVIDENCE_TYPE_STRING = `IncidentEvidence(${EVIDENCE_FIELDS.map(([name, type]) => `${type} ${name}`).join(',')})`

export const EVIDENCE_TYPEHASH = keccak256(toBytes(EVIDENCE_TYPE_STRING))

/** Field values in exact IncidentEvidence tuple order, for the on-chain hashEvidence() call. */
export function evidenceToTuple(evidence: EvidenceRecord) {
  return EVIDENCE_FIELDS.map(([, type, key]) => {
    const raw = evidence[key]
    return type === 'uint64' ? BigInt(raw) : raw
  })
}

/** Independently recomputes evidenceHash from raw evidence fields -- no RPC call. */
export function computeEvidenceHash(evidence: EvidenceRecord): `0x${string}` {
  const abiParams = [{ type: 'bytes32' }, ...EVIDENCE_FIELDS.map(([, type]) => ({ type }))]
  const values = [EVIDENCE_TYPEHASH, ...evidenceToTuple(evidence)]
  return keccak256(encodeAbiParameters(abiParams, values))
}
