// Full-width action button used by the owner and bond controls (green primary or outlined secondary).
export function ActionButton({
  label,
  variant,
  loading = false,
  disabled,
  onClick,
}: {
  label: string
  variant: 'primary' | 'outline'
  loading?: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex h-10 items-center justify-center gap-2 rounded-[10px] text-[14px] font-semibold transition-colors disabled:cursor-not-allowed ${
        variant === 'primary'
          ? 'border-0 bg-[#16803c] text-white hover:bg-[#0f5f2c] disabled:bg-[#e3e8e1] disabled:text-[#8a958c]'
          : 'border border-[#dfe4dc] bg-white text-[#17201a] hover:bg-[#f4f6f3] disabled:border-[#e3e8e1] disabled:bg-white disabled:text-[#a3ada5]'
      }`}
    >
      {loading ? <span className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden /> : null}
      {label}
    </button>
  )
}
