import { z } from 'zod';

export type RealtimeStatus = 'disconnected' | 'connecting' | 'connected' | 'degraded';

const EPOCH = new Date(0);

function parseOccurredAt(value: unknown): Date {
  if (typeof value === 'string') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return EPOCH;
}

// Mirrors Dart's RealtimeEvent.fromJson: tolerant of missing/malformed
// fields rather than throwing, so one bad SSE frame doesn't kill the stream.
const RealtimeEventSchema = z
  .object({
    id: z
      .unknown()
      .optional()
      .transform((v) => String(v ?? null)),
    type: z.string().catch(''),
    device_id: z.string().catch(''),
    occurred_at: z.unknown().optional(),
    payload: z.record(z.string(), z.unknown()).catch({}),
  })
  .transform((raw) => ({
    id: raw.id,
    type: raw.type,
    deviceId: raw.device_id,
    occurredAt: parseOccurredAt(raw.occurred_at),
    payload: raw.payload,
  }));

export type RealtimeEvent = z.infer<typeof RealtimeEventSchema>;

export function parseRealtimeEvent(json: unknown): RealtimeEvent {
  return RealtimeEventSchema.parse(json);
}
