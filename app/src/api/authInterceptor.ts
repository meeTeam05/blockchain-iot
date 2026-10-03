import { AxiosError, AxiosInstance, InternalAxiosRequestConfig, isAxiosError } from 'axios';
import { AuthException, NetworkException } from './appException';
import { useForceLogoutSignal } from './forceLogoutSignal';
import type { SecureStorage } from '../storage/secureStorage';

declare module 'axios' {
  interface AxiosRequestConfig {
    /** Skip the auth interceptor entirely (used by the refresh call itself). */
    skipInterceptor?: boolean;
    /** Marks a request as already retried once after a token refresh. */
    authRetried?: boolean;
  }
}

/** In-memory access token, set by the auth store after login/refresh/restore. */
let accessToken: string | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

function classify(error: unknown): unknown {
  if (isAxiosError(error) && !error.response) {
    // No response reached the client at all: timeout or connectivity loss.
    return new NetworkException();
  }
  return error;
}

/** Wires the access-token header + 401 refresh-and-retry flow onto `client`. */
export function attachAuthInterceptor(client: AxiosInstance, storage: SecureStorage): void {
  let refreshPromise: Promise<string> | null = null;

  async function forceLogout(): Promise<void> {
    setAccessToken(null);
    useForceLogoutSignal.getState().bump();
    await storage.clear();
  }

  async function performRefresh(): Promise<string> {
    const refreshToken = await storage.getRefreshToken();
    if (!refreshToken) {
      await forceLogout();
      throw new AuthException();
    }

    let data: unknown;
    try {
      const res = await client.post(
        '/auth/refresh',
        { refreshToken },
        { skipInterceptor: true },
      );
      data = res.data;
    } catch {
      await forceLogout();
      throw new AuthException();
    }

    if (typeof data !== 'object' || data === null) {
      await forceLogout();
      throw new AuthException();
    }

    const body = data as Record<string, unknown>;
    const newAccess = typeof body.accessToken === 'string' ? body.accessToken : null;
    if (!newAccess) {
      await forceLogout();
      throw new AuthException();
    }

    const newRefresh = typeof body.refreshToken === 'string' ? body.refreshToken : null;
    setAccessToken(newAccess);
    if (newRefresh) {
      await storage.saveRefreshToken(newRefresh);
    }
    return newAccess;
  }

  function refreshAccessToken(): Promise<string> {
    if (refreshPromise) return refreshPromise;
    const inFlight = performRefresh();
    refreshPromise = inFlight;
    inFlight.catch(() => {}).finally(() => {
      if (refreshPromise === inFlight) refreshPromise = null;
    });
    return inFlight;
  }

  client.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    if (config.skipInterceptor) return config;
    if (accessToken) {
      config.headers.set('Authorization', `Bearer ${accessToken}`);
    }
    return config;
  });

  client.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
      const config = error.config;
      const status = error.response?.status;
      const path = config?.url ?? '';
      const isAuthPath = path.includes('/auth/');
      const alreadyRetried = config?.authRetried === true;

      // Only attempt refresh on 401 from non-auth endpoints. Auth endpoints
      // (login, register, refresh) must propagate 401 as-is.
      if (!config || status !== 401 || isAuthPath) {
        throw classify(error);
      }
      if (alreadyRetried) {
        throw new AuthException();
      }

      try {
        const newAccess = await refreshAccessToken();
        config.authRetried = true;
        config.headers.set('Authorization', `Bearer ${newAccess}`);
        return await client.request(config);
      } catch (retryErr) {
        if (retryErr instanceof AuthException) {
          throw retryErr;
        }
        if (isAxiosError(retryErr) && retryErr.response?.status === 401) {
          throw new AuthException();
        }
        throw classify(retryErr);
      }
    },
  );
}
