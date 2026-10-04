import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useWalletClient } from 'wagmi'
import type { Hash } from 'viem'
import { AIR_SAFE_TOKEN_ABI, SAFETY_INCENTIVES_ABI } from '../generated/incentives-deployments'
import { useIncentivesGuard } from './useIncentives'
import { settlementEligibility, validateIncentives, type IncentiveAction } from './incentives'
import type { RpcRequest } from './deploymentValidation'
import { runReceiptTransaction, resumeReceiptTransaction, type PendingReceiptTransaction,
  type ReceiptDependencies, type TransactionSnapshot } from './incidentTransaction'

const locks = new Set<string>()
export async function withIncentiveLock<T>(key: string, task: () => Promise<T>) {
  if (locks.has(key)) return undefined
  locks.add(key)
  try { return await task() } finally { locks.delete(key) }
}
const actions: IncentiveAction[] = ['approve', 'stakeDevice', 'requestUnstake', 'withdraw',
  'recordTimelyAck', 'recordTimelyResolve', 'slashMissedAck', 'slashLateRelay']
function loadPending(key: string) {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null') as PendingReceiptTransaction<IncentiveAction> | null
    return value?.version === 1 && actions.includes(value.action) && /^0x[0-9a-fA-F]{64}$/.test(value.txHash) ? value : null
  } catch { return null }
}
const idle: TransactionSnapshot<IncentiveAction> = { stage: 'idle', action: null }

export function useIncentiveTransaction(target: Hash | 'wallet') {
  const guard = useIncentivesGuard()
  const wallet = useWalletClient()
  const queries = useQueryClient()
  const storageKey = `smartair-pending-incentives:${guard.deployment?.network}:${guard.deployment?.incentives.address.toLowerCase()}:${guard.account.address?.toLowerCase()}:${target}`
  const [state, setState] = useState({ key: storageKey, snapshot: idle })
  const snapshot = state.key === storageKey ? state.snapshot : idle
  const setSnapshot = (value: TransactionSnapshot<IncentiveAction>) => setState({ key: storageKey, snapshot: value })
  const latest = useRef({ guard, wallet })
  useLayoutEffect(() => { latest.current = { guard, wallet } })

  function dependencies(args: readonly unknown[] = []): ReceiptDependencies<unknown, IncentiveAction> {
    const client = guard.publicClient!
    return {
      simulate: async (action) => {
        const current = latest.current
        const g = current.guard
        if (!g.canWrite || !g.deployment || !g.account.address || !g.connectorClient) throw new Error('Ví/mạng/deployment chưa được xác minh')
        await Promise.all([
          validateIncentives(client.request as RpcRequest, g.deployment),
          validateIncentives(g.connectorClient.request as RpcRequest, g.deployment),
        ])
        if (action in settlementEligibility) {
          const settlement = await client.readContract({ address: g.deployment.incentives.address, abi: SAFETY_INCENTIVES_ABI,
            functionName: 'pendingSettlement', args: [target as Hash] })
          const eligible = settlementEligibility[action as keyof typeof settlementEligibility]
          if (!settlement.exists || !settlement.covered || !settlement[eligible]) throw new Error('Hành động không còn hợp lệ, đang làm mới dữ liệu chain')
        }
        const request = { account: g.account.address,
          address: action === 'approve' ? g.deployment.token.address : g.deployment.incentives.address,
          abi: action === 'approve' ? AIR_SAFE_TOKEN_ABI : SAFETY_INCENTIVES_ABI, functionName: action, args }
        return (await client.simulateContract(request as Parameters<typeof client.simulateContract>[0])).request
      },
      submit: async (request) => {
        const current = latest.current
        const signing = current.wallet.data
        if (!current.guard.canWrite || !signing || signing.account.address.toLowerCase() !== guard.account.address?.toLowerCase()) throw new Error('Ví đã thay đổi, hãy kiểm tra lại giao dịch')
        await validateIncentives(signing.request as RpcRequest, guard.deployment!)
        return signing.writeContract(request as Parameters<typeof signing.writeContract>[0])
      },
      waitForReceipt: async (hash) => ({ status: (await client.waitForTransactionReceipt({ hash, confirmations: 1 })).status }),
      persist: (pending) => { try { localStorage.setItem(storageKey, JSON.stringify(pending)) } catch { /* private browsing */ } },
      clearPending: () => { try { localStorage.removeItem(storageKey) } catch { /* private browsing */ } },
      confirmed: async (pending, emit) => {
        emit({ stage: 'indexing', action: pending.action, txHash: pending.txHash })
        const results = await Promise.allSettled([
          queries.invalidateQueries({ queryKey: ['incentives'] }),
          queries.invalidateQueries({ queryKey: ['incident'] }),
        ])
        try { localStorage.removeItem(storageKey) } catch { /* private browsing */ }
        const result = { stage: 'success', txHash: pending.txHash, apiSyncDelayed: results.some((r) => r.status === 'rejected') } as const
        emit({ ...result, action: pending.action })
        return result
      },
    }
  }
  const resumeRef = useRef(() => {})
  useLayoutEffect(() => { resumeRef.current = () => {
    const pending = loadPending(storageKey)
    if (!pending || !guard.publicClient || guard.status !== 'ready') return
    void withIncentiveLock(storageKey, () => resumeReceiptTransaction(pending, dependencies(), setSnapshot))
  } })
  useEffect(() => {
    resumeRef.current()
  }, [storageKey, guard.status])

  async function run(action: IncentiveAction, args: readonly unknown[]) {
    return withIncentiveLock(storageKey, async () => {
      const pending = loadPending(storageKey)
      if (pending) return resumeReceiptTransaction(pending, dependencies(), setSnapshot)
      const result = await runReceiptTransaction(action, dependencies(args), setSnapshot)
      if (result.stage === 'error') void queries.invalidateQueries({ queryKey: ['incentives'] })
      return result
    })
  }
  // Escape hatch for a submitted transaction that never produced a receipt (dropped from
  // the mempool): without it run() would keep resuming the same dead hash.
  function discardPending() {
    try { localStorage.removeItem(storageKey) } catch { /* private browsing */ }
    setSnapshot(idle)
  }
  return { run, snapshot, guard, discardPending }
}
