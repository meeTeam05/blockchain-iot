import { useAccount, useBalance, useConnect, useDisconnect, useSwitchChain } from 'wagmi'
import { formatEther } from 'viem'
import { GhostButton } from '../../components/ui/GhostButton'
import { Pill } from '../../components/ui/Pill'
import { chain } from '../../lib/wagmiConfig'

const LOW_BALANCE_ETH = 0.002

function shortenAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function ConnectWallet() {
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()
  const { data: balance } = useBalance({ address, query: { enabled: isConnected } })

  if (!isConnected) {
    return (
      <GhostButton
        label={isPending ? 'Đang kết nối…' : 'Kết nối ví'}
        onClick={() => connect({ connector: connectors[0] })}
      />
    )
  }

  const wrongNetwork = chainId !== chain.id
  const lowBalance = balance !== undefined && Number(formatEther(balance.value)) < LOW_BALANCE_ETH

  return (
    <div className="flex items-center gap-2">
      {wrongNetwork ? (
        <button
          type="button"
          onClick={() => switchChain({ chainId: chain.id })}
          className="rounded-pill bg-danger-tint px-3 py-1 text-[13px] font-semibold text-[#BF3923]"
        >
          Sai mạng, bấm để đổi
        </button>
      ) : (
        <Pill tone="online" label={chain.name} />
      )}
      {lowBalance ? <Pill tone="warn" label="ETH thấp" /> : null}
      <button
        type="button"
        onClick={() => disconnect()}
        className="rounded-pill bg-ink px-3 py-1 font-mono text-[13px] text-paper"
      >
        {shortenAddress(address!)}
      </button>
    </div>
  )
}
