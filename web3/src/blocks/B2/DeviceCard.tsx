import { Link } from 'react-router'
import { useLatestTelemetry, type ApiDevice } from '../../lib/devicesApi'
import { formatLastSeen } from '../../lib/deviceDisplay'

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

function Metric({ label, value, digits, unit, className = '' }: {
  label: string
  value: number | null | undefined
  digits: number
  unit: string
  className?: string
}) {
  const hasValue = typeof value === 'number' && Number.isFinite(value)
  return (
    <div className={`p-4 sm:px-6 sm:py-4.5 flex flex-col gap-1 border-[#eef1ec] ${className}`}>
      <span className="text-[12px] text-[#5d6a60]">{label}</span>
      <span
        data-testid={`metric-${label}`}
        className={`text-[22px] font-semibold ${hasValue ? 'text-[#17201a]' : 'text-[#a3ada5]'}`}
      >
        {hasValue ? value.toFixed(digits) : '—'}{' '}
        <span className="text-[12px] font-medium text-[#7a867c]">{unit}</span>
      </span>
    </div>
  )
}

function formatShortId(id: string): string {
  if (id.length <= 16) return id
  return `${id.slice(0, 8)}…${id.slice(-4)}`
}

export function DeviceCard({ device, chainDevice, connectedAddress }: DeviceCardProps) {
  const isOwner =
    chainDevice?.owner !== undefined &&
    connectedAddress !== undefined &&
    chainDevice.owner.toLowerCase() === connectedAddress.toLowerCase()

  const openIncidents = device.open_incident_count ?? 0
  const telemetry = useLatestTelemetry(device.id, device.online)
  const reading = device.online ? telemetry.data : undefined

  return (
    <article className="bg-white rounded-[18px] overflow-hidden shadow-[0_1px_2px_rgba(20,40,25,0.05)] border border-[#eef1ec] transition-shadow hover:shadow-md">
      {/* Top row: Avatar, Info, Badges */}
      <div className="flex items-center gap-3.5 p-5 sm:px-6 border-b border-[#eef1ec] flex-wrap">
        <div className="w-11 h-11 rounded-[12px] bg-[#eef2ec] grid place-items-center flex-shrink-0">
          <span
            className={`w-3 h-3 rounded-full ${
              device.online
                ? 'bg-[#22c55e] shadow-[0_0_0_5px_#dcfce7]'
                : 'bg-[#9aa59c] shadow-[0_0_0_5px_#dfe4dc]'
            }`}
          />
        </div>

        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <Link
            to={`/d/${device.id}`}
            className="text-[18px] font-semibold text-[#17201a] hover:text-[#16803c] transition-colors"
          >
            {device.name}
          </Link>
          <span className="font-mono text-[12px] text-[#7a867c] truncate">
            ID · SA-{formatShortId(device.id)} ·{' '}
            {formatLastSeen(device.online, device.last_seen)}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-2 flex-wrap">
          <span
            className={`px-2.5 py-1 rounded-full text-[11px] font-bold tracking-[0.06em] ${
              device.online ? 'bg-[#e8faef] text-[#0f7638]' : 'bg-[#eef1ec] text-[#4f5b52]'
            }`}
          >
            {device.online ? 'ONLINE' : 'OFFLINE'}
          </span>

          {!chainDevice?.exists ? (
            <span className="px-2.5 py-1 rounded-full bg-[#fdf4dc] text-[#8a5a00] text-[11px] font-bold tracking-[0.06em]">
              CHỜ ĐĂNG KÝ ON-CHAIN
            </span>
          ) : (
            <>
              <span
                className={`px-2.5 py-1 rounded-full text-[11px] font-bold tracking-[0.06em] ${
                  chainDevice.active ? 'bg-[#e6fbef] text-[#0a7a3e]' : 'bg-[#fff0f1] text-[#c4122a]'
                }`}
              >
                {chainDevice.active ? 'ACTIVE' : 'REVOKED'}
              </span>
              {isOwner ? (
                <span className="px-2.5 py-1 rounded-full bg-[#e2f9fc] text-[#00606f] text-[11px] font-bold tracking-[0.06em]">
                  BẠN LÀ CHỦ
                </span>
              ) : null}
            </>
          )}
        </div>
      </div>

      {/* 4 Telemetry Metrics Grid: latest reading while online, "—" while offline */}
      <div className="grid grid-cols-2 sm:grid-cols-4 border-b border-[#eef1ec]">
        <Metric label="CO" value={reading?.co_ppm} digits={1} unit="ppm" className="border-r" />
        <Metric label="NO₂" value={reading?.no2_ppm} digits={2} unit="ppm" className="sm:border-r" />
        <Metric label="Nhiệt độ" value={reading?.temperature} digits={1} unit="°C" className="border-r border-t sm:border-t-0" />
        <Metric label="Độ ẩm" value={reading?.humidity} digits={0} unit="%" className="border-t sm:border-t-0" />
      </div>

      {/* Open Incident Alert Banner */}
      {openIncidents > 0 ? (
        <div className="p-4 sm:px-6 sm:py-4">
          <div className="flex items-center gap-3 p-3 rounded-[12px] bg-[#fff1f3] flex-wrap">
            <span className="size-2 rounded-full bg-[#c81e3a] flex-shrink-0" />
            <span className="text-[14px] text-[#8f1028] font-semibold">
              {openIncidents} sự cố đang mở
            </span>
            <span className="text-[13px] text-[#8f1028]">
              Cần xác nhận hoặc xử lý
            </span>
            <Link
              to={`/d/${device.id}`}
              className="ml-auto text-[13px] font-semibold text-[#c81e3a] hover:underline flex items-center gap-1"
            >
              Xem sự cố →
            </Link>
          </div>
        </div>
      ) : null}
    </article>
  )
}
