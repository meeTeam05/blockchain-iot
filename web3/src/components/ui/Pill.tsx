// Ported from app_new/src/components/atoms/Pill.tsx.
// Text colors are web-only AA-contrast overrides (decision #21 in
// tmp/02_decisions/2026-10-01_task5-dapp-incident-decisions.md) -- background
// tints are unchanged from app_new. Do not port these text overrides back
// into app_new/src/theme/tokens.ts; that file is out of scope for Task 5.
export type PillTone = 'online' | 'offline' | 'warn' | 'brand' | 'accent' | 'danger'

const TONE_CLASSES: Record<PillTone, string> = {
  online: 'bg-online/15 text-[#17765A]',
  offline: 'bg-ink-3/15 text-[#5C6D69]',
  warn: 'bg-warn-tint text-[#A65A13]',
  brand: 'bg-brand-tint text-brand',
  accent: 'bg-accent-tint text-[#1A5FEF]',
  danger: 'bg-danger-tint text-[#BF3923]',
}

interface PillProps {
  label: string
  tone: PillTone
}

export function Pill({ label, tone }: PillProps) {
  return (
    <span
      className={`inline-flex items-start rounded-pill px-2.5 py-1 font-sans text-[11px] font-semibold tracking-[0.2px] uppercase ${TONE_CLASSES[tone]}`}
    >
      {label}
    </span>
  )
}
