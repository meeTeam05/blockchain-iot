import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiDevice, TelemetryPoint } from '../../lib/devicesApi'
import { isFreshTelemetry, TELEMETRY_STALE_MS, telemetryPointFromEvent } from '../../lib/devicesApi'
import { DeviceCard } from './DeviceCard'

const mocks = vi.hoisted(() => ({ useLatestTelemetry: vi.fn() }))
vi.mock('../../lib/devicesApi', async (original) => ({
  ...(await original<typeof import('../../lib/devicesApi')>()),
  useLatestTelemetry: mocks.useLatestTelemetry,
}))

const device: ApiDevice = {
  id: 'dc:b4:d9:13:ed:8c', name: 'Smart Air 13ED8C', home_id: 'h1', room_id: null, online: true,
  last_seen: new Date().toISOString(), firmware_ver: null, created_at: new Date().toISOString(),
  mode: 'on', relay_1: null, relay_2: null, relay_3: null, open_incident_count: 0,
}
const reading: TelemetryPoint = { ts: new Date().toISOString(), temperature: 29.46, humidity: 71.6, co_ppm: 3.25, no2_ppm: 0.084 }

function renderCard(overrides: Partial<ApiDevice> = {}) {
  return render(
    <MemoryRouter>
      <DeviceCard device={{ ...device, ...overrides }} chainDevice={undefined} connectedAddress={undefined} />
    </MemoryRouter>,
  )
}

describe('DeviceCard telemetry', () => {
  beforeEach(() => mocks.useLatestTelemetry.mockReset().mockReturnValue({ data: reading }))

  it('shows the latest CO, NO2, temperature and humidity while online', () => {
    renderCard()
    expect(mocks.useLatestTelemetry).toHaveBeenCalledWith(device.id, true)
    expect(screen.getByTestId('metric-CO')).toHaveTextContent('3.3 ppm')
    expect(screen.getByTestId('metric-NO₂')).toHaveTextContent('0.08 ppm')
    expect(screen.getByTestId('metric-Nhiệt độ')).toHaveTextContent('29.5 °C')
    expect(screen.getByTestId('metric-Độ ẩm')).toHaveTextContent('72 %')
    expect(screen.queryByText('PM2.5')).not.toBeInTheDocument()
    expect(screen.getByTestId('telemetry-caption')).toHaveTextContent(/^Cập nhật lúc \d{2}:\d{2}:\d{2}$/)
  })

  it('shows a dash for every metric while offline and stops polling', () => {
    renderCard({ online: false })
    expect(mocks.useLatestTelemetry).toHaveBeenCalledWith(device.id, false)
    for (const label of ['CO', 'NO₂', 'Nhiệt độ', 'Độ ẩm']) expect(screen.getByTestId(`metric-${label}`)).toHaveTextContent('—')
    expect(screen.getByTestId('telemetry-caption')).toHaveTextContent('Thiết bị offline · không có số đo')
  })

  it('shows a dash instead of an old reading of an online device, with when it was taken', () => {
    const old = new Date(Date.now() - TELEMETRY_STALE_MS - 60_000).toISOString()
    mocks.useLatestTelemetry.mockReturnValue({ data: { ...reading, ts: old } })
    renderCard()
    for (const label of ['CO', 'NO₂', 'Nhiệt độ', 'Độ ẩm']) expect(screen.getByTestId(`metric-${label}`)).toHaveTextContent('—')
    expect(screen.getByTestId('telemetry-caption')).toHaveTextContent(/^Không có số đo mới · lần cuối \d{2}:\d{2} \d{2}\/\d{2}$/)
  })

  it('explains an empty window, a loading card and an API error', () => {
    mocks.useLatestTelemetry.mockReturnValue({ data: null })
    const view = renderCard()
    expect(screen.getByTestId('telemetry-caption')).toHaveTextContent('Chưa có số đo trong 24 giờ')
    view.unmount()
    mocks.useLatestTelemetry.mockReturnValue({ data: undefined, isPending: true })
    const loading = renderCard()
    expect(screen.getByTestId('telemetry-caption')).toHaveTextContent('Đang tải số đo…')
    loading.unmount()
    mocks.useLatestTelemetry.mockReturnValue({ data: undefined, isError: true })
    renderCard()
    expect(screen.getByTestId('telemetry-caption')).toHaveTextContent('Không tải được số đo')
  })

  it('shows a dash for a sensor field the reading does not have', () => {
    mocks.useLatestTelemetry.mockReturnValue({ data: { ...reading, no2_ppm: null } })
    renderCard()
    expect(screen.getByTestId('metric-NO₂')).toHaveTextContent('—')
    expect(screen.getByTestId('metric-CO')).toHaveTextContent('3.3 ppm')
  })
})

describe('isFreshTelemetry', () => {
  it('treats a reading as current up to the stale threshold', () => {
    const now = Date.parse('2026-10-04T10:00:00.000Z')
    const at = (msAgo: number) => ({ ...reading, ts: new Date(now - msAgo).toISOString() })
    expect(isFreshTelemetry(at(0), now)).toBe(true)
    expect(isFreshTelemetry(at(TELEMETRY_STALE_MS), now)).toBe(true)
    expect(isFreshTelemetry(at(TELEMETRY_STALE_MS + 1), now)).toBe(false)
  })
})

describe('telemetryPointFromEvent', () => {
  it('maps an SSE telemetry.point payload and drops non-numeric fields', () => {
    expect(telemetryPointFromEvent({ ts: '2026-10-04T00:00:00.000Z', temperature: 30, humidity: '70', co_ppm: null, no2_ppm: 0.1, mode: 'on' }))
      .toEqual({ ts: '2026-10-04T00:00:00.000Z', temperature: 30, humidity: null, co_ppm: null, no2_ppm: 0.1 })
    expect(telemetryPointFromEvent({ temperature: 30 })).toBeNull()
  })
})
