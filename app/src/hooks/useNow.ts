import { useEffect, useState } from 'react';
import { startClock } from '../lib/clock';

// Wall-clock "now" that re-renders every intervalMs until `untilMs` has passed, then
// stops its own timer. null `untilMs` means no timer at all; null result means
// "not ticked yet" (the first tick happens synchronously when the effect starts).
export function useNow(untilMs: number | null, intervalMs = 1_000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (untilMs === null) return undefined;
    let stopped = false;
    let stop = () => {};
    stop = startClock(
      (t) => {
        setNow(t);
        if (t > untilMs && !stopped) {
          stopped = true;
          stop();
        }
      },
      { intervalMs, immediate: true },
    );
    if (Date.now() > untilMs) stop();
    return () => stop();
  }, [untilMs, intervalMs]);
  return now;
}
