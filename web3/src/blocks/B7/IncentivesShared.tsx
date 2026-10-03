import type { ReactNode } from 'react'
import type { TransactionSnapshot } from '../../lib/incidentTransaction'
import { decodeError } from '../../lib/errors'
import type { IncentiveAction } from '../../lib/incentives'
import { ExplorerLink } from '../../components/ExplorerLink'
import type { useIncentivesGuard } from '../../lib/useIncentives'

export function NoticeBanner({ role, children }: { role?: 'alert'; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-[10px] bg-[#fdf4dc] px-3 py-2.5">
      <span className="mt-1.5 size-2 shrink-0 rounded-full bg-[#d97706]" />
      <p role={role} className="m-0 min-w-0 flex-1 text-[13px] leading-[1.5] text-[#7a4f00]">
        {children}
      </p>
    </div>
  )
}

export function IncentivesGuardNotice({ guard }: { guard: ReturnType<typeof useIncentivesGuard> }) {
  if (guard.status === 'unavailable') return <NoticeBanner>Token/incentives chưa được deploy trên mạng này.</NoticeBanner>
  if (guard.status === 'not_deployed') return <NoticeBanner role="alert">Token/incentives chưa được deploy trên RPC hiện hành.</NoticeBanner>
  if (guard.status === 'rpc_error') return <NoticeBanner role="alert">RPC incentives không khả dụng. Không thể đọc dữ liệu chain.</NoticeBanner>
  if (guard.status === 'mismatch') return <NoticeBanner role="alert">Sai mạng/domain/deployment incentives.</NoticeBanner>
  if (guard.status === 'loading') return <NoticeBanner>Đang kiểm tra deployment incentives…</NoticeBanner>
  if (!guard.account.isConnected) return <NoticeBanner>Kết nối ví để thực hiện giao dịch incentives.</NoticeBanner>
  if (!guard.canWrite) return <NoticeBanner role="alert">Sai mạng hoặc RPC ví chưa được xác minh.</NoticeBanner>
  return null
}
export function IncentivesCard({ title, children }: { title: string; children: ReactNode }) {
  return <section className="my-4 space-y-3 rounded-card border border-line bg-paper p-5"><h2 className="font-semibold">{title}</h2>{children}</section>
}
export function IncentiveTxStatus({ snapshot, onDiscard }: { snapshot: TransactionSnapshot<IncentiveAction>; onDiscard?: () => void }) {
  const messages: Record<string, string> = { simulating: 'Đang mô phỏng…', awaiting_wallet: 'Chờ xác nhận trong ví…',
    submitted: 'Đã gửi giao dịch.', confirming: 'Chờ receipt on-chain…', indexing: 'Chain đã xác nhận, đang làm mới dữ liệu…',
    success: 'Đã xác nhận trên chain.', cancelled: 'Đã hủy trong ví, có thể thử lại.', error: 'Giao dịch chưa hoàn tất.' }
  return <div role="status">
    {snapshot.stage !== 'idle' ? <p>{messages[snapshot.stage]}</p> : null}
    {snapshot.error ? <p role="alert">{decodeError(snapshot.error).message}</p> : null}
    {snapshot.apiSyncDelayed ? <p>Đã ghi trên chain, API đang cập nhật.</p> : null}
    {snapshot.txHash ? <p>Tx: <ExplorerLink kind="tx" value={snapshot.txHash} /></p> : null}
    {onDiscard && snapshot.stage === 'error' && snapshot.txHash ? <>
      <p>Chỉ bỏ qua khi giao dịch đã rớt khỏi mempool, nếu không thao tác có thể chạy hai lần.</p>
      <button type="button" onClick={onDiscard}>Bỏ qua giao dịch đang chờ</button>
    </> : null}
  </div>
}
