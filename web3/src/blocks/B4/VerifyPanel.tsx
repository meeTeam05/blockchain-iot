// B4: independent verification, used by the incident page and by the
// standalone /verify/:deviceId/:incidentId route. Four checks, each computed in
// the browser and/or read from chain -- never taken on the API's word alone.
// The outcome comes from lib/verification.ts.
import { Fragment, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { Hex } from 'viem'
import { useBlockNumber, useReadContract } from 'wagmi'
import { Panel } from '../../components/ui/Panel'
import { activeNetwork } from '../../config/networks'
import { buildVerifyLink } from '../../config/routes'
import { AIR_SAFETY_LOG_ABI } from '../../generated/incident-deployments'
import { computeDeviceIdHash, computeIncidentKey } from '../../lib/chainIncident'
import { computeEvidenceHash, evidenceToTuple, type EvidenceRecord } from '../../lib/evidence'
import { computeIncidentAttestationDigest, recoverIncidentSigner } from '../../lib/incidentSignature'
import type { ApiIncidentDetail } from '../../lib/incidentsApi'
import { evaluateVerification, type ReadResult, type VerificationState } from '../../lib/verification'
import { useDomainStatus } from '../B0/domainStatus'

const ZERO_HASH = /^0x0+$/

function shortHash(hash: string) {
  return hash.length > 24 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : hash
}

type StepTone = 'ok' | 'fail' | 'partial' | 'pending'

const STEP_ICON: Record<StepTone, { glyph: string; className: string }> = {
  ok: { glyph: '✓', className: 'bg-[#dcf5e3] text-[#15803d]' },
  fail: { glyph: '✕', className: 'bg-[#fff1f3] text-[#c81e3a]' },
  partial: { glyph: '!', className: 'bg-[#fdf4dc] text-[#8a5a00]' },
  pending: { glyph: '–', className: 'bg-[#eef1ec] text-[#8a958c]' },
}

function stepTone(ok: boolean | undefined): StepTone {
  return ok === undefined ? 'pending' : ok ? 'ok' : 'fail'
}

function VerifyStep({ tone, title, children }: { tone: StepTone; title: string; children: ReactNode }) {
  const icon = STEP_ICON[tone]
  return (
    <div className="flex gap-3.5 border-b border-[#f1f3ef] px-6 py-4">
      <span
        className={`grid size-[22px] shrink-0 place-items-center rounded-full text-[12px] font-bold ${icon.className}`}
        aria-hidden
      >
        {icon.glyph}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="text-[14px] font-semibold text-[#17201a]">{title}</div>
        {children}
      </div>
    </div>
  )
}

function ValueGrid({ rows }: { rows: { label: string; value: ReactNode; muted?: boolean }[] }) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-[12px] font-medium leading-[1.6]">
      {rows.map((row) => (
        <Fragment key={row.label}>
          <span className="text-[#8a958c]">{row.label}</span>
          <div className={`break-all ${row.muted ? 'text-[#8a958c]' : 'text-[#17201a]'}`}>{row.value}</div>
        </Fragment>
      ))}
    </div>
  )
}

function chainValue(value: string | undefined): { value: ReactNode; muted: boolean } {
  if (value === undefined) return { value: '—', muted: true }
  if (ZERO_HASH.test(value)) return { value: '0x0000…0000 (chưa có bản ghi)', muted: true }
  return { value, muted: false }
}

interface EvidenceSourceProps {
  label: string
  ok: boolean | undefined
  hash: string | undefined
  last?: boolean
}

function EvidenceSource({ label, ok, hash, last = false }: EvidenceSourceProps) {
  const status =
    ok === true
      ? { text: 'Khớp', className: 'text-[#15803d]' }
      : ok === false
        ? { text: 'Không khớp', className: 'text-[#c81e3a]' }
        : { text: hash ? 'Chưa so' : 'Chưa có', className: 'text-[#8a958c]' }
  return (
    <div
      className={`flex flex-wrap items-baseline gap-3 px-3.5 py-2.5 ${last ? 'bg-[#fafbf9]' : 'border-b border-[#eef1ec]'}`}
    >
      <span className="w-[170px] shrink-0 text-[13px] text-[#17201a]">{label}</span>
      <div
        className={`min-w-0 flex-[1_1_200px] break-all font-mono text-[12px] font-medium ${hash ? 'text-[#17201a]' : 'text-[#8a958c]'}`}
      >
        {hash ? shortHash(hash) : '—'}
      </div>
      <span className={`text-[12px] font-semibold ${status.className}`}>{status.text}</span>
    </div>
  )
}

const HERO_TEXT: Record<VerificationState, { title: string; body: string }> = {
  ok: { title: 'Dữ liệu toàn vẹn', body: 'Dữ liệu thiết bị ký, chain ghi và server lưu khớp nhau.' },
  identity_mismatch: { title: 'Không khớp ở bước 1–2', body: 'deviceId/incidentId của evidence không khớp thiết bị hoặc sequence.' },
  invalid_evidence: { title: 'Không khớp ở bước 3', body: 'Evidence từ API không băm ra evidenceHash đã ghi trên chain.' },
  signer_mismatch: { title: 'Không khớp ở bước 4', body: 'Chữ ký không khôi phục ra signer đã ghi cùng sự cố trên chain.' },
  not_found: { title: 'Sự cố chưa có trên chain', body: 'Chưa có bản ghi on-chain để đối chiếu.' },
  rpc_error: { title: 'RPC không khả dụng', body: 'Không đọc được chain. Chưa phải kết quả xác minh, hãy thử lại.' },
  deployment_unavailable: { title: 'Sai mạng / deployment', body: 'RPC không khớp deployment đã cấu hình, không thể xác minh.' },
  loading: { title: 'Đang kiểm tra…', body: 'Đang đối chiếu dữ liệu local với on-chain.' },
}

