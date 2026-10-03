import { Pressable, StyleSheet, Text } from 'react-native';
import { useColors } from '../../theme/useColors';
import { AtmosphereTokens } from '../../theme/tokens';

interface GhostButtonProps {
  label: string;
  onPress: () => void;
}

export function GhostButton({ label, onPress }: GhostButtonProps) {
  const c = useColors();

  return (
    <Pressable
      onPress={onPress}
      style={[styles.button, { backgroundColor: c.paper, borderColor: c.brand }]}
    >
      <Text style={[styles.label, { color: c.brand }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    height: 52,
    borderWidth: 1.5,
    borderRadius: AtmosphereTokens.radiusButton,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: AtmosphereTokens.space24,
  },
  label: {
    fontWeight: '600',
    fontSize: 15,
  },
});
