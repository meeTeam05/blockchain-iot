import { AlertTriangle, Check, Settings } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import { HistoryRow } from '../../components/ui/HistoryRow'
import type { PillTone } from '../../components/ui/Pill'
import { computeDeviceIdHash } from '../../lib/chainIncident'
import { chain } from '../../lib/wagmiConfig'
import { fetchDeviceHistory, type HistoryEvent } from './historyLogs'
import { ExplorerLink } from '../../components/ExplorerLink'

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
  return (
    <span className="flex flex-wrap gap-x-2">
      <span>{new Date(Number(event.timestamp) * 1000).toLocaleString('vi-VN')}</span>
      <ExplorerLink kind="block" value={event.blockNumber.toString()} label={`block ${event.blockNumber}`} />
      <ExplorerLink kind="tx" value={event.transactionHash} label={`${event.transactionHash.slice(0, 10)}…`} />
    </span>
  )
}

export function useDeviceHistory(deviceId: string) {
  const publicClient = usePublicClient({ chainId: chain.id })
  const deviceIdHash = computeDeviceIdHash(deviceId)

  return useQuery({
    queryKey: ['device-history', deviceId],
    enabled: Boolean(publicClient),
    queryFn: () => fetchDeviceHistory(publicClient!, deviceIdHash),
    staleTime: 30_000,
  })
}

export function HistoryTimeline({ deviceId }: { deviceId: string }) {
  const { data: events, isLoading, isError, error, refetch } = useDeviceHistory(deviceId)

  if (isLoading) return <p className="m-0 px-6 py-7 text-[13px] text-[#5d6a60]">Đang tải lịch sử on-chain…</p>
  if (isError) {
    return (
      <div className="px-6 py-5 text-[13px] text-[#c81e3a]">
        <p>Không đọc được lịch sử on-chain: {error.message}</p>
        <button type="button" className="mt-2 underline" onClick={() => void refetch()}>Thử lại</button>
      </div>
    )
  }
  if (!events || events.length === 0) {
    return (
      <div className="flex items-center gap-3 px-6 py-7 text-[13px] text-[#5d6a60]">
        <span className="size-2 rounded-full bg-[#c3cbc4]" />
        Thiết bị chưa có giao dịch on-chain.
      </div>
    )
  }

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
