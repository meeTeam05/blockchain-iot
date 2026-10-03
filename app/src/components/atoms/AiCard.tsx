import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '../../theme/useColors';
import { AtmosphereTextStyles } from '../../theme/textStyles';
import { AtmosphereTokens } from '../../theme/tokens';
import { AppIcons } from '../../theme/icons';
import { AtmosphereSwitch } from './AtmosphereSwitch';

interface AiCardProps {
  on: boolean;
  disabled?: boolean;
  pending?: boolean;
  onToggle: () => void;
}

export function AiCard({ on, disabled = false, pending = false, onToggle }: AiCardProps) {
  const c = useColors();
  const status = pending ? 'Updating…' : disabled ? 'Available when device is ON' : on ? 'ON' : 'OFF';

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: c.paper, borderColor: c.line, opacity: disabled ? 0.55 : 1 },
      ]}
    >
      <AppIcons.ai size={22} color={on && !disabled ? c.brand : c.ink3} />
      <View style={{ width: AtmosphereTokens.space12 }} />
      <View style={{ flex: 1 }}>
        <Text style={AtmosphereTextStyles.body(c.ink)}>AI detection</Text>
        <View style={{ height: AtmosphereTokens.space4 }} />
        <Text style={AtmosphereTextStyles.caption(c.ink3)} accessibilityLiveRegion="polite">
          {status}
        </Text>
      </View>
      {disabled ? (
        <View style={styles.lockIcon}>
          <AppIcons.lock size={16} color={c.ink3} />
        </View>
      ) : null}
      <AtmosphereSwitch
        value={on}
        onChange={disabled || pending ? undefined : () => onToggle()}
        accessibilityLabel="AI detection toggle"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: AtmosphereTokens.space16,
    borderRadius: AtmosphereTokens.radiusCard,
    borderWidth: 1,
  },
  lockIcon: {
    marginRight: AtmosphereTokens.space8,
  },
});
