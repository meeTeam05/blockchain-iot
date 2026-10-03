import { PageShell } from '../components/ui/PageShell'
import { SessionActions } from '../blocks/B1/SessionActions'
import { KeeperBoard } from '../blocks/B10/KeeperBoard'

export function KeeperPage() {
  return (
    <PageShell actions={<SessionActions />}>
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-[28px] font-bold tracking-[-0.01em] text-[#17201a]">Keeper</h1>
        <p className="m-0 text-[14px] text-[#5d6a60]">Sự cố quá hạn đang chờ phạt. Server tự phạt trễ xác nhận (P1); relay trễ (P2) cần phạt thủ công.</p>
      </div>
      <KeeperBoard />
    </PageShell>
  )
}
