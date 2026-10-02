// Ported from app_new/src/components/shell/AtmosphereAppBar.tsx, restyled
// 2026-10-02 to match tmp/base/Warden Mockups.dc.html's header bar layout
// (nav pill, white bar with a bottom border instead of blending into the
// page background) -- the logo mark itself stays DotLogo, Smart Air's real
// mark shared with app/app_new, not Warden's placeholder badge+diamond.
// No safe-area inset handling here (that's an RN/iOS notch concern, not a
// browser one).
import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { DotLogo } from './DotLogo'

type AppBarProps =
  | { variant: 'brand'; actions?: ReactNode }
  | { variant: 'back'; title: string; actions?: ReactNode; onBack: () => void }

export function AppBar(props: AppBarProps) {
  if (props.variant === 'brand') {
    return (
      <div className="flex h-14 items-center justify-between border-b border-line bg-paper px-4">
        <div className="flex items-center gap-7">
          <div className="flex items-center gap-2.5">
            <DotLogo size={24} color="#1fe07a" />
            <span className="text-base font-bold tracking-wide text-ink uppercase">smart air</span>
          </div>
          <nav className="flex items-center gap-1 text-[14px]">
            <span className="rounded-pill bg-line-2 px-3 py-1.5 font-medium text-ink">Thiết bị</span>
          </nav>
        </div>
        <div className="flex items-center gap-2">{props.actions}</div>
      </div>
    )
  }

  return (
    <div className="flex h-14 items-center justify-between border-b border-line bg-paper px-4">
      <div className="flex items-center gap-2">
        <button type="button" onClick={props.onBack} className="mr-1 p-2 -m-2">
          <ArrowLeft className="size-[22px] text-ink" aria-hidden />
        </button>
        <span className="truncate text-[17px] font-semibold text-ink">{props.title}</span>
      </div>
      <div className="flex items-center gap-2">{props.actions}</div>
    </div>
  )
}
