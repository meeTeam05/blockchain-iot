import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { computeDeviceIdHash, computeIncidentId } from './chainIncident'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const vector = JSON.parse(
  readFileSync(path.resolve(HERE, '../../../docs/test-vectors/incident-v2-qcvn-exceeded.json'), 'utf8'),
)

describe('chainIncident identity helpers against the real test vector', () => {
  it('computeDeviceIdHash matches evidence.device_id_hash', () => {
    expect(computeDeviceIdHash(vector.transport.device_id)).toBe(vector.evidence.device_id_hash)
  })

  it('computeIncidentId matches evidence.incident_id', () => {
    const deviceIdHash = computeDeviceIdHash(vector.transport.device_id)
    expect(computeIncidentId(deviceIdHash, vector.evidence.sequence)).toBe(vector.evidence.incident_id)
  })
})
