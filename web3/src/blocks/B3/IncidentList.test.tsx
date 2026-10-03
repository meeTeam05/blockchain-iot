import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IncidentList } from './IncidentList'

const mocks = vi.hoisted(() => ({ useIncidents: vi.fn(), useReadContracts: vi.fn() }))
vi.mock('../../lib/incidentsApi', () => ({ useIncidents: mocks.useIncidents }))
vi.mock('wagmi', () => ({ useReadContracts: mocks.useReadContracts }))

const incident = {
  device_id: 'dev-1',
  incident_id: `0x${'11'.repeat(32)}`,
  sequence: '7',
  observed_at: '1700000000',
  received_at: null,
  severity: 'danger',
  overall_level: 'EXCEEDED',
  co_level: 'EXCEEDED',
  no2_level: 'SAFE',
  verify_status: 'verified',
  owner_status: 'open',
  chain_status: 'pending',
  tx_hash: null,
}

function incidentQuery(overrides: Record<string, unknown> = {}) {
  return {
    data: { pages: [[incident]] },
    isLoading: false,
    isError: false,
    error: null,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    isFetchingNextPage: false,
    ...overrides,
  }
}

describe('IncidentList state separation', () => {
  beforeEach(() => {
    mocks.useIncidents.mockReturnValue(incidentQuery())
    mocks.useReadContracts.mockReturnValue({
      data: [{ status: 'success', result: { status: 0 } }],
      isPending: false,
      isError: false,
    })
  })

  it('renders API unavailable independently', () => {
    mocks.useIncidents.mockReturnValue(incidentQuery({ data: undefined, isError: true, error: new Error('API down') }))
    render(<MemoryRouter><IncidentList deviceId="dev-1" /></MemoryRouter>)
    expect(screen.getByText('API down')).toBeInTheDocument()
  })

  it('does not collapse an RPC failure into not-on-chain', () => {
    mocks.useReadContracts.mockReturnValue({ data: [{ status: 'failure' }], isPending: false, isError: true })
    render(<MemoryRouter><IncidentList deviceId="dev-1" /></MemoryRouter>)
    expect(screen.getByText('Chain không khả dụng')).toBeInTheDocument()
  })

  it('renders pending relay when chain successfully returns None', () => {
    render(<MemoryRouter><IncidentList deviceId="dev-1" /></MemoryRouter>)
    expect(screen.getByText('Đang đưa lên chain')).toBeInTheDocument()
  })
})
