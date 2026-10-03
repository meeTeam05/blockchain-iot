import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '../../theme/useColors';
import { AtmosphereTextStyles } from '../../theme/textStyles';
import { AtmosphereTokens } from '../../theme/tokens';
import { AppIcons } from '../../theme/icons';
import { AtmosphereSwitch } from './AtmosphereSwitch';

interface RelayCardProps {
  channel: number;
  name: string;
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
}

export function RelayCard({ channel, name, on, disabled = false, onToggle }: RelayCardProps) {
  const c = useColors();

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: c.paper, borderColor: c.line, opacity: disabled ? 0.55 : 1 },
      ]}
    >
      {disabled ? (
        <View style={styles.lockIcon}>
          <AppIcons.lock size={16} color={c.ink3} />
        </View>
      ) : null}
      <Text style={AtmosphereTextStyles.label(c.ink3)}>{`R${channel}`}</Text>
      <View style={{ height: AtmosphereTokens.space8 }} />
      <Text style={AtmosphereTextStyles.body(c.ink)} numberOfLines={2}>
        {name}
      </Text>
      <View style={{ height: AtmosphereTokens.space12 }} />
      <AtmosphereSwitch
        value={on}
        onChange={disabled ? undefined : () => onToggle()}
        accessibilityLabel={`Relay ${channel} ${name} toggle`}
      />
      <View style={{ height: AtmosphereTokens.space8 }} />
      <Text style={AtmosphereTextStyles.caption(c.ink3)}>{on ? 'ON' : 'OFF'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: AtmosphereTokens.space16,
    borderRadius: AtmosphereTokens.radiusCard,
    borderWidth: 1,
  },
  lockIcon: {
    position: 'absolute',
    top: AtmosphereTokens.space16,
    right: AtmosphereTokens.space16,
  },
});
