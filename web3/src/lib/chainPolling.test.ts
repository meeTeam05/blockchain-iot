import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CHAIN_POLL_MS, setRealtimeLive, useChainPollInterval } from './chainPolling'
import { isFinalSettlement } from './useIncentives'

type Settlement = NonNullable<Parameters<typeof isFinalSettlement>[0]>['settlement']
const settlement = (overrides: Partial<Settlement> = {}): Settlement => ({
  covered: true, resolveDeadline: 1_000n, canRecordAck: false, canRecordResolve: false,
  canSlashMissedAck: false, canSlashLateRelay: false, ...overrides,
})

describe('chain polling', () => {
  afterEach(() => setRealtimeLive(false))

  it('polls only while the realtime stream is down', () => {
    const hook = renderHook(() => useChainPollInterval(CHAIN_POLL_MS))
    expect(hook.result.current).toBe(CHAIN_POLL_MS)
    act(() => setRealtimeLive(true))
    expect(hook.result.current).toBe(false)
    act(() => setRealtimeLive(false))
    expect(hook.result.current).toBe(CHAIN_POLL_MS)
  })

  it('stops polling a settlement only once time can no longer change it', () => {
    expect(isFinalSettlement(undefined)).toBe(false)
    expect(isFinalSettlement({ settlement: settlement(), block: { timestamp: 999n } })).toBe(false)
    expect(isFinalSettlement({ settlement: settlement(), block: { timestamp: 1_001n } })).toBe(true)
    expect(isFinalSettlement({ settlement: settlement({ canSlashLateRelay: true }), block: { timestamp: 1_001n } })).toBe(false)
    expect(isFinalSettlement({ settlement: settlement({ canSlashMissedAck: true }), block: { timestamp: 1_001n } })).toBe(false)
    expect(isFinalSettlement({ settlement: settlement({ covered: false }), block: { timestamp: 0n } })).toBe(true)
  })
})
