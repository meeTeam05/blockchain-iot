import { z } from 'zod';
import { zDateTime, zDateTimeNullable } from './shared';

const CommandSchema = z
  .object({
    id: z.string(),
    payload: z.record(z.string(), z.unknown()),
    status: z.string(),
    created_at: zDateTime,
    executed_at: zDateTimeNullable,
  })
  .transform((raw) => ({
    id: raw.id,
    payload: raw.payload,
    status: raw.status,
    createdAt: raw.created_at,
    executedAt: raw.executed_at,
  }));

export type Command = z.infer<typeof CommandSchema>;

export function parseCommand(json: unknown): Command {
  return CommandSchema.parse(json);
}
