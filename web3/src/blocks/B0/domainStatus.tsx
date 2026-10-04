import { useQuery } from '@tanstack/react-query'
import { createContext, useContext, type ReactNode } from 'react'
import { useAccount, useConnectorClient, usePublicClient } from 'wagmi'
import { activeNetwork } from '../../config/networks'
import {
  validateDeployment,
  type DeploymentTarget,
  type DeploymentStatus,
  type RpcRequest,
} from '../../lib/deploymentValidation'

export interface DomainStatusValue {
  publicStatus: DeploymentStatus
  walletStatus: DeploymentStatus
}

export const CORRECT_DOMAIN_STATUS: DomainStatusValue = {
  publicStatus: 'correct',
  walletStatus: 'correct',
}

export const DomainStatusContext = createContext<DomainStatusValue>({
  publicStatus: 'checking',
  walletStatus: 'disconnected',
})

export function useDomainStatus() {
  return useContext(DomainStatusContext)
}

export function useDomainOk() {
  const status = useDomainStatus()
  return status.publicStatus === 'correct' && status.walletStatus === 'correct'
}

const target: DeploymentTarget = {
  chainId: activeNetwork.chainId,
  address: activeNetwork.address,
  name: activeNetwork.name,
  version: activeNetwork.version,
  domainSeparator: activeNetwork.domainSeparator,
  runtimeCodeHash: activeNetwork.runtimeCodeHash,
  deployTxHash: activeNetwork.deployTxHash,
  blockNumber: activeNetwork.blockNumber,
}

export function DomainStatusProvider({ children }: { children: ReactNode }) {
  const publicClient = usePublicClient()
  const { isConnected, address, chainId, connector } = useAccount()
  const connectorClient = useConnectorClient()
  const publicValidation = useQuery({
    queryKey: ['deployment-guard', 'public', activeNetwork.key],
    queryFn: () => validateDeployment(publicClient!.request as RpcRequest, target),
    enabled: Boolean(publicClient),
    retry: false,
    staleTime: Infinity,
    meta: { static: true },
    // A transient RPC failure must not pin the banner until reload.
    refetchInterval: (query) => (query.state.data === 'rpc_unavailable' ? 15_000 : false),
  })
  const walletValidation = useQuery({
    queryKey: ['deployment-guard', 'wallet', connector?.uid, address, chainId],
    queryFn: () => validateDeployment(connectorClient.data!.request as RpcRequest, target),
    enabled: isConnected && chainId === target.chainId && Boolean(connectorClient.data),
    retry: false,
    staleTime: Infinity,
    meta: { static: true },
    // A transient RPC failure must not pin the banner until reload.
    refetchInterval: (query) => (query.state.data === 'rpc_unavailable' ? 15_000 : false),
  })

  const publicStatus = publicClient
    ? (publicValidation.data ?? (publicValidation.isError ? 'rpc_unavailable' : 'checking'))
    : 'rpc_unavailable'
  const walletStatus = !isConnected
    ? 'disconnected'
    : chainId !== target.chainId
      ? 'wrong_chain'
    : (walletValidation.data ??
      (connectorClient.isError || walletValidation.isError ? 'rpc_unavailable' : 'checking'))
  const value = { publicStatus, walletStatus } satisfies DomainStatusValue
  return <DomainStatusContext.Provider value={value}>{children}</DomainStatusContext.Provider>
}

const STATUS_MESSAGE: Record<Exclude<DeploymentStatus, 'correct' | 'disconnected'>, string> = {
  checking: 'Đang kiểm tra deployment…',
  wrong_chain: 'Sai chain trong ví.',
  wrong_rpc: 'RPC ví đang trỏ tới deployment khác dù chain ID trùng.',
  contract_not_deployed: 'Không tìm thấy AirSafetyLog tại địa chỉ cấu hình.',
  domain_mismatch: 'EIP-712 domain không khớp deployment cấu hình.',
  rpc_unavailable: 'Không thể kiểm tra RPC lúc này.',
}

export function DomainMismatchBanner() {
  const { publicStatus, walletStatus } = useDomainStatus()
  const messages: string[] = []
  if (publicStatus !== 'correct' && publicStatus !== 'disconnected') {
    messages.push(`Public RPC: ${STATUS_MESSAGE[publicStatus]}`)
  }
  if (walletStatus !== 'correct' && walletStatus !== 'disconnected') {
    messages.push(`Wallet RPC: ${STATUS_MESSAGE[walletStatus]}`)
  }
  if (messages.length === 0) return null
  return (
    <div className="bg-danger px-4 py-3 text-center text-[15px] font-semibold text-paper">
      {messages.join(' ')} Mọi hành động gửi giao dịch đã bị khóa.
    </div>
  )
}
