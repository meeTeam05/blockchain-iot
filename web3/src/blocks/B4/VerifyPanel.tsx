// B4: independent verification, used by the incident page and by the
// standalone /verify/:deviceId/:incidentId route. Four checks, each computed in
// the browser and/or read from chain -- never taken on the API's word alone
// (Web3_task.md Nguyên tắc 2). The outcome comes from lib/verification.ts.
import { Check, Copy, X } from 'lucide-react'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Hex } from 'viem'
import { useBlockNumber, useReadContract } from 'wagmi'
import { Card } from '../../components/ui/Card'
import { activeNetwork } from '../../config/networks'
import { buildVerifyLink } from '../../config/routes'
import { AIR_SAFETY_LOG_ABI } from '../../generated/incident-deployments'
import { computeDeviceIdHash, computeIncidentKey } from '../../lib/chainIncident'
import { computeEvidenceHash, evidenceToTuple, type EvidenceRecord } from '../../lib/evidence'
import { computeIncidentAttestationDigest, recoverIncidentSigner } from '../../lib/incidentSignature'
import type { ApiIncidentDetail } from '../../lib/incidentsApi'
import { evaluateVerification, type ReadResult, type VerificationState } from '../../lib/verification'
import { useDomainStatus } from '../B0/domainStatus'

interface VerifyRowProps {
  label: string
  ok: boolean | undefined
  localValue?: string
  canonicalValue?: string
}

