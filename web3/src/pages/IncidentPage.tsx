import { useAccount, useReadContract } from 'wagmi'
import { useNavigate, useParams } from 'react-router'
import { AppBar } from '../components/ui/AppBar'
import { IncidentSummary } from '../blocks/B3/IncidentSummary'
import { VerifyPanel } from '../blocks/B4/VerifyPanel'
import { OwnerActions } from '../blocks/B5/OwnerActions'
import { activeNetwork } from '../config/networks'
import { AIR_SAFETY_LOG_ABI } from '../generated/incident-deployments'
import { computeDeviceIdHash, computeIncidentKey } from '../lib/chainIncident'
import { useIncidentDetail } from '../lib/incidentsApi'
import { CHAIN_STATUS_NAMES } from '../lib/mergeStatus'

export function IncidentPage() {
  const { deviceId, incidentId } = useParams<{ deviceId: string; incidentId: string }>()
  const navigate = useNavigate()
  const { address } = useAccount()
  const { data: incident, isLoading, error, refetch } = useIncidentDetail(deviceId ?? '', incidentId ?? '')

  const deviceIdHash = deviceId ? computeDeviceIdHash(deviceId) : undefined
  const incidentKey = deviceIdHash && incidentId ? computeIncidentKey(deviceIdHash, incidentId as `0x${string}`) : undefined

  const { data: chainIncident } = useReadContract({
    address: activeNetwork.address,
    abi: AIR_SAFETY_LOG_ABI,
    functionName: 'getIncident',
    args: incidentKey ? [incidentKey] : undefined,
    query: { enabled: Boolean(incidentKey) },
  })
  const { data: chainDevice } = useReadContract({
    address: activeNetwork.address,
    abi: AIR_SAFETY_LOG_ABI,
    functionName: 'getDevice',
    args: deviceIdHash ? [deviceIdHash] : undefined,
    query: { enabled: Boolean(deviceIdHash) },
  })

  if (!deviceId || !incidentId) return null

  const chainStatus = CHAIN_STATUS_NAMES[chainIncident ? Number(chainIncident.status) : 0]
  const isOwner = Boolean(address && chainDevice?.owner && chainDevice.owner.toLowerCase() === address.toLowerCase())

  return (
    <>
      <AppBar variant="back" title="Sự cố" onBack={() => navigate(`/d/${deviceId}`)} />
      <div className="mx-auto flex w-full max-w-sm flex-col gap-4 p-6">
        {isLoading ? <p className="text-ink-2">Đang tải…</p> : null}
        {error ? <p className="text-danger">{error.message}</p> : null}
        {incident ? (
          <>
            <IncidentSummary incident={incident} />
            <VerifyPanel deviceId={deviceId} incident={incident} />
            {incidentKey ? (
              <OwnerActions
                incidentKey={incidentKey}
                chainStatus={chainStatus}
                isOwner={isOwner}
                ownerStatus={incident.owner_status}
                onSettled={() => void refetch()}
              />
            ) : null}
          </>
        ) : null}
      </div>
    </>
  )
}
