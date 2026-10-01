// B6: on-chain history, read directly via getLogs -- the one page that
// does NOT trust the API at all (decision #5's documented limitation: B3
// trusts the API's incident list, only this page is fully trustless).
// Chunked <=2000 blocks per call per tmp/Web3_task.md, starting from the
// deployment block already recorded in spec/incident/deployments/*.json.
//
// Uses the raw `eth_getLogs` RPC method (via client.request) instead of
// viem's getLogs() action: that action's typed overloads only support
// filtering by specific event ABIs/args, not a raw topics array.
//
// deviceIdHash sits at a different indexed position per event (topics[1] for
// Device* events, topics[2] for Incident*/Emergency* events -- it is NOT a
// fixed topic slot across the contract's event shapes), so there is no single
// topics filter that matches it everywhere. Fetch all of this contract's logs
// in range and filter by the decoded arg instead.
import { decodeEventLog, numberToHex, type Hex, type PublicClient } from 'viem'
import { AIR_SAFETY_LOG_ABI } from '../../generated/incident-deployments'
import { activeNetwork } from '../../config/networks'

const MAX_BLOCK_RANGE = 2000n

export interface HistoryEvent {
  eventName: string
  blockNumber: bigint
  transactionHash: Hex
  args: Record<string, unknown>
}

export async function fetchDeviceHistory(publicClient: PublicClient, deviceIdHash: Hex): Promise<HistoryEvent[]> {
  const latest = await publicClient.getBlockNumber()
  const fromDeployment = BigInt(activeNetwork.blockNumber)
  const events: HistoryEvent[] = []

  for (let from = fromDeployment; from <= latest; from += MAX_BLOCK_RANGE + 1n) {
    const to = from + MAX_BLOCK_RANGE > latest ? latest : from + MAX_BLOCK_RANGE
    const logs = await publicClient.request({
      method: 'eth_getLogs',
      params: [
        {
          address: activeNetwork.address,
          fromBlock: numberToHex(from),
          toBlock: numberToHex(to),
        },
      ],
    })
    for (const log of logs) {
      // Historical (non-pending) logs always carry a transactionHash; skip
      // defensively rather than widen HistoryEvent's type for a case that
      // shouldn't occur here.
      if (!log.transactionHash || !log.blockNumber) continue
      try {
        const decoded = decodeEventLog({ abi: AIR_SAFETY_LOG_ABI, data: log.data, topics: log.topics })
        const args = decoded.args as Record<string, unknown>
        if (args.deviceIdHash !== deviceIdHash) continue
        events.push({
          eventName: decoded.eventName,
          blockNumber: BigInt(log.blockNumber),
          transactionHash: log.transactionHash,
          args,
        })
      } catch {
        // Not one of our events (shouldn't happen at our own contract address) -- skip.
      }
    }
  }

  return events.sort((a, b) => Number(b.blockNumber - a.blockNumber))
}
