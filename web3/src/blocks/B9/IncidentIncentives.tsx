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
export function IncidentIncentives({
  deviceId,
  incidentKey,
  projection,
  transaction,
}: {
  deviceId: string
  incidentKey: Hash
  projection?: IncidentIncentive | null
  transaction: ReturnType<typeof useIncentiveTransaction>
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
  const indexedFlags = flags
    ? Number(flags.timely_ack) +
      Number(flags.ack_rewarded) * 2 +
      Number(flags.resolve_settled) * 4 +
      Number(flags.ack_slashed) * 8 +
      Number(flags.relay_slashed) * 16
    : undefined
  const projectionValid = Boolean(api.data && projection?.incident_key === incidentKey)

  const isUrgent = remaining !== undefined && remaining < 180n && remaining >= 0n
  const isOverdue = remaining !== undefined && remaining < 0n
  const countdownMinutes = remaining !== undefined && remaining >= 0n ? remaining / 60n : 0n
  const countdownSeconds = remaining !== undefined && remaining >= 0n ? remaining % 60n : 0n
  const countdownDisplay = `${String(countdownMinutes).padStart(2, '0')}:${String(countdownSeconds).padStart(2, '0')}`

  // Progress percentage (based on 30 min max window = 1800s)
  const progressPct =
    remaining !== undefined && remaining > 0n
      ? Math.min(100, Math.max(5, Number((remaining * 100n) / 1800n)))
      : 0

  return (
    <IncentivesCard title="Khuyến khích & Thưởng phạt (Incentives)">
      <IncentivesGuardNotice guard={chain.guard} />
      {token.isError ? <p role="alert" className="text-danger text-[13px]">RPC token lỗi: {token.error.message}</p> : null}
      {device.isError ? <p role="alert" className="text-danger text-[13px]">RPC device incentives lỗi: {device.error.message}</p> : null}
      {chain.guard.status === 'ready' && chain.isPending ? (
        <p className="text-[13px] text-ink-3">Đang đọc pendingSettlement từ chain…</p>
      ) : null}
      {chain.isError ? (
        <p role="alert" className="text-danger text-[13px]">RPC settlement lỗi: {chain.error.message}</p>
      ) : s ? (
        <>
          {!s.exists ? (
            <p className="text-[13px] text-ink-3">Sự cố chưa tồn tại trên chain.</p>
          ) : !s.covered ? (
            <p className="text-[13px] text-ink-3">Sự cố trước khi incentives được kích hoạt.</p>
          ) : (
            <div className="flex flex-col gap-3">
              {/* Prominent Countdown Box */}
              <div
                className={`rounded-2xl border p-4 transition-all ${
                  isOverdue
                    ? 'border-danger-bright/40 bg-danger-tint/50'
                    : isUrgent
                      ? 'border-danger-bright/50 bg-danger-tint/30 shadow-[0_0_0_3px_rgba(255,59,74,0.15)]'
                      : 'border-brand-bright/30 bg-gradient-to-br from-paper to-brand-tint/30'
                }`}
              >
                <div className="flex items-center justify-between text-[12px]">
                  <span className="font-semibold text-ink-2 uppercase tracking-wide">
                    {isOverdue ? 'Hạn xác nhận: Quá hạn' : 'Thời hạn xác nhận'}
                  </span>
                  <span
                    className={`rounded-pill px-2.5 py-0.5 font-mono text-[11px] font-bold ${
                      isOverdue
                        ? 'bg-danger text-paper'
                        : isUrgent
                          ? 'bg-danger-bright text-paper animate-pulse'
                          : 'bg-brand-tint text-brand'
                    }`}
                  >
                    {isOverdue ? 'OVERDUE' : isUrgent ? 'URGENT' : 'ON TIME: +5 ASAFE'}
                  </span>
                </div>

                <div className="my-2 flex items-baseline gap-2">
                  <span
                    className={`font-mono text-[36px] font-medium tracking-tight ${
                      isOverdue || isUrgent ? 'text-danger' : 'text-ink'
                    }`}
                  >
                    {isOverdue ? 'Quá hạn' : countdownDisplay}
                  </span>
                </div>

                {/* Visual Progress Bar */}
                <div className="h-2 w-full overflow-hidden rounded-full bg-line-2">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      isOverdue
                        ? 'bg-danger w-full'
                        : isUrgent
                          ? 'bg-danger-bright'
                          : 'bg-brand-bright'
                    }`}
                    style={{ width: `${progressPct}%` }}
                  />
                </div>

                {/* Canonical test-id paragraph preserved for test assertions */}
                <p
                  className={`mt-2 text-[12.5px] ${
                    remaining !== undefined && remaining < 180n ? 'text-danger font-medium' : 'text-ink-2'
                  }`}
                  data-testid="ack-countdown"
                >
                  {remaining !== undefined && remaining >= 0n
                    ? `Hạn acknowledge: ${String(remaining / 60n).padStart(2, '0')}:${String(remaining % 60n).padStart(2, '0')}`
                    : 'Quá hạn, không có thưởng ack; có thể bị phạt.'}
                </p>
              </div>

              {/* Settlement summary & status badges */}
              <div className="rounded-xl border border-line-2 bg-canvas/60 p-3 text-[12.5px]">
                <p className="font-mono text-[11.5px] text-ink-3">
                  Canonical settlement flags: {s.flags} · Relay delay: {String(s.relayDelay)} giây
                </p>

                <div className="mt-2 flex flex-wrap gap-1.5">
                  {s.flags & 2 ? (
                    <span className="inline-flex items-center gap-1 rounded-pill bg-brand-tint px-2.5 py-0.5 font-semibold text-brand">
                      ✓ Chain: đã thưởng ack
                    </span>
                  ) : null}
                  {s.flags & 4 ? (
                    <span className="inline-flex items-center gap-1 rounded-pill bg-accent-tint px-2.5 py-0.5 font-semibold text-accent">
                      ✓ Chain: resolve đã settlement (thưởng hoặc skipped)
                    </span>
                  ) : null}
                  {s.flags & 8 ? (
                    <span className="inline-flex items-center gap-1 rounded-pill bg-danger-tint px-2.5 py-0.5 font-semibold text-danger">
                      ✕ Chain: owner đã bị phạt
                    </span>
                  ) : null}
                  {s.flags & 16 ? (
                    <span className="inline-flex items-center gap-1 rounded-pill bg-danger-tint px-2.5 py-0.5 font-semibold text-danger">
                      ✕ Chain: relay trễ, operator bị phạt
                    </span>
                  ) : null}
                </div>

                {device.data ? (
                  <p className="mt-2 text-[12px] text-ink-2">
                    <span className="font-semibold text-ink">{device.data.rewardsToday}/{device.data.params.dailyRewardCap}</span> lượt thưởng hôm nay
                  </p>
                ) : null}

                <p className="mt-2 text-[11px] text-ink-4">
                  Server keeper tự xử lý R1/R2 và P1; có thể ghi nhận thủ công khi chưa settlement. P2 chỉ do keeper bên ngoài thực hiện.
                </p>
              </div>

              {s.canRecordAck ? (
                <PrimaryButton
                  label="Ghi nhận thưởng ack"
                  disabled={!transaction.guard.canWrite || isTransactionBusy(transaction.snapshot.stage)}
                  onClick={() => void transaction.run('recordTimelyAck', [incidentKey])}
                />
              ) : null}
              {s.canRecordResolve ? (
                <PrimaryButton
                  label="Ghi nhận thưởng resolve"
                  disabled={!transaction.guard.canWrite || isTransactionBusy(transaction.snapshot.stage)}
                  onClick={() => void transaction.run('recordTimelyResolve', [incidentKey])}
                />
              ) : null}
            </div>
          )}
        </>
      ) : null}

      {api.isError ? <p role="alert" className="text-danger text-[13px]">{api.error.message}</p> : api.isPending ? <p className="text-[13px] text-ink-3">Đang xác minh deployment API incentives…</p> : null}

      {projectionValid && projection ? (
        <div className="mt-2 border-t border-line-2 pt-3 text-[12.5px]">
          <p className="font-medium text-ink">
            API projection: {statusLabels[projection.reward_status] ?? projection.reward_status}
          </p>
          {s && indexedFlags !== s.flags ? (
            <p className="mt-1 text-warn text-[12px]">API chưa đồng bộ settlement; chain đã ghi nhận giao dịch.</p>
          ) : null}

          {projection.events.map((event) => (
            <p key={event.id} className="rounded-lg border border-line-2 bg-canvas px-2.5 py-1.5 text-[11.5px] text-ink-2">
              {event.name} {event.amount && decimals !== undefined ? `${formatUnits(BigInt(event.amount), decimals)} ASAFE` : ''}
              {event.name === 'RewardSkipped' ? ` · ${String(event.data.reason_name ?? event.data.reason ?? 'Skipped')}` : ''}
              {' · '}Keeper/owner: {event.account ?? '—'} · <ExplorerLink kind="tx" value={event.tx_hash} /> · <ExplorerLink kind="block" value={event.block_number} />
            </p>
          ))}
        </div>
      ) : null}

      <IncentiveTxStatus snapshot={transaction.snapshot} onDiscard={transaction.discardPending} />
    </IncentivesCard>
  )
}
