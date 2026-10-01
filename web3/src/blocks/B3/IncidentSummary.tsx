import { Card } from '../../components/ui/Card'
import { Pill } from '../../components/ui/Pill'
import { ExplorerLink } from '../../components/ExplorerLink'
import type { ApiIncidentDetail } from '../../lib/incidentsApi'

export function IncidentSummary({ incident }: { incident: ApiIncidentDetail }) {
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {incident.severity ? <Pill tone={incident.severity === 'warning' ? 'warn' : 'danger'} label={incident.severity} /> : null}
        <span className="text-[13px] text-ink-3">sequence {incident.sequence}</span>
      </div>
      <p className="text-[13px] text-ink-2">Phát hiện lúc: {incident.observed_at}</p>
      <p className="font-mono text-[12px] text-ink-3">evidenceHash {incident.evidence_hash}</p>
      {incident.chain.tx_hash ? (
        <p className="text-[13px]">
          tx <ExplorerLink kind="tx" value={incident.chain.tx_hash} label={incident.chain.tx_hash.slice(0, 14) + '…'} />
        </p>
      ) : null}
    </Card>
  )
}
