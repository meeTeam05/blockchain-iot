// B0: link to a tx/address/block on Etherscan. On localhost (no explorer),
// renders the raw value as plain mono text instead of a dead link.
import { activeNetwork } from '../config/networks'

interface ExplorerLinkProps {
  kind: 'tx' | 'address' | 'block'
  value: string | number
  label?: string
}

export function ExplorerLink({ kind, value, label }: ExplorerLinkProps) {
  const text = label ?? String(value)
  if (!activeNetwork.explorerBaseUrl) {
    return <span className="font-mono text-ink-2">{text}</span>
  }
  const path = kind === 'tx' ? 'tx' : kind === 'address' ? 'address' : 'block'
  const href = `${activeNetwork.explorerBaseUrl}/${path}/${value}`
  return (
    <a href={href} target="_blank" rel="noreferrer" className="font-mono text-accent underline">
      {text}
    </a>
  )
}
