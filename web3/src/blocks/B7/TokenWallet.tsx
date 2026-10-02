import { formatUnits } from 'viem'
import { activeNetwork } from '../../config/networks'
import { ExplorerLink } from '../../components/ExplorerLink'
import { useTokenWallet } from '../../lib/useIncentives'
import { IncentivesCard, IncentivesGuardNotice } from './IncentivesShared'

export function TokenWallet() {
  const token = useTokenWallet()
  return <IncentivesCard title="Ví AirSafeToken">
    <IncentivesGuardNotice guard={token.guard} />
    <p>Mạng: {activeNetwork.key} · RPC: {activeNetwork.rpcUrl}</p>
    {token.guard.deployment ? <p>Token: <ExplorerLink kind="address" value={token.guard.deployment.token.address} /></p> : null}
    {token.guard.account.address ? <p>Ví: <ExplorerLink kind="address" value={token.guard.account.address} /></p> : null}
    {token.guard.status === 'ready' && token.isPending ? <p>Đang đọc token từ chain…</p> : null}
    {token.isError ? <p role="alert">RPC token lỗi: {token.error.message}</p> : token.data ? <>
      <p>Symbol: {token.data.symbol} · Decimals: {token.data.decimals}</p>
      {token.data.balance !== undefined ? <p data-testid="token-balance">Số dư chain: {formatUnits(token.data.balance, token.data.decimals)} {token.data.symbol}</p> : null}
      {token.data.allowance !== undefined ? <p>Allowance SafetyIncentives: {formatUnits(token.data.allowance, token.data.decimals)} {token.data.symbol}</p> : null}
    </> : null}
  </IncentivesCard>
}
