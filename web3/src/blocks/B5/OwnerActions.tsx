import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAccount, usePublicClient, useWalletClient } from 'wagmi'
import type { Hash } from 'viem'
import { ExplorerLink } from '../../components/ExplorerLink'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
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

function ActionButton({
  label,
  variant,
  loading,
  disabled,
  onClick,
}: {
  label: string
  variant: 'primary' | 'outline'
  loading: boolean
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex h-10 items-center justify-center gap-2 rounded-[10px] text-[14px] font-semibold transition-colors disabled:cursor-not-allowed ${
        variant === 'primary'
          ? 'border-0 bg-[#16803c] text-white hover:bg-[#0f5f2c] disabled:bg-[#e3e8e1] disabled:text-[#8a958c]'
          : 'border border-[#dfe4dc] bg-white text-[#17201a] hover:bg-[#f4f6f3] disabled:border-[#e3e8e1] disabled:bg-white disabled:text-[#a3ada5]'
      }`}
    >
      {loading ? <span className="size-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden /> : null}
      {label}
    </button>
  )
}

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
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {canAcknowledge ? (
          <ActionButton
            label="Xác nhận đã biết"
            variant="primary"
            loading={busy && snapshot.action === 'acknowledgeIncident'}
            disabled={busy}
            onClick={() => {
              setSnapshot(IDLE)
              setDialogAction('acknowledgeIncident')
            }}
          />
        ) : null}
        {canResolve ? (
          <ActionButton
            label="Đánh dấu đã xử lý"
            variant={canAcknowledge ? 'outline' : 'primary'}
            loading={busy && snapshot.action === 'resolveIncident'}
            disabled={busy}
            onClick={() => {
              setSnapshot(IDLE)
              setDialogAction('resolveIncident')
            }}
          />
        ) : null}
        {canAcknowledge && !canResolve ? (
          <p className="m-0 text-center text-[12px] text-[#8a958c]">Đánh dấu đã xử lý mở sau khi xác nhận</p>
        ) : null}
      </div>

      {snapshot.stage === 'simulating' ? (
        <div className="flex items-center gap-2 rounded-xl bg-canvas p-3 text-[13px] text-ink-2">
          <span className="size-3 animate-spin rounded-full border-2 border-brand border-r-transparent" />
          <p>Đang mô phỏng giao dịch…</p>
        </div>
      ) : null}

      {snapshot.stage === 'awaiting_wallet' ? (
        <div className="flex items-center gap-2 rounded-xl border border-accent-bright/30 bg-accent-tint p-3 text-[13px] font-medium text-accent">
          <span className="size-3 animate-pulse rounded-full bg-accent-bright" />
          <p>Đang chờ xác nhận trong ví…</p>
        </div>
      ) : null}

      {snapshot.stage === 'confirming' ? (
        <div className="flex items-center gap-2 rounded-xl border border-accent-bright/30 bg-accent-tint/60 p-3 text-[13px] text-accent">
          <span className="size-3 animate-spin rounded-full border-2 border-accent border-r-transparent" />
          <p>Đã gửi, đang chờ receipt on-chain…</p>
        </div>
      ) : null}

      {snapshot.stage === 'indexing' ? (
        <div className="flex items-center gap-2 rounded-xl bg-brand-tint/60 p-3 text-[13px] font-medium text-brand">
          <span className="size-2 rounded-full bg-brand-bright animate-ping" />
          <p>Chain đã xác nhận, đang chờ API đồng bộ…</p>
        </div>
      ) : null}

      {snapshot.stage === 'error' && errorMessage ? (
        <div className="rounded-xl border border-danger-bright/30 bg-danger-tint p-3 text-[13px] text-danger">
          <p className="font-semibold">Giao dịch thất bại</p>
          <p className="mt-0.5">{errorMessage}</p>
        </div>
      ) : null}

      {snapshot.stage === 'success' && snapshot.apiSyncDelayed ? (
        <div className="rounded-xl border border-warn/30 bg-warn-tint p-3 text-[13px] text-warn">
          <p>API đang chậm, giao dịch đã được ghi nhận trên chain.</p>
        </div>
      ) : null}

      {snapshot.txHash ? (
        <div className="flex items-center justify-between rounded-xl bg-canvas px-3 py-2 text-[12px] text-ink-2">
          <span>Giao dịch</span>
          <p className="text-[13px] text-ink-2 font-mono">
            Tx: <ExplorerLink kind="tx" value={snapshot.txHash} label={`${snapshot.txHash.slice(0, 10)}…`} />
          </p>
        </div>
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
