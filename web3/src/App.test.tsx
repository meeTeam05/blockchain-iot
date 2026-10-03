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

    expect(await screen.findByText('Đang tải…')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Kết nối ví' })).toBeInTheDocument()
    expect(window.location.pathname).toBe(directPath)
  })

  it('opens the standalone verify route directly (new tab / reload) with the decoded ids', async () => {
    sessionStorage.setItem('smartair-web3-auth', JSON.stringify({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      user: { id: 'user-1', email: 'owner@example.com', full_name: null },
    }))
    const incidentId = `0x${'34'.repeat(32)}`
    const directPath = `/dapp/verify/${encodeURIComponent('dc:b4:d9:13:ed:8c')}/${incidentId}`
    window.history.replaceState({}, '', directPath)
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      requested.push(String(input))
      return new Promise<Response>(() => {})
    }))

    render(<App />)
    expect(await screen.findByText('Xác minh sự cố')).toBeInTheDocument()
    expect(screen.getByTestId('verify-target')).toHaveTextContent(`device dc:b4:d9:13:ed:8c · incident ${incidentId}`)
    expect(screen.getByText('Đang tải evidence từ API…')).toBeInTheDocument()
    await waitFor(() => expect(requested.some((url) => url.endsWith(`/devices/dc%3Ab4%3Ad9%3A13%3Aed%3A8c/incidents/${incidentId}`))).toBe(true))
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

  it('supports toggling to registration form and returns to login upon successful registration', async () => {
    let registerBody: Record<string, unknown> | null = null
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      if (String(input).endsWith('/auth/register')) {
        registerBody = JSON.parse(String(init?.body))
        return new Response(JSON.stringify({
          id: 'user-new',
          email: registerBody?.email,
          full_name: registerBody?.full_name,
          created_at: '2026-10-04T00:00:00Z',
        }), { status: 201, headers: { 'Content-Type': 'application/json' } })
      }
      return new Promise<Response>(() => {})
    }))

    render(<App />)
    // Switch to register mode
    fireEvent.click(screen.getByRole('button', { name: 'Đăng ký ngay' }))

    expect(await screen.findByLabelText('Họ và tên')).toBeInTheDocument()
    expect(screen.getByLabelText('Xác nhận mật khẩu')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Đăng ký tài khoản' })).toBeInTheDocument()

    // Fill registration fields
    fireEvent.change(screen.getByLabelText('Họ và tên'), { target: { value: 'Tran Van B' } })
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'tranb@example.com' } })
    fireEvent.change(screen.getByLabelText('Mật khẩu'), { target: { value: 'password123' } })
    fireEvent.change(screen.getByLabelText('Xác nhận mật khẩu'), { target: { value: 'password123' } })

    fireEvent.click(screen.getByRole('button', { name: 'Đăng ký tài khoản' }))

    // Expect to switch back to login mode with success notification and prefilled email
    expect(await screen.findByText('Đăng ký tài khoản thành công! Vui lòng nhập mật khẩu để đăng nhập.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Đăng nhập' })).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveValue('tranb@example.com')
    expect(registerBody).toEqual({
      email: 'tranb@example.com',
      password: 'password123',
      full_name: 'Tran Van B',
    })
  })
})
