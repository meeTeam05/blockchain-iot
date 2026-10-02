import { describe, it, expect, vi } from 'vitest'
import { encodeFunctionResult, type PublicClient } from 'viem'
import { activeNetwork } from '../config/networks'
import { SAFETY_INCENTIVES_ABI } from '../generated/incentives-deployments'
import { incentivesDeployment, parseBondAmount, readTokenWallet, resolveIncentives, stakeWithApproval, validateIncentives } from './incentives'
import { readIncentivesResponse } from './incentivesApi'
import { withIncentiveLock } from './useIncentiveTransaction'

const deployment = incentivesDeployment!
describe('Task 8 canonical deployment and token reads', () => {
  it('uses local generated addresses and tolerates missing Sepolia incentives', () => {
    expect(resolveIncentives(activeNetwork)?.token.address).toBe(deployment.token.address)
    expect(resolveIncentives({ ...activeNetwork, key: 'sepolia' })).toBeNull()
    expect(() => resolveIncentives({ ...activeNetwork, address: `0x${'1'.repeat(40)}` })).toThrow('không khớp')
  })
  it('reads balance/allowance and decimals from the token contract, never the API', async () => {
    const readContract = vi.fn(async ({ functionName }: { functionName: string; address?: string }) => ({ symbol: 'ASAFE', decimals: 6, balanceOf: 123000000n, allowance: 4000000n })[functionName])
    const result = await readTokenWallet({ readContract } as unknown as PublicClient, deployment, deployment.airSafetyLog)
    expect(result).toEqual({ symbol: 'ASAFE', decimals: 6, balance: 123000000n, allowance: 4000000n })
    expect(readContract.mock.calls.every(([request]) => request.address === deployment.token.address)).toBe(true)
  })
  it('propagates RPC failure rather than returning zero balance/allowance', async () => {
    const readContract = vi.fn().mockRejectedValue(new Error('RPC unavailable'))
    await expect(readTokenWallet({ readContract } as unknown as PublicClient, deployment, deployment.airSafetyLog)).rejects.toThrow('RPC unavailable')
  })
  it('does not read wallet balance/allowance while disconnected', async () => {
    const readContract = vi.fn(async ({ functionName }) => functionName === 'symbol' ? 'ASAFE' : 18)
    expect((await readTokenWallet({ readContract } as unknown as PublicClient, deployment)).balance).toBeUndefined()
    expect(readContract).toHaveBeenCalledTimes(2)
  })
  it('rejects wrong network, absent bytecode and incorrect contract linkage', async () => {
    await expect(validateIncentives(async () => '0x1', deployment)).rejects.toThrow('Sai mạng')
    await expect(validateIncentives(async ({ method }) => method === 'eth_chainId' ? '0xaa36a7' : '0x', deployment)).rejects.toThrow('chưa được deploy')
    await expect(validateIncentives(async ({ method }) => method === 'eth_chainId' ? '0xaa36a7' : method === 'eth_getCode' ? '0x6000' :
      encodeFunctionResult({ abi: SAFETY_INCENTIVES_ABI, functionName: 'airSafetyLog', result: deployment.token.address }), deployment)).rejects.toThrow('linkage')
  })
})
describe('Task 8 approval and bond workflow', () => {
  it('approves exactly the amount, then stakes', async () => {
    const run = vi.fn(async () => ({ stage: 'success' }))
    await stakeWithApproval(100n, 25n, run)
    expect(run.mock.calls).toEqual([['approve', 100n], ['stakeDevice', 100n]])
  })
  it('skips approval when allowance already covers the requested bond', async () => {
    const run = vi.fn(async () => ({ stage: 'success' }))
    await stakeWithApproval(100n, 100n, run)
    expect(run.mock.calls).toEqual([['stakeDevice', 100n]])
  })
  it('does not stake after an approval rejection or error', async () => {
    for (const stage of ['cancelled', 'error']) {
      const run = vi.fn(async () => ({ stage }))
      await stakeWithApproval(100n, 0n, run)
      expect(run).toHaveBeenCalledTimes(1)
    }
  })
  it('validates precision, nonzero amounts, uint128 bounds and token decimals', () => {
    expect(parseBondAmount('1.25', 6)).toBe(1250000n)
    for (const amount of ['0', '-1', '1e18', '1.0000001', 'NaN', String(2n ** 128n)]) expect(() => parseBondAmount(amount, 6)).toThrow()
  })
  it('blocks simultaneous clicks for the same pending transaction scope', async () => {
    let resolve!: () => void
    const task = vi.fn(() => new Promise<void>((done) => { resolve = done }))
    const first = withIncentiveLock('duplicate', task)
    expect(await withIncentiveLock('duplicate', task)).toBeUndefined()
    expect(task).toHaveBeenCalledOnce()
    resolve(); await first
    expect(await withIncentiveLock('duplicate', async () => true)).toBe(true)
  })
})
describe('Task 7 projection deployment scoping', () => {
  it('accepts the configured contract and rejects data from another deployment', async () => {
    const response = () => new Response(JSON.stringify({ contract: deployment.incentives.address, totals: { rewarded: '5' } }))
    expect(await readIncentivesResponse(response(), deployment.incentives.address)).toMatchObject({ totals: { rewarded: '5' } })
    await expect(readIncentivesResponse(response(), deployment.token.address)).rejects.toThrow('deployment incentives khác')
  })
  it('distinguishes unauthorized, not indexed and API failure', async () => {
    for (const [status, message] of [[403, 'quyền'], [404, 'chưa index'], [503, 'API incentives lỗi']] as const) {
      await expect(readIncentivesResponse(new Response('{}', { status }), deployment.incentives.address)).rejects.toThrow(message)
    }
  })
})
