import { Command } from '../models/command';
import { DeviceShadow } from '../models/device';

export const COMMAND_PENDING_UI_TIMEOUT_MS = 5_000;

export type ExpectedReportedState =
  | { kind: 'mode'; mode: 'on' | 'off' }
  | { kind: 'relay'; channel: 1 | 2 | 3; state: boolean }
  | { kind: 'ai'; state: boolean };

export type CommandResolution =
  | { state: 'pending' | 'sent'; commandId: string }
  | { state: 'awaiting-reported-state'; commandId: string }
  | { state: 'confirmed'; commandId: string }
  | { state: 'failed'; commandId: string; errorMessage: string | null }
  | { state: 'queued'; commandId: string };

/**
 * Mirrors mobileApp's commandReconciliation (itself matching Flutter's
 * command/shadow contract): sends a command without optimistically changing
 * displayed relay/mode state, then waits for the matching *reported* shadow.
 * Returns presentation state only — never mutates a query cache.
 */
export function reconcileCommand({
  command,
  expected,
  reportedShadow,
  submittedAt,
  now = new Date(),
}: {
  command: Pick<Command, 'id' | 'status'> | null;
  expected: ExpectedReportedState;
  reportedShadow: DeviceShadow | null;
  submittedAt: Date;
  now?: Date;
}): CommandResolution {
  const commandId = command?.id ?? '';
  if (command === null) {
    return isPendingUiTimedOut(submittedAt, now) ? { state: 'queued', commandId } : { state: 'pending', commandId };
  }

  if (command.status === 'pending' || command.status === 'sent') {
    if (isPendingUiTimedOut(submittedAt, now)) return { state: 'queued', commandId: command.id };
    return { state: command.status, commandId: command.id };
  }
  if (command.status === 'timeout') return { state: 'queued', commandId: command.id };
  // The backend's command-list contract has no execution-error detail field,
  // so this is always null; kept typed for forward compatibility.
  if (command.status === 'error') return { state: 'failed', commandId: command.id, errorMessage: null };

  return matchesReportedShadow(reportedShadow, expected)
    ? { state: 'confirmed', commandId: command.id }
    : { state: 'awaiting-reported-state', commandId: command.id };
}

export function isPendingUiTimedOut(submittedAt: Date, now = new Date()): boolean {
  return now.getTime() - submittedAt.getTime() >= COMMAND_PENDING_UI_TIMEOUT_MS;
}

export function matchesReportedShadow(shadow: DeviceShadow | null, expected: ExpectedReportedState): boolean {
  if (shadow === null) return false;
  if (expected.kind === 'mode') {
    return typeof shadow.reported.mode === 'string' && (shadow.reported.mode as string).toLowerCase() === expected.mode;
  }
  if (expected.kind === 'ai') {
    return shadow.reported.ai_enabled === expected.state;
  }
  return shadow.reported[`relay_${expected.channel}`] === expected.state;
}
