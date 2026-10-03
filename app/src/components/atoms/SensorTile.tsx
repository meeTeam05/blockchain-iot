import { StyleSheet, Text, View } from 'react-native';
import { LucideIcon } from 'lucide-react-native';
import { useColors } from '../../theme/useColors';
import { AtmosphereTextStyles } from '../../theme/textStyles';
import { AtmosphereTokens } from '../../theme/tokens';
import { AtmospherePalette } from '../../theme/palette';
import { Sparkline } from './Sparkline';

export type SensorTone = 'cool' | 'warm' | 'air' | 'no2';

interface SensorTileProps {
  value: string | null;
  unit: string;
  label: string;
  icon: LucideIcon;
  tone: SensorTone;
  sparkColor: string;
  sparklineData?: number[] | null;
  dimmed?: boolean;
}

function backgroundFor(tone: SensorTone, c: AtmospherePalette): string {
  switch (tone) {
    case 'cool':
      return c.tileCoolA;
    case 'warm':
      return c.tileWarmA;
    case 'air':
      return c.tileAirA;
    case 'no2':
      return c.tileNo2A;
  }
}

// Simplified from the Dart original: no TweenAnimationBuilder glow-in
// effect on mount/value-change — a static tile, since RN has no equivalent
// primitive as cheap as Flutter's and the glow is a cosmetic nicety.
export function SensorTile({
  value,
  unit,
  label,
  icon: Icon,
  tone,
  sparkColor,
  sparklineData,
  dimmed = false,
}: SensorTileProps) {
  const c = useColors();
  const bg = backgroundFor(tone, c);
  const displayValue = dimmed ? '--' : (value ?? '--');

  return (
    <View style={[styles.tile, { backgroundColor: bg, borderColor: c.line }]}>
      <View style={styles.headerRow}>
        <Icon size={16} color={c.ink2} />
        <View style={{ width: AtmosphereTokens.space4 }} />
        <Text style={[AtmosphereTextStyles.label(c.ink2), { flex: 1 }]}>{label.toUpperCase()}</Text>
      </View>
      <View style={{ flex: 1 }} />
      <View style={styles.valueRow}>
        <Text style={AtmosphereTextStyles.sensorValue(dimmed ? c.ink3 : c.ink)}>{displayValue}</Text>
        <View style={{ width: AtmosphereTokens.space4 }} />
        <Text style={AtmosphereTextStyles.body(c.ink2)}>{unit}</Text>
      </View>
      <View style={{ height: AtmosphereTokens.space8 }} />
      {!dimmed && sparklineData && sparklineData.length > 0 ? (
        <Sparkline points={sparklineData} color={sparkColor} height={32} />
      ) : (
        <View style={{ height: 32 }} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    padding: AtmosphereTokens.space16,
    borderRadius: AtmosphereTokens.radiusTile,
    borderWidth: 1,
    minHeight: 168,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
  },
});
