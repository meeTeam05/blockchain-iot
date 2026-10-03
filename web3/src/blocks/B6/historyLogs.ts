// Trustless device history. Filters are sent to eth_getLogs itself; device
// events index deviceIdHash at topic[1], incident events at topic[2].
import { decodeEventLog, numberToHex, toEventSelector, type Hex, type PublicClient, type RpcLog } from 'viem'
import { AIR_SAFETY_LOG_ABI } from '../../generated/incident-deployments'
import { activeNetwork } from '../../config/networks'

export const BLOCKS_PER_CHUNK = 2000n

const DEVICE_TOPICS = [
  'DeviceRegistered(bytes32,address,address)',
  'DeviceSignerRotated(bytes32,address,address)',
  'DeviceRevoked(bytes32,address)',
  'DeviceOwnerChanged(bytes32,address,address)',
].map(toEventSelector)

const INCIDENT_TOPICS = [
  'IncidentLogged(bytes32,bytes32,bytes32,uint64,uint64,uint8,bytes32,address)',
  'IncidentAcknowledged(bytes32,bytes32,address)',
  'IncidentResolved(bytes32,bytes32,address)',
  'EmergencyTriggered(bytes32,bytes32,uint64)',
].map(toEventSelector)

export interface HistoryEvent {
  eventName: string
  blockNumber: bigint
  blockHash: Hex
  logIndex: number
  transactionHash: Hex
  timestamp: bigint
  args: Record<string, unknown>
}

export async function fetchDeviceHistory(publicClient: PublicClient, deviceIdHash: Hex): Promise<HistoryEvent[]> {
  const latest = await publicClient.getBlockNumber()
  const fromDeployment = BigInt(activeNetwork.blockNumber)
  const decodedEvents: Omit<HistoryEvent, 'timestamp'>[] = []
  const seen = new Set<string>()

  // Inclusive JSON-RPC ranges: [from, from + 1999] is exactly 2,000 blocks.
  for (let from = fromDeployment; from <= latest; from += BLOCKS_PER_CHUNK) {
    const to = from + BLOCKS_PER_CHUNK - 1n > latest ? latest : from + BLOCKS_PER_CHUNK - 1n
    const filters: (Hex | Hex[] | null)[][] = [
      [DEVICE_TOPICS, deviceIdHash],
      [INCIDENT_TOPICS, null, deviceIdHash],
    ]
    const batches = await Promise.all(filters.map(async (topics): Promise<RpcLog[]> => publicClient.request({
      method: 'eth_getLogs',
      params: [{ address: activeNetwork.address, fromBlock: numberToHex(from), toBlock: numberToHex(to), topics }],
    })))
    for (const log of batches.flat()) {
      if (!log.transactionHash || !log.blockHash || !log.blockNumber || !log.logIndex) continue
      const dedupKey = `${log.transactionHash}:${log.logIndex}`
      if (seen.has(dedupKey)) continue
      seen.add(dedupKey)
      try {
        const decoded = decodeEventLog({ abi: AIR_SAFETY_LOG_ABI, data: log.data, topics: log.topics })
        decodedEvents.push({
          eventName: decoded.eventName,
          blockNumber: BigInt(log.blockNumber),
          blockHash: log.blockHash,
          logIndex: Number(log.logIndex),
          transactionHash: log.transactionHash,
          args: decoded.args as Record<string, unknown>,
        })
      } catch {
        // Ignore logs that cannot be decoded with the canonical deployment ABI.
      }
    }
  }

  const blockNumbers = [...new Set(decodedEvents.map((event) => event.blockNumber))]
  const blocks = await Promise.all(blockNumbers.map((blockNumber) => publicClient.getBlock({ blockNumber })))
  const timestampByBlock = new Map(blocks.map((block) => [block.number, block.timestamp]))
  return decodedEvents
    .map((event) => ({ ...event, timestamp: timestampByBlock.get(event.blockNumber) ?? 0n }))
    .sort((a, b) => a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1)
}
