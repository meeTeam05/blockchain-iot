import { useCallback, useEffect } from 'react';
import { Stack } from 'expo-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useAuthStore } from '@/stores/authStore';
import { queryClient } from '@/api/queryClient';
import { realtimeService } from '@/services/realtimeService';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const status = useAuthStore((s) => s.status);

  const [fontsLoaded, fontError] = useFonts({
    'PlusJakartaSans-Regular': require('../assets/fonts/PlusJakartaSans-Regular.ttf'),
    'PlusJakartaSans-Medium': require('../assets/fonts/PlusJakartaSans-Medium.ttf'),
    'PlusJakartaSans-SemiBold': require('../assets/fonts/PlusJakartaSans-SemiBold.ttf'),
    'PlusJakartaSans-Bold': require('../assets/fonts/PlusJakartaSans-Bold.ttf'),
    'JetBrainsMono-Regular': require('../assets/fonts/JetBrainsMono-Regular.ttf'),
  });

  const onLayoutRootView = useCallback(async () => {
    if ((fontsLoaded || fontError) && status !== 'loading') {
      await SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError, status]);

  useEffect(() => {
    void onLayoutRootView();
  }, [onLayoutRootView]);

  useEffect(() => {
    void useAuthStore.getState().restore();
  }, []);

  useEffect(() => {
    if (status === 'authenticated') {
      realtimeService.start();
    } else {
      realtimeService.stop();
    }
  }, [status]);

  if ((!fontsLoaded && !fontError) || status === 'loading') {
    // Splash screen (native) is still visible via preventAutoHideAsync().
    return null;
  }

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Protected guard={status === 'authenticated'}>
            <Stack.Screen name="(app)" />
            <Stack.Screen name="devices" />
            <Stack.Screen name="homes" />
            <Stack.Screen name="provision" />
          </Stack.Protected>
          <Stack.Protected guard={status !== 'authenticated'}>
            <Stack.Screen name="(auth)" />
          </Stack.Protected>
        </Stack>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
