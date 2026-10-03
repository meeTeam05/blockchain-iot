// Real end-to-end proof for B5/decision #9's spike payoff: wagmi's mock
// connector signs+sends acknowledgeIncident against a live hardhat node
// with a REAL logged incident, through the actual <OwnerActions> component
// -- not a mocked contract call. OwnerActions never calls the backend API
// directly (that's the parent page's job via onSettled), so nothing here
// is mocked -- the chain side is 100% real, driven through real UI clicks.
//
// Skipped unless E2E_CHAIN_RPC_URL points at a local hardhat node:
//   cd blockchain && npx hardhat node
//   cd web3 && E2E_CHAIN_RPC_URL=http://127.0.0.1:8545 npm run test -- ownerActions
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createConfig, http, WagmiProvider } from 'wagmi'
import { mock } from 'wagmi/connectors'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain JS helper, no type declarations published.
import { KEYS, createProvider, deploy, logIncidentAsRelayer, registerDevice } from '../../../server/api/test/helpers/chain-deploy.js'
// @ts-expect-error -- plain JS helper, no type declarations published.
import { loadVector, signIncident } from '../../../server/api/test/helpers/incident-fixtures.js'
import { activeNetwork } from '../../src/config/networks'
import { chain } from '../../src/lib/wagmiConfig'
import { ConnectWallet } from '../../src/blocks/B1/ConnectWallet'
import { CORRECT_DOMAIN_STATUS, DomainStatusContext } from '../../src/blocks/B0/domainStatus'
import { OwnerActions } from '../../src/blocks/B5/OwnerActions'

const RPC_URL = process.env.E2E_CHAIN_RPC_URL

describe.skipIf(!RPC_URL)('OwnerActions against a live hardhat node', () => {
  it('acknowledgeIncident via the mock connector changes the on-chain status to Acknowledged', async () => {
    const provider = createProvider(RPC_URL)
    const { contract, address } = await deploy(provider)
    // OwnerActions reads activeNetwork.address directly (same as the real
    // app). This run's contract is NOT guaranteed to land at the static
    // localhost.json address (hardhat's deterministic first-nonce address
    // only matches when nobody else has deployed on this node yet) -- mutate
    // the shared singleton so the component under test targets the address
    // actually deployed in this run, matching decision #13's intent.
    activeNetwork.address = address as `0x${string}`

    const ownerAccount = privateKeyToAccount(KEYS.owner)
    const vector = await loadVector('earlyWarning')
    const deviceIdHash = vector.payload.device_id_hash
    // signer (device hardware key) and owner (MetaMask wallet) are deliberately
    // different roles -- the vector's default test key is the signer, account
    // #3 (KEYS.owner) is a separate owner address, matching how the real
    // system works (acknowledgeIncident only cares about the owner role).
    const signerAddress = vector.vector.expected.signer
    await registerDevice(contract, provider, deviceIdHash, signerAddress, ownerAccount.address)

    const domain = { name: 'AirSafetyLog', version: '1', chainId: '11155111', verifyingContract: address }
    const signed = signIncident({ vector: vector.vector, domain, payload: vector.payload })
    const incidentKey = await logIncidentAsRelayer(contract, provider, signed)

    const config = createConfig({
      chains: [{ ...chain, rpcUrls: { default: { http: [RPC_URL!] } } }],
      connectors: [mock({ accounts: [ownerAccount.address] })],
      transports: { [chain.id]: http(RPC_URL!) },
    })
    const queryClient = new QueryClient()

    render(
      <WagmiProvider config={config}>
        <QueryClientProvider client={queryClient}>
          {/* Real DomainStatusProvider checks the static activeNetwork.address,
              which doesn't exist on this run's dynamically-deployed contract --
              force domainOk=true here since that check is B0's concern, not B5's. */}
          <DomainStatusContext.Provider value={CORRECT_DOMAIN_STATUS}>
            <ConnectWallet />
            <OwnerActions
              deviceId="device-1"
              incidentId={vector.payload.incident_id}
              incidentKey={incidentKey}
              chainStatus="Logged"
              isOwner
              readOwnerStatus={async () => 'acknowledged'}
              refetchChain={async () => {}}
            />
          </DomainStatusContext.Provider>
        </QueryClientProvider>
      </WagmiProvider>,
    )

    // Real user interaction: click "Kết nối ví" through the actual ConnectWallet
    // component, same as a real user would -- not an imperative bypass.
    fireEvent.click(await screen.findByRole('button', { name: 'Kết nối ví' }))
    await screen.findByText(chain.name)

    const button = await screen.findByRole('button', { name: 'Xác nhận' })
    fireEvent.click(button)

    const dialog = await screen.findByRole('dialog')
    const confirmButton = within(dialog).getByRole('button', { name: 'Xác nhận' })
    fireEvent.click(confirmButton)

    // Verify via the same ethers contract instance already used for setup --
    // avoids opening yet another competing HTTP transport against the
    // hardhat node while wagmi's own polling is also active.
    await waitFor(
      async () => {
        const incident = await contract.getIncident(incidentKey)
        expect(Number(incident.status)).toBe(2) // Acknowledged
      },
      { timeout: 15_000 },
    )
  }, 30_000)
})
