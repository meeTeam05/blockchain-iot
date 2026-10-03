import type { ReactNode } from 'react'
import { useChainNow } from '../../lib/useChainNow'
import { formatUnits, type Hash } from 'viem'
import { useCanonicalDeviceIncentives, useSettlement, useTokenWallet } from '../../lib/useIncentives'
import { useIncentivesApi, type IncidentIncentive, type IncentiveParams } from '../../lib/incentivesApi'
import type { useIncentiveTransaction } from '../../lib/useIncentiveTransaction'
import { isTransactionBusy } from '../../lib/incidentTransaction'
import { Panel } from '../../components/ui/Panel'
import { ExplorerLink } from '../../components/ExplorerLink'
import { IncentivesGuardNotice, IncentiveTxStatus } from '../B7/IncentivesShared'

const statusLabels: Record<string, string> = { none: 'Chưa có settlement được index', ack_rewarded: 'Đã thưởng ack',
  resolved_rewarded: 'Đã thưởng resolve', over_cap: 'Vượt trần ngày: không thưởng', slashed: 'Owner đã bị phạt',
  late_relay_slashed: 'Relay trễ: operator bị phạt' }
function RecordButton({ label, disabled, onClick }: { label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="h-9 cursor-pointer rounded-[10px] border border-[#16803c] bg-white px-3.5 text-[13px] font-semibold text-[#16803c] transition-colors hover:bg-[#f0faf3] disabled:cursor-not-allowed disabled:border-[#e3e8e1] disabled:text-[#a3ada5]"
    >
      {label}
    </button>
  )
}

function formatDeadline(epochSeconds: bigint) {
  const date = new Date(Number(epochSeconds) * 1000)
  const time = date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  const day = date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' })
  return `${time} · ${day}`
}

