import { AppBar } from '../components/ui/AppBar'
import { LoginForm } from '../blocks/B1/LoginForm'
import { ConnectWallet } from '../blocks/B1/ConnectWallet'
import { DeviceList } from '../blocks/B2/DeviceList'
import { useAuth } from '../lib/authStore'

export function HomePage() {
  const { accessToken } = useAuth()

  if (!accessToken) {
    return (
      <>
        <AppBar variant="brand" />
        <div className="flex min-h-[calc(100vh-56px)] items-center justify-center p-6">
          <div className="w-full max-w-sm rounded-card border border-line bg-paper p-8 shadow-[0_6px_24px_-8px_rgba(14,18,16,0.08)]">
            <LoginForm />
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <AppBar variant="brand" actions={<ConnectWallet />} />
      <div className="mx-auto w-full max-w-3xl p-6">
        <DeviceList />
      </div>
    </>
  )
}
