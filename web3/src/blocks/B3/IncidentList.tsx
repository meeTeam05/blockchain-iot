import { AlertTriangle } from 'lucide-react'
import { Link } from 'react-router'
import { useReadContracts } from 'wagmi'
import { Card } from '../../components/ui/Card'
import { EmptyState } from '../../components/ui/EmptyState'
import { Pill } from '../../components/ui/Pill'
import { activeNetwork } from '../../config/networks'
import { AIR_SAFETY_LOG_ABI } from '../../generated/incident-deployments'
import { computeDeviceIdHash, computeIncidentKey } from '../../lib/chainIncident'
import { useIncidents } from '../../lib/incidentsApi'
import { CHAIN_STATUS_NAMES, mergeIncidentStatus } from '../../lib/mergeStatus'

const SEVERITY_TONE = { warning: 'warn', danger: 'danger', critical: 'danger' } as const

export function IncidentList({ deviceId }: { deviceId: string }) {
  const { data: incidents, isLoading } = useIncidents(deviceId)
  const deviceIdHash = computeDeviceIdHash(deviceId)

  const contracts = (incidents ?? []).map((i) => ({
    address: activeNetwork.address,
    abi: AIR_SAFETY_LOG_ABI,
    functionName: 'getIncident' as const,
    args: [computeIncidentKey(deviceIdHash, i.incident_id as `0x${string}`)] as const,
  }))
  const { data: chainResults } = useReadContracts({ contracts, query: { enabled: contracts.length > 0 } })

  if (isLoading) return <p className="text-ink-2">Đang tải…</p>

  if (!incidents || incidents.length === 0) {
    return <EmptyState icon={AlertTriangle} title="Chưa có sự cố" body="Thiết bị chưa ghi nhận sự cố nào." />
  }

  return (
    <div className="flex flex-col gap-2">
      {incidents.map((incident, i) => {
        const chainStatusIndex = chainResults?.[i]?.status === 'success' ? Number(chainResults[i].result.status) : 0
        const chainStatusName = CHAIN_STATUS_NAMES[chainStatusIndex] ?? 'None'
        const merged = mergeIncidentStatus(incident.chain_status, chainStatusName)
        const severityTone = incident.severity ? SEVERITY_TONE[incident.severity] : 'offline'

        return (
          <Link key={incident.incident_id} to={`/d/${deviceId}/i/${incident.incident_id}`}>
            <Card className="flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  {incident.severity ? <Pill tone={severityTone} label={incident.severity} /> : null}
                  <Pill tone={merged.tone} label={merged.label} />
                </div>
                <p className="mt-1 text-[13px] text-ink-3">sequence {incident.sequence}</p>
              </div>
            </Card>
          </Link>
        )
      })}
    </div>
  )
}
