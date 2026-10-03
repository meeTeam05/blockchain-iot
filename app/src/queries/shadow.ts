import { useQuery, useQueryClient } from '@tanstack/react-query';
import { deviceService } from '../services/deviceService';
import { realtimeService } from '../services/realtimeService';
import { queryClient } from '../api/queryClient';
import { DeviceShadow } from '../models/device';
import { RealtimeEvent } from '../models/realtimeEvent';

export const shadowQueryKey = (deviceId: string) => ['shadow', deviceId] as const;

export function useShadow(deviceId: string) {
  return useQuery({
    queryKey: shadowQueryKey(deviceId),
    queryFn: () => deviceService.getShadow(deviceId),
    enabled: deviceId.length > 0,
  });
}

export function useRefreshShadow(deviceId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.refetchQueries({ queryKey: shadowQueryKey(deviceId) });
}

function asMap(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Registered once at module load — patches whichever device's shadow cache
// is currently active, mirroring ShadowNotifier._handleRealtimeEvent.
realtimeService.onEvent((event: RealtimeEvent) => {
  if (event.type !== 'shadow.reported') return;
  const key = shadowQueryKey(event.deviceId);
  const current = queryClient.getQueryData<DeviceShadow>(key);
  if (!current) return;

  const reported = asMap(event.payload.reported);
  const patch = asMap(event.payload.patch);
  queryClient.setQueryData<DeviceShadow>(key, {
    ...current,
    reported: { ...current.reported, ...patch, ...reported },
    updatedAt: event.occurredAt,
  });
});
