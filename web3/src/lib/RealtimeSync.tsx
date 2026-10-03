import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from './authStore'
import { isIncidentRealtimeEvent, RealtimeClient, RealtimeRefreshCoordinator } from './realtime'

export function RealtimeSync() {
  const { request } = useAuth()
  const queryClient = useQueryClient()

  useEffect(() => {
    const refresh = () => {
      void queryClient.invalidateQueries({ refetchType: 'active' })
    }
    const coordinator = new RealtimeRefreshCoordinator(refresh)
    const client = new RealtimeClient((lastEventId, signal) => {
      const headers = new Headers({ Accept: 'text/event-stream' })
      if (lastEventId) headers.set('Last-Event-ID', lastEventId)
      return request('/realtime', { headers, signal })
    })
    const offStatus = client.onStatus((status) => coordinator.setStatus(status))
    const offEvent = client.onEvent((event) => {
      if (isIncidentRealtimeEvent(event)) {
        coordinator.onRelevantEvent()
      }
    })
    client.start()
    return () => {
      offStatus()
      offEvent()
      client.stop()
      coordinator.dispose()
    }
  }, [queryClient, request])

  return null
}
