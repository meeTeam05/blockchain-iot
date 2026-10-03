import {
  decodeFunctionResult,
  encodeFunctionData,
  getContractAddress,
  keccak256,
  type Address,
  type Hex,
} from 'viem'
import { AIR_SAFETY_LOG_ABI } from '../generated/incident-deployments'

export type DeploymentStatus =
  | 'checking'
  | 'correct'
  | 'wrong_chain'
  | 'wrong_rpc'
  | 'contract_not_deployed'
  | 'domain_mismatch'
  | 'rpc_unavailable'
  | 'disconnected'

export interface DeploymentTarget {
  chainId: number
  address: Address
  name: string
  version: string
  domainSeparator: Hex
  runtimeCodeHash: Hex
  deployTxHash: Hex
  blockNumber: number
}

export type RpcRequest = (request: {
  method: string
  params?: readonly unknown[]
}) => Promise<unknown>

const EIP712_DOMAIN_CALL = encodeFunctionData({
  abi: AIR_SAFETY_LOG_ABI,
  functionName: 'eip712Domain',
})
const DOMAIN_SEPARATOR_CALL = encodeFunctionData({
  abi: AIR_SAFETY_LOG_ABI,
  functionName: 'domainSeparator',
})

function sameHex(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase()
}

function isBlock(value: unknown, expected: number) {
  return typeof value === 'string' && Number.parseInt(value, 16) === expected
}

export async function validateDeployment(
  request: RpcRequest,
  target: DeploymentTarget,
): Promise<DeploymentStatus> {
  try {
    const chainIdHex = await request({ method: 'eth_chainId' })
    if (typeof chainIdHex !== 'string' || Number.parseInt(chainIdHex, 16) !== target.chainId) {
      return 'wrong_chain'
    }

    const code = await request({
      method: 'eth_getCode',
      params: [target.address, 'latest'],
    })
    if (typeof code !== 'string' || code === '0x' || /^0x0*$/.test(code)) {
      return 'contract_not_deployed'
    }
    if (!sameHex(keccak256(code as Hex), target.runtimeCodeHash)) {
      return 'wrong_rpc'
    }

    const domainResult = await request({
      method: 'eth_call',
      params: [{ to: target.address, data: EIP712_DOMAIN_CALL }, 'latest'],
    })
    const domain = decodeFunctionResult({
      abi: AIR_SAFETY_LOG_ABI,
      functionName: 'eip712Domain',
      data: domainResult as Hex,
    })
    if (
      domain[1] !== target.name ||
      domain[2] !== target.version ||
      Number(domain[3]) !== target.chainId ||
      !sameHex(domain[4], target.address)
    ) {
      return 'domain_mismatch'
    }

    const separatorResult = await request({
      method: 'eth_call',
      params: [{ to: target.address, data: DOMAIN_SEPARATOR_CALL }, 'latest'],
    })
    const separator = decodeFunctionResult({
      abi: AIR_SAFETY_LOG_ABI,
      functionName: 'domainSeparator',
      data: separatorResult as Hex,
    })
    if (!sameHex(separator, target.domainSeparator)) return 'domain_mismatch'

    const deploymentReceipt = await request({
      method: 'eth_getTransactionReceipt',
      params: [target.deployTxHash],
    }) as { contractAddress?: string; blockNumber?: string } | null
    if (deploymentReceipt) {
      return deploymentReceipt.contractAddress &&
        sameHex(deploymentReceipt.contractAddress, target.address) &&
        isBlock(deploymentReceipt.blockNumber, target.blockNumber)
        ? 'correct'
        : 'wrong_rpc'
    }

    // Public RPCs (e.g. publicnode) prune old receipts but keep the transaction.
    // A contract-creation tx in the canonical block whose CREATE address
    // (sender + nonce) is the target proves the same deployment.
    const deploymentTx = await request({
      method: 'eth_getTransactionByHash',
      params: [target.deployTxHash],
    }) as { from?: string; nonce?: string; to?: string | null; blockNumber?: string } | null
    if (
      !deploymentTx ||
      deploymentTx.to != null ||
      typeof deploymentTx.from !== 'string' ||
      typeof deploymentTx.nonce !== 'string' ||
      !isBlock(deploymentTx.blockNumber, target.blockNumber) ||
      !sameHex(
        getContractAddress({ from: deploymentTx.from as Address, nonce: BigInt(deploymentTx.nonce) }),
        target.address,
      )
    ) {
      return 'wrong_rpc'
    }
    return 'correct'
  } catch {
    return 'rpc_unavailable'
  }
}
