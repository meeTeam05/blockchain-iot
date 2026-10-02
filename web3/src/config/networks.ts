// B0: reads the generated per-network deployment + env, so switching
// VITE_NETWORK between localhost and sepolia needs no code change
// (tmp/Web3_task.md B0 "Xong khi" criterion).
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

export const activeNetwork = {
  key: networkKey,
  chainId: Number(deployment.chainId),
  address: deployment.address,
  name: deployment.name,
  version: deployment.version,
  domainSeparator: deployment.domainSeparator,
  blockNumber: deployment.blockNumber,
  rpcUrl: import.meta.env.VITE_RPC_URL as string,
  explorerBaseUrl: EXPLORER_BASE_URL[networkKey] ?? null,
}

export const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string
