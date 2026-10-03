import { useCallback } from 'react'
import { useAccount, useReadContract } from 'wagmi'
import { Link, useNavigate, useParams } from 'react-router'
import { Badge, Panel, PanelHeader } from '../components/ui/Panel'
import { PageShell } from '../components/ui/PageShell'
import { IncidentSummary } from '../blocks/B3/IncidentSummary'
import { VerifyPanel } from '../blocks/B4/VerifyPanel'
import { HistoryTimeline } from '../blocks/B6/HistoryTimeline'
import { OwnerActions } from '../blocks/B5/OwnerActions'
import { SessionActions } from '../blocks/B1/SessionActions'
import { activeNetwork } from '../config/networks'
import { AIR_SAFETY_LOG_ABI } from '../generated/incident-deployments'
import { computeDeviceIdHash, computeIncidentKey } from '../lib/chainIncident'
import { useDevices } from '../lib/devicesApi'
import { formatIncidentTime, incidentTitle, severityDisplay } from '../lib/incidentDisplay'
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
  const { data: devices } = useDevices()

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

  const deviceName = devices?.find((d) => d.id === deviceId)?.name ?? deviceId
  const severity = severityDisplay(incident?.severity ?? null)
  const onChain = chainStatus !== 'None'

  return (
    <PageShell actions={<SessionActions />}>
      {isLoading ? <p className="m-0 text-[#5d6a60]">Đang tải…</p> : null}
      {error ? <p className="m-0 text-[#c81e3a]">{error.message}</p> : null}
      {incident ? (
        <>
          <div className="flex flex-wrap items-start gap-4">
            <button
              type="button"
              onClick={() => navigate(`/d/${deviceId}`)}
              className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-xl border border-[#dfe4dc] bg-white text-[18px] text-[#17201a] transition-colors hover:bg-[#f4f6f3]"
              aria-label="Quay lại thiết bị"
            >
              ←
            </button>
            <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-2">
              <nav className="flex flex-wrap items-center gap-1.5 text-[13px] text-[#5d6a60]" aria-label="Breadcrumb">
                <Link to="/" className="text-[#5d6a60] no-underline hover:text-[#17201a]">Thiết bị</Link>
                <span>/</span>
                <Link to={`/d/${deviceId}`} className="text-[#5d6a60] no-underline hover:text-[#17201a]">{deviceName}</Link>
                <span>/</span>
                <span className="font-semibold text-[#17201a]">Sự cố #{incident.sequence}</span>
              </nav>
              <h1 className="m-0 text-[26px] font-bold tracking-[-0.01em] text-[#17201a] [text-wrap:pretty]">
                {incidentTitle(incident.incident_kind)}
              </h1>
              <div className="flex flex-wrap items-center gap-2">
                <Badge label={chainStatus === 'Resolved' ? 'Đã xử lý' : 'Đang mở'} tone={chainStatus === 'Resolved' ? 'green' : 'red'} />
                <Badge label={severity.label} tone={severity.badgeTone} />
                {onChain ? (
                  <Badge label="Đã ghi on-chain" tone="green" />
                ) : (
                  <Badge label={merged!.label === 'Chưa có trên chain' ? 'Chưa ghi on-chain' : merged!.label} tone={merged!.tone === 'danger' ? 'red' : 'grey'} />
                )}
                <span className="text-[13px] text-[#5d6a60]">Phát hiện {formatIncidentTime(incident.observed_at, true)}</span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-start gap-5">
            <div className="flex min-w-0 flex-[999_1_640px] flex-col gap-5">
              {isChainIncidentError ? (
                <p className="m-0 rounded-[10px] bg-[#fdf4dc] px-3 py-2.5 text-[13px] text-[#7a4f00]">
                  RPC/chain hiện không khả dụng; trạng thái API bên dưới vẫn được giữ riêng và không bị coi là “None”.
                </p>
              ) : null}
              <IncidentSummary deviceId={deviceId} incident={incident} loggedAt={chainIncident?.loggedAt} />
              <VerifyPanel deviceId={deviceId} incident={incident} />
              <Panel>
                <PanelHeader title="Lịch sử on-chain" />
                <HistoryTimeline deviceId={deviceId} />
              </Panel>
            </div>

            <aside className="flex min-w-0 max-w-full flex-[1_1_340px] flex-col gap-5">
              {isOwner ? (
                <div className="flex items-center gap-2 rounded-2xl border border-brand-bright/30 bg-brand-tint/60 px-4 py-2.5 text-[13px] text-brand">
                  <span className="rounded-pill bg-ink px-2.5 py-0.5 text-[11px] font-bold text-brand-bright">BẠN</span>
                  <span className="font-semibold">là chủ thiết bị này</span>
                </div>
              ) : null}

              {incidentKey ? (
                <IncidentIncentives
                  deviceId={deviceId}
                  incidentKey={incidentKey}
                  projection={incident.incentive}
                  transaction={incentivesTx}
                  resolved={chainStatus === 'Resolved'}
                  actions={
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
                  }
                  footer={
                    <Link to="/wallet" className="text-[13px] font-semibold text-[#16803c] no-underline hover:text-[#0f5f2c]">
                      Xem bond &amp; thưởng phạt thiết bị →
                    </Link>
                  }
                  note={
                    !isOwner ? (
                      <p className="m-0 text-[13px] text-[#5d6a60]">
                        {isConnected
                          ? 'Chỉ chủ thiết bị được thao tác.'
                          : 'Kết nối ví chủ sở hữu thiết bị để thao tác.'}
                      </p>
                    ) : null
                  }
                />
              ) : null}
            </aside>
          </div>
        </>
      ) : null}
    </PageShell>
  )
}
