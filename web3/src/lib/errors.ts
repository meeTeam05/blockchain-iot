// Shared custom error messages for the incident and incentives transactions.
import { BaseError, ContractFunctionRevertedError } from 'viem'

const MESSAGES: Record<string, string> = {
  NotDeviceOwner: 'Ví đang kết nối không phải chủ thiết bị này',
  InvalidStatus: 'Sự cố đã được xử lý ở bước này rồi',
  IncidentNotFound: 'Sự cố chưa được ghi lên chain',
  BondTooLow: 'Tổng bond thấp hơn mức yêu cầu',
  BondHeldByOther: 'Bond hiện còn thuộc ví chủ sở hữu trước',
  CooldownActive: 'Chưa hết thời gian chờ rút bond',
  NotStaker: 'Ví đang kết nối không phải người stake bond này',
  AlreadySettled: 'Đã được keeper khác xử lý, hãy làm mới',
  AckDeadlinePassed: 'Đã quá hạn xác nhận, không còn thưởng',
  AckDeadlineNotPassed: 'Chưa quá hạn xác nhận, chưa thể phạt',
  ResolveDeadlinePassed: 'Đã quá hạn xử lý, không còn thưởng',
  IncidentNotCovered: 'Sự cố xảy ra trước khi incentives được kích hoạt',
  NoUnstakeRequest: 'Chưa yêu cầu unstake',
  UnstakeAlreadyRequested: 'Bond đã có yêu cầu unstake',
  NotAcknowledged: 'Chưa ghi nhận acknowledge đúng hạn',
  NotResolved: 'Sự cố chưa được resolve trên chain',
  RelayNotLate: 'Relay chưa vượt quá hạn cho phép',
  ERC20InsufficientBalance: 'Không đủ ASAFE trong ví',
  ERC20InsufficientAllowance: 'Allowance không đủ, cần approve trước',
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
