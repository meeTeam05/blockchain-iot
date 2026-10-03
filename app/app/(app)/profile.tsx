import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useColors } from '@/theme/useColors';
import { withAlpha } from '@/theme/color';
import { AppIcons } from '@/theme/icons';
import { AtmosphereTextStyles } from '@/theme/textStyles';
import { AtmosphereTokens } from '@/theme/tokens';
import { AtmosphereAppBar } from '@/components/shell/AtmosphereAppBar';
import { DangerButton } from '@/components/atoms/DangerButton';
import { ConfirmDialog } from '@/components/atoms/ConfirmDialog';
import { useAuthStore } from '@/stores/authStore';
import { useHomes } from '@/queries/homes';
import { THEME_MODE_LABELS, ThemeModeKey, useThemeModeStore } from '@/theme/themeModeStore';

function getInitial(fullName: string | null, email: string | undefined): string {
  if (fullName && fullName.length > 0) return fullName.charAt(0).toUpperCase();
  if (email && email.length > 0) return email.charAt(0).toUpperCase();
  return '?';
}

function SettingsCard({ children }: { children: React.ReactNode }) {
  const c = useColors();
  return (
    <View style={[styles.card, { backgroundColor: c.paper, borderColor: c.line }]}>{children}</View>
  );
}

function SettingRow({
  icon: Icon,
  label,
  onPress,
  trailing,
}: {
  icon: typeof AppIcons.home;
  label: string;
  onPress?: () => void;
  trailing?: React.ReactNode;
}) {
  const c = useColors();
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={styles.settingRow}>
      <Icon size={20} color={c.ink2} />
      <View style={{ width: AtmosphereTokens.space12 }} />
      <Text style={[AtmosphereTextStyles.body(c.ink), { flex: 1 }]}>{label}</Text>
      {trailing ?? (onPress ? <AppIcons.chev size={16} color={c.ink3} /> : null)}
    </Pressable>
  );
}

function Divider() {
  const c = useColors();
  return <View style={{ height: 1, backgroundColor: c.line }} />;
}

export default function ProfileScreen() {
  const c = useColors();
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const homesQuery = useHomes();
  const themeMode = useThemeModeStore((s) => s.mode);
  const setThemeMode = useThemeModeStore((s) => s.setMode);

  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);

  const homes = homesQuery.data ?? [];

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <AtmosphereAppBar variant="brand" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={AtmosphereTextStyles.pageTitle(c.ink)}>Profile</Text>
        <View style={{ height: AtmosphereTokens.space20 }} />

        <View style={[styles.accountCard, { backgroundColor: c.paper, borderColor: c.line }]}>
          <View style={[styles.avatar, { backgroundColor: c.brandTint }]}>
            <Text style={AtmosphereTextStyles.h1(c.brand)}>{getInitial(user?.fullName ?? null, user?.email)}</Text>
          </View>
          <View style={{ width: AtmosphereTokens.space16 }} />
          <View style={{ flex: 1 }}>
            {user?.fullName ? <Text style={AtmosphereTextStyles.h2(c.ink)}>{user.fullName}</Text> : null}
            <Text style={AtmosphereTextStyles.caption(c.ink2)}>{user?.email ?? ''}</Text>
          </View>
          <Pressable onPress={() => Alert.alert('', 'Profile editing coming soon')} hitSlop={8}>
            <AppIcons.edit size={20} color={c.ink3} />
          </Pressable>
        </View>

        <View style={{ height: AtmosphereTokens.space24 }} />
        <Text style={AtmosphereTextStyles.label(c.ink3)}>HOMES</Text>
        <View style={{ height: AtmosphereTokens.space12 }} />
        {homesQuery.isLoading ? (
          <SettingsCard>
            <View style={styles.loadingRow}>
              <ActivityIndicator color={c.brand} />
            </View>
          </SettingsCard>
        ) : homesQuery.isError ? (
          <SettingsCard>
            <Text style={[AtmosphereTextStyles.caption(c.danger), styles.padded]}>Failed to load homes</Text>
          </SettingsCard>
        ) : (
          <SettingsCard>
            {homes.length === 0 ? (
              <Text style={[AtmosphereTextStyles.caption(c.ink3), styles.padded]}>No homes yet</Text>
            ) : (
              homes.map((home, i) => (
                <View key={home.id}>
                  {i > 0 ? <Divider /> : null}
                  <SettingRow
                    icon={AppIcons.home}
                    label={home.name}
                    onPress={() => router.push(`/homes/${home.id}`)}
                  />
                </View>
              ))
            )}
          </SettingsCard>
        )}

        <View style={{ height: AtmosphereTokens.space24 }} />
        <Text style={AtmosphereTextStyles.label(c.ink3)}>APP SETTINGS</Text>
        <View style={{ height: AtmosphereTokens.space12 }} />
        <SettingsCard>
          <SettingRow
            icon={AppIcons.cloud}
            label="Theme"
            onPress={() => setThemePickerOpen(true)}
            trailing={
              <View style={styles.themeTrailing}>
                <Text style={AtmosphereTextStyles.caption(c.ink2)}>{THEME_MODE_LABELS[themeMode]}</Text>
                <View style={{ width: AtmosphereTokens.space4 }} />
                <AppIcons.chev size={16} color={c.ink3} />
              </View>
            }
          />
          <Divider />
          <SettingRow
            icon={AppIcons.notifications}
            label="Notifications"
            onPress={() => Alert.alert('', 'Notification settings coming soon')}
          />
          <Divider />
          <SettingRow
            icon={AppIcons.info}
            label="About"
            onPress={() =>
              Alert.alert('About', 'Smart Air v0.1.0\n\nIndoor air quality monitor and smart device controller.')
            }
          />
        </SettingsCard>

        <View style={{ height: AtmosphereTokens.space32 }} />
        <DangerButton label="Logout" onPress={() => setLogoutConfirmOpen(true)} />
        <View style={{ height: AtmosphereTokens.space32 }} />
      </ScrollView>

      {themePickerOpen ? (
        <View style={styles.sheetBackdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setThemePickerOpen(false)} />
          <View style={[styles.sheet, { backgroundColor: c.surface }]}>
            {(Object.keys(THEME_MODE_LABELS) as ThemeModeKey[]).map((key) => (
              <Pressable
                key={key}
                style={styles.sheetRow}
                onPress={() => {
                  setThemeMode(key);
                  setThemePickerOpen(false);
                }}
              >
                <Text style={AtmosphereTextStyles.body(c.ink)}>{THEME_MODE_LABELS[key]}</Text>
                {themeMode === key ? <AppIcons.check size={16} color={c.brand} /> : null}
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      <ConfirmDialog
        visible={logoutConfirmOpen}
        title="Logout"
        message="Are you sure you want to log out?"
        confirmLabel="Logout"
        onCancel={() => setLogoutConfirmOpen(false)}
        onConfirm={() => {
          setLogoutConfirmOpen(false);
          void logout();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: AtmosphereTokens.space16 },
  accountCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: AtmosphereTokens.space20,
    borderRadius: AtmosphereTokens.radiusCard,
    borderWidth: 1,
  },
  avatar: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center' },
  card: { borderRadius: AtmosphereTokens.radiusCard, borderWidth: 1 },
  padded: { padding: AtmosphereTokens.space16 },
  loadingRow: { padding: AtmosphereTokens.space16, alignItems: 'center' },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: AtmosphereTokens.space16,
    paddingVertical: AtmosphereTokens.space16,
  },
  themeTrailing: { flexDirection: 'row', alignItems: 'center' },
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
