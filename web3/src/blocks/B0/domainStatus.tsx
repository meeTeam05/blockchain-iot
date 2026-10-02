// B0: shared domain-match flag. <TxButton> (B5) must check useDomainOk()
// before enabling any send action -- "sai domain thì dApp bị khóa"
// (tmp/Web3_task.md B0 "Xong khi").
import { createContext, useContext, type ReactNode } from 'react'
import { useReadContract } from 'wagmi'
import { AIR_SAFETY_LOG_ABI } from '../../generated/incident-deployments'
import { activeNetwork } from '../../config/networks'
import { chain } from '../../lib/wagmiConfig'

// Exported so integration tests can force domainOk=true when testing against
// a dynamically-deployed contract the real provider's static-address check
// doesn't know about (decision #13) -- app code should use useDomainOk().
export const DomainStatusContext = createContext(false)

export function useDomainOk() {
  return useContext(DomainStatusContext)
}

export function DomainStatusProvider({ children }: { children: ReactNode }) {
  const { data, isError } = useReadContract({
    address: activeNetwork.address,
    abi: AIR_SAFETY_LOG_ABI,
    functionName: 'eip712Domain',
    chainId: chain.id,
  })

  const domainOk =
    !isError &&
    data !== undefined &&
    data[1] === activeNetwork.name &&
    data[2] === activeNetwork.version &&
    Number(data[3]) === activeNetwork.chainId &&
    data[4].toLowerCase() === activeNetwork.address.toLowerCase()

  return <DomainStatusContext.Provider value={domainOk}>{children}</DomainStatusContext.Provider>
}

export function DomainMismatchBanner() {
  const domainOk = useDomainOk()
  if (domainOk) return null
  return (
    <div className="bg-danger px-4 py-3 text-center text-[15px] font-semibold text-paper">
      Sai domain hoặc sai mạng -- mọi hành động gửi giao dịch đã bị khóa.
    </div>
  )
}
