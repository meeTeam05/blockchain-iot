// Decision #13 (tmp/02_decisions/2026-10-01_task5-dapp-incident-decisions.md):
// chain-e2e.test.js deploys a FRESH AirSafetyLog every run, at an address
// that does not match the static spec/incident/deployments/localhost.json
// entry. This test proves the dApp's own viem reads work against that kind
// of dynamically-deployed address, by reusing the exact same deploy()/
// registerDevice() helpers chain-e2e.test.js uses
// (server/api/test/helpers/chain-deploy.js) instead of a second, possibly
// drifting implementation. No `ethers` import here -- that stays inside the
// shared helper; this file only uses viem, matching the dApp's own stack.
//
// Skipped unless E2E_CHAIN_RPC_URL points at a local hardhat node:
//   cd contracts && npx hardhat node
//   cd web3 && E2E_CHAIN_RPC_URL=http://127.0.0.1:8545 npm run test -- chainRead
import { createPublicClient, http, keccak256, toBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'
// Cross-package import: Node resolves chain-deploy.js's OWN `ethers` import
// relative to its own location (server/api/node_modules) -- this file never
// imports `ethers` itself, matching the dApp's own viem-only stack.
// @ts-expect-error -- plain JS helper, no type declarations published.
import { KEYS, createProvider, deploy, registerDevice } from '../../../server/api/test/helpers/chain-deploy.js'
import { AIR_SAFETY_LOG_ABI } from '../../src/generated/incident-deployments'

const RPC_URL = process.env.E2E_CHAIN_RPC_URL

describe.skipIf(!RPC_URL)('dApp chain reads against a dynamically-deployed contract', () => {
  it('eip712Domain() and getDevice() via viem match what was just deployed with ethers', async () => {
    const provider = createProvider(RPC_URL)
    const { contract, address } = await deploy(provider)

    const deviceId = 'aa:bb:cc:dd:ee:ff'
    const deviceIdHash = keccak256(toBytes(deviceId))
    const owner = privateKeyToAccount(KEYS.owner).address
    await registerDevice(contract, provider, deviceIdHash, owner, owner)

    // Read it back through viem, the dApp's own stack, pointed at this
    // run's dynamic address (not the static localhost.json one).
    const publicClient = createPublicClient({ transport: http(RPC_URL!) })

    const domain = await publicClient.readContract({
      address: address as `0x${string}`,
      abi: AIR_SAFETY_LOG_ABI,
      functionName: 'eip712Domain',
    })
    expect(domain[1]).toBe('AirSafetyLog')
    expect(domain[4].toLowerCase()).toBe(address.toLowerCase())

    const device = await publicClient.readContract({
      address: address as `0x${string}`,
      abi: AIR_SAFETY_LOG_ABI,
      functionName: 'getDevice',
      args: [deviceIdHash],
    })
    expect(device.exists).toBe(true)
    expect(device.active).toBe(true)
    expect(device.owner.toLowerCase()).toBe(owner.toLowerCase())
  })
})
