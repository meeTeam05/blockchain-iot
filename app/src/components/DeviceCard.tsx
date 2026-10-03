import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '../theme/useColors';
import { AppIcons } from '../theme/icons';
import { AtmosphereTextStyles } from '../theme/textStyles';
import { AtmosphereTokens } from '../theme/tokens';
import { AtmospherePalette } from '../theme/palette';
import { GhostButton } from './atoms/GhostButton';
import { Pill } from './atoms/Pill';
import { Device } from '../models/device';

interface DeviceCardProps {
  device: Device;
  roomName?: string | null;
  onPress: () => void;
}

/** Deterministic 0..3 tone index from a device id — same purpose as the
 * Dart original's `id.hashCode.abs() % 4`, just a different (simpler) hash
 * since only visual variety, not a specific value, matters here. */
function tintIndex(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 4;
}

function tintColorsFor(id: string, c: AtmospherePalette): { bg: string; accent: string } {
  switch (tintIndex(id)) {
    case 0:
      return { bg: c.brandTint, accent: c.brand };
    case 1:
      return { bg: c.accentTint, accent: c.accent };
    case 2:
      return { bg: c.mint, accent: c.brand };
    default:
      return { bg: '#F0E8FB', accent: '#7A4FD0' };
  }
}

export function DeviceCard({ device, roomName, onPress }: DeviceCardProps) {
  const c = useColors();
  const tint = tintColorsFor(device.id, c);

  return (
    <View style={[styles.card, { backgroundColor: tint.bg, borderColor: c.line }]}>
      <View style={styles.headerRow}>
        <View style={[styles.iconBox, { backgroundColor: tint.accent }]}>
          <AppIcons.device size={20} color={c.ink} />
        </View>
        <View style={{ width: AtmosphereTokens.space12 }} />
        <Text style={[AtmosphereTextStyles.h2(c.ink), styles.name]} numberOfLines={1}>
          {device.name}
        </Text>
        <View style={{ width: AtmosphereTokens.space8 }} />
        {device.mode ? (
          <>
            <Pill label={device.mode.toUpperCase()} tone={device.mode === 'on' ? 'online' : 'offline'} />
            <View style={{ width: AtmosphereTokens.space8 }} />
          </>
        ) : null}
        <Pill label={device.online ? 'Online' : 'Offline'} tone={device.online ? 'online' : 'offline'} />
      </View>
      <View style={{ height: AtmosphereTokens.space16 }} />
      <View style={styles.row}>
        <AppIcons.pin size={14} color={c.ink3} />
        <View style={{ width: AtmosphereTokens.space6 }} />
        <Text style={AtmosphereTextStyles.caption(c.ink2)}>
          {roomName ?? (device.roomId === null ? 'No room assigned' : 'Room unavailable')}
        </Text>
      </View>
      <View style={{ height: AtmosphereTokens.space20 }} />
      <GhostButton label="View Detail" onPress={onPress} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: AtmosphereTokens.radiusCard,
    borderWidth: 1,
    padding: AtmosphereTokens.space20,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconBox: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    flex: 1,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
