// Incident rows of one device with their merged API+chain status. Shared by the
// incident table (B3) and the device page (tab count, "Tổng quan sự cố" card)
// so both read the same react-query/wagmi caches.
import { useReadContracts } from 'wagmi'
import { activeNetwork } from '../../config/networks'
import { AIR_SAFETY_LOG_ABI } from '../../generated/incident-deployments'
import { computeDeviceIdHash, computeIncidentKey } from '../../lib/chainIncident'
import { useIncidents, type ApiIncidentSummary } from '../../lib/incidentsApi'
import { CHAIN_STATUS_NAMES, deriveIncidentStatus, type MergedStatus } from '../../lib/mergeStatus'

export type IncidentGroup = 'open' | 'done'
export type ChainReadState = 'loading' | 'error' | 'success'

export interface IncidentRow {
  incident: ApiIncidentSummary
  merged: MergedStatus
  group: IncidentGroup
  chainRead: ChainReadState
  onChain: boolean
}

export function useDeviceIncidents(deviceId: string) {
  const query = useIncidents(deviceId)
  const incidents = query.data?.pages.flat() ?? []
  const deviceIdHash = computeDeviceIdHash(deviceId)

  const contracts = incidents.map((i) => ({
    address: activeNetwork.address,
    abi: AIR_SAFETY_LOG_ABI,
    functionName: 'getIncident' as const,
    args: [computeIncidentKey(deviceIdHash, i.incident_id as `0x${string}`)] as const,
  }))
  const { data: chainResults, isPending: isChainPending, isError: isChainError } = useReadContracts({
    contracts,
    query: { enabled: contracts.length > 0 },
  })

  const rows: IncidentRow[] = incidents.map((incident, i) => {
    const result = chainResults?.[i]
    const chainRead: ChainReadState = isChainPending
      ? 'loading'
      : isChainError || result?.status === 'failure' || !result
        ? 'error'
        : 'success'
    const chainStatusIndex = result?.status === 'success' ? Number(result.result.status) : 0
    const chainStatusName = CHAIN_STATUS_NAMES[chainStatusIndex] ?? 'None'
    // Chain wins when it was read; the API owner_status only decides while the chain is unreadable.
    const resolved = chainRead === 'success' ? chainStatusName === 'Resolved' : incident.owner_status === 'resolved'
    return {
      incident,
      merged: deriveIncidentStatus(incident.chain_status, chainRead, chainStatusName),
      group: resolved ? 'done' : 'open',
      chainRead,
      onChain: chainStatusIndex > 0,
    }
  })

  return {
    rows,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    hasNextPage: query.hasNextPage,
    fetchNextPage: query.fetchNextPage,
    isFetchingNextPage: query.isFetchingNextPage,
    openCount: rows.filter((r) => r.group === 'open').length,
    doneCount: rows.filter((r) => r.group === 'done').length,
  }
}
