import { QueryClient } from '@tanstack/react-query';
import { onSessionInvalidated } from '../stores/authStore';

export const queryClient = new QueryClient();

// Drop all cached server state (homes, devices, realtime events, ...) on
// logout or forced logout. Mirrors AuthNotifier's
// `_invalidateSessionProviders`.
onSessionInvalidated(() => {
  queryClient.clear();
});
