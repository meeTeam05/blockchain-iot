import { useQuery } from '@tanstack/react-query'
import type { Hash } from 'viem'
import { useAuth } from './authStore'
import { incentivesDeployment } from './incentives'

export interface IncentiveEvent {
  id: string; name: string; incident_key: Hash | null; account: string | null; amount: string | null
  data: Record<string, unknown>; tx_hash: Hash; block_number: string; block_time: string | null
}
export interface IncidentIncentive {
  incident_key: Hash | null; covered: boolean | null; logged_at: string | null; deadline_at: string | null
  resolve_deadline_at: string | null; reward_status: string
  flags: { timely_ack: boolean; ack_rewarded: boolean; resolve_settled: boolean; ack_slashed: boolean; relay_slashed: boolean }
  events: IncentiveEvent[]
}
export interface DeviceIncentives {
  device_id: string; device_id_hash: Hash; enabled: boolean; contract: string | null
  bond: { staker: string; amount: string; since: string | null; unstake_requested_at: string | null; unstake_available_at: string | null } | null
  rewards_today: { day: number; count: number; cap: number | null }
  totals: { rewarded: string; slashed: string }; warnings: string[]; events: IncentiveEvent[]
}
export interface IncentiveParams {
  contract: string; token: string; air_safety_log: string; treasury: string; operator: string
  params: Record<string, string | number>; reward_fund: string; low_reward_fund: boolean
  total_bonded: string; operator_bond: { amount: string; unstake_requested_at: string | null }
  block_number: string; params_history: IncentiveEvent[]
}
export interface OverdueItem {
  incident_key: Hash; device_id_hash: Hash; severity: number; logged_at: string
  deadline_at?: string; relay_delay_seconds?: string; penalty: string; bounty: string; bond_available: string
}
export interface OverdueIncentives {
  contract: string; as_of: string; keeper_share_bps: number
  slash_missed_ack: OverdueItem[]; slash_late_relay: OverdueItem[]
}
export class IncentivesApiError extends Error {
  status: number
  constructor(status: number) {
    super(status === 401 || status === 403 ? 'Không có quyền xem incentives (API)' :
      status === 404 ? 'API incentives chưa bật hoặc chưa index deployment hiện hành' : `API incentives lỗi (${status})`)
    this.status = status
  }
}
export async function readIncentivesResponse<T extends { contract: string | null }>(response: Response, contract: string): Promise<T> {
  if (!response.ok) throw new IncentivesApiError(response.status)
  const body = await response.json() as T
  if (body.contract?.toLowerCase() !== contract.toLowerCase()) throw new Error('API đang trả deployment incentives khác mạng hiện hành')
  return body
}
export function useIncentivesApi<T extends { contract: string | null }>(path: string, privateRoute = false, enabled = true) {
  const { accessToken, request, requestPublic } = useAuth()
  const deployment = incentivesDeployment
  return useQuery({
    queryKey: ['incentives', deployment?.incentives.address, 'api', path, privateRoute ? accessToken : 'public'],
    enabled: Boolean(deployment) && enabled && (!privateRoute || Boolean(accessToken)),
    retry: false, refetchInterval: 10_000,
    queryFn: async () => readIncentivesResponse<T>(privateRoute ? await request(path) : await requestPublic(path), deployment!.incentives.address),
  })
}
