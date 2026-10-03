import { create } from 'zustand';
import { authService } from '../services/authService';
import { secureStorage } from '../api/client';
import { setAccessToken } from '../api/authInterceptor';
import { useForceLogoutSignal } from '../api/forceLogoutSignal';
import { parseUser, toUserJson, User } from '../models/user';

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'error';

interface AuthState {
  status: AuthStatus;
  user: User | null;
  error: unknown | null;
  /** Restores the session from secure storage. Call once at app startup. */
  restore: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, fullName: string) => Promise<void>;
  logout: () => Promise<void>;
}

type SessionInvalidationHook = () => void;
const sessionInvalidationHooks: SessionInvalidationHook[] = [];

/**
 * Registers a callback to run after logout (explicit or forced by the auth
 * interceptor), so other stores/query caches can drop session-scoped data
 * (devices, homes, realtime events). Mirrors AuthNotifier's
 * `_invalidateSessionProviders` — wired up by those stores as they're built
 * in later phases.
 */
export function onSessionInvalidated(hook: SessionInvalidationHook): void {
  sessionInvalidationHooks.push(hook);
}

function invalidateSessionState(): void {
  for (const hook of sessionInvalidationHooks) hook();
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'loading',
  user: null,
  error: null,

  restore: async () => {
    set({ status: 'loading', error: null });

    // If a refresh token + cached user exist, restore immediately with no
    // network call. AuthInterceptor refreshes the access token on the first
    // API request that gets a 401.
    const refreshToken = await secureStorage.getRefreshToken();
    if (!refreshToken) {
      set({ status: 'unauthenticated', user: null });
      return;
    }

    const userJson = await secureStorage.getUserJson();
    if (!userJson) {
      set({ status: 'unauthenticated', user: null });
      return;
    }

    set({ status: 'authenticated', user: parseUser(userJson) });
  },

  login: async (email, password) => {
    set({ status: 'loading', error: null });
    try {
      const result = await authService.login(email, password);
      setAccessToken(result.accessToken);
      await secureStorage.saveRefreshToken(result.refreshToken);
      await secureStorage.saveUserJson(toUserJson(result.user));
      set({ status: 'authenticated', user: result.user, error: null });
    } catch (err) {
      set({ status: 'error', error: err });
    }
  },

  register: async (email, password, fullName) => {
    set({ status: 'loading', error: null });
    try {
      await authService.register(email, password, fullName);
      // Auto-login after register.
      await get().login(email, password);
    } catch (err) {
      set({ status: 'error', error: err });
    }
  },

  logout: async () => {
    await authService.logout();
    setAccessToken(null);
    await secureStorage.clear();
    set({ status: 'unauthenticated', user: null, error: null });
    invalidateSessionState();
  },
}));

// When the auth interceptor fires a forced logout (401 that couldn't be
// refreshed), clear session state the same way an explicit logout does.
useForceLogoutSignal.subscribe(() => {
  useAuthStore.setState({ status: 'unauthenticated', user: null, error: null });
  invalidateSessionState();
});
