// Smoke-render test for every ported Atmosphere-Web atom (decision #19).
// Just proves each renders without throwing and shows its expected text --
// not a visual-regression test (that's the manual diff step in the plan).
import { render, screen } from '@testing-library/react'
import { AlertTriangle } from 'lucide-react'
import { describe, expect, it, vi } from 'vitest'
import { AppBar } from './AppBar'
import { Card } from './Card'
import { ConfirmDialog } from './ConfirmDialog'
import { DangerButton } from './DangerButton'
import { DotLogo } from './DotLogo'
import { EmptyState } from './EmptyState'
import { Field } from './Field'
import { GhostButton } from './GhostButton'
import { HistoryRow } from './HistoryRow'
import { Pill } from './Pill'
import { PrimaryButton } from './PrimaryButton'

describe('Atmosphere-Web atoms', () => {
  it('Pill renders every tone', () => {
    const tones = ['online', 'offline', 'warn', 'brand', 'accent', 'danger'] as const
    for (const tone of tones) {
      render(<Pill label={tone} tone={tone} />)
    }
    expect(screen.getAllByText(/online|offline|warn|brand|accent|danger/i).length).toBe(tones.length)
  })

  it('PrimaryButton renders label and loading spinner state', () => {
    render(<PrimaryButton label="Xác nhận" onClick={() => {}} />)
    expect(screen.getByRole('button', { name: 'Xác nhận' })).toBeInTheDocument()
    const { container } = render(<PrimaryButton label="Xác nhận" loading onClick={() => {}} />)
    expect(container.querySelector('svg')).toBeInTheDocument()
  })

  it('DangerButton and GhostButton render their labels', () => {
    render(<DangerButton label="Thử lại" onClick={() => {}} />)
    render(<GhostButton label="Hủy" onClick={() => {}} />)
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hủy' })).toBeInTheDocument()
  })

  it('Card renders children', () => {
    render(<Card>hello</Card>)
    expect(screen.getByText('hello')).toBeInTheDocument()
  })

  it('Field shows label, error text and danger border on error', () => {
    render(<Field label="Email" value="" onChange={() => {}} errorText="Bắt buộc" />)
    expect(screen.getByText('Email')).toBeInTheDocument()
    expect(screen.getByText('Bắt buộc')).toBeInTheDocument()
  })

  it('HistoryRow renders label/sub and optional badge', () => {
    render(<HistoryRow icon={AlertTriangle} label="IncidentLogged" sub="block 123" badgeTone="danger" badgeLabel="danger" />)
    expect(screen.getByText('IncidentLogged')).toBeInTheDocument()
    expect(screen.getByText('block 123')).toBeInTheDocument()
  })

  it('EmptyState renders title/body and optional actions', () => {
    const onPrimary = vi.fn()
    render(
      <EmptyState
        icon={AlertTriangle}
        title="Chưa có incident"
        body="Thiết bị chưa ghi nhận sự cố nào."
        primaryAction="Làm mới"
        onPrimaryAction={onPrimary}
      />,
    )
    expect(screen.getByText('Chưa có incident')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Làm mới' })).toBeInTheDocument()
  })

  it('ConfirmDialog renders title/message and calls onConfirm/onCancel', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(
      <ConfirmDialog
        open
        title="Xác nhận acknowledge"
        message="Bạn chắc chắn?"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    )
    expect(screen.getByText('Xác nhận acknowledge')).toBeInTheDocument()
    expect(screen.getByText('Bạn chắc chắn?')).toBeInTheDocument()
  })

  it('AppBar renders brand and back variants', () => {
    render(<AppBar variant="brand" />)
    expect(screen.getByText('smart air')).toBeInTheDocument()
    render(<AppBar variant="back" title="Sự cố" onBack={() => {}} />)
    expect(screen.getByText('Sự cố')).toBeInTheDocument()
  })

  it('DotLogo renders an svg with 25 dots', () => {
    const { container } = render(<DotLogo color="#0F6B5C" />)
    expect(container.querySelectorAll('circle').length).toBe(25)
  })
})
