import { encodeFunctionResult, getContractAddress, keccak256, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { AIR_SAFETY_LOG_ABI } from '../generated/incident-deployments'
import { validateDeployment, type DeploymentTarget, type RpcRequest } from './deploymentValidation'

const code = '0x6001600055' as Hex
const deployer = '0x2222222222222222222222222222222222222222'
const deployTx: { from: string; nonce: string; to: string | null; blockNumber: string } =
  { from: deployer, nonce: '0x7', to: null, blockNumber: '0x2a' }
const target: DeploymentTarget = {
  chainId: 11155111,
  address: getContractAddress({ from: deployer, nonce: 7n }),
  name: 'AirSafetyLog',
  version: '1',
  domainSeparator: `0x${'ab'.repeat(32)}`,
  runtimeCodeHash: keccak256(code),
  deployTxHash: `0x${'de'.repeat(32)}`,
  blockNumber: 42,
}

function rpc(overrides: {
  chainId?: string
  code?: Hex
  name?: string
  address?: `0x${string}`
    separator?: Hex
    receipt?: { contractAddress: `0x${string}`; blockNumber: string } | null
  tx?: Partial<typeof deployTx> | null
  fail?: boolean
} = {}): RpcRequest {
  return async ({ method, params }) => {
    if (overrides.fail) throw new Error('offline')
    if (method === 'eth_chainId') return overrides.chainId ?? '0xaa36a7'
    if (method === 'eth_getCode') return overrides.code ?? code
    if (method === 'eth_getTransactionReceipt') {
      return overrides.receipt === undefined
        ? { contractAddress: target.address, blockNumber: '0x2a' }
        : overrides.receipt
    }
    if (method === 'eth_getTransactionByHash') {
      return overrides.tx === undefined ? deployTx : overrides.tx && { ...deployTx, ...overrides.tx }
    }
    if (method === 'eth_call') {
      const data = ((params?.[0] ?? {}) as { data: Hex }).data
      if (data.startsWith('0x84b0196e')) {
        return encodeFunctionResult({
          abi: AIR_SAFETY_LOG_ABI,
          functionName: 'eip712Domain',
          result: [
            '0x0f',
            overrides.name ?? target.name,
            target.version,
            BigInt(target.chainId),
            overrides.address ?? target.address,
            `0x${'00'.repeat(32)}`,
            [],
          ],
        })
      }
      return encodeFunctionResult({
        abi: AIR_SAFETY_LOG_ABI,
        functionName: 'domainSeparator',
        result: overrides.separator ?? target.domainSeparator,
      })
    }
    throw new Error(`unexpected ${method}`)
  }
}

describe('validateDeployment', () => {
  it('accepts the correct wallet RPC deployment', async () => {
    await expect(validateDeployment(rpc(), target)).resolves.toBe('correct')
  })

  it('distinguishes wrong chain', async () => {
    await expect(validateDeployment(rpc({ chainId: '0x1' }), target)).resolves.toBe('wrong_chain')
  })

  it('detects a same-chain RPC serving a different deployment', async () => {
    await expect(validateDeployment(rpc({ code: '0x6002' }), target)).resolves.toBe('wrong_rpc')
  })

  it('rejects matching code/domain without the canonical deployment receipt or tx', async () => {
    await expect(validateDeployment(rpc({ receipt: null, tx: null }), target)).resolves.toBe('wrong_rpc')
  })

  it('rejects a receipt for another address or block', async () => {
    await expect(
      validateDeployment(rpc({ receipt: { contractAddress: deployer, blockNumber: '0x2a' } }), target),
    ).resolves.toBe('wrong_rpc')
    await expect(
      validateDeployment(rpc({ receipt: { contractAddress: target.address, blockNumber: '0x2b' } }), target),
    ).resolves.toBe('wrong_rpc')
  })

  it('accepts a pruned receipt when the deploy tx creates the target in the canonical block', async () => {
    await expect(validateDeployment(rpc({ receipt: null }), target)).resolves.toBe('correct')
  })

  it('rejects a pruned receipt when the deploy tx does not prove the deployment', async () => {
    for (const tx of [{ nonce: '0x8' }, { blockNumber: '0x2b' }, { to: deployer }, { from: target.address }]) {
      await expect(validateDeployment(rpc({ receipt: null, tx }), target)).resolves.toBe('wrong_rpc')
    }
  })

  it('distinguishes a missing contract', async () => {
    await expect(validateDeployment(rpc({ code: '0x' }), target)).resolves.toBe('contract_not_deployed')
  })

  it('detects domain field and separator mismatches', async () => {
    await expect(validateDeployment(rpc({ name: 'Wrong' }), target)).resolves.toBe('domain_mismatch')
    await expect(
      validateDeployment(rpc({ separator: `0x${'cd'.repeat(32)}` }), target),
    ).resolves.toBe('domain_mismatch')
  })

  it('reports an unavailable RPC', async () => {
    await expect(validateDeployment(rpc({ fail: true }), target)).resolves.toBe('rpc_unavailable')
  })

  it('keeps public and wallet validation independent', async () => {
    const [publicStatus, walletStatus] = await Promise.all([
      validateDeployment(rpc(), target),
      validateDeployment(rpc({ code: '0x6002' }), target),
    ])
    expect(publicStatus).toBe('correct')
    expect(walletStatus).toBe('wrong_rpc')
  })
})
