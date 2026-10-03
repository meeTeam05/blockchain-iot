import { z } from 'zod';
import { zDateTime } from './shared';

const TelemetryPointSchema = z
  .object({
    ts: zDateTime,
    temperature: z.number().nullable().optional(),
    humidity: z.number().nullable().optional(),
    co_ppm: z.number().nullable().optional(),
    no2_ppm: z.number().nullable().optional(),
    mode: z.string().nullable().optional(),
  })
  .transform((raw) => ({
    ts: raw.ts,
    temperature: raw.temperature ?? null,
    humidity: raw.humidity ?? null,
    coPpm: raw.co_ppm ?? null,
    no2Ppm: raw.no2_ppm ?? null,
    mode: raw.mode ?? null,
  }));

export type TelemetryPoint = z.infer<typeof TelemetryPointSchema>;

export function parseTelemetryPoint(json: unknown): TelemetryPoint {
  return TelemetryPointSchema.parse(json);
}

/**
 * Lenient on `ts` only: returns null if `ts` is missing/unparseable instead
 * of throwing. Every other field is still validated strictly (throws), to
 * match the original Dart `TelemetryPoint.tryFromJson`.
 */
export function tryParseTelemetryPoint(json: unknown): TelemetryPoint | null {
  if (typeof json !== 'object' || json === null) return null;
  const tsRaw = (json as Record<string, unknown>).ts;
  if (typeof tsRaw !== 'string') return null;
  const ts = new Date(tsRaw);
  if (Number.isNaN(ts.getTime())) return null;
  return TelemetryPointSchema.parse({ ...json, ts: ts.toISOString() });
}
