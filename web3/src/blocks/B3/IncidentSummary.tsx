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

export function IncidentSummary({ deviceId, incident, merged }: { deviceId: string; incident: ApiIncidentDetail; merged: MergedStatus }) {
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
    </Card>
  )
}
