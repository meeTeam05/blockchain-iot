import type { ReactNode } from 'react'
import { Card } from '../../components/ui/Card'
import { Pill } from '../../components/ui/Pill'
import { ExplorerLink } from '../../components/ExplorerLink'
import type { ApiIncidentDetail } from '../../lib/incidentsApi'
import type { MergedStatus } from '../../lib/mergeStatus'

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

interface MetaColumnProps {
  label: string
  children: ReactNode
}

function MetaColumn({ label, children }: MetaColumnProps) {
  return (
    <div className="min-w-0 flex-1 px-4 py-3 first:pl-0 last:pr-0">
      <p className="text-[11px] font-medium tracking-wide text-ink-3 uppercase">{label}</p>
      <div className="mt-0.5 break-all font-mono text-[13px] text-ink">{children}</div>
    </div>
  )
}

function valueOrDash(value: unknown, suffix = '') {
  return value === null || value === undefined || value === '' ? '—' : `${String(value)}${suffix}`
}

export function IncidentSummary({
  deviceId,
  incident,
  merged,
  loggedAt,
}: {
  deviceId: string
  incident: ApiIncidentDetail
  merged: MergedStatus
  loggedAt?: bigint
}) {
  const isDanger = incident.severity === 'danger' || incident.severity === 'critical'
  const isWarning = incident.severity === 'warning'

  return (
    <Card elevated className="flex flex-col gap-4 overflow-hidden border-line">
      {/* Header bar: Severity, Status & Sequence */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-2 pb-3.5">
        <div className="flex flex-wrap items-center gap-2">
          {incident.severity ? (
            <span
              className={`inline-flex items-center gap-1.5 rounded-pill px-3 py-1 text-[12px] font-semibold ${
                isDanger
                  ? 'bg-danger-tint text-danger'
                  : isWarning
                    ? 'bg-warn-tint text-warn'
                    : 'bg-line-2 text-ink-2'
              }`}
            >
              <span
                className={`size-2 rounded-full ${
                  isDanger ? 'bg-danger-bright animate-pulse' : isWarning ? 'bg-warn' : 'bg-ink-3'
                }`}
              />
              {isDanger ? '● Nguy hiểm' : isWarning ? '● Cảnh báo' : incident.severity}
            </span>
          ) : null}
          <Pill tone={merged.tone} label={merged.label} />
        </div>
        <span className="font-mono text-[12px] font-medium text-ink-3">
          sequence <span className="text-ink font-semibold">#{incident.sequence}</span>
        </span>
      </div>

      {/* 4 Core metadata columns */}
      <div className="grid grid-cols-1 divide-y divide-line-2 rounded-xl bg-canvas p-2 sm:grid-cols-4 sm:divide-x sm:divide-y-0">
        <MetaColumn label="Device">{deviceId}</MetaColumn>
        <MetaColumn label="Detected">{formatObservedAt(incident.observed_at)}</MetaColumn>
        <MetaColumn label="Evidence">{incident.evidence_hash}</MetaColumn>
        <MetaColumn label="Tx">
          {incident.chain.tx_hash ? (
            <ExplorerLink kind="tx" value={incident.chain.tx_hash} label={incident.chain.tx_hash.slice(0, 14) + '…'} />
          ) : (
            '—'
          )}
        </MetaColumn>
      </div>

      {/* Sensor readings as prominent metric cards */}
      <div>
        <p className="mb-2 text-[11px] font-bold tracking-wider text-ink-3 uppercase">Chỉ số cảm biến môi trường</p>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <div className="rounded-xl border border-line-2 bg-paper p-3 shadow-xs">
            <span className="text-[11px] font-medium text-ink-3">Nhiệt độ</span>
            <div className="mt-1 font-mono text-[16px] font-semibold text-ink">
              {valueOrDash(incident.sensors.temperature_c, ' °C')}
            </div>
          </div>
          <div className="rounded-xl border border-line-2 bg-paper p-3 shadow-xs">
            <span className="text-[11px] font-medium text-ink-3">Độ ẩm</span>
            <div className="mt-1 font-mono text-[16px] font-semibold text-ink">
              {valueOrDash(incident.sensors.humidity_pct, ' %')}
            </div>
          </div>
          <div
            className={`rounded-xl border p-3 shadow-xs ${
              Number(incident.sensors.co_ppm) > 9
                ? 'border-danger-bright/30 bg-danger-tint/30 text-danger'
                : 'border-line-2 bg-paper text-ink'
            }`}
          >
            <span className="text-[11px] font-medium text-ink-3">Khí CO</span>
            <div className="mt-1 font-mono text-[16px] font-semibold">
              {valueOrDash(incident.sensors.co_ppm, ' ppm')}
            </div>
          </div>
          <div
            className={`rounded-xl border p-3 shadow-xs ${
              Number(incident.sensors.no2_ppm) > 0.1
                ? 'border-danger-bright/30 bg-danger-tint/30 text-danger'
                : 'border-line-2 bg-paper text-ink'
            }`}
          >
            <span className="text-[11px] font-medium text-ink-3">Khí NO₂</span>
            <div className="mt-1 font-mono text-[16px] font-semibold">
              {valueOrDash(incident.sensors.no2_ppm, ' ppm')}
            </div>
          </div>
        </div>
      </div>

      {/* Extended metadata */}
      <div className="grid grid-cols-2 gap-3 border-t border-line-2 pt-3 text-[12px] sm:grid-cols-4">
        <MetaColumn label="Kind">{valueOrDash(incident.incident_kind)}</MetaColumn>
        <MetaColumn label="Time source">{valueOrDash(incident.time_source)}</MetaColumn>
        <MetaColumn label="Logged on-chain">{loggedAt ? formatObservedAt(loggedAt.toString()) : '—'}</MetaColumn>
        <MetaColumn label="Fail reason">{valueOrDash(incident.chain.fail_reason ?? incident.chain.last_error)}</MetaColumn>
      </div>

      {/* Signed payload JSON inspection */}
      <details className="border-t border-line-2 pt-3 text-[12px] text-ink-2">
        <summary className="cursor-pointer select-none font-semibold text-ink hover:text-brand">
          Chi tiết dữ liệu đã ký (Signed payload)
        </summary>
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-line-2 bg-canvas p-3 font-mono text-[11px] text-ink-2">
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
    </Card>
  )
}
