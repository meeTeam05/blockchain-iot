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
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {incident.severity ? <Pill tone={incident.severity === 'warning' ? 'warn' : 'danger'} label={incident.severity} /> : null}
        <Pill tone={merged.tone} label={merged.label} />
        <span className="text-[13px] text-ink-3">sequence {incident.sequence}</span>
      </div>
      <div className="flex flex-col divide-y divide-line sm:flex-row sm:divide-x sm:divide-y-0">
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
      <div className="grid grid-cols-2 gap-3 border-t border-line pt-3 text-[12px] sm:grid-cols-4">
        <MetaColumn label="Temperature">{valueOrDash(incident.sensors.temperature_c, ' °C')}</MetaColumn>
        <MetaColumn label="Humidity">{valueOrDash(incident.sensors.humidity_pct, ' %')}</MetaColumn>
        <MetaColumn label="CO">{valueOrDash(incident.sensors.co_ppm, ' ppm')}</MetaColumn>
        <MetaColumn label="NO₂">{valueOrDash(incident.sensors.no2_ppm, ' ppm')}</MetaColumn>
        <MetaColumn label="Kind">{valueOrDash(incident.incident_kind)}</MetaColumn>
        <MetaColumn label="Time source">{valueOrDash(incident.time_source)}</MetaColumn>
        <MetaColumn label="Logged on-chain">{loggedAt ? formatObservedAt(loggedAt.toString()) : '—'}</MetaColumn>
        <MetaColumn label="Fail reason">{valueOrDash(incident.chain.fail_reason ?? incident.chain.last_error)}</MetaColumn>
      </div>
      <details className="border-t border-line pt-3 text-[12px] text-ink-2">
        <summary className="cursor-pointer font-semibold text-ink">Chi tiết dữ liệu đã ký</summary>
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-canvas p-3 font-mono text-[11px]">
          {JSON.stringify({
            derived: incident.derived,
            model: incident.model,
            alarm_sources: incident.alarm_sources,
            firmware: incident.firmware,
            calibration: incident.calibration,
          }, null, 2)}
        </pre>
      </details>
    </Card>
  )
}
