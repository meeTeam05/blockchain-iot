// Pure identity helpers shared by B2-B6. Each verified against the real
// Schema v2 test vectors / contract constants, not guessed:
//   computeDeviceIdHash: matches docs/test-vectors device_id_hash exactly.
//   computeIncidentId: matches docs/test-vectors incident_id exactly.
import { encodeAbiParameters, encodePacked, keccak256, toBytes } from 'viem'

const INCIDENT_ID_PREFIX = 'AIR-INCIDENT-2'

export function computeDeviceIdHash(deviceId: string): `0x${string}` {
  return keccak256(toBytes(deviceId))
}

export function computeIncidentId(deviceIdHash: `0x${string}`, sequence: bigint | string): `0x${string}` {
  return keccak256(encodePacked(['string', 'bytes32', 'uint64'], [INCIDENT_ID_PREFIX, deviceIdHash, BigInt(sequence)]))
}

export function computeIncidentKey(deviceIdHash: `0x${string}`, incidentId: `0x${string}`): `0x${string}` {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }], [deviceIdHash, incidentId]))
}
