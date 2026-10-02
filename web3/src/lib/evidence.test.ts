// Hard gate for decision #1: must match both real test vectors exactly, and
// a single mutated field must flip the result. Runs fully offline (no RPC),
// matching tmp/Web3_task.md bước 5.5's stated acceptance criterion.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { computeEvidenceHash, type EvidenceRecord } from './evidence'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VECTOR_DIR = path.resolve(HERE, '../../../docs/test-vectors')

function loadVector(filename: string) {
  return JSON.parse(readFileSync(path.join(VECTOR_DIR, filename), 'utf8'))
}

const VECTORS = [
  'incident-v2-qcvn-exceeded.json',
  'incident-v2-model-early-warning.json',
]

describe('computeEvidenceHash against real Schema v2 test vectors', () => {
  for (const file of VECTORS) {
    it(`matches expected.evidence_hash in ${file}`, () => {
      const vector = loadVector(file)
      const hash = computeEvidenceHash(vector.evidence as EvidenceRecord)
      expect(hash).toBe(vector.expected.evidence_hash)
    })
  }

  it('flips to a different hash when a single field is mutated', () => {
    const vector = loadVector('incident-v2-qcvn-exceeded.json')
    const mutated: EvidenceRecord = { ...vector.evidence, sequence: String(Number(vector.evidence.sequence) + 1) }
    const original = computeEvidenceHash(vector.evidence as EvidenceRecord)
    const changed = computeEvidenceHash(mutated)
    expect(changed).not.toBe(original)
    expect(original).toBe(vector.expected.evidence_hash)
  })
})
