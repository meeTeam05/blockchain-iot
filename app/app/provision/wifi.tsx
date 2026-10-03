import { useRef, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/theme/useColors';
import { AppIcons } from '@/theme/icons';
import { AtmosphereTokens } from '@/theme/tokens';
import { AtmosphereCard } from '@/components/atoms/AtmosphereCard';
import { Field } from '@/components/atoms/Field';
import { BleStepShell } from '@/components/shell/BleStepShell';
import { bleService } from '@/services/bleService';
import { deviceService } from '@/services/deviceService';
import { ApiException } from '@/api/appException';

function defaultProvisioningName(deviceId: string): string {
  const suffix = deviceId.replace(/[^A-Fa-f0-9]/g, '').toUpperCase();
  if (!suffix) {
    const len = Math.min(deviceId.length, 6);
    return `Smart Air ${deviceId.slice(deviceId.length - len).toUpperCase()}`;
  }
  const len = Math.min(suffix.length, 6);
  return `Smart Air ${suffix.slice(suffix.length - len)}`;
}

export default function Step3WifiScreen() {
  const { homeId, mac, ssid } = useLocalSearchParams<{
    homeId?: string;
    mac?: string;
    deviceId?: string;
    ssid?: string;
  }>();
  const router = useRouter();
  const c = useColors();

  const [ssidValue, setSsidValue] = useState(ssid ?? '');
  const [password, setPassword] = useState('');
  const [ssidError, setSsidError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const registeredDeviceId = useRef<string | null>(null);
  const registeredSecretKey = useRef<string | null>(null);

  function validate(): boolean {
    const nextSsidError = ssidValue.trim() ? null : 'Enter your Wi-Fi SSID';
    const nextPasswordError = password.length >= 6 ? null : 'Password must be at least 6 characters';
    setSsidError(nextSsidError);
    setPasswordError(nextPasswordError);
    return nextSsidError === null && nextPasswordError === null;
  }

  async function sendCredentials() {
    if (!validate() || sending) return;
    setSending(true);

    try {
      if (!homeId) throw new Error('Select a home before provisioning.');

      const result = await bleService.sendCredentials(ssidValue.trim(), password);
      let secretKey: string | null = null;

      try {
        const registration = await deviceService.provisionDevice({
          deviceId: result.deviceId,
          name: defaultProvisioningName(result.deviceId),
          homeId,
        });
        registeredDeviceId.current = registration.device.id;
        registeredSecretKey.current = registration.secretKey;
        secretKey = registration.secretKey;
      } catch (err) {
        const isAlreadyRegistered =
          err instanceof ApiException && err.statusCode === 409 && err.message === 'Device already registered';
        if (!isAlreadyRegistered) throw err;

        if (registeredDeviceId.current === result.deviceId && registeredSecretKey.current) {
          secretKey = registeredSecretKey.current;
        } else {
          const announced = await deviceService.checkAnnounce(result.deviceId);
          if (!announced) {
            throw new ApiException(
              409,
              'Device already registered and MQTT credentials cannot be recovered. Delete or factory reset the device, then provision again.',
            );
          }
        }
      }

      if (secretKey) {
        await deviceService.configureProvisionedDevice({
          host: result.ip,
          deviceId: result.deviceId,
          secretKey,
        });
      }
      await bleService.disconnect();

      router.push({
        pathname: '/provision/announce',
        params: { homeId, mac: mac ?? '', deviceId: result.deviceId },
      });
    } catch (err) {
      setSending(false);
      Alert.alert('', err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <BleStepShell
      currentStep={2}
      title="Connect to Wi-Fi"
      subtitle="Send Wi-Fi details, register the device with the server, then deliver its MQTT credentials locally."
      body={
        <View>
          <AtmosphereCard padding={AtmosphereTokens.space16}>
            <View style={styles.macRow}>
              <View style={[styles.macIcon, { backgroundColor: c.accentTint }]}>
                <AppIcons.wifi size={20} color={c.accent} />
              </View>
              <View style={{ width: AtmosphereTokens.space12 }} />
              <Text style={{ color: c.ink, fontSize: 13, fontWeight: '600', flex: 1 }}>{mac}</Text>
            </View>
            <View style={{ height: AtmosphereTokens.space20 }} />
            <Field label="Wi-Fi network" value={ssidValue} onChangeText={setSsidValue} errorText={ssidError} />
            <View style={{ height: AtmosphereTokens.space16 }} />
            <Field
              label="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              errorText={passwordError}
            />
          </AtmosphereCard>
          <View style={{ height: AtmosphereTokens.space16 }} />
          <Text style={{ color: c.ink2, fontSize: 13, lineHeight: 20 }}>
            We keep the BLE link open just long enough to deliver the credentials securely.
          </Text>
        </View>
      }
      primaryLabel={sending ? 'Sending...' : 'Send credentials'}
      primaryLoading={sending}
      primaryEnabled={!sending}
      onPrimary={sendCredentials}
      secondaryLabel="Back"
      onSecondary={() => router.back()}
      onCancel={() => router.back()}
    />
  );
}

const styles = StyleSheet.create({
  macRow: { flexDirection: 'row', alignItems: 'center' },
  macIcon: { width: 44, height: 44, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
});
