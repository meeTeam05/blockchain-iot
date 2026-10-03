import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { useColors } from '@/theme/useColors';
import { AppIcons } from '@/theme/icons';
import { AtmosphereTextStyles } from '@/theme/textStyles';
import { AtmosphereTokens } from '@/theme/tokens';

import { AtmosphereAppBar } from '@/components/shell/AtmosphereAppBar';
import { AtmosphereCard } from '@/components/atoms/AtmosphereCard';
import { DeviceModeCard } from '@/components/atoms/ModeCard';
import { SensorTile } from '@/components/atoms/SensorTile';
import { RelayCard } from '@/components/atoms/RelayCard';
import { AiCard } from '@/components/atoms/AiCard';
import { EmptyState } from '@/components/atoms/EmptyState';

import { useDevices } from '@/queries/devices';
import { useCommands } from '@/queries/commands';
import { useShadow, useRefreshShadow } from '@/queries/shadow';
import { useTelemetryLive } from '@/hooks/useTelemetryLive';
import { useDeviceControls } from '@/hooks/useDeviceControls';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatRelativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${date.getDate()}/${date.getMonth() + 1}`;
}

export default function DeviceDashboardScreen() {
  const { id: deviceId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const c = useColors();
  const insets = useSafeAreaInsets();

  const devicesQuery = useDevices();
  const commandsQuery = useCommands(deviceId);
  const shadowQuery = useShadow(deviceId);
  const refreshShadow = useRefreshShadow(deviceId);
  const telemetry = useTelemetryLive(deviceId);
  // Called unconditionally per the Rules of Hooks — submit() is only ever
  // invoked after `device` below is confirmed to exist.
  const controls = useDeviceControls({
    commands: commandsQuery.data ?? [],
    deviceId,
    shadow: shadowQuery.data ?? null,
    refetchShadow: refreshShadow,
  });

  const device = (devicesQuery.data ?? []).find((d) => d.id === deviceId) ?? null;

  function goBack() {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace('/home');
    }
  }

  function handleModeToggle(nextOn: boolean) {
    if (nextOn) {
      controls.mode.submit('on').catch(() => undefined);
      return;
    }
    Alert.alert('Switch to Standby?', 'Sensors will pause and relays will turn off.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Confirm', onPress: () => controls.mode.submit('off').catch(() => undefined) },
    ]);
  }

  if (devicesQuery.isLoading) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <AtmosphereAppBar variant="back" title="Device" onBack={goBack} />
        <View style={styles.blockingCenter}>
          <ActivityIndicator color={c.brand} />
        </View>
      </View>
    );
  }

  if (devicesQuery.isError) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <AtmosphereAppBar variant="back" title="Device" onBack={goBack} />
        <EmptyState
          icon={AppIcons.warn}
          title="Failed to load device"
          body={errorMessage(devicesQuery.error)}
          primaryAction="Retry"
          onPrimaryAction={() => devicesQuery.refetch()}
        />
      </View>
    );
  }

  if (!device) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <AtmosphereAppBar variant="back" title={deviceId ?? 'Device'} onBack={goBack} />
        <EmptyState
          icon={AppIcons.warn}
          title="Device not found"
          body="This device is not in your list. It may have been removed."
        />
      </View>
    );
  }

  if (shadowQuery.isError && !shadowQuery.data) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <AtmosphereAppBar variant="back" title={device.name} onBack={goBack} />
        <EmptyState
          icon={AppIcons.warn}
          title="Failed to load device status"
          body={errorMessage(shadowQuery.error)}
          primaryAction="Retry"
          onPrimaryAction={() => shadowQuery.refetch()}
        />
      </View>
    );
  }

  // The reported shadow — not local state — is the sole source of displayed
  // mode/relay values; commands never optimistically flip them.
  const reported = shadowQuery.data?.reported ?? {};
  const deviceOn = typeof reported.mode === 'string' && (reported.mode as string).toLowerCase() === 'on';
  const relay1 = reported.relay_1 === true;
  const relay2 = reported.relay_2 === true;
  const relay3 = reported.relay_3 === true;
  // Present only when the firmware was built with SA_ENABLE_AI=y.
  const aiSupported = typeof reported.ai_enabled === 'boolean';
  const aiOn = reported.ai_enabled === true;

  const latestCommand = (commandsQuery.data ?? [])[0] ?? null;
  const numericSeries = (pick: (p: { temperature: number | null; humidity: number | null; coPpm: number | null; no2Ppm: number | null }) => number | null) =>
    telemetry.points.map(pick).filter((v): v is number => v !== null);
  const feedback = controlFeedback(controls);

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <AtmosphereAppBar
        variant="back"
        title={device.name}
        onBack={goBack}
        actions={
          <Pressable onPress={() => router.push(`/devices/${device.id}/settings`)} hitSlop={8}>
            <AppIcons.cog size={20} color={c.ink} />
          </Pressable>
        }
      />

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: AtmosphereTokens.space20 + insets.bottom }]}
      >
        <Text style={AtmosphereTextStyles.caption(device.online ? c.brand : c.ink3)}>
          {device.online ? '● Online' : '● Offline'}
        </Text>

        <View style={{ height: AtmosphereTokens.space16 }} />

        <DeviceModeCard
          mode={deviceOn ? 'on' : 'off'}
          online={device.online}
          onChange={controls.mode.isPending ? undefined : handleModeToggle}
        />

        <View style={{ height: AtmosphereTokens.space20 }} />

        <View style={styles.sensorGrid}>
          <View style={styles.sensorCell}>
            <SensorTile
              value={deviceOn ? (telemetry.latest?.temperature?.toFixed(2) ?? null) : null}
              unit="°C"
              label="Temperature"
              icon={AppIcons.temp}
              tone="warm"
              sparkColor={c.danger}
              sparklineData={deviceOn ? numericSeries((p) => p.temperature) : []}
              dimmed={!deviceOn}
            />
          </View>

          <View style={styles.sensorCell}>
            <SensorTile
              value={deviceOn ? (telemetry.latest?.humidity?.toFixed(2) ?? null) : null}
              unit="%"
              label="Humidity"
              icon={AppIcons.humidity}
              tone="air"
              sparkColor={c.accent}
              sparklineData={deviceOn ? numericSeries((p) => p.humidity) : []}
              dimmed={!deviceOn}
            />
          </View>

          <View style={styles.sensorCell}>
            <SensorTile
              value={deviceOn ? (telemetry.latest?.coPpm?.toFixed(2) ?? null) : null}
              unit="ppm"
              label="CO"
              icon={AppIcons.cloud}
              tone="cool"
              sparkColor={c.brand}
              sparklineData={deviceOn ? numericSeries((p) => p.coPpm) : []}
              dimmed={!deviceOn}
            />
          </View>

          <View style={styles.sensorCell}>
            <SensorTile
              value={deviceOn ? (telemetry.latest?.no2Ppm?.toFixed(2) ?? null) : null}
              unit="ppm"
              label="NO₂"
              icon={AppIcons.smog}
              tone="no2"
              sparkColor="#7A4FD0"
              sparklineData={deviceOn ? numericSeries((p) => p.no2Ppm) : []}
              dimmed={!deviceOn}
            />
          </View>
        </View>

        <View style={{ height: AtmosphereTokens.space24 }} />

        <View style={styles.relaysHeaderRow}>
          <Text style={AtmosphereTextStyles.h2(c.ink)}>Relays</Text>
          <View style={{ width: AtmosphereTokens.space8 }} />
          <Text style={AtmosphereTextStyles.caption(c.ink3)}>- 3 channels</Text>
        </View>

        <View style={{ height: AtmosphereTokens.space12 }} />

        <View style={styles.relayGrid}>
          <View style={styles.relayCell}>
            <RelayCard
              channel={1}
              name="Fan"
              on={relay1}
              disabled={!deviceOn || controls.fan.isPending}
              onToggle={() => {
                if (deviceOn) controls.fan.submit(!relay1);
              }}
            />
          </View>

          <View style={styles.relayCell}>
            <RelayCard
              channel={2}
              name="Lamp"
              on={relay2}
              disabled={!deviceOn || controls.lamp.isPending}
              onToggle={() => {
                if (deviceOn) controls.lamp.submit(!relay2);
              }}
            />
          </View>

          <View style={styles.relayCell}>
            <RelayCard
              channel={3}
              name="Filter"
              on={relay3}
              disabled={!deviceOn || controls.filter.isPending}
              onToggle={() => {
                if (deviceOn) controls.filter.submit(!relay3);
              }}
            />
          </View>
        </View>

        {feedback ? (
          <>
            <View style={{ height: AtmosphereTokens.space12 }} />
            <Text style={AtmosphereTextStyles.caption(feedback.state === 'failure' ? c.danger : c.warn)}>
              {feedback.message}
            </Text>
          </>
        ) : null}

        {aiSupported ? (
          <>
            <View style={{ height: AtmosphereTokens.space24 }} />
            <Text style={AtmosphereTextStyles.h2(c.ink)}>AI</Text>
            <View style={{ height: AtmosphereTokens.space12 }} />
            <AiCard
              on={aiOn}
              disabled={!deviceOn}
              pending={controls.ai.isPending}
              onToggle={() => {
                if (deviceOn) controls.ai.submit(!aiOn);
              }}
            />
          </>
        ) : null}

        <View style={{ height: AtmosphereTokens.space24 }} />

        <AtmosphereCard>
          <View style={styles.activityHeaderRow}>
            <Text style={[AtmosphereTextStyles.h2(c.ink), { flex: 1 }]}>Recent activity</Text>

            <Text
              style={AtmosphereTextStyles.body(c.brand)}
              onPress={() => router.push(`/devices/${device.id}/commands`)}
            >
              View all →
            </Text>
          </View>

          <View style={{ height: AtmosphereTokens.space12 }} />

          <Text style={AtmosphereTextStyles.body(c.ink2)}>
            {latestCommand
              ? `${latestCommand.status} · ${formatRelativeTime(latestCommand.createdAt)}`
              : 'No command activity yet.'}
          </Text>
        </AtmosphereCard>
      </ScrollView>
    </View>
  );
}

function controlFeedback(
  controls: ReturnType<typeof useDeviceControls>,
): { message: string; state: 'failure' | 'queued' } | null {
  for (const control of [controls.mode, controls.fan, controls.lamp, controls.filter, controls.ai]) {
    if ((control.state === 'failure' || control.state === 'queued') && control.errorMessage !== null) {
      const message = control === controls.ai ? `AI: ${control.errorMessage}` : control.errorMessage;
      return { message, state: control.state };
    }
  }
  return null;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  content: {
    padding: AtmosphereTokens.space20,
  },
  blockingCenter: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: AtmosphereTokens.space24,
  },
  sensorGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: AtmosphereTokens.space12,
  },
  sensorCell: {
    width: '47%',
  },
  relaysHeaderRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
  },
  relayGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: AtmosphereTokens.space12,
  },
  relayCell: {
    width: '47%',
  },
  activityHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
