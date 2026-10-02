// Ported from app_new/src/components/atoms/HistoryRow.tsx. Used for every
// row in B6 ("Lịch sử on-chain").
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Pill, type PillTone } from './Pill'

interface HistoryRowProps {
  icon: LucideIcon
  label: string
  sub: ReactNode
  badgeTone?: PillTone
  badgeLabel?: string
}

export function HistoryRow({ icon: Icon, label, sub, badgeTone, badgeLabel }: HistoryRowProps) {
  return (
    <div className="flex items-center px-4 py-3">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-line-2">
        <Icon className="size-5 text-ink-2" aria-hidden />
      </div>
      <div className="ml-3 min-w-0 flex-1">
        <p className="truncate text-[15px] font-medium text-ink">{label}</p>
        <p className="mt-0.5 text-[13px] text-ink-3">{sub}</p>
      </div>
      {badgeTone && badgeLabel ? <Pill label={badgeLabel} tone={badgeTone} /> : null}
    </div>
  )
}
