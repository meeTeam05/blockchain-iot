import { useState, useMemo } from 'react'
import { HardDrive, Search } from 'lucide-react'
import { keccak256, toBytes } from 'viem'
import { useAccount, useReadContracts } from 'wagmi'
import { EmptyState } from '../../components/ui/EmptyState'
import { activeNetwork } from '../../config/networks'
import { useDevices } from '../../lib/devicesApi'
import { AIR_SAFETY_LOG_ABI } from '../../generated/incident-deployments'
import { DeviceCard } from './DeviceCard'

type FilterType = 'all' | 'online' | 'offline' | 'incident'

export function DeviceList() {
  const { address } = useAccount()
  const { data: devices, isLoading, error, refetch } = useDevices()
  const [filter, setFilter] = useState<FilterType>('all')
  const [searchQuery, setSearchQuery] = useState('')

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

  const totalCount = devices?.length ?? 0
  const onlineCount = useMemo(() => devices?.filter((d) => d.online).length ?? 0, [devices])
  const offlineCount = totalCount - onlineCount
  const incidentDevicesCount = useMemo(
    () => devices?.filter((d) => (d.open_incident_count ?? 0) > 0).length ?? 0,
    [devices]
  )
  const totalOpenIncidents = useMemo(
    () => devices?.reduce((acc, d) => acc + (d.open_incident_count ?? 0), 0) ?? 0,
    [devices]
  )

  const filteredDevices = useMemo(() => {
    if (!devices) return []
    return devices.filter((d) => {
      if (filter === 'online' && !d.online) return false
      if (filter === 'offline' && d.online) return false
      if (filter === 'incident' && (d.open_incident_count ?? 0) === 0) return false
      if (searchQuery.trim()) {
        const query = searchQuery.trim().toLowerCase()
        const matchesName = d.name.toLowerCase().includes(query)
        const matchesId = d.id.toLowerCase().includes(query)
        if (!matchesName && !matchesId) return false
      }
      return true
    })
  }, [devices, filter, searchQuery])

  if (isLoading) return <p className="text-[#5d6a60]">Đang tải danh sách thiết bị…</p>

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
    <div className="flex flex-col gap-6">
      {/* 3 Summary Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-white rounded-[14px] p-4 sm:px-[18px] sm:py-4 flex flex-col gap-1 border border-[#eef1ec] shadow-[0_1px_2px_rgba(20,40,25,0.03)]">
          <span className="text-[12px] text-[#5d6a60] font-medium">Tổng thiết bị</span>
          <span className="text-[24px] font-bold text-[#17201a]">{totalCount}</span>
        </div>
        <div className="bg-white rounded-[14px] p-4 sm:px-[18px] sm:py-4 flex flex-col gap-1 border border-[#eef1ec] shadow-[0_1px_2px_rgba(20,40,25,0.03)]">
          <span className="text-[12px] text-[#5d6a60] font-medium">Đang online</span>
          <span className="text-[24px] font-bold text-[#17201a]">{onlineCount}</span>
        </div>
        <div className="bg-white rounded-[14px] p-4 sm:px-[18px] sm:py-4 flex flex-col gap-1 border border-[#eef1ec] shadow-[0_1px_2px_rgba(20,40,25,0.03)]">
          <span className="text-[12px] text-[#5d6a60] font-medium">Sự cố đang mở</span>
          <span className="text-[24px] font-bold text-[#c81e3a]">{totalOpenIncidents}</span>
        </div>
      </div>

      {/* Filter Tabs & Search Bar */}
      <div className="flex gap-2 flex-wrap items-center">
        <button
          type="button"
          onClick={() => setFilter('all')}
          className={`h-[34px] px-3.5 rounded-full font-medium text-[13px] cursor-pointer transition-colors ${
            filter === 'all'
              ? 'bg-[#17201a] text-white border-0'
              : 'bg-white text-[#4f5b52] border border-[#dfe4dc] hover:bg-[#f4f6f3]'
          }`}
        >
          Tất cả · {totalCount}
        </button>
        <button
          type="button"
          onClick={() => setFilter('online')}
          className={`h-[34px] px-3.5 rounded-full font-medium text-[13px] cursor-pointer transition-colors ${
            filter === 'online'
              ? 'bg-[#17201a] text-white border-0'
              : 'bg-white text-[#4f5b52] border border-[#dfe4dc] hover:bg-[#f4f6f3]'
          }`}
        >
          Online · {onlineCount}
        </button>
        <button
          type="button"
          onClick={() => setFilter('offline')}
          className={`h-[34px] px-3.5 rounded-full font-medium text-[13px] cursor-pointer transition-colors ${
            filter === 'offline'
              ? 'bg-[#17201a] text-white border-0'
              : 'bg-white text-[#4f5b52] border border-[#dfe4dc] hover:bg-[#f4f6f3]'
          }`}
        >
          Offline · {offlineCount}
        </button>
        <button
          type="button"
          onClick={() => setFilter('incident')}
          className={`h-[34px] px-3.5 rounded-full font-medium text-[13px] cursor-pointer transition-colors ${
            filter === 'incident'
              ? 'bg-[#17201a] text-white border-0'
              : 'bg-white text-[#4f5b52] border border-[#dfe4dc] hover:bg-[#f4f6f3]'
          }`}
        >
          Có sự cố · {incidentDevicesCount}
        </button>

        <div className="ml-auto h-9 w-[260px] max-w-full bg-white border border-[#dfe4dc] rounded-[10px] flex items-center px-3 gap-2">
          <Search className="size-3.5 text-[#8a958c] flex-shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Tìm theo tên hoặc mã thiết bị…"
            className="w-full bg-transparent text-[13px] text-[#17201a] placeholder:text-[#8a958c] outline-none"
          />
        </div>
      </div>

      {/* Device Cards */}
      {filteredDevices.length === 0 ? (
        <div className="bg-white rounded-[18px] p-8 text-center text-[#5d6a60] border border-[#eef1ec]">
          Không tìm thấy thiết bị phù hợp với bộ lọc hiện tại.
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {filteredDevices.map((device) => {
            const originalIndex = devices.findIndex((d) => d.id === device.id)
            const chainResult = originalIndex >= 0 ? chainResults?.[originalIndex] : undefined
            return (
              <DeviceCard
                key={device.id}
                device={device}
                chainDevice={chainResult?.status === 'success' ? chainResult.result : undefined}
                connectedAddress={address}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
