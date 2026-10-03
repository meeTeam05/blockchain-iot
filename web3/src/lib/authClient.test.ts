import { describe, expect, it, vi } from 'vitest'
import {
  AuthRequester,
  loginWithPassword,
  registerUser,
  type AuthSession,
} from './authClient'

const initial: AuthSession = {
  accessToken: 'access-old',
  refreshToken: 'refresh-old',
  user: { id: 'user-1', email: 'owner@example.com', full_name: null },
}

function response(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function requester(fetcher: typeof fetch) {
  let session: AuthSession | null = { ...initial }
  const clear = vi.fn(() => {
    session = null
  })
  const set = vi.fn((next: AuthSession) => {
    session = next
  })
  return {
    client: new AuthRequester({
      baseUrl: 'https://api.example.test/api',
      fetcher,
      getSession: () => session,
      setSession: set,
      clearSession: clear,
    }),
    getSession: () => session,
    clear,
    set,
  }
}

describe('AuthRequester', () => {
  it('binds native fetch to its global receiver for private and public requests', async () => {
    vi.stubGlobal('fetch', function (this: unknown) {
      expect(this).toBe(globalThis)
      return Promise.resolve(response(200, { ok: true }))
    })
    try {
      const client = new AuthRequester({
        baseUrl: 'https://api.example.test/api',
        getSession: () => initial,
        setSession: vi.fn(),
        clearSession: vi.fn(),
      })
      expect((await client.request('/devices')).status).toBe(200)
      expect((await client.requestPublic('/incentives/params')).status).toBe(200)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('surfaces login failure without creating a session', async () => {
    const fetcher = vi.fn(async () => response(401, { error: 'Invalid credentials' })) as typeof fetch
    await expect(
      loginWithPassword('https://api.example.test/api', 'bad@example.com', 'wrong-pass', fetcher),
    ).rejects.toThrow('Invalid credentials')
  })

  it('refreshes an expired access token, rotates refresh token, then retries once', async () => {
    const fetcher = vi.fn(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/auth/refresh')) {
        expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: 'refresh-old' })
        return response(200, { accessToken: 'access-new', refreshToken: 'refresh-new' })
      }
      return new Headers(init?.headers).get('Authorization') === 'Bearer access-new'
        ? response(200, { ok: true })
        : response(401, { error: 'expired' })
    }) as typeof fetch
    const state = requester(fetcher)
    expect((await state.client.request('/devices')).status).toBe(200)
    expect(state.getSession()).toMatchObject({ accessToken: 'access-new', refreshToken: 'refresh-new' })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('single-flights parallel 401 refreshes', async () => {
    let refreshCalls = 0
    let releaseRefresh: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    const fetcher = vi.fn(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/auth/refresh')) {
        refreshCalls += 1
        await gate
        return response(200, { accessToken: 'access-new', refreshToken: 'refresh-new' })
      }
      return new Headers(init?.headers).get('Authorization') === 'Bearer access-new'
        ? response(200, { ok: true })
        : response(401, { error: 'expired' })
    }) as typeof fetch
    const state = requester(fetcher)
    const first = state.client.request('/devices')
    const second = state.client.request('/devices/device-1/incidents')
    await vi.waitFor(() => expect(refreshCalls).toBe(1))
    releaseRefresh?.()
    expect((await Promise.all([first, second])).map(({ status }) => status)).toEqual([200, 200])
    expect(refreshCalls).toBe(1)
  })

  it('clears the session when refresh fails', async () => {
    const fetcher = vi.fn(async (input) =>
      String(input).endsWith('/auth/refresh')
        ? response(401, { error: 'invalid refresh' })
        : response(401, { error: 'expired' }),
    ) as typeof fetch
    const state = requester(fetcher)
    await expect(state.client.request('/devices')).rejects.toThrow('Phiên đăng nhập đã hết hạn')
    expect(state.clear).toHaveBeenCalledOnce()
    expect(state.getSession()).toBeNull()
  })

  it('bounds 401 handling to one refresh and one retry', async () => {
    const fetcher = vi.fn(async (input) =>
      String(input).endsWith('/auth/refresh')
        ? response(200, { accessToken: 'access-new', refreshToken: 'refresh-new' })
        : response(401, { error: 'still unauthorized' }),
    ) as typeof fetch
    const state = requester(fetcher)
    expect((await state.client.request('/devices')).status).toBe(401)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(state.clear).toHaveBeenCalledOnce()
  })

  it('registers a user successfully and returns user details', async () => {
    const fetcher = vi.fn(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        email: 'newuser@example.com',
        password: 'password-123',
        full_name: 'Nguyen Van A',
      })
      return response(201, {
        id: 'user-new',
        email: 'newuser@example.com',
        full_name: 'Nguyen Van A',
        created_at: '2026-10-04T00:00:00Z',
      })
    }) as typeof fetch

    const result = await registerUser(
      'https://api.example.test/api',
      'newuser@example.com',
      'password-123',
      'Nguyen Van A',
      fetcher,
    )
    expect(result.id).toBe('user-new')
    expect(result.email).toBe('newuser@example.com')
  })

  it('rejects duplicate email with 409 friendly message', async () => {
    const fetcher = vi.fn(async () =>
      response(409, { error: 'Email already registered' }),
    ) as typeof fetch

    await expect(
      registerUser(
        'https://api.example.test/api',
        'existing@example.com',
        'password-123',
        undefined,
        fetcher,
      ),
    ).rejects.toThrow('Email này đã được đăng ký trong hệ thống')
  })
})
