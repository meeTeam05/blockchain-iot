import { HardDrive } from 'lucide-react'
import { keccak256, toBytes } from 'viem'
import { useAccount, useReadContracts } from 'wagmi'
import { EmptyState } from '../../components/ui/EmptyState'
import { activeNetwork } from '../../config/networks'
import { useDevices } from '../../lib/devicesApi'
import { AIR_SAFETY_LOG_ABI } from '../../generated/incident-deployments'
import { DeviceCard } from './DeviceCard'

export function DeviceList() {
  const { address } = useAccount()
  const { data: devices, isLoading, error, refetch } = useDevices()

  const contracts = (devices ?? []).map((d) => ({
    address: activeNetwork.address,
    abi: AIR_SAFETY_LOG_ABI,
    functionName: 'getDevice' as const,
    args: [keccak256(toBytes(d.id))] as const,
  }))

  const { data: chainResults } = useReadContracts({
    contracts,
    query: { enabled: contracts.length > 0 },
  })

  if (isLoading) return <p className="text-ink-2">Đang tải…</p>

  if (error) {
    return (
      <EmptyState
        icon={HardDrive}
        title="Không tải được danh sách"
        body={error.message}
        primaryAction="Thử lại"
        onPrimaryAction={() => void refetch()}
      />
    )
  }

  if (!devices || devices.length === 0) {
    return <EmptyState icon={HardDrive} title="Chưa có thiết bị" body="Thêm thiết bị từ app di động trước." />
  }

  return (
    <div className="flex flex-col gap-3">
      {devices.map((device, i) => (
        <DeviceCard
          key={device.id}
          device={device}
          chainDevice={chainResults?.[i]?.status === 'success' ? chainResults[i].result : undefined}
          connectedAddress={address}
        />
      ))}
    </div>
  )
}
