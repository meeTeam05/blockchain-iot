// B0/B1: wallet connection. Chain ID 11155111 is used for BOTH localhost
// hardhat and Sepolia (deliberate collision in blockchain/hardhat.config.js,
// kept so Schema v2 test vectors verify against either) -- always check the
// RPC actually in use via the eip712Domain banner (DomainMismatchBanner),
// never assume chainId alone proves the right network.
import { createConfig, fallback, http } from 'wagmi'
import { injected, mock } from 'wagmi/connectors'
import { defineChain } from 'viem'
import { activeNetwork } from '../config/networks'

// Playwright E2E: drives a real browser against
// a real hardhat node, but signs through wagmi's mock connector instead of a
// real MetaMask extension -- same approach already proven by decision #9's
// spike and by test/integration/ownerActions.integration.test.tsx. Never on
// in a normal build; only playwright.config.ts's webServer sets this env var.
const e2eMockAccount = import.meta.env.VITE_E2E_MOCK_ACCOUNT as `0x${string}` | undefined
const e2eWrongAccount = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const
const e2eKeeperAccount = import.meta.env.VITE_E2E_KEEPER_ACCOUNT as `0x${string}` | undefined
const connectors = e2eMockAccount
  ? [mock({ accounts: [e2eWrongAccount] }), mock({ accounts: [e2eMockAccount] }), ...(e2eKeeperAccount ? [mock({ accounts: [e2eKeeperAccount] })] : [])]
  : [injected()]

const isSepolia = activeNetwork.key === 'sepolia'

export const chain = defineChain({
  id: activeNetwork.chainId,
  name: activeNetwork.key === 'sepolia' ? 'Sepolia' : 'Hardhat (localhost)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: [activeNetwork.rpcUrl] },
  },
  blockExplorers: activeNetwork.explorerBaseUrl
    ? { default: { name: 'Etherscan', url: activeNetwork.explorerBaseUrl } }
    : undefined,
  // wagmi batches same-tick eth_calls through Multicall3 only when the chain
  // declares it. Sepolia has the canonical deployment; local hardhat does not.
  contracts: isSepolia
    ? { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11', blockCreated: 751532 } }
    : undefined,
})

// Free-tier RPC keys rate-limit per second (HTTP 429). On Sepolia, fail over
// to a keyless public node so reads keep working; it prunes old logs and
// receipts, so the primary RPC stays first.
const PUBLIC_SEPOLIA_RPC = 'https://ethereum-sepolia-rpc.publicnode.com'
const rpcTransport = isSepolia && activeNetwork.rpcUrl !== PUBLIC_SEPOLIA_RPC
  ? fallback([http(activeNetwork.rpcUrl, { retryCount: 1 }), http(PUBLIC_SEPOLIA_RPC)])
  : http(activeNetwork.rpcUrl)

export const wagmiConfig = createConfig({
  chains: [chain],
  connectors,
  transports: {
    [chain.id]: rpcTransport,
  },
})
