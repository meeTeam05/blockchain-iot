import { Pressable, StyleSheet, Text } from 'react-native';
import { AtmosphereTokens } from '../../theme/tokens';

interface DangerButtonProps {
  label: string;
  onPress: () => void;
}

export function DangerButton({ label, onPress }: DangerButtonProps) {
  return (
    <Pressable onPress={onPress} style={styles.button}>
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    height: 52,
    backgroundColor: AtmosphereTokens.danger,
    borderRadius: AtmosphereTokens.radiusButton,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: AtmosphereTokens.space24,
  },
  label: {
    color: AtmosphereTokens.paper,
    fontWeight: '600',
    fontSize: 15,
  },
});
