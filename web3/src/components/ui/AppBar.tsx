// Ported from app_new/src/components/shell/AtmosphereAppBar.tsx. No safe-area
// inset handling here (that's an RN/iOS notch concern, not a browser one).
// Only the two variants docs/reference/ATMOSPHERE_WEB_DESIGN.md maps for Task 5 are
// ported -- `minimal` is not used by any B0-B6 page.
import type { ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { DotLogo } from './DotLogo'

type AppBarProps =
  | { variant: 'brand'; actions?: ReactNode }
  | { variant: 'back'; title: string; actions?: ReactNode; onBack: () => void }

export function AppBar(props: AppBarProps) {
  if (props.variant === 'brand') {
    return (
      <div className="flex h-14 items-center justify-between bg-bg px-4">
        <div className="flex items-center gap-2">
          <DotLogo size={24} color="#0F6B5C" />
          <span className="text-lg font-bold text-ink">smart-air</span>
        </div>
        <div className="flex items-center gap-2">{props.actions}</div>
      </div>
    )
  }

  return (
    <div className="flex h-14 items-center justify-between bg-bg px-4">
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
