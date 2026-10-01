import { Link } from 'react-router'
import { Card } from '../../components/ui/Card'
import { Pill } from '../../components/ui/Pill'
import type { ApiDevice } from '../../lib/devicesApi'

interface ChainDevice {
  signer: string
  owner: string
  lastSequence: bigint
  hasLogged: boolean
  active: boolean
  exists: boolean
}

interface DeviceCardProps {
  device: ApiDevice
  chainDevice: ChainDevice | undefined
  connectedAddress: string | undefined
}

function shorten(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function DeviceCard({ device, chainDevice, connectedAddress }: DeviceCardProps) {
  const isOwner =
    chainDevice?.owner !== undefined &&
    connectedAddress !== undefined &&
    chainDevice.owner.toLowerCase() === connectedAddress.toLowerCase()

  return (
    <Link to={`/d/${device.id}`}>
      <Card className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[17px] font-semibold text-ink">{device.name}</span>
          <Pill tone={device.online ? 'online' : 'offline'} label={device.online ? 'online' : 'offline'} />
        </div>

        {!chainDevice?.exists ? (
          <Pill tone="offline" label="Chờ đăng ký on-chain" />
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Pill tone={chainDevice.active ? 'brand' : 'danger'} label={chainDevice.active ? 'active' : 'revoked'} />
              {isOwner ? <Pill tone="accent" label="Bạn" /> : null}
            </div>
            <p className="font-mono text-[13px] text-ink-3">
              owner {shorten(chainDevice.owner)} · lastSequence {chainDevice.lastSequence.toString()}
            </p>
          </>
        )}

        {device.open_incident_count !== undefined ? (
          <p className="text-[13px] text-ink-2">{device.open_incident_count} sự cố đang mở</p>
        ) : null}
      </Card>
    </Link>
  )
}
