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
