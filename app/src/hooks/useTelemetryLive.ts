import { useCallback, useEffect, useState } from 'react';
import { deviceService } from '../services/deviceService';
import { realtimeService } from '../services/realtimeService';
import { RealtimeEvent, RealtimeStatus } from '../models/realtimeEvent';
import { TelemetryPoint } from '../models/telemetry';

const LIVE_WINDOW_MS = 30 * 60 * 1000;
const LIVE_MAX_POINTS = 720;

export interface TelemetrySeriesState {
  points: TelemetryPoint[];
  latest: TelemetryPoint | null;
  initialLoading: boolean;
  refreshing: boolean;
  lastError: unknown;
  lastUpdated: Date | null;
  connection: RealtimeStatus;
}

const INITIAL_STATE: TelemetrySeriesState = {
  points: [],
  latest: null,
  initialLoading: true,
  refreshing: false,
  lastError: null,
  lastUpdated: null,
  connection: 'disconnected',
};

function identityKey(point: TelemetryPoint): string {
  return [point.ts.getTime(), point.mode ?? '', point.temperature, point.humidity, point.coPpm, point.no2Ppm].join(
    '|',
  );
}

function latestPoint(points: TelemetryPoint[]): TelemetryPoint | null {
  if (points.length === 0) return null;
  return points.reduce((a, b) => (a.ts > b.ts ? a : b));
}

function normalizePoints(points: TelemetryPoint[], now: Date = new Date()): TelemetryPoint[] {
  const cutoff = now.getTime() - LIVE_WINDOW_MS;
  const byIdentity = new Map<string, { point: TelemetryPoint; seq: number }>();
  let seq = 0;
  for (const point of points) {
    if (point.ts.getTime() < cutoff) continue;
    byIdentity.set(identityKey(point), { point, seq: seq++ });
  }
  const normalized = [...byIdentity.values()].sort((a, b) => {
    const byTs = a.point.ts.getTime() - b.point.ts.getTime();
    return byTs !== 0 ? byTs : a.seq - b.seq;
  });
  const values = normalized.map((entry) => entry.point);
  return values.length <= LIVE_MAX_POINTS ? values : values.slice(values.length - LIVE_MAX_POINTS);
}

function pointFromEvent(event: RealtimeEvent): TelemetryPoint | null {
  const payload = event.payload;
  const tsRaw = payload.ts;
  if (typeof tsRaw !== 'string') return null;
  const ts = new Date(tsRaw);
  if (Number.isNaN(ts.getTime())) return null;
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  return {
    ts,
    temperature: num(payload.temperature),
    humidity: num(payload.humidity),
    coPpm: num(payload.co_ppm),
    no2Ppm: num(payload.no2_ppm),
    mode: typeof payload.mode === 'string' ? payload.mode : null,
  };
}

async function fetchSnapshot(deviceId: string): Promise<TelemetryPoint[]> {
  const now = new Date();
  const points = await deviceService.getTelemetry(deviceId, {
    from: new Date(now.getTime() - LIVE_WINDOW_MS),
    to: now,
    limit: LIVE_MAX_POINTS,
  });
  return normalizePoints(points, now);
}

/**
 * Live-windowed telemetry for one device: initial 30-minute snapshot, then
 * merged with `telemetry.point` realtime events as they arrive. Mirrors
 * TelemetryLiveNotifier — a per-mount subscription (not the shared
 * query-cache pattern used by devices/shadow/commands), since the
 * windowing/normalizing state itself only makes sense while a dashboard
 * screen for this specific device is open.
 */
export function useTelemetryLive(deviceId: string) {
  const [state, setState] = useState<TelemetrySeriesState>(INITIAL_STATE);

  const refreshSnapshot = useCallback(async () => {
    setState((s) => ({ ...s, refreshing: true, lastError: null }));
    try {
      const normalized = await fetchSnapshot(deviceId);
      setState((s) => ({
        points: normalized,
        latest: latestPoint(normalized),
        initialLoading: false,
        refreshing: false,
        lastError: null,
        lastUpdated: new Date(),
        connection: s.connection,
      }));
    } catch (err) {
      setState((s) => ({ ...s, refreshing: false, lastError: err }));
    }
  }, [deviceId]);

  useEffect(() => {
    let cancelled = false;
    setState(INITIAL_STATE);

    fetchSnapshot(deviceId)
      .then((normalized) => {
        if (cancelled) return;
        setState((s) => ({
          points: normalized,
          latest: latestPoint(normalized),
          initialLoading: false,
          refreshing: false,
          lastError: null,
          lastUpdated: new Date(),
          connection: s.connection,
        }));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState((s) => ({ ...s, initialLoading: false, lastError: err }));
      });

    const unsubscribeEvent = realtimeService.onEvent((event) => {
      if (event.type === 'replay.reset') {
        setState((s) => ({ ...s, connection: 'degraded' }));
        void refreshSnapshot();
        return;
      }
      if (event.deviceId !== deviceId || event.type !== 'telemetry.point') return;
      const point = pointFromEvent(event);
      if (!point) return;
      setState((s) => {
        const points = normalizePoints([...s.points, point]);
        return {
          ...s,
          points,
          latest: latestPoint(points),
          initialLoading: false,
          refreshing: false,
          lastError: null,
          lastUpdated: new Date(),
        };
      });
    });

    const unsubscribeStatus = realtimeService.onStatus((status) => {
      setState((s) => (s.connection === status ? s : { ...s, connection: status }));
    });

    return () => {
      cancelled = true;
      unsubscribeEvent();
      unsubscribeStatus();
    };
  }, [deviceId, refreshSnapshot]);

  return { ...state, refreshSnapshot };
}
