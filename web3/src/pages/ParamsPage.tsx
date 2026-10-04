import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { formatUnits } from 'viem'
import { PageShell } from '../components/ui/PageShell'
import { Panel, PanelHeader } from '../components/ui/Panel'
import { SessionActions } from '../blocks/B1/SessionActions'
import { SAFETY_INCENTIVES_ABI } from '../generated/incentives-deployments'
import { useIncentivesGuard, useTokenWallet } from '../lib/useIncentives'
import { useIncentivesApi, type IncentiveParams } from '../lib/incentivesApi'
import { IncentivesGuardNotice } from '../blocks/B7/IncentivesShared'
import { ExplorerLink } from '../components/ExplorerLink'
import { formatDuration } from '../lib/formatDuration'
import { CHAIN_POLL_MS } from '../lib/chainPolling'

function Notice({ role, children }: { role?: 'alert'; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-[10px] bg-[#fdf4dc] px-3 py-2.5">
      <span className="mt-1.5 size-2 shrink-0 rounded-full bg-[#d97706]" />
      <p role={role} className="m-0 min-w-0 flex-1 text-[13px] leading-[1.5] text-[#7a4f00]">{children}</p>
    </div>
  )
}

function StatCard({ label, testId, warn = false, children }: { label: string; testId: string; warn?: boolean; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[14px] border border-[#eef1ec] bg-white p-4 shadow-[0_1px_2px_rgba(20,40,25,0.03)] sm:px-[18px]">
      <span className="text-[12px] font-medium text-[#5d6a60]">{label}</span>
      <span data-testid={testId} className={`break-all text-[24px] font-bold ${warn ? 'text-[#b45309]' : 'text-[#17201a]'}`}>
        {children}
      </span>
    </div>
  )
}

function ParamRow({ label, name, value }: { label: string; name: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-[#f1f3ef] px-6 py-3 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[14px] text-[#17201a]">{label}</span>
        <span className="font-mono text-[11px] font-medium text-[#8a958c]">{name}</span>
      </div>
      <span data-testid={`param-${name}`} className="shrink-0 text-right text-[14px] font-semibold text-[#17201a]">{value}</span>
    </div>
  )
}

export function ParamsPage() {
  const guard = useIncentivesGuard()
  const token = useTokenWallet()
  const api = useIncentivesApi<IncentiveParams>('/incentives/params')
  const chain = useQuery({
    queryKey: ['incentives', guard.deployment?.incentives.address, 'params-chain'],
    enabled: guard.status === 'ready', retry: false, refetchInterval: CHAIN_POLL_MS,
    queryFn: async () => {
      const client = guard.publicClient!
      const address = guard.deployment!.incentives.address
      const [params, rewardFund, bond, operator] = await Promise.all([
        client.readContract({ address, abi: SAFETY_INCENTIVES_ABI, functionName: 'params' }),
        client.readContract({ address, abi: SAFETY_INCENTIVES_ABI, functionName: 'rewardFund' }),
        client.readContract({ address, abi: SAFETY_INCENTIVES_ABI, functionName: 'operatorBond' }),
        client.readContract({ address, abi: SAFETY_INCENTIVES_ABI, functionName: 'operator' }),
      ])
      return { params, rewardFund, bond, operator }
    },
  })

  const decimals = token.data?.decimals
  const asafe = (value: bigint) => (decimals === undefined ? '—' : `${formatUnits(value, decimals)} ASAFE`)
  const data = chain.data && decimals !== undefined ? chain.data : undefined
  const lowFund = data ? data.rewardFund < 1000n * 10n ** BigInt(decimals!) : false

  return (
    <PageShell actions={<SessionActions />}>
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="m-0 text-[28px] font-bold tracking-[-0.01em] text-[#17201a]">Tham số</h1>
          <span className="rounded-full bg-[#eef1ec] px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.06em] text-[#4f5b52]">Chỉ đọc</span>
        </div>
        <p className="m-0 text-[14px] text-[#5d6a60]">Tham số incentives đọc trực tiếp từ chain.</p>
      </div>

      {/* Once the deployment is validated the notice only asks to connect a wallet, which this read-only page never needs. */}
      {guard.status !== 'ready' ? <IncentivesGuardNotice guard={guard} /> : null}
      {token.isError ? <Notice role="alert">RPC token lỗi: {token.error.message}</Notice> : null}
      {guard.status === 'ready' && chain.isPending ? <p className="m-0 text-[13px] text-[#5d6a60]">Đang đọc params từ chain…</p> : null}
      {chain.isError ? <Notice role="alert">RPC params lỗi: {chain.error.message}</Notice> : null}

      {data ? (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard label="Quỹ thưởng" testId="params-reward-fund" warn={lowFund}>{asafe(data.rewardFund)}</StatCard>
            <StatCard label="Operator bond" testId="params-operator-bond">{asafe(data.bond.amount)}</StatCard>
            <StatCard label="Operator" testId="params-operator">
              <span className="text-[16px]"><ExplorerLink kind="address" value={data.operator} /></span>
            </StatCard>
          </div>
          {lowFund ? <Notice>Quỹ thưởng thấp: dưới 1 000 ASAFE.</Notice> : null}

          <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <Panel>
              <PanelHeader title="Thời hạn" />
              <ParamRow label="Hạn xác nhận (cảnh báo)" name="ackDeadlineWarning" value={formatDuration(data.params.ackDeadlineWarning)} />
              <ParamRow label="Hạn xác nhận (nghiêm trọng)" name="ackDeadlineDanger" value={formatDuration(data.params.ackDeadlineDanger)} />
              <ParamRow label="Hạn xử lý" name="resolveDeadline" value={formatDuration(data.params.resolveDeadline)} />
              <ParamRow label="Độ trễ relay tối đa" name="maxRelayDelay" value={formatDuration(data.params.maxRelayDelay)} />
              <ParamRow label="Chờ rút bond" name="unstakeCooldown" value={formatDuration(data.params.unstakeCooldown)} />
            </Panel>
            <Panel>
              <PanelHeader title="Thưởng và phạt" />
              <ParamRow label="Bond yêu cầu của owner" name="ownerBond" value={asafe(data.params.ownerBond)} />
              <ParamRow label="Thưởng xác nhận" name="ackReward" value={asafe(data.params.ackReward)} />
              <ParamRow label="Thưởng xử lý" name="resolveReward" value={asafe(data.params.resolveReward)} />
              <ParamRow label="Phạt trễ xác nhận" name="missedAckPenalty" value={asafe(data.params.missedAckPenalty)} />
              <ParamRow label="Phạt relay trễ" name="lateRelayPenalty" value={asafe(data.params.lateRelayPenalty)} />
            </Panel>
            <Panel>
              <PanelHeader title="Cấu hình khác" />
              <ParamRow label="Bounty cho keeper" name="keeperShareBps" value={`${Number(data.params.keeperShareBps) / 100}%`} />
              <ParamRow label="Lượt thưởng tối đa mỗi ngày" name="dailyRewardCap" value={String(data.params.dailyRewardCap)} />
            </Panel>
          </div>
        </>
      ) : null}

      <Panel>
        <PanelHeader title="Lịch sử cập nhật tham số" right={api.data ? <span className="font-mono text-[12px] text-[#8a958c]">Snapshot API: block {api.data.block_number}</span> : null} />
        {api.isPending && guard.deployment ? <p className="m-0 px-6 py-7 text-[13px] text-[#5d6a60]">Đang tải params history API…</p> : null}
        {api.isError ? <div className="px-6 py-5"><Notice role="alert">{api.error.message}</Notice></div> : null}
        {api.data && api.data.params_history.length === 0 ? (
          <div className="flex items-center gap-3 px-6 py-7 text-[13px] text-[#5d6a60]">
            <span className="size-2 rounded-full bg-[#c3cbc4]" />
            Chưa có ParamsUpdated được index.
          </div>
        ) : null}
        {api.data?.params_history.map((event) => (
          <details key={event.id} className="group border-b border-[#f1f3ef] last:border-b-0">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2.5 px-6 py-3.5 text-[13px] text-[#17201a] hover:bg-[#f8faf7] [&::-webkit-details-marker]:hidden">
              <span className="text-[#5d6a60] group-open:hidden">▸</span>
              <span className="hidden text-[#5d6a60] group-open:inline">▾</span>
              <span>ParamsUpdated · <ExplorerLink kind="tx" value={event.tx_hash} /> · <ExplorerLink kind="block" value={event.block_number} /></span>
            </summary>
            <pre className="m-0 overflow-auto bg-[#f6f8f5] px-6 py-4 font-mono text-[12px] font-medium leading-[1.7] text-[#3d4a40]">{JSON.stringify(event.data, null, 2)}</pre>
          </details>
        ))}
      </Panel>
    </PageShell>
  )
}
