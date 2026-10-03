import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react'
import { decodeEventLog, formatUnits } from 'viem'
import { useCanonicalDeviceIncentives, useTokenWallet } from '../../lib/useIncentives'
import { useIncentivesApi, type DeviceIncentives as Projection } from '../../lib/incentivesApi'
import { SAFETY_INCENTIVES_ABI } from '../../generated/incentives-deployments'
import { activeNetwork } from '../../config/networks'
import { ExplorerLink } from '../../components/ExplorerLink'
import { Panel } from '../../components/ui/Panel'
import { IncentivesGuardNotice } from '../B7/IncentivesShared'

type ReconStatus = 'match' | 'diff' | 'api-only'

const RECON_STATUS: Record<ReconStatus, { text: string; className: string }> = {
  match: { text: 'Khớp', className: 'text-[#15803d]' },
  diff: { text: 'Lệch', className: 'text-[#c81e3a]' },
  'api-only': { text: 'Chỉ API', className: 'text-[#8a958c]' },
}

const RECON_GRID = 'grid grid-cols-[minmax(0,1.4fr)_1fr_1fr_70px] gap-3 px-6'

function AlertBanner({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-[10px] bg-[#fdf4dc] px-3 py-2.5">
      <span className="mt-1.5 size-2 shrink-0 rounded-full bg-[#d97706]" />
      <p role="alert" className="m-0 min-w-0 flex-1 text-[13px] leading-[1.5] text-[#7a4f00]">
        {children}
      </p>
    </div>
  )
}

function Stat({
  label,
  testId,
  className = '',
  children,
}: {
  label: string
  testId: string
  className?: string
  children: ReactNode
}) {
  return (
    <div className={`flex flex-col gap-1 border-[#eef1ec] px-[22px] py-3.5 ${className}`}>
      <span className="text-[12px] text-[#5d6a60]">{label}</span>
      <span data-testid={testId} className="text-[18px] font-semibold text-[#17201a]">
        {children}
      </span>
    </div>
  )
}

function Unit({ children }: { children: ReactNode }) {
  return <span className="text-[12px] font-medium text-[#5d6a60]">{children}</span>
}

export function DeviceIncentives({ deviceId }: { deviceId: string }) {
  const canonical = useCanonicalDeviceIncentives(deviceId)
  const token = useTokenWallet()
  const api = useIncentivesApi<Projection>(`/devices/${deviceId}/incentives`, true)
  const [compare, setCompare] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)
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

  // An errored query must not keep rendering its stale data as if it were current.
  const chainData = canonical.isError ? undefined : canonical.data
  const apiData = api.isError ? undefined : api.data
  const fmt = (value: bigint) => (decimals === undefined ? '—' : formatUnits(value, decimals))
  const bondShort = chainData && decimals !== undefined && chainData.bond.amount < chainData.params.ownerBond
  const reconRows: { label: string; chain: string; api: string; status: ReconStatus }[] = [
    {
      label: 'Bond (ASAFE)',
      chain: chainData ? fmt(chainData.bond.amount) : '—',
      api: apiData ? fmt(BigInt(apiData.bond?.amount ?? '0')) : '—',
      status: chainData && apiData ? (BigInt(apiData.bond?.amount ?? '0') === chainData.bond.amount ? 'match' : 'diff') : 'api-only',
    },
    {
      label: 'Lượt thưởng hôm nay',
      chain: chainData ? `${chainData.rewardsToday}/${chainData.params.dailyRewardCap}` : '—',
      api: apiData ? `${apiData.rewards_today.count}/${apiData.rewards_today.cap ?? chainData?.params.dailyRewardCap ?? '—'}` : '—',
      status: chainData && apiData ? (apiData.rewards_today.count === chainData.rewardsToday ? 'match' : 'diff') : 'api-only',
    },
    { label: 'Tổng thưởng (ASAFE)', chain: '—', api: apiData ? fmt(BigInt(apiData.totals.rewarded)) : '—', status: 'api-only' },
    { label: 'Tổng phạt owner (ASAFE)', chain: '—', api: apiData ? fmt(BigInt(apiData.totals.slashed)) : '—', status: 'api-only' },
  ]
  const explorerBase = activeNetwork.explorerBaseUrl
  const incentivesAddress = canonical.guard.deployment?.incentives.address

  return <Panel>
    <div className="flex flex-col gap-3 px-[22px] pb-3.5 pt-[18px]">
      <h2 className="m-0 text-[16px] font-semibold text-[#17201a]">Khuyến khích &amp; thưởng phạt</h2>
      <IncentivesGuardNotice guard={canonical.guard} />
      {token.isError ? <AlertBanner>RPC token lỗi: {token.error.message}</AlertBanner> : null}
      {canonical.guard.status === 'ready' && canonical.isPending ? <p className="m-0 text-[13px] text-[#5d6a60]">Đang đọc incentives chain…</p> : null}
      {canonical.isError ? <AlertBanner>RPC incentives lỗi: {canonical.error.message}</AlertBanner> : null}
      {api.isPending ? <p className="m-0 text-[13px] text-[#5d6a60]">Đang tải API projection…</p> : null}
      {api.isError ? <AlertBanner>{api.error.message}</AlertBanner> : null}
      {stale ? (
        <div className="flex items-start gap-2.5 rounded-[10px] bg-[#fdf4dc] px-3 py-2.5">
          <span className="mt-1.5 size-2 shrink-0 rounded-full bg-[#d97706]" />
          <p className="m-0 min-w-0 flex-1 text-[13px] leading-[1.5] text-[#7a4f00]">API đang chậm hoặc chưa index giao dịch; chain vẫn là canonical.</p>
        </div>
      ) : null}
    </div>

    {chainData && decimals !== undefined ? (
      <div className="grid grid-cols-2 border-t border-[#eef1ec]">
        <Stat label="Bond hiện có" testId="device-bond" className="border-b border-r">
          <span className={bondShort ? 'text-[#c81e3a]' : ''}>{fmt(chainData.bond.amount)}</span>{' '}
          <Unit>/ {fmt(chainData.params.ownerBond)} ASAFE</Unit>
        </Stat>
        <Stat label="Lượt thưởng hôm nay" testId="device-rewards-today" className="border-b">
          {chainData.rewardsToday} <Unit>/ {chainData.params.dailyRewardCap}</Unit>
        </Stat>
        <Stat label="Phạt trễ xác nhận" testId="device-ack-penalty" className="border-r">
          {fmt(chainData.params.missedAckPenalty)} <Unit>ASAFE</Unit>
        </Stat>
        <div className="flex flex-col gap-1 px-[22px] py-3.5">
          <span className="text-[12px] text-[#5d6a60]">Đã index</span>
          <span data-testid="device-indexed" className="text-[13px] font-semibold leading-[1.6] text-[#17201a]">
            {apiData ? `Thưởng ${fmt(BigInt(apiData.totals.rewarded))} · Phạt ${fmt(BigInt(apiData.totals.slashed))}` : '—'}
          </span>
        </div>
      </div>
    ) : null}

    <div className="flex flex-wrap items-center gap-3 border-t border-[#eef1ec] px-[22px] pb-4 pt-3">
      <span className="min-w-0 flex-[1_1_auto] text-[12px] text-[#8a958c]">
        {apiData && apiData.events.length > 0 ? `${apiData.events.length} sự kiện incentive đã index.` : 'Chưa có sự kiện incentive.'}
      </span>
      <button
        type="button"
        className="cursor-pointer border-0 bg-transparent p-0 text-[13px] font-semibold text-[#16803c] hover:text-[#0f5f2c] disabled:cursor-not-allowed disabled:text-[#a3ada5]"
        disabled={canonical.guard.status !== 'ready'}
        onClick={() => { setCompare(true); setDrawerOpen(true) }}
      >
        Đối chiếu on-chain →
      </button>
    </div>

    <Dialog open={drawerOpen} onClose={() => setDrawerOpen(false)} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-[rgba(15,25,18,0.35)]" />
      <DialogPanel className="fixed inset-y-0 right-0 flex w-[560px] max-w-full flex-col bg-white shadow-[-12px_0_40px_rgba(15,25,18,0.15)]">
        <div className="flex items-start gap-3 border-b border-[#eef1ec] px-6 py-5">
          <div className="flex flex-1 flex-col gap-1.5">
            <DialogTitle className="m-0 text-[18px] font-semibold text-[#17201a]">Đối chiếu incentives on-chain</DialogTitle>
            <span className="break-all font-mono text-[12px] text-[#5d6a60]">{deviceId}</span>
          </div>
          <button
            type="button"
            aria-label="Đóng"
            onClick={() => setDrawerOpen(false)}
            className="size-9 cursor-pointer rounded-[10px] border border-[#dfe4dc] bg-white text-[16px] text-[#17201a] hover:bg-[#f4f6f3]"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="flex flex-col gap-3 px-6 py-4 empty:hidden">
            <IncentivesGuardNotice guard={canonical.guard} />
            {stale ? <p className="m-0 text-[13px] text-[#7a4f00]">API đang chậm hoặc chưa index giao dịch; chain vẫn là canonical.</p> : null}
          </div>
          <div className={`${RECON_GRID} bg-[#f6f8f5] py-2.5 text-[11px] font-bold tracking-[0.06em] text-[#5d6a60]`}>
            <span>CHỈ SỐ</span><span>CHAIN</span><span>API INDEX</span><span />
          </div>
          {reconRows.map((row) => (
            <div key={row.label} className={`${RECON_GRID} items-center border-b border-[#f1f3ef] py-3 text-[13px]`}>
              <span className="text-[#3d4a40]">{row.label}</span>
              <span className={`font-mono text-[13px] font-medium ${row.chain === '—' ? 'text-[#8a958c]' : 'text-[#17201a]'}`}>{row.chain}</span>
              <span className="font-mono text-[13px] font-medium text-[#17201a]">{row.api}</span>
              <span className={`text-[12px] font-semibold ${RECON_STATUS[row.status].className}`}>{RECON_STATUS[row.status].text}</span>
            </div>
          ))}
          <div className="px-6 pb-2 pt-5"><h3 className="m-0 text-[14px] font-semibold text-[#17201a]">Sự kiện incentive</h3></div>
          <div className="flex flex-col gap-1.5 px-6 pb-6 text-[13px] text-[#3d4a40]">
            {compare && history.isPending ? <p className="m-0">Đang quét logs incentives…</p> : null}
            {history.isError ? <p role="alert" className="m-0 text-[#c81e3a]">RPC logs lỗi: {history.error.message}</p> : null}
            {apiData && decimals !== undefined ? apiData.events.map((event) => <p key={event.id} className="m-0">
              {event.name} · {event.amount ? formatUnits(BigInt(event.amount), decimals) : '—'} ASAFE · <ExplorerLink kind="tx" value={event.tx_hash} />
            </p>) : null}
            {history.data?.map((event) => <p key={event.tx + event.name} className="m-0">
              On-chain {event.name} · <ExplorerLink kind="tx" value={event.tx} /> · <ExplorerLink kind="block" value={String(event.block)} />
            </p>)}
            {!(apiData?.events.length) && !history.data?.length && !history.isPending && !history.isError ? (
              <div className="rounded-xl border border-dashed border-[#dfe4dc] px-4 py-7 text-center text-[#5d6a60]">
                Chưa có sự kiện nào được ghi trên chain hoặc index.
              </div>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-2.5 border-t border-[#eef1ec] px-6 py-3.5">
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            className="h-10 cursor-pointer rounded-[10px] border border-[#dfe4dc] bg-white px-4 text-[14px] font-semibold text-[#17201a] hover:bg-[#f4f6f3]"
          >
            Đóng
          </button>
          {explorerBase && incentivesAddress ? (
            <a
              href={`${explorerBase}/address/${incentivesAddress}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-10 items-center rounded-[10px] bg-[#16803c] px-4 text-[14px] font-semibold text-white no-underline hover:bg-[#0f5f2c] hover:text-white"
            >
              Mở trên Etherscan ↗
            </a>
          ) : null}
        </div>
      </DialogPanel>
    </Dialog>
  </Panel>
}
