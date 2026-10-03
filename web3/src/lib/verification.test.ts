// B4 outcome rules over the real Schema v2 vector: valid data, each failure step,
// infrastructure states that must never read as "verification failed", and the
// historical signer after a rotation.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { computeEvidenceHash, type EvidenceRecord } from './evidence'
import { computeIncidentAttestationDigest, recoverIncidentSigner } from './incidentSignature'
import { evaluateVerification, type VerificationInput } from './verification'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const vector = JSON.parse(readFileSync(path.resolve(HERE, '../../../docs/test-vectors/incident-v2-qcvn-exceeded.json'), 'utf8'))
const evidence = vector.evidence as EvidenceRecord
const deviceId = vector.transport.device_id as string
const localHash = computeEvidenceHash(evidence)
const OLD_SIGNER = vector.expected.signer as Address
const ROTATED_SIGNER = '0x00000000000000000000000000000000000000aa' as Address

function input(overrides: Partial<VerificationInput> = {}): VerificationInput {
  return {
    routeDeviceId: deviceId,
    routeIncidentId: evidence.incident_id as string,
    evidence,
    localHash,
    domain: 'correct',
    contractHash: { status: 'success', value: localHash },
    chainIncident: { status: 'success', value: { status: 1, evidenceHash: localHash, signer: OLD_SIGNER, incidentId: evidence.incident_id as Hex } },
    recoveredSigner: { status: 'success', value: OLD_SIGNER },
    ...overrides,
  }
}

describe('evaluateVerification', () => {
  it('passes all four checks for the real vector', () => {
    const result = evaluateVerification(input())
    expect(result.state).toBe('ok')
    expect(result.checks).toEqual({ deviceIdHash: true, incidentId: true, evidenceHash: true, signer: true })
  })

  it('accepts the historical incident signer after the device key was rotated', async () => {
    const digest = computeIncidentAttestationDigest({
      name: vector.domain.name, version: vector.domain.version, chainId: BigInt(vector.domain.chain_id),
      verifyingContract: vector.domain.verifying_contract,
    }, evidence, localHash)
    const recovered = await recoverIncidentSigner(digest, vector.expected.signature)
    expect(recovered).toBe(OLD_SIGNER)
    // getDevice().signer is now ROTATED_SIGNER; the check compares with getIncident().signer only.
    const result = evaluateVerification(input({ recoveredSigner: { status: 'success', value: recovered } }))
    expect(result.state).toBe('ok')
    const wrongIfCurrent = evaluateVerification(input({
      chainIncident: { status: 'success', value: { status: 1, evidenceHash: localHash, signer: ROTATED_SIGNER, incidentId: evidence.incident_id as Hex } },
      recoveredSigner: { status: 'success', value: recovered },
    }))
    expect(wrongIfCurrent.state).toBe('signer_mismatch')
  })

  it('reports invalid evidence at step 3 when one field was changed', () => {
    const tampered = { ...evidence, co_ppm_x1000: Number(evidence.co_ppm_x1000) + 1 } as EvidenceRecord
    const tamperedHash = computeEvidenceHash(tampered)
    const result = evaluateVerification(input({ evidence: tampered, localHash: tamperedHash, contractHash: { status: 'success', value: tamperedHash } }))
    expect(result.state).toBe('invalid_evidence')
    expect(result.checks.evidenceHash).toBe(false)
    expect(result.storedHashOk).toBe(false)
  })

  it('reports a signer mismatch and a failed recovery as step 4', () => {
    expect(evaluateVerification(input({ recoveredSigner: { status: 'success', value: ROTATED_SIGNER } })).state).toBe('signer_mismatch')
    expect(evaluateVerification(input({ recoveredSigner: { status: 'error' } })).state).toBe('signer_mismatch')
  })

  it('reports identity mismatches for a wrong device or incident id in the route', () => {
    expect(evaluateVerification(input({ routeDeviceId: 'other-device' })).state).toBe('identity_mismatch')
    expect(evaluateVerification(input({ routeIncidentId: `0x${'0'.repeat(64)}` })).state).toBe('identity_mismatch')
  })

  it('never turns RPC or deployment problems into a failed verification', () => {
    const rpc = evaluateVerification(input({ chainIncident: { status: 'error' } }))
    expect(rpc.state).toBe('rpc_error')
    expect(rpc.checks.evidenceHash).toBeUndefined()
    expect(rpc.checks.signer).toBeUndefined()
    expect(evaluateVerification(input({ contractHash: { status: 'error' } })).state).toBe('rpc_error')
    expect(evaluateVerification(input({ domain: 'rpc_unavailable' })).state).toBe('rpc_error')
    for (const domain of ['wrong_chain', 'wrong_rpc', 'contract_not_deployed', 'domain_mismatch'] as const) {
      expect(evaluateVerification(input({ domain })).state).toBe('deployment_unavailable')
    }
  })

  it('distinguishes not-on-chain and loading', () => {
    const missing = evaluateVerification(input({
      chainIncident: { status: 'success', value: { status: 0, evidenceHash: `0x${'0'.repeat(64)}`, signer: '0x0000000000000000000000000000000000000000', incidentId: `0x${'0'.repeat(64)}` } },
    }))
    expect(missing.state).toBe('not_found')
    expect(missing.checks.signer).toBeUndefined()
    expect(evaluateVerification(input({ chainIncident: { status: 'pending' } })).state).toBe('loading')
    expect(evaluateVerification(input({ domain: 'checking' })).state).toBe('loading')
  })
})
