// B4: independent verification, mounted directly in the incident page (no
// separate /verify route for M1-M3 -- decision #8). Four checks, each
// computed in the browser and/or read from chain -- never taken on the
// API's word alone (Web3_task.md Nguyên tắc 2).
import { Check, X } from 'lucide-react'
import { useBlockNumber, useReadContract } from 'wagmi'
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
    <div className="flex items-start gap-3 border-b border-line-2 py-3.5 last:border-b-0">
      {ok === undefined ? (
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-line-2" />
      ) : ok ? (
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-bright text-ink">
          <Check className="size-3.5" strokeWidth={3} aria-hidden />
        </span>
      ) : (
        <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-danger-bright text-paper">
          <X className="size-3.5" strokeWidth={3} aria-hidden />
        </span>
      )}
      <div className="min-w-0">
        <p className="text-[14px] font-medium text-ink">{label}</p>
        {detail ? <p className="mt-0.5 break-all font-mono text-[12px] text-ink-2">{detail}</p> : null}
      </div>
    </div>
  )
}

interface EvidenceSourceProps {
  index: number
  label: string
  ok: boolean | undefined
  hash: string | undefined
}

function EvidenceSource({ index, label, ok, hash }: EvidenceSourceProps) {
  const tone = ok === undefined ? 'bg-line-2 text-ink-2' : ok ? 'bg-brand-tint text-brand' : 'bg-danger-tint text-danger'
  return (
    <div className={`rounded-lg px-3 py-2 ${tone}`}>
      <p className="text-[11px] font-semibold">
        {index}. {label}
      </p>
      <p className="mt-0.5 break-all font-mono text-[11px] text-ink-2">{hash ?? '…'}</p>
    </div>
  )
}

interface VerifyHeroProps {
  state: 'ok' | 'fail' | 'loading'
  passedCount: number
  blockNumber: bigint | undefined
}

function VerifyHero({ state, passedCount, blockNumber }: VerifyHeroProps) {
  const tone =
    state === 'ok'
      ? { bg: 'bg-brand-tint', circle: 'bg-brand-bright text-ink', text: 'text-brand', bar: 'bg-brand-bright' }
      : state === 'fail'
        ? { bg: 'bg-danger-tint', circle: 'bg-danger-bright text-paper', text: 'text-danger', bar: 'bg-danger-bright' }
        : { bg: 'bg-line-2', circle: 'bg-line text-ink-3', text: 'text-ink-2', bar: 'bg-ink-4' }

  return (
    <div className={`flex w-full shrink-0 flex-col gap-3 rounded-xl p-5 sm:w-[240px] ${tone.bg}`}>
      <span className={`flex size-14 items-center justify-center rounded-full ${tone.circle}`}>
        {state === 'ok' ? (
          <Check className="size-7" strokeWidth={3} aria-hidden />
        ) : state === 'fail' ? (
          <X className="size-7" strokeWidth={3} aria-hidden />
        ) : (
          <span className="size-3 animate-pulse rounded-full bg-current" />
        )}
      </span>
      <div>
        <p className={`text-[16px] font-bold ${tone.text}`}>
          {state === 'ok' ? 'Dữ liệu toàn vẹn' : state === 'fail' ? 'Không khớp' : 'Đang kiểm tra…'}
        </p>
        <p className="mt-1 text-[12px] text-ink-2">
          {state === 'ok'
            ? 'Những gì thiết bị đã ký, những gì chain ghi lại và những gì server lưu đều khớp byte-for-byte.'
            : state === 'fail'
              ? 'Có ít nhất 1 phép so khớp thất bại. Xem chi tiết bên cạnh.'
              : 'Đang đối chiếu dữ liệu local với on-chain.'}
        </p>
      </div>
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`h-1.5 flex-1 rounded-full ${i < passedCount ? tone.bar : 'bg-line'}`} />
        ))}
      </div>
      <p className="font-mono text-[11px] text-ink-3">
        {passedCount}/4 checks{blockNumber !== undefined ? ` · block ${blockNumber.toString()}` : ''}
      </p>
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
  const { data: blockNumber } = useBlockNumber()

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

  const checks = [deviceIdHashOk, incidentIdOk, evidenceHashOk, signerOk]
  const allOk = checks.every((v) => v === true)
  const anyFalse = checks.some((v) => v === false)
  const passedCount = checks.filter((v) => v === true).length
  const heroState = allOk ? 'ok' : anyFalse ? 'fail' : 'loading'

  const heroStyle = allOk
    ? {
        backgroundImage:
          'linear-gradient(#fff,#fff), linear-gradient(135deg, var(--color-brand-bright), var(--color-accent-bright) 60%, var(--color-line))',
        backgroundOrigin: 'padding-box, border-box',
        backgroundClip: 'padding-box, border-box',
        border: '1.5px solid transparent',
      }
    : undefined

  return (
    <Card
      elevated
      className={`flex flex-col ${!allOk ? (anyFalse ? 'border-danger-bright/50' : 'border-line') : ''}`}
      style={heroStyle}
    >
      <h2 className="mb-3 text-[17px] font-bold tracking-tight text-ink">Xác minh độc lập</h2>
      <div className="flex flex-col gap-4 sm:flex-row">
        <VerifyHero state={heroState} passedCount={passedCount} blockNumber={blockNumber} />
        <div className="flex min-w-0 flex-1 flex-col">
          <VerifyRow label="deviceIdHash khớp device_id" ok={deviceIdHashOk} detail={deviceIdHash} />
          <VerifyRow label="incidentId khớp (deviceIdHash, sequence)" ok={incidentIdOk} detail={incidentIdExpected} />
          <div className="border-b border-line-2 py-3.5">
            <p className="mb-2 text-[14px] font-medium text-ink">evidenceHash — 3 nguồn độc lập</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <EvidenceSource index={1} label="Tính lại ở trình duyệt" ok={evidenceHashOk} hash={localHash} />
              <EvidenceSource index={2} label="Đọc trực tiếp từ chain" ok={chainHashResult === undefined ? undefined : chainHashOk} hash={chainHashResult} />
              <EvidenceSource
                index={3}
                label="Chain ghi lúc xảy ra"
                ok={chainIncident === undefined ? undefined : storedHashOk}
                hash={chainIncident?.evidenceHash}
              />
            </div>
          </div>
          <VerifyRow label="signer trên chain khớp signer đã ký" ok={signerOk} detail={chainIncident?.signer} />
        </div>
      </div>
    </Card>
  )
}