function VerifyRow({ label, ok, localValue, canonicalValue }: VerifyRowProps) {
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
        {localValue ? <p className="mt-0.5 break-all font-mono text-[11px] text-ink-2">local: {localValue}</p> : null}
        {canonicalValue ? <p className="mt-0.5 break-all font-mono text-[11px] text-ink-3">canonical: {canonicalValue}</p> : null}
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

const HERO_TEXT: Record<VerificationState, { title: string; body: string }> = {
  ok: { title: 'Dữ liệu toàn vẹn', body: 'Những gì thiết bị đã ký, những gì chain ghi lại và những gì server lưu đều khớp byte-for-byte.' },
  identity_mismatch: { title: 'Không khớp ở bước 1–2', body: 'deviceId/incidentId của evidence không khớp thiết bị hoặc sequence.' },
  invalid_evidence: { title: 'Không khớp ở bước 3', body: 'Evidence từ API không băm ra evidenceHash đã ghi trên chain.' },
  signer_mismatch: { title: 'Không khớp ở bước 4', body: 'Chữ ký không khôi phục ra signer đã ghi cùng sự cố trên chain.' },
  not_found: { title: 'Sự cố chưa có trên chain', body: 'getIncident() chưa có bản ghi này; chưa thể đối chiếu evidenceHash và signer.' },
  rpc_error: { title: 'RPC không khả dụng', body: 'Không đọc được chain lúc này. Đây không phải kết quả xác minh; hãy thử lại.' },
  deployment_unavailable: { title: 'Sai mạng / deployment', body: 'RPC không trỏ tới AirSafetyLog và domain EIP-712 đã cấu hình; không thể xác minh.' },
  loading: { title: 'Đang kiểm tra…', body: 'Đang đối chiếu dữ liệu local với on-chain.' },
}

const FAILED: VerificationState[] = ['identity_mismatch', 'invalid_evidence', 'signer_mismatch']

interface VerifyHeroProps {
  state: VerificationState
  passedCount: number
  blockNumber: bigint | undefined
}

function VerifyHero({ state, passedCount, blockNumber }: VerifyHeroProps) {
  const failed = FAILED.includes(state)
  const tone =
    state === 'ok'
      ? { bg: 'bg-brand-tint', circle: 'bg-brand-bright text-ink', text: 'text-brand', bar: 'bg-brand-bright' }
      : failed
        ? { bg: 'bg-danger-tint', circle: 'bg-danger-bright text-paper', text: 'text-danger', bar: 'bg-danger-bright' }
        : { bg: 'bg-line-2', circle: 'bg-line text-ink-3', text: 'text-ink-2', bar: 'bg-ink-4' }
  const text = HERO_TEXT[state]

  return (
    <div className={`flex w-full shrink-0 flex-col gap-3 rounded-xl p-5 sm:w-[240px] ${tone.bg}`} data-testid="verify-state" data-state={state}>
      <span className={`flex size-14 items-center justify-center rounded-full ${tone.circle}`}>
        {state === 'ok' ? (
          <Check className="size-7" strokeWidth={3} aria-hidden />
        ) : failed ? (
          <X className="size-7" strokeWidth={3} aria-hidden />
        ) : (
          <span className="size-3 animate-pulse rounded-full bg-current" />
        )}
      </span>
      <div role={state === 'rpc_error' || state === 'deployment_unavailable' ? 'alert' : undefined}>
        <p className={`text-[16px] font-bold ${tone.text}`}>{text.title}</p>
        <p className="mt-1 text-[12px] text-ink-2">{text.body}</p>
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

export function CopyVerifyLink({ deviceId, incidentId }: { deviceId: string; incidentId: string }) {
  const link = buildVerifyLink(window.location.origin, deviceId, incidentId)
  const [status, setStatus] = useState<'idle' | 'copied' | 'failed'>('idle')
  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable')
      await navigator.clipboard.writeText(link)
      setStatus('copied')
    } catch {
      setStatus('failed')
    }
  }
  return (
    <div className="mt-3 flex flex-col gap-1">
      <button type="button" onClick={() => void copy()}
        className="inline-flex w-fit items-center gap-2 rounded-pill border border-line px-3 py-1.5 text-[13px] font-medium text-ink">
        <Copy className="size-3.5" aria-hidden /> Sao chép link xác minh
      </button>
      {status === 'copied' ? <p role="status" className="text-[12px] text-brand">Đã sao chép link xác minh.</p> : null}
      {status === 'failed' ? (
        <p role="alert" className="break-all text-[12px] text-danger">
          Không sao chép được vào clipboard. Hãy sao chép thủ công: <span className="font-mono">{link}</span>
        </p>
      ) : null}
    </div>
  )
}

function readResult<T>(query: { isPending: boolean; isError: boolean; data: T | undefined }): ReadResult<T> {
  if (query.isError) return { status: 'error' }
  if (query.isPending || query.data === undefined) return { status: 'pending' }
  return { status: 'success', value: query.data }
}

interface VerifyPanelProps {
  deviceId: string
  incident: ApiIncidentDetail
  // Route incident id (standalone /verify); must equal the evidence incident_id.
  incidentId?: string
}

export function VerifyPanel({ deviceId, incident, incidentId }: VerifyPanelProps) {
  const evidence = incident.evidence as EvidenceRecord
  const deviceIdHash = computeDeviceIdHash(deviceId)
  const incidentIdFromEvidence = String(evidence.incident_id)
  const incidentKey = computeIncidentKey(deviceIdHash, incidentIdFromEvidence as `0x${string}`)
  const { publicStatus } = useDomainStatus()

  const localHash = computeEvidenceHash(evidence)
  const localDigest = computeIncidentAttestationDigest(
    {
      name: activeNetwork.name,
      version: activeNetwork.version,
      chainId: activeNetwork.chainId,
      verifyingContract: activeNetwork.address,
    },
    evidence,
    localHash,
  )

  const recoveredSigner = useQuery({
    queryKey: ['incident-signer-recovery', localDigest, incident.signature],
    queryFn: () => recoverIncidentSigner(localDigest, incident.signature as Hex),
    retry: false,
  })

  const contractHash = useReadContract({
    address: activeNetwork.address,
    abi: AIR_SAFETY_LOG_ABI,
    functionName: 'hashEvidence',
    args: [evidenceToTuple(evidence) as never],
    query: { retry: false },
  })

  const chainIncidentQuery = useReadContract({
    address: activeNetwork.address,
    abi: AIR_SAFETY_LOG_ABI,
    functionName: 'getIncident',
    args: [incidentKey],
    query: { retry: false },
  })
  const chainIncident = chainIncidentQuery.data
  const { data: blockNumber } = useBlockNumber()

  const result = evaluateVerification({
    routeDeviceId: deviceId,
    routeIncidentId: incidentId,
    evidence,
    localHash,
    domain: publicStatus,
    contractHash: readResult(contractHash),
    chainIncident: readResult({
      isPending: chainIncidentQuery.isPending,
      isError: chainIncidentQuery.isError,
      data: chainIncident && {
        status: Number(chainIncident.status),
        evidenceHash: chainIncident.evidenceHash,
        signer: chainIncident.signer,
        incidentId: chainIncident.incidentId,
      },
    }),
    recoveredSigner: readResult(recoveredSigner),
  })
  const { checks, state } = result
  const values = [checks.deviceIdHash, checks.incidentId, checks.evidenceHash, checks.signer]
  const passedCount = values.filter((v) => v === true).length
  const allOk = state === 'ok'
  const anyFalse = FAILED.includes(state)

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
        <VerifyHero state={state} passedCount={passedCount} blockNumber={blockNumber} />
        <div className="flex min-w-0 flex-1 flex-col">
          <VerifyRow
            label="deviceIdHash khớp device_id"
            ok={checks.deviceIdHash}
            localValue={result.expectedDeviceIdHash}
            canonicalValue={String(evidence.device_id_hash)}
          />
          <VerifyRow
            label="incidentId khớp (deviceIdHash, sequence)"
            ok={checks.incidentId}
            localValue={result.expectedIncidentId}
            canonicalValue={chainIncident?.incidentId ?? incidentIdFromEvidence}
          />
          <div className="border-b border-line-2 py-3.5">
            <p className="mb-2 text-[14px] font-medium text-ink">evidenceHash — 3 nguồn độc lập</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <EvidenceSource index={1} label="Tính lại ở trình duyệt" ok={checks.evidenceHash} hash={localHash} />
              <EvidenceSource index={2} label="Đọc trực tiếp từ chain" ok={result.contractHashOk} hash={contractHash.data} />
              <EvidenceSource
                index={3}
                label="Chain ghi lúc xảy ra"
                ok={result.storedHashOk}
                hash={chainIncident && Number(chainIncident.status) !== 0 ? chainIncident.evidenceHash : undefined}
              />
            </div>
          </div>
          <VerifyRow
            label="Chữ ký EIP-712 khớp signer lịch sử trên chain"
            ok={checks.signer}
            localValue={recoveredSigner.data}
            canonicalValue={chainIncident && Number(chainIncident.status) !== 0 ? chainIncident.signer : undefined}
          />
          <p className="mt-2 break-all font-mono text-[10px] text-ink-4">
            digest local: {localDigest} · digest API (tham khảo): {incident.eip712_digest} · signer API (không tin cậy):{' '}
            {incident.signer_address}
          </p>
          <CopyVerifyLink deviceId={deviceId} incidentId={incidentId ?? incidentIdFromEvidence} />
        </div>
      </div>
    </Card>
  )
}
