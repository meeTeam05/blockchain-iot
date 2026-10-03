import {
  CHAIN_STATUSES,
  ackCountdown,
  ackCountdownText,
  chainStatusLabel,
  parseIncidentChainInfo,
  IncidentChainInfo,
} from './incident';

const DEADLINE = new Date('2026-10-03T10:30:00Z');
const at = (msBefore: number) => DEADLINE.getTime() - msBefore;
const open: IncidentChainInfo = { chainStatus: 'confirmed', ownerStatus: 'open', ackDeadlineAt: DEADLINE };

describe('parseIncidentChainInfo', () => {
  it('reads chain_status, owner_status and the chain-derived deadline', () => {
    expect(parseIncidentChainInfo({
      chain_status: 'confirmed', owner_status: 'open', incentive: { deadline_at: DEADLINE.toISOString() },
    })).toEqual(open);
  });
  it('keeps missing values as null instead of inventing them', () => {
    expect(parseIncidentChainInfo({ chain_status: null, owner_status: 'open', incentive: null }))
      .toEqual({ chainStatus: null, ownerStatus: 'open', ackDeadlineAt: null });
    expect(parseIncidentChainInfo({ chain_status: 'queued', owner_status: 'open', incentive: { deadline_at: 'bad' } }).ackDeadlineAt).toBeNull();
  });
  it('rejects a non-object response', () => {
    expect(() => parseIncidentChainInfo([])).toThrow('Unexpected incident response');
  });
});

describe('chainStatusLabel', () => {
  it.each([
    ['queued', 'Đang chờ đưa lên chain', 'progress'],
    ['pending', 'Đang ghi lên chain', 'progress'],
    ['confirmed', 'Đã ghi on-chain', 'success'],
    ['failed', 'Lỗi đưa lên chain', 'danger'],
    ['blocked', 'Bị chặn khi đưa lên chain', 'danger'],
    ['legacy_domain', 'Ký cho contract cũ, không lên chain', 'neutral'],
    ['waiting_signer', 'Chờ đăng ký signer on-chain', 'warning'],
    ['stale_signer', 'Signer cũ, không lên chain', 'danger'],
  ])('maps %s', (status, label, tone) => {
    expect(chainStatusLabel({ chainStatus: status, ownerStatus: 'open' })).toEqual({ label, tone });
  });
  it('covers every backend outbox status', () => {
    expect(CHAIN_STATUSES).toHaveLength(8);
  });
  it('adds the owner lifecycle once on chain', () => {
    expect(chainStatusLabel({ chainStatus: 'confirmed', ownerStatus: 'acknowledged' }).label).toBe('Đã ghi on-chain · Đã xác nhận');
    expect(chainStatusLabel({ chainStatus: 'confirmed', ownerStatus: 'resolved' }).label).toBe('Đã ghi on-chain · Đã xử lý');
  });
  it('separates "no chain state yet" from unknown values', () => {
    expect(chainStatusLabel({ chainStatus: null, ownerStatus: 'open' }).label).toBe('Chưa có trạng thái chain');
    expect(chainStatusLabel({ chainStatus: 'mystery', ownerStatus: 'open' }).label).toBe('Trạng thái chain không xác định (mystery)');
  });
});

describe('ackCountdown', () => {
  it('more than 3 minutes left: waiting, not urgent', () => {
    const c = ackCountdown(open, at(10 * 60_000));
    expect(c).toEqual({ kind: 'waiting', remainingMs: 600_000, minutes: 10, urgent: false });
    expect(ackCountdownText(c)).toBe('Đang chờ acknowledge · Còn 10 phút');
  });
  it('3 minutes or less: urgent, minutes rounded up', () => {
    expect(ackCountdown(open, at(3 * 60_000))).toMatchObject({ kind: 'waiting', minutes: 3, urgent: true });
    expect(ackCountdown(open, at(90_000))).toMatchObject({ kind: 'waiting', minutes: 2, urgent: true });
  });
  it('exactly at the deadline: still waiting with 0 minutes, never negative', () => {
    expect(ackCountdown(open, DEADLINE.getTime())).toEqual({ kind: 'waiting', remainingMs: 0, minutes: 0, urgent: true });
  });
  it('after the deadline: expired', () => {
    const c = ackCountdown(open, DEADLINE.getTime() + 1);
    expect(c).toEqual({ kind: 'expired' });
    expect(ackCountdownText(c)).toBe('Quá hạn acknowledge');
  });
  it('acknowledged or resolved incidents stop the countdown', () => {
    expect(ackCountdown({ ...open, ownerStatus: 'acknowledged' }, at(60_000))).toEqual({ kind: 'none' });
    expect(ackCountdown({ ...open, ownerStatus: 'resolved' }, DEADLINE.getTime() + 60_000)).toEqual({ kind: 'none' });
  });
  it('no deadline (incentives off) or not on chain: no fake countdown', () => {
    expect(ackCountdown({ ...open, ackDeadlineAt: null }, at(60_000))).toEqual({ kind: 'none' });
    expect(ackCountdown({ ...open, chainStatus: 'pending' }, at(60_000))).toEqual({ kind: 'none' });
    expect(ackCountdownText({ kind: 'none' })).toBeNull();
  });
});
