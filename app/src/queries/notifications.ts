import { useQuery } from '@tanstack/react-query';
import { notificationService } from '../services/notificationService';
import { realtimeService } from '../services/realtimeService';
import { queryClient } from '../api/queryClient';
import { devicesQueryKey } from './devices';
import { NotificationItem } from '../models/notification';
import { RealtimeEvent } from '../models/realtimeEvent';
import { Device } from '../models/device';

export const notificationsQueryKey = ['notifications'] as const;

export function useNotifications() {
  return useQuery({
    queryKey: notificationsQueryKey,
    queryFn: () => notificationService.listNotifications(),
  });
}

function asMap(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function deviceNameFor(deviceId: string): string {
  const devices = queryClient.getQueryData<Device[]>(devicesQueryKey) ?? [];
  return devices.find((d) => d.id === deviceId)?.name ?? deviceId;
}

interface DerivedNotification {
  type: string;
  title: string;
  body: string;
  severity: string;
}

function commandPayload(eventPayload: Record<string, unknown>): Record<string, unknown> {
  const nested = asMap(eventPayload.payload);
  if (Object.keys(nested).length > 0) return nested;
  return asMap(eventPayload.command_payload);
}

function commandSuccessTitle(payload: Record<string, unknown>): string {
  switch (payload.type) {
    case 'relay_set':
      return `Relay ${payload.relay ?? '?'} turned ${payload.state === true ? 'on' : 'off'}`;
    case 'device_mode':
      return `Mode changed to ${String(payload.mode ?? '?').toUpperCase()}`;
    case 'calibrate_co':
      return 'CO calibration completed';
    case 'calibrate_no2':
      return 'NO2 calibration completed';
    case 'set_time':
      return 'Device time synchronized';
    case 'ai_set':
      return `AI ${payload.state === true ? 'enabled' : 'disabled'}`;
    default:
      return 'Command completed';
  }
}

function commandFailureTitle(payload: Record<string, unknown>, status: string): string {
  const suffix = status === 'timeout' ? 'timed out' : 'failed';
  switch (payload.type) {
    case 'relay_set':
      return `Relay ${payload.relay ?? '?'} command ${suffix}`;
    case 'device_mode':
      return `Mode change ${suffix}`;
    case 'calibrate_co':
      return `CO calibration ${suffix}`;
    case 'calibrate_no2':
      return `NO2 calibration ${suffix}`;
    case 'set_time':
      return `Time sync ${suffix}`;
    case 'ai_set':
      return `AI toggle ${suffix}`;
    default:
      return `Command ${suffix}`;
  }
}

function titleAndBodyForEvent(event: RealtimeEvent): DerivedNotification | null {
  if (event.type === 'device.status') {
    const online = event.payload.online === true;
    return {
      type: online ? 'device.online' : 'device.offline',
      title: online ? 'Device came online' : 'Device went offline',
      body: online ? 'Device is connected and reporting.' : 'Device is no longer reporting.',
      severity: online ? 'success' : 'warning',
    };
  }

  if (event.type === 'ota.progress') {
    const status = typeof event.payload.status === 'string' ? event.payload.status : null;
    if (status === 'rebooting') {
      return {
        type: 'ota.rebooting',
        title: 'OTA update applied',
        body: 'Device is rebooting to finish the update.',
        severity: 'success',
      };
    }
    if (status === 'failed') {
      const reason = typeof event.payload.reason === 'string' ? event.payload.reason.trim() : '';
      return {
        type: 'ota.failed',
        title: 'OTA update failed',
        body: reason || 'Device reported an OTA failure.',
        severity: 'danger',
      };
    }
    return null;
  }

  if (event.type === 'incident.created') {
    const severity = event.payload.severity === 'danger' ? 'danger' : event.payload.severity === 'warning' ? 'warning' : null;
    if (!severity) return null;
    const level = severity === 'danger' ? 2 : 1;
    const gases = [
      event.payload.co_level === level ? 'CO' : null,
      event.payload.no2_level === level ? 'NO2' : null,
    ].filter((g): g is string => g !== null);
    const gasLabel = gases.length > 0 ? gases.join(' and ') : 'Gas';

    return {
      type: `incident.${severity}`,
      title: severity === 'danger' ? 'Gas threshold exceeded' : 'Gas early warning',
      body: severity === 'danger' ? `${gasLabel} exceeded the QCVN 03:2019/BYT limit.` : `${gasLabel} entered early warning.`,
      severity: severity === 'danger' ? 'danger' : 'warning',
    };
  }

  if (event.type !== 'command.updated') return null;

  const status = typeof event.payload.status === 'string' ? event.payload.status : null;
  if (status !== 'done' && status !== 'error' && status !== 'timeout') return null;

  const payload = commandPayload(event.payload);
  if (status === 'done') {
    return {
      type: 'command.done',
      title: commandSuccessTitle(payload),
      body: 'Command completed successfully.',
      severity: 'success',
    };
  }

  const errorMessage = typeof event.payload.error_message === 'string' ? event.payload.error_message.trim() : '';
  return {
    type: `command.${status}`,
    title: commandFailureTitle(payload, status),
    body:
      status === 'error' && errorMessage
        ? errorMessage
        : status === 'timeout'
          ? 'The device did not acknowledge the command in time.'
          : 'Device reported a command error.',
    severity: status === 'timeout' ? 'warning' : 'danger',
  };
}

function notificationFromRealtimeEvent(event: RealtimeEvent): NotificationItem | null {
  const derived = titleAndBodyForEvent(event);
  if (!derived) return null;
  return {
    id: event.id,
    type: derived.type,
    deviceId: event.deviceId,
    deviceName: deviceNameFor(event.deviceId),
    title: derived.title,
    body: derived.body,
    severity: derived.severity,
    occurredAt: event.occurredAt,
    payload: event.payload,
  };
}

// Registered once at module load — prepends realtime-derived notifications
// to the cached list, mirroring NotificationsNotifier._handleRealtimeEvent.
realtimeService.onEvent((event) => {
  const current = queryClient.getQueryData<NotificationItem[]>(notificationsQueryKey);
  if (!current) return;

  const item = notificationFromRealtimeEvent(event);
  if (!item) return;
  if (current.some((existing) => existing.id === item.id)) return;

  queryClient.setQueryData<NotificationItem[]>(notificationsQueryKey, [item, ...current]);
});
