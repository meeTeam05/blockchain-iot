import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ApiIncidentDetail } from '../../lib/incidentsApi'
import { IncidentSummary } from './IncidentSummary'

const incident = {
  sequence: '7', severity: 'danger', observed_at: '1700000000', evidence_hash: '0xabc',
  sensors: { temperature_c: 30.5, humidity_pct: 70, co_ppm: 12, no2_ppm: null },
  incident_kind: 'THRESHOLD_EXCEEDED_ENTERED', time_source: 'sntp',
  chain: { tx_hash: null, fail_reason: 'stale_signer', last_error: null },
  derived: {}, model: {}, alarm_sources: {}, firmware: {}, calibration: {},
} as unknown as ApiIncidentDetail

describe('IncidentSummary detail fields', () => {
  it('renders sensor values, canonical loggedAt and fail_reason', () => {
    render(<IncidentSummary deviceId="dev-1" incident={incident} merged={{ label: 'Lỗi đưa lên chain', tone: 'danger' }} loggedAt={1_700_000_100n} />)
    expect(screen.getByText('30.5 °C')).toBeInTheDocument()
    expect(screen.getByText('stale_signer')).toBeInTheDocument()
    expect(screen.getByText('Logged on-chain')).toBeInTheDocument()
  })
})
