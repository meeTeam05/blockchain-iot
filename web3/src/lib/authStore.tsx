// B1: API session. JWT kept in memory + sessionStorage (tmp/Web3_task.md
// bước 5.2), same /api/auth the mobile app already uses.
import { createContext, useContext, useState, type ReactNode } from 'react'
import { apiBaseUrl } from '../config/networks'

const STORAGE_KEY = 'smartair-web3-auth'

interface StoredAuth {
  accessToken: string
  user: { id: string; email: string; full_name: string | null }
}

interface AuthState extends Partial<StoredAuth> {
  login(email: string, password: string): Promise<void>
  logout(): void
}

const AuthContext = createContext<AuthState | null>(null)

function readStored(): StoredAuth | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as StoredAuth) : null
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<StoredAuth | null>(() => readStored())

  async function login(email: string, password: string) {
    const res = await fetch(`${apiBaseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const body = await res.json()
    if (!res.ok) throw new Error(body.error ?? 'Đăng nhập thất bại')
    const next: StoredAuth = { accessToken: body.accessToken, user: body.user }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    setAuth(next)
  }

  function logout() {
    sessionStorage.removeItem(STORAGE_KEY)
    setAuth(null)
  }

  return (
    <AuthContext.Provider value={{ accessToken: auth?.accessToken, user: auth?.user, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
