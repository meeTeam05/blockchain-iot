// B0: reads the generated per-network deployment + env, so switching
// VITE_NETWORK between localhost and sepolia needs no code change.
import { INCIDENT_DEPLOYMENTS } from '../generated/incident-deployments'

export type NetworkKey = keyof typeof INCIDENT_DEPLOYMENTS

const networkKey = (import.meta.env.VITE_NETWORK ?? 'localhost') as NetworkKey
const deployment = INCIDENT_DEPLOYMENTS[networkKey]

if (!deployment) {
  throw new Error(
    `VITE_NETWORK="${networkKey}" has no entry in incident-deployments.ts -- regenerate with node spec/incident/gen/gen-all.mjs`,
  )
}

const EXPLORER_BASE_URL: Record<NetworkKey, string | null> = {
  localhost: null,
  sepolia: 'https://sepolia.etherscan.io',
}

// keccak256 of eth_getCode at each canonical deployment. AirSafetyLog contains
// constructor-patched immutables, so the compiled artifact's placeholder code
// (and each deployed address) has a different runtime hash.
const RUNTIME_CODE_HASH: Record<NetworkKey, `0x${string}`> = {
  localhost: '0xf504c6cd815e3692a008fea42979045966d0623fc1548e83c7675723d8e6c29f',
  sepolia: '0x42d6b7e3e67ea1ced8645f058e881d5f3f40afd1fb47ae92c3a153a36fd2697d',
}

export const activeNetwork = {
  key: networkKey,
  chainId: Number(deployment.chainId),
  address: deployment.address,
  name: deployment.name,
  version: deployment.version,
  domainSeparator: deployment.domainSeparator,
  deployTxHash: deployment.deployTxHash,
  blockNumber: deployment.blockNumber,
  runtimeCodeHash: RUNTIME_CODE_HASH[networkKey],
  rpcUrl: import.meta.env.VITE_RPC_URL as string,
  explorerBaseUrl: EXPLORER_BASE_URL[networkKey] ?? null,
}

export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string
