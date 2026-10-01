import { AlertTriangle, Check, Settings } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import { HistoryRow } from '../../components/ui/HistoryRow'
import type { PillTone } from '../../components/ui/Pill'
import { computeDeviceIdHash } from '../../lib/chainIncident'
import { chain } from '../../lib/wagmiConfig'
import { fetchDeviceHistory, type HistoryEvent } from './historyLogs'

const EVENT_DISPLAY: Record<string, { icon: typeof AlertTriangle; tone: PillTone; label: string }> = {
  DeviceRegistered: { icon: Settings, tone: 'brand', label: 'Đăng ký thiết bị' },
  DeviceSignerRotated: { icon: Settings, tone: 'warn', label: 'Đổi signer' },
  DeviceRevoked: { icon: Settings, tone: 'danger', label: 'Thu hồi thiết bị' },
  DeviceOwnerChanged: { icon: Settings, tone: 'accent', label: 'Đổi owner' },
  IncidentLogged: { icon: AlertTriangle, tone: 'danger', label: 'Ghi sự cố lên chain' },
  IncidentAcknowledged: { icon: Check, tone: 'warn', label: 'Xác nhận sự cố' },
  IncidentResolved: { icon: Check, tone: 'online', label: 'Xử lý xong sự cố' },
}

function eventSub(event: HistoryEvent) {
  return `block ${event.blockNumber} · ${event.transactionHash.slice(0, 10)}…`
}

export function HistoryTimeline({ deviceId }: { deviceId: string }) {
  const publicClient = usePublicClient({ chainId: chain.id })
  const deviceIdHash = computeDeviceIdHash(deviceId)

  const { data: events, isLoading } = useQuery({
    queryKey: ['device-history', deviceId],
    enabled: Boolean(publicClient),
    queryFn: () => fetchDeviceHistory(publicClient!, deviceIdHash),
  })

  if (isLoading) return <p className="text-ink-2">Đang tải lịch sử on-chain…</p>
  if (!events || events.length === 0) return <p className="text-ink-2">Chưa có lịch sử on-chain cho thiết bị này.</p>

  return (
    <div className="flex flex-col divide-y divide-line">
      {events.map((event, i) => {
        const display = EVENT_DISPLAY[event.eventName] ?? { icon: Settings, tone: 'offline' as PillTone, label: event.eventName }
        return (
          <HistoryRow
            key={`${event.transactionHash}-${i}`}
            icon={display.icon}
            label={display.label}
            sub={eventSub(event)}
            badgeTone={display.tone}
            badgeLabel={event.eventName}
          />
        )
      })}
    </div>
  )
}
