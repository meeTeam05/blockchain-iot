import { Pressable, StyleSheet, Text } from 'react-native';
import { useColors } from '../../theme/useColors';
import { AtmosphereTextStyles } from '../../theme/textStyles';
import { AtmosphereTokens } from '../../theme/tokens';

interface FilterChipProps {
  label: string;
  active: boolean;
  onPress: () => void;
}

export function FilterChip({ label, active, onPress }: FilterChipProps) {
  const c = useColors();

  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.chip,
        {
          backgroundColor: active ? c.brandTint : c.paper,
          borderColor: active ? c.brand : c.line,
          borderWidth: active ? 1.5 : 1,
        },
      ]}
    >
      <Text style={AtmosphereTextStyles.body(active ? c.brand : c.ink2)}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    paddingHorizontal: AtmosphereTokens.space16,
    paddingVertical: AtmosphereTokens.space8,
    borderRadius: AtmosphereTokens.radiusPill,
  },
});
