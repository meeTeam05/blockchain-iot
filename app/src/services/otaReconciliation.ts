import { QueryClient } from '@tanstack/react-query';
import { queryClient } from '../api/queryClient';
import { deviceService } from './deviceService';
import { devicesQueryKey } from '../queries/devices';
import { otaCatalogQueryKey, otaProgressQueryKey } from '../queries/otaKeys';
import { Device } from '../models/device';
import { OtaRealtimeProgress } from '../models/ota';

export const OTA_RECONCILIATION_INTERVAL_MS = 5_000;
export const OTA_RECONCILIATION_MAX_DURATION_MS = 120_000;

interface ReconciliationRun {
  deviceId: string;
  requestedVersion: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

function normalizeDeviceId(deviceId: string): string {
  return deviceId.trim().toLowerCase();
}

async function fetchDevice(id: string): Promise<Device | null> {
  const devices = await queryClient.fetchQuery({ queryKey: devicesQueryKey, queryFn: () => deviceService.getDevices() });
  return devices.find((d) => d.id === id) ?? null;
}

/**
 * Reconciles the firmware result from the existing GET /devices data source.
 * A reboot is successful only when that source reports the requested
 * version. Mirrors mobileApp's OTAReconciliationService — Flutter has no
 * post-reboot reconciliation, but this app_new port and mobileApp both add
 * it as an approved lifecycle behavior derived exclusively from existing data.
 */
export class OTAReconciliationService {
  private readonly runs = new Map<string, ReconciliationRun>();

  constructor(
    private readonly qc: QueryClient,
    private readonly fetchDeviceImpl: (deviceId: string) => Promise<Device | null> = fetchDevice,
    private readonly now: () => number = Date.now,
  ) {}

  /** Starts one run per device. Duplicate/replayed reboot events are no-ops. */
  start(deviceId: string, requestedVersion: string | null): boolean {
    const normalizedId = normalizeDeviceId(deviceId);
    if (requestedVersion === null || requestedVersion.trim().length === 0 || this.runs.has(normalizedId)) return false;

    const run: ReconciliationRun = { deviceId: normalizedId, requestedVersion, startedAt: this.now(), timer: null };
    this.runs.set(normalizedId, run);
    this.updateProgress(run, 'waiting_reboot');
    this.invalidateDeviceCaches(normalizedId);
    this.scheduleNext(run);
    return true;
  }

  cancel(deviceId: string): boolean {
    const normalizedId = normalizeDeviceId(deviceId);
    const run = this.runs.get(normalizedId);
    if (run === undefined) return false;
    if (run.timer !== null) clearTimeout(run.timer);
    this.runs.delete(normalizedId);
    return true;
  }

  private scheduleNext(run: ReconciliationRun): void {
    run.timer = setTimeout(() => {
      this.check(run).catch(() => undefined);
    }, OTA_RECONCILIATION_INTERVAL_MS);
  }

  private async check(run: ReconciliationRun): Promise<void> {
    if (!this.isActive(run)) return;
    if (this.elapsed(run) >= OTA_RECONCILIATION_MAX_DURATION_MS) {
      this.finish(run, 'timeout');
      return;
    }

    this.updateProgress(run, 'checking_device');
    this.invalidateDeviceCaches(run.deviceId);
    try {
      const device = await this.fetchDeviceImpl(run.deviceId);
      if (!this.isActive(run)) return;
      if (device?.online === true) {
        this.finish(run, device.firmwareVer === run.requestedVersion ? 'completed' : 'failed');
        return;
      }
    } catch {
      // The device may still be restarting or the network request may be transient; retry until the deadline.
    }

    if (!this.isActive(run)) return;
    if (this.elapsed(run) >= OTA_RECONCILIATION_MAX_DURATION_MS) {
      this.finish(run, 'timeout');
      return;
    }
    this.updateProgress(run, 'waiting_reboot');
    this.scheduleNext(run);
  }

  private finish(run: ReconciliationRun, state: Extract<OtaRealtimeProgress['state'], 'completed' | 'failed' | 'timeout'>): void {
    if (!this.isActive(run)) return;
    if (run.timer !== null) clearTimeout(run.timer);
    this.runs.delete(run.deviceId);
    this.updateProgress(run, state);
    this.invalidateDeviceCaches(run.deviceId);
  }

  private updateProgress(run: ReconciliationRun, state: OtaRealtimeProgress['state']): void {
    this.qc.setQueryData<OtaRealtimeProgress>(otaProgressQueryKey(run.deviceId), (current) => ({
      eventId: current?.eventId ?? null,
      state,
      progress: current?.progress ?? null,
      occurredAt: new Date(this.now()),
      errorMessage: current?.errorMessage ?? null,
      requestedVersion: current?.requestedVersion ?? run.requestedVersion,
    }));
  }

  private invalidateDeviceCaches(deviceId: string): void {
    this.qc.invalidateQueries({ queryKey: otaCatalogQueryKey(deviceId) }).catch(() => undefined);
    this.qc.invalidateQueries({ queryKey: devicesQueryKey }).catch(() => undefined);
  }

  private elapsed(run: ReconciliationRun): number {
    return this.now() - run.startedAt;
  }

  private isActive(run: ReconciliationRun): boolean {
    return this.runs.get(run.deviceId) === run;
  }
}

export const otaReconciliationService = new OTAReconciliationService(queryClient);
