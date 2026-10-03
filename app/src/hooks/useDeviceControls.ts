import { useCallback, useEffect, useRef, useState } from 'react';
import { deviceService } from '../services/deviceService';
import { Command } from '../models/command';
import { DeviceShadow } from '../models/device';
import { COMMAND_PENDING_UI_TIMEOUT_MS, ExpectedReportedState, reconcileCommand } from '../services/commandReconciliation';

export type DeviceControlState =
  | 'idle'
  | 'submitting'
  | 'pending'
  | 'sent'
  | 'waiting-for-device'
  | 'success'
  | 'failure'
  | 'queued';

interface PendingAction {
  commandId: string;
  expected: ExpectedReportedState;
  submittedAt: Date;
}

export interface DeviceControl {
  commandId: string | null;
  errorMessage: string | null;
  isPending: boolean;
  state: DeviceControlState;
}

export interface RelayDeviceControl extends DeviceControl {
  submit: (state: boolean) => Promise<void>;
}

export interface ModeDeviceControl extends DeviceControl {
  submit: (mode: 'on' | 'off') => Promise<void>;
}

export interface AiDeviceControl extends DeviceControl {
  submit: (state: boolean) => Promise<void>;
}

interface ReconciliationOptions {
  commands: Command[];
  shadow: DeviceShadow | null;
  refetchShadow: () => Promise<unknown>;
}

/**
 * Holds local control presentation state only. The reported-shadow query
 * remains the sole source of displayed relay and mode values — this never
 * optimistically flips them. Ports mobileApp's usePendingCommandReconciliation,
 * restructured so the phase/error values are derived during render (from
 * `action`/`commands`/`shadow`) instead of mirrored into state from an
 * effect — direct setState-from-effect is flagged by this project's
 * react-hooks/set-state-in-effect rule and isn't needed here since nothing
 * about the derivation is a genuine side effect. The two real side effects
 * (forcing a re-check at the 5s UI timeout, and the one-time delayed shadow
 * refetch) still run in effects, but only set state from inside their timer
 * callbacks, not synchronously in the effect body.
 */
function usePendingCommandReconciliation({ commands, shadow, refetchShadow }: ReconciliationOptions) {
  const [action, setAction] = useState<PendingAction | null>(null);
  const [uiTimedOut, setUiTimedOut] = useState(false);
  const [submitPhase, setSubmitPhase] = useState<'idle' | 'submitting' | 'failure'>('idle');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const refreshedCommandIds = useRef(new Set<string>());

  const begin = useCallback(() => {
    setSubmitError(null);
    setSubmitPhase('submitting');
  }, []);

  const track = useCallback((commandId: string, expected: ExpectedReportedState) => {
    refreshedCommandIds.current.delete(commandId);
    setUiTimedOut(false);
    setSubmitPhase('idle');
    setAction({ commandId, expected, submittedAt: new Date() });
  }, []);

  const failSubmission = useCallback((error: unknown, fallback: string) => {
    setSubmitPhase('failure');
    setSubmitError(error instanceof Error && error.message.length > 0 ? `${fallback} ${error.message}` : fallback);
  }, []);

  const command = action === null ? null : (commands.find((item) => item.id === action.commandId) ?? null);
  // A command that already reached 'done' keeps waiting for the reported
  // shadow instead of being forced to 'queued' by the UI timeout.
  const resolution =
    action === null
      ? null
      : uiTimedOut && command?.status !== 'done'
        ? ({ state: 'queued', commandId: action.commandId } as const)
        : reconcileCommand({ command, expected: action.expected, reportedShadow: shadow, submittedAt: action.submittedAt });

  // Forces a state re-check exactly at the 5-second mark — wall-clock time
  // passing alone doesn't trigger a render otherwise.
  useEffect(() => {
    if (action === null) return undefined;
    const delay = Math.max(0, COMMAND_PENDING_UI_TIMEOUT_MS - (Date.now() - action.submittedAt.getTime()));
    const timer = setTimeout(() => setUiTimedOut(true), delay);
    return () => clearTimeout(timer);
  }, [action]);

  // One-time, one-second-delayed shadow refetch fallback in case the SSE
  // shadow.reported frame is slow to arrive for a completed command.
  useEffect(() => {
    if (action === null || resolution?.state !== 'awaiting-reported-state') return undefined;
    if (refreshedCommandIds.current.has(action.commandId)) return undefined;
    refreshedCommandIds.current.add(action.commandId);
    const timer = setTimeout(() => {
      refetchShadow().catch(() => undefined);
    }, 1_000);
    return () => clearTimeout(timer);
  }, [action, resolution?.state, refetchShadow]);

  const state: DeviceControlState =
    resolution === null
      ? submitPhase === 'submitting'
        ? 'submitting'
        : 'idle'
      : resolution.state === 'awaiting-reported-state'
        ? 'waiting-for-device'
        : resolution.state === 'confirmed'
          ? 'success'
          : resolution.state === 'failed'
            ? 'failure'
            : resolution.state;

  const errorMessage =
    resolution?.state === 'failed'
      ? (resolution.errorMessage ?? 'The device rejected this command.')
      : resolution?.state === 'queued'
        ? 'Command queued. It will run when the device reconnects.'
        : submitPhase === 'failure'
          ? submitError
          : null;

  return {
    begin,
    commandId: action?.commandId ?? null,
    errorMessage,
    failSubmission,
    isPending: state === 'submitting' || state === 'pending' || state === 'sent' || state === 'waiting-for-device',
    state,
    track,
  };
}

