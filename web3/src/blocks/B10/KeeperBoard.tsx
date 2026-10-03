import { useQuery } from '@tanstack/react-query'
import { formatUnits, parseAbiItem, type PublicClient } from 'viem'
import { activeNetwork } from '../../config/networks'
import { SAFETY_INCENTIVES_ABI } from '../../generated/incentives-deployments'
import { AIR_SAFETY_LOG_ABI } from '../../generated/incident-deployments'
import { useIncentivesApi, type OverdueIncentives, type OverdueItem } from '../../lib/incentivesApi'
import { useIncentivesGuard, useSettlement, useTokenWallet } from '../../lib/useIncentives'
import { useIncentiveTransaction } from '../../lib/useIncentiveTransaction'
import { isTransactionBusy } from '../../lib/incidentTransaction'
import type { IncentivesDeployment } from '../../lib/incentives'
import { PrimaryButton } from '../../components/ui/PrimaryButton'
import { IncentivesCard, IncentivesGuardNotice, IncentiveTxStatus } from '../B7/IncentivesShared'

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

function KeeperItem({ item, action }: { item: KeeperCandidate; action: 'slashMissedAck' | 'slashLateRelay' }) {
  const chain = useSettlement(item.incident_key)
  const token = useTokenWallet()
  const tx = useIncentiveTransaction(item.incident_key)
  const eligible = action === 'slashMissedAck' ? chain.data?.settlement.canSlashMissedAck : chain.data?.settlement.canSlashLateRelay
  const bounty = useQuery({
    queryKey: ['incentives', chain.guard.deployment?.incentives.address, 'bounty', item.incident_key, action, chain.data?.settlement.flags],
    enabled: Boolean(eligible) && chain.guard.status === 'ready', retry: false, refetchInterval: 5_000,
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
    enabled: Boolean(eligible) && tx.guard.canWrite, retry: false, refetchInterval: 5_000,
    queryFn: () => chain.guard.publicClient!.simulateContract({
      address: chain.guard.deployment!.incentives.address, abi: SAFETY_INCENTIVES_ABI,
      account: tx.guard.account.address, functionName: action, args: [item.incident_key],
    }),
  })
  // Keep receipt information until reconciliation even after the candidate leaves API.
  if (eligible === false && tx.snapshot.stage === 'idle') return null
  return <div className="my-3 space-y-2 rounded border border-line p-3">
    <p className="break-all">Incident key: {item.incident_key}</p>
    {chain.isPending ? <p>Đang kiểm tra eligibility on-chain…</p> : null}
    {chain.isError ? <p role="alert">RPC settlement lỗi: {chain.error.message}</p> : null}
    {token.isError ? <p role="alert">RPC token lỗi: {token.error.message}</p> : null}
    {eligible === false ? <p>Đã settlement hoặc không còn eligible; không thể gửi lại.</p> : null}
    {preflight.isError ? <p role="alert">Simulation keeper lỗi; action không khả dụng: {preflight.error.message}</p> : null}
    {bounty.isError ? <p role="alert">RPC bounty lỗi: {bounty.error.message}</p> : bounty.data !== undefined && token.data ? <p>Bounty canonical: +{formatUnits(bounty.data, token.data.decimals)} ASAFE</p> : null}
    <PrimaryButton label={action === 'slashMissedAck' ? 'Phạt missed ack' : 'Phạt relay trễ (operator)'}
      disabled={!tx.guard.canWrite || !eligible || bounty.isPending || bounty.isError || preflight.isPending || preflight.isError || isTransactionBusy(tx.snapshot.stage)}
      onClick={() => void tx.run(action, [item.incident_key])} />
    <IncentiveTxStatus snapshot={tx.snapshot} onDiscard={tx.discardPending} />
  </div>
}

export function KeeperBoard() {
  const guard = useIncentivesGuard()
  const api = useIncentivesApi<OverdueIncentives>('/incentives/overdue')
  const fallback = useQuery({
    queryKey: ['incentives', guard.deployment?.incentives.address, 'overdue-chain'],
    enabled: api.isError && guard.status === 'ready', retry: false, refetchInterval: 10_000,
    queryFn: () => scanOverdue(guard.publicClient!, guard.deployment!),
  })
  const data = api.isError ? fallback.data : api.data
  return <IncentivesCard title="Keeper / Overdue">
    <IncentivesGuardNotice guard={guard} />
    <p>R1/R2 và P1 được server keeper tự xử lý; bảng này cho phép keeper bên ngoài xử lý khi còn eligible.</p>
    <p>Relay trễ (P2): phạt operator chỉ bằng thao tác thủ công của ví; server không tự slash P2.</p>
    {api.isPending && guard.deployment ? <p>Đang tải overdue API…</p> : null}
    {api.isError ? <p role="alert">{api.error.message}. Đang dùng fallback logs on-chain.</p> : null}
    {api.isError && fallback.isPending ? <p>Đang quét overdue trên chain…</p> : null}
    {fallback.isError ? <p role="alert">RPC fallback lỗi: {fallback.error.message}</p> : null}
    {data ? <>
      <h3>Quá hạn acknowledge (P1)</h3>
      {data.slash_missed_ack.length === 0 ? <p>Không có incident quá hạn acknowledge.</p> : data.slash_missed_ack.map((item) => <KeeperItem key={item.incident_key} item={item} action="slashMissedAck" />)}
      <h3>Relay trễ — phạt operator (P2, manual)</h3>
      {data.slash_late_relay.length === 0 ? <p>Không có incident relay trễ.</p> : data.slash_late_relay.map((item) => <KeeperItem key={item.incident_key} item={item} action="slashLateRelay" />)}
    </> : null}
  </IncentivesCard>
}
