import { useState } from 'react'
import { AppBar } from '../components/ui/AppBar'
import { SessionActions } from '../blocks/B1/SessionActions'
import { TokenWallet } from '../blocks/B7/TokenWallet'
import { BondControls } from '../blocks/B8/BondControls'
import { DeviceIncentives } from '../blocks/B9/DeviceIncentives'
import { useDevices } from '../lib/devicesApi'

export function WalletPage() {
  const devices = useDevices()
  const [chosen, setChosen] = useState('')
  const deviceId = chosen || devices.data?.[0]?.id
  return (
    <>
      <AppBar variant="brand" actions={<SessionActions />} />
      <main className="mx-auto max-w-3xl p-6"><TokenWallet />
      {devices.isPending ? <p>Đang tải thiết bị…</p> : null}
      {devices.isError ? <p role="alert">{devices.error.message}</p> : devices.data?.length === 0 ? <p>Chưa có thiết bị.</p> : null}
      {devices.data?.length ? <label>Thiết bị<select aria-label="Thiết bị bond" value={deviceId} onChange={(e) => setChosen(e.target.value)}>
        {devices.data.map((device) => <option key={device.id} value={device.id}>{device.name} ({device.id})</option>)}
      </select></label> : null}
      {deviceId ? <><BondControls key={deviceId} deviceId={deviceId} /><DeviceIncentives deviceId={deviceId} /></> : null}
      </main>
    </>
  )
}
