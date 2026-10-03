import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/theme/useColors';
import { AppIcons } from '@/theme/icons';
import { AtmosphereTextStyles } from '@/theme/textStyles';
import { AtmosphereTokens } from '@/theme/tokens';
import { AtmosphereAppBar } from '@/components/shell/AtmosphereAppBar';
import { EmptyState } from '@/components/atoms/EmptyState';
import { DangerButton } from '@/components/atoms/DangerButton';
import { PromptDialog } from '@/components/atoms/PromptDialog';
import { ConfirmDialog } from '@/components/atoms/ConfirmDialog';
import { useAuthStore } from '@/stores/authStore';
import {
  useCreateRoom,
  useDeleteHome,
  useDeleteRoom,
  useHomes,
  useInviteMember,
  useRooms,
  useUpdateHomeName,
  useUpdateRoom,
} from '@/queries/homes';
import { Room } from '@/models/home';

export default function HomeDetailScreen() {
  const { homeId } = useLocalSearchParams<{ homeId: string }>();
  const router = useRouter();
  const c = useColors();
  const insets = useSafeAreaInsets();

  const homesQuery = useHomes();
  const roomsQuery = useRooms(homeId);
  const currentUser = useAuthStore((s) => s.user);

  const updateHomeName = useUpdateHomeName();
  const deleteHome = useDeleteHome();
  const createRoom = useCreateRoom(homeId);
  const updateRoom = useUpdateRoom(homeId);
  const deleteRoom = useDeleteRoom(homeId);
  const inviteMember = useInviteMember(homeId);

  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [invitePromptOpen, setInvitePromptOpen] = useState(false);
  const [addRoomPromptOpen, setAddRoomPromptOpen] = useState(false);
  const [editRoom, setEditRoom] = useState<Room | null>(null);
  const [deleteRoomTarget, setDeleteRoomTarget] = useState<Room | null>(null);
  const [confirmDeleteHomeOpen, setConfirmDeleteHomeOpen] = useState(false);

  const homes = homesQuery.data ?? [];
  const home = homes.find((h) => h.id === homeId) ?? null;

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace('/homes');
  }

  if (homesQuery.isLoading && !home) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <AtmosphereAppBar variant="back" title="Home" onBack={goBack} />
        <View style={styles.center}>
          <ActivityIndicator color={c.brand} />
        </View>
      </View>
    );
  }

  if (!home) {
    return (
      <View style={[styles.screen, { backgroundColor: c.bg }]}>
        <AtmosphereAppBar variant="back" title="Home" onBack={goBack} />
        <EmptyState
          icon={AppIcons.home}
          title="Home not found"
          body={
            homesQuery.isError
              ? 'Failed to load homes'
              : 'This home is no longer available in your current session.'
          }
          secondaryAction="Back"
          onSecondaryAction={goBack}
        />
      </View>
    );
  }

  const isOwner = home.ownerId === currentUser?.id;
  const rooms = roomsQuery.data ?? [];

  return (
    <View style={[styles.screen, { backgroundColor: c.bg }]}>
      <AtmosphereAppBar variant="back" title={home.name} onBack={goBack} />
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: AtmosphereTokens.space16 + insets.bottom }]}
      >
        <Text style={AtmosphereTextStyles.label(c.ink3)}>HOME NAME</Text>
        <View style={{ height: AtmosphereTokens.space12 }} />
        <View style={[styles.card, { backgroundColor: c.paper, borderColor: c.line }]}>
          <View style={styles.row}>
            {editingName ? (
              <TextInput
                value={nameDraft}
                onChangeText={setNameDraft}
                autoFocus
                style={[AtmosphereTextStyles.body(c.ink), styles.nameInput]}
              />
            ) : (
              <Text style={[AtmosphereTextStyles.body(c.ink), styles.nameInput]}>
                {home.name}
              </Text>
            )}
            {isOwner ? (
              <Pressable
                disabled={updateHomeName.isPending}
                onPress={() => {
                  if (editingName) {
                    const trimmed = nameDraft.trim();
                    if (!trimmed) return;
                    updateHomeName.mutate(
                      { id: home.id, name: trimmed },
                      { onSuccess: () => setEditingName(false) },
                    );
                  } else {
                    setNameDraft(home.name);
                    setEditingName(true);
                  }
                }}
                hitSlop={8}
              >
                {editingName ? (
                  <AppIcons.check size={20} color={c.brand} />
                ) : (
                  <AppIcons.edit size={20} color={c.brand} />
                )}
              </Pressable>
            ) : null}
          </View>
        </View>

        <View style={{ height: AtmosphereTokens.space24 }} />
        <View style={styles.sectionHeaderRow}>
          <Text style={AtmosphereTextStyles.label(c.ink3)}>MEMBERS</Text>
          {isOwner ? (
            <Pressable onPress={() => setInvitePromptOpen(true)} style={styles.linkRow}>
              <AppIcons.plus size={16} color={c.brand} />
              <Text style={AtmosphereTextStyles.caption(c.brand)}>Invite</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={{ height: AtmosphereTokens.space12 }} />
        <View style={[styles.card, { backgroundColor: c.paper, borderColor: c.line }]}>
          <MemberRow
            name={currentUser?.email ?? 'Current user'}
            role={isOwner ? 'Owner' : 'Member'}
          />
          <View style={{ height: AtmosphereTokens.space8 }} />
          <Text style={AtmosphereTextStyles.caption(c.ink3)}>
            The current API exposes invite actions, but it does not return a full member list
            yet.
          </Text>
        </View>

        <View style={{ height: AtmosphereTokens.space24 }} />
        <View style={styles.sectionHeaderRow}>
          <Text style={AtmosphereTextStyles.label(c.ink3)}>ROOMS</Text>
          {isOwner ? (
            <Pressable onPress={() => setAddRoomPromptOpen(true)} style={styles.linkRow}>
              <AppIcons.plus size={16} color={c.brand} />
              <Text style={AtmosphereTextStyles.caption(c.brand)}>Add</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={{ height: AtmosphereTokens.space12 }} />
        {roomsQuery.isLoading ? (
          <View style={[styles.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            <ActivityIndicator color={c.brand} />
          </View>
        ) : roomsQuery.isError ? (
          <View style={[styles.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            <Text style={AtmosphereTextStyles.caption(c.danger)}>Failed to load rooms</Text>
          </View>
        ) : (
          <View style={[styles.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            {rooms.length === 0 ? (
              <Text style={AtmosphereTextStyles.caption(c.ink3)}>No rooms yet</Text>
            ) : (
              rooms.map((room, i) => (
                <View key={room.id}>
                  {i > 0 ? <View style={[styles.divider, { backgroundColor: c.line }]} /> : null}
                  <RoomRow
                    name={room.name}
                    canManage={isOwner}
                    onEdit={() => setEditRoom(room)}
                    onDelete={() => setDeleteRoomTarget(room)}
                  />
                </View>
              ))
            )}
          </View>
        )}

        <View style={{ height: AtmosphereTokens.space32 }} />
        <Text style={AtmosphereTextStyles.label(c.danger)}>DANGER ZONE</Text>
        <View style={{ height: AtmosphereTokens.space12 }} />
        {isOwner ? (
          <>
            <DangerButton
              label="Delete home"
              onPress={() => setConfirmDeleteHomeOpen(true)}
            />
            <View style={{ height: AtmosphereTokens.space8 }} />
            <Text style={[AtmosphereTextStyles.caption(c.danger), styles.centerText]}>
              This deletes the home, every device in it, and their associated data.
            </Text>
          </>
        ) : (
          <View style={[styles.card, { backgroundColor: c.paper, borderColor: c.line }]}>
            <Text style={[AtmosphereTextStyles.caption(c.ink3), styles.centerText]}>
              Leaving a home is not exposed by the current API yet.
            </Text>
          </View>
        )}
        <View style={{ height: AtmosphereTokens.space32 }} />
      </ScrollView>

      <PromptDialog
        visible={invitePromptOpen}
        title="Invite member"
        label="Email address"
        onCancel={() => setInvitePromptOpen(false)}
        onSubmit={(email) => {
          setInvitePromptOpen(false);
          inviteMember.mutate({ email });
        }}
      />
      <PromptDialog
        visible={addRoomPromptOpen}
        title="Add room"
        label="Room name"
        onCancel={() => setAddRoomPromptOpen(false)}
        onSubmit={(name) => {
          setAddRoomPromptOpen(false);
          createRoom.mutate(name);
        }}
      />
      <PromptDialog
        visible={editRoom !== null}
        title="Edit room"
        label="Room name"
        initialValue={editRoom?.name ?? ''}
        onCancel={() => setEditRoom(null)}
        onSubmit={(name) => {
          if (editRoom) updateRoom.mutate({ roomId: editRoom.id, name });
          setEditRoom(null);
        }}
      />
      <ConfirmDialog
        visible={deleteRoomTarget !== null}
        title="Delete room"
        message="Devices assigned to this room will remain in the home but lose the room assignment."
        onCancel={() => setDeleteRoomTarget(null)}
        onConfirm={() => {
          if (deleteRoomTarget) deleteRoom.mutate(deleteRoomTarget.id);
          setDeleteRoomTarget(null);
        }}
      />
      <ConfirmDialog
        visible={confirmDeleteHomeOpen}
        title="Delete home"
        message="This will permanently delete this home and all its devices. This action cannot be undone."
        onCancel={() => setConfirmDeleteHomeOpen(false)}
        onConfirm={() => {
          setConfirmDeleteHomeOpen(false);
          deleteHome.mutate(home.id, { onSuccess: () => router.replace('/homes') });
        }}
      />
    </View>
  );
}

function MemberRow({ name, role }: { name: string; role: string }) {
  const c = useColors();
  return (
    <View style={styles.row}>
      <View style={[styles.avatar, { backgroundColor: c.brandTint }]}>
        <Text style={AtmosphereTextStyles.body(c.brand)}>{name.charAt(0).toUpperCase()}</Text>
      </View>
      <View style={{ width: AtmosphereTokens.space12 }} />
      <View style={{ flex: 1 }}>
        <Text style={AtmosphereTextStyles.body(c.ink)}>{name}</Text>
        <Text style={AtmosphereTextStyles.caption(c.ink3)}>{role}</Text>
      </View>
      <View style={[styles.pill, { backgroundColor: c.brandTint }]}>
        <Text style={AtmosphereTextStyles.pill(c.brand)}>You</Text>
      </View>
    </View>
  );
}

function RoomRow({
  name,
  canManage,
  onEdit,
  onDelete,
}: {
  name: string;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const c = useColors();
  return (
    <View style={[styles.row, styles.roomRow]}>
      <AppIcons.home size={20} color={c.ink2} />
      <View style={{ width: AtmosphereTokens.space12 }} />
      <Text style={[AtmosphereTextStyles.body(c.ink), { flex: 1 }]}>{name}</Text>
      {canManage ? (
        <View style={styles.row}>
          <Pressable onPress={onEdit} hitSlop={8}>
            <AppIcons.edit size={16} color={c.ink3} />
          </Pressable>
          <View style={{ width: AtmosphereTokens.space12 }} />
          <Pressable onPress={onDelete} hitSlop={8}>
            <AppIcons.trash size={16} color={c.danger} />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: AtmosphereTokens.space16 },
  card: {
    padding: AtmosphereTokens.space16,
    borderRadius: AtmosphereTokens.radiusCard,
    borderWidth: 1,
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  roomRow: { paddingVertical: AtmosphereTokens.space12 },
  divider: { height: 1 },
  nameInput: { flex: 1 },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pill: {
    paddingHorizontal: AtmosphereTokens.space8,
    paddingVertical: AtmosphereTokens.space4,
    borderRadius: AtmosphereTokens.radiusPill,
  },
  centerText: { textAlign: 'center' },
});
