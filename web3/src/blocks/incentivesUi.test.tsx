import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TokenWallet } from './B7/TokenWallet'
import { BondControls } from './B8/BondControls'
import { DeviceIncentives } from './B9/DeviceIncentives'
import { IncidentIncentives } from './B9/IncidentIncentives'
import { KeeperBoard } from './B10/KeeperBoard'
import { IncentiveTxStatus } from './B7/IncentivesShared'
import { incentivesDeployment } from '../lib/incentives'

const mocks = vi.hoisted(() => ({ token: {} as any, canonical: {} as any, settlement: {} as any, guard: {} as any,
  api: {} as any, tx: {} as any }))
vi.mock('../lib/useIncentives', () => ({ useTokenWallet: () => mocks.token,
  useCanonicalDeviceIncentives: () => mocks.canonical, useSettlement: () => mocks.settlement, useIncentivesGuard: () => mocks.guard }))
vi.mock('../lib/incentivesApi', () => ({ useIncentivesApi: () => mocks.api }))
vi.mock('../lib/useIncentiveTransaction', () => ({ useIncentiveTransaction: () => mocks.tx }))
const owner = '0x90f79bf6eb2c4f870365e785982e1f101e93b906'
const key = `0x${'ab'.repeat(32)}` as const
const A = (n: number) => BigInt(n) * 10n ** 18n
const params = { ownerBond: A(100), missedAckPenalty: A(20), dailyRewardCap: 3, unstakeCooldown: 604800n, keeperShareBps: 2500 }
beforeEach(() => {
  mocks.guard = { status: 'ready', canWrite: true, deployment: incentivesDeployment, account: { address: owner, isConnected: true },
    publicClient: { simulateContract: vi.fn(async () => ({ request: {} })), readContract: vi.fn(async ({ functionName }) => functionName === 'params' ? params : functionName === 'getDevice' ? { owner } : { amount: A(100), since: 1n, staker: owner }) } }
  mocks.token = { guard: mocks.guard, isPending: false, isError: false, data: { symbol: 'ASAFE', decimals: 18, balance: A(100), allowance: 0n },
    refetch: vi.fn(async () => ({ isError: false, data: mocks.token.data })) }
  mocks.canonical = { guard: mocks.guard, hash: key, isError: false, isPending: false,
    data: { device: { owner, exists: true }, bond: { amount: A(80), staker: owner, unstakeRequestedAt: 0n }, params, rewardsToday: 2, block: { timestamp: 1900000000n } } }
  mocks.settlement = { guard: mocks.guard, isError: false, isPending: false,
    data: { block: { timestamp: 1900000000n }, settlement: { exists: true, covered: true, deviceIdHash: key, loggedAt: 1899999900n,
      ackDeadline: 1900001700n, flags: 3, relayDelay: 60n, canRecordAck: false, canRecordResolve: false, canSlashMissedAck: false, canSlashLateRelay: false } } }
  mocks.api = { isPending: false, isError: false, data: { contract: incentivesDeployment!.incentives.address,
    bond: { amount: String(A(100)) }, rewards_today: { count: 1 }, totals: { rewarded: String(A(5)), slashed: String(A(20)) }, events: [],
    slash_missed_ack: [], slash_late_relay: [] } }
  mocks.tx = { guard: mocks.guard, run: vi.fn(async () => ({ stage: 'success' })), snapshot: { stage: 'idle', action: null } }
})
function mount(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}
describe('B7/B8 UI', () => {
  it('renders chain balance and allowance, never a false zero on RPC failure', () => {
    const view = mount(<TokenWallet />)
    expect(screen.getByTestId('token-balance')).toHaveTextContent('100 ASAFE')
    expect(screen.getByText('Allowance SafetyIncentives: 0 ASAFE')).toBeInTheDocument()
    mocks.token.isError = true; mocks.token.error = new Error('offline')
    view.rerender(<TokenWallet />)
    expect(screen.getByRole('alert')).toHaveTextContent('RPC token lỗi')
    expect(screen.queryByTestId('token-balance')).not.toBeInTheDocument()
  })
  it('distinguishes loading, missing deployment and disconnected wallet', () => {
    mocks.guard.status = 'unavailable'; mocks.guard.deployment = null; mocks.token.data = undefined
    const view = mount(<TokenWallet />)
    expect(screen.getByText('Token/incentives chưa được deploy trên mạng này.')).toBeInTheDocument()
    mocks.guard.status = 'ready'; mocks.guard.account.isConnected = false; mocks.token.isPending = true
    view.rerender(<TokenWallet />)
    expect(screen.getByText('Kết nối ví để thực hiện giao dịch incentives.')).toBeInTheDocument()
    expect(screen.getByText('Đang đọc token từ chain…')).toBeInTheDocument()
  })
  it('runs exact approve then stake and blocks duplicate clicks', async () => {
    let release!: () => void
    mocks.tx.run.mockImplementationOnce(() => new Promise((done) => { release = () => done({ stage: 'success' }) }))
    mount(<BondControls deviceId="device" />)
    fireEvent.change(screen.getByLabelText('Số lượng ASAFE'), { target: { value: '100' } })
    const button = screen.getByRole('button', { name: 'Approve → Stake' })
    fireEvent.click(button); fireEvent.click(button)
    await waitFor(() => expect(mocks.tx.run).toHaveBeenCalledTimes(1))
    expect(button).toBeDisabled()
    release()
    await waitFor(() => expect(mocks.tx.run).toHaveBeenCalledTimes(2))
    expect(mocks.tx.run.mock.calls).toEqual([['approve', [incentivesDeployment!.incentives.address, A(100)]], ['stakeDevice', [key, A(100)]]])
  })
  it('resumes from stake when allowance is sufficient and handles cancelled approval', async () => {
    mocks.token.data.allowance = A(100)
    const view = mount(<BondControls deviceId="device" />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve → Stake' }))
    await waitFor(() => expect(mocks.tx.run).toHaveBeenCalledWith('stakeDevice', [key, A(100)]))
    view.unmount(); mocks.tx.run.mockClear(); mocks.token.data.allowance = 0n
    mocks.tx.run.mockResolvedValue({ stage: 'cancelled' })
    mount(<BondControls deviceId="device" />)
    fireEvent.click(screen.getByRole('button', { name: 'Approve → Stake' }))
    await waitFor(() => expect(mocks.tx.run).toHaveBeenCalledTimes(1))
    expect(mocks.tx.run.mock.calls[0][0]).toBe('approve')
  })
  it('blocks stake for a nonowner and withdrawal during chain cooldown', () => {
    mocks.canonical.data.device.owner = incentivesDeployment!.token.address
    mocks.canonical.data.bond.unstakeRequestedAt = 1900000000n
    mount(<BondControls deviceId="device" />)
    expect(screen.getByRole('button', { name: 'Approve → Stake' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Withdraw bond' })).toBeDisabled()
    expect(screen.getByText(/604800 giây cooldown/)).toBeInTheDocument()
  })
})
describe('B9/B10 projection vs canonical state', () => {
  it('renders API projection separately and identifies stale indexing without a tx failure', () => {
    mount(<DeviceIncentives deviceId="device" />)
    expect(screen.getByText('Bond canonical: 80 ASAFE')).toBeInTheDocument()
    expect(screen.getByText('API indexed/projection: thưởng 5, phạt owner 20 ASAFE')).toBeInTheDocument()
    expect(screen.getByText(/API đang chậm hoặc chưa index giao dịch/)).toBeInTheDocument()
    expect(screen.queryByText('Giao dịch chưa hoàn tất.')).not.toBeInTheDocument()
  })
  it('shows API and RPC errors instead of unbonded/empty incentives', () => {
    mocks.api.isError = true; mocks.api.error = new Error('API forbidden')
    mocks.canonical.isError = true; mocks.canonical.error = new Error('RPC offline')
    mount(<DeviceIncentives deviceId="device" />)
    expect(screen.getAllByRole('alert')).toHaveLength(2)
    expect(screen.queryByText('Bond canonical: 80 ASAFE')).not.toBeInTheDocument()
  })
  it('renders incident events, keeper, explorer data and pending API sync alongside chain countdown', () => {
    const projection = { incident_key: key, reward_status: 'ack_rewarded', covered: true,
      flags: { timely_ack: false, ack_rewarded: false, resolve_settled: false, ack_slashed: false, relay_slashed: false },
      events: [{ id: '1', name: 'AckRewarded', amount: String(A(5)), account: owner, tx_hash: key, block_number: '42', data: {} }] } as any
    mount(<IncidentIncentives deviceId="device" incidentKey={key} projection={projection} transaction={mocks.tx} />)
    expect(screen.getByTestId('ack-countdown')).toHaveTextContent('28:20')
    expect(screen.getByText('API projection: Đã thưởng ack')).toBeInTheDocument()
    expect(screen.getByText(/API chưa đồng bộ settlement/)).toBeInTheDocument()
    expect(screen.getByText(/AckRewarded 5 ASAFE/)).toBeInTheDocument()
  })
})
describe('keeper UI', () => {
  it('does not expose a submit button for an API candidate settled on chain', () => {
    mocks.api.data.slash_missed_ack = [{ incident_key: key }]
    mount(<KeeperBoard />)
    expect(screen.queryByRole('button', { name: 'Phạt missed ack' })).not.toBeInTheDocument()
  })
  it('shows a canonical 25% bounty and sends exactly one eligible action', async () => {
    mocks.api.data.slash_missed_ack = [{ incident_key: key }]
    mocks.settlement.data.settlement.canSlashMissedAck = true
    mount(<KeeperBoard />)
    await waitFor(() => expect(screen.getByText('Bounty canonical: +5 ASAFE')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('button', { name: 'Phạt missed ack' })).toBeEnabled())
    expect(mocks.guard.publicClient.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'slashMissedAck', args: [key] }))
    fireEvent.click(screen.getByRole('button', { name: 'Phạt missed ack' }))
    expect(mocks.tx.run).toHaveBeenCalledWith('slashMissedAck', [key])
    expect(mocks.tx.run).toHaveBeenCalledOnce()
  })
  it('disables actions for the wrong wallet/network while preserving public overdue data', async () => {
    mocks.guard.canWrite = false
    mocks.api.data.slash_late_relay = [{ incident_key: key }]
    mocks.settlement.data.settlement.canSlashLateRelay = true
    mount(<KeeperBoard />)
    expect(screen.getByRole('button', { name: 'Phạt relay trễ (operator)' })).toBeDisabled()
  })
  it('blocks submission when canonical keeper simulation reverts', async () => {
    mocks.api.data.slash_missed_ack = [{ incident_key: key }]
    mocks.settlement.data.settlement.canSlashMissedAck = true
    mocks.guard.publicClient.simulateContract.mockRejectedValue(new Error('AlreadySettled'))
    mount(<KeeperBoard />)
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('AlreadySettled'))
    expect(screen.getByRole('button', { name: 'Phạt missed ack' })).toBeDisabled()
    expect(mocks.tx.run).not.toHaveBeenCalled()
  })
})
describe('pending transaction escape hatch', () => {
  const txHash = `0x${'ef'.repeat(32)}` as const
  it('offers to drop a submitted transaction only after an error with a tx hash', () => {
    const onDiscard = vi.fn()
    const view = mount(<IncentiveTxStatus snapshot={{ stage: 'error', action: 'stakeDevice', txHash, error: new Error('timeout') }} onDiscard={onDiscard} />)
    fireEvent.click(screen.getByRole('button', { name: 'Bỏ qua giao dịch đang chờ' }))
    expect(onDiscard).toHaveBeenCalledOnce()
    view.rerender(<IncentiveTxStatus snapshot={{ stage: 'error', action: 'stakeDevice', error: new Error('simulation reverted') }} onDiscard={onDiscard} />)
    expect(screen.queryByRole('button', { name: 'Bỏ qua giao dịch đang chờ' })).not.toBeInTheDocument()
    view.rerender(<IncentiveTxStatus snapshot={{ stage: 'confirming', action: 'stakeDevice', txHash }} onDiscard={onDiscard} />)
    expect(screen.queryByRole('button', { name: 'Bỏ qua giao dịch đang chờ' })).not.toBeInTheDocument()
  })
})
