import type { Hash } from 'viem'

export type IncidentAction = 'acknowledgeIncident' | 'resolveIncident'
export type TransactionStage =
  | 'idle'
  | 'simulating'
  | 'awaiting_wallet'
  | 'submitted'
  | 'confirming'
  | 'indexing'
  | 'success'
  | 'cancelled'
  | 'error'

export interface PendingIncidentTransaction {
  version: 1
  action: IncidentAction
  incidentKey: Hash
  deviceId: string
  incidentId: string
  txHash: Hash
  expectedOwnerStatus: 'acknowledged' | 'resolved'
  submittedAt: number
}

export interface TransactionSnapshot {
  stage: TransactionStage
  action: IncidentAction | null
  txHash?: Hash
  error?: unknown
  apiSyncDelayed?: boolean
}

export interface TransactionResult {
  stage: 'success' | 'cancelled' | 'error'
  txHash?: Hash
  apiSyncDelayed?: boolean
  error?: unknown
}

export interface TransactionDependencies<TRequest> {
  simulate(action: IncidentAction): Promise<TRequest>
  submit(request: TRequest): Promise<Hash>
  waitForReceipt(hash: Hash): Promise<{ status: 'success' | 'reverted' }>
  refetchChain(): Promise<void>
  invalidateQueries(): Promise<void>
  readOwnerStatus(): Promise<string | null | undefined>
  persist(pending: PendingIncidentTransaction): void
  clearPending(): void
  sleep(ms: number): Promise<void>
}

export interface TransactionInput {
  action: IncidentAction
  incidentKey: Hash
  deviceId: string
  incidentId: string
  indexingTimeoutMs?: number
  pollingIntervalMs?: number
}

const DEFAULT_INDEXING_TIMEOUT_MS = 2 * 60_000
const DEFAULT_POLLING_INTERVAL_MS = 3_000
const STORAGE_PREFIX = 'smartair-pending-incident-tx'

export class TransactionRevertedError extends Error {
  constructor() {
    super('Giao dịch đã bị revert trên chain')
    this.name = 'TransactionRevertedError'
  }
}

export function isTransactionBusy(stage: TransactionStage) {
  return ['simulating', 'awaiting_wallet', 'submitted', 'confirming', 'indexing'].includes(stage)
}

export function isUserRejected(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: number; name?: string; cause?: unknown }
  return (
    candidate.code === 4001 ||
    candidate.name === 'UserRejectedRequestError' ||
    (candidate.cause !== error && isUserRejected(candidate.cause))
  )
}

export function pendingStorageKey(network: string, incidentKey: Hash) {
  return `${STORAGE_PREFIX}:${network}:${incidentKey.toLowerCase()}`
}

export function loadPendingTransaction(key: string): PendingIncidentTransaction | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PendingIncidentTransaction>
    if (
      value.version !== 1 ||
      (value.action !== 'acknowledgeIncident' && value.action !== 'resolveIncident') ||
      typeof value.txHash !== 'string' ||
      typeof value.incidentKey !== 'string'
    ) {
      localStorage.removeItem(key)
      return null
    }
    return value as PendingIncidentTransaction
  } catch {
    return null
  }
}

async function finishConfirmed<TRequest>(
  pending: PendingIncidentTransaction,
  dependencies: TransactionDependencies<TRequest>,
  emit: (snapshot: TransactionSnapshot) => void,
  timeoutMs: number,
  intervalMs: number,
): Promise<TransactionResult> {
  // Receipt is canonical. Projection refresh failures are deliberately kept
  // out of the transaction error path; the API/indexer may simply be behind.
  await Promise.allSettled([dependencies.refetchChain(), dependencies.invalidateQueries()])
  emit({ stage: 'indexing', action: pending.action, txHash: pending.txHash })

  const attempts = Math.max(1, Math.ceil(timeoutMs / intervalMs) + 1)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      if ((await dependencies.readOwnerStatus()) === pending.expectedOwnerStatus) {
        dependencies.clearPending()
        const result = { stage: 'success', txHash: pending.txHash } as const
        emit({ ...result, action: pending.action })
        return result
      }
    } catch {
      // Keep polling a fresh API read until the bounded deadline.
    }
    if (attempt < attempts - 1) await dependencies.sleep(intervalMs)
  }

  dependencies.clearPending()
  const result = { stage: 'success', txHash: pending.txHash, apiSyncDelayed: true } as const
  emit({ ...result, action: pending.action })
  return result
}

async function reconcilePending<TRequest>(
  pending: PendingIncidentTransaction,
  dependencies: TransactionDependencies<TRequest>,
  emit: (snapshot: TransactionSnapshot) => void,
  timeoutMs: number,
  intervalMs: number,
): Promise<TransactionResult> {
  emit({ stage: 'submitted', action: pending.action, txHash: pending.txHash })
  emit({ stage: 'confirming', action: pending.action, txHash: pending.txHash })
  try {
    const receipt = await dependencies.waitForReceipt(pending.txHash)
    if (receipt.status === 'reverted') {
      dependencies.clearPending()
      throw new TransactionRevertedError()
    }
    return finishConfirmed(pending, dependencies, emit, timeoutMs, intervalMs)
  } catch (error) {
    emit({ stage: 'error', action: pending.action, txHash: pending.txHash, error })
    return { stage: 'error', txHash: pending.txHash, error }
  }
}

export async function runIncidentTransaction<TRequest>(
  input: TransactionInput,
  dependencies: TransactionDependencies<TRequest>,
  emit: (snapshot: TransactionSnapshot) => void,
): Promise<TransactionResult> {
  const expectedOwnerStatus =
    input.action === 'acknowledgeIncident' ? 'acknowledged' : 'resolved'
  try {
    emit({ stage: 'simulating', action: input.action })
    const request = await dependencies.simulate(input.action)
    emit({ stage: 'awaiting_wallet', action: input.action })
    let txHash: Hash
    try {
      txHash = await dependencies.submit(request)
    } catch (error) {
      if (isUserRejected(error)) {
        emit({ stage: 'cancelled', action: input.action })
        return { stage: 'cancelled' }
      }
      throw error
    }

    const pending: PendingIncidentTransaction = {
      version: 1,
      action: input.action,
      incidentKey: input.incidentKey,
      deviceId: input.deviceId,
      incidentId: input.incidentId,
      txHash,
      expectedOwnerStatus,
      submittedAt: Date.now(),
    }
    dependencies.persist(pending)
    return reconcilePending(
      pending,
      dependencies,
      emit,
      input.indexingTimeoutMs ?? DEFAULT_INDEXING_TIMEOUT_MS,
      input.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS,
    )
  } catch (error) {
    emit({ stage: 'error', action: input.action, error })
    return { stage: 'error', error }
  }
}

export function resumeIncidentTransaction<TRequest>(
  pending: PendingIncidentTransaction,
  dependencies: TransactionDependencies<TRequest>,
  emit: (snapshot: TransactionSnapshot) => void,
  options: { indexingTimeoutMs?: number; pollingIntervalMs?: number } = {},
) {
  return reconcilePending(
    pending,
    dependencies,
    emit,
    options.indexingTimeoutMs ?? DEFAULT_INDEXING_TIMEOUT_MS,
    options.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS,
  )
}
