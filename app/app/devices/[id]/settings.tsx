import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useColors } from '@/theme/useColors';
import { withAlpha } from '@/theme/color';
import { AppIcons } from '@/theme/icons';
import { AtmosphereTextStyles } from '@/theme/textStyles';
import { AtmosphereTokens } from '@/theme/tokens';
import { AtmosphereAppBar } from '@/components/shell/AtmosphereAppBar';
import { AtmosphereCard } from '@/components/atoms/AtmosphereCard';
import { EmptyState } from '@/components/atoms/EmptyState';
import { DangerButton } from '@/components/atoms/DangerButton';
import { ConfirmDialog } from '@/components/atoms/ConfirmDialog';
import { devicesQueryKey, useDeleteDevice, useDevices } from '@/queries/devices';
import { useRooms } from '@/queries/homes';
import { deviceService } from '@/services/deviceService';
import { useQueryClient } from '@tanstack/react-query';

function Row({
  title,
  value,
  onPress,
  trailing,
  mono = false,
}: {
  title: string;
  value: string;
  onPress?: () => void;
  trailing?: React.ReactNode;
  mono?: boolean;
}) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={AtmosphereTextStyles.body(c.ink2)}>{title}</Text>
        <View style={{ height: 4 }} />
        <Text style={mono ? AtmosphereTextStyles.mono(c.ink) : AtmosphereTextStyles.body(c.ink)}>{value}</Text>
      </View>
      {trailing}
    </Pressable>
  );
}

function Divider() {
  const c = useColors();
  return <View style={{ height: 1, backgroundColor: c.line }} />;
}

