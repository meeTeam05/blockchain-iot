// Ported from app/src/components/atoms/PrimaryButton.tsx. Maps directly
// onto <TxButton>'s simulating/awaiting_wallet/pending states via `loading`.
import { Loader2 } from 'lucide-react'

interface PrimaryButtonProps {
  label: string
  loading?: boolean
  disabled?: boolean
  onClick: () => void
}

export function PrimaryButton({ label, loading = false, disabled = false, onClick }: PrimaryButtonProps) {
  const inactive = loading || disabled
  return (
    <button
      type="button"
      onClick={inactive ? undefined : onClick}
      disabled={inactive}
      className="flex h-[52px] items-center justify-center rounded-button bg-brand-bright px-6 text-[15px] font-semibold text-ink disabled:opacity-50"
    >
      {loading ? <Loader2 className="size-5 animate-spin" aria-hidden /> : label}
    </button>
  )
}
