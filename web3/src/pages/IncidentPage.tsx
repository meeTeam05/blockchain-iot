import { useCallback } from 'react'
import { useAccount, useReadContract } from 'wagmi'
import { useNavigate, useParams } from 'react-router'
import { AppBar } from '../components/ui/AppBar'
import { IncidentSummary } from '../blocks/B3/IncidentSummary'
import { VerifyPanel } from '../blocks/B4/VerifyPanel'
import { OwnerActions } from '../blocks/B5/OwnerActions'
import { SessionActions } from '../blocks/B1/SessionActions'
import { activeNetwork } from '../config/networks'
import { AIR_SAFETY_LOG_ABI } from '../generated/incident-deployments'
import { computeDeviceIdHash, computeIncidentKey } from '../lib/chainIncident'
import { useIncidentDetail } from '../lib/incidentsApi'
import { CHAIN_STATUS_NAMES, deriveIncidentStatus } from '../lib/mergeStatus'
import { addressesMatch } from '../lib/ownership'
import { IncidentIncentives } from '../blocks/B9/IncidentIncentives'
import { useIncentiveTransaction } from '../lib/useIncentiveTransaction'
import { SAFETY_INCENTIVES_ABI } from '../generated/incentives-deployments'
import type { IncidentAction } from '../lib/incidentTransaction'

export function IncidentPage() {
  const { deviceId, incidentId } = useParams<{ deviceId: string; incidentId: string }>()
  const navigate = useNavigate()
  const { address, isConnected } = useAccount()
  const { data: incident, isLoading, error, refetch } = useIncidentDetail(deviceId ?? '', incidentId ?? '')

  const deviceIdHash = deviceId ? computeDeviceIdHash(deviceId) : undefined
  const incidentKey = deviceIdHash && incidentId ? computeIncidentKey(deviceIdHash, incidentId as `0x${string}`) : undefined
  const incentivesTx = useIncentiveTransaction(incidentKey ?? 'wallet')
  const afterConfirmed = async (action: IncidentAction) => {
    const { guard, run } = incentivesTx
    if (!guard.canWrite || !incidentKey || !guard.publicClient || !guard.deployment) return
    const read = () => guard.publicClient!.readContract({ address: guard.deployment!.incentives.address,
      abi: SAFETY_INCENTIVES_ABI, functionName: 'pendingSettlement', args: [incidentKey] })
    if ((await read()).canRecordAck) await run('recordTimelyAck', [incidentKey])
    if (action === 'resolveIncident' && (await read()).canRecordResolve) await run('recordTimelyResolve', [incidentKey])
  }

  const { data: chainIncident, isPending: isChainIncidentPending, isError: isChainIncidentError, refetch: refetchChainIncident } = useReadContract({
    address: activeNetwork.address,
    abi: AIR_SAFETY_LOG_ABI,
    functionName: 'getIncident',
    args: incidentKey ? [incidentKey] : undefined,
    query: { enabled: Boolean(incidentKey) },
  })
  const { data: chainDevice, refetch: refetchChainDevice } = useReadContract({
    address: activeNetwork.address,
    abi: AIR_SAFETY_LOG_ABI,
    functionName: 'getDevice',
    args: deviceIdHash ? [deviceIdHash] : undefined,
    query: { enabled: Boolean(deviceIdHash) },
  })

  const readOwnerStatus = useCallback(async () => (await refetch()).data?.owner_status, [refetch])
  const refetchChain = useCallback(async () => {
    await Promise.all([refetchChainIncident(), refetchChainDevice()])
  }, [refetchChainDevice, refetchChainIncident])

  if (!deviceId || !incidentId) return null

  const chainStatus = CHAIN_STATUS_NAMES[chainIncident ? Number(chainIncident.status) : 0]
  const merged = incident
    ? deriveIncidentStatus(
        incident.chain_status,
        isChainIncidentPending ? 'loading' : isChainIncidentError ? 'error' : 'success',
        chainStatus,
      )
    : undefined
  const isOwner = addressesMatch(chainDevice?.owner, address)

  return (
    <>
      <AppBar variant="back" title="Sự cố" actions={<SessionActions />} onBack={() => navigate(`/d/${deviceId}`)} />
      <div className="mx-auto w-full max-w-5xl p-6">
        {isLoading ? <p className="text-ink-2">Đang tải…</p> : null}
        {error ? <p className="text-danger">{error.message}</p> : null}
        {incident ? (
          <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1fr_320px]">
            <div className="flex flex-col gap-4">
              {isChainIncidentError ? (
                <p className="rounded-card border border-line bg-paper p-3 text-[13px] text-ink-2">
                  RPC/chain hiện không khả dụng; trạng thái API bên dưới vẫn được giữ riêng và không bị coi là “None”.
                </p>
              ) : null}
              <IncidentSummary
                deviceId={deviceId}
                incident={incident}
                merged={merged!}
                loggedAt={chainIncident?.loggedAt}
              />
              <VerifyPanel deviceId={deviceId} incident={incident} />
              {incidentKey ? <IncidentIncentives deviceId={deviceId} incidentKey={incidentKey} projection={incident.incentive} transaction={incentivesTx} /> : null}
            </div>
            <div className="flex flex-col gap-3">
              {isOwner ? (
                <div className="flex items-center gap-2 text-[13px] text-ink-2">
                  <span className="rounded-pill bg-ink px-2.5 py-1 text-[11px] font-bold text-brand-bright">BẠN</span>
                  là chủ thiết bị này
                </div>
              ) : null}
              {incidentKey ? (
                <OwnerActions
                  deviceId={deviceId}
                  incidentId={incidentId}
                  incidentKey={incidentKey}
                  chainStatus={chainStatus}
                  isOwner={isOwner}
                  readOwnerStatus={readOwnerStatus}
                  refetchChain={refetchChain}
                  afterConfirmed={afterConfirmed}
                />
              ) : null}
              {!isOwner ? (
                <p className="rounded-card border border-line bg-paper p-4 text-[13px] text-ink-2">
                  {isConnected
                    ? 'Chỉ chủ sở hữu thiết bị mới acknowledge/resolve được sự cố này.'
                    : 'Kết nối ví chủ sở hữu thiết bị để acknowledge/resolve sự cố này.'}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </>
  )
}
