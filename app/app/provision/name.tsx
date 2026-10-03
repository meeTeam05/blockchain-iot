import { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useColors } from '@/theme/useColors';
import { withAlpha } from '@/theme/color';
import { AppIcons } from '@/theme/icons';
import { AtmosphereTextStyles } from '@/theme/textStyles';
import { AtmosphereTokens } from '@/theme/tokens';
import { AtmosphereCard } from '@/components/atoms/AtmosphereCard';
import { Field } from '@/components/atoms/Field';
import { BleStepShell } from '@/components/shell/BleStepShell';
import { useHomes, useRooms } from '@/queries/homes';
import { devicesQueryKey } from '@/queries/devices';
import { deviceService } from '@/services/deviceService';

function defaultDeviceName(deviceId: string): string {
  const suffix = deviceId.replace(/[^A-Fa-f0-9]/g, '').toUpperCase();
  const source = suffix || deviceId;
  const len = Math.min(source.length, 6);
  return `Smart Air ${source.slice(source.length - len).toUpperCase()}`;
}

export default function Step5NameScreen() {
  const { homeId, deviceId } = useLocalSearchParams<{
    homeId?: string;
    mac?: string;
    deviceId?: string;
  }>();
  const router = useRouter();
  const c = useColors();
  const queryClient = useQueryClient();

  const hasRequiredRouteState = Boolean(homeId) && Boolean(deviceId);

  const [name, setName] = useState(deviceId ? defaultDeviceName(deviceId) : 'Smart Air');
  const [nameError, setNameError] = useState<string | null>(null);
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);
  const [roomPickerOpen, setRoomPickerOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const homesQuery = useHomes();
  const roomsQuery = useRooms(homeId ?? '');

  const homes = homesQuery.data ?? [];
  const selectedHome = homeId ? (homes.find((h) => h.id === homeId) ?? null) : null;
  const rooms = roomsQuery.data ?? [];

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError('Enter a device name');
      return;
    }
    setNameError(null);
    setSaving(true);
    try {
      await deviceService.updateDevice(deviceId!, {
        name: trimmed,
        ...(selectedRoomId ? { roomId: selectedRoomId } : {}),
      });
      await queryClient.invalidateQueries({ queryKey: devicesQueryKey });
      router.replace(`/devices/${deviceId}`);
    } catch (err) {
      setSaving(false);
      Alert.alert('', err instanceof Error ? err.message : String(err));
    }
  }

  if (!hasRequiredRouteState) {
    return (
      <BleStepShell
        currentStep={4}
        title="Name your device"
        subtitle="Provisioning link is incomplete. Start again before naming device."
        body={
          <AtmosphereCard padding={AtmosphereTokens.space16}>
            <View style={styles.center}>
              <AppIcons.warn size={30} color={c.danger} />
              <View style={{ height: AtmosphereTokens.space16 }} />
              <Text style={[AtmosphereTextStyles.h2(c.ink), styles.centerText]}>
                Missing provisioning details
              </Text>
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

  const homeLabel = selectedHome?.name || (homesQuery.isLoading ? 'Loading home...' : 'Unknown home');
  const roomLabel = roomsQuery.isLoading
    ? 'Loading rooms...'
    : (rooms.find((r) => r.id === selectedRoomId)?.name ?? 'No room');

  return (
    <BleStepShell
      currentStep={4}
      title="Name your device"
      subtitle="Confirm the final label and room before opening the dashboard."
      body={
        <View>
          <AtmosphereCard padding={AtmosphereTokens.space16}>
            <Field label="Device name" value={name} onChangeText={setName} errorText={nameError} />
            <View style={{ height: AtmosphereTokens.space16 }} />
            <Text style={AtmosphereTextStyles.body(c.ink)}>Home</Text>
            <View style={{ height: AtmosphereTokens.space8 }} />
            <View style={[styles.readonlyCard, { backgroundColor: c.paper, borderColor: c.line }]}>
              <Text style={AtmosphereTextStyles.body(c.ink)}>{homeLabel}</Text>
            </View>
            <View style={{ height: AtmosphereTokens.space16 }} />
            <Text style={AtmosphereTextStyles.body(c.ink)}>Room</Text>
            <View style={{ height: AtmosphereTokens.space8 }} />
            <Pressable
              onPress={() => setRoomPickerOpen(true)}
              style={[styles.dropdown, { backgroundColor: c.paper, borderColor: c.line }]}
            >
              <Text style={AtmosphereTextStyles.body(c.ink)}>{roomLabel}</Text>
              <AppIcons.chevDown size={18} color={c.ink3} />
            </Pressable>
            <View style={{ height: AtmosphereTokens.space16 }} />
            <Text style={{ color: c.ink2, fontSize: 13, lineHeight: 20 }}>
              This is the label your household will see in the Home tab and dashboard.
            </Text>
          </AtmosphereCard>

          {roomPickerOpen ? (
            <View style={styles.sheetBackdrop}>
              <Pressable style={StyleSheet.absoluteFill} onPress={() => setRoomPickerOpen(false)} />
              <View style={[styles.sheet, { backgroundColor: c.surface }]}>
                <Text style={AtmosphereTextStyles.h2(c.ink)}>Choose a room</Text>
                <View style={{ height: AtmosphereTokens.space12 }} />
                <Pressable
                  style={styles.sheetRow}
                  onPress={() => {
                    setSelectedRoomId(null);
                    setRoomPickerOpen(false);
                  }}
                >
                  <Text style={AtmosphereTextStyles.body(c.ink)}>No room</Text>
                </Pressable>
                {rooms.map((room) => (
                  <Pressable
                    key={room.id}
                    style={styles.sheetRow}
                    onPress={() => {
                      setSelectedRoomId(room.id);
                      setRoomPickerOpen(false);
                    }}
                  >
                    <Text style={AtmosphereTextStyles.body(c.ink)}>{room.name}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}
        </View>
      }
      primaryLabel={saving ? 'Saving...' : 'Save'}
      primaryLoading={saving}
      primaryEnabled={!saving}
      onPrimary={save}
      secondaryLabel="Back"
      onSecondary={() => router.back()}
      onCancel={() => router.back()}
    />
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center' },
  centerText: { textAlign: 'center' },
  readonlyCard: {
    borderRadius: AtmosphereTokens.radiusInput,
    borderWidth: 1,
    paddingHorizontal: AtmosphereTokens.space12,
    paddingVertical: AtmosphereTokens.space16,
  },
  dropdown: {
    borderRadius: AtmosphereTokens.radiusInput,
    borderWidth: 1,
    paddingHorizontal: AtmosphereTokens.space12,
    paddingVertical: AtmosphereTokens.space16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
    paddingVertical: AtmosphereTokens.space12,
  },
});
