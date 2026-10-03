// Page frame shared by the device screens (list, device, incident): brand
// AppBar plus the 2200px content column from tmp/06_web/device/Thiet bi.dc.html.
import type { ReactNode } from 'react'
import { AppBar } from './AppBar'

export function PageShell({ actions, children }: { actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#e8ece6] flex flex-col font-['Be_Vietnam_Pro',system-ui,sans-serif] text-[#17201a]">
      <AppBar variant="brand" actions={actions} />
      <main className="w-full max-w-[2200px] mx-auto px-8 pt-7 pb-16 flex flex-col gap-6">{children}</main>
    </div>
  )
}