export function IncidentIncentives({
  deviceId,
  incidentKey,
  projection,
  transaction,
  resolved = false,
  actions,
  note,
  footer,
}: {
  deviceId: string
  incidentKey: Hash
  projection?: IncidentIncentive | null
  transaction: ReturnType<typeof useIncentiveTransaction>
  // A resolved incident swaps the ack countdown for a done summary.
  resolved?: boolean
  // Owner controls and the permission note render inside the "Xử lý sự cố" card.
  actions?: ReactNode
  note?: ReactNode
  footer?: ReactNode
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

  const isOverdue = remaining !== undefined && remaining < 0n
  const countdownMinutes = remaining !== undefined && remaining >= 0n ? remaining / 60n : 0n
  const countdownSeconds = remaining !== undefined && remaining >= 0n ? remaining % 60n : 0n
  const countdownDisplay = `${String(countdownMinutes).padStart(2, '0')}:${String(countdownSeconds).padStart(2, '0')}`
  const timerColor = isOverdue || (remaining !== undefined && remaining <= 60n) ? '#c81e3a' : remaining !== undefined && remaining <= 300n ? '#d97706' : '#16a34a'

  // Progress percentage (based on 30 min max window = 1800s)
  const progressPct =
    remaining !== undefined && remaining > 0n
      ? Math.min(100, Math.max(5, Number((remaining * 100n) / 1800n)))
      : 0
  const penalty = device.data && decimals !== undefined ? formatUnits(device.data.params.missedAckPenalty, decimals) : undefined

  const settled = s?.exists && s.covered ? s : undefined
  // Only claim what the canonical settlement flags prove: bit 8 = owner slashed, bit 1 = timely ack.
  const resolvedNote = settled
    ? settled.flags & 8
      ? 'Xác nhận trễ · owner đã bị phạt'
      : settled.flags & 1
        ? 'Xác nhận đúng hạn · không bị phạt'
        : undefined
    : undefined
  const details = [
    token.isError ? (
      <p key="token-error" role="alert" className="m-0 text-[13px] text-[#c81e3a]">RPC token lỗi: {token.error.message}</p>
    ) : null,
    device.isError ? (
      <p key="device-error" role="alert" className="m-0 text-[13px] text-[#c81e3a]">RPC device incentives lỗi: {device.error.message}</p>
    ) : null,
    chain.isError ? (
      <p key="settlement-error" role="alert" className="m-0 text-[13px] text-[#c81e3a]">RPC settlement lỗi: {chain.error.message}</p>
    ) : null,
    chain.guard.status === 'ready' && chain.isPending ? (
      <p key="settlement-pending" className="m-0 text-[13px] text-[#5d6a60]">Đang đọc pendingSettlement từ chain…</p>
    ) : null,
    settled ? (
      <div key="settlement" className="flex flex-col gap-2">
        <p className="m-0 font-mono text-[11.5px] text-[#8a958c]">
          Canonical settlement flags: {settled.flags} · Relay delay: {String(settled.relayDelay)} giây
        </p>
        <div className="flex flex-wrap gap-1.5">
          {settled.flags & 2 ? (
            <span className="rounded-full bg-[#e8faef] px-2.5 py-0.5 text-[12px] font-semibold text-[#0f7638] before:mr-1 before:content-['✓']">
              Chain: đã thưởng ack
            </span>
          ) : null}
          {settled.flags & 4 ? (
            <span className="rounded-full bg-[#e2f9fc] px-2.5 py-0.5 text-[12px] font-semibold text-[#00606f] before:mr-1 before:content-['✓']">
              Chain: resolve đã settlement (thưởng hoặc skipped)
            </span>
          ) : null}
          {settled.flags & 8 ? (
            <span className="rounded-full bg-[#fff1f3] px-2.5 py-0.5 text-[12px] font-semibold text-[#a3122e] before:mr-1 before:content-['✕']">
              Chain: owner đã bị phạt
            </span>
          ) : null}
          {settled.flags & 16 ? (
            <span className="rounded-full bg-[#fff1f3] px-2.5 py-0.5 text-[12px] font-semibold text-[#a3122e] before:mr-1 before:content-['✕']">
              Chain: relay trễ, operator bị phạt
            </span>
          ) : null}
        </div>
        <p className="m-0 text-[11px] text-[#8a958c]">
          Keeper tự xử lý R1, R2, P1. P2 do keeper bên ngoài thực hiện.
        </p>
        {settled.canRecordAck ? (
          <RecordButton
            label="Ghi nhận thưởng ack"
            disabled={!transaction.guard.canWrite || isTransactionBusy(transaction.snapshot.stage)}
            onClick={() => void transaction.run('recordTimelyAck', [incidentKey])}
          />
        ) : null}
        {settled.canRecordResolve ? (
          <RecordButton
            label="Ghi nhận thưởng resolve"
            disabled={!transaction.guard.canWrite || isTransactionBusy(transaction.snapshot.stage)}
            onClick={() => void transaction.run('recordTimelyResolve', [incidentKey])}
          />
        ) : null}
      </div>
    ) : null,
    api.isError ? (
      <p key="api-error" role="alert" className="m-0 text-[13px] text-[#c81e3a]">{api.error.message}</p>
    ) : api.isPending ? (
      <p key="api-pending" className="m-0 text-[13px] text-[#5d6a60]">Đang xác minh deployment API incentives…</p>
    ) : null,
    projectionValid && projection ? (
      <div key="projection" className="flex flex-col gap-1.5 text-[12.5px]">
        <p className="m-0 font-medium text-[#17201a]">
          API projection: {statusLabels[projection.reward_status] ?? projection.reward_status}
        </p>
        {s && indexedFlags !== s.flags ? (
          <p className="m-0 text-[12px] text-[#7a4f00]">API chưa đồng bộ settlement; chain đã ghi nhận giao dịch.</p>
        ) : null}

        {projection.events.map((event) => (
          <p key={event.id} className="m-0 rounded-lg bg-[#f6f8f5] px-2.5 py-1.5 text-[11.5px] text-[#3d4a40]">
            {event.name} {event.amount && decimals !== undefined ? `${formatUnits(BigInt(event.amount), decimals)} ASAFE` : ''}
            {event.name === 'RewardSkipped' ? ` · ${String(event.data.reason_name ?? event.data.reason ?? 'Skipped')}` : ''}
            {' · '}Keeper/owner: {event.account ?? '—'} · <ExplorerLink kind="tx" value={event.tx_hash} /> · <ExplorerLink kind="block" value={event.block_number} />
          </p>
        ))}
      </div>
    ) : null,
    transaction.snapshot.stage !== 'idle' ? (
      <IncentiveTxStatus key="tx-status" snapshot={transaction.snapshot} onDiscard={transaction.discardPending} />
    ) : null,
  ]

  return (
    <>
      <Panel>
        <div className="flex flex-col gap-3.5 px-[22px] py-5">
          <h2 className="m-0 text-[16px] font-semibold text-[#17201a]">Xử lý sự cố</h2>

          {s && !s.exists ? (
            <p className="m-0 text-[13px] text-[#5d6a60]">Sự cố chưa tồn tại trên chain.</p>
          ) : s && !s.covered ? (
            <p className="m-0 text-[13px] text-[#5d6a60]">Sự cố trước khi incentives được kích hoạt.</p>
          ) : s && resolved ? (
            <div className="flex items-center gap-3 rounded-xl bg-[#f0faf3] p-3.5" data-testid="incident-resolved">
              <span className="grid size-7 shrink-0 place-items-center rounded-full bg-[#dcf5e3] font-bold text-[#15803d]" aria-hidden>✓</span>
              <div className="flex flex-col gap-0.5">
                <span className="text-[14px] font-semibold text-[#15803d]">Đã xử lý</span>
                {resolvedNote ? <span className="text-[12px] text-[#5d6a60]">{resolvedNote}</span> : null}
              </div>
            </div>
          ) : s ? (
            <>
              <span className="text-[12px] text-[#5d6a60]">Hạn xác nhận</span>
              <div
                data-testid="ack-countdown"
                className="font-mono text-[44px] font-medium leading-none tracking-[-0.02em]"
                style={{ color: timerColor }}
              >
                <span className="sr-only">Hạn acknowledge: </span>
                {isOverdue ? 'Quá hạn' : countdownDisplay}
              </div>
              <div className="h-1.5 overflow-hidden rounded-[3px] bg-[#eef1ec]">
                <div
                  className="h-full rounded-[3px] transition-all duration-500"
                  style={{ width: `${isOverdue ? 100 : progressPct}%`, backgroundColor: timerColor }}
                />
              </div>
              <div className="flex flex-wrap justify-between gap-3 text-[12px] text-[#5d6a60]">
                <span>Hạn chót {formatDeadline(s.ackDeadline)}</span>
                {penalty ? <span>Quá hạn: <b className="text-[#c81e3a]">−{penalty} ASAFE</b></span> : null}
              </div>
              {isOverdue ? (
                <p className="m-0 text-[12.5px] text-[#c81e3a]">Quá hạn, không có thưởng ack; có thể bị phạt.</p>
              ) : null}
            </>
          ) : null}

          {actions}
          {note}
        </div>
      </Panel>

      <Panel>
        <div className="flex flex-col gap-3 px-[22px] py-[18px]">
          <h2 className="m-0 text-[16px] font-semibold text-[#17201a]">Thưởng phạt sự cố</h2>
          <IncentivesGuardNotice guard={chain.guard} />
          {details}
          {footer}
        </div>
      </Panel>
    </>
  )
}
