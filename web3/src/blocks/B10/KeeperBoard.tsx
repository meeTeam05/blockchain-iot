import { useQuery } from '@tanstack/react-query'
import { formatUnits, parseAbiItem, type PublicClient } from 'viem'
import { activeNetwork } from '../../config/networks'
import { SAFETY_INCENTIVES_ABI } from '../../generated/incentives-deployments'
import { AIR_SAFETY_LOG_ABI } from '../../generated/incident-deployments'
import { useIncentivesApi, type OverdueIncentives, type OverdueItem } from '../../lib/incentivesApi'
import { useIncentivesGuard, useSettlement, useTokenWallet } from '../../lib/useIncentives'
import { useIncentiveTransaction } from '../../lib/useIncentiveTransaction'
import { CHAIN_POLL_MS, SETTLEMENT_POLL_MS } from '../../lib/chainPolling'
import { isTransactionBusy } from '../../lib/incidentTransaction'
import type { IncentivesDeployment } from '../../lib/incentives'
import { ActionButton } from '../../components/ui/ActionButton'
import { Panel, PanelHeader } from '../../components/ui/Panel'
import { formatIncidentTime, severityDisplay } from '../../lib/incidentDisplay'
import { IncentivesGuardNotice, IncentiveTxStatus, NoticeBanner } from '../B7/IncentivesShared'

// API unavailable: use the canonical incident log, in the same bounded RPC chunks
// as Task 5 history. Never fabricate candidates from a failed RPC response.
type KeeperCandidate = Pick<OverdueItem, 'incident_key' | 'device_id_hash' | 'severity' | 'logged_at'>
async function scanOverdue(client: PublicClient, deployment: IncentivesDeployment) {
  const head = await client.getBlockNumber()
  const keys = new Set<`0x${string}`>()
  for (let from = BigInt(activeNetwork.blockNumber); from <= head; from += 2000n) {
    const logs = await client.getLogs({ address: deployment.airSafetyLog,
      event: parseAbiItem('event IncidentLogged(bytes32 indexed incidentKey, bytes32 indexed deviceIdHash, bytes32 indexed incidentId, uint64 sequence, uint64 observedAt, uint8 severity, bytes32 evidenceHash, address signer)'),
      fromBlock: from, toBlock: from + 1999n < head ? from + 1999n : head })
    for (const log of logs) if (log.args.incidentKey) keys.add(log.args.incidentKey)
  }
  const result: { slash_missed_ack: KeeperCandidate[]; slash_late_relay: KeeperCandidate[] } = { slash_missed_ack: [], slash_late_relay: [] }
  for (const key of keys) {
    const s = await client.readContract({ address: deployment.incentives.address, abi: SAFETY_INCENTIVES_ABI, functionName: 'pendingSettlement', args: [key] })
    const row: KeeperCandidate = { incident_key: key, device_id_hash: s.deviceIdHash, severity: s.severity,
      logged_at: new Date(Number(s.loggedAt) * 1000).toISOString() }
    if (s.canSlashMissedAck) result.slash_missed_ack.push(row)
    if (s.canSlashLateRelay) result.slash_late_relay.push(row)
  }
  return result
}

function StatCard({ label, value, danger = false }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="flex flex-col gap-1 rounded-[14px] border border-[#eef1ec] bg-white p-4 shadow-[0_1px_2px_rgba(20,40,25,0.03)] sm:px-[18px]">
      <span className="text-[12px] font-medium text-[#5d6a60]">{label}</span>
      <span className={`text-[24px] font-bold ${danger ? 'text-[#c81e3a]' : 'text-[#17201a]'}`}>{value}</span>
    </div>
  )
}

