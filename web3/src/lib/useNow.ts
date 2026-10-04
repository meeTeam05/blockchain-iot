import { useEffect, useState } from 'react'

/** Wall-clock milliseconds, re-read every `intervalMs` while `enabled`. */
export function useNow(intervalMs: number, enabled = true) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const tick = () => setNow(Date.now())
    // Re-read at once when (re-)enabled, so a device coming back online is not
    // judged against a clock frozen while it was offline.
    const first = setTimeout(tick, 0)
    const timer = setInterval(tick, intervalMs)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [intervalMs, enabled])
  return now
}
