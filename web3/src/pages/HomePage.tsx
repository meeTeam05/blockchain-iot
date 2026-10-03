import { AppBar } from '../components/ui/AppBar'
import { SessionActions } from '../blocks/B1/SessionActions'
import { DeviceList } from '../blocks/B2/DeviceList'

export function HomePage() {
  return (
    <div className="min-h-screen bg-[#e8ece6] flex flex-col font-['Be_Vietnam_Pro',system-ui,sans-serif] text-[#17201a]">
      <AppBar variant="brand" actions={<SessionActions />} />
      <main className="w-full max-w-[1120px] mx-auto px-6 py-10 pb-16 flex flex-col gap-6">
        <div className="flex flex-col gap-1.5">
          <h1 className="m-0 text-[28px] font-bold tracking-[-0.01em] text-[#17201a]">Thiết bị</h1>
          <p className="m-0 text-[14px] text-[#5d6a60]">Quản lý cảm biến và theo dõi trạng thái hoạt động.</p>
        </div>
        <DeviceList />
      </main>
    </div>
  )
}
