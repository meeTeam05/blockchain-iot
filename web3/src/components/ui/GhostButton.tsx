// Ported from app_new/src/components/atoms/GhostButton.tsx.
interface GhostButtonProps {
  label: string
  onClick: () => void
}

export function GhostButton({ label, onClick }: GhostButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-[52px] items-center justify-center rounded-button border-[1.5px] border-brand bg-paper px-6 text-[15px] font-semibold text-brand"
    >
      {label}
    </button>
  )
}
