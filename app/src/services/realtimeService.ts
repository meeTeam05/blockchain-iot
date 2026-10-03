import EventSource from 'react-native-sse';
import { Env } from '../config/env';
import { getAccessToken } from '../api/authInterceptor';
import { parseRealtimeEvent, RealtimeEvent, RealtimeStatus } from '../models/realtimeEvent';

// The full set of `type` values the backend's SSE endpoint emits
// (server/api/src/services/*.js, server/api/src/plugins/realtime.js).
// react-native-sse dispatches per exact SSE `event:` name, so every type
// needs its own listener registration — there's no wildcard listener.
const EVENT_NAMES = [
  'command.updated',
  'device.status',
  'ota.progress',
  'replay.reset',
  'shadow.reported',
  'telemetry.point',
] as const;

type SseEventName = (typeof EVENT_NAMES)[number];

const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export type RealtimeEventHandler = (event: RealtimeEvent) => void;
export type RealtimeStatusHandler = (status: RealtimeStatus) => void;

/**
 * Single shared SSE connection to /realtime. Reconnects itself with
 * exponential backoff and a fresh Authorization header (the access token
 * may have been refreshed since the last attempt — react-native-sse sets
 * headers once per connection, not dynamically, so headers must be rebuilt
 * on every reconnect). Mirrors RealtimeService.watchEvents.
 *
 * KNOWN RISK (flagged during planning, not yet verified on a real device):
 * this relies on React Native's XHR delivering progressive `responseText`
 * for a long-lived streaming response. If a platform/version buffers the
 * whole response instead, events won't arrive until the connection
 * actually closes. Test on real Android + iOS devices before relying on
 * this in production; if it doesn't stream, the fix is a watchdog timer
 * that force-reconnects when nothing has arrived for N seconds.
 */
export class RealtimeService {
  private es: EventSource<SseEventName> | null = null;
  private lastEventId: string | null = null;
  private reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  private readonly eventHandlers = new Set<RealtimeEventHandler>();
  private readonly statusHandlers = new Set<RealtimeStatusHandler>();

  // SSE reconnect/replay can resend frames. Bounded dedup by event ID, plus
  // per-resource staleness rejection so a delayed/replayed frame can't
  // overwrite a newer one that already arrived. Mirrors mobileApp's
  // RealtimeEventRouter.acceptsEvent.
  private readonly seenEventIds = new Set<string>();
  private readonly latestEventTimes = new Map<string, number>();

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.es?.close();
    this.es = null;
    this.emitStatus('disconnected');
  }

  onEvent(handler: RealtimeEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  onStatus(handler: RealtimeStatusHandler): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  private emitStatus(status: RealtimeStatus): void {
    for (const handler of this.statusHandlers) handler(status);
  }

  private connect(): void {
    if (this.stopped) return;
    this.emitStatus('connecting');

    const token = getAccessToken();
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId;

    const baseUrl = Env.apiBaseUri.toString().replace(/\/$/, '');
    const es = new EventSource<SseEventName>(`${baseUrl}/realtime`, {
      headers,
      // We own reconnection (backoff + fresh headers) below; disabling the
      // library's own repoll avoids a second, uncoordinated retry loop.
      pollingInterval: 0,
    });
    this.es = es;

    es.addEventListener('open', () => {
      this.reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      this.emitStatus('connected');
    });

    for (const name of EVENT_NAMES) {
      es.addEventListener(name, (evt) => this.handleMessage(evt));
    }

    es.addEventListener('error', () => {
      if (this.stopped) return;
      this.emitStatus('disconnected');
      this.scheduleReconnect();
    });
  }

  private handleMessage(evt: { data: string | null; lastEventId: string | null }): void {
    if (evt.lastEventId) this.lastEventId = evt.lastEventId;
    if (!evt.data) return;

    let json: unknown;
    try {
      json = JSON.parse(evt.data);
    } catch {
      return;
    }

    let event: RealtimeEvent;
    try {
      event = parseRealtimeEvent(json);
    } catch {
      return;
    }

    if (!this.acceptsEvent(event)) return;

    if (event.type === 'replay.reset') {
      this.emitStatus('degraded');
    }
    for (const handler of this.eventHandlers) handler(event);
  }

  private acceptsEvent(event: RealtimeEvent): boolean {
    if (this.seenEventIds.has(event.id)) return false;
    this.seenEventIds.add(event.id);
    if (this.seenEventIds.size > 1_000) {
      this.seenEventIds.delete(this.seenEventIds.values().next().value as string);
    }

    if (event.type === 'telemetry.point' || event.type === 'replay.reset') return true;

    const key =
      event.type === 'command.updated'
        ? `${event.type}:${event.deviceId}:${String(event.payload.command_id ?? '')}`
        : `${event.type}:${event.deviceId}`;

    const eventTime = event.occurredAt.getTime();
    const previous = this.latestEventTimes.get(key);
    if (previous !== undefined && eventTime < previous) return false;
    this.latestEventTimes.set(key, eventTime);
    return true;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.es?.close();
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  }
}

export const realtimeService = new RealtimeService();
