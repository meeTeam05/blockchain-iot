import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useAccount, useReadContract } from 'wagmi'
import { PageShell } from '../components/ui/PageShell'
import { Badge, Panel, PanelHeader } from '../components/ui/Panel'
import { IncidentList } from '../blocks/B3/IncidentList'
import { useDeviceIncidents } from '../blocks/B3/useDeviceIncidents'
import { HistoryTimeline, useDeviceHistory } from '../blocks/B6/HistoryTimeline'
import { SessionActions } from '../blocks/B1/SessionActions'
import { activeNetwork } from '../config/networks'
import { AIR_SAFETY_LOG_ABI } from '../generated/incident-deployments'
import { computeDeviceIdHash } from '../lib/chainIncident'
import { useDevices } from '../lib/devicesApi'
import { formatRelativeTime } from '../lib/deviceDisplay'
import { addressesMatch } from '../lib/ownership'

type Tab = 'incidents' | 'history'

function Kpi({ label, value, className = '' }: { label: string; value: string; className?: string }) {
  return (
    <div className={`flex flex-col gap-1 px-[22px] py-3.5 ${className}`}>
      <span className="text-[12px] text-[#5d6a60]">{label}</span>
      <span className="text-[22px] font-bold">{value}</span>
    </div>
  )
}

export function DevicePage() {
  const { deviceId = '' } = useParams<{ deviceId: string }>()
  const navigate = useNavigate()
  const { address } = useAccount()
  const { data: devices } = useDevices()
  const [tab, setTab] = useState<Tab>('incidents')
  const incidents = useDeviceIncidents(deviceId)
  const history = useDeviceHistory(deviceId)
  const { data: chainDevice } = useReadContract({
    address: activeNetwork.address,
    abi: AIR_SAFETY_LOG_ABI,
    functionName: 'getDevice',
    args: [computeDeviceIdHash(deviceId)],
    query: { enabled: Boolean(deviceId) },
  })

  if (!deviceId) return null

  const device = devices?.find((d) => d.id === deviceId)
  const deviceName = device?.name ?? deviceId
  const isOwner = addressesMatch(chainDevice?.owner, address)
  const more = incidents.hasNextPage ? '+' : ''
  const tabs: { key: Tab; label: string; count: string | undefined }[] = [
    { key: 'incidents', label: 'Sự cố', count: incidents.isLoading ? undefined : `${incidents.rows.length}${more}` },
    { key: 'history', label: 'Lịch sử on-chain', count: history.data ? String(history.data.length) : undefined },
  ]

  return (
    <PageShell actions={<SessionActions />}>
      <div className="flex flex-wrap items-start gap-4">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-xl border border-[#dfe4dc] bg-white text-[18px] text-[#17201a] transition-colors hover:bg-[#f4f6f3]"
          aria-label="Quay lại danh sách thiết bị"
        >
          ←
        </button>
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-2">
          <nav className="flex flex-wrap items-center gap-1.5 text-[13px] text-[#5d6a60]" aria-label="Breadcrumb">
            <Link to="/" className="text-[#5d6a60] no-underline hover:text-[#17201a]">Thiết bị</Link>
            <span>/</span>
            <span className="font-semibold text-[#17201a]">{deviceName}</span>
          </nav>
          <h1 className="m-0 text-[26px] font-bold tracking-[-0.01em] text-[#17201a]">{deviceName}</h1>
          <div className="flex flex-wrap items-center gap-2">
            {device ? <Badge label={device.online ? 'Online' : 'Offline'} tone={device.online ? 'green' : 'grey'} /> : null}
            {chainDevice ? (
              !chainDevice.exists ? (
                <Badge label="Chờ đăng ký on-chain" tone="amber" />
              ) : (
                <>
                  <Badge label={chainDevice.active ? 'Active' : 'Revoked'} tone={chainDevice.active ? 'green' : 'red'} />
                  {isOwner ? <Badge label="Bạn là chủ" tone="cyan" /> : null}
                </>
              )
            ) : null}
            <span className="break-all font-mono text-[12px] font-medium text-[#5d6a60]">
              {deviceId}
              {device ? ` · ${device.online ? 'đang hoạt động' : `online ${formatRelativeTime(device.last_seen)}`}` : ''}
            </span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-5">
        <div className="flex min-w-0 flex-[999_1_640px] flex-col gap-4">
          <div className="flex gap-1 border-b border-[#d6dcd3]">
            {tabs.map(({ key, label, count }) => {
              const on = tab === key
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setTab(key)}
                  className={`-mb-px flex h-11 cursor-pointer items-center gap-2 border-0 border-b-2 bg-transparent px-3.5 text-[14px] font-semibold ${
                    on ? 'border-[#16803c] text-[#16803c]' : 'border-transparent text-[#5d6a60]'
                  }`}
                >
                  {label}
                  {count !== undefined ? (
                    <span className={`rounded-full px-2 py-px text-[12px] ${on ? 'bg-[#dcf5e3]' : 'bg-[#e3e8e1]'}`}>{count}</span>
                  ) : null}
                </button>
              )
            })}
          </div>
          {tab === 'incidents' ? (
            <IncidentList deviceId={deviceId} />
          ) : (
            <Panel>
              <PanelHeader title="Lịch sử on-chain" />
              <HistoryTimeline deviceId={deviceId} />
            </Panel>
          )}
        </div>
        <aside className="flex min-w-0 max-w-full flex-[1_1_340px] flex-col gap-5">
          <Panel>
            <PanelHeader title="Tổng quan sự cố" />
            <div className="grid grid-cols-2">
              <Kpi label="Đang mở" value={`${incidents.openCount}${more}`} className={`border-r border-[#eef1ec] ${incidents.openCount > 0 ? 'text-[#c81e3a]' : ''}`} />
              <Kpi label="Đã xử lý" value={`${incidents.doneCount}${more}`} />
            </div>
          </Panel>
        </aside>
      </div>
    </PageShell>
  )
}
