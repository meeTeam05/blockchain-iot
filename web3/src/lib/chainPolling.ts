import { useSyncExternalStore } from 'react'

// While the SSE stream is connected, RealtimeSync invalidates active queries on
// every incident/incentive event, so chain reads tied to the user's own devices
// do not need to poll. They fall back to polling only while the stream is down.
export const SETTLEMENT_POLL_MS = 15_000
export const CHAIN_POLL_MS = 30_000

let realtimeLive = false
const listeners = new Set<() => void>()

export function setRealtimeLive(live: boolean) {
  if (realtimeLive === live) return
  realtimeLive = live
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useRealtimeLive() {
  return useSyncExternalStore(subscribe, () => realtimeLive, () => false)
}

export function useChainPollInterval(ms: number): number | false {
  return useRealtimeLive() ? false : ms
}
