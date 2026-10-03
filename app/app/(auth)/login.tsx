import { useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuthStore } from '@/stores/authStore';
import { useColors } from '@/theme/useColors';
import { AtmosphereTextStyles } from '@/theme/textStyles';
import { AtmosphereTokens } from '@/theme/tokens';
import { DotLogo } from '@/components/atoms/DotLogo';
import { Field } from '@/components/atoms/Field';
import { PrimaryButton } from '@/components/atoms/PrimaryButton';
import { TextLinkButton } from '@/components/atoms/TextLinkButton';

export default function LoginScreen() {
  const router = useRouter();
  const c = useColors();
  const login = useAuthStore((s) => s.login);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  function validate(): boolean {
    const nextEmailError = email.includes('@') ? null : 'Enter a valid email';
    const nextPasswordError = password.length >= 6 ? null : 'Min 6 characters';
    setEmailError(nextEmailError);
    setPasswordError(nextPasswordError);
    return nextEmailError === null && nextPasswordError === null;
  }

  async function submit() {
    if (!validate()) return;
    setLoading(true);
    await login(email.trim(), password);
    setLoading(false);

    const error = useAuthStore.getState().error;
    if (error) {
      Alert.alert('', error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.bg }]} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.logo}>
          <DotLogo size={64} color={c.brand} />
        </View>
        <View style={{ height: AtmosphereTokens.space24 }} />
        <Text style={[AtmosphereTextStyles.h2(c.ink), styles.centerText]}>Welcome back</Text>
        <View style={{ height: AtmosphereTokens.space8 }} />
        <Text style={[AtmosphereTextStyles.body(c.ink3), styles.centerText]}>
          Sign in to continue
        </Text>
        <View style={{ height: AtmosphereTokens.space32 }} />

        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          keyboardType="email-address"
          errorText={emailError}
        />
        <View style={{ height: AtmosphereTokens.space20 }} />
        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          errorText={passwordError}
        />
        <View style={{ height: AtmosphereTokens.space32 }} />

        <PrimaryButton label="Sign In" loading={loading} onPress={submit} />
        <View style={{ height: AtmosphereTokens.space20 }} />

        <View style={styles.centerRow}>
          <TextLinkButton
            label="Forgot password?"
            onPress={() => Alert.alert('', 'Coming soon')}
          />
        </View>
        <View style={{ height: AtmosphereTokens.space20 }} />

        <View style={[styles.row, styles.centerRow]}>
          <Text style={AtmosphereTextStyles.body(c.ink3)}>No account? </Text>
          <TextLinkButton label="Register" onPress={() => router.push('/register')} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: AtmosphereTokens.space24,
    paddingVertical: AtmosphereTokens.space32,
  },
  logo: {
    alignSelf: 'center',
  },
  centerText: {
    textAlign: 'center',
  },
  centerRow: {
    alignItems: 'center',
  },
  row: {
    flexDirection: 'row',
  },
});
