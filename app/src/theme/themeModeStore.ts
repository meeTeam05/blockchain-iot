import { create } from 'zustand';

export type ThemeModeKey = 'light' | 'dark' | 'system';

interface ThemeModeState {
  /** Default 'light' matches app/lib/app_state.dart's ValueNotifier default. */
  mode: ThemeModeKey;
  setMode: (mode: ThemeModeKey) => void;
}

export const useThemeModeStore = create<ThemeModeState>((set) => ({
  mode: 'light',
  setMode: (mode) => set({ mode }),
}));

export const THEME_MODE_LABELS: Record<ThemeModeKey, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};
