import { z } from 'zod';

const UserSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    full_name: z.string().nullable().optional(),
  })
  .transform((raw) => ({
    id: raw.id,
    email: raw.email,
    fullName: raw.full_name ?? null,
  }));

export type User = z.infer<typeof UserSchema>;

export function parseUser(json: unknown): User {
  return UserSchema.parse(json);
}

/** Inverse of parseUser: back to the snake_case wire shape, for local storage. */
export function toUserJson(user: User): Record<string, unknown> {
  return {
    id: user.id,
    email: user.email,
    full_name: user.fullName,
  };
}
