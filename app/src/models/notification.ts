import { z } from 'zod';

const EPOCH = new Date(0);

function parseOccurredAt(value: unknown): Date {
  if (typeof value === 'string') {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return EPOCH;
}

// Mirrors Dart's NotificationItem.fromJson: tolerant of missing/malformed
// fields (falls back to '' / 'info' / {} / epoch) rather than throwing, since
// a single bad notification shouldn't break the whole list.
const NotificationItemSchema = z
  .object({
    id: z
      .unknown()
      .optional()
      .transform((v) => String(v ?? null)),
    type: z.string().catch(''),
    device_id: z.string().catch(''),
    device_name: z.string().catch(''),
    title: z.string().catch(''),
    body: z.string().catch(''),
    severity: z.string().catch('info'),
    occurred_at: z.unknown().optional(),
    payload: z.record(z.string(), z.unknown()).catch({}),
  })
  .transform((raw) => ({
    id: raw.id,
    type: raw.type,
    deviceId: raw.device_id,
    deviceName: raw.device_name,
    title: raw.title,
    body: raw.body,
    severity: raw.severity,
    occurredAt: parseOccurredAt(raw.occurred_at),
    payload: raw.payload,
  }));

export type NotificationItem = z.infer<typeof NotificationItemSchema>;

export function parseNotificationItem(json: unknown): NotificationItem {
  return NotificationItemSchema.parse(json);
}