function EmptyRow({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-3 px-6 py-7 text-[13px] text-[#5d6a60]">
      <span className="size-2 rounded-full bg-[#c3cbc4]" />
      {children}
    </div>
  )
}

function KeeperItem({ item, action }: { item: KeeperCandidate; action: 'slashMissedAck' | 'slashLateRelay' }) {
  const chain = useSettlement(item.incident_key, { realtime: false })
  const token = useTokenWallet()
  const tx = useIncentiveTransaction(item.incident_key)
  const eligible = action === 'slashMissedAck' ? chain.data?.settlement.canSlashMissedAck : chain.data?.settlement.canSlashLateRelay
  const bounty = useQuery({
    queryKey: ['incentives', chain.guard.deployment?.incentives.address, 'bounty', item.incident_key, action, chain.data?.settlement.flags],
    enabled: Boolean(eligible) && chain.guard.status === 'ready', retry: false, refetchInterval: SETTLEMENT_POLL_MS,
    queryFn: async () => {
      const client = chain.guard.publicClient!
      const address = chain.guard.deployment!.incentives.address
      const [params, bond] = await Promise.all([
        client.readContract({ address, abi: SAFETY_INCENTIVES_ABI, functionName: 'params' }),
        action === 'slashMissedAck' ? client.readContract({ address, abi: SAFETY_INCENTIVES_ABI, functionName: 'deviceBond', args: [chain.data!.settlement.deviceIdHash] })
          : client.readContract({ address, abi: SAFETY_INCENTIVES_ABI, functionName: 'operatorBond' }),
      ])
      let available = bond.amount
      if (action === 'slashMissedAck') {
        const device = await client.readContract({ address: chain.guard.deployment!.airSafetyLog, abi: AIR_SAFETY_LOG_ABI, functionName: 'getDevice', args: [chain.data!.settlement.deviceIdHash] })
        if (bond.since > chain.data!.settlement.loggedAt || bond.staker.toLowerCase() !== device.owner.toLowerCase()) available = 0n
      }
      const penalty = action === 'slashMissedAck' ? params.missedAckPenalty : params.lateRelayPenalty
      return (available < penalty ? available : penalty) * BigInt(params.keeperShareBps) / 10000n
    },
  })
  const preflight = useQuery({
    queryKey: ['incentives', chain.guard.deployment?.incentives.address, 'keeper-simulation', item.incident_key, action,
      tx.guard.account.address, chain.data?.settlement.flags],
    enabled: Boolean(eligible) && tx.guard.canWrite, retry: false, refetchInterval: SETTLEMENT_POLL_MS,
    queryFn: () => chain.guard.publicClient!.simulateContract({
      address: chain.guard.deployment!.incentives.address, abi: SAFETY_INCENTIVES_ABI,
      account: tx.guard.account.address, functionName: action, args: [item.incident_key],
    }),
  })
  // Keep receipt information until reconciliation even after the candidate leaves API.
  if (eligible === false && tx.snapshot.stage === 'idle') return null
  const severity = severityDisplay((['warning', 'warning', 'danger', 'critical'] as const)[item.severity] ?? null)
  return <div className="flex flex-col gap-2 border-t border-[#eef1ec] px-6 py-4 first:border-t-0">
    <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
      <div className="flex min-w-[260px] flex-[1_1_320px] flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2.5 text-[13px]">
          <span className="flex items-center gap-2 font-semibold" style={{ color: severity.color }}>
            <span className="size-2 rounded-full" style={{ backgroundColor: severity.color }} />
            {severity.label}
          </span>
          <span className="font-mono text-[12px] font-medium text-[#3d4a40]">{formatIncidentTime(String(Math.floor(Date.parse(item.logged_at) / 1000)), true)}</span>
        </div>
        <p className="m-0 break-all font-mono text-[12px] font-medium text-[#7a867c]">Incident key: {item.incident_key}</p>
      </div>
      <div className="ml-auto flex flex-wrap items-center gap-x-5 gap-y-2">
      {bounty.isError ? null : bounty.data !== undefined && token.data ? (
        <span className="text-[13px] font-semibold text-[#15803d]">Bounty canonical: +{formatUnits(bounty.data, token.data.decimals)} ASAFE</span>
      ) : null}
      <div className="w-[250px] max-w-full">
        <ActionButton label={action === 'slashMissedAck' ? 'Phạt missed ack' : 'Phạt relay trễ (operator)'} variant="primary"
          disabled={!tx.guard.canWrite || !eligible || bounty.isPending || bounty.isError || preflight.isPending || preflight.isError || isTransactionBusy(tx.snapshot.stage)}
          onClick={() => void tx.run(action, [item.incident_key])} />
      </div>
      </div>
    </div>
    {chain.isPending ? <p className="m-0 text-[13px] text-[#5d6a60]">Đang kiểm tra eligibility on-chain…</p> : null}
    {chain.isError ? <NoticeBanner role="alert">RPC settlement lỗi: {chain.error.message}</NoticeBanner> : null}
    {token.isError ? <NoticeBanner role="alert">RPC token lỗi: {token.error.message}</NoticeBanner> : null}
    {eligible === false ? <p className="m-0 text-[13px] text-[#5d6a60]">Đã xử lý hoặc không còn đủ điều kiện.</p> : null}
    {preflight.isError ? <NoticeBanner role="alert">Mô phỏng thất bại: {preflight.error.message}</NoticeBanner> : null}
    {bounty.isError ? <NoticeBanner role="alert">RPC bounty lỗi: {bounty.error.message}</NoticeBanner> : null}
    <IncentiveTxStatus snapshot={tx.snapshot} onDiscard={tx.discardPending} />
  </div>
}

export function KeeperBoard() {
  const guard = useIncentivesGuard()
  const api = useIncentivesApi<OverdueIncentives>('/incentives/overdue')
  const fallback = useQuery({
    queryKey: ['incentives', guard.deployment?.incentives.address, 'overdue-chain'],
    enabled: api.isError && guard.status === 'ready', retry: false, refetchInterval: CHAIN_POLL_MS,
    queryFn: () => scanOverdue(guard.publicClient!, guard.deployment!),
  })
  const data = api.isError ? fallback.data : api.data
  const missed = data?.slash_missed_ack
  const late = data?.slash_late_relay
  const share = api.data && !api.isError ? `${api.data.keeper_share_bps / 100}%` : '—'
  return <>
    <IncentivesGuardNotice guard={guard} />
    {api.isPending && guard.deployment ? <p className="m-0 text-[13px] text-[#5d6a60]">Đang tải overdue API…</p> : null}
    {api.isError ? <NoticeBanner role="alert">{api.error.message}. Đang dùng fallback logs on-chain.</NoticeBanner> : null}
    {api.isError && fallback.isPending ? <p className="m-0 text-[13px] text-[#5d6a60]">Đang quét overdue trên chain…</p> : null}
    {fallback.isError ? <NoticeBanner role="alert">RPC fallback lỗi: {fallback.error.message}</NoticeBanner> : null}
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <StatCard label="Quá hạn xác nhận (P1)" value={missed ? String(missed.length) : '—'} danger={Boolean(missed?.length)} />
      <StatCard label="Relay trễ (P2)" value={late ? String(late.length) : '—'} danger={Boolean(late?.length)} />
      <StatCard label="Bounty cho keeper" value={share} />
    </div>
    {data ? <>
      <Panel>
        <PanelHeader title="Quá hạn acknowledge (P1)" right={<span className="text-[12px] text-[#5d6a60]">{missed!.length} sự cố</span>} />
        {missed!.length === 0 ? <EmptyRow>Không có incident quá hạn acknowledge.</EmptyRow> : missed!.map((item) => <KeeperItem key={item.incident_key} item={item} action="slashMissedAck" />)}
      </Panel>
      <Panel>
        <PanelHeader title="Relay trễ, phạt operator (P2, thủ công)" right={<span className="text-[12px] text-[#5d6a60]">{late!.length} sự cố</span>} />
        {late!.length === 0 ? <EmptyRow>Không có incident relay trễ.</EmptyRow> : late!.map((item) => <KeeperItem key={item.incident_key} item={item} action="slashLateRelay" />)}
      </Panel>
    </> : null}
  </>
}
