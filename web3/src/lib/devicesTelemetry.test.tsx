import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { telemetryQueryKey, useLatestTelemetry } from './devicesApi'
import { RealtimeSync } from './RealtimeSync'
import type { RealtimeEvent, RealtimeStatus } from './realtime'

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  eventHandler: undefined as ((event: RealtimeEvent) => void) | undefined,
  statusHandler: undefined as ((status: RealtimeStatus) => void) | undefined,
}))
vi.mock('./authStore', () => ({
  useAuth: () => ({ accessToken: 'token', request: mocks.request, requestPublic: mocks.request }),
}))
vi.mock('./realtime', async (original) => ({
  ...(await original<typeof import('./realtime')>()),
  RealtimeClient: class {
    onEvent(handler: (event: RealtimeEvent) => void) { mocks.eventHandler = handler; return () => {} }
    onStatus(handler: (status: RealtimeStatus) => void) { mocks.statusHandler = handler; return () => {} }
    start() {}
    stop() {}
  },
}))

const DEVICE = 'dc:b4:d9:13:ed:8c'
const row = { ts: '2026-10-04T10:00:00.000Z', temperature: 29.4, humidity: 71, co_ppm: 3.2, no2_ppm: 0.08 }

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return { client, wrapper }
}
const json = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response

describe('useLatestTelemetry', () => {
  beforeEach(() => mocks.request.mockReset())

  it('requests only the newest point of the device and returns it', async () => {
    mocks.request.mockResolvedValue(json([row, { ...row, ts: '2026-10-04T09:59:00.000Z' }]))
    const { wrapper } = setup()
    const hook = renderHook(() => useLatestTelemetry(DEVICE, true), { wrapper })
    await waitFor(() => expect(hook.result.current.data).toEqual(row))
    expect(mocks.request).toHaveBeenCalledWith(`/devices/${encodeURIComponent(DEVICE)}/telemetry?limit=1`)
  })

  it('returns null when the device has no reading in the window', async () => {
    mocks.request.mockResolvedValue(json([]))
    const { wrapper } = setup()
    const hook = renderHook(() => useLatestTelemetry(DEVICE, true), { wrapper })
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true))
    expect(hook.result.current.data).toBeNull()
  })

  it('surfaces an API error instead of showing stale numbers', async () => {
    mocks.request.mockResolvedValue(json({ error: 'Forbidden' }, false))
    const { wrapper } = setup()
    const hook = renderHook(() => useLatestTelemetry(DEVICE, true), { wrapper })
    await waitFor(() => expect(hook.result.current.isError).toBe(true))
  })

  it('does not call the API for an offline device', async () => {
    const { wrapper } = setup()
    const hook = renderHook(() => useLatestTelemetry(DEVICE, false), { wrapper })
    await act(async () => { await Promise.resolve() })
    expect(hook.result.current.fetchStatus).toBe('idle')
    expect(mocks.request).not.toHaveBeenCalled()
  })
})

describe('RealtimeSync telemetry', () => {
  afterEach(() => { mocks.eventHandler = undefined; mocks.statusHandler = undefined })

  const event = (type: string, payload: Record<string, unknown> = {}): RealtimeEvent =>
    ({ id: '1', type, deviceId: DEVICE, occurredAt: row.ts, payload })

  it('writes a telemetry.point straight into the card cache without refetching', () => {
    const { client, wrapper: Wrapper } = setup()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    render(<Wrapper><RealtimeSync /></Wrapper>)
    act(() => mocks.eventHandler!(event('telemetry.point', { ...row, mode: 'on' })))
    expect(client.getQueryData(telemetryQueryKey(DEVICE))).toEqual(row)
    expect(invalidate).not.toHaveBeenCalled()
  })

  it('keeps the newer reading when a replayed older point arrives late', () => {
    const { client, wrapper: Wrapper } = setup()
    render(<Wrapper><RealtimeSync /></Wrapper>)
    act(() => mocks.eventHandler!(event('telemetry.point', row)))
    act(() => mocks.eventHandler!(event('telemetry.point', { ...row, ts: '2026-10-04T09:00:00.000Z', temperature: 10 })))
    expect(client.getQueryData(telemetryQueryKey(DEVICE))).toEqual(row)
    act(() => mocks.eventHandler!(event('telemetry.point', { ...row, ts: '2026-10-04T10:01:00.000Z', temperature: 31 })))
    expect(client.getQueryData(telemetryQueryKey(DEVICE))).toMatchObject({ temperature: 31 })
  })

  it('refreshes only the device list on device.status', () => {
    const { client, wrapper: Wrapper } = setup()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    render(<Wrapper><RealtimeSync /></Wrapper>)
    act(() => mocks.eventHandler!(event('device.status', { online: false })))
    expect(invalidate).toHaveBeenCalledTimes(1)
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['devices'] })
  })
})
