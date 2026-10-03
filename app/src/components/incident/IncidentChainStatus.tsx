import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '../../theme/useColors';
import { AtmosphereTextStyles } from '../../theme/textStyles';
import { AtmosphereTokens } from '../../theme/tokens';
import { AtmospherePalette } from '../../theme/palette';
import { useIncidentChainInfo } from '../../queries/incidents';
import { useNow } from '../../hooks/useNow';
import { ackCountdown, ackCountdownText, chainStatusLabel, ChainTone } from '../../models/incident';

function toneColor(tone: ChainTone, c: AtmospherePalette): string {
  switch (tone) {
    case 'success':
      return c.mint;
    case 'warning':
      return c.warn;
    case 'danger':
      return c.danger;
    case 'progress':
      return c.brand;
    default:
      return c.ink2;
  }
}

// Task 5: chain_status label; Task 8 (mobile part): "Đang chờ acknowledge · Còn X phút"
// from the chain-derived deadline. Read-only; acting happens in the dApp.
export function IncidentChainStatus({ deviceId, incidentId }: { deviceId: string; incidentId: string }) {
  const c = useColors();
  const query = useIncidentChainInfo(deviceId, incidentId);
  const info = query.data;
  // Only an open, on-chain incident with a chain-derived deadline has a countdown.
  const untilMs = info?.ackDeadlineAt && info.chainStatus === 'confirmed' && info.ownerStatus === 'open'
    ? info.ackDeadlineAt.getTime() : null;
  const now = useNow(untilMs);

  if (query.isPending) {
    return <Text testID="incident-chain-loading" style={AtmosphereTextStyles.caption(c.ink3)}>Đang tải trạng thái chain…</Text>;
  }
  if (query.isError || !info) {
    return (
      <Text testID="incident-chain-error" style={AtmosphereTextStyles.caption(c.danger)}>
        Không tải được trạng thái chain{query.error instanceof Error ? `: ${query.error.message}` : ''}
      </Text>
    );
  }
  const status = chainStatusLabel(info);
  const countdown = now === null ? ({ kind: 'none' } as const) : ackCountdown(info, now);
  const countdownText = ackCountdownText(countdown);
  const countdownColor = countdown.kind === 'expired' || (countdown.kind === 'waiting' && countdown.urgent) ? c.danger : c.warn;
  return (
    <View style={styles.block}>
      <Text testID="incident-chain-status" style={AtmosphereTextStyles.caption(toneColor(status.tone, c))}>
        {status.label}
      </Text>
      {countdownText ? (
        <Text testID="incident-ack-countdown" style={AtmosphereTextStyles.caption(countdownColor)}>
          {countdownText}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: AtmosphereTokens.space6 },
});
