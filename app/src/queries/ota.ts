import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deviceService } from '../services/deviceService';
import { realtimeService } from '../services/realtimeService';
import { otaReconciliationService } from '../services/otaReconciliation';
import { queryClient } from '../api/queryClient';
import { OtaRealtimeProgress } from '../models/ota';
import { RealtimeEvent } from '../models/realtimeEvent';
import { otaCatalogQueryKey, otaProgressQueryKey } from './otaKeys';

export { otaCatalogQueryKey, otaProgressQueryKey };

export function useOtaCatalog(deviceId: string) {
  return useQuery({
    queryKey: otaCatalogQueryKey(deviceId),
    queryFn: () => deviceService.getOtaCatalog(deviceId),
    enabled: deviceId.length > 0,
  });
}

/** Read-only subscription to progress state written by the realtime router below. */
export function useOtaRealtimeProgress(deviceId: string) {
  return useQuery<OtaRealtimeProgress | null>({
    queryKey: otaProgressQueryKey(deviceId),
    queryFn: async () => null,
    enabled: false,
    initialData: null,
  });
}

export function useOtaRequestMutation(deviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (version: string) => deviceService.startOtaUpdate(deviceId, version),
    onMutate: (version: string) => {
      qc.setQueryData<OtaRealtimeProgress>(otaProgressQueryKey(deviceId), {
        eventId: null,
        state: 'requesting',
        progress: null,
        occurredAt: new Date(),
        errorMessage: null,
        requestedVersion: version,
      });
    },
    onSuccess: (_result, version) => {
      qc.setQueryData<OtaRealtimeProgress>(otaProgressQueryKey(deviceId), {
        eventId: null,
        state: 'accepted',
        progress: null,
        occurredAt: new Date(),
        errorMessage: null,
        requestedVersion: version,
      });
      qc.invalidateQueries({ queryKey: otaCatalogQueryKey(deviceId) }).catch(() => undefined);
    },
    onError: (err, version) => {
      qc.setQueryData<OtaRealtimeProgress>(otaProgressQueryKey(deviceId), {
        eventId: null,
        state: 'failed',
        progress: null,
        occurredAt: new Date(),
        errorMessage: err instanceof Error ? err.message : 'Unable to request firmware update.',
        requestedVersion: version,
      });
    },
  });
}

function progressValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

/** Maps only the OTA states published by the existing firmware contract. */
function otaProgressFromEvent(event: RealtimeEvent): OtaRealtimeProgress | null {
  const status = event.payload.status;
  const progress = progressValue(event.payload.progress);

  if (status === 'rebooting') {
    return { eventId: event.id, state: 'waiting_reboot', progress, occurredAt: event.occurredAt, errorMessage: null, requestedVersion: null };
  }
  if (status === 'failed' || status === 'sha256_mismatch') {
    return { eventId: event.id, state: 'failed', progress, occurredAt: event.occurredAt, errorMessage: null, requestedVersion: null };
  }
  if (status === 'starting' || status === undefined || status === null) {
    return { eventId: event.id, state: 'downloading', progress, occurredAt: event.occurredAt, errorMessage: null, requestedVersion: null };
  }
  return null;
}

function isTerminalOtaProgress(progress: OtaRealtimeProgress): boolean {
  return progress.state === 'waiting_reboot' || progress.state === 'failed';
}

function refreshTerminalOtaCaches(deviceId: string): void {
  queryClient.invalidateQueries({ queryKey: otaCatalogQueryKey(deviceId) }).catch(() => undefined);
  queryClient.invalidateQueries({ queryKey: ['devices'] }).catch(() => undefined);
}

// Registered once at module load — patches whichever device's OTA progress
// cache is active, then drives post-reboot reconciliation. Mirrors
// mobileApp's RealtimeEventRouter.applyOtaProgress.
realtimeService.onEvent((event: RealtimeEvent) => {
  if (event.type !== 'ota.progress') return;

  const progress = otaProgressFromEvent(event);
  if (progress === null) return;

  const key = otaProgressQueryKey(event.deviceId);
  const current = queryClient.getQueryData<OtaRealtimeProgress | null>(key);
  if (current?.eventId === progress.eventId || (current !== null && current !== undefined && event.occurredAt < current.occurredAt)) {
    return;
  }

  queryClient.setQueryData<OtaRealtimeProgress>(key, { ...progress, requestedVersion: current?.requestedVersion ?? null });
  if (isTerminalOtaProgress(progress)) refreshTerminalOtaCaches(event.deviceId);

  const latest = queryClient.getQueryData<OtaRealtimeProgress>(key);
  if (latest?.state === 'failed') {
    otaReconciliationService.cancel(event.deviceId);
    return;
  }
  if (progress.state !== 'waiting_reboot') return;
  otaReconciliationService.start(event.deviceId, latest?.requestedVersion ?? null);
});
