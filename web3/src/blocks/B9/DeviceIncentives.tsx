import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { decodeEventLog, formatUnits } from 'viem'
import { useCanonicalDeviceIncentives, useTokenWallet } from '../../lib/useIncentives'
import { useIncentivesApi, type DeviceIncentives as Projection } from '../../lib/incentivesApi'
import { SAFETY_INCENTIVES_ABI } from '../../generated/incentives-deployments'
import { ExplorerLink } from '../../components/ExplorerLink'
import { IncentivesCard, IncentivesGuardNotice } from '../B7/IncentivesShared'

export function DeviceIncentives({ deviceId }: { deviceId: string }) {
  const canonical = useCanonicalDeviceIncentives(deviceId)
  const token = useTokenWallet()
  const api = useIncentivesApi<Projection>(`/devices/${deviceId}/incentives`, true)
  const [compare, setCompare] = useState(false)
  const history = useQuery({
    queryKey: ['incentives', canonical.guard.deployment?.incentives.address, 'history', canonical.hash],
    enabled: compare && canonical.guard.status === 'ready', retry: false,
    queryFn: async () => {
      const client = canonical.guard.publicClient!
      const deployment = canonical.guard.deployment!
      const head = await client.getBlockNumber()
      const events: { name: string; tx: string; block: bigint }[] = []
      for (let from = BigInt(deployment.incentives.blockNumber); from <= head; from += 2000n) {
        const to = from + 1999n < head ? from + 1999n : head
        const logs = await client.getLogs({ address: deployment.incentives.address, fromBlock: from, toBlock: to })
        for (const log of logs) {
          const decoded = decodeEventLog({ abi: SAFETY_INCENTIVES_ABI, data: log.data, topics: log.topics })
          const args = decoded.args as Record<string, unknown>
          let relevant = args.deviceIdHash === canonical.hash
          if (args.incidentKey) {
            const settlement = await client.readContract({ address: deployment.incentives.address, abi: SAFETY_INCENTIVES_ABI,
              functionName: 'pendingSettlement', args: [args.incidentKey as `0x${string}`] })
            relevant = settlement.deviceIdHash === canonical.hash
          }
          if (relevant) events.push({ name: decoded.eventName, tx: log.transactionHash!, block: log.blockNumber! })
        }
      }
      return events
    },
  })
  const decimals = token.data?.decimals
  const stale = api.data && canonical.data && (BigInt(api.data.bond?.amount ?? '0') !== canonical.data.bond.amount ||
    api.data.rewards_today.count !== canonical.data.rewardsToday)
  return <IncentivesCard title="Device incentives">
    <IncentivesGuardNotice guard={canonical.guard} />
    {token.isError ? <p role="alert">RPC token lỗi: {token.error.message}</p> : null}
    {canonical.guard.status === 'ready' && canonical.isPending ? <p>Đang đọc incentives chain…</p> : null}
    {canonical.isError ? <p role="alert">RPC incentives lỗi: {canonical.error.message}</p> : canonical.data && decimals !== undefined ? <>
      <p>Bond canonical: {formatUnits(canonical.data.bond.amount, decimals)} ASAFE</p>
      <p>Required bond: {formatUnits(canonical.data.params.ownerBond, decimals)} ASAFE</p>
      <p>{canonical.data.rewardsToday}/{canonical.data.params.dailyRewardCap} lượt thưởng hôm nay (chain)</p>
      <p>Missed ack penalty: {formatUnits(canonical.data.params.missedAckPenalty, decimals)} ASAFE</p>
    </> : null}
    {api.isPending ? <p>Đang tải API projection…</p> : null}
    {api.isError ? <p role="alert">{api.error.message}</p> : api.data && decimals !== undefined ? <>
      <p>API indexed/projection: thưởng {formatUnits(BigInt(api.data.totals.rewarded), decimals)}, phạt owner {formatUnits(BigInt(api.data.totals.slashed), decimals)} ASAFE</p>
      {stale ? <p>API đang chậm hoặc chưa index giao dịch; chain vẫn là canonical.</p> : null}
      {api.data.events.length === 0 ? <p>Chưa có incentive events được index.</p> : api.data.events.map((event) => <p key={event.id}>
        {event.name} · {event.amount ? formatUnits(BigInt(event.amount), decimals) : '—'} ASAFE · <ExplorerLink kind="tx" value={event.tx_hash} />
      </p>)}
    </> : null}
    <button className="underline" disabled={canonical.guard.status !== 'ready'} onClick={() => setCompare(true)}>Đối chiếu lịch sử incentives on-chain</button>
    {compare && history.isPending ? <p>Đang quét logs incentives…</p> : null}
    {history.isError ? <p role="alert">RPC logs lỗi: {history.error.message}</p> : history.data?.map((event) => <p key={event.tx + event.name}>
      On-chain {event.name} · <ExplorerLink kind="tx" value={event.tx} /> · <ExplorerLink kind="block" value={String(event.block)} />
    </p>)}
  </IncentivesCard>
}
