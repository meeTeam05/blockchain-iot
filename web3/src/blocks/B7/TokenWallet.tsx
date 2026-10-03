import type { ReactNode } from 'react'
import { formatUnits } from 'viem'
import { activeNetwork } from '../../config/networks'
import { ExplorerLink } from '../../components/ExplorerLink'
import { useTokenWallet } from '../../lib/useIncentives'
import { IncentivesGuardNotice, NoticeBanner } from './IncentivesShared'

function Stat({ label, testId, children }: { label: string; testId?: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-[14px] border border-[#eef1ec] bg-white p-4 shadow-[0_1px_2px_rgba(20,40,25,0.03)] sm:px-[18px]">
      <span className="text-[12px] font-medium text-[#5d6a60]">{label}</span>
      <span data-testid={testId} className="break-all text-[24px] font-bold text-[#17201a]">{children}</span>
    </div>
  )
}

const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

export function TokenWallet() {
  const token = useTokenWallet()
  const { data } = token
  const account = token.guard.account.address
  const amount = (value: bigint | undefined) =>
    data && value !== undefined ? `${formatUnits(value, data.decimals)} ${data.symbol}` : undefined
  const balance = token.isError ? undefined : amount(data?.balance)
  const allowance = token.isError ? undefined : amount(data?.allowance)

  return (
    <div className="flex flex-col gap-3">
      <IncentivesGuardNotice guard={token.guard} />
      {token.guard.status === 'ready' && token.isPending ? <p className="m-0 text-[13px] text-[#5d6a60]">Đang đọc token từ chain…</p> : null}
      {token.isError ? <NoticeBanner role="alert">RPC token lỗi: {token.error.message}</NoticeBanner> : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Stat label="Số dư" testId={balance ? 'token-balance' : undefined}>{balance ?? '—'}</Stat>
        <Stat label="Allowance cho SafetyIncentives" testId={allowance ? 'token-allowance' : undefined}>{allowance ?? '—'}</Stat>
        <Stat label="Ví">
          {account ? (
            <span className="text-[16px]"><ExplorerLink kind="address" value={account} label={shortAddress(account)} /></span>
          ) : (
            <span className="text-[16px] font-medium text-[#8a958c]">Chưa kết nối</span>
          )}
        </Stat>
      </div>
      <details className="group text-[13px] text-[#5d6a60]">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-2 font-medium hover:text-[#17201a] [&::-webkit-details-marker]:hidden">
          <span className="group-open:hidden">▸</span>
          <span className="hidden group-open:inline">▾</span>
          Chi tiết mạng
        </summary>
        <div className="mt-2 flex flex-col gap-1 rounded-[10px] bg-white px-4 py-3">
          <p className="m-0">Mạng: {activeNetwork.key} · RPC: <span className="break-all font-mono text-[12px]">{activeNetwork.rpcUrl}</span></p>
          {token.guard.deployment ? <p className="m-0">Token: <ExplorerLink kind="address" value={token.guard.deployment.token.address} /></p> : null}
          {data ? <p className="m-0">Symbol: {data.symbol} · Decimals: {data.decimals}</p> : null}
        </div>
      </details>
    </div>
  )
}
