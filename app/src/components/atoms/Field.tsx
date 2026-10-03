import { StyleSheet, Text, TextInput, TextInputProps, View } from 'react-native';
import { useColors } from '../../theme/useColors';
import { AtmosphereTextStyles } from '../../theme/textStyles';
import { AtmosphereTokens } from '../../theme/tokens';

interface FieldProps {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  secureTextEntry?: boolean;
  keyboardType?: TextInputProps['keyboardType'];
  errorText?: string | null;
}

export function Field({
  label,
  value,
  onChangeText,
  secureTextEntry = false,
  keyboardType,
  errorText,
}: FieldProps) {
  const c = useColors();
  const hasError = Boolean(errorText);

  return (
    <View>
      <Text style={AtmosphereTextStyles.body(c.ink)}>{label}</Text>
      <View style={{ height: AtmosphereTokens.space8 }} />
      <TextInput
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
        autoCapitalize="none"
        style={[
          styles.input,
          AtmosphereTextStyles.body(c.ink),
          {
            backgroundColor: c.paper,
            borderColor: hasError ? c.danger : c.line,
            borderRadius: AtmosphereTokens.radiusInput,
          },
        ]}
      />
      {hasError ? (
        <Text style={[AtmosphereTextStyles.caption(c.danger), styles.errorText]}>
          {errorText}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    height: 56,
    borderWidth: 1,
    paddingHorizontal: AtmosphereTokens.space16,
  },
  errorText: {
    marginTop: AtmosphereTokens.space4,
  },
});
