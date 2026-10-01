// Ported from app_new/src/components/atoms/EmptyState.tsx. Used for "chưa
// có incident" / "chưa đăng ký on-chain" states (B2/B3).
import type { LucideIcon } from 'lucide-react'
import { PrimaryButton } from './PrimaryButton'
import { GhostButton } from './GhostButton'

interface EmptyStateProps {
  icon: LucideIcon
  title: string
  body: string
  primaryAction?: string
  onPrimaryAction?: () => void
  secondaryAction?: string
  onSecondaryAction?: () => void
}

export function EmptyState({
  icon: Icon,
  title,
  body,
  primaryAction,
  onPrimaryAction,
  secondaryAction,
  onSecondaryAction,
}: EmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
      <div className="flex size-[120px] items-center justify-center rounded-full bg-line-2">
        <Icon className="size-12 text-ink-3" aria-hidden />
      </div>
      <h1 className="mt-6 text-[26px] font-bold tracking-[-0.5px] text-ink">{title}</h1>
      <p className="mt-3 text-[15px] text-ink-2">{body}</p>
      {primaryAction && onPrimaryAction ? (
        <div className="mt-8 w-full max-w-xs">
          <PrimaryButton label={primaryAction} onClick={onPrimaryAction} />
        </div>
      ) : null}
      {secondaryAction && onSecondaryAction ? (
        <div className="mt-3 w-full max-w-xs">
          <GhostButton label={secondaryAction} onClick={onSecondaryAction} />
        </div>
      ) : null}
    </div>
  )
}
