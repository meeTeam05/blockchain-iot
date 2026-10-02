import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAccount, usePublicClient, useWalletClient } from 'wagmi'
import type { Hash } from 'viem'
import { ExplorerLink } from '../../components/ExplorerLink'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { PrimaryButton } from '../../components/ui/PrimaryButton'
import { activeNetwork } from '../../config/networks'
import { AIR_SAFETY_LOG_ABI } from '../../generated/incident-deployments'
import { decodeError } from '../../lib/errors'
import {
  isTransactionBusy,
  loadPendingTransaction,
  pendingStorageKey,
  resumeIncidentTransaction,
  runIncidentTransaction,
  TransactionRevertedError,
  type IncidentAction,
  type PendingIncidentTransaction,
  type TransactionDependencies,
  type TransactionSnapshot,
} from '../../lib/incidentTransaction'
import { useDomainOk, useDomainStatus } from '../B0/domainStatus'

interface OwnerActionsProps {
  deviceId: string
  incidentId: string
  incidentKey: Hash
  chainStatus: 'None' | 'Logged' | 'Acknowledged' | 'Resolved'
  isOwner: boolean
  readOwnerStatus: () => Promise<string | null | undefined>
  refetchChain: () => Promise<void>
  afterConfirmed?: (action: IncidentAction) => Promise<void>
}

const IDLE: TransactionSnapshot = { stage: 'idle', action: null }

export function OwnerActions({
  deviceId,
  incidentId,
  incidentKey,
  chainStatus,
  isOwner,
  readOwnerStatus,
  refetchChain,
  afterConfirmed,
}: OwnerActionsProps) {
  const { address, isConnected } = useAccount()
  const { data: walletClient } = useWalletClient()
  const publicClient = usePublicClient()
  const queryClient = useQueryClient()
  const domainOk = useDomainOk()
  const { publicStatus } = useDomainStatus()
  const [snapshot, setSnapshot] = useState<TransactionSnapshot>(IDLE)
  const [dialogAction, setDialogAction] = useState<IncidentAction | null>(null)
  const resuming = useRef(false)
  const storageKey = useMemo(
    () => pendingStorageKey(activeNetwork.key, incidentKey),
    [incidentKey],
  )

  function createDependencies(action?: IncidentAction): TransactionDependencies<unknown> | null {
    if (!publicClient) return null
    return {
      simulate: async (action) => {
        if (!address) throw new Error('Ví chưa kết nối')
        const result = await publicClient.simulateContract({
          account: address,
          address: activeNetwork.address,
          abi: AIR_SAFETY_LOG_ABI,
          functionName: action,
          args: [incidentKey],
        })
        return result.request
      },
      submit: async (request) => {
        if (!walletClient) throw new Error('Ví chưa kết nối')
        return walletClient.writeContract(
          request as Parameters<typeof walletClient.writeContract>[0],
        )
      },
      waitForReceipt: async (hash) => {
        const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 })
        return { status: receipt.status }
      },
      refetchChain: async () => {
        await refetchChain()
        if (action) await afterConfirmed?.(action)
      },
      invalidateQueries: async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['incident', deviceId, incidentId] }),
          queryClient.invalidateQueries({ queryKey: ['incidents', deviceId] }),
          queryClient.invalidateQueries({ queryKey: ['device-history', deviceId] }),
          queryClient.invalidateQueries({ queryKey: ['devices'] }),
        ])
      },
      readOwnerStatus,
      persist: (pending: PendingIncidentTransaction) => {
        try {
          localStorage.setItem(storageKey, JSON.stringify(pending))
        } catch {
          // A storage quota/privacy failure must not prevent a valid tx.
        }
      },
      clearPending: () => {
        try {
          localStorage.removeItem(storageKey)
        } catch {
          // Receipt reconciliation is still complete in memory.
        }
      },
      sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
    }
  }

  useEffect(() => {
    if (resuming.current || publicStatus !== 'correct') return
    const pending = loadPendingTransaction(storageKey)
    if (!pending || pending.deviceId !== deviceId || pending.incidentId !== incidentId) return
    const dependencies = createDependencies(pending.action)
    if (!dependencies) return
    resuming.current = true
    void resumeIncidentTransaction(pending, dependencies, setSnapshot).finally(() => {
      resuming.current = false
    })
    // Account/wallet state is intentionally absent: receipt reconciliation
    // uses the validated public RPC and works even while the wallet is offline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, incidentId, publicClient, publicStatus, storageKey])

  async function submitAction(action: IncidentAction) {
    setDialogAction(null)
    if (!domainOk) return
    const dependencies = createDependencies(action)
    if (!dependencies) return
    const result = await runIncidentTransaction(
      { action, incidentKey, deviceId, incidentId },
      dependencies,
      setSnapshot,
    )
    if (result.stage === 'cancelled') setSnapshot(IDLE)
  }

  if (!isConnected || !isOwner || !domainOk) return null

  const canAcknowledge = chainStatus === 'Logged'
  const canResolve = chainStatus === 'Logged' || chainStatus === 'Acknowledged'
  const busy = isTransactionBusy(snapshot.stage)
  const errorMessage = snapshot.error
    ? snapshot.error instanceof TransactionRevertedError
      ? snapshot.error.message
      : decodeError(snapshot.error).message
    : null

  return (
    <div className="flex flex-col gap-2">
      {canAcknowledge ? (
        <PrimaryButton
          label="Xác nhận"
          loading={busy && snapshot.action === 'acknowledgeIncident'}
          disabled={busy}
          onClick={() => {
            setSnapshot(IDLE)
            setDialogAction('acknowledgeIncident')
          }}
        />
      ) : null}
      {canResolve ? (
        <PrimaryButton
          label="Đã xử lý"
          loading={busy && snapshot.action === 'resolveIncident'}
          disabled={busy}
          onClick={() => {
            setSnapshot(IDLE)
            setDialogAction('resolveIncident')
          }}
        />
      ) : null}

      {snapshot.stage === 'simulating' ? <p className="text-[13px] text-ink-2">Đang mô phỏng giao dịch…</p> : null}
      {snapshot.stage === 'awaiting_wallet' ? <p className="text-[13px] text-ink-2">Đang chờ xác nhận trong ví…</p> : null}
      {snapshot.stage === 'confirming' ? <p className="text-[13px] text-ink-2">Đã gửi, đang chờ receipt on-chain…</p> : null}
      {snapshot.stage === 'indexing' ? <p className="text-[13px] text-ink-2">Chain đã xác nhận, đang chờ API đồng bộ…</p> : null}
      {snapshot.stage === 'error' && errorMessage ? <p className="text-[13px] text-danger">{errorMessage}</p> : null}
      {snapshot.stage === 'success' && snapshot.apiSyncDelayed ? (
        <p className="text-[13px] text-warn">API đang chậm, giao dịch đã được ghi nhận trên chain.</p>
      ) : null}
      {snapshot.txHash ? (
        <p className="text-[13px] text-ink-2">
          Tx: <ExplorerLink kind="tx" value={snapshot.txHash} label={`${snapshot.txHash.slice(0, 10)}…`} />
        </p>
      ) : null}

      <ConfirmDialog
        open={dialogAction !== null}
        title={dialogAction === 'acknowledgeIncident' ? 'Xác nhận sự cố?' : 'Đánh dấu đã xử lý?'}
        message="Giao dịch sẽ được mô phỏng trước khi yêu cầu ví ký."
        onCancel={() => setDialogAction(null)}
        onConfirm={() => {
          if (dialogAction) void submitAction(dialogAction)
        }}
      />
    </div>
  )
}
