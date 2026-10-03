// Ported from app_new/src/components/atoms/Pill.tsx. The "Warden" token set
// (src/index.css) already defines brand/warn/accent/danger as the dark,
// text-safe variant of each color -- no per-tone hex override needed here
// (unlike the old Atmosphere tokens, where decision #21 had to darken each
// tone's text color by hand for AA contrast).
export type PillTone = 'online' | 'offline' | 'warn' | 'brand' | 'accent' | 'danger'

const TONE_CLASSES: Record<PillTone, string> = {
  online: 'bg-online/15 text-brand',
  offline: 'bg-ink-3/15 text-ink-2',
  warn: 'bg-warn-tint text-warn',
  brand: 'bg-brand-tint text-brand',
  accent: 'bg-accent-tint text-accent',
  danger: 'bg-danger-tint text-danger',
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
