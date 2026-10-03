import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/theme/useColors';
import { AppIcons } from '@/theme/icons';
import { AtmosphereTokens } from '@/theme/tokens';
import { AtmosphereCard } from '@/components/atoms/AtmosphereCard';
import { EmptyState } from '@/components/atoms/EmptyState';
import { BleStepShell } from '@/components/shell/BleStepShell';
import { bleService } from '@/services/bleService';
import { BleDeviceInfo } from '@/services/bleModels';
import type { BlePreflightStatus } from '@/services/bleModels';

const PREFLIGHT_TITLES: Record<BlePreflightStatus, string> = {
  unsupported: 'Bluetooth unavailable',
  bluetoothOff: 'Bluetooth is off',
  permissionDenied: 'Bluetooth permission required',
  permissionPermanentlyDenied: 'Bluetooth permission blocked',
  locationOff: 'Location is off',
  ready: 'Ready to scan',
};

const PREFLIGHT_MESSAGES: Record<BlePreflightStatus, string> = {
  unsupported: 'This phone does not support Bluetooth Low Energy scanning.',
  bluetoothOff: 'Turn on Bluetooth, then check again.',
  permissionDenied: 'Allow Bluetooth access, then check again.',
  permissionPermanentlyDenied: 'Open app settings and allow Bluetooth access, then check again.',
  locationOff: 'Turn on Location services, then check again.',
  ready: 'Ready to scan.',
};

function canOpenSettings(status: BlePreflightStatus | null): boolean {
  return status === 'bluetoothOff' || status === 'permissionPermanentlyDenied' || status === 'locationOff';
}

export default function Step2BleScanScreen() {
  const { homeId } = useLocalSearchParams<{ homeId?: string }>();
  const router = useRouter();
  const c = useColors();

  const [devices, setDevices] = useState<BleDeviceInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preflightStatus, setPreflightStatus] = useState<BlePreflightStatus | null>(null);
  const stopScanRef = useRef<(() => void) | null>(null);
  const scanTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
      stopScanRef.current?.();
      bleService.stopScan();
    };
  }, []);

  async function startScan() {
    if (scanTimeoutRef.current) clearTimeout(scanTimeoutRef.current);
    stopScanRef.current?.();
    await bleService.stopScan();

    setDevices([]);
    setError(null);
    setPreflightStatus(null);
    setConnecting(false);
    setScanning(false);

    const preflight = await bleService.checkPreflight();
    if (preflight !== 'ready') {
      setPreflightStatus(preflight);
      setError(PREFLIGHT_MESSAGES[preflight]);
      return;
    }

    setScanning(true);
    stopScanRef.current = bleService.scan(
      {
        onDevice: (device) => {
          setDevices((prev) => {
            if (prev.some((d) => d.remoteId === device.remoteId)) return prev;
            return [...prev, device].sort((a, b) => b.rssi - a.rssi);
          });
        },
        onError: (err) => {
          setScanning(false);
          setError(err.message);
        },
      },
      12_000,
    );

    scanTimeoutRef.current = setTimeout(() => setScanning(false), 15_000);
  }

  async function openSettings() {
    if (preflightStatus === 'bluetoothOff') await bleService.openBluetoothSettings();
    else if (preflightStatus === 'permissionPermanentlyDenied') await bleService.openPermissionSettings();
    else if (preflightStatus === 'locationOff') await bleService.openLocationSettings();
  }

  async function selectDevice(device: BleDeviceInfo) {
    if (connecting) return;
    setConnecting(true);
    setError(null);
    try {
      await bleService.connect(device.remoteId);
      router.push({
        pathname: '/provision/wifi',
        params: { homeId: homeId ?? '', mac: device.remoteId, deviceId: device.remoteId },
      });
    } catch (err) {
      setConnecting(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const hasDevices = devices.length > 0;

  return (
    <BleStepShell
      currentStep={1}
      title="Scan for nearby devices"
      subtitle="We'll find Smart Air units in provisioning mode and connect to the strongest one."
      body={
        <AtmosphereCard padding={AtmosphereTokens.space16}>
          {scanning ? (
            <View style={styles.scanningState}>
              <ActivityIndicator size="small" />
              <View style={{ height: AtmosphereTokens.space16 }} />
              <Text style={{ color: c.ink, fontWeight: '600' }}>Scanning...</Text>
              <View style={{ height: AtmosphereTokens.space8 }} />
              <Text style={{ color: c.ink2, fontSize: 13 }}>Tap a device to continue.</Text>
            </View>
          ) : error ? (
            <EmptyState
              icon={AppIcons.warn}
              title={preflightStatus === null ? 'Scan failed' : PREFLIGHT_TITLES[preflightStatus]}
              body={error}
              secondaryAction={canOpenSettings(preflightStatus) ? 'Open Settings' : undefined}
              onSecondaryAction={canOpenSettings(preflightStatus) ? openSettings : undefined}
            />
          ) : !hasDevices ? (
            <EmptyState
              icon={AppIcons.bluetooth}
              title="Ready to scan"
              body="Keep the device in pairing mode, then scan."
            />
          ) : (
            devices.map((device) => (
              <View key={device.remoteId} style={{ marginBottom: AtmosphereTokens.space12 }}>
                <DeviceTile device={device} busy={connecting} onPress={() => selectDevice(device)} />
              </View>
            ))
          )}
        </AtmosphereCard>
      }
      primaryLabel={scanning ? 'Scanning...' : error !== null ? 'Check again' : 'Scan'}
      primaryEnabled={!scanning && !connecting}
      primaryLoading={connecting}
      onPrimary={startScan}
      secondaryLabel="Back"
      onSecondary={() => router.back()}
      onCancel={() => router.back()}
    />
  );
}

function DeviceTile({
  device,
  busy,
  onPress,
}: {
  device: BleDeviceInfo;
  busy: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable onPress={busy ? undefined : onPress}>
      <AtmosphereCard padding={AtmosphereTokens.space16}>
        <View style={styles.tileRow}>
          <View style={[styles.tileIcon, { backgroundColor: c.brandTint }]}>
            <AppIcons.bluetooth size={24} color={c.brand} />
          </View>
          <View style={{ width: AtmosphereTokens.space16 }} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: c.ink, fontSize: 15, fontWeight: '700' }}>{device.name}</Text>
            <View style={{ height: 4 }} />
            <Text style={{ color: c.ink2, fontSize: 12 }}>{device.remoteId}</Text>
          </View>
          <View style={{ width: AtmosphereTokens.space12 }} />
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={{ color: c.brand, fontWeight: '700' }}>{device.rssi} dBm</Text>
            <View style={{ height: 6 }} />
            <Text style={{ color: c.ink2, fontSize: 12 }}>Tap to connect</Text>
          </View>
        </View>
      </AtmosphereCard>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scanningState: { alignItems: 'center', paddingVertical: AtmosphereTokens.space8 },
  tileRow: { flexDirection: 'row', alignItems: 'center' },
  tileIcon: { width: 52, height: 52, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
});
