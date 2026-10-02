import {
  decodeFunctionResult,
  encodeFunctionData,
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
    if (
      !deploymentReceipt ||
      !deploymentReceipt.contractAddress ||
      !sameHex(deploymentReceipt.contractAddress, target.address) ||
      typeof deploymentReceipt.blockNumber !== 'string' ||
      Number.parseInt(deploymentReceipt.blockNumber, 16) !== target.blockNumber
    ) {
      return 'wrong_rpc'
    }
    return 'correct'
  } catch {
    return 'rpc_unavailable'
  }
}
