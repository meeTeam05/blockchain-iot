import type { ReactNode } from 'react'
import type { TransactionSnapshot } from '../../lib/incidentTransaction'
import { decodeError } from '../../lib/errors'
import type { IncentiveAction } from '../../lib/incentives'
import { ExplorerLink } from '../../components/ExplorerLink'
import type { useIncentivesGuard } from '../../lib/useIncentives'

export function IncentivesGuardNotice({ guard }: { guard: ReturnType<typeof useIncentivesGuard> }) {
  if (guard.status === 'unavailable') return <p>Token/incentives chưa được deploy trên mạng này.</p>
  if (guard.status === 'not_deployed') return <p role="alert">Token/incentives chưa được deploy trên RPC hiện hành.</p>
  if (guard.status === 'rpc_error') return <p role="alert">RPC incentives không khả dụng. Không thể đọc dữ liệu chain.</p>
  if (guard.status === 'mismatch') return <p role="alert">Sai mạng/domain/deployment incentives.</p>
  if (guard.status === 'loading') return <p>Đang kiểm tra deployment incentives…</p>
  if (!guard.account.isConnected) return <p>Kết nối ví để thực hiện giao dịch incentives.</p>
  if (!guard.canWrite) return <p role="alert">Sai mạng hoặc RPC ví chưa được xác minh cho incentives.</p>
  return null
}
export function IncentivesCard({ title, children }: { title: string; children: ReactNode }) {
  return <section className="my-4 space-y-3 rounded-card border border-line bg-paper p-5"><h2 className="font-semibold">{title}</h2>{children}</section>
}
export function IncentiveTxStatus({ snapshot, onDiscard }: { snapshot: TransactionSnapshot<IncentiveAction>; onDiscard?: () => void }) {
  const messages: Record<string, string> = { simulating: 'Đang mô phỏng…', awaiting_wallet: 'Chờ xác nhận trong ví…',
    submitted: 'Đã gửi giao dịch.', confirming: 'Chờ receipt on-chain…', indexing: 'Chain đã xác nhận; làm mới dữ liệu…',
    success: 'Đã xác nhận trên chain.', cancelled: 'Bạn đã hủy yêu cầu trong ví; có thể tiếp tục.', error: 'Giao dịch chưa hoàn tất.' }
  return <div role="status">
    {snapshot.stage !== 'idle' ? <p>{messages[snapshot.stage]}</p> : null}
    {snapshot.error ? <p role="alert">{decodeError(snapshot.error).message}</p> : null}
    {snapshot.apiSyncDelayed ? <p>API đang chậm; giao dịch đã được ghi trên chain.</p> : null}
    {snapshot.txHash ? <p>Tx: <ExplorerLink kind="tx" value={snapshot.txHash} /></p> : null}
    {onDiscard && snapshot.stage === 'error' && snapshot.txHash ? <>
      <p>Chỉ bỏ qua khi giao dịch đã bị rớt khỏi mempool; nếu nó được đào sau đó, thao tác có thể thực hiện hai lần.</p>
      <button type="button" onClick={onDiscard}>Bỏ qua giao dịch đang chờ</button>
    </> : null}
  </div>
}
