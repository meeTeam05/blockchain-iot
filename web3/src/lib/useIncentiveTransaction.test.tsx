import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeFunctionData, encodeFunctionResult, type Hash } from 'viem'
import type { ReactNode } from 'react'
import { SAFETY_INCENTIVES_ABI } from '../generated/incentives-deployments'
import { incentivesDeployment } from './incentives'
import { useIncentiveTransaction } from './useIncentiveTransaction'

const mock = vi.hoisted(() => ({ public: { request: vi.fn(), readContract: vi.fn(), simulateContract: vi.fn(), waitForTransactionReceipt: vi.fn() },
  wallet: { request: vi.fn(), writeContract: vi.fn(), account: { address: '0x90F79bf6EB2c4f870365E785982e1f101E93b906' } },
  account: { address: '0x90F79bf6EB2c4f870365E785982e1f101E93b906', isConnected: true, chainId: 11155111, connector: { uid: 'test' } } }))
vi.mock('wagmi', () => ({ usePublicClient: () => mock.public, useConnectorClient: () => ({ data: mock.wallet }),
  useWalletClient: () => ({ data: mock.wallet }), useAccount: () => mock.account }))
vi.mock('../blocks/B0/domainStatus', () => ({ useDomainStatus: () => ({ publicStatus: 'correct', walletStatus: 'correct' }) }))
const hash = `0x${'ab'.repeat(32)}` as Hash
const key = `0x${'cd'.repeat(32)}` as Hash
let queryClient: QueryClient
function wrapper({ children }: { children: ReactNode }) { return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> }
beforeEach(() => {
  vi.resetAllMocks(); localStorage.clear()
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const rpc = async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === 'eth_chainId') return '0xaa36a7'
    if (method === 'eth_getCode') return '0x6000'
    const request = params?.[0] as { data: string }
    return encodeFunctionResult({ abi: SAFETY_INCENTIVES_ABI, functionName: 'airSafetyLog',
      result: request.data === encodeFunctionData({ abi: SAFETY_INCENTIVES_ABI, functionName: 'airSafetyLog' }) ? incentivesDeployment!.airSafetyLog : incentivesDeployment!.token.address })
  }
  // Selectors are obtained from the real ABI, not duplicated in the test.
  mock.public.request.mockImplementation(rpc); mock.wallet.request.mockImplementation(rpc)
  mock.public.readContract.mockResolvedValue({ exists: true, covered: true, canSlashMissedAck: true, canSlashLateRelay: true })
  mock.public.simulateContract.mockImplementation(async (request) => ({ request }))
  mock.wallet.writeContract.mockResolvedValue(hash)
  mock.public.waitForTransactionReceipt.mockResolvedValue({ status: 'success' })
})
afterEach(() => queryClient.clear())
describe('incentives uses the shared Task 5 transaction engine', () => {
  async function setup() {
    const hook = renderHook(() => useIncentiveTransaction(key), { wrapper })
    await waitFor(() => expect(hook.result.current.guard.canWrite).toBe(true))
    return hook
  }
  it('simulates, signs once, persists/resumes receipt and refreshes after confirmation', async () => {
    const hook = await setup()
    const refresh = vi.spyOn(queryClient, 'invalidateQueries')
    await act(async () => { await hook.result.current.run('slashMissedAck', [key]) })
    expect(mock.public.simulateContract).toHaveBeenCalledOnce()
    expect(mock.wallet.writeContract).toHaveBeenCalledOnce()
    expect(hook.result.current.snapshot.stage).toBe('success')
    expect(mock.public.waitForTransactionReceipt).toHaveBeenCalledWith({ hash, confirmations: 1 })
    expect(refresh).toHaveBeenCalledWith({ queryKey: ['incentives'] })
    expect(refresh).toHaveBeenCalledWith({ queryKey: ['incident'] })
  })
  it('preserves confirmed receipt success when projection refresh fails', async () => {
    const hook = await setup()
    vi.spyOn(queryClient, 'invalidateQueries').mockRejectedValue(new Error('API offline'))
    await act(async () => { await hook.result.current.run('slashLateRelay', [key]) })
    expect(hook.result.current.snapshot).toMatchObject({ stage: 'success', txHash: hash, apiSyncDelayed: true })
    expect(mock.wallet.writeContract).toHaveBeenCalledOnce()
  })
  it('blocks stale keeper actions before simulation/signing', async () => {
    const hook = await setup()
    mock.public.readContract.mockResolvedValue({ exists: true, covered: true, canSlashMissedAck: false })
    await act(async () => { await hook.result.current.run('slashMissedAck', [key]) })
    expect(hook.result.current.snapshot.stage).toBe('error')
    expect(mock.public.simulateContract).not.toHaveBeenCalled()
    expect(mock.wallet.writeContract).not.toHaveBeenCalled()
  })
  it('stops on simulation revert and handles wallet rejection', async () => {
    const hook = await setup()
    mock.public.simulateContract.mockRejectedValueOnce(new Error('BondTooLow'))
    await act(async () => { await hook.result.current.run('stakeDevice', [key, 1n]) })
    expect(mock.wallet.writeContract).not.toHaveBeenCalled()
    expect(hook.result.current.snapshot.stage).toBe('error')
    mock.wallet.writeContract.mockRejectedValueOnce({ code: 4001 })
    await act(async () => { await hook.result.current.run('approve', [incentivesDeployment!.incentives.address, 100n]) })
    expect(hook.result.current.snapshot.stage).toBe('cancelled')
  })
  it('lets the user drop a submitted transaction that never produced a receipt, then sends a new one', async () => {
    const hook = await setup()
    const storage = `smartair-pending-incentives:localhost:${incentivesDeployment!.incentives.address.toLowerCase()}:${mock.account.address.toLowerCase()}:${key}`
    mock.public.waitForTransactionReceipt.mockRejectedValueOnce(new Error('receipt timeout'))
    await act(async () => { await hook.result.current.run('slashMissedAck', [key]) })
    expect(hook.result.current.snapshot).toMatchObject({ stage: 'error', txHash: hash })
    expect(localStorage.getItem(storage)).not.toBeNull()

    act(() => hook.result.current.discardPending())
    expect(localStorage.getItem(storage)).toBeNull()
    expect(hook.result.current.snapshot.stage).toBe('idle')

    await act(async () => { await hook.result.current.run('slashMissedAck', [key]) })
    expect(mock.wallet.writeContract).toHaveBeenCalledTimes(2)
    expect(hook.result.current.snapshot.stage).toBe('success')
  })
  it('does not resubmit a persisted transaction after remount', async () => {
    const storage = `smartair-pending-incentives:localhost:${incentivesDeployment!.incentives.address.toLowerCase()}:${mock.account.address.toLowerCase()}:${key}`
    localStorage.setItem(storage, JSON.stringify({ version: 1, action: 'stakeDevice', txHash: hash, submittedAt: 1 }))
    const hook = renderHook(() => useIncentiveTransaction(key), { wrapper })
    await waitFor(() => expect(hook.result.current.snapshot.stage).toBe('success'))
    expect(mock.wallet.writeContract).not.toHaveBeenCalled()
    expect(mock.public.simulateContract).not.toHaveBeenCalled()
    expect(localStorage.getItem(storage)).toBeNull()
  })
})
