import type { ReactNode } from 'react'
import { Panel, PanelHeader } from '../../components/ui/Panel'
import { ExplorerLink } from '../../components/ExplorerLink'
import type { ApiIncidentDetail } from '../../lib/incidentsApi'

function formatObservedAt(epochSeconds: string) {
  const ms = Number(epochSeconds) * 1000
  if (!Number.isFinite(ms)) return epochSeconds
  return new Date(ms).toLocaleString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

function InfoCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 border-b border-[#f1f3ef] py-3">
      <span className="text-[12px] text-[#5d6a60]">{label}</span>
      <div className="break-all font-mono text-[13px] font-medium text-[#17201a]">{children}</div>
    </div>
  )
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="font-sans text-[13px] font-normal text-[#8a958c]">{children}</span>
}

function HashBox({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[12px] text-[#5d6a60]">{label}</span>
      <div className="break-all rounded-[10px] bg-[#f6f8f5] px-3 py-2.5 font-mono text-[12px] font-medium leading-[1.6] text-[#17201a]">
        {children}
      </div>
    </div>
  )
}

interface MetricProps {
  label: string
  value: number | null
  unit: string
  exceeded?: boolean
  last?: boolean
}

function Metric({ label, value, unit, exceeded = false, last = false }: MetricProps) {
  return (
    <div
      className={`flex flex-col gap-1 px-6 py-[18px] ${last ? '' : 'sm:border-r'} border-[#eef1ec] ${
        exceeded ? 'bg-[#fff6f7]' : ''
      }`}
    >
      <span className={`text-[12px] ${exceeded ? 'font-semibold text-[#a3122e]' : 'text-[#5d6a60]'}`}>
        {label}
        {exceeded ? ' ↑' : ''}
      </span>
      <span className={`text-[22px] font-semibold ${exceeded ? 'text-[#c81e3a]' : 'text-[#17201a]'}`}>
        {value === null || value === undefined ? '—' : String(value)}{' '}
        <span className={`text-[12px] font-medium ${exceeded ? '' : 'text-[#5d6a60]'}`}>{unit}</span>
      </span>
    </div>
  )
}

export function IncidentSummary({
  deviceId,
  incident,
  loggedAt,
}: {
  deviceId: string
  incident: ApiIncidentDetail
  loggedAt?: bigint
}) {
  const coExceeded = Number(incident.sensors.co_ppm) > 9
  const no2Exceeded = Number(incident.sensors.no2_ppm) > 0.1
  const exceededCount = Number(coExceeded) + Number(no2Exceeded)
  const failReason = incident.chain.fail_reason ?? incident.chain.last_error

  return (
    <>
      <Panel>
        <PanelHeader
          title="Chỉ số lúc phát hiện"
          right={
            exceededCount > 0 ? (
              <span className="text-[12px] text-[#5d6a60]">{exceededCount} chỉ số vượt ngưỡng</span>
            ) : null
          }
        />
        <div className="grid grid-cols-2 sm:grid-cols-4">
          <Metric label="Nhiệt độ" value={incident.sensors.temperature_c} unit="°C" />
          <Metric label="Độ ẩm" value={incident.sensors.humidity_pct} unit="%" />
          <Metric label="Khí CO" value={incident.sensors.co_ppm} unit="ppm" exceeded={coExceeded} />
          <Metric label="Khí NO₂" value={incident.sensors.no2_ppm} unit="ppm" exceeded={no2Exceeded} last />
        </div>
      </Panel>

      <Panel>
        <PanelHeader title="Thông tin sự cố" />
        <div className="grid grid-cols-1 gap-x-6 px-6 pb-1 pt-2 sm:grid-cols-[repeat(auto-fit,minmax(180px,1fr))]">
          <InfoCell label="Thiết bị">{deviceId}</InfoCell>
          <InfoCell label="Sequence">#{incident.sequence}</InfoCell>
          <InfoCell label="Loại sự cố">{incident.incident_kind ?? '—'}</InfoCell>
          <InfoCell label="Nguồn thời gian">{incident.time_source ?? '—'}</InfoCell>
          <InfoCell label="Ghi on-chain">
            {loggedAt ? formatObservedAt(loggedAt.toString()) : <Muted>Chưa ghi</Muted>}
          </InfoCell>
          <InfoCell label="Lý do lỗi">{failReason ? failReason : <Muted>Không có</Muted>}</InfoCell>
        </div>
        <div className="grid grid-cols-1 gap-x-6 gap-y-3 px-6 pb-5 pt-3 md:grid-cols-2">
          <HashBox label="Evidence hash">{incident.evidence_hash}</HashBox>
          <HashBox label="Transaction">
            {incident.chain.tx_hash ? (
              <ExplorerLink kind="tx" value={incident.chain.tx_hash} label={incident.chain.tx_hash.slice(0, 14) + '…'} />
            ) : (
              '—'
            )}
          </HashBox>
        </div>
        <details className="group border-t border-[#eef1ec]">
          <summary className="flex cursor-pointer list-none items-center gap-2.5 px-6 py-3.5 text-[13px] font-semibold text-[#17201a] hover:bg-[#f8faf7] [&::-webkit-details-marker]:hidden">
            <span className="text-[#5d6a60] group-open:hidden">▸</span>
            <span className="hidden text-[#5d6a60] group-open:inline">▾</span>
            Dữ liệu đã ký
          </summary>
          <pre className="m-0 max-h-80 overflow-auto whitespace-pre-wrap break-all bg-[#f6f8f5] px-6 pb-5 pt-4 font-mono text-[12px] font-medium leading-[1.7] text-[#3d4a40]">
            {JSON.stringify(
              {
                derived: incident.derived,
                model: incident.model,
                alarm_sources: incident.alarm_sources,
                firmware: incident.firmware,
                calibration: incident.calibration,
              },
              null,
              2,
            )}
          </pre>
        </details>
      </Panel>
    </>
  )
}
