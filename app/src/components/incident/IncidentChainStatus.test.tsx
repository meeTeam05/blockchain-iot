import type { ReactElement } from 'react';
import { IncidentChainStatus } from './IncidentChainStatus';
import { IncidentChainInfo } from '../../models/incident';

// react-test-renderer ships without type declarations; only what this test uses.
interface TestNode { type: unknown; props: Record<string, unknown> & { children?: unknown } }
interface ReactTestRenderer {
  root: { findAll: (predicate: (node: TestNode) => boolean) => TestNode[] };
  update: (element: ReactElement) => void;
  unmount: () => void;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { act, create } = require('react-test-renderer') as {
  act: (callback: () => void) => void;
  create: (element: ReactElement) => ReactTestRenderer;
};

const mockQuery: { current: { isPending: boolean; isError: boolean; data?: IncidentChainInfo; error?: Error } } = {
  current: { isPending: true, isError: false },
};
jest.mock('../../queries/incidents', () => ({ useIncidentChainInfo: () => mockQuery.current }));

const NOW = Date.parse('2026-10-03T10:00:00Z');
const INCIDENT = `0x${'ab'.repeat(32)}`;
const deadlineIn = (ms: number) => new Date(NOW + ms);

let renderer: ReactTestRenderer | null = null;
function mount() {
  act(() => {
    renderer = create(<IncidentChainStatus deviceId="d1" incidentId={INCIDENT} />);
  });
  return renderer!;
}
function text(testID: string): string | null {
  const found = renderer!.root.findAll((node) => node.props.testID === testID && typeof node.type === 'string');
  if (found.length === 0) return null;
  return ([] as unknown[]).concat(found[0].props.children).join('');
}

beforeEach(() => {
  jest.useFakeTimers({ now: NOW });
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});

test('loading and API error are shown as such, never as a chain state', () => {
  mount();
  expect(text('incident-chain-loading')).toBe('Đang tải trạng thái chain…');
  expect(text('incident-chain-status')).toBeNull();
  mockQuery.current = { isPending: false, isError: true, error: new Error('Network Error') };
  act(() => renderer!.update(<IncidentChainStatus deviceId="d1" incidentId={INCIDENT} />));
  expect(text('incident-chain-error')).toBe('Không tải được trạng thái chain: Network Error');
  expect(text('incident-chain-status')).toBeNull();
});

test('counts down while waiting, turns urgent then expired, and stops ticking', () => {
  mockQuery.current = { isPending: false, isError: false,
    data: { chainStatus: 'confirmed', ownerStatus: 'open', ackDeadlineAt: deadlineIn(4 * 60_000) } };
  mount();
  expect(text('incident-chain-status')).toBe('Đã ghi on-chain');
  expect(text('incident-ack-countdown')).toBe('Đang chờ acknowledge · Còn 4 phút');
  expect(jest.getTimerCount()).toBe(1);
  act(() => jest.advanceTimersByTime(60_000));
  expect(text('incident-ack-countdown')).toBe('Đang chờ acknowledge · Còn 3 phút');
  act(() => jest.advanceTimersByTime(3 * 60_000));
  expect(text('incident-ack-countdown')).toBe('Đang chờ acknowledge · Còn 0 phút');
  act(() => jest.advanceTimersByTime(1_000));
  expect(text('incident-ack-countdown')).toBe('Quá hạn acknowledge');
  expect(jest.getTimerCount()).toBe(0);
});

test('acknowledged, resolved or no deadline: no countdown and no timer', () => {
  for (const data of [
    { chainStatus: 'confirmed', ownerStatus: 'acknowledged', ackDeadlineAt: deadlineIn(60_000) },
    { chainStatus: 'confirmed', ownerStatus: 'resolved', ackDeadlineAt: deadlineIn(60_000) },
    { chainStatus: 'confirmed', ownerStatus: 'open', ackDeadlineAt: null },
    { chainStatus: null, ownerStatus: 'open', ackDeadlineAt: null },
  ]) {
    mockQuery.current = { isPending: false, isError: false, data };
    mount();
    expect(text('incident-ack-countdown')).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
    act(() => renderer!.unmount());
  }
  renderer = null;
});

test('unmount clears the countdown timer', () => {
  mockQuery.current = { isPending: false, isError: false,
    data: { chainStatus: 'confirmed', ownerStatus: 'open', ackDeadlineAt: deadlineIn(10 * 60_000) } };
  mount();
  expect(jest.getTimerCount()).toBe(1);
  act(() => renderer!.unmount());
  renderer = null;
  expect(jest.getTimerCount()).toBe(0);
});
