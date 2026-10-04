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
import { CHAIN_POLL_MS, SETTLEMENT_POLL_MS, useChainPollInterval } from './chainPolling'

export function useIncentivesGuard() {
  const publicClient = usePublicClient()
  const connector = useConnectorClient()
  const account = useAccount()
  const domain = useDomainStatus()
  const deployment = incentivesDeployment
  const publicValidation = useQuery({
    queryKey: ['incentives', deployment?.incentives.address, 'guard', 'public'],
    enabled: Boolean(deployment && publicClient) && domain.publicStatus === 'correct', retry: false, staleTime: Infinity, meta: { static: true },
    refetchInterval: (query) => (query.state.status === 'error' ? 15_000 : false),
    queryFn: async () => { await validateIncentives(publicClient!.request as RpcRequest, deployment!); return true },
  })
  const walletValidation = useQuery({
    queryKey: ['incentives', deployment?.incentives.address, 'guard', 'wallet', account.address, account.chainId, account.connector?.uid],
    enabled: Boolean(deployment && connector.data) && domain.walletStatus === 'correct', retry: false, staleTime: Infinity, meta: { static: true },
    refetchInterval: (query) => (query.state.status === 'error' ? 15_000 : false),
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
    // Treasury transfers emit no realtime event, so the wallet keeps a slow poll.
    enabled: guard.status === 'ready', retry: false, refetchInterval: CHAIN_POLL_MS,
    queryFn: () => readTokenWallet(guard.publicClient!, guard.deployment!, guard.account.address),
  })
  return { ...query, guard }
}
export function useCanonicalDeviceIncentives(deviceId: string) {
  const guard = useIncentivesGuard()
  const pollMs = useChainPollInterval(CHAIN_POLL_MS)
  const hash = computeDeviceIdHash(deviceId)
  const query = useQuery({
    queryKey: ['incentives', guard.deployment?.incentives.address, 'device-chain', deviceId],
    enabled: Boolean(deviceId) && guard.status === 'ready', retry: false, refetchInterval: pollMs,
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
// Past the resolve deadline with nothing callable, a settlement can no longer
// change by time alone; only a transaction (which refreshes it) can.
export function isFinalSettlement(data?: { settlement: { covered: boolean; resolveDeadline: bigint; canRecordAck: boolean;
  canRecordResolve: boolean; canSlashMissedAck: boolean; canSlashLateRelay: boolean }; block: { timestamp: bigint } }) {
  if (!data) return false
  const s = data.settlement
  return !s.covered || (data.block.timestamp > s.resolveDeadline
    && !s.canRecordAck && !s.canRecordResolve && !s.canSlashMissedAck && !s.canSlashLateRelay)
}

/** `realtime: false` for incidents of other owners (keeper board), which get no SSE events. */
export function useSettlement(key?: Hash, { realtime = true }: { realtime?: boolean } = {}) {
  const guard = useIncentivesGuard()
  const livePollMs = useChainPollInterval(SETTLEMENT_POLL_MS)
  const pollMs = realtime ? livePollMs : SETTLEMENT_POLL_MS
  const query = useQuery({
    queryKey: ['incentives', guard.deployment?.incentives.address, 'settlement', key],
    enabled: Boolean(key) && guard.status === 'ready', retry: false,
    refetchInterval: (query) => (isFinalSettlement(query.state.data) ? false : pollMs),
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
