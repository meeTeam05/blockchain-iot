import { startClock } from './clock';

function fakeAppState(initial: string) {
  const listeners = new Set<(state: string) => void>();
  return {
    currentState: initial,
    addEventListener: jest.fn((_event: string, listener: (state: string) => void) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    }),
    emit: (state: string) => listeners.forEach((listener) => listener(state)),
    count: () => listeners.size,
  };
}

beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
afterEach(() => jest.useRealTimers());

test('ticks with the wall clock while active and cleans up everything', () => {
  const appState = fakeAppState('active');
  const ticks: number[] = [];
  const stop = startClock((now) => ticks.push(now), { intervalMs: 1_000, appState: appState as never });
  jest.advanceTimersByTime(3_000);
  expect(ticks).toEqual([1_001_000, 1_002_000, 1_003_000]);
  stop();
  expect(jest.getTimerCount()).toBe(0);
  expect(appState.count()).toBe(0);
  jest.advanceTimersByTime(5_000);
  expect(ticks).toHaveLength(3);
});

test('pauses in background and resyncs immediately on foreground (no drift)', () => {
  const appState = fakeAppState('active');
  const ticks: number[] = [];
  const stop = startClock((now) => ticks.push(now), { intervalMs: 1_000, appState: appState as never });
  appState.emit('background');
  expect(jest.getTimerCount()).toBe(0);
  jest.advanceTimersByTime(600_000);
  expect(ticks).toHaveLength(0);
  appState.emit('active');
  expect(ticks).toEqual([1_600_000]);
  expect(jest.getTimerCount()).toBe(1);
  stop();
  expect(jest.getTimerCount()).toBe(0);
});

test('does not start an interval while the app is in the background', () => {
  const appState = fakeAppState('background');
  const stop = startClock(() => {}, { appState: appState as never });
  expect(jest.getTimerCount()).toBe(0);
  stop();
});

test('immediate ticks once synchronously before the interval', () => {
  const appState = fakeAppState('active');
  const ticks: number[] = [];
  const stop = startClock((now) => ticks.push(now), { appState: appState as never, immediate: true });
  expect(ticks).toEqual([1_000_000]);
  stop();
});
