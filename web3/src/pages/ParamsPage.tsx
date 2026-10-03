import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { formatUnits } from 'viem'
import { AppBar } from '../components/ui/AppBar'
import { ConnectWallet } from '../blocks/B1/ConnectWallet'
import { SAFETY_INCENTIVES_ABI } from '../generated/incentives-deployments'
import { useIncentivesGuard, useTokenWallet } from '../lib/useIncentives'
import { useIncentivesApi, type IncentiveParams } from '../lib/incentivesApi'
import { IncentivesCard, IncentivesGuardNotice } from '../blocks/B7/IncentivesShared'
import { ExplorerLink } from '../components/ExplorerLink'

export function ParamsPage() {
  const navigate = useNavigate()
  const guard = useIncentivesGuard()
  const token = useTokenWallet()
  const api = useIncentivesApi<IncentiveParams>('/incentives/params')
  const chain = useQuery({
    queryKey: ['incentives', guard.deployment?.incentives.address, 'params-chain'],
    enabled: guard.status === 'ready', retry: false, refetchInterval: 10_000,
    queryFn: async () => {
      const client = guard.publicClient!
      const address = guard.deployment!.incentives.address
      const [params, rewardFund, bond, operator] = await Promise.all([
        client.readContract({ address, abi: SAFETY_INCENTIVES_ABI, functionName: 'params' }),
        client.readContract({ address, abi: SAFETY_INCENTIVES_ABI, functionName: 'rewardFund' }),
        client.readContract({ address, abi: SAFETY_INCENTIVES_ABI, functionName: 'operatorBond' }),
        client.readContract({ address, abi: SAFETY_INCENTIVES_ABI, functionName: 'operator' }),
      ])
      return { params, rewardFund, bond, operator }
    },
  })
  return <><AppBar variant="back" title="Tham số / quỹ" actions={<ConnectWallet />} onBack={() => navigate('/')} /><main className="mx-auto max-w-3xl p-6">
    <IncentivesCard title="Incentives params (read-only)">
      <IncentivesGuardNotice guard={guard} />
      {token.isError ? <p role="alert">RPC token lỗi: {token.error.message}</p> : null}
      {guard.status === 'ready' && chain.isPending ? <p>Đang đọc params từ chain…</p> : null}
      {chain.isError ? <p role="alert">RPC params lỗi: {chain.error.message}</p> : chain.data && token.data ? <>
        <p>Quỹ thưởng canonical: {formatUnits(chain.data.rewardFund, token.data.decimals)} ASAFE</p>
        {chain.data.rewardFund < 1000n * 10n ** BigInt(token.data.decimals) ? <p className="text-warn">Quỹ thưởng thấp: dưới 1 000 ASAFE.</p> : null}
        <p>Operator: <ExplorerLink kind="address" value={chain.data.operator} /></p>
        <p>Operator bond canonical: {formatUnits(chain.data.bond.amount, token.data.decimals)} ASAFE</p>
        {Object.entries(chain.data.params).map(([name, value]) => <p key={name}>{name}: {String(value)}</p>)}
      </> : null}
      {api.isPending && guard.deployment ? <p>Đang tải params history API…</p> : null}
      {api.isError ? <p role="alert">{api.error.message}</p> : api.data ? <>
        <p>API projection snapshot: block {api.data.block_number}</p>
        {api.data.params_history.length === 0 ? <p>Chưa có ParamsUpdated được index.</p> : api.data.params_history.map((event) => <div key={event.id}>
          <p>ParamsUpdated · <ExplorerLink kind="tx" value={event.tx_hash} /> · <ExplorerLink kind="block" value={event.block_number} /></p>
          <pre className="overflow-auto text-xs">{JSON.stringify(event.data, null, 2)}</pre>
        </div>)}
      </> : null}
    </IncentivesCard>
  </main></>
}
