import { AppBar } from '../components/ui/AppBar'
import { SessionActions } from '../blocks/B1/SessionActions'
import { DeviceList } from '../blocks/B2/DeviceList'

export function HomePage() {
  return (
    <>
      <AppBar variant="brand" actions={<SessionActions />} />
      <div className="mx-auto w-full max-w-3xl p-6">
        <DeviceList />
      </div>
    </>
  )
}
