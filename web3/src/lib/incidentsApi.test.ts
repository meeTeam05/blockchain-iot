import { describe, expect, it } from 'vitest'
import { incidentPagePath } from './incidentsApi'

describe('incident cursor pagination', () => {
  it('requests the first page with a bounded limit', () => {
    expect(incidentPagePath('dev-1')).toBe('/devices/dev-1/incidents?limit=50')
  })

  it('uses the last sequence as before_sequence for the next page', () => {
    expect(incidentPagePath('dev-1', '18446744073709551615'))
      .toBe('/devices/dev-1/incidents?limit=50&before_sequence=18446744073709551615')
  })
})
