import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useAuth } from './authStore'
import { setRealtimeLive } from './chainPolling'
import { newerTelemetry, telemetryPointFromEvent, telemetryQueryKey, type TelemetryPoint } from './devicesApi'
import { isIncidentRealtimeEvent, RealtimeClient, RealtimeRefreshCoordinator } from './realtime'

export function RealtimeSync() {
  const { request } = useAuth()
  const queryClient = useQueryClient()

  useEffect(() => {
    const refresh = () => {
      // Deployment guards and other one-shot chain reads carry meta.static and
      // are not re-read on every event.
      void queryClient.invalidateQueries({ refetchType: 'active', predicate: (query) => !query.meta?.static })
    }
    const coordinator = new RealtimeRefreshCoordinator(refresh)
    const client = new RealtimeClient((lastEventId, signal) => {
      const headers = new Headers({ Accept: 'text/event-stream' })
      if (lastEventId) headers.set('Last-Event-ID', lastEventId)
      return request('/realtime', { headers, signal })
    })
    const offStatus = client.onStatus((status) => {
      coordinator.setStatus(status)
      setRealtimeLive(status === 'connected')
    })
    const offEvent = client.onEvent((event) => {
      // Telemetry carries the readings: write them straight into the card's cache.
      if (event.type === 'telemetry.point') {
        const point = telemetryPointFromEvent(event.payload)
        if (point) {
          queryClient.setQueryData<TelemetryPoint | null>(telemetryQueryKey(event.deviceId), (current) => newerTelemetry(current, point))
        }
        return
      }
      if (event.type === 'device.status') {
        void queryClient.invalidateQueries({ queryKey: ['devices'] })
        return
      }
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
      setRealtimeLive(false)
    }
  }, [queryClient, request])

  return null
}
