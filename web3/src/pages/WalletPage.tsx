import { useState } from 'react'
import { PageShell } from '../components/ui/PageShell'
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
    <PageShell actions={<SessionActions />}>
      <div className="flex flex-col gap-1.5">
        <h1 className="m-0 text-[28px] font-bold tracking-[-0.01em] text-[#17201a]">Ví Token</h1>
        <p className="m-0 text-[14px] text-[#5d6a60]">Số dư ASAFE và bond của thiết bị.</p>
      </div>
      <TokenWallet />
      {devices.isPending ? <p className="m-0 text-[13px] text-[#5d6a60]">Đang tải thiết bị…</p> : null}
      {devices.isError ? <p role="alert" className="m-0 text-[13px] text-[#c81e3a]">{devices.error.message}</p> : devices.data?.length === 0 ? <p className="m-0 text-[13px] text-[#5d6a60]">Chưa có thiết bị.</p> : null}
      {devices.data?.length ? (
        <label className="flex flex-wrap items-center gap-3 text-[14px] font-semibold text-[#17201a]">
          Thiết bị
          <select aria-label="Thiết bị bond" value={deviceId} onChange={(e) => setChosen(e.target.value)}
            className="h-9 max-w-full cursor-pointer rounded-[10px] border border-[#dfe4dc] bg-white px-3 text-[13px] font-medium text-[#17201a] outline-none focus:border-[#16803c]">
            {devices.data.map((device) => <option key={device.id} value={device.id}>{device.name} ({device.id})</option>)}
          </select>
        </label>
      ) : null}
      {deviceId ? (
        <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <BondControls key={deviceId} deviceId={deviceId} />
          <DeviceIncentives deviceId={deviceId} />
        </div>
      ) : null}
    </PageShell>
  )
}
