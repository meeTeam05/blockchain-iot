// Hard gate for decision #1: must match both real test vectors exactly, and
// a single mutated field must flip the result. Runs fully offline (no RPC),
// matching tmp/Web3_task.md bước 5.5's stated acceptance criterion.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { computeEvidenceHash, EVIDENCE_FIELDS, type EvidenceRecord } from './evidence'

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

  for (const file of VECTORS) {
    it(`changes the hash when each individual evidence field is mutated in ${file}`, () => {
      const vector = loadVector(file)
      const originalEvidence = vector.evidence as EvidenceRecord
      const originalHash = computeEvidenceHash(originalEvidence)
      for (const [, type, key] of EVIDENCE_FIELDS) {
        const raw = originalEvidence[key]
        let changed: string | number
        if (type === 'bytes32') {
          const last = String(raw).at(-1)
          changed = `${String(raw).slice(0, -1)}${last === '0' ? '1' : '0'}`
        } else if (type === 'uint64') {
          changed = (BigInt(raw) === (1n << 64n) - 1n ? BigInt(raw) - 1n : BigInt(raw) + 1n).toString()
        } else {
          const bits = Number(type.match(/[0-9]+/)?.[0] ?? 32)
          const max = type.startsWith('int') ? (2 ** (bits - 1)) - 1 : (2 ** bits) - 1
          changed = Number(raw) === max ? Number(raw) - 1 : Number(raw) + 1
        }
        expect(computeEvidenceHash({ ...originalEvidence, [key]: changed }), key).not.toBe(originalHash)
      }
    })
  }
})
