import { useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/theme/useColors';
import { AppIcons } from '@/theme/icons';
import { AtmosphereTextStyles } from '@/theme/textStyles';
import { AtmosphereTokens } from '@/theme/tokens';
import { AtmosphereAppBar } from '@/components/shell/AtmosphereAppBar';
import { AtmosphereCard } from '@/components/atoms/AtmosphereCard';
import { StepDots } from '@/components/atoms/StepDots';
import { PrimaryButton } from '@/components/atoms/PrimaryButton';
import { deviceService } from '@/services/deviceService';

const CALIBRATION_CONFIRMATION_TIMEOUT_MS = 7 * 60_000;

function InstructionItem({ number, text }: { number: string; text: string }) {
  const c = useColors();
  return (
    <View style={styles.instructionRow}>
      <View style={[styles.instructionBadge, { backgroundColor: c.brandTint }]}>
        <Text style={AtmosphereTextStyles.caption(c.brand)}>{number}</Text>
      </View>
      <View style={{ width: AtmosphereTokens.space12 }} />
      <Text style={[AtmosphereTextStyles.body(c.ink2), { flex: 1 }]}>{text}</Text>
    </View>
  );
}

export default function CalibrationWizardScreen() {
  const { id: deviceId, sensor } = useLocalSearchParams<{ id: string; sensor: string }>();
  const router = useRouter();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const sensorLabel = sensor.toUpperCase();

  const [currentStep, setCurrentStep] = useState(0);
  const [calibrating, setCalibrating] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace(`/devices/${deviceId}/settings`);
  }

  async function startCalibration() {
    setCalibrating(true);
    setElapsedSeconds(0);
    setError(null);
    setResult(null);

    const startedAt = Date.now();
    elapsedTimerRef.current = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);

    try {
      const commandType = sensor === 'co' ? 'calibrate_co' : 'calibrate_no2';
      const commandId = await deviceService.sendCommand(deviceId, { type: commandType });
      const command = await deviceService.waitForCommandCompletion(deviceId, commandId, {
        timeoutMs: CALIBRATION_CONFIRMATION_TIMEOUT_MS,
      });

      setCalibrating(false);
      setCurrentStep(2);
      if (command.status === 'done') {
        setResult('Calibration command completed. Recheck live sensor values after the device settles.');
      } else {
        setError(`Calibration finished with status: ${command.status}`);
      }
    } catch (err) {
      setCalibrating(false);
      setCurrentStep(2);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    }
  }

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <AtmosphereAppBar variant="back" title={`Calibrate ${sensorLabel} sensor`} onBack={goBack} />
      <View style={{ height: AtmosphereTokens.space24 }} />
      <StepDots current={currentStep} total={3} />
      <View style={{ height: AtmosphereTokens.space32 }} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: AtmosphereTokens.space20 + insets.bottom }]}
      >
        {currentStep === 0 ? (
          <View>
            <Text style={AtmosphereTextStyles.h1(c.ink)}>Preparation</Text>
            <View style={{ height: AtmosphereTokens.space16 }} />
            <AtmosphereCard>
              <Text style={AtmosphereTextStyles.body(c.ink)}>
                Before calibrating the {sensorLabel} sensor, ensure:
              </Text>
              <View style={{ height: AtmosphereTokens.space16 }} />
              <InstructionItem number="1" text="Place the device in the cleanest stable air available" />
              <View style={{ height: AtmosphereTokens.space12 }} />
              <InstructionItem number="2" text="Keep it powered on for at least 24 hours (preheat period)" />
              <View style={{ height: AtmosphereTokens.space12 }} />
              <InstructionItem
                number="3"
                text="Avoid traffic, smoke, cooking fumes, sprays, and strong odors"
              />
              <View style={{ height: AtmosphereTokens.space12 }} />
              <InstructionItem number="4" text="Ensure stable temperature (15-25°C recommended)" />
            </AtmosphereCard>
            <View style={{ height: AtmosphereTokens.space24 }} />
            <AtmosphereCard>
              <View style={styles.infoRow}>
                <AppIcons.info size={20} color={c.accent} />
                <View style={{ width: AtmosphereTokens.space12 }} />
                <Text style={[AtmosphereTextStyles.caption(c.ink2), { flex: 1 }]}>
                  Calibration takes about 3 minutes; final confirmation can take up to 7 minutes. Without
                  reference gas, readings are for trends and alerts, not lab-grade ppm.
                </Text>
              </View>
            </AtmosphereCard>
            <View style={{ height: AtmosphereTokens.space32 }} />
            <PrimaryButton label="Start calibration" onPress={() => setCurrentStep(1)} />
          </View>
        ) : currentStep === 1 && !calibrating ? (
          <View>
            <Text style={AtmosphereTextStyles.h1(c.ink)}>Ready to calibrate</Text>
            <View style={{ height: AtmosphereTokens.space16 }} />
            <AtmosphereCard>
              <View style={styles.center}>
                <AppIcons.cog size={64} color={c.brand} />
                <View style={{ height: AtmosphereTokens.space16 }} />
                <Text style={[AtmosphereTextStyles.body(c.ink2), styles.centerText]}>
                  Press the button below to start the {sensorLabel} sensor calibration process.
                </Text>
              </View>
            </AtmosphereCard>
            <View style={{ height: AtmosphereTokens.space32 }} />
            <PrimaryButton label="Start" onPress={startCalibration} />
            <View style={{ height: AtmosphereTokens.space12 }} />
            <Text
              style={[AtmosphereTextStyles.body(c.ink3), styles.centerText]}
              onPress={() => setCurrentStep(0)}
            >
              Back
            </Text>
          </View>
        ) : currentStep === 1 && calibrating ? (
          <View>
            <Text style={AtmosphereTextStyles.h1(c.ink)}>Calibrating...</Text>
            <View style={{ height: AtmosphereTokens.space16 }} />
            <AtmosphereCard>
              <View style={styles.center}>
                <ActivityIndicator size="large" />
                <View style={{ height: AtmosphereTokens.space24 }} />
                <Text style={AtmosphereTextStyles.h2(c.ink)}>Calibration in progress</Text>
                <View style={{ height: AtmosphereTokens.space8 }} />
                <Text style={AtmosphereTextStyles.mono(c.ink3)}>Elapsed: {elapsedSeconds}s</Text>
                <View style={{ height: AtmosphereTokens.space16 }} />
                <Text style={[AtmosphereTextStyles.caption(c.ink2), styles.centerText]}>
                  Please wait while the sensor samples a stable baseline. Keep the app open for final
                  confirmation.
                </Text>
              </View>
            </AtmosphereCard>
            <View style={{ height: AtmosphereTokens.space24 }} />
            <AtmosphereCard>
              <View style={styles.infoRow}>
                <AppIcons.warn size={20} color={c.warn} />
                <View style={{ width: AtmosphereTokens.space12 }} />
                <Text style={[AtmosphereTextStyles.caption(c.ink2), { flex: 1 }]}>
                  Do not close the app or move the device
                </Text>
              </View>
            </AtmosphereCard>
          </View>
        ) : (
          <View>
            <Text style={AtmosphereTextStyles.h1(c.ink)}>
              {error ? 'Calibration failed' : 'Calibration complete'}
            </Text>
            <View style={{ height: AtmosphereTokens.space16 }} />
            <AtmosphereCard>
              <View style={styles.center}>
                {error ? (
                  <AppIcons.warn size={64} color={c.danger} />
                ) : (
                  <AppIcons.check size={64} color={c.brand} />
                )}
                <View style={{ height: AtmosphereTokens.space16 }} />
                {error ? (
                  <>
                    <Text style={AtmosphereTextStyles.h2(c.danger)}>Calibration error</Text>
                    <View style={{ height: AtmosphereTokens.space8 }} />
                    <Text style={[AtmosphereTextStyles.body(c.ink2), styles.centerText]}>{error}</Text>
                  </>
                ) : (
                  <>
                    <Text style={AtmosphereTextStyles.h2(c.brand)}>Success</Text>
                    <View style={{ height: AtmosphereTokens.space8 }} />
                    {result ? (
                      <Text style={[AtmosphereTextStyles.mono(c.ink), styles.centerText]}>{result}</Text>
                    ) : null}
                    <View style={{ height: AtmosphereTokens.space8 }} />
                    <Text style={[AtmosphereTextStyles.body(c.ink2), styles.centerText]}>
                      The {sensorLabel} sensor baseline has been saved. Factory reset will keep this
                      calibration.
                    </Text>
                  </>
                )}
              </View>
            </AtmosphereCard>
            <View style={{ height: AtmosphereTokens.space32 }} />
            {error ? (
              <PrimaryButton
                label="Retry"
                onPress={() => {
                  setCurrentStep(1);
                  setCalibrating(false);
                  setError(null);
                  setResult(null);
                  setElapsedSeconds(0);
                }}
              />
            ) : (
              <PrimaryButton label="Done" onPress={goBack} />
            )}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: AtmosphereTokens.space20 },
  center: { alignItems: 'center' },
  centerText: { textAlign: 'center' },
  instructionRow: { flexDirection: 'row', alignItems: 'flex-start' },
  instructionBadge: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  infoRow: { flexDirection: 'row', alignItems: 'flex-start' },
});
