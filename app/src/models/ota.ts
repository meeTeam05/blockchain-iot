import { z } from 'zod';

const OtaVersionInfoSchema = z.object({
  version: z.string(),
  filename: z.string(),
  url: z.string(),
});

export type OtaVersionInfo = z.infer<typeof OtaVersionInfoSchema>;

const DeviceOtaCatalogSchema = z
  .object({
    device_id: z.string(),
    current_version: z.string().nullable(),
    device_online: z.boolean(),
    versions: z.array(OtaVersionInfoSchema),
  })
  .transform((raw) => ({
    deviceId: raw.device_id,
    currentVersion: raw.current_version,
    deviceOnline: raw.device_online,
    versions: raw.versions,
  }));

export type DeviceOtaCatalog = z.infer<typeof DeviceOtaCatalogSchema>;

/**
 * Throws a ZodError on any shape mismatch. The original Dart
 * `getOtaCatalog` wraps the same failure as `ApiException(0, 'Unexpected
 * server response')` — replicate that wrapping in the Phase 6 OTA service
 * (device_service.ts), not here.
 */
export function parseDeviceOtaCatalog(json: unknown): DeviceOtaCatalog {
  return DeviceOtaCatalogSchema.parse(json);
}

/**
 * Normalized firmware OTA progress. The firmware publishes `starting`, numeric
 * progress frames (with no status), `rebooting`, `failed`, and
 * `sha256_mismatch`; the latter two are represented as a single failure UI
 * state. Completion is inferred only by reconciliation against real device
 * data (see services/otaReconciliation.ts); no `ota.completed` wire event
 * exists.
 */
export type OtaProgressState =
  | 'idle'
  | 'requesting'
  | 'accepted'
  | 'downloading'
  | 'waiting_reboot'
  | 'checking_device'
  | 'completed'
  | 'failed'
  | 'timeout';

export interface OtaRealtimeProgress {
  eventId: string | null;
  state: OtaProgressState;
  progress: number | null;
  occurredAt: Date;
  /** Request or firmware failure detail; never sourced from an invented event. */
  errorMessage: string | null;
  /** Version accepted by the OTA request endpoint for this lifecycle. */
  requestedVersion: string | null;
}
