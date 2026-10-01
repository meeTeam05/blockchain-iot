// B4: independent verification, mounted directly in the incident page (no
// separate /verify route for M1-M3 -- decision #8). Four checks, each
// computed in the browser and/or read from chain -- never taken on the
// API's word alone (Web3_task.md Nguyên tắc 2).
import { Check, X } from 'lucide-react'
import { useReadContract } from 'wagmi'
import { Card } from '../../components/ui/Card'
import { activeNetwork } from '../../config/networks'
import { AIR_SAFETY_LOG_ABI } from '../../generated/incident-deployments'
import { computeDeviceIdHash, computeIncidentId, computeIncidentKey } from '../../lib/chainIncident'
import { computeEvidenceHash, evidenceToTuple, type EvidenceRecord } from '../../lib/evidence'
import type { ApiIncidentDetail } from '../../lib/incidentsApi'

interface VerifyRowProps {
  label: string
  ok: boolean | undefined
  detail?: string
}

function VerifyRow({ label, ok, detail }: VerifyRowProps) {
  return (
    <div className="flex items-start gap-2 py-1.5">
      {ok === undefined ? (
        <span className="mt-0.5 size-4 shrink-0 rounded-full bg-line-2" />
      ) : ok ? (
        <Check className="mt-0.5 size-4 shrink-0 text-online" aria-hidden />
      ) : (
        <X className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
      )}
      <div>
        <p className="text-[15px] text-ink">{label}</p>
        {detail ? <p className="font-mono text-[12px] text-ink-3">{detail}</p> : null}
      </div>
    </div>
  )
}

interface VerifyPanelProps {
  deviceId: string
  incident: ApiIncidentDetail
}

export function VerifyPanel({ deviceId, incident }: VerifyPanelProps) {
  const evidence = incident.evidence as EvidenceRecord
  const deviceIdHash = computeDeviceIdHash(deviceId)
  const incidentIdFromEvidence = String(evidence.incident_id)
  const incidentIdExpected = computeIncidentId(deviceIdHash, String(evidence.sequence))
  const incidentKey = computeIncidentKey(deviceIdHash, incidentIdFromEvidence as `0x${string}`)

  const localHash = computeEvidenceHash(evidence)

  const { data: chainHashResult } = useReadContract({
    address: activeNetwork.address,
    abi: AIR_SAFETY_LOG_ABI,
    functionName: 'hashEvidence',
    args: [evidenceToTuple(evidence) as never],
  })

  const { data: chainIncident } = useReadContract({
    address: activeNetwork.address,
    abi: AIR_SAFETY_LOG_ABI,
    functionName: 'getIncident',
    args: [incidentKey],
  })

  const deviceIdHashOk = deviceIdHash.toLowerCase() === String(evidence.device_id_hash).toLowerCase()
  const incidentIdOk = incidentIdExpected.toLowerCase() === incidentIdFromEvidence.toLowerCase()
  const chainHashOk = chainHashResult !== undefined && chainHashResult.toLowerCase() === localHash.toLowerCase()
  const storedHashOk =
    chainIncident !== undefined && chainIncident.evidenceHash.toLowerCase() === localHash.toLowerCase()
  const evidenceHashOk = chainIncident === undefined || chainHashResult === undefined ? undefined : chainHashOk && storedHashOk
  const signerOk =
    chainIncident === undefined
      ? undefined
      : chainIncident.signer.toLowerCase() === incident.signer_address.toLowerCase()

  const allOk = [deviceIdHashOk, incidentIdOk, evidenceHashOk, signerOk].every((v) => v === true)
  const anyFalse = [deviceIdHashOk, incidentIdOk, evidenceHashOk, signerOk].some((v) => v === false)

  return (
    <Card className="flex flex-col">
      <h2 className="mb-2 text-[17px] font-semibold text-ink">Xác minh độc lập</h2>
      <VerifyRow label="deviceIdHash khớp device_id" ok={deviceIdHashOk} detail={deviceIdHash} />
      <VerifyRow label="incidentId khớp (deviceIdHash, sequence)" ok={incidentIdOk} detail={incidentIdExpected} />
      <VerifyRow
        label="evidenceHash khớp (local, chain, lưu trữ)"
        ok={evidenceHashOk}
        detail={localHash}
      />
      <VerifyRow
        label="signer trên chain khớp signer đã ký"
        ok={signerOk}
        detail={chainIncident?.signer}
      />
      <p className={`mt-3 text-[15px] font-semibold ${allOk ? 'text-online' : anyFalse ? 'text-danger' : 'text-ink-3'}`}>
        {allOk ? '✅ Dữ liệu toàn vẹn' : anyFalse ? '❌ Không khớp' : 'Đang kiểm tra…'}
      </p>
    </Card>
  )
}
