import { StyleSheet, Text, View } from 'react-native';
import { useColors } from '../../theme/useColors';
import { AtmosphereTextStyles } from '../../theme/textStyles';
import { AtmosphereTokens } from '../../theme/tokens';
import { AtmosphereSwitch } from './AtmosphereSwitch';

interface DeviceModeCardProps {
  mode: string;
  online: boolean;
  onChange?: (value: boolean) => void;
}

export function DeviceModeCard({ mode, online, onChange }: DeviceModeCardProps) {
  const c = useColors();
  const isOn = mode.toLowerCase() === 'on';

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: isOn ? c.brandTint : c.bg, borderColor: c.line },
      ]}
    >
      <View style={{ flex: 1 }}>
        <Text style={AtmosphereTextStyles.label(c.ink2)}>DEVICE MODE</Text>
        <View style={{ height: AtmosphereTokens.space8 }} />
        <Text style={AtmosphereTextStyles.h1(isOn ? c.brand : c.ink3)}>{mode.toUpperCase()}</Text>
        <View style={{ height: AtmosphereTokens.space4 }} />
        <Text style={AtmosphereTextStyles.caption(c.ink3)}>{online ? 'Online' : 'Offline'}</Text>
      </View>
      <AtmosphereSwitch
        value={isOn}
        onChange={onChange}
        size="large"
        accessibilityLabel="Device mode toggle"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: AtmosphereTokens.space20,
    borderRadius: AtmosphereTokens.radiusCard,
    borderWidth: 1,
  },
});
