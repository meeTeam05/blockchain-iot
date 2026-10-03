import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { deviceService } from '../services/deviceService';
import { realtimeService } from '../services/realtimeService';
import { queryClient } from '../api/queryClient';
import { Command } from '../models/command';
import { RealtimeEvent } from '../models/realtimeEvent';

export const commandsQueryKey = (deviceId: string) => ['commands', deviceId] as const;

export function useCommands(deviceId: string) {
  return useQuery({
    queryKey: commandsQueryKey(deviceId),
    queryFn: () => deviceService.getCommands(deviceId),
    enabled: deviceId.length > 0,
  });
}

export function useSendCommand(deviceId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) => deviceService.sendCommand(deviceId, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: commandsQueryKey(deviceId) });
    },
  });
}

function asMap(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// Registered once at module load — patches whichever device's commands
// cache is currently active, mirroring CommandsNotifier._handleRealtimeEvent.
realtimeService.onEvent((event: RealtimeEvent) => {
  if (event.type !== 'command.updated') return;
  const key = commandsQueryKey(event.deviceId);
  const current = queryClient.getQueryData<Command[]>(key);
  if (!current) return;

  const commandId = typeof event.payload.command_id === 'string' ? event.payload.command_id : null;
  const status = typeof event.payload.status === 'string' ? event.payload.status : null;
  if (!commandId || !status) return;

  const index = current.findIndex((c) => c.id === commandId);
  const existing = index >= 0 ? current[index] : undefined;
  const payload = asMap(event.payload.payload);
  const isTerminal = status === 'done' || status === 'error' || status === 'timeout';
  const nextCommand: Command = {
    id: commandId,
    payload: Object.keys(payload).length > 0 ? payload : (existing?.payload ?? {}),
    status,
    createdAt: existing?.createdAt ?? event.occurredAt,
    executedAt: isTerminal ? event.occurredAt : (existing?.executedAt ?? null),
  };

  const next = [...current];
  if (index >= 0) next[index] = nextCommand;
  else next.unshift(nextCommand);
  next.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  queryClient.setQueryData(key, next);
});
