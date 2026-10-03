export type RealtimeStatus = 'connecting' | 'connected' | 'disconnected'

export interface RealtimeEvent {
  id: string
  type: string
  deviceId: string
  occurredAt: string
  payload: Record<string, unknown>
}

export function isIncidentRealtimeEvent(event: Pick<RealtimeEvent, 'type'>) {
  return event.type.startsWith('incident.') || event.type === 'incentive.updated' || event.type === 'replay.reset'
}

type ConnectStream = (lastEventId: string | null, signal: AbortSignal) => Promise<Response>

const INITIAL_RECONNECT_MS = 1_000
const MAX_RECONNECT_MS = 30_000

export class RealtimeClient {
  private readonly connectStream: ConnectStream
  private abortController: AbortController | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = INITIAL_RECONNECT_MS
  private lastEventId: string | null = null
  private stopped = true
  private generation = 0
  private readonly eventHandlers = new Set<(event: RealtimeEvent) => void>()
  private readonly statusHandlers = new Set<(status: RealtimeStatus) => void>()
  private readonly seenIds = new Set<string>()

  constructor(connectStream: ConnectStream) {
    this.connectStream = connectStream
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.reconnectDelay = INITIAL_RECONNECT_MS
    void this.connect(++this.generation)
  }

  stop() {
    this.stopped = true
    this.generation += 1
    this.abortController?.abort()
    this.abortController = null
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.emitStatus('disconnected')
  }

  onEvent(handler: (event: RealtimeEvent) => void) {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  onStatus(handler: (status: RealtimeStatus) => void) {
    this.statusHandlers.add(handler)
    return () => this.statusHandlers.delete(handler)
  }

  private emitStatus(status: RealtimeStatus) {
    for (const handler of this.statusHandlers) handler(status)
  }

  private async connect(generation: number) {
    if (this.stopped || generation !== this.generation) return
    this.emitStatus('connecting')
    const abortController = new AbortController()
    this.abortController = abortController
    try {
      const response = await this.connectStream(this.lastEventId, abortController.signal)
      if (!response.ok || !response.body) throw new Error(`SSE failed (${response.status})`)
      if (this.stopped || generation !== this.generation) return
      this.reconnectDelay = INITIAL_RECONNECT_MS
      this.emitStatus('connected')
      await this.readStream(response.body, generation)
    } catch (error) {
      if (abortController.signal.aborted || this.stopped || generation !== this.generation) return
      void error
    }
    if (!this.stopped && generation === this.generation) {
      this.emitStatus('disconnected')
      this.scheduleReconnect(generation)
    }
  }

  private scheduleReconnect(generation: number) {
    if (this.reconnectTimer || this.stopped) return
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect(generation)
    }, delay)
  }

  private async readStream(stream: ReadableStream<Uint8Array>, generation: number) {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (!this.stopped && generation === this.generation) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          this.handleFrame(buffer.slice(0, boundary))
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  private handleFrame(frame: string) {
    if (!frame || frame.startsWith(':')) return
    let id = ''
    const data: string[] = []
    for (const line of frame.split('\n')) {
      if (line.startsWith('id:')) id = line.slice(3).trim()
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    if (!data.length) return
    try {
      const raw = JSON.parse(data.join('\n')) as Record<string, unknown>
      const eventId = String(raw.id ?? id)
      if (!eventId || this.seenIds.has(eventId)) return
      this.seenIds.add(eventId)
      if (this.seenIds.size > 1_000) this.seenIds.delete(this.seenIds.values().next().value!)
      this.lastEventId = eventId
      const event: RealtimeEvent = {
        id: eventId,
        type: typeof raw.type === 'string' ? raw.type : '',
        deviceId: typeof raw.device_id === 'string' ? raw.device_id : '',
        occurredAt: typeof raw.occurred_at === 'string' ? raw.occurred_at : '',
        payload: raw.payload && typeof raw.payload === 'object' ? raw.payload as Record<string, unknown> : {},
      }
      for (const handler of this.eventHandlers) handler(event)
    } catch {
      // A malformed frame must not terminate the long-lived stream.
    }
  }
}

export class RealtimeRefreshCoordinator {
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private eventTimer: ReturnType<typeof setTimeout> | null = null
  private readonly refresh: () => void

  constructor(refresh: () => void) {
    this.refresh = refresh
  }

  setStatus(status: RealtimeStatus) {
    if (status === 'disconnected' && !this.pollTimer) {
      this.pollTimer = setInterval(this.refresh, 10_000)
    } else if (status !== 'disconnected' && this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  onRelevantEvent() {
    if (this.eventTimer) return
    this.eventTimer = setTimeout(() => {
      this.eventTimer = null
      this.refresh()
    }, 50)
  }

  dispose() {
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.eventTimer) clearTimeout(this.eventTimer)
    this.pollTimer = null
    this.eventTimer = null
  }
}
