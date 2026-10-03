import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/theme/useColors';
import { AtmosphereTextStyles } from '@/theme/textStyles';
import { AtmosphereTokens } from '@/theme/tokens';
import { AppColors } from '@/theme/appColors';
import { AppIcons } from '@/theme/icons';
import { AtmosphereAppBar } from '@/components/shell/AtmosphereAppBar';
import { AtmosphereCard } from '@/components/atoms/AtmosphereCard';
import { EmptyState } from '@/components/atoms/EmptyState';
import { Pill } from '@/components/atoms/Pill';
import { useDevices } from '@/queries/devices';
import { useOtaCatalog, useOtaRealtimeProgress, useOtaRequestMutation } from '@/queries/ota';
import { OtaProgressState } from '@/models/ota';

const PROGRESS_COPY: Record<OtaProgressState, { title: string; body: (progress: number | null, error: string | null) => string }> = {
  idle: { title: '', body: () => '' },
  requesting: { title: 'Requesting firmware update', body: () => 'Sending the update request to the device service.' },
  accepted: { title: 'Firmware update requested', body: () => 'Waiting for firmware progress from the device.' },
  downloading: { title: 'Downloading firmware', body: (p) => (p === null ? 'Preparing the firmware update…' : `Downloading firmware: ${p}%`) },
  waiting_reboot: { title: 'OTA update applied', body: () => 'Device is rebooting to finish the update.' },
  checking_device: { title: 'Checking firmware version', body: () => 'Waiting for the device to reconnect…' },
  completed: { title: 'Firmware update complete', body: () => 'The device reconnected with the requested firmware version.' },
  timeout: { title: 'Unable to verify firmware update', body: () => 'The device did not reconnect in time.' },
  failed: { title: 'OTA update failed', body: (_p, err) => err ?? 'Device reported an OTA failure.' },
};

