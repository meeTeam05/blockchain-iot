import { useRef, useState } from 'react'
import { useChainNow } from '../../lib/useChainNow'
import { formatUnits } from 'viem'
import { PrimaryButton } from '../../components/ui/PrimaryButton'
import { useCanonicalDeviceIncentives, useTokenWallet } from '../../lib/useIncentives'
import { useIncentiveTransaction } from '../../lib/useIncentiveTransaction'
import { parseBondAmount, stakeWithApproval } from '../../lib/incentives'
import { addressesMatch } from '../../lib/ownership'
import { isTransactionBusy } from '../../lib/incidentTransaction'
import { IncentiveTxStatus, IncentivesCard, IncentivesGuardNotice } from '../B7/IncentivesShared'

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
  return <IncentivesCard title="Approve / Bond">
    <IncentivesGuardNotice guard={canonical.guard} />
    {canonical.guard.status === 'ready' && canonical.isPending ? <p>Đang đọc bond từ chain…</p> : null}
    {token.isError ? <p role="alert">RPC token lỗi: {token.error.message}</p> : null}
    {canonical.isError ? <p role="alert">RPC bond lỗi: {canonical.error.message}</p> : data && decimals !== undefined ? <>
      <p data-testid="bond-amount">Bond chain: {formatUnits(data.bond.amount, decimals)} ASAFE</p>
      <p>Required bond: {formatUnits(data.params.ownerBond, decimals)} ASAFE</p>
      <label className="block">Số lượng ASAFE<input aria-label="Số lượng ASAFE" className="mx-3 border p-2" value={value}
        placeholder={formatUnits(data.params.ownerBond, decimals)} onChange={(e) => setValue(e.target.value)} disabled={busy} /></label>
      {!owner ? <p>Chỉ ví owner hiện tại trên chain được stake cho thiết bị.</p> : null}
      <p>Bước 1/2: approve đúng số lượng nếu thiếu allowance. Bước 2/2: stake. Khi hủy, allowance đã xác nhận được giữ để tiếp tục.</p>
      <PrimaryButton label="Approve → Stake" disabled={!ready || !owner || busy} onClick={() => void stake()} />
      {requested > 0n ? <p>Còn {String(availableAt > now ? availableAt - now : 0n)} giây cooldown. Trong thời gian chờ vẫn có thể bị phạt.</p> : null}
      <PrimaryButton label="Yêu cầu unstake" disabled={!ready || !staker || data.bond.amount === 0n || requested > 0n || busy}
        onClick={() => void tx.run('requestUnstake', [canonical.hash])} />
      <PrimaryButton label="Withdraw bond" disabled={!ready || !staker || requested === 0n || now < availableAt || busy}
        onClick={() => void tx.run('withdraw', [canonical.hash])} />
    </> : null}
    {error ? <p role="alert">{error}</p> : null}
    <IncentiveTxStatus snapshot={tx.snapshot} onDiscard={tx.discardPending} />
  </IncentivesCard>
}
