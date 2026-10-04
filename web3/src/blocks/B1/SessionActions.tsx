import { useQueryClient } from '@tanstack/react-query'
import { ConnectWallet } from './ConnectWallet'
import { useAuth } from '../../lib/authStore'

export function SessionActions() {
  const { accessToken, logout } = useAuth()
  const queryClient = useQueryClient()

  return (
    <div className="flex items-center gap-2">
      <ConnectWallet />
      {accessToken ? (
        <button
          type="button"
          className="h-[36px] px-4 rounded-full border border-[#dfe4dc] bg-white text-[13px] font-medium text-[#4f5b52] hover:bg-[#f4f6f3] transition-colors cursor-pointer flex items-center justify-center whitespace-nowrap"
          onClick={() => {
            void logout().finally(() => queryClient.clear())
          }}
        >
          Đăng xuất
        </button>
      ) : null}
    </div>
  )
}