export default function GeneralSettingsScreen() {
  const { id: deviceId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const devicesQuery = useDevices();
  const deleteDevice = useDeleteDevice();
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [roomPickerOpen, setRoomPickerOpen] = useState(false);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);

  const device = (devicesQuery.data ?? []).find((d) => d.id === deviceId) ?? null;
  // Called unconditionally (before any early return) per the Rules of Hooks
  // — falls back to an empty homeId (query stays disabled) while loading.
  const roomsQuery = useRooms(device?.homeId ?? '');

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace(`/devices/${deviceId}`);
  }

  if (devicesQuery.isLoading && !devicesQuery.data) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <AtmosphereAppBar variant="back" title="Settings" onBack={goBack} />
        <View style={styles.center}>
          <ActivityIndicator color={c.brand} />
        </View>
      </View>
    );
  }

  if (devicesQuery.isError) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <AtmosphereAppBar variant="back" title="Settings" onBack={goBack} />
        <EmptyState
          icon={AppIcons.warn}
          title="Failed to load device"
          body={devicesQuery.error instanceof Error ? devicesQuery.error.message : 'Unknown error'}
          primaryAction="Retry"
          onPrimaryAction={() => devicesQuery.refetch()}
          secondaryAction="Go home"
          onSecondaryAction={() => router.replace('/home')}
        />
      </View>
    );
  }

  if (!device) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <AtmosphereAppBar variant="back" title="Settings" onBack={goBack} />
        <EmptyState
          icon={AppIcons.device}
          title="Device not found"
          body="This device may have been removed or is no longer available."
          primaryAction="Refresh"
          onPrimaryAction={() => devicesQuery.refetch()}
          secondaryAction="Go home"
          onSecondaryAction={() => router.replace('/home')}
        />
      </View>
    );
  }

  const rooms = roomsQuery.data ?? [];
  const roomLoading = roomsQuery.isLoading && !roomsQuery.data;
  const roomSubtitle = roomLoading
    ? 'Loading rooms...'
    : device.roomId
      ? (rooms.find((r) => r.id === device.roomId)?.name ?? 'Unknown room')
      : 'No room assigned';

  async function saveName() {
    const newName = nameDraft.trim();
    if (!newName) return;
    setEditingName(false);
    try {
      await deviceService.updateDevice(deviceId, { name: newName });
      await queryClient.invalidateQueries({ queryKey: devicesQueryKey });
    } catch (err) {
      Alert.alert('', `Failed to update name: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function updateRoom(roomId: string | null) {
    setRoomPickerOpen(false);
    try {
      await deviceService.updateDevice(deviceId, { roomId });
      await queryClient.invalidateQueries({ queryKey: devicesQueryKey });
    } catch (err) {
      Alert.alert('', `Failed to update room: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function copyDeviceId() {
    await Clipboard.setStringAsync(device!.id);
  }

  async function confirmDelete() {
    setConfirmDeleteOpen(false);
    try {
      await deleteDevice.mutateAsync(device!.id);
      router.replace('/home');
    } catch (err) {
      Alert.alert('', `Failed to delete device: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <AtmosphereAppBar variant="back" title="Settings" onBack={goBack} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: AtmosphereTokens.space20 + insets.bottom }]}
      >
        <Text style={AtmosphereTextStyles.h2(c.ink)}>General</Text>
        <View style={{ height: AtmosphereTokens.space12 }} />
        <AtmosphereCard padding={0}>
          <Row
            title="Device name"
            value={editingName ? nameDraft : device.name}
            trailing={
              <Pressable
                onPress={() => {
                  if (editingName) void saveName();
                  else {
                    setNameDraft(device.name);
                    setEditingName(true);
                  }
                }}
                hitSlop={8}
              >
                {editingName ? (
                  <AppIcons.check size={20} color={c.brand} />
                ) : (
                  <AppIcons.edit size={20} color={c.ink3} />
                )}
              </Pressable>
            }
          />
          <Divider />
          <Row
            title="Device ID"
            value={device.id}
            mono
            trailing={
              <Pressable onPress={copyDeviceId} hitSlop={8}>
                <AppIcons.download size={18} color={c.ink3} />
              </Pressable>
            }
          />
          <Divider />
          <Row
            title="Room"
            value={roomSubtitle}
            onPress={roomLoading ? undefined : () => setRoomPickerOpen(true)}
            trailing={
              roomLoading ? (
                <ActivityIndicator size="small" color={c.brand} />
              ) : (
                <AppIcons.chev size={18} color={c.ink3} />
              )
            }
          />
          <Divider />
          <Row
            title="Firmware version"
            value={device.firmwareVer ?? 'Unknown'}
            mono
            onPress={() => router.push(`/devices/${deviceId}/ota`)}
            trailing={<AppIcons.chev size={18} color={c.ink3} />}
          />
        </AtmosphereCard>

        <View style={{ height: AtmosphereTokens.space32 }} />
        <Text style={AtmosphereTextStyles.h2(c.ink)}>Sensor calibration</Text>
        <View style={{ height: AtmosphereTokens.space12 }} />
        <AtmosphereCard padding={0}>
          <Row
            title="CO sensor"
            value="Calibration recommended"
            onPress={() => router.push(`/devices/${deviceId}/calibrate/co`)}
            trailing={<AppIcons.chev size={18} color={c.ink3} />}
          />
          <Divider />
          <Row
            title="NO₂ sensor"
            value="Calibration recommended"
            onPress={() => router.push(`/devices/${deviceId}/calibrate/no2`)}
            trailing={<AppIcons.chev size={18} color={c.ink3} />}
          />
        </AtmosphereCard>

        <View style={{ height: AtmosphereTokens.space32 }} />
        <Text style={AtmosphereTextStyles.h2(c.danger)}>Danger zone</Text>
        <View style={{ height: AtmosphereTokens.space12 }} />
        <AtmosphereCard>
          <Text style={AtmosphereTextStyles.body(c.ink)}>Delete this device</Text>
          <View style={{ height: AtmosphereTokens.space8 }} />
          <Text style={AtmosphereTextStyles.caption(c.ink3)}>
            This will remove the device from your home. You can re-add it later through provisioning.
          </Text>
          <View style={{ height: AtmosphereTokens.space16 }} />
          <DangerButton label="Delete device" onPress={() => setConfirmDeleteOpen(true)} />
        </AtmosphereCard>
      </ScrollView>

      {roomPickerOpen ? (
        <View style={styles.sheetBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setRoomPickerOpen(false)} />
          <View style={[styles.sheet, { backgroundColor: c.surface }]}>
            <Pressable style={styles.sheetRow} onPress={() => updateRoom(null)}>
              <Text style={AtmosphereTextStyles.body(c.ink)}>No room</Text>
              {device.roomId === null ? <AppIcons.check size={18} color={c.brand} /> : null}
            </Pressable>
            {rooms.map((room) => (
              <Pressable key={room.id} style={styles.sheetRow} onPress={() => updateRoom(room.id)}>
                <Text style={AtmosphereTextStyles.body(c.ink)}>{room.name}</Text>
                {device.roomId === room.id ? <AppIcons.check size={18} color={c.brand} /> : null}
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      <ConfirmDialog
        visible={confirmDeleteOpen}
        title="Delete device?"
        message={`This will permanently remove "${device.name}" from your home. This action cannot be undone.`}
        onCancel={() => setConfirmDeleteOpen(false)}
        onConfirm={confirmDelete}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: AtmosphereTokens.space20 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: AtmosphereTokens.space16,
    paddingVertical: AtmosphereTokens.space12,
  },
  sheetBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
    backgroundColor: withAlpha('#0E1F1B', 0.4),
  },
  sheet: {
    padding: AtmosphereTokens.space20,
    borderTopLeftRadius: AtmosphereTokens.radiusCard,
    borderTopRightRadius: AtmosphereTokens.radiusCard,
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: AtmosphereTokens.space12,
  },
});
