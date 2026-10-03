import { z } from 'zod';
import { zDateTimeNullable } from './shared';

const DeviceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    home_id: z.string(),
    room_id: z.string().nullable().optional(),
    online: z.boolean().default(false),
    last_seen: zDateTimeNullable,
    firmware_ver: z.string().nullable().optional(),
    mode: z.string().nullable().optional(),
    relay_1: z.boolean().nullable().optional(),
    relay_2: z.boolean().nullable().optional(),
    relay_3: z.boolean().nullable().optional(),
    created_at: zDateTimeNullable,
  })
  .transform((raw) => ({
    id: raw.id,
    name: raw.name,
    homeId: raw.home_id,
    roomId: raw.room_id ?? null,
    online: raw.online,
    lastSeen: raw.last_seen,
    firmwareVer: raw.firmware_ver ?? null,
    mode: raw.mode ?? null,
    relay1: raw.relay_1 ?? null,
    relay2: raw.relay_2 ?? null,
    relay3: raw.relay_3 ?? null,
    createdAt: raw.created_at,
  }));

export type Device = z.infer<typeof DeviceSchema>;

export function parseDevice(json: unknown): Device {
  return DeviceSchema.parse(json);
}

const DeviceShadowSchema = z
  .object({
    reported: z.record(z.string(), z.unknown()).default({}),
    desired: z.record(z.string(), z.unknown()).default({}),
    updatedAt: zDateTimeNullable,
  })
  .transform((raw) => ({
    reported: raw.reported,
    desired: raw.desired,
    updatedAt: raw.updatedAt,
  }));

export type DeviceShadow = z.infer<typeof DeviceShadowSchema>;

export function parseDeviceShadow(json: unknown): DeviceShadow {
  return DeviceShadowSchema.parse(json);
}
