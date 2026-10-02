import { hashTypedData, recoverAddress, type Address, type Hex } from 'viem'
import type { EvidenceRecord } from './evidence'

export interface IncidentDomain {
  name: string
  version: string
  chainId: number | bigint
  verifyingContract: Address
}

export const INCIDENT_ATTESTATION_TYPES = {
  IncidentAttestation: [
    { name: 'deviceIdHash', type: 'bytes32' },
    { name: 'incidentId', type: 'bytes32' },
    { name: 'sequence', type: 'uint64' },
    { name: 'observedAt', type: 'uint64' },
    { name: 'severity', type: 'uint8' },
    { name: 'evidenceHash', type: 'bytes32' },
  ],
} as const

const SECP256K1_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
const SECP256K1_HALF_N = SECP256K1_N >> 1n

export function assertCanonicalIncidentSignature(signature: Hex) {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('Incident signature must be 65-byte hex')
  const raw = signature.slice(2)
  const r = BigInt(`0x${raw.slice(0, 64)}`)
  const s = BigInt(`0x${raw.slice(64, 128)}`)
  const v = Number.parseInt(raw.slice(128), 16)
  if (r === 0n || r >= SECP256K1_N) throw new Error('Incident signature r is out of range')
  if (s === 0n || s > SECP256K1_HALF_N) throw new Error('Incident signature s is not canonical low-s')
  if (v !== 27 && v !== 28) throw new Error('Incident signature v must be 27 or 28')
}

export function computeIncidentAttestationDigest(
  domain: IncidentDomain,
  evidence: EvidenceRecord,
  evidenceHash: Hex,
): Hex {
  return hashTypedData({
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: BigInt(domain.chainId),
      verifyingContract: domain.verifyingContract,
    },
    types: INCIDENT_ATTESTATION_TYPES,
    primaryType: 'IncidentAttestation',
    message: {
      deviceIdHash: evidence.device_id_hash as Hex,
      incidentId: evidence.incident_id as Hex,
      sequence: BigInt(evidence.sequence),
      observedAt: BigInt(evidence.observed_at),
      severity: Number(evidence.severity),
      evidenceHash,
    },
  })
}

/** Recovers the signer entirely in the browser; the API signer is deliberately not an input. */
export async function recoverIncidentSigner(digest: Hex, signature: Hex): Promise<Address> {
  assertCanonicalIncidentSignature(signature)
  return recoverAddress({ hash: digest, signature })
}

/** Compare with the signer stored on the historical incident, never the device's current signer. */
export function signerMatchesCanonical(recovered: Address, incidentSigner: Address): boolean {
  return recovered.toLowerCase() === incidentSigner.toLowerCase()
}
