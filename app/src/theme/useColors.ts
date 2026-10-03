import { useColorScheme } from 'react-native';
import { AtmospherePalette, paletteFor } from './palette';
import { useThemeModeStore } from './themeModeStore';

export function useColors(): AtmospherePalette {
  const systemScheme = useColorScheme();
  const mode = useThemeModeStore((s) => s.mode);
  const resolved = mode === 'system' ? (systemScheme === 'dark' ? 'dark' : 'light') : mode;
  return paletteFor(resolved);
}
