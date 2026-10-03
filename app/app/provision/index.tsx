import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/theme/useColors';
import { AppIcons } from '@/theme/icons';
import { AtmosphereTokens } from '@/theme/tokens';
import { AtmosphereCard } from '@/components/atoms/AtmosphereCard';
import { BleStepShell } from '@/components/shell/BleStepShell';

export default function Step1PowerOnScreen() {
  const { homeId } = useLocalSearchParams<{ homeId?: string }>();
  const router = useRouter();
  const c = useColors();
  const [pulseOn, setPulseOn] = useState(true);

  useEffect(() => {
    const timer = setInterval(() => setPulseOn((v) => !v), 700);
    return () => clearInterval(timer);
  }, []);

  return (
    <BleStepShell
      currentStep={0}
      title="Power on your device"
      subtitle="Press and hold BOOT for 3 seconds until the LED blinks, then continue."
      body={
        <AtmosphereCard padding={AtmosphereTokens.space24}>
          <View style={styles.center}>
            <View style={[styles.deviceOuter, { backgroundColor: c.brandTint, borderColor: c.line }]}>
              <View style={[styles.deviceInner, { backgroundColor: c.paper, borderColor: c.line }]}>
                <AppIcons.device size={54} color={c.brand} />
              </View>
              <View
                style={[
                  styles.led,
                  { backgroundColor: c.brand, opacity: pulseOn ? 1 : 0.25 },
                ]}
              />
              <View style={[styles.ledLabel, { backgroundColor: c.paper }]}>
                <Text style={{ color: c.brand, fontSize: 12, fontWeight: '600' }}>LED blinking</Text>
              </View>
            </View>
            <View style={{ height: AtmosphereTokens.space20 }} />
            <Text style={[styles.hint, { color: c.ink2 }]}>
              Make sure the device is close by and ready to join your Wi-Fi network.
            </Text>
          </View>
        </AtmosphereCard>
      }
      primaryLabel="Continue"
      onPrimary={() => router.push({ pathname: '/provision/scan', params: { homeId: homeId ?? '' } })}
      secondaryLabel="Cancel"
      onSecondary={() => router.replace('/home')}
      onCancel={() => router.replace('/home')}
    />
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center' },
  deviceOuter: {
    width: 220,
    height: 180,
    borderRadius: AtmosphereTokens.radiusCard,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deviceInner: {
    width: 122,
    height: 104,
    borderRadius: 24,
    borderWidth: 1.2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  led: {
    position: 'absolute',
    top: 34,
    right: 38,
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  ledLabel: {
    position: 'absolute',
    bottom: 18,
    paddingHorizontal: AtmosphereTokens.space12,
    paddingVertical: AtmosphereTokens.space6,
    borderRadius: AtmosphereTokens.radiusPill,
  },
  hint: {
    textAlign: 'center',
    fontSize: 14,
    lineHeight: 20,
  },
});
