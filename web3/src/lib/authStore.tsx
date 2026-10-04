import { createContext, useContext, useState, type ReactNode } from 'react'
import { apiBaseUrl } from '../config/networks'
import {
  AuthRequester,
  loginWithPassword,
  registerUser,
  type AuthSession,
  type RegisteredUser,
} from './authClient'

const STORAGE_KEY = 'smartair-web3-auth'

interface AuthState {
  accessToken?: string
  user?: AuthSession['user']
  login(email: string, password: string): Promise<void>
  register(email: string, password: string, fullName?: string): Promise<RegisteredUser>
  logout(): Promise<void>
  request(path: string, init?: RequestInit): Promise<Response>
  requestPublic(path: string, init?: RequestInit): Promise<Response>
}

const AuthContext = createContext<AuthState | null>(null)

function readStored(): AuthSession | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<AuthSession>
    if (
      typeof value.accessToken !== 'string' ||
      typeof value.refreshToken !== 'string' ||
      !value.user ||
      typeof value.user.id !== 'string'
    ) {
      sessionStorage.removeItem(STORAGE_KEY)
      return null
    }
    return value as AuthSession
  } catch {
    sessionStorage.removeItem(STORAGE_KEY)
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<AuthSession | null>(() => readStored())

  function setSession(next: AuthSession) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    setSessionState(next)
  }

  function clearSession() {
    sessionStorage.removeItem(STORAGE_KEY)
    setSessionState(null)
  }

  const [requester] = useState(() =>
    new AuthRequester({
      baseUrl: apiBaseUrl,
      getSession: () => session,
      setSession,
      clearSession,
    }),
  )

  async function login(email: string, password: string) {
    requester.replaceSession(await loginWithPassword(apiBaseUrl, email, password))
  }

  async function register(email: string, password: string, fullName?: string) {
    return await registerUser(apiBaseUrl, email, password, fullName)
  }

  async function logout() {
    try {
      if (requester.hasSession()) {
        await requester.request('/auth/logout', { method: 'POST' })
      }
    } catch {
      // Local logout is unconditional even if the API/network is unavailable.
    } finally {
      requester.clearSession()
    }
  }

  return (
    <AuthContext.Provider
      value={{
        accessToken: session?.accessToken,
        user: session?.user,
        login,
        register,
        logout,
        request: (path, init) => requester.request(path, init),
        requestPublic: (path, init) => requester.requestPublic(path, init),
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside AuthProvider')
  return context
}
