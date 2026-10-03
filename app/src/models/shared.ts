import { z } from 'zod';

// { offset: true, local: true } mirrors Dart's DateTime.parse, which accepts
// a numeric UTC offset ("+07:00") or no zone at all, not just a "Z" suffix.
const isoDateTime = () => z.iso.datetime({ offset: true, local: true });

/** Required ISO-8601 datetime string, parsed into a Date. Throws if missing or malformed. */
export const zDateTime = isoDateTime().transform((value) => new Date(value));

/** Optional/nullable ISO-8601 datetime string, parsed into a Date or null. */
export const zDateTimeNullable = isoDateTime()
  .nullable()
  .optional()
  .transform((value) => (value ? new Date(value) : null));
