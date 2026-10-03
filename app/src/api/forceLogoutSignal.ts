import { create } from 'zustand';

interface ForceLogoutSignalState {
  /** Incremented whenever a 401 cannot be recovered by token refresh. The
   * auth store (Phase 2) subscribes to this to clear session state and
   * trigger the router redirect guard. */
  count: number;
  bump: () => void;
}

export const useForceLogoutSignal = create<ForceLogoutSignalState>((set) => ({
  count: 0,
  bump: () => set((s) => ({ count: s.count + 1 })),
}));
