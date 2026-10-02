import { describe, expect, it, vi } from 'vitest'
import { encodeEventTopics, numberToHex, type Hex, type PublicClient } from 'viem'
import { activeNetwork } from '../../config/networks'
import { AIR_SAFETY_LOG_ABI } from '../../generated/incident-deployments'
import { BLOCKS_PER_CHUNK, fetchDeviceHistory } from './historyLogs'

const DEVICE = `0x${'11'.repeat(32)}` as Hex
const TX = `0x${'22'.repeat(32)}` as Hex
const BLOCK_HASH = `0x${'33'.repeat(32)}` as Hex

function makeClient(latest: bigint, includeLog = false) {
  const topics = encodeEventTopics({
    abi: AIR_SAFETY_LOG_ABI,
    eventName: 'DeviceRegistered',
    args: {
      deviceIdHash: DEVICE,
      signer: '0x0000000000000000000000000000000000000001',
      owner: '0x0000000000000000000000000000000000000002',
    },
  })
  const log = {
    address: activeNetwork.address,
    blockHash: BLOCK_HASH,
    blockNumber: numberToHex(BigInt(activeNetwork.blockNumber)),
    data: '0x' as Hex,
    logIndex: '0x0' as Hex,
    removed: false,
    topics,
    transactionHash: TX,
    transactionIndex: '0x0' as Hex,
  }
  const request = vi.fn(async (_request: unknown) => includeLog ? [log] : [])
  const getBlock = vi.fn(async ({ blockNumber }: { blockNumber: bigint }) => ({ number: blockNumber, timestamp: 1_700_000_000n }))
  return {
    client: { getBlockNumber: vi.fn(async () => latest), request, getBlock } as unknown as PublicClient,
    request,
    getBlock,
  }
}

describe('fetchDeviceHistory', () => {
  function filtersFrom(request: ReturnType<typeof makeClient>['request']) {
    return request.mock.calls.map(([call]) => (
      call as { params: [{ fromBlock: Hex; toBlock: Hex; topics: (Hex | Hex[] | null)[] }] }
    ).params[0])
  }

  it.each([[1999n, 1], [2000n, 1], [2001n, 2]])(
    'uses inclusive chunks for a %s-block range',
    async (totalBlocks, chunks) => {
      const { client, request } = makeClient(BigInt(activeNetwork.blockNumber) + totalBlocks - 1n)
      await fetchDeviceHistory(client, DEVICE)
      expect(request).toHaveBeenCalledTimes(chunks * 2)
      for (const filter of filtersFrom(request)) {
        expect(BigInt(filter.toBlock) - BigInt(filter.fromBlock)).toBeLessThan(BLOCKS_PER_CHUNK)
      }
    },
  )

  it('sends deviceIdHash at the correct RPC topic positions', async () => {
    const { client, request } = makeClient(BigInt(activeNetwork.blockNumber))
    await fetchDeviceHistory(client, DEVICE)
    const filters = filtersFrom(request)
    expect(filters[0]?.topics[1]).toBe(DEVICE)
    expect(filters[1]?.topics[1]).toBeNull()
    expect(filters[1]?.topics[2]).toBe(DEVICE)
  })

  it('deduplicates logs and enriches their block timestamp', async () => {
    const { client, getBlock } = makeClient(BigInt(activeNetwork.blockNumber), true)
    const events = await fetchDeviceHistory(client, DEVICE)
    expect(events).toHaveLength(1)
    expect(events[0]?.timestamp).toBe(1_700_000_000n)
    expect(events[0]?.eventName).toBe('DeviceRegistered')
    expect(getBlock).toHaveBeenCalledTimes(1)
  })

  it('does not duplicate an event returned around a chunk boundary', async () => {
    const start = BigInt(activeNetwork.blockNumber)
    const { client } = makeClient(start + 2000n, true)
    const events = await fetchDeviceHistory(client, DEVICE)
    expect(events).toHaveLength(1)
  })

  it('surfaces RPC failures to the query/UI error state', async () => {
    const client = {
      getBlockNumber: vi.fn(async () => BigInt(activeNetwork.blockNumber)),
      request: vi.fn(async () => { throw new Error('RPC unavailable') }),
    } as unknown as PublicClient
    await expect(fetchDeviceHistory(client, DEVICE)).rejects.toThrow('RPC unavailable')
  })
})
