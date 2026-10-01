// B0 stub / B5 full table (tmp/Web3_task.md mục 6). Only the AirSafetyLog
// errors relevant to Task 5 are mapped here -- SafetyIncentives errors
// (AckDeadlinePassed, BondTooLow, ...) are Task 8 and out of scope.
import { BaseError, ContractFunctionRevertedError } from 'viem'

const MESSAGES: Record<string, string> = {
  NotDeviceOwner: 'Ví đang kết nối không phải chủ thiết bị này',
  InvalidStatus: 'Sự cố đã được xử lý ở bước này rồi',
  IncidentNotFound: 'Sự cố chưa được ghi lên chain',
}

export interface DecodedError {
  errorName: string | null
  message: string
}

export function decodeError(error: unknown): DecodedError {
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError)
    if (reverted instanceof ContractFunctionRevertedError) {
      const errorName = reverted.data?.errorName ?? null
      if (errorName && MESSAGES[errorName]) {
        return { errorName, message: MESSAGES[errorName] }
      }
      if (errorName) {
        return { errorName, message: reverted.reason ?? errorName }
      }
    }
    return { errorName: null, message: 'Mạng Sepolia đang chậm hoặc ví không đủ ETH trả phí' }
  }
  return { errorName: null, message: error instanceof Error ? error.message : 'Lỗi không xác định' }
}
