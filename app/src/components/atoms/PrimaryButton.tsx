import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { AtmosphereTokens } from '../../theme/tokens';

interface PrimaryButtonProps {
  label: string;
  loading?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

export function PrimaryButton({ label, loading = false, disabled = false, onPress }: PrimaryButtonProps) {
  const inactive = loading || disabled;
  return (
    <Pressable
      onPress={inactive ? undefined : onPress}
      disabled={inactive}
      style={[styles.button, inactive && styles.buttonDisabled]}
    >
      {loading ? (
        <ActivityIndicator color={AtmosphereTokens.paper} size="small" />
      ) : (
        <Text style={styles.label}>{label}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    height: 52,
    backgroundColor: AtmosphereTokens.brand,
    borderRadius: AtmosphereTokens.radiusButton,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: AtmosphereTokens.space24,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  label: {
    color: AtmosphereTokens.paper,
    fontWeight: '600',
    fontSize: 15,
  },
});
