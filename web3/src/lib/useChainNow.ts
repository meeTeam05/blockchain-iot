import { useEffect, useState } from 'react'

// Anchor to the latest RPC block, rather than the browser's wall clock (Hardhat
// can advance days instantly). Wall time is only used for elapsed seconds.
export function useChainNow(timestamp?: bigint) {
  const [clock, setClock] = useState({ timestamp, now: timestamp })
  useEffect(() => {
    const at = Date.now()
    const timer = setInterval(() => setClock({ timestamp,
      now: timestamp === undefined ? undefined : timestamp + BigInt(Math.max(0, Math.floor((Date.now() - at) / 1000))) }), 1000)
    return () => clearInterval(timer)
  }, [timestamp])
  return clock.timestamp === timestamp ? clock.now : timestamp
}
