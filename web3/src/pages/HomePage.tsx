import { PageShell } from '../components/ui/PageShell'
import { SessionActions } from '../blocks/B1/SessionActions'
import { DeviceList } from '../blocks/B2/DeviceList'

export function HomePage() {
  return (
    <PageShell actions={<SessionActions />}>
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-[28px] font-bold tracking-[-0.01em] text-[#17201a]">Thiết bị</h1>
        <p className="m-0 text-[14px] text-[#5d6a60]">Quản lý cảm biến và theo dõi trạng thái hoạt động.</p>
      </div>
      <DeviceList />
    </PageShell>
  )
}
