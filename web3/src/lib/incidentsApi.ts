import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useAuth } from './authStore'

export interface ApiIncidentSummary {
  device_id: string
  incident_id: string
  sequence: string
  observed_at: string
  received_at: string | null
  severity: 'warning' | 'danger' | 'critical' | null
  overall_level: string | null
  co_level: string | null
  no2_level: string | null
  verify_status: string
  owner_status: string
  chain_status: string | null
  tx_hash: string | null
}

export interface ApiIncidentDetail extends ApiIncidentSummary {
  observed_at_iso: string | null
  incident_kind: string | null
  time_source: string | null
  sensors: {
    temperature_c: number | null
    humidity_pct: number | null
    co_ppm: number | null
    no2_ppm: number | null
  }
  derived: Record<string, number | null>
  model: Record<string, number | null>
  alarm_sources: Record<string, Record<string, boolean>>
  firmware: { version: string; version_hash: string; model_sha256: string }
  calibration: { revision: number; hash: string; canonical: string; independently_recomputable: boolean }
  evidence: Record<string, string | number>
  evidence_hash: string
  eip712_digest: string
  signature: string
  signer_address: string
  owner_address: string | null
  owner: Record<string, string | null>
  chain: {
    status: string | null
    fail_reason: string | null
    tx_hash: string | null
    attempts: number
    block_number: string | null
    confirmations: number | null
    confirmed_at: string | null
    last_error: string | null
    verifying_contract: string | null
    updated_at: string | null
  }
}

const INCIDENT_PAGE_SIZE = 50

export function incidentPagePath(deviceId: string, beforeSequence: string | null = null) {
  const params = new URLSearchParams({ limit: String(INCIDENT_PAGE_SIZE) })
  if (beforeSequence) params.set('before_sequence', beforeSequence)
  return `/devices/${deviceId}/incidents?${params}`
}

export function useIncidents(deviceId: string) {
  const { accessToken, request } = useAuth()
  return useInfiniteQuery({
    queryKey: ['incidents', deviceId],
    enabled: Boolean(accessToken) && Boolean(deviceId),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }): Promise<ApiIncidentSummary[]> => {
      const res = await request(incidentPagePath(deviceId, pageParam))
      if (!res.ok) throw new Error('Không tải được danh sách sự cố')
      return res.json()
    },
    getNextPageParam: (page) =>
      page.length === INCIDENT_PAGE_SIZE ? page.at(-1)?.sequence : undefined,
  })
}

export function useIncidentDetail(deviceId: string, incidentId: string) {
  const { accessToken, request } = useAuth()
  return useQuery({
    queryKey: ['incident', deviceId, incidentId],
    enabled: Boolean(accessToken) && Boolean(deviceId) && Boolean(incidentId),
    queryFn: async (): Promise<ApiIncidentDetail> => {
      const res = await request(`/devices/${deviceId}/incidents/${incidentId}`)
      if (!res.ok) throw new Error('Không tải được sự cố')
      return res.json()
    },
  })
}