const FAILED: VerificationState[] = ['identity_mismatch', 'invalid_evidence', 'signer_mismatch']

interface VerifyHeaderProps {
  state: VerificationState
  passedCount: number
}

function VerifyHeader({ state, passedCount }: VerifyHeaderProps) {
  const failed = FAILED.includes(state)
  const tone =
    state === 'ok'
      ? { count: 'text-[#15803d]', bar: 'bg-[#16a34a]' }
      : failed
        ? { count: 'text-[#c81e3a]', bar: 'bg-[#c81e3a]' }
        : { count: 'text-[#8a5a00]', bar: 'bg-[#16a34a]' }
  const text = HERO_TEXT[state]

  return (
    <div
      className="flex flex-col gap-2.5 border-b border-[#eef1ec] px-6 py-[18px]"
      data-testid="verify-state"
      data-state={state}
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="m-0 flex-1 text-[16px] font-semibold leading-[1.4] text-[#17201a]">Xác minh độc lập</h2>
        <span className={`text-[13px] font-semibold ${tone.count}`}>{passedCount}/4 kiểm tra đạt</span>
      </div>
      <div className="grid grid-cols-4 gap-1">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={`h-1.5 rounded-[3px] ${i < passedCount ? tone.bar : 'bg-[#e3e8e1]'}`} />
        ))}
      </div>
      <div role={state === 'rpc_error' || state === 'deployment_unavailable' ? 'alert' : undefined}>
        <p className="m-0 text-[13px] text-[#5d6a60]">
          <span className="font-semibold text-[#17201a]">{text.title}</span> · {text.body}
        </p>
      </div>
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
    <div className="flex flex-col items-end gap-1.5">
      <button
        type="button"
        onClick={() => void copy()}
        className="h-9 cursor-pointer rounded-[10px] border border-[#dfe4dc] bg-white px-3.5 text-[13px] font-semibold text-[#17201a] transition-colors hover:bg-[#f4f6f3]"
      >
        Sao chép link xác minh
      </button>
      {status === 'copied' ? <p role="status" className="m-0 text-[12px] font-medium text-[#15803d]">Đã sao chép link xác minh.</p> : null}
      {status === 'failed' ? (
        <p role="alert" className="m-0 break-all text-[12px] text-[#c81e3a]">
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
  const logged = chainIncident !== undefined && Number(chainIncident.status) !== 0
  const incidentChain = chainValue(chainIncident?.incidentId)
  const evidenceSourceOk = [checks.evidenceHash, result.contractHashOk, result.storedHashOk]
  const evidenceTone: StepTone =
    checks.evidenceHash === undefined && evidenceSourceOk.some((v) => v === true) ? 'partial' : stepTone(checks.evidenceHash)

  return (
    <Panel>
      <VerifyHeader state={state} passedCount={passedCount} />

      <VerifyStep tone={stepTone(checks.deviceIdHash)} title="deviceIdHash khớp device_id">
        <ValueGrid
          rows={[
            { label: 'local', value: result.expectedDeviceIdHash },
            { label: 'evidence', value: String(evidence.device_id_hash) },
          ]}
        />
      </VerifyStep>

      <VerifyStep tone={stepTone(checks.incidentId)} title="incidentId khớp (deviceIdHash, sequence)">
        <ValueGrid
          rows={[
            { label: 'local', value: result.expectedIncidentId },
            chainIncident
              ? { label: 'chain', value: incidentChain.value, muted: incidentChain.muted }
              : { label: 'evidence', value: incidentIdFromEvidence },
          ]}
        />
      </VerifyStep>

      <VerifyStep tone={evidenceTone} title="evidenceHash — 3 nguồn độc lập">
        <div className="overflow-hidden rounded-xl border border-[#eef1ec]">
          <EvidenceSource label="Tính lại ở trình duyệt" ok={checks.evidenceHash} hash={localHash} />
          <EvidenceSource label="Đọc trực tiếp từ chain" ok={result.contractHashOk} hash={contractHash.data} />
          <EvidenceSource
            label="Chain ghi lúc xảy ra"
            ok={result.storedHashOk}
            hash={logged ? chainIncident.evidenceHash : undefined}
            last
          />
        </div>
      </VerifyStep>

      <VerifyStep tone={stepTone(checks.signer)} title="Chữ ký EIP-712 khớp signer lịch sử trên chain">
        <ValueGrid
          rows={[
            { label: 'signer', value: recoveredSigner.data ?? '—', muted: recoveredSigner.data === undefined },
            ...(logged ? [{ label: 'chain', value: chainIncident.signer }] : []),
            { label: 'digest', value: localDigest },
          ]}
        />
        <p className="m-0 break-all font-mono text-[10px] text-[#8a958c]">
          digest API (tham khảo): {incident.eip712_digest} · signer API (không tin cậy): {incident.signer_address}
        </p>
      </VerifyStep>

      <div className="flex flex-wrap items-center gap-3 px-6 py-3.5">
        <span className="font-mono text-[12px] font-medium text-[#8a958c]">
          {blockNumber !== undefined ? `block ${blockNumber.toString()}` : ''}
        </span>
        <div className="ml-auto">
          <CopyVerifyLink deviceId={deviceId} incidentId={incidentId ?? incidentIdFromEvidence} />
        </div>
      </div>
    </Panel>
  )
}
