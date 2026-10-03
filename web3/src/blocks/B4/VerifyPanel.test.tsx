import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hex } from 'viem'
import { activeNetwork } from '../../config/networks'
import { computeEvidenceHash, type EvidenceRecord } from '../../lib/evidence'
import { computeIncidentAttestationDigest, recoverIncidentSigner } from '../../lib/incidentSignature'
import type { ApiIncidentDetail } from '../../lib/incidentsApi'
import { VerifyPanel } from './VerifyPanel'
import { VerifyPage } from '../../pages/VerifyPage'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const vector = JSON.parse(readFileSync(path.resolve(HERE, '../../../../docs/test-vectors/incident-v2-qcvn-exceeded.json'), 'utf8'))
const evidence = vector.evidence as EvidenceRecord
const deviceId = vector.transport.device_id as string
const incidentId = evidence.incident_id as string
const localHash = computeEvidenceHash(evidence)
const incident = { evidence, signature: vector.expected.signature, eip712_digest: '0x', signer_address: '0x' } as unknown as ApiIncidentDetail

const mocks = vi.hoisted(() => ({ reads: {} as Record<string, { data?: unknown; isPending: boolean; isError: boolean }>,
  domain: 'correct', detail: {} as { data?: unknown; isPending: boolean; isError: boolean; error?: Error } }))
vi.mock('wagmi', () => ({
  useReadContract: ({ functionName }: { functionName: string }) => mocks.reads[functionName],
  useBlockNumber: () => ({ data: 123n }),
}))
vi.mock('../B0/domainStatus', () => ({ useDomainStatus: () => ({ publicStatus: mocks.domain, walletStatus: 'disconnected' }) }))
vi.mock('../../lib/incidentsApi', async (original) => ({
  ...(await original<typeof import('../../lib/incidentsApi')>()),
  useIncidentDetail: () => mocks.detail,
}))
vi.mock('../B1/SessionActions', () => ({ SessionActions: () => null }))

// The dApp signs against the configured deployment domain, so the signer the
// browser recovers is computed the same way here.
let configuredSigner: Hex
beforeEach(async () => {
  configuredSigner = await recoverIncidentSigner(computeIncidentAttestationDigest({
    name: activeNetwork.name, version: activeNetwork.version, chainId: activeNetwork.chainId, verifyingContract: activeNetwork.address,
  }, evidence, localHash), vector.expected.signature)
  mocks.domain = 'correct'
  mocks.reads = {
    hashEvidence: { data: localHash, isPending: false, isError: false },
    getIncident: { data: { status: 1, evidenceHash: localHash, signer: configuredSigner, incidentId }, isPending: false, isError: false },
  }
  mocks.detail = { data: incident, isPending: false, isError: false }
})

function mount(ui: React.ReactNode, path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter></QueryClientProvider>)
}
const state = () => screen.getByTestId('verify-state').getAttribute('data-state')

describe('VerifyPanel', () => {
  it('shows 4/4 for valid evidence and a historical signer', async () => {
    mount(<VerifyPanel deviceId={deviceId} incident={incident} />)
    await waitFor(() => expect(state()).toBe('ok'))
    expect(screen.getByText('Dữ liệu toàn vẹn')).toBeInTheDocument()
    expect(screen.getByText('4/4 checks · block 123')).toBeInTheDocument()
  })

  it('shows step 3 for invalid evidence and step 4 for a signer mismatch', async () => {
    mocks.reads.getIncident.data = { status: 1, evidenceHash: `0x${'9'.repeat(64)}`, signer: configuredSigner, incidentId }
    const view = mount(<VerifyPanel deviceId={deviceId} incident={incident} />)
    await waitFor(() => expect(state()).toBe('invalid_evidence'))
    mocks.reads.getIncident.data = { status: 1, evidenceHash: localHash, signer: '0x00000000000000000000000000000000000000aa', incidentId }
    view.rerender(<QueryClientProvider client={new QueryClient()}><MemoryRouter><VerifyPanel deviceId={deviceId} incident={incident} /></MemoryRouter></QueryClientProvider>)
    await waitFor(() => expect(state()).toBe('signer_mismatch'))
  })

  it('shows RPC failure, wrong deployment and not-on-chain as their own states', async () => {
    mocks.reads.getIncident = { isPending: false, isError: true }
    const view = mount(<VerifyPanel deviceId={deviceId} incident={incident} />)
    await waitFor(() => expect(state()).toBe('rpc_error'))
    expect(screen.getByRole('alert')).toHaveTextContent('RPC không khả dụng')
    expect(screen.queryByText('Không khớp ở bước 3')).not.toBeInTheDocument()
    view.unmount()
    mocks.reads.getIncident = { data: { status: 0, evidenceHash: `0x${'0'.repeat(64)}`, signer: '0x0000000000000000000000000000000000000000', incidentId }, isPending: false, isError: false }
    const missing = mount(<VerifyPanel deviceId={deviceId} incident={incident} />)
    await waitFor(() => expect(state()).toBe('not_found'))
    missing.unmount()
    mocks.domain = 'domain_mismatch'
    mount(<VerifyPanel deviceId={deviceId} incident={incident} />)
    await waitFor(() => expect(state()).toBe('deployment_unavailable'))
  })

  it('copies the canonical /dapp/verify link of the current origin', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mount(<VerifyPanel deviceId={deviceId} incident={incident} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sao chép link xác minh' }))
    await screen.findByText('Đã sao chép link xác minh.')
    expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/dapp/verify/${encodeURIComponent(deviceId)}/${incidentId}`)
  })

  it('shows the link for manual copy when the clipboard fails', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(async () => { throw new Error('denied') }) }, configurable: true })
    mount(<VerifyPanel deviceId={deviceId} incident={incident} />)
    fireEvent.click(screen.getByRole('button', { name: 'Sao chép link xác minh' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(`/dapp/verify/${encodeURIComponent(deviceId)}/${incidentId}`)
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true })
  })
})

describe('VerifyPage (/verify/:deviceId/:incidentId)', () => {
  const routes = <Routes><Route path="/verify/:deviceId/:incidentId" element={<VerifyPage />} /></Routes>
  const url = `/verify/${encodeURIComponent(deviceId)}/${incidentId}`

  it('renders directly from the URL with the decoded device id and incident id', async () => {
    mount(routes, url)
    expect(screen.getByText('Xác minh sự cố')).toBeInTheDocument()
    expect(screen.getByTestId('verify-target')).toHaveTextContent(`device ${deviceId} · incident ${incidentId}`)
    await waitFor(() => expect(state()).toBe('ok'))
  })

  it('separates API loading, API failure and an invalid incident id', () => {
    mocks.detail = { isPending: true, isError: false }
    const view = mount(routes, url)
    expect(screen.getByText('Đang tải evidence từ API…')).toBeInTheDocument()
    view.unmount()
    mocks.detail = { isPending: false, isError: true, error: new Error('Không tải được sự cố (API lỗi 503)') }
    const failed = mount(routes, url)
    expect(screen.getByRole('alert')).toHaveTextContent('API lỗi 503')
    expect(screen.queryByTestId('verify-state')).not.toBeInTheDocument()
    failed.unmount()
    mount(routes, `/verify/${encodeURIComponent(deviceId)}/not-a-hash`)
    expect(screen.getByRole('alert')).toHaveTextContent('incidentId không hợp lệ')
  })
})