function useRelayDeviceControl(deviceId: string, channel: 1 | 2 | 3, options: ReconciliationOptions): RelayDeviceControl {
  const reconciliation = usePendingCommandReconciliation(options);
  const submit = useCallback(
    async (state: boolean) => {
      if (reconciliation.isPending) return;
      reconciliation.begin();
      try {
        const commandId = await deviceService.setRelay(deviceId, channel, state);
        reconciliation.track(commandId, { kind: 'relay', channel, state });
      } catch (error) {
        reconciliation.failSubmission(error, 'Failed to toggle relay.');
      }
    },
    [channel, deviceId, reconciliation],
  );
  return {
    commandId: reconciliation.commandId,
    errorMessage: reconciliation.errorMessage,
    isPending: reconciliation.isPending,
    state: reconciliation.state,
    submit,
  };
}

function useModeDeviceControl(deviceId: string, options: ReconciliationOptions): ModeDeviceControl {
  const reconciliation = usePendingCommandReconciliation(options);
  const submit = useCallback(
    async (mode: 'on' | 'off') => {
      if (reconciliation.isPending) return;
      reconciliation.begin();
      try {
        const commandId = await deviceService.setMode(deviceId, mode);
        reconciliation.track(commandId, { kind: 'mode', mode });
      } catch (error) {
        reconciliation.failSubmission(error, 'Failed to change mode.');
      }
    },
    [deviceId, reconciliation],
  );
  return {
    commandId: reconciliation.commandId,
    errorMessage: reconciliation.errorMessage,
    isPending: reconciliation.isPending,
    state: reconciliation.state,
    submit,
  };
}

function useAiDeviceControl(deviceId: string, options: ReconciliationOptions): AiDeviceControl {
  const reconciliation = usePendingCommandReconciliation(options);
  const submit = useCallback(
    async (state: boolean) => {
      if (reconciliation.isPending) return;
      reconciliation.begin();
      try {
        const commandId = await deviceService.setAi(deviceId, state);
        reconciliation.track(commandId, { kind: 'ai', state });
      } catch (error) {
        reconciliation.failSubmission(error, 'Failed to toggle AI.');
      }
    },
    [deviceId, reconciliation],
  );
  return {
    commandId: reconciliation.commandId,
    errorMessage: reconciliation.errorMessage,
    isPending: reconciliation.isPending,
    state: reconciliation.state,
    submit,
  };
}

export function useDeviceControls({ commands, deviceId, refetchShadow, shadow }: ReconciliationOptions & { deviceId: string }) {
  // Deliberately independent: a pending mode command disables only itself, not the relays.
  const fan = useRelayDeviceControl(deviceId, 1, { commands, shadow, refetchShadow });
  const lamp = useRelayDeviceControl(deviceId, 2, { commands, shadow, refetchShadow });
  const filter = useRelayDeviceControl(deviceId, 3, { commands, shadow, refetchShadow });
  const mode = useModeDeviceControl(deviceId, { commands, shadow, refetchShadow });
  const ai = useAiDeviceControl(deviceId, { commands, shadow, refetchShadow });
  return { ai, fan, filter, lamp, mode };
}
