import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Link } from 'react-router'
import { EmptyState } from '../../components/ui/EmptyState'
import type { PillTone } from '../../components/ui/Pill'
import { incidentTitle, formatIncidentTime, kindFromLevel, severityDisplay } from '../../lib/incidentDisplay'
import { useDeviceIncidents, type IncidentGroup, type IncidentRow } from './useDeviceIncidents'

type Filter = 'all' | IncidentGroup

const STATUS_COLOR: Record<PillTone, string> = {
  danger: '#c81e3a',
  warn: '#b45309',
  online: '#15803d',
  brand: '#15803d',
  accent: '#5d6a60',
  offline: '#5d6a60',
}

const TABLE_GRID = 'grid grid-cols-[120px_minmax(260px,1fr)_50px_120px_110px_190px_16px] items-center gap-4 px-6'

function chainBadge(row: IncidentRow) {
  if (row.chainRead === 'loading') return { label: '…', className: 'bg-[#eef1ec] text-[#4f5b52]' }
  if (row.chainRead === 'error') return { label: 'LỖI ĐỌC', className: 'bg-[#eef1ec] text-[#4f5b52]' }
  return row.onChain
    ? { label: 'ĐÃ GHI', className: 'bg-[#dcf5e3] text-[#15803d]' }
    : { label: 'CHƯA GHI', className: 'bg-[#eef1ec] text-[#4f5b52]' }
}

function IncidentTableRow({ deviceId, row }: { deviceId: string; row: IncidentRow }) {
  const { incident, merged } = row
  const severity = severityDisplay(incident.severity)
  const kind = kindFromLevel(incident.overall_level)
  const chain = chainBadge(row)
  return (
    <Link
      to={`/d/${deviceId}/i/${incident.incident_id}`}
      className={`${TABLE_GRID} border-t border-[#eef1ec] py-4 text-[#17201a] no-underline transition-colors hover:bg-[#f8faf7] hover:text-[#17201a] ${
        row.group === 'open' ? 'bg-[#fffafa]' : 'bg-white'
      }`}
    >
      <span className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: severity.color }}>
        <span className="size-2 rounded-full" style={{ backgroundColor: severity.color }} />
        {severity.label}
      </span>
      <div className="flex min-w-0 flex-col gap-[3px]">
        <div className="text-[14px] font-semibold">{incidentTitle(kind)}</div>
        <div className="overflow-hidden text-ellipsis font-mono text-[12px] font-medium text-[#7a867c]">{kind ?? '—'}</div>
      </div>
      <span className="font-mono text-[13px] font-medium">#{incident.sequence}</span>
      <span className="font-mono text-[13px] font-medium text-[#3d4a40]">{formatIncidentTime(incident.observed_at)}</span>
      <span>
        <span className={`rounded-full px-[9px] py-1 text-[11px] font-bold tracking-[0.04em] ${chain.className}`}>{chain.label}</span>
      </span>
      <span className="text-[13px] font-semibold" style={{ color: STATUS_COLOR[merged.tone] }}>{merged.label}</span>
      <span className="text-[16px] text-[#a3ada5]">›</span>
    </Link>
  )
}

export function IncidentList({ deviceId }: { deviceId: string }) {
  const { rows, isLoading, isError, error, hasNextPage, fetchNextPage, isFetchingNextPage, openCount, doneCount } =
    useDeviceIncidents(deviceId)
  const [filter, setFilter] = useState<Filter>('all')

  if (isLoading) return <p className="m-0 text-[13px] text-[#5d6a60]">Đang tải…</p>
  if (isError) return <p className="m-0 text-[13px] text-[#c81e3a]">{error?.message}</p>

  if (rows.length === 0) {
    return <EmptyState icon={AlertTriangle} title="Chưa có sự cố" body="Thiết bị chưa ghi nhận sự cố nào." />
  }

  const filters: { key: Filter; label: string; count: number }[] = [
    { key: 'all', label: 'Tất cả', count: rows.length },
    { key: 'open', label: 'Đang mở', count: openCount },
    { key: 'done', label: 'Đã xử lý', count: doneCount },
  ]
  const visible = rows.filter((row) => filter === 'all' || row.group === filter)

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {filters.map(({ key, label, count }) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={`h-[34px] cursor-pointer rounded-full px-3.5 text-[13px] font-medium transition-colors ${
              filter === key
                ? 'border border-[#17201a] bg-[#17201a] text-white'
                : 'border border-[#dfe4dc] bg-white text-[#4f5b52] hover:bg-[#f4f6f3]'
            }`}
          >
            {label} · {count}
          </button>
        ))}
      </div>
      <section className="overflow-y-hidden overflow-x-auto rounded-[18px] border border-[#eef1ec] bg-white shadow-[0_1px_2px_rgba(20,40,25,0.05)]">
        <div className="min-w-[980px]">
          <div className={`${TABLE_GRID} bg-[#f6f8f5] py-3 text-[11px] font-bold tracking-[0.06em] text-[#5d6a60]`}>
            <span>MỨC ĐỘ</span>
            <span>SỰ CỐ</span>
            <span>SEQ</span>
            <span>PHÁT HIỆN</span>
            <span>ON-CHAIN</span>
            <span>TRẠNG THÁI</span>
            <span />
          </div>
          {visible.map((row) => (
            <IncidentTableRow key={row.incident.incident_id} deviceId={deviceId} row={row} />
          ))}
          {visible.length === 0 ? (
            <div className="border-t border-[#eef1ec] px-6 py-8 text-center text-[13px] text-[#5d6a60]">
              Không có sự cố nào ở mục này.
            </div>
          ) : null}
        </div>
      </section>
      {hasNextPage ? (
        <button
          type="button"
          disabled={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
          className="h-9 w-fit cursor-pointer rounded-[10px] border border-[#dfe4dc] bg-white px-4 text-[13px] font-semibold text-[#17201a] hover:bg-[#f4f6f3] disabled:opacity-50"
        >
          {isFetchingNextPage ? 'Đang tải…' : 'Tải thêm sự cố'}
        </button>
      ) : null}
    </>
  )
}
