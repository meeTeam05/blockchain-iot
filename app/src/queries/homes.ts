import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { homeService } from '../services/homeService';
import { Home, Room } from '../models/home';

export const homesQueryKey = ['homes'] as const;
export const roomsQueryKey = (homeId: string) => ['rooms', homeId] as const;

export function useHomes() {
  return useQuery({ queryKey: homesQueryKey, queryFn: () => homeService.getHomes() });
}

export function useCreateHome() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ name, timezone }: { name: string; timezone?: string }) =>
      homeService.createHome(name, timezone),
    onSuccess: (home) => {
      queryClient.setQueryData<Home[]>(homesQueryKey, (prev) => [...(prev ?? []), home]);
    },
  });
}

export function useUpdateHomeName() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      homeService.updateHome(id, { name }),
    onSuccess: (home) => {
      queryClient.setQueryData<Home[]>(homesQueryKey, (prev) =>
        (prev ?? []).map((h) => (h.id === home.id ? home : h)),
      );
    },
  });
}

export function useDeleteHome() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => homeService.deleteHome(id),
    onSuccess: (_result, id) => {
      queryClient.setQueryData<Home[]>(homesQueryKey, (prev) =>
        (prev ?? []).filter((h) => h.id !== id),
      );
    },
  });
}

export function useRooms(homeId: string) {
  return useQuery({
    queryKey: roomsQueryKey(homeId),
    queryFn: () => homeService.getRooms(homeId),
    enabled: homeId.length > 0,
  });
}

export function useCreateRoom(homeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => homeService.createRoom(homeId, name),
    onSuccess: (room) => {
      queryClient.setQueryData<Room[]>(roomsQueryKey(homeId), (prev) => [...(prev ?? []), room]);
    },
  });
}

export function useUpdateRoom(homeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ roomId, name }: { roomId: string; name: string }) =>
      homeService.updateRoom(roomId, { name }),
    onSuccess: (room) => {
      queryClient.setQueryData<Room[]>(roomsQueryKey(homeId), (prev) =>
        (prev ?? []).map((r) => (r.id === room.id ? room : r)),
      );
    },
  });
}

export function useDeleteRoom(homeId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (roomId: string) => homeService.deleteRoom(roomId),
    onSuccess: (_result, roomId) => {
      queryClient.setQueryData<Room[]>(roomsQueryKey(homeId), (prev) =>
        (prev ?? []).filter((r) => r.id !== roomId),
      );
    },
  });
}

export function useInviteMember(homeId: string) {
  return useMutation({
    mutationFn: ({ email, role }: { email: string; role?: string }) =>
      homeService.inviteMember(homeId, email, role),
  });
}
