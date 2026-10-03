// Task 5/8 mobile view of one incident: on-chain progress (blockchain_outbox.status
// as `chain_status`), the owner lifecycle projected by the indexer (`owner_status`)
// and, when incentives are on, the acknowledge deadline derived from chain
// (`incentive.deadline_at` = AirSafetyLog loggedAt + ACK_DEADLINE[severity]).
// Only values the API actually returns are mapped; anything else is "unknown".

// blockchain_outbox.status (migrations 017/019).
export const CHAIN_STATUSES = [
  'queued',
  'pending',
  'confirmed',
  'failed',
  'blocked',
  'legacy_domain',
  'waiting_signer',
  'stale_signer',
] as const;
export type ChainStatus = (typeof CHAIN_STATUSES)[number];

// incidents.owner_status (migration 017), written by the chain indexer.
export const OWNER_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type OwnerStatus = (typeof OWNER_STATUSES)[number];

export interface IncidentChainInfo {
  chainStatus: string | null;
  ownerStatus: string | null;
  ackDeadlineAt: Date | null;
}

function asMap(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseIncidentChainInfo(data: unknown): IncidentChainInfo {
  const body = asMap(data);
  if (!body) throw new Error('Unexpected incident response');
  const incentive = asMap(body.incentive);
  const deadline = typeof incentive?.deadline_at === 'string' ? new Date(incentive.deadline_at) : null;
  return {
    chainStatus: typeof body.chain_status === 'string' ? body.chain_status : null,
    ownerStatus: typeof body.owner_status === 'string' ? body.owner_status : null,
    ackDeadlineAt: deadline && !Number.isNaN(deadline.getTime()) ? deadline : null,
  };
}

export type ChainTone = 'neutral' | 'progress' | 'success' | 'warning' | 'danger';

export interface ChainStatusLabel {
  label: string;
  tone: ChainTone;
}

const CHAIN_LABELS: Record<ChainStatus, ChainStatusLabel> = {
  queued: { label: 'Đang chờ đưa lên chain', tone: 'progress' },
  pending: { label: 'Đang ghi lên chain', tone: 'progress' },
  confirmed: { label: 'Đã ghi on-chain', tone: 'success' },
  failed: { label: 'Lỗi đưa lên chain', tone: 'danger' },
  blocked: { label: 'Bị chặn khi đưa lên chain', tone: 'danger' },
  legacy_domain: { label: 'Ký cho contract cũ, không lên chain', tone: 'neutral' },
  waiting_signer: { label: 'Chờ đăng ký signer on-chain', tone: 'warning' },
  stale_signer: { label: 'Signer cũ, không lên chain', tone: 'danger' },
};

export function isChainStatus(value: string | null): value is ChainStatus {
  return value !== null && (CHAIN_STATUSES as readonly string[]).includes(value);
}

// Owner lifecycle only exists once the incident is on chain.
export function chainStatusLabel(info: Pick<IncidentChainInfo, 'chainStatus' | 'ownerStatus'>): ChainStatusLabel {
  if (info.chainStatus === null) return { label: 'Chưa có trạng thái chain', tone: 'neutral' };
  if (!isChainStatus(info.chainStatus)) return { label: `Trạng thái chain không xác định (${info.chainStatus})`, tone: 'neutral' };
  if (info.chainStatus === 'confirmed') {
    if (info.ownerStatus === 'acknowledged') return { label: 'Đã ghi on-chain · Đã xác nhận', tone: 'success' };
    if (info.ownerStatus === 'resolved') return { label: 'Đã ghi on-chain · Đã xử lý', tone: 'success' };
  }
  return CHAIN_LABELS[info.chainStatus];
}

const URGENT_MS = 3 * 60_000;

export type AckCountdown =
  | { kind: 'none' }
  | { kind: 'waiting'; remainingMs: number; minutes: number; urgent: boolean }
  | { kind: 'expired' };

// The contract accepts a timely ack while block.timestamp <= deadline, so the
// deadline instant itself is still "waiting" (0 minutes left); later is expired.
// Acknowledged/resolved incidents and incidents without a deadline show nothing.
export function ackCountdown(info: IncidentChainInfo, nowMs: number): AckCountdown {
  if (!info.ackDeadlineAt || info.chainStatus !== 'confirmed' || info.ownerStatus !== 'open') return { kind: 'none' };
  const remainingMs = info.ackDeadlineAt.getTime() - nowMs;
  if (remainingMs < 0) return { kind: 'expired' };
  return { kind: 'waiting', remainingMs, minutes: Math.ceil(remainingMs / 60_000), urgent: remainingMs <= URGENT_MS };
}

export function ackCountdownText(countdown: AckCountdown): string | null {
  if (countdown.kind === 'waiting') return `Đang chờ acknowledge · Còn ${countdown.minutes} phút`;
  if (countdown.kind === 'expired') return 'Quá hạn acknowledge';
  return null;
}
