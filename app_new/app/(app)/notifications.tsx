import { ActivityIndicator, FlatList, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/theme/useColors';
import { AppIcons } from '@/theme/icons';
import { AtmosphereTextStyles } from '@/theme/textStyles';
import { AtmosphereTokens } from '@/theme/tokens';
import { AtmosphereAppBar } from '@/components/shell/AtmosphereAppBar';
import { EmptyState } from '@/components/atoms/EmptyState';
import { useNotifications } from '@/queries/notifications';
import { NotificationItem } from '@/models/notification';
import { AtmospherePalette } from '@/theme/palette';
import { ApiConfig } from '@/config/env';

const ICON_BY_TYPE: Record<string, typeof AppIcons.check> = {
  'device.online': AppIcons.check,
  'command.done': AppIcons.check,
  'ota.rebooting': AppIcons.check,
  'device.offline': AppIcons.warn,
  'command.timeout': AppIcons.warn,
  'ota.failed': AppIcons.close,
  'command.error': AppIcons.close,
  'incident.warning': AppIcons.warn,
  'incident.danger': AppIcons.warn,
};

// Deep link to the Task 5 dApp (decisions #3/#12,
// tmp/02_decisions/2026-10-01_task5-dapp-incident-decisions.md): always use
// metamask.app.link, no canOpenURL pre-check -- the universal link itself
// sends the user to install MetaMask when it isn't present.
const DAPP_HOST = new URL(ApiConfig.defaultApiBaseUrl).host;

function chainLink(deviceId: string, incidentId: string): string {
  return `https://metamask.app.link/dapp/${DAPP_HOST}/d/${deviceId}/i/${incidentId}`;
}

function accentBackground(severity: string, c: AtmospherePalette): string {
  switch (severity) {
    case 'success':
      return c.brandTint;
    case 'warning':
      return c.warnTint;
    case 'danger':
      return c.dangerTint;
    default:
      return c.line2;
  }
}

function accentColor(severity: string, c: AtmospherePalette): string {
  switch (severity) {
    case 'success':
      return c.mint;
    case 'warning':
      return c.warn;
    case 'danger':
      return c.danger;
    default:
      return c.ink2;
  }
}

function formatTime(date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${date.getDate()}/${date.getMonth() + 1} ${hh}:${mm}`;
}

function NotificationTile({ item }: { item: NotificationItem }) {
  const c = useColors();
  const router = useRouter();
  const Icon = ICON_BY_TYPE[item.type] ?? AppIcons.notifications;
  const incidentId = item.type.startsWith('incident.') && typeof item.payload.incident_id === 'string'
    ? item.payload.incident_id
    : null;

  return (
    <Pressable
      onPress={() => router.push(`/devices/${item.deviceId}`)}
      style={[styles.tile, { backgroundColor: c.paper, borderColor: c.line }]}
    >
      <View style={[styles.tileIcon, { backgroundColor: accentBackground(item.severity, c) }]}>
        <Icon size={20} color={accentColor(item.severity, c)} />
      </View>
      <View style={{ width: AtmosphereTokens.space12 }} />
      <View style={{ flex: 1 }}>
        <Text style={AtmosphereTextStyles.body(c.ink)}>{item.title}</Text>
        <View style={{ height: AtmosphereTokens.space6 }} />
        <Text style={AtmosphereTextStyles.caption(c.ink2)}>{item.body}</Text>
        <View style={{ height: AtmosphereTokens.space8 }} />
        <View style={styles.tileFooterRow}>
          <Text style={[AtmosphereTextStyles.caption(c.ink), { flex: 1 }]} numberOfLines={1}>
            {item.deviceName}
          </Text>
          <Text style={AtmosphereTextStyles.caption(c.ink3)}>{formatTime(item.occurredAt)}</Text>
        </View>
        {incidentId ? (
          <>
            <View style={{ height: AtmosphereTokens.space8 }} />
            <Pressable onPress={() => Linking.openURL(chainLink(item.deviceId, incidentId))}>
              <Text style={AtmosphereTextStyles.caption(c.brand)}>Xem trên chain</Text>
            </Pressable>
          </>
        ) : null}
      </View>
    </Pressable>
  );
}

export default function NotificationsScreen() {
  const c = useColors();
  const router = useRouter();
  const notificationsQuery = useNotifications();

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <AtmosphereAppBar variant="brand" />
      <View style={styles.headerBlock}>
        <Text style={AtmosphereTextStyles.pageTitle(c.ink)}>Notifications</Text>
      </View>

      {notificationsQuery.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.brand} />
        </View>
      ) : notificationsQuery.isError ? (
        <EmptyState
          icon={AppIcons.warn}
          title="Failed to load notifications"
          body={notificationsQuery.error instanceof Error ? notificationsQuery.error.message : 'Unknown error'}
          primaryAction="Retry"
          onPrimaryAction={() => notificationsQuery.refetch()}
        />
      ) : (notificationsQuery.data ?? []).length === 0 ? (
        <EmptyState
          icon={AppIcons.notifications}
          title="No notifications yet"
          body="Important device events will appear here when devices go offline, finish commands, or complete OTA updates."
          primaryAction="Open devices"
          onPrimaryAction={() => router.push('/home')}
        />
      ) : (
        <FlatList
          data={notificationsQuery.data}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          onRefresh={notificationsQuery.refetch}
          refreshing={notificationsQuery.isRefetching}
          ItemSeparatorComponent={() => <View style={{ height: AtmosphereTokens.space12 }} />}
          renderItem={({ item }) => <NotificationTile item={item} />}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  headerBlock: {
    paddingHorizontal: AtmosphereTokens.space16,
    paddingTop: AtmosphereTokens.space20,
    paddingBottom: AtmosphereTokens.space12,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { paddingHorizontal: AtmosphereTokens.space16, paddingBottom: AtmosphereTokens.space24 },
  tile: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: AtmosphereTokens.space16,
    borderRadius: AtmosphereTokens.radiusCard,
    borderWidth: 1,
  },
  tileIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  tileFooterRow: { flexDirection: 'row', alignItems: 'center' },
});
