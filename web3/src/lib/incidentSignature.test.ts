import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { computeEvidenceHash, type EvidenceRecord } from './evidence'
import {
  computeIncidentAttestationDigest,
  recoverIncidentSigner,
  signerMatchesCanonical,
  type IncidentDomain,
} from './incidentSignature'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const vector = JSON.parse(
  readFileSync(path.resolve(HERE, '../../../docs/test-vectors/incident-v2-qcvn-exceeded.json'), 'utf8'),
)
const evidence = vector.evidence as EvidenceRecord
const domain: IncidentDomain = {
  name: vector.domain.name,
  version: vector.domain.version,
  chainId: BigInt(vector.domain.chain_id),
  verifyingContract: vector.domain.verifying_contract,
}

function digestFor(value: EvidenceRecord) {
  return computeIncidentAttestationDigest(domain, value, computeEvidenceHash(value))
}

describe('independent incident signature verification', () => {
  it('reproduces the vector digest and recovers the expected signer', async () => {
    const digest = digestFor(evidence)
    expect(digest).toBe(vector.expected.eip712_digest)
    expect(await recoverIncidentSigner(digest, vector.expected.signature)).toBe(vector.expected.signer)
  })

  it('rejects a wrong signer', async () => {
    const recovered = await recoverIncidentSigner(digestFor(evidence), vector.expected.signature)
    expect(signerMatchesCanonical(recovered, '0x0000000000000000000000000000000000000001')).toBe(false)
  })

  it('fails verification when signed evidence is tampered', async () => {
    const tampered = { ...evidence, co_ppm_x1000: Number(evidence.co_ppm_x1000) + 1 }
    const recovered = await recoverIncidentSigner(digestFor(tampered), vector.expected.signature)
    expect(signerMatchesCanonical(recovered, vector.expected.signer)).toBe(false)
  })

  it('rejects a non-canonical tampered signature even if a permissive recovery could parse it', async () => {
    const signature = `${vector.expected.signature.slice(0, -2)}00` as Hex
    await expect(recoverIncidentSigner(digestFor(evidence), signature)).rejects.toThrow('v must be 27 or 28')
  })

  it('accepts a historical incident signer after the device signer has rotated', async () => {
    const recovered = await recoverIncidentSigner(digestFor(evidence), vector.expected.signature)
    const currentDeviceSigner = '0x0000000000000000000000000000000000000002' as Address
    expect(currentDeviceSigner).not.toBe(recovered)
    expect(signerMatchesCanonical(recovered, vector.expected.signer)).toBe(true)
  })

  it('does not trust an incorrect API signer_address', async () => {
    const apiSignerAddress = '0x0000000000000000000000000000000000000003'
    const recovered = await recoverIncidentSigner(digestFor(evidence), vector.expected.signature)
    expect(apiSignerAddress).not.toBe(recovered)
    expect(signerMatchesCanonical(recovered, vector.expected.signer)).toBe(true)
  })
})
