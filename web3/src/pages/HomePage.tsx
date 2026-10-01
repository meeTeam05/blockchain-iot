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
        <div className="mx-auto w-full max-w-sm p-6">
          <LoginForm />
        </div>
      </>
    )
  }

  return (
    <>
      <AppBar variant="brand" actions={<ConnectWallet />} />
      <div className="mx-auto w-full max-w-sm p-6">
        <DeviceList />
      </div>
    </>
  )
}
