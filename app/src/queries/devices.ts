import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deviceService } from '../services/deviceService';
import { realtimeService } from '../services/realtimeService';
import { queryClient } from '../api/queryClient';
import { Device } from '../models/device';
import { RealtimeEvent } from '../models/realtimeEvent';

export const devicesQueryKey = ['devices'] as const;

export function useDevices() {
  return useQuery({ queryKey: devicesQueryKey, queryFn: () => deviceService.getDevices() });
}

export function useRegisterDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (options: { deviceId: string; name: string; homeId: string; roomId?: string }) =>
      deviceService.registerDevice(options),
    onSuccess: (device) => {
      queryClient.setQueryData<Device[]>(devicesQueryKey, (prev) => [...(prev ?? []), device]);
    },
  });
}

export function useDeleteDevice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deviceService.deleteDevice(id),
    onSuccess: (_result, id) => {
      queryClient.setQueryData<Device[]>(devicesQueryKey, (prev) =>
        (prev ?? []).filter((d) => d.id !== id),
      );
    },
  });
}

function asMap(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

// Registered once at module load (singleton import) — patches the shared
// devices cache as realtime events arrive, mirroring
// DevicesNotifier._handleRealtimeEvent. Multiple useDevices() consumers
// share this one subscription.
realtimeService.onEvent((event: RealtimeEvent) => {
  if (event.type === 'replay.reset') {
    queryClient.invalidateQueries({ queryKey: devicesQueryKey });
    return;
  }

  const current = queryClient.getQueryData<Device[]>(devicesQueryKey);
  if (!current) return;

  if (event.type === 'device.status') {
    const firmware = typeof event.payload.firmware === 'string' ? event.payload.firmware : undefined;
    queryClient.setQueryData<Device[]>(
      devicesQueryKey,
      current.map((device) =>
        device.id === event.deviceId
          ? {
              ...device,
              online: event.payload.online === true,
              lastSeen: event.occurredAt,
              firmwareVer: firmware ?? device.firmwareVer,
            }
          : device,
      ),
    );
    return;
  }

  if (event.type !== 'shadow.reported') return;
  const reported = asMap(event.payload.reported);
  queryClient.setQueryData<Device[]>(
    devicesQueryKey,
    current.map((device) =>
      device.id === event.deviceId
        ? {
            ...device,
            mode: typeof reported.mode === 'string' ? reported.mode : device.mode,
            relay1: asBool(reported.relay_1) ?? device.relay1,
            relay2: asBool(reported.relay_2) ?? device.relay2,
            relay3: asBool(reported.relay_3) ?? device.relay3,
          }
        : device,
    ),
  );
});
