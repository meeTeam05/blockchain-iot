import { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useColors } from '@/theme/useColors';
import { withAlpha } from '@/theme/color';
import { AppIcons } from '@/theme/icons';
import { AtmosphereTextStyles } from '@/theme/textStyles';
import { AtmosphereTokens } from '@/theme/tokens';
import { AtmosphereAppBar } from '@/components/shell/AtmosphereAppBar';
import { EmptyState } from '@/components/atoms/EmptyState';
import { FilterChip } from '@/components/atoms/FilterChip';
import { HistoryRow } from '@/components/atoms/HistoryRow';
import { PillTone } from '@/components/atoms/Pill';
import { useCommands } from '@/queries/commands';
import { Command } from '@/models/command';

type CommandFilter = 'all' | 'done' | 'failed' | 'pending';

const FILTERS: { key: CommandFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'done', label: 'Done' },
  { key: 'failed', label: 'Failed' },
  { key: 'pending', label: 'Pending' },
];

function filterCommands(commands: Command[], filter: CommandFilter): Command[] {
  switch (filter) {
    case 'all':
      return commands;
    case 'done':
      return commands.filter((c) => c.status === 'done');
    case 'failed':
      return commands.filter((c) => c.status === 'error' || c.status === 'timeout');
    case 'pending':
      return commands.filter((c) => c.status === 'pending' || c.status === 'sent');
  }
}

function formatCommand(command: Command): { icon: typeof AppIcons.bolt; label: string } {
  const type = typeof command.payload.type === 'string' ? command.payload.type : 'unknown';
  switch (type) {
    case 'device_mode':
      return { icon: AppIcons.bolt, label: `Mode: ${command.payload.mode ?? '?'}` };
    case 'relay_set':
      return {
        icon: AppIcons.wind,
        label: `Relay ${command.payload.relay ?? '?'}: ${command.payload.state === true ? 'ON' : 'OFF'}`,
      };
    case 'calibrate_co':
      return { icon: AppIcons.cog, label: 'Calibrate CO sensor' };
    case 'calibrate_no2':
      return { icon: AppIcons.cog, label: 'Calibrate NO₂ sensor' };
    case 'ai_set':
      return { icon: AppIcons.ai, label: `AI: ${command.payload.state === true ? 'ON' : 'OFF'}` };
    default:
      return { icon: AppIcons.device, label: type };
  }
}

function statusBadge(status: string): { tone: PillTone; label: string } {
  switch (status) {
    case 'done':
      return { tone: 'online', label: 'Done' };
    case 'sent':
      return { tone: 'brand', label: 'Sent' };
    case 'error':
      return { tone: 'danger', label: 'Error' };
    case 'timeout':
      return { tone: 'warn', label: 'Timeout' };
    default:
      return { tone: 'accent', label: 'Pending' };
  }
}

function formatTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${date.getDate()}/${date.getMonth() + 1} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export default function CommandHistoryScreen() {
  const { id: deviceId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const commandsQuery = useCommands(deviceId);
  const [filter, setFilter] = useState<CommandFilter>('all');
  const [payloadSheet, setPayloadSheet] = useState<Command | null>(null);

  const filtered = useMemo(
    () => filterCommands(commandsQuery.data ?? [], filter),
    [commandsQuery.data, filter],
  );

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <AtmosphereAppBar
        variant="back"
        title="Command history"
        onBack={() => (router.canGoBack() ? router.back() : router.replace(`/devices/${deviceId}`))}
      />
      <View style={{ height: AtmosphereTokens.space16 }} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
        {FILTERS.map((f) => (
          <View key={f.key} style={{ marginRight: AtmosphereTokens.space8 }}>
            <FilterChip label={f.label} active={filter === f.key} onPress={() => setFilter(f.key)} />
          </View>
        ))}
      </ScrollView>
      <View style={{ height: AtmosphereTokens.space16 }} />

      {commandsQuery.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.brand} />
        </View>
      ) : commandsQuery.isError ? (
        <EmptyState
          icon={AppIcons.warn}
          title="Failed to load commands"
          body={commandsQuery.error instanceof Error ? commandsQuery.error.message : 'Unknown error'}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={AppIcons.chart}
          title="No commands yet"
          body="Command history will appear here once you interact with the device."
        />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(command) => command.id}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom }]}
          onRefresh={commandsQuery.refetch}
          refreshing={commandsQuery.isRefetching}
          renderItem={({ item }) => {
            const { icon, label } = formatCommand(item);
            const badge = statusBadge(item.status);
            return (
              <Pressable onPress={() => setPayloadSheet(item)}>
                <HistoryRow
                  icon={icon}
                  label={label}
                  sub={formatTime(item.createdAt)}
                  badgeTone={badge.tone}
                  badgeLabel={badge.label}
                />
              </Pressable>
            );
          }}
        />
      )}

      {payloadSheet ? (
        <View style={styles.sheetBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setPayloadSheet(null)} />
          <View style={[styles.sheet, { backgroundColor: c.paper }]}>
            <Text style={AtmosphereTextStyles.h2(c.ink)}>Command payload</Text>
            <View style={{ height: AtmosphereTokens.space16 }} />
            <View style={[styles.payloadBox, { backgroundColor: c.line2 }]}>
              <Text style={AtmosphereTextStyles.mono(c.ink2)}>
                {Object.entries(payloadSheet.payload)
                  .map(([key, value]) => `${key}: ${String(value)}`)
                  .join('\n')}
              </Text>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  filters: { paddingHorizontal: AtmosphereTokens.space16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { paddingHorizontal: AtmosphereTokens.space16 },
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
    padding: AtmosphereTokens.space24,
    borderTopLeftRadius: AtmosphereTokens.radiusCard,
    borderTopRightRadius: AtmosphereTokens.radiusCard,
  },
  payloadBox: {
    padding: AtmosphereTokens.space12,
    borderRadius: AtmosphereTokens.radiusInput,
  },
});
