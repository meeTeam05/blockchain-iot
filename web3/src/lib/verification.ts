// B4: turns the independent verification inputs into one outcome. Pure, so the
// incident page and the standalone /verify route share exactly one algorithm.
//
// Each check is true/false once its inputs are known and undefined while loading.
// Infrastructure problems (RPC down, wrong network/domain, incident not on chain)
// are reported as their own states and never as a failed verification.
import type { Address, Hex } from 'viem'
import type { DeploymentStatus } from './deploymentValidation'
import { computeDeviceIdHash, computeIncidentId } from './chainIncident'
import type { EvidenceRecord } from './evidence'
import { signerMatchesCanonical } from './incidentSignature'

export type ReadResult<T> =
  | { status: 'pending' }
  | { status: 'error' }
  | { status: 'success'; value: T }

export interface ChainIncidentView {
  status: number
  evidenceHash: Hex
  signer: Address
  incidentId: Hex
}

export type VerificationState =
  | 'loading'
  | 'ok'
  | 'identity_mismatch'
  | 'invalid_evidence'
  | 'signer_mismatch'
  | 'not_found'
  | 'rpc_error'
  | 'deployment_unavailable'

export interface VerificationInput {
  routeDeviceId: string
  routeIncidentId?: string
  evidence: EvidenceRecord
  localHash: Hex
  domain: DeploymentStatus
  contractHash: ReadResult<Hex>
  chainIncident: ReadResult<ChainIncidentView>
  recoveredSigner: ReadResult<Address>
}

export interface VerificationResult {
  state: VerificationState
  checks: {
    deviceIdHash: boolean
    incidentId: boolean
    evidenceHash: boolean | undefined
    signer: boolean | undefined
  }
  expectedDeviceIdHash: Hex
  expectedIncidentId: Hex
  contractHashOk: boolean | undefined
  storedHashOk: boolean | undefined
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export function evaluateVerification(input: VerificationInput): VerificationResult {
  const { evidence, localHash, chainIncident, contractHash, recoveredSigner } = input
  const expectedDeviceIdHash = computeDeviceIdHash(input.routeDeviceId)
  const expectedIncidentId = computeIncidentId(expectedDeviceIdHash, String(evidence.sequence)) as Hex
  const evidenceIncidentId = String(evidence.incident_id)

  // 1-2: local identity, no network needed.
  const deviceIdHashOk = same(expectedDeviceIdHash, String(evidence.device_id_hash))
  const incidentIdOk = same(expectedIncidentId, evidenceIncidentId)
    && (input.routeIncidentId === undefined || same(input.routeIncidentId, evidenceIncidentId))

  const onChain = chainIncident.status === 'success' && chainIncident.value.status !== 0
    ? chainIncident.value : undefined
  const contractHashOk = contractHash.status === 'success' ? same(contractHash.value, localHash) : undefined
  const storedHashOk = onChain ? same(onChain.evidenceHash, localHash) : undefined
  // 3: browser hash == contract hashEvidence() == getIncident().evidenceHash.
  const evidenceHash = contractHashOk === undefined || storedHashOk === undefined ? undefined : contractHashOk && storedHashOk
  // 4: signer recovered from the device signature == the signer recorded with this
  // incident on chain (historical; never the device's current signer).
  const signer = !onChain || recoveredSigner.status === 'pending'
    ? undefined
    : recoveredSigner.status === 'error' ? false : signerMatchesCanonical(recoveredSigner.value, onChain.signer)

  const checks = { deviceIdHash: deviceIdHashOk, incidentId: incidentIdOk, evidenceHash, signer }
  const result = { checks, expectedDeviceIdHash, expectedIncidentId, contractHashOk, storedHashOk }

  // Tampered identity is a verification failure regardless of the chain.
  if (!deviceIdHashOk || !incidentIdOk) return { ...result, state: 'identity_mismatch' }
  // Wrong network/contract/domain: nothing read from that RPC can prove or disprove anything.
  if (input.domain === 'rpc_unavailable') return { ...result, state: 'rpc_error' }
  if (input.domain !== 'correct' && input.domain !== 'checking' && input.domain !== 'disconnected') {
    return { ...result, state: 'deployment_unavailable' }
  }
  if (chainIncident.status === 'error' || contractHash.status === 'error') return { ...result, state: 'rpc_error' }
  if (chainIncident.status === 'success' && chainIncident.value.status === 0) return { ...result, state: 'not_found' }
  if (evidenceHash === false) return { ...result, state: 'invalid_evidence' }
  if (signer === false) return { ...result, state: 'signer_mismatch' }
  if (input.domain === 'checking' || evidenceHash === undefined || signer === undefined) return { ...result, state: 'loading' }
  return { ...result, state: 'ok' }
}
