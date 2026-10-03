import { decodeFunctionResult, encodeFunctionData, parseUnits, type Address, type Hex, type PublicClient } from 'viem'
import { activeNetwork } from '../config/networks'
import { INCENTIVES_DEPLOYMENTS, SAFETY_INCENTIVES_ABI, AIR_SAFE_TOKEN_ABI } from '../generated/incentives-deployments'
import type { RpcRequest } from './deploymentValidation'

export interface IncentivesDeployment {
  network: string
  chainId: string
  airSafetyLog: Address
  token: { address: Address; blockNumber: number }
  incentives: { address: Address; blockNumber: number; activatedAt: string }
}
export function resolveIncentives(network: { key: string; chainId: number; address: Address }, deployments: Record<string, IncentivesDeployment> = INCENTIVES_DEPLOYMENTS) {
  const value = deployments[network.key]
  if (!value) return null
  if (Number(value.chainId) !== network.chainId || value.airSafetyLog.toLowerCase() !== network.address.toLowerCase()) {
    throw new Error('Deployment incentives không khớp AirSafetyLog của mạng hiện hành')
  }
  return value
}
export const incentivesDeployment = resolveIncentives(activeNetwork)

export class IncentivesValidationError extends Error {
  kind: 'not_deployed' | 'mismatch'
  constructor(kind: 'not_deployed' | 'mismatch', message: string) { super(message); this.kind = kind }
}

export async function validateIncentives(request: RpcRequest, deployment: IncentivesDeployment) {
  if (Number(BigInt(await request({ method: 'eth_chainId' }) as string)) !== Number(deployment.chainId)) {
    throw new IncentivesValidationError('mismatch', 'Sai mạng incentives trong RPC')
  }
  for (const address of [deployment.token.address, deployment.incentives.address]) {
    const code = await request({ method: 'eth_getCode', params: [address, 'latest'] })
    if (!code || code === '0x') throw new IncentivesValidationError('not_deployed', 'Token/incentives chưa được deploy trên RPC này')
  }
  for (const [functionName, expected] of [['airSafetyLog', deployment.airSafetyLog], ['token', deployment.token.address]] as const) {
    const data = encodeFunctionData({ abi: SAFETY_INCENTIVES_ABI, functionName })
    const result = await request({ method: 'eth_call', params: [{ to: deployment.incentives.address, data }, 'latest'] }) as Hex
    const actual = decodeFunctionResult({ abi: SAFETY_INCENTIVES_ABI, functionName, data: result })
    if (actual.toLowerCase() !== expected.toLowerCase()) throw new IncentivesValidationError('mismatch', 'Contract linkage incentives không khớp deployment')
  }
}

export type IncentiveAction = 'approve' | 'stakeDevice' | 'requestUnstake' | 'withdraw' |
  'recordTimelyAck' | 'recordTimelyResolve' | 'slashMissedAck' | 'slashLateRelay'
export const settlementEligibility = {
  recordTimelyAck: 'canRecordAck', recordTimelyResolve: 'canRecordResolve',
  slashMissedAck: 'canSlashMissedAck', slashLateRelay: 'canSlashLateRelay',
} as const

export async function readTokenWallet(client: PublicClient, deployment: IncentivesDeployment, account?: Address) {
  const address = deployment.token.address
  const [symbol, decimals, balance, allowance] = await Promise.all([
    client.readContract({ address, abi: AIR_SAFE_TOKEN_ABI, functionName: 'symbol' }),
    client.readContract({ address, abi: AIR_SAFE_TOKEN_ABI, functionName: 'decimals' }),
    account ? client.readContract({ address, abi: AIR_SAFE_TOKEN_ABI, functionName: 'balanceOf', args: [account] }) : undefined,
    account ? client.readContract({ address, abi: AIR_SAFE_TOKEN_ABI, functionName: 'allowance', args: [account, deployment.incentives.address] }) : undefined,
  ])
  return { symbol, decimals, balance, allowance }
}

export function parseBondAmount(value: string, decimals: number) {
  if (!/^\d+(\.\d+)?$/.test(value.trim()) || (value.trim().split('.')[1]?.length ?? 0) > decimals) throw new Error('Số lượng token không hợp lệ')
  const amount = parseUnits(value.trim(), decimals)
  if (amount <= 0n || amount >= 2n ** 128n) throw new Error('Số lượng phải lớn hơn 0 và trong giới hạn bond')
  return amount
}

export async function stakeWithApproval(amount: bigint, allowance: bigint,
  run: (action: 'approve' | 'stakeDevice', amount: bigint) => Promise<{ stage: string }>) {
  if (allowance < amount && (await run('approve', amount)).stage !== 'success') return
  return run('stakeDevice', amount)
}
