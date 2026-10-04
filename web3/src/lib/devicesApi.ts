import { useQuery } from '@tanstack/react-query'
import { useAuth } from './authStore'

export interface ApiDevice {
  id: string
  name: string
  home_id: string
  room_id: string | null
  online: boolean
  last_seen: string | null
  firmware_ver: string | null
  created_at: string
  mode: string | null
  relay_1: boolean | null
  relay_2: boolean | null
  relay_3: boolean | null
  // Added by decision #10 (tmp/02_decisions/...) -- optional until that
  // backend change lands, so B2 degrades gracefully without it.
  open_incident_count?: number
}

export function useDevices() {
  const { accessToken, request } = useAuth()
  return useQuery({
    queryKey: ['devices'],
    enabled: Boolean(accessToken),
    queryFn: async (): Promise<ApiDevice[]> => {
      const res = await request('/devices')
      if (!res.ok) throw new Error('Không tải được danh sách thiết bị')
      return res.json()
    },
  })
}

// Latest row of GET /devices/:id/telemetry (newest first). The kit measures
// temperature, humidity, CO and NO2; any field can be null.
export interface TelemetryPoint {
  ts: string
  temperature: number | null
  humidity: number | null
  co_ppm: number | null
  no2_ppm: number | null
}

export const TELEMETRY_POLL_MS = 30_000

export const telemetryQueryKey = (deviceId: string) => ['device-telemetry', deviceId] as const

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Shapes a `telemetry.point` SSE payload like a telemetry API row. */
export function telemetryPointFromEvent(payload: Record<string, unknown>): TelemetryPoint | null {
  if (typeof payload.ts !== 'string') return null
  return {
    ts: payload.ts,
    temperature: numberOrNull(payload.temperature),
    humidity: numberOrNull(payload.humidity),
    co_ppm: numberOrNull(payload.co_ppm),
    no2_ppm: numberOrNull(payload.no2_ppm),
  }
}

/** Polls only while `enabled` (the device is online); SSE pushes fill it in between. */
export function useLatestTelemetry(deviceId: string, enabled: boolean) {
  const { accessToken, request } = useAuth()
  return useQuery({
    queryKey: telemetryQueryKey(deviceId),
    enabled: Boolean(accessToken) && enabled,
    refetchInterval: TELEMETRY_POLL_MS,
    queryFn: async (): Promise<TelemetryPoint | null> => {
      const res = await request(`/devices/${encodeURIComponent(deviceId)}/telemetry?limit=1`)
      if (!res.ok) throw new Error('Không tải được dữ liệu cảm biến')
      const rows = (await res.json()) as TelemetryPoint[]
      return rows[0] ?? null
    },
  })
}
