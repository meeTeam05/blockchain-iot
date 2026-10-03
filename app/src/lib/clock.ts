import { AppState, AppStateStatus } from 'react-native';

type AppStateSource = Pick<typeof AppState, 'currentState' | 'addEventListener'>;

// Calls onTick(now) every intervalMs while the app is in the foreground. The caller
// derives everything from the reported wall-clock time, so a background pause or a
// late interval never accumulates drift; returning to the foreground ticks at once.
// With `immediate`, it also ticks once synchronously. The returned function stops
// the interval and removes the AppState listener.
export function startClock(
  onTick: (nowMs: number) => void,
  { intervalMs = 1_000, appState = AppState as AppStateSource, now = Date.now, immediate = false } = {},
): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  const stopTimer = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const startTimer = () => {
    stopTimer();
    timer = setInterval(() => onTick(now()), intervalMs);
  };
  const subscription = appState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'active') {
      onTick(now());
      startTimer();
    } else {
      stopTimer();
    }
  });
  if (appState.currentState !== 'background' && appState.currentState !== 'inactive') {
    if (immediate) onTick(now());
    startTimer();
  }
  return () => {
    stopTimer();
    subscription.remove();
  };
}
