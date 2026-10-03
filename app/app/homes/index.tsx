import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useColors } from '@/theme/useColors';
import { AppColors } from '@/theme/appColors';
import { AppIcons } from '@/theme/icons';
import { AtmosphereTextStyles } from '@/theme/textStyles';
import { AtmosphereAppBar } from '@/components/shell/AtmosphereAppBar';
import { useHomes } from '@/queries/homes';
import { Home } from '@/models/home';

export default function HomesScreen() {
  const c = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data: homes, isLoading, isError, refetch, isRefetching } = useHomes();

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <AtmosphereAppBar
        variant="back"
        title="My Homes"
        onBack={() => router.back()}
        actions={
          <Pressable onPress={() => router.push('/profile')} hitSlop={8}>
            <AppIcons.profile size={20} color={c.textSecondary} />
          </Pressable>
        }
      />

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.brand} />
        </View>
      ) : isError ? (
        <View style={styles.center}>
          <Text style={AtmosphereTextStyles.body(c.danger)}>Failed to load homes</Text>
        </View>
      ) : !homes || homes.length === 0 ? (
        <View style={styles.center}>
          <AppIcons.home size={64} color={c.textSecondary} />
          <View style={{ height: 12 }} />
          <Text style={AtmosphereTextStyles.body(c.textSecondary)}>No homes yet</Text>
          <View style={{ height: 8 }} />
          <Pressable
            onPress={() => router.push('/homes/create')}
            style={[styles.createButton, { backgroundColor: AppColors.primary }]}
          >
            <AppIcons.plus size={18} color="#FFFFFF" />
            <Text style={styles.createButtonLabel}>Create Home</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={homes}
          keyExtractor={(home) => home.id}
          contentContainerStyle={[styles.list, { paddingBottom: 16 + insets.bottom }]}
          onRefresh={refetch}
          refreshing={isRefetching}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          renderItem={({ item }: { item: Home }) => (
            <Pressable
              onPress={() => router.push(`/homes/${item.id}`)}
              style={[styles.row, { backgroundColor: c.surface }]}
            >
              <AppIcons.home size={20} color={AppColors.primary} />
              <View style={styles.rowText}>
                <Text style={AtmosphereTextStyles.body(c.textPrimary)}>{item.name}</Text>
                {item.address ? (
                  <Text style={AtmosphereTextStyles.caption(c.textSecondary)}>
                    {item.address}
                  </Text>
                ) : null}
              </View>
              <AppIcons.chev size={18} color={c.textSecondary} />
            </Pressable>
          )}
        />
      )}

      {homes && homes.length > 0 ? (
        <Pressable
          onPress={() => router.push('/homes/create')}
          style={[styles.fab, { backgroundColor: AppColors.primary, bottom: 20 + insets.bottom }]}
        >
          <AppIcons.plus size={24} color="#FFFFFF" />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { padding: 16 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 12,
    padding: 16,
  },
  rowText: { flex: 1 },
  createButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  createButtonLabel: { color: '#FFFFFF', fontWeight: '600' },
  fab: {
    position: 'absolute',
    right: 20,
    bottom: 20,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
