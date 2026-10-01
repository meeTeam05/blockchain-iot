// Ported from app_new/src/components/atoms/ConfirmDialog.tsx, rebuilt on
// Headless UI's Dialog for free focus-trap/ESC-to-close/click-outside
// (decision #16) instead of a bare backdrop + div. Maps onto the
// <TxButton> confirmation step before simulateContract.
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react'

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  destructive?: boolean
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Xác nhận',
  destructive = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onClose={onCancel} className="relative z-50">
      <DialogBackdrop className="fixed inset-0 bg-black/40" />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel className="w-[85%] max-w-sm rounded-2xl bg-paper p-5">
          <DialogTitle className="text-[22px] font-bold tracking-[-0.4px] text-ink">{title}</DialogTitle>
          <p className="mt-2 text-[15px] text-ink-2">{message}</p>
          <div className="mt-5 flex justify-end gap-4">
            <button type="button" onClick={onCancel} className="px-1 py-2 text-[15px] text-ink-3">
              Hủy
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className={`px-1 py-2 text-[15px] font-semibold ${destructive ? 'text-danger' : 'text-brand'}`}
            >
              {confirmLabel}
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  )
}
