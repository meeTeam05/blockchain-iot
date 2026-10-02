// B5: owner-gated acknowledge/resolve. State machine per tmp/Web3_task.md
// mục 5: idle -> simulating -> awaiting_wallet -> pending -> confirmed ->
// indexing -> done (or error at any point before `pending`).
import { useEffect, useState } from 'react'
import { useAccount, useSimulateContract, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog'
import { PrimaryButton } from '../../components/ui/PrimaryButton'
import { activeNetwork } from '../../config/networks'
import { AIR_SAFETY_LOG_ABI } from '../../generated/incident-deployments'
import { decodeError } from '../../lib/errors'
import { useDomainOk } from '../B0/domainStatus'

type Action = 'acknowledgeIncident' | 'resolveIncident'
type Stage = 'idle' | 'confirming' | 'simulating' | 'awaiting_wallet' | 'pending' | 'confirmed' | 'indexing' | 'done' | 'error'

const INDEXING_TIMEOUT_MS = 2 * 60_000

interface OwnerActionsProps {
  incidentKey: `0x${string}`
  chainStatus: 'None' | 'Logged' | 'Acknowledged' | 'Resolved'
  isOwner: boolean
  ownerStatus: string
  onSettled: () => void
}

export function OwnerActions({ incidentKey, chainStatus, isOwner, ownerStatus, onSettled }: OwnerActionsProps) {
  const { isConnected } = useAccount()
  const domainOk = useDomainOk()
  const [action, setAction] = useState<Action | null>(null)
  const [stage, setStage] = useState<Stage>('idle')
  const [message, setMessage] = useState<string | null>(null)

  const { data: simulated, error: simError } = useSimulateContract({
    address: activeNetwork.address,
    abi: AIR_SAFETY_LOG_ABI,
    functionName: action ?? 'acknowledgeIncident',
    args: [incidentKey],
    query: { enabled: action !== null && stage === 'simulating' },
  })

  const { writeContract, data: txHash, error: writeError } = useWriteContract()
  const { isSuccess: confirmedOnChain } = useWaitForTransactionReceipt({ hash: txHash })

  useEffect(() => {
    if (stage !== 'simulating') return
    if (simError) {
      setMessage(decodeError(simError).message)
      setStage('error')
      return
    }
    if (simulated) {
      setStage('awaiting_wallet')
      // Explicit limit, not just the simulated estimate: wallets sometimes
      // compute their own (lower) gas for this call and ignore the dapp's
      // suggestion, which can revert out-of-gas. 100k is well above the
      // ~34k this call actually costs.
      writeContract({ ...simulated.request, gas: 100_000n })
    }
  }, [stage, simError, simulated, writeContract])

  useEffect(() => {
    if (writeError) {
      setMessage(decodeError(writeError).message)
      setStage('error')
    } else if (txHash && stage === 'awaiting_wallet') {
      setStage('pending')
    }
  }, [writeError, txHash, stage])

  useEffect(() => {
    if (confirmedOnChain && stage === 'pending') setStage('confirmed')
  }, [confirmedOnChain, stage])

  useEffect(() => {
    if (stage !== 'confirmed') return
    setStage('indexing')
    const expected = action === 'acknowledgeIncident' ? 'acknowledged' : 'resolved'
    const deadline = Date.now() + INDEXING_TIMEOUT_MS
    const interval = setInterval(() => {
      onSettled()
      if (ownerStatus === expected || Date.now() > deadline) {
        clearInterval(interval)
        setStage('done')
        if (ownerStatus !== expected) setMessage('API đang chậm, chain đã ghi')
      }
    }, 3000)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage])

  function startAction(next: Action) {
    setAction(next)
    setStage('confirming')
  }

  function confirm() {
    setStage('simulating')
  }

  function cancel() {
    setAction(null)
    setStage('idle')
  }

  if (!isConnected || !isOwner || !domainOk) return null

  const canAcknowledge = chainStatus === 'Logged'
  const canResolve = chainStatus === 'Logged' || chainStatus === 'Acknowledged'
  const busy = stage !== 'idle' && stage !== 'confirming' && stage !== 'error' && stage !== 'done'

  return (
    <div className="flex flex-col gap-2">
      {canAcknowledge ? (
        <PrimaryButton
          label="Xác nhận"
          loading={busy && action === 'acknowledgeIncident'}
          onClick={() => startAction('acknowledgeIncident')}
        />
      ) : null}
      {canResolve ? (
        <PrimaryButton
          label="Đã xử lý"
          loading={busy && action === 'resolveIncident'}
          onClick={() => startAction('resolveIncident')}
        />
      ) : null}
      {stage === 'error' && message ? <p className="text-[13px] text-danger">{message}</p> : null}
      {stage === 'done' && message ? <p className="text-[13px] text-warn">{message}</p> : null}

      <ConfirmDialog
        open={stage === 'confirming'}
        title={action === 'acknowledgeIncident' ? 'Xác nhận sự cố?' : 'Đánh dấu đã xử lý?'}
        message="Giao dịch sẽ được gửi qua ví đang kết nối."
        onCancel={cancel}
        onConfirm={confirm}
      />
    </div>
  )
}
