import { afterEach, describe, expect, it, vi } from 'vitest'
import { isIncidentRealtimeEvent, RealtimeClient, RealtimeRefreshCoordinator } from './realtime'

afterEach(() => vi.useRealTimers())

describe('RealtimeRefreshCoordinator', () => {
  it('refreshes for incident/replay SSE events but not unrelated telemetry', () => {
    expect(isIncidentRealtimeEvent({ type: 'incident.chain_updated' })).toBe(true)
    expect(isIncidentRealtimeEvent({ type: 'incident.owner_updated' })).toBe(true)
    expect(isIncidentRealtimeEvent({ type: 'replay.reset' })).toBe(true)
    expect(isIncidentRealtimeEvent({ type: 'telemetry.point' })).toBe(false)
  })
  it('polls every 10 seconds only while SSE is disconnected', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const coordinator = new RealtimeRefreshCoordinator(refresh)
    coordinator.setStatus('connected')
    vi.advanceTimersByTime(20_000)
    expect(refresh).not.toHaveBeenCalled()
    coordinator.setStatus('disconnected')
    coordinator.setStatus('disconnected')
    vi.advanceTimersByTime(20_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    coordinator.setStatus('connected')
    vi.advanceTimersByTime(20_000)
    expect(refresh).toHaveBeenCalledTimes(2)
    coordinator.dispose()
  })

  it('coalesces a burst of SSE events into one refresh', () => {
    vi.useFakeTimers()
    const refresh = vi.fn()
    const coordinator = new RealtimeRefreshCoordinator(refresh)
    coordinator.onRelevantEvent()
    coordinator.onRelevantEvent()
    coordinator.onRelevantEvent()
    vi.advanceTimersByTime(50)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})

describe('RealtimeClient', () => {
  it('reuses one stream, parses events, deduplicates replay, and cleans up', async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>
    const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller } })
    const connect = vi.fn(async (_lastId: string | null, signal: AbortSignal) => {
      signal.addEventListener('abort', () => streamController.close(), { once: true })
      return new Response(stream, { status: 200 })
    })
    const client = new RealtimeClient(connect)
    const events = vi.fn()
    client.onEvent(events)
    client.start()
    client.start()
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1))
    const frame = 'id: 7\nevent: incident.created\ndata: {"id":"7","type":"incident.created","device_id":"dev-1","payload":{}}\n\n'
    streamController.enqueue(new TextEncoder().encode(frame + frame))
    await vi.waitFor(() => expect(events).toHaveBeenCalledTimes(1))
    client.stop()
    expect(connect.mock.calls[0]?.[1].aborted).toBe(true)
  })

  it('reconnects after failure and carries Last-Event-ID', async () => {
    vi.useFakeTimers()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(async () => new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c } })))
    const client = new RealtimeClient(connect)
    client.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(connect.mock.calls[1]?.[0]).toBeNull()
    client.stop()
    controller.close()
  })
})
