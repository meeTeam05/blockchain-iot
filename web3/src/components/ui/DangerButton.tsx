// Ported from app_new/src/components/atoms/DangerButton.tsx. No loading state
// in the original -- use PrimaryButton for the main tx flow, this is for
// decode-error retry actions only.
interface DangerButtonProps {
  label: string
  onClick: () => void
}

export function DangerButton({ label, onClick }: DangerButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-[52px] items-center justify-center rounded-button bg-danger px-6 text-[15px] font-semibold text-paper"
    >
      {label}
    </button>
  )
}
