import { StyleSheet, Text, View } from 'react-native';
import { LucideIcon } from 'lucide-react-native';
import { useColors } from '../../theme/useColors';
import { AtmosphereTextStyles } from '../../theme/textStyles';
import { AtmosphereTokens } from '../../theme/tokens';
import { Pill, PillTone } from './Pill';

interface HistoryRowProps {
  icon: LucideIcon;
  label: string;
  sub: string;
  badgeTone?: PillTone;
  badgeLabel?: string;
}

export function HistoryRow({ icon: Icon, label, sub, badgeTone, badgeLabel }: HistoryRowProps) {
  const c = useColors();

  return (
    <View style={styles.row}>
      <View style={[styles.iconBox, { backgroundColor: c.line2 }]}>
        <Icon size={20} color={c.ink2} />
      </View>
      <View style={{ width: AtmosphereTokens.space12 }} />
      <View style={{ flex: 1 }}>
        <Text style={AtmosphereTextStyles.body(c.ink)}>{label}</Text>
        <View style={{ height: AtmosphereTokens.space2 }} />
        <Text style={AtmosphereTextStyles.caption(c.ink3)}>{sub}</Text>
      </View>
      {badgeTone && badgeLabel ? <Pill label={badgeLabel} tone={badgeTone} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: AtmosphereTokens.space12,
    paddingHorizontal: AtmosphereTokens.space16,
  },
  iconBox: {
    width: 40,
    height: 40,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
