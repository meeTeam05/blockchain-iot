// Section container + header used by the device / incident screens, matching
// tmp/06_web/device/Thiet bi.dc.html (white 18px card, hairline header rule).
import type { ReactNode } from 'react'

export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={`overflow-hidden rounded-[18px] border border-[#eef1ec] bg-white shadow-[0_1px_2px_rgba(20,40,25,0.05)] ${className}`}
    >
      {children}
    </section>
  )
}

export function PanelHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-[#eef1ec] px-6 py-[18px]">
      <h2 className="m-0 flex-1 text-[16px] font-semibold leading-[1.4] text-[#17201a]">{title}</h2>
      {right}
    </div>
  )
}

export type BadgeTone = 'red' | 'amber' | 'grey' | 'green' | 'cyan'

const BADGE_TONES: Record<BadgeTone, string> = {
  red: 'bg-[#fff1f3] text-[#a3122e]',
  amber: 'bg-[#fdf4dc] text-[#8a5a00]',
  grey: 'bg-[#eef1ec] text-[#4f5b52]',
  green: 'bg-[#e8faef] text-[#0f7638]',
  cyan: 'bg-[#e2f9fc] text-[#00606f]',
}

export function Badge({ label, tone }: { label: string; tone: BadgeTone }) {
  return (
    <span className={`rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.06em] ${BADGE_TONES[tone]}`}>
      {label}
    </span>
  )
}
