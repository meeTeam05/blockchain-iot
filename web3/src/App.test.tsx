// Integration-level smoke test: mounts the REAL provider tree (Wagmi +
// react-query + Auth + DomainStatus), not just isolated atoms. This is the
// closest thing to "open it in a browser" available without a connected
// browser-automation tool in this environment -- it would catch provider
// ordering bugs, hook-outside-provider errors, and render-time crashes.
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

describe('App', () => {
  beforeEach(() => {
    sessionStorage.clear()
    window.history.replaceState({}, '', '/dapp/')
    vi.unstubAllGlobals()
  })

  it('mounts the full provider tree and shows the login form when logged out', async () => {
    render(<App />)
    expect(screen.getByText('smart air')).toBeInTheDocument()
    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(screen.getByLabelText('Mật khẩu')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Đăng nhập' })).toBeInTheDocument()
  })

  it('keeps a direct incident URL through login and shows the global wallet action', async () => {
    const incidentId = `0x${'12'.repeat(32)}`
    const directPath = `/dapp/d/device-1/i/${incidentId}`
    window.history.replaceState({}, '', directPath)
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input).endsWith('/auth/login')) {
        return new Response(JSON.stringify({
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          user: { id: 'user-1', email: 'owner@example.com', full_name: null },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Promise<Response>(() => {})
    }))

    render(<App />)
    fireEvent.change(await screen.findByLabelText('Email'), { target: { value: 'owner@example.com' } })
    fireEvent.change(screen.getByLabelText('Mật khẩu'), { target: { value: 'password-123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }))

    expect(await screen.findByText('Sự cố')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Kết nối ví' })).toBeInTheDocument()
    expect(window.location.pathname).toBe(directPath)
  })

  it('exposes logout globally and clears the browser session', async () => {
    sessionStorage.setItem('smartair-web3-auth', JSON.stringify({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      user: { id: 'user-1', email: 'owner@example.com', full_name: null },
    }))
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      if (String(input).endsWith('/auth/logout')) {
        return new Response(JSON.stringify({ success: true }), { status: 200 })
      }
      return new Promise<Response>(() => {})
    }))

    render(<App />)
    fireEvent.click(await screen.findByRole('button', { name: 'Đăng xuất' }))
    await waitFor(() => expect(sessionStorage.getItem('smartair-web3-auth')).toBeNull())
    expect(await screen.findByRole('button', { name: 'Đăng nhập' })).toBeInTheDocument()
  })
})
