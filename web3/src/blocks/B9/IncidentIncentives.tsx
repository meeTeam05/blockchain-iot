import { useChainNow } from '../../lib/useChainNow'
import { formatUnits, type Hash } from 'viem'
import { useCanonicalDeviceIncentives, useSettlement, useTokenWallet } from '../../lib/useIncentives'
import { useIncentivesApi, type IncidentIncentive, type IncentiveParams } from '../../lib/incentivesApi'
import type { useIncentiveTransaction } from '../../lib/useIncentiveTransaction'
import { isTransactionBusy } from '../../lib/incidentTransaction'
import { PrimaryButton } from '../../components/ui/PrimaryButton'
import { ExplorerLink } from '../../components/ExplorerLink'
import { IncentivesCard, IncentivesGuardNotice, IncentiveTxStatus } from '../B7/IncentivesShared'

const statusLabels: Record<string, string> = { none: 'Chưa có settlement được index', ack_rewarded: 'Đã thưởng ack',
  resolved_rewarded: 'Đã thưởng resolve', over_cap: 'Vượt trần ngày: không thưởng', slashed: 'Owner đã bị phạt',
  late_relay_slashed: 'Relay trễ: operator bị phạt' }
export function IncidentIncentives({ deviceId, incidentKey, projection, transaction }: {
  deviceId: string; incidentKey: Hash; projection?: IncidentIncentive | null; transaction: ReturnType<typeof useIncentiveTransaction>
}) {
  const chain = useSettlement(incidentKey)
  const device = useCanonicalDeviceIncentives(deviceId)
  const token = useTokenWallet()
  const api = useIncentivesApi<IncentiveParams>('/incentives/params')
  const s = chain.data?.settlement
  const now = useChainNow(chain.data?.block.timestamp)
  const remaining = s && now !== undefined ? s.ackDeadline - now : undefined
  const decimals = token.data?.decimals
  const flags = projection?.flags
  const indexedFlags = flags ? Number(flags.timely_ack) + Number(flags.ack_rewarded) * 2 + Number(flags.resolve_settled) * 4 + Number(flags.ack_slashed) * 8 + Number(flags.relay_slashed) * 16 : undefined
  const projectionValid = Boolean(api.data && projection?.incident_key === incidentKey)
  return <IncentivesCard title="Incident incentives">
    <IncentivesGuardNotice guard={chain.guard} />
    {token.isError ? <p role="alert">RPC token lỗi: {token.error.message}</p> : null}
    {device.isError ? <p role="alert">RPC device incentives lỗi: {device.error.message}</p> : null}
    {chain.guard.status === 'ready' && chain.isPending ? <p>Đang đọc pendingSettlement từ chain…</p> : null}
    {chain.isError ? <p role="alert">RPC settlement lỗi: {chain.error.message}</p> : s ? <>
      {!s.exists ? <p>Sự cố chưa tồn tại trên chain.</p> : !s.covered ? <p>Sự cố trước khi incentives được kích hoạt.</p> : <>
        <p className={remaining !== undefined && remaining < 180n ? 'text-danger' : ''} data-testid="ack-countdown">
          {remaining !== undefined && remaining >= 0n ? `Hạn acknowledge: ${String(remaining / 60n).padStart(2, '0')}:${String(remaining % 60n).padStart(2, '0')}` : 'Quá hạn, không có thưởng ack; có thể bị phạt.'}
        </p>
        <p>Canonical settlement flags: {s.flags} · Relay delay: {String(s.relayDelay)} giây</p>
        {s.flags & 2 ? <p>Chain: đã thưởng ack</p> : null}
        {s.flags & 4 ? <p>Chain: resolve đã settlement (thưởng hoặc skipped)</p> : null}
        {s.flags & 8 ? <p>Chain: owner đã bị phạt</p> : null}
        {s.flags & 16 ? <p>Chain: relay trễ, operator bị phạt</p> : null}
        {device.data ? <p>{device.data.rewardsToday}/{device.data.params.dailyRewardCap} lượt thưởng hôm nay</p> : null}
        <p>Server keeper tự xử lý R1/R2 và P1; có thể ghi nhận thủ công khi chưa settlement. P2 chỉ do keeper bên ngoài thực hiện.</p>
        {s.canRecordAck ? <PrimaryButton label="Ghi nhận thưởng ack" disabled={!transaction.guard.canWrite || isTransactionBusy(transaction.snapshot.stage)} onClick={() => void transaction.run('recordTimelyAck', [incidentKey])} /> : null}
        {s.canRecordResolve ? <PrimaryButton label="Ghi nhận thưởng resolve" disabled={!transaction.guard.canWrite || isTransactionBusy(transaction.snapshot.stage)} onClick={() => void transaction.run('recordTimelyResolve', [incidentKey])} /> : null}
      </>}
    </> : null}
    {api.isError ? <p role="alert">{api.error.message}</p> : api.isPending ? <p>Đang xác minh deployment API incentives…</p> : null}
    {projectionValid && projection ? <>
      <p>API projection: {statusLabels[projection.reward_status] ?? projection.reward_status}</p>
      {s && indexedFlags !== s.flags ? <p>API chưa đồng bộ settlement; chain đã ghi nhận giao dịch.</p> : null}
      {projection.events.map((event) => <p key={event.id}>{event.name} {event.amount && decimals !== undefined ? `${formatUnits(BigInt(event.amount), decimals)} ASAFE` : ''}
        {event.name === 'RewardSkipped' ? ` · ${String(event.data.reason_name ?? event.data.reason ?? 'Skipped')}` : ''}
        {' · '}Keeper/owner: {event.account ?? '—'} · <ExplorerLink kind="tx" value={event.tx_hash} /> · <ExplorerLink kind="block" value={event.block_number} />
      </p>)}
    </> : null}
    <IncentiveTxStatus snapshot={transaction.snapshot} />
  </IncentivesCard>
}
