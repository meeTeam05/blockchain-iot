import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '../../theme/useColors';
import { AtmosphereTextStyles } from '../../theme/textStyles';
import { AtmosphereTokens } from '../../theme/tokens';
import { AtmospherePalette } from '../../theme/palette';
import { withAlpha } from '../../theme/color';

export type PillTone = 'online' | 'offline' | 'warn' | 'brand' | 'accent' | 'danger';

interface PillProps {
  label: string;
  tone: PillTone;
}

function colorsForTone(tone: PillTone, c: AtmospherePalette): { bg: string; text: string } {
  switch (tone) {
    case 'online':
      return { bg: withAlpha('#1A8767', 0.15), text: '#1A8767' };
    case 'offline':
      return { bg: withAlpha(c.ink3, 0.15), text: c.ink3 };
    case 'warn':
      return { bg: c.warnTint, text: c.warn };
    case 'brand':
      return { bg: c.brandTint, text: c.brand };
    case 'accent':
      return { bg: c.accentTint, text: c.accent };
    case 'danger':
      return { bg: c.dangerTint, text: c.danger };
  }
}

export function Pill({ label, tone }: PillProps) {
  const c = useColors();
  const colors = colorsForTone(tone, c);

  return (
    <View style={[styles.pill, { backgroundColor: colors.bg }]}>
      <Text style={AtmosphereTextStyles.pill(colors.text)}>{label.toUpperCase()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: AtmosphereTokens.radiusPill,
    alignSelf: 'flex-start',
  },
});
