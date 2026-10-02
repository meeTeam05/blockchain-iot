import { useQuery } from '@tanstack/react-query'
import { apiBaseUrl } from '../config/networks'
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
  evidence: Record<string, string | number>
  evidence_hash: string
  signer_address: string
  owner_address: string | null
  chain: {
    status: string | null
    fail_reason: string | null
    tx_hash: string | null
  }
}

export function useIncidents(deviceId: string) {
  const { accessToken } = useAuth()
  return useQuery({
    queryKey: ['incidents', deviceId],
    enabled: Boolean(accessToken) && Boolean(deviceId),
    queryFn: async (): Promise<ApiIncidentSummary[]> => {
      const res = await fetch(`${apiBaseUrl}/devices/${deviceId}/incidents`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) throw new Error('Không tải được danh sách sự cố')
      return res.json()
    },
  })
}

export function useIncidentDetail(deviceId: string, incidentId: string) {
  const { accessToken } = useAuth()
  return useQuery({
    queryKey: ['incident', deviceId, incidentId],
    enabled: Boolean(accessToken) && Boolean(deviceId) && Boolean(incidentId),
    queryFn: async (): Promise<ApiIncidentDetail> => {
      const res = await fetch(`${apiBaseUrl}/devices/${deviceId}/incidents/${incidentId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      if (!res.ok) throw new Error('Không tải được sự cố')
      return res.json()
    },
  })
}
