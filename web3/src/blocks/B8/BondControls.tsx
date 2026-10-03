import { useRef, useState } from 'react'
import { useChainNow } from '../../lib/useChainNow'
import { formatUnits } from 'viem'
import { ActionButton } from '../../components/ui/ActionButton'
import { Panel, PanelHeader } from '../../components/ui/Panel'
import { useCanonicalDeviceIncentives, useTokenWallet } from '../../lib/useIncentives'
import { useIncentiveTransaction } from '../../lib/useIncentiveTransaction'
import { parseBondAmount, stakeWithApproval } from '../../lib/incentives'
import { formatDuration } from '../../lib/formatDuration'
import { addressesMatch } from '../../lib/ownership'
import { isTransactionBusy } from '../../lib/incidentTransaction'
import { IncentiveTxStatus, IncentivesGuardNotice, NoticeBanner } from '../B7/IncentivesShared'

export function BondControls({ deviceId }: { deviceId: string }) {
  const canonical = useCanonicalDeviceIncentives(deviceId)
  const token = useTokenWallet()
  const tx = useIncentiveTransaction(canonical.hash)
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [flowBusy, setFlowBusy] = useState(false)
  const lock = useRef(false)
  const chainNow = useChainNow(canonical.data?.block.timestamp)
  const data = canonical.data
  const decimals = token.data?.decimals
  const address = canonical.guard.account.address
  const busy = flowBusy || isTransactionBusy(tx.snapshot.stage)
  const ready = canonical.guard.canWrite && data && token.data && !canonical.isError && !token.isError && decimals !== undefined
  const owner = addressesMatch(data?.device.owner, address)
  const staker = addressesMatch(data?.bond.staker, address)
  const requested = data?.bond.unstakeRequestedAt ?? 0n
  const availableAt = data ? requested + data.params.unstakeCooldown : 0n
  const now = chainNow ?? 0n
  async function stake() {
    if (lock.current || !ready || !owner) return
    lock.current = true; setFlowBusy(true); setError('')
    try {
      const fresh = await token.refetch()
      if (fresh.isError || fresh.data?.balance === undefined || fresh.data.allowance === undefined) throw new Error('Không đọc được balance/allowance hiện tại')
      const amount = parseBondAmount(value || formatUnits(data.params.ownerBond, decimals), decimals)
      if (amount > fresh.data.balance) throw new Error('Không đủ ASAFE trong ví')
      if (data.bond.amount + amount < data.params.ownerBond) throw new Error('Tổng bond thấp hơn mức required bond')
      await stakeWithApproval(amount, fresh.data.allowance, async (action) =>
        (await tx.run(action, action === 'approve' ? [tx.guard.deployment!.incentives.address, amount] : [canonical.hash, amount])) ?? { stage: 'busy' })
    } catch (err) { setError(err instanceof Error ? err.message : 'Không stake được') }
    finally { lock.current = false; setFlowBusy(false) }
  }
  const bondPct = data && data.params.ownerBond > 0n
    ? Math.min(100, Number((data.bond.amount * 100n) / data.params.ownerBond))
    : 0
  return <Panel>
    <PanelHeader title="Bond" />
    <div className="flex flex-col gap-4 px-6 py-5">
      <IncentivesGuardNotice guard={canonical.guard} />
      {canonical.guard.status === 'ready' && canonical.isPending ? <p className="m-0 text-[13px] text-[#5d6a60]">Đang đọc bond từ chain…</p> : null}
      {token.isError ? <NoticeBanner role="alert">RPC token lỗi: {token.error.message}</NoticeBanner> : null}
      {canonical.isError ? <NoticeBanner role="alert">RPC bond lỗi: {canonical.error.message}</NoticeBanner> : data && decimals !== undefined ? <>
        <div className="flex flex-col gap-2">
          <span className="text-[12px] text-[#5d6a60]">Bond hiện có</span>
          <div className="flex flex-wrap items-baseline gap-2">
            <span data-testid="bond-amount" className="text-[24px] font-bold text-[#17201a]">{formatUnits(data.bond.amount, decimals)} ASAFE</span>
            <span className="text-[13px] text-[#5d6a60]">Tối thiểu {formatUnits(data.params.ownerBond, decimals)} ASAFE{data.bond.amount >= data.params.ownerBond ? ' · đã đủ' : ''}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-[3px] bg-[#eef1ec]">
            <div className={`h-full rounded-[3px] transition-all duration-500 ${bondPct >= 100 ? 'bg-[#16a34a]' : 'bg-[#d97706]'}`} style={{ width: `${bondPct}%` }} />
          </div>
        </div>
        <label className="flex flex-col gap-1.5 text-[12px] text-[#5d6a60]">
          Số lượng ASAFE
          <input aria-label="Số lượng ASAFE" className="h-10 rounded-[10px] border border-[#dfe4dc] bg-white px-3 text-[14px] text-[#17201a] outline-none placeholder:text-[#8a958c] focus:border-[#16803c] disabled:bg-[#f6f8f5]"
            value={value} placeholder={formatUnits(data.params.ownerBond, decimals)} onChange={(e) => setValue(e.target.value)} disabled={busy} />
        </label>
        {!owner ? <NoticeBanner>Chỉ ví owner của thiết bị được stake.</NoticeBanner> : null}
        <div className="flex flex-col gap-2">
          <ActionButton label="Approve → Stake" variant="primary" disabled={!ready || !owner || busy} onClick={() => void stake()} />
          <p className="m-0 text-[12px] text-[#8a958c]">Tự approve nếu thiếu allowance, rồi stake.</p>
        </div>
        {requested > 0n ? (
          <NoticeBanner>Còn {formatDuration(availableAt > now ? availableAt - now : 0n)} cooldown. Trong thời gian chờ vẫn có thể bị phạt.</NoticeBanner>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          <ActionButton label="Yêu cầu unstake" variant="outline" disabled={!ready || !staker || data.bond.amount === 0n || requested > 0n || busy}
            onClick={() => void tx.run('requestUnstake', [canonical.hash])} />
          <ActionButton label="Withdraw bond" variant="outline" disabled={!ready || !staker || requested === 0n || now < availableAt || busy}
            onClick={() => void tx.run('withdraw', [canonical.hash])} />
        </div>
      </> : null}
      {error ? <NoticeBanner role="alert">{error}</NoticeBanner> : null}
      <IncentiveTxStatus snapshot={tx.snapshot} onDiscard={tx.discardPending} />
    </div>
  </Panel>
}
