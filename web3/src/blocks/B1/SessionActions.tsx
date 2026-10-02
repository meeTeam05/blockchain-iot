import { useQueryClient } from '@tanstack/react-query'
import { ConnectWallet } from './ConnectWallet'
import { useAuth } from '../../lib/authStore'

export function SessionActions() {
  const { logout } = useAuth()
  const queryClient = useQueryClient()

  return (
    <div className="flex items-center gap-2">
      <ConnectWallet />
      <button
        type="button"
        className="rounded-pill border border-line px-3 py-1.5 text-[13px] font-semibold text-ink-2"
        onClick={() => {
          void logout().finally(() => queryClient.clear())
        }}
      >
        Đăng xuất
      </button>
    </div>
  )
}
