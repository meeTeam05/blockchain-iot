import { z } from 'zod';

const HomeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    address: z.string().nullable().optional(),
    owner_id: z.string().nullable().optional(),
    timezone: z.string().default('Asia/Ho_Chi_Minh'),
  })
  .transform((raw) => ({
    id: raw.id,
    name: raw.name,
    address: raw.address ?? null,
    ownerId: raw.owner_id ?? null,
    timezone: raw.timezone,
  }));

export type Home = z.infer<typeof HomeSchema>;

export function parseHome(json: unknown): Home {
  return HomeSchema.parse(json);
}

const RoomSchema = z
  .object({
    id: z.string(),
    home_id: z.string(),
    name: z.string(),
    icon: z.string().nullable().optional(),
  })
  .transform((raw) => ({
    id: raw.id,
    homeId: raw.home_id,
    name: raw.name,
    icon: raw.icon ?? null,
  }));

export type Room = z.infer<typeof RoomSchema>;

export function parseRoom(json: unknown): Room {
  return RoomSchema.parse(json);
}
