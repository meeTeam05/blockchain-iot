import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/theme/useColors';
import { AppIcons } from '@/theme/icons';
import { AtmosphereTokens } from '@/theme/tokens';
import { AtmosphereTextStyles } from '@/theme/textStyles';
import { AtmosphereCard } from '@/components/atoms/AtmosphereCard';
import { BleStepShell } from '@/components/shell/BleStepShell';
import { deviceService } from '@/services/deviceService';

const POLL_INTERVAL_MS = 2000;
const DEADLINE_MS = 60_000;

export default function Step4CloudScreen() {
  const { homeId, mac, deviceId } = useLocalSearchParams<{
    homeId?: string;
    mac?: string;
    deviceId?: string;
  }>();
  const router = useRouter();
  const c = useColors();

  const hasRequiredRouteState = Boolean(homeId) && Boolean(deviceId);

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollingRef = useRef(false);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!hasRequiredRouteState) return;
    begin();
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
      pollingRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRequiredRouteState]);

  function begin() {
    if (pollingRef.current || !deviceId || !homeId || !mac) return;

    if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    setElapsedSeconds(0);
    setError(null);
    pollingRef.current = true;
    inFlightRef.current = false;

    elapsedTimerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
    const deadline = Date.now() + DEADLINE_MS;
    let lastError: unknown = null;

    async function pollOnce() {
      if (!pollingRef.current || inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const announced = await deviceService.checkAnnounce(deviceId!);
        if (!pollingRef.current) return;
        if (announced) {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
          pollingRef.current = false;
          router.push({
            pathname: '/provision/name',
            params: { homeId: homeId!, mac: mac!, deviceId: deviceId! },
          });
          return;
        }
        lastError = null;
      } catch (err) {
        lastError = err;
      } finally {
        inFlightRef.current = false;
      }

      if (!pollingRef.current || Date.now() < deadline) return;

      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
      pollingRef.current = false;
      setError(
        lastError === null
          ? 'Device did not announce within 60 seconds. Check Wi-Fi and try again.'
          : `Device did not announce within 60 seconds. Last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
    }

    pollTimerRef.current = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
    void pollOnce();
  }

  if (!hasRequiredRouteState) {
    return (
      <BleStepShell
        currentStep={3}
        title="Confirm cloud connection"
        subtitle="Provisioning link is incomplete. Start again from the device scan step."
        body={
          <AtmosphereCard padding={AtmosphereTokens.space20}>
            <View style={styles.center}>
              <AppIcons.warn size={30} color={c.danger} />
              <View style={{ height: AtmosphereTokens.space16 }} />
              <Text style={AtmosphereTextStyles.h2(c.ink)}>Missing provisioning details</Text>
              <View style={{ height: AtmosphereTokens.space8 }} />
              <Text style={[AtmosphereTextStyles.body(c.ink2), styles.centerText]}>
                This step needs both a home and device ID. Start provisioning again.
              </Text>
            </View>
          </AtmosphereCard>
        }
        primaryLabel="Start over"
        onPrimary={() => router.replace('/home')}
        secondaryLabel="Cancel"
        onSecondary={() => router.replace('/home')}
        onCancel={() => router.replace('/home')}
      />
    );
  }

  return (
    <BleStepShell
      currentStep={3}
      title="Confirm cloud connection"
      subtitle="We're waiting for the device to reboot, connect to MQTT, and announce itself to the cloud."
      body={
        <AtmosphereCard padding={AtmosphereTokens.space20}>
          <View style={styles.center}>
            <View style={[styles.cloudIcon, { backgroundColor: c.brandTint }]}>
              <AppIcons.cloud size={34} color={c.brand} />
            </View>
            <View style={{ height: AtmosphereTokens.space20 }} />
            <Text style={{ color: c.ink, fontSize: 18, fontWeight: '700' }}>
              {error ? 'Cloud check failed' : 'Connecting to cloud...'}
            </Text>
            <View style={{ height: AtmosphereTokens.space8 }} />
            <Text style={[styles.hint, { color: c.ink2 }]}>
              {error ?? `Elapsed ${elapsedSeconds}s - checking every 2 seconds`}
            </Text>
            <View style={{ height: AtmosphereTokens.space20 }} />
            {error === null ? (
              <ActivityIndicator size="small" />
            ) : (
              <AppIcons.warn size={30} color={c.danger} />
            )}
          </View>
        </AtmosphereCard>
      }
      primaryLabel={error === null ? 'Waiting...' : 'Retry'}
      primaryEnabled={error !== null}
      onPrimary={begin}
      secondaryLabel="Cancel"
      onSecondary={() => router.replace('/home')}
      onCancel={() => router.replace('/home')}
    />
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center' },
  centerText: { textAlign: 'center' },
  cloudIcon: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  hint: { textAlign: 'center', fontSize: 13, lineHeight: 20 },
});
