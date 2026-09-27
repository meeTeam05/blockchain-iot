const fs = require("node:fs");
const path = require("node:path");
const { ethers } = require("hardhat");

const VECTOR_DIR = path.join(__dirname, "..", "..", "docs", "test-vectors");
const VECTOR_FILES = ["incident-v2-model-early-warning.json", "incident-v2-qcvn-exceeded.json"];

function loadVectors() {
  return VECTOR_FILES.map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(VECTOR_DIR, f), "utf8")) }));
}

// snake_case JSON evidence -> camelCase struct in Schema v2 field order.
const EVIDENCE_FIELDS = [
  ["schemaVersion", "uint16", "schema_version"],
  ["deviceIdHash", "bytes32", "device_id_hash"],
  ["incidentId", "bytes32", "incident_id"],
  ["sequence", "uint64", "sequence"],
  ["observedAt", "uint64", "observed_at"],
  ["timeSource", "uint8", "time_source"],
  ["sensorValidMask", "uint8", "sensor_valid_mask"],
  ["detectionMethod", "uint8", "detection_method"],
  ["temperatureCx100", "int32", "temperature_c_x100"],
  ["humidityPctX100", "uint16", "humidity_pct_x100"],
  ["coPpmX1000", "uint32", "co_ppm_x1000"],
  ["no2PpmX1000", "uint32", "no2_ppm_x1000"],
  ["overallLevel", "uint8", "overall_level"],
  ["coLevel", "uint8", "co_level"],
  ["no2Level", "uint8", "no2_level"],
  ["coAlarmSourceMask", "uint8", "co_alarm_source_mask"],
  ["no2AlarmSourceMask", "uint8", "no2_alarm_source_mask"],
  ["derivedValidMask", "uint8", "derived_valid_mask"],
  ["coStel15PpmX1000", "uint32", "co_stel15_ppm_x1000"],
  ["no2Stel15PpmX1000", "uint32", "no2_stel15_ppm_x1000"],
  ["coTwa8hPpmX1000", "uint32", "co_twa8h_ppm_x1000"],
  ["no2Twa8hPpmX1000", "uint32", "no2_twa8h_ppm_x1000"],
  ["coProj10PpmX1000", "uint32", "co_proj10_ppm_x1000"],
  ["no2Proj10PpmX1000", "uint32", "no2_proj10_ppm_x1000"],
  ["modelProbabilityValidMask", "uint8", "model_probability_valid_mask"],
  ["coModelProbabilityBps", "uint16", "co_model_probability_bps"],
  ["no2ModelProbabilityBps", "uint16", "no2_model_probability_bps"],
  ["incidentKind", "uint8", "incident_kind"],
  ["severity", "uint8", "severity"],
  ["firmwareVersionHash", "bytes32", "firmware_version_hash"],
  ["modelSha256", "bytes32", "model_sha256"],
  ["calibrationRevision", "uint32", "calibration_revision"],
  ["calibrationHash", "bytes32", "calibration_hash"],
];

const EVIDENCE_TYPES = {
  IncidentEvidence: EVIDENCE_FIELDS.map(([name, type]) => ({ name, type })),
};

const ATTESTATION_TYPES = {
  IncidentAttestation: [
    { name: "deviceIdHash", type: "bytes32" },
    { name: "incidentId", type: "bytes32" },
    { name: "sequence", type: "uint64" },
    { name: "observedAt", type: "uint64" },
    { name: "severity", type: "uint8" },
    { name: "evidenceHash", type: "bytes32" },
  ],
};

function evidenceFromVector(v) {
  const e = {};
  for (const [name, type, json] of EVIDENCE_FIELDS) {
    const raw = v.evidence[json];
    e[name] = type === "bytes32" ? raw : BigInt(raw);
  }
  return e;
}

function hashEvidence(e) {
  return ethers.TypedDataEncoder.hashStruct("IncidentEvidence", EVIDENCE_TYPES, e);
}

function computeIncidentId(deviceIdHash, sequence) {
  return ethers.solidityPackedKeccak256(["string", "bytes32", "uint64"], ["AIR-INCIDENT-2", deviceIdHash, sequence]);
}

function claimFromEvidence(e, evidenceHash = hashEvidence(e)) {
  return {
    deviceIdHash: e.deviceIdHash,
    incidentId: e.incidentId,
    sequence: e.sequence,
    observedAt: e.observedAt,
    severity: e.severity,
    evidenceHash,
  };
}

function domainFor(address, chainId = 11155111n) {
  return { name: "AirSafetyLog", version: "1", chainId, verifyingContract: address };
}

async function signClaim(wallet, contractAddress, claim) {
  return wallet.signTypedData(domainFor(contractAddress), ATTESTATION_TYPES, claim);
}

// Build a fresh, internally consistent claim for a device at a given sequence.
function makeClaim(deviceIdHash, sequence, { severity = 1n, observedAt = 1790394600n, evidenceHash } = {}) {
  sequence = BigInt(sequence);
  return {
    deviceIdHash,
    incidentId: computeIncidentId(deviceIdHash, sequence),
    sequence,
    observedAt,
    severity,
    evidenceHash: evidenceHash ?? ethers.keccak256(ethers.toUtf8Bytes(`evidence-${deviceIdHash}-${sequence}`)),
  };
}

module.exports = {
  ATTESTATION_TYPES,
  EVIDENCE_FIELDS,
  EVIDENCE_TYPES,
  claimFromEvidence,
  computeIncidentId,
  domainFor,
  evidenceFromVector,
  hashEvidence,
  loadVectors,
  makeClaim,
  signClaim,
};