export default function OtaScreen() {
  const { id: deviceId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const c = useColors();
  const insets = useSafeAreaInsets();

  const devicesQuery = useDevices();
  const otaQuery = useOtaCatalog(deviceId);
  const progressQuery = useOtaRealtimeProgress(deviceId);
  const otaRequest = useOtaRequestMutation(deviceId);
  const [submittingVersion, setSubmittingVersion] = useState<string | null>(null);

  const device = (devicesQuery.data ?? []).find((d) => d.id === deviceId) ?? null;
  const catalog = otaQuery.data ?? null;
  const currentVersion = device?.firmwareVer ?? catalog?.currentVersion ?? 'Unknown';
  const isOnline = device?.online ?? catalog?.deviceOnline ?? false;
  const progress = progressQuery.data;

  async function startUpdate(version: string) {
    setSubmittingVersion(version);
    try {
      await otaRequest.mutateAsync(version);
    } catch (err) {
      Alert.alert('', err instanceof Error ? err.message : String(err));
    } finally {
      setSubmittingVersion(null);
    }
  }

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <AtmosphereAppBar
        variant="back"
        title="Firmware update"
        onBack={() =>
          router.canGoBack() ? router.back() : router.replace(`/devices/${deviceId}/settings`)
        }
      />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: AtmosphereTokens.space20 + insets.bottom }]}
      >
        <AtmosphereCard>
          <View style={styles.headerRow}>
            <Text style={AtmosphereTextStyles.caption(c.ink3)}>Current firmware</Text>
            <Pill label={isOnline ? 'Online' : 'Offline'} tone={isOnline ? 'online' : 'offline'} />
          </View>
          <View style={{ height: AtmosphereTokens.space4 }} />
          <Text style={AtmosphereTextStyles.mono(c.ink)}>{currentVersion}</Text>
        </AtmosphereCard>

        {progress && progress.state !== 'idle' ? (
          <>
            <View style={{ height: AtmosphereTokens.space16 }} />
            <AtmosphereCard>
              <Text
                style={AtmosphereTextStyles.body(
                  progress.state === 'failed' || progress.state === 'timeout' ? c.danger : c.brand,
                )}
              >
                {PROGRESS_COPY[progress.state].title}
              </Text>
              <View style={{ height: AtmosphereTokens.space4 }} />
              <Text style={AtmosphereTextStyles.caption(c.ink2)}>
                {PROGRESS_COPY[progress.state].body(progress.progress, progress.errorMessage)}
              </Text>
              {(progress.state === 'failed' || progress.state === 'timeout') && progress.requestedVersion ? (
                <Pressable
                  onPress={() => startUpdate(progress.requestedVersion!)}
                  style={[styles.progressRetry, { borderColor: c.brand }]}
                >
                  <Text style={AtmosphereTextStyles.body(c.brand)}>Retry</Text>
                </Pressable>
              ) : null}
            </AtmosphereCard>
          </>
        ) : null}

        <View style={{ height: AtmosphereTokens.space24 }} />
        <Text style={AtmosphereTextStyles.h2(c.ink)}>Available versions</Text>
        <View style={{ height: AtmosphereTokens.space12 }} />

        {otaQuery.isLoading && !catalog ? (
          <View style={styles.loadingBox}>
            <ActivityIndicator color={c.brand} />
          </View>
        ) : otaQuery.isError && !catalog ? (
          <EmptyState
            icon={AppIcons.warn}
            title="Failed to load OTA versions"
            body={otaQuery.error instanceof Error ? otaQuery.error.message : 'Unknown error'}
            primaryAction="Retry"
            onPrimaryAction={() => otaQuery.refetch()}
          />
        ) : (catalog?.versions ?? []).length === 0 ? (
          <EmptyState
            icon={AppIcons.download}
            title="No OTA versions found"
            body="Drop firmware binaries into server/ota-files to make them available here."
          />
        ) : (
          catalog!.versions.map((version) => (
            <View key={version.version} style={{ marginBottom: AtmosphereTokens.space12 }}>
              <AtmosphereCard>
                <View style={styles.versionRow}>
                  <View style={{ flex: 1 }}>
                    <View style={styles.versionTitleRow}>
                      <Text style={AtmosphereTextStyles.body(c.ink)}>{version.version}</Text>
                      {version.version === currentVersion ? (
                        <>
                          <View style={{ width: AtmosphereTokens.space8 }} />
                          <Pill label="Current" tone="brand" />
                        </>
                      ) : null}
                    </View>
                    <View style={{ height: AtmosphereTokens.space4 }} />
                    <Text style={AtmosphereTextStyles.mono(c.ink3)}>{version.filename}</Text>
                  </View>
                  <View style={{ width: AtmosphereTokens.space12 }} />
                  <Pressable
                    disabled={submittingVersion !== null}
                    onPress={() => startUpdate(version.version)}
                    style={[styles.updateButton, { backgroundColor: AppColors.primary }]}
                  >
                    {submittingVersion === version.version ? (
                      <ActivityIndicator size="small" color="#FFFFFF" />
                    ) : (
                      <Text style={styles.updateButtonLabel}>Update</Text>
                    )}
                  </Pressable>
                </View>
              </AtmosphereCard>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: AtmosphereTokens.space20 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  loadingBox: { alignItems: 'center', paddingVertical: AtmosphereTokens.space24 },
  versionRow: { flexDirection: 'row', alignItems: 'flex-start' },
  versionTitleRow: { flexDirection: 'row', alignItems: 'center' },
  updateButton: {
    height: 40,
    paddingHorizontal: AtmosphereTokens.space16,
    borderRadius: AtmosphereTokens.radiusButton,
    alignItems: 'center',
    justifyContent: 'center',
  },
  updateButtonLabel: { color: '#FFFFFF', fontWeight: '600' },
  progressRetry: {
    marginTop: AtmosphereTokens.space12,
    height: 40,
    paddingHorizontal: AtmosphereTokens.space16,
    borderRadius: AtmosphereTokens.radiusButton,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
});
