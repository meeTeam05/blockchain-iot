import { describe, expect, it, vi } from 'vitest'
import {
  isTransactionBusy,
  loadPendingTransaction,
  pendingStorageKey,
  resumeIncidentTransaction,
  runIncidentTransaction,
  TransactionRevertedError,
  type PendingIncidentTransaction,
  type TransactionDependencies,
  type TransactionSnapshot,
  type TransactionStage,
} from './incidentTransaction'

const hash = `0x${'11'.repeat(32)}` as const
const key = `0x${'22'.repeat(32)}` as const

function setup(statuses: Array<string | Error> = ['acknowledged']) {
  const order: string[] = []
  const pending: PendingIncidentTransaction[] = []
  const deps: TransactionDependencies<{ request: true }> = {
    simulate: vi.fn(async () => {
      order.push('simulate')
      return { request: true as const }
    }),
    submit: vi.fn(async () => {
      order.push('submit')
      return hash
    }),
    waitForReceipt: vi.fn(async () => {
      order.push('receipt')
      return { status: 'success' as const }
    }),
    refetchChain: vi.fn(async () => {
      order.push('chain')
    }),
    invalidateQueries: vi.fn(async () => {
      order.push('invalidate')
    }),
    readOwnerStatus: vi.fn(async () => {
      order.push('api')
      const value = statuses.shift() ?? 'acknowledged'
      if (value instanceof Error) throw value
      return value
    }),
    persist: vi.fn((value) => pending.push(value)),
    clearPending: vi.fn(),
    sleep: vi.fn(async () => {
      order.push('sleep')
    }),
  }
  return { deps, order, pending }
}

const input = {
  action: 'acknowledgeIncident' as const,
  incidentKey: key,
  deviceId: 'device-1',
  incidentId: hash,
  indexingTimeoutMs: 10,
  pollingIntervalMs: 5,
}

describe('incident transaction state machine', () => {
  it('runs simulate -> wallet -> receipt -> chain invalidation -> fresh API poll', async () => {
    const { deps, order, pending } = setup(['open', 'acknowledged'])
    const states: TransactionSnapshot[] = []
    const result = await runIncidentTransaction(input, deps, (state) => states.push(state))
    expect(result.stage).toBe('success')
    expect(pending[0]?.txHash).toBe(hash)
    expect(states.map(({ stage }) => stage)).toEqual([
      'simulating', 'awaiting_wallet', 'submitted', 'confirming', 'indexing', 'success',
    ])
    expect(order).toEqual(['simulate', 'submit', 'receipt', 'chain', 'invalidate', 'api', 'sleep', 'api'])
  })

  it('stops on simulation failure before opening the wallet', async () => {
    const { deps } = setup()
    vi.mocked(deps.simulate).mockRejectedValueOnce(new Error('simulation failed'))
    const result = await runIncidentTransaction(input, deps, () => {})
    expect(result.stage).toBe('error')
    expect(deps.submit).not.toHaveBeenCalled()
  })

  it('treats wallet rejection as cancelled without a red error', async () => {
    const { deps } = setup()
    vi.mocked(deps.submit).mockRejectedValueOnce({ code: 4001 })
    const states: TransactionSnapshot[] = []
    const result = await runIncidentTransaction(input, deps, (state) => states.push(state))
    expect(result.stage).toBe('cancelled')
    expect(states.at(-1)?.stage).toBe('cancelled')
    expect(deps.persist).not.toHaveBeenCalled()
  })

  it('reports a reverted receipt and clears the terminal pending record', async () => {
    const { deps } = setup()
    vi.mocked(deps.waitForReceipt).mockResolvedValueOnce({ status: 'reverted' })
    const result = await runIncidentTransaction(input, deps, () => {})
    expect(result.stage).toBe('error')
    expect(result.error).toBeInstanceOf(TransactionRevertedError)
    expect(deps.clearPending).toHaveBeenCalledOnce()
  })

  it('keeps chain success when API indexing is delayed or temporarily errors', async () => {
    const { deps } = setup([new Error('503'), 'open', 'open'])
    const result = await runIncidentTransaction(input, deps, () => {})
    expect(result).toMatchObject({ stage: 'success', apiSyncDelayed: true })
    expect(deps.readOwnerStatus).toHaveBeenCalledTimes(3)
  })

  it('resumes a persisted hash without simulating or submitting again', async () => {
    const { deps, pending } = setup()
    await runIncidentTransaction(input, deps, () => {})
    vi.clearAllMocks()
    await resumeIncidentTransaction(pending[0], deps, () => {}, {
      indexingTimeoutMs: 0,
      pollingIntervalMs: 1,
    })
    expect(deps.simulate).not.toHaveBeenCalled()
    expect(deps.submit).not.toHaveBeenCalled()
    expect(deps.waitForReceipt).toHaveBeenCalledWith(hash)
  })

  it('round-trips the versioned pending record used after reload', () => {
    const pending: PendingIncidentTransaction = {
      version: 1,
      action: 'acknowledgeIncident',
      incidentKey: key,
      deviceId: 'device-1',
      incidentId: hash,
      txHash: hash,
      expectedOwnerStatus: 'acknowledged',
      submittedAt: 1,
    }
    const storageKey = pendingStorageKey('localhost', key)
    localStorage.setItem(storageKey, JSON.stringify(pending))
    expect(loadPendingTransaction(storageKey)).toEqual(pending)
  })

  it('isolates one action failure so a later action can succeed', async () => {
    const { deps } = setup(['resolved'])
    vi.mocked(deps.simulate).mockRejectedValueOnce(new Error('ack failed'))
    expect((await runIncidentTransaction(input, deps, () => {})).stage).toBe('error')
    expect((await runIncidentTransaction({ ...input, action: 'resolveIncident' }, deps, () => {})).stage).toBe('success')
  })

  it('marks every in-flight phase busy for mutual button exclusion', () => {
    const busyStages: TransactionStage[] = ['simulating', 'awaiting_wallet', 'submitted', 'confirming', 'indexing']
    const terminalStages: TransactionStage[] = ['idle', 'success', 'cancelled', 'error']
    expect(busyStages.every(isTransactionBusy)).toBe(true)
    expect(terminalStages.some(isTransactionBusy)).toBe(false)
  })
})
