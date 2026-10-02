export interface AuthUser {
  id: string
  email: string
  full_name: string | null
}

export interface AuthSession {
  accessToken: string
  refreshToken: string
  user: AuthUser
}

interface AuthRequesterOptions {
  baseUrl: string
  fetcher?: typeof fetch
  getSession: () => AuthSession | null
  setSession: (session: AuthSession) => void
  clearSession: () => void
}

export class SessionExpiredError extends Error {
  constructor() {
    super('Phiên đăng nhập đã hết hạn')
    this.name = 'SessionExpiredError'
  }
}

function withAccessToken(init: RequestInit, accessToken: string): RequestInit {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${accessToken}`)
  return { ...init, headers }
}

export class AuthRequester {
  private readonly fetcher: typeof fetch
  private readonly options: AuthRequesterOptions
  private currentSession: AuthSession | null
  private refreshFlight: Promise<AuthSession> | null = null

  constructor(options: AuthRequesterOptions) {
    this.options = options
    this.fetcher = options.fetcher ?? fetch
    this.currentSession = options.getSession()
  }

  hasSession() {
    return this.currentSession !== null
  }

  replaceSession(session: AuthSession) {
    this.currentSession = session
    this.options.setSession(session)
  }

  clearSession() {
    this.currentSession = null
    this.options.clearSession()
  }

  private async refresh(): Promise<AuthSession> {
    if (this.refreshFlight) return this.refreshFlight
    this.refreshFlight = (async () => {
      const current = this.currentSession
      if (!current?.refreshToken) throw new SessionExpiredError()
      const response = await this.fetcher(`${this.options.baseUrl}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
      })
      const body = await response.json().catch(() => null) as {
        accessToken?: unknown
        refreshToken?: unknown
      } | null
      if (
        !response.ok ||
        typeof body?.accessToken !== 'string' ||
        typeof body.refreshToken !== 'string'
      ) {
        throw new SessionExpiredError()
      }
      const rotated = {
        ...current,
        accessToken: body.accessToken,
        refreshToken: body.refreshToken,
      }
      this.replaceSession(rotated)
      return rotated
    })()

    try {
      return await this.refreshFlight
    } catch (error) {
      this.clearSession()
      throw error
    } finally {
      this.refreshFlight = null
    }
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const session = this.currentSession
    if (!session) throw new SessionExpiredError()
    const accessUsed = session.accessToken
    let response = await this.fetcher(
      `${this.options.baseUrl}${path}`,
      withAccessToken(init, accessUsed),
    )
    if (response.status !== 401) return response

    // Another concurrent request may already have completed the single-flight
    // refresh. Reuse its rotated access token instead of rotating twice.
    const latest = this.currentSession
    const refreshed = latest && latest.accessToken !== accessUsed
      ? latest
      : await this.refresh()
    response = await this.fetcher(
      `${this.options.baseUrl}${path}`,
      withAccessToken(init, refreshed.accessToken),
    )
    if (response.status === 401) this.clearSession()
    return response
  }
}

export async function loginWithPassword(
  baseUrl: string,
  email: string,
  password: string,
  fetcher: typeof fetch = fetch,
): Promise<AuthSession> {
  const response = await fetcher(`${baseUrl}/auth/login`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const body = await response.json().catch(() => null) as Partial<AuthSession> & { error?: string } | null
  if (!response.ok) throw new Error(body?.error ?? 'Đăng nhập thất bại')
  if (
    typeof body?.accessToken !== 'string' ||
    typeof body.refreshToken !== 'string' ||
    !body.user ||
    typeof body.user.id !== 'string'
  ) {
    throw new Error('Phản hồi đăng nhập không hợp lệ')
  }
  return body as AuthSession
}
