// B3 status merge table -- chain state takes
// priority whenever it's known; API chain_status only disambiguates the
// "chưa thấy gì trên chain" (chain status None) case.
import type { PillTone } from '../components/ui/Pill'

export const CHAIN_STATUS_NAMES = ['None', 'Logged', 'Acknowledged', 'Resolved'] as const
export type ChainStatusName = (typeof CHAIN_STATUS_NAMES)[number]

export interface MergedStatus {
  label: string
  tone: PillTone
}

export type ChainReadState = 'loading' | 'error' | 'success'

export function deriveIncidentStatus(
  apiChainStatus: string | null,
  chainReadState: ChainReadState,
  chainStatus: ChainStatusName = 'None',
): MergedStatus {
  if (chainReadState === 'loading') return { label: 'Đang đọc chain', tone: 'offline' }
  if (chainReadState === 'error') return { label: 'Chain không khả dụng', tone: 'offline' }
  return mergeIncidentStatus(apiChainStatus, chainStatus)
}

export function mergeIncidentStatus(apiChainStatus: string | null, chainStatus: ChainStatusName): MergedStatus {
  if (chainStatus === 'Logged') return { label: 'Đã ghi on-chain, chờ xử lý', tone: 'danger' }
  if (chainStatus === 'Acknowledged') return { label: 'Đã xác nhận', tone: 'warn' }
  if (chainStatus === 'Resolved') return { label: 'Đã xử lý xong', tone: 'online' }

  // chainStatus === 'None' -- disambiguate using the API's outbox status.
  if (apiChainStatus === 'queued' || apiChainStatus === 'pending') {
    return { label: 'Đang đưa lên chain', tone: 'accent' }
  }
  if (apiChainStatus === 'failed' || apiChainStatus === 'blocked') {
    return { label: 'Lỗi đưa lên chain', tone: 'danger' }
  }
  if (apiChainStatus === 'legacy_domain') {
    return { label: 'Ký cho contract cũ, không lên chain', tone: 'offline' }
  }
  return { label: 'Chưa có trên chain', tone: 'offline' }
}
