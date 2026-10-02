// Integration-level smoke test: mounts the REAL provider tree (Wagmi +
// react-query + Auth + DomainStatus), not just isolated atoms. This is the
// closest thing to "open it in a browser" available without a connected
// browser-automation tool in this environment -- it would catch provider
// ordering bugs, hook-outside-provider errors, and render-time crashes.
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('App', () => {
  it('mounts the full provider tree and shows the login form when logged out', async () => {
    render(<App />)
    expect(screen.getByText('smart air')).toBeInTheDocument()
    expect(await screen.findByLabelText('Email')).toBeInTheDocument()
    expect(screen.getByLabelText('Mật khẩu')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Đăng nhập' })).toBeInTheDocument()
  })
})
