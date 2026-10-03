import { useQuery } from '@tanstack/react-query'
import { useAccount, useConnectorClient, usePublicClient } from 'wagmi'
import { useDomainStatus } from '../blocks/B0/domainStatus'
import { activeNetwork } from '../config/networks'
import { AIR_SAFETY_LOG_ABI } from '../generated/incident-deployments'
import { SAFETY_INCENTIVES_ABI } from '../generated/incentives-deployments'
import type { RpcRequest } from './deploymentValidation'
import { incentivesDeployment, readTokenWallet, validateIncentives, IncentivesValidationError } from './incentives'
import { computeDeviceIdHash } from './chainIncident'
import type { Hash } from 'viem'

export function useIncentivesGuard() {
  const publicClient = usePublicClient()
  const connector = useConnectorClient()
  const account = useAccount()
  const domain = useDomainStatus()
  const deployment = incentivesDeployment
  const publicValidation = useQuery({
    queryKey: ['incentives', deployment?.incentives.address, 'guard', 'public'],
    enabled: Boolean(deployment && publicClient) && domain.publicStatus === 'correct', retry: false,
    queryFn: async () => { await validateIncentives(publicClient!.request as RpcRequest, deployment!); return true },
  })
  const walletValidation = useQuery({
    queryKey: ['incentives', deployment?.incentives.address, 'guard', 'wallet', account.address, account.chainId, account.connector?.uid],
    enabled: Boolean(deployment && connector.data) && domain.walletStatus === 'correct', retry: false,
    queryFn: async () => { await validateIncentives(connector.data!.request as RpcRequest, deployment!); return true },
  })
  const status = !deployment ? 'unavailable' : publicValidation.error instanceof IncentivesValidationError ? publicValidation.error.kind
    : domain.publicStatus === 'rpc_unavailable' || publicValidation.isError ? 'rpc_error'
    : domain.publicStatus !== 'correct' && domain.publicStatus !== 'checking' ? 'mismatch'
    : publicValidation.data ? 'ready' : 'loading'
  return { deployment, publicClient, connectorClient: connector.data, account, status,
    error: publicValidation.error ?? walletValidation.error,
    canWrite: status === 'ready' && domain.walletStatus === 'correct' && Boolean(walletValidation.data)
      && !walletValidation.isError && account.isConnected && account.chainId === activeNetwork.chainId }
}

export function useTokenWallet() {
  const guard = useIncentivesGuard()
  const query = useQuery({
    queryKey: ['incentives', guard.deployment?.incentives.address, 'token', guard.account.address],
    enabled: guard.status === 'ready', retry: false, refetchInterval: 10_000,
    queryFn: () => readTokenWallet(guard.publicClient!, guard.deployment!, guard.account.address),
  })
  return { ...query, guard }
}
export function useCanonicalDeviceIncentives(deviceId: string) {
  const guard = useIncentivesGuard()
  const hash = computeDeviceIdHash(deviceId)
  const query = useQuery({
    queryKey: ['incentives', guard.deployment?.incentives.address, 'device-chain', deviceId],
    enabled: Boolean(deviceId) && guard.status === 'ready', retry: false, refetchInterval: 10_000,
    queryFn: async () => {
      const client = guard.publicClient!
      const address = guard.deployment!.incentives.address
      const [bond, params, device, block] = await Promise.all([
        client.readContract({ address, abi: SAFETY_INCENTIVES_ABI, functionName: 'deviceBond', args: [hash] }),
        client.readContract({ address, abi: SAFETY_INCENTIVES_ABI, functionName: 'params' }),
        client.readContract({ address: activeNetwork.address, abi: AIR_SAFETY_LOG_ABI, functionName: 'getDevice', args: [hash] }),
        client.getBlock(),
      ])
      const rewardsToday = await client.readContract({ address, abi: SAFETY_INCENTIVES_ABI, functionName: 'rewardsToday', args: [hash, block.timestamp / 86400n] })
      return { bond, params, device, block, rewardsToday }
    },
  })
  return { ...query, guard, hash }
}
export function useSettlement(key?: Hash) {
  const guard = useIncentivesGuard()
  const query = useQuery({
    queryKey: ['incentives', guard.deployment?.incentives.address, 'settlement', key],
    enabled: Boolean(key) && guard.status === 'ready', retry: false, refetchInterval: 5_000,
    queryFn: async () => {
      const [settlement, block] = await Promise.all([
        guard.publicClient!.readContract({ address: guard.deployment!.incentives.address, abi: SAFETY_INCENTIVES_ABI, functionName: 'pendingSettlement', args: [key!] }),
        guard.publicClient!.getBlock(),
      ])
      return { settlement, block }
    },
  })
  return { ...query, guard }
}
