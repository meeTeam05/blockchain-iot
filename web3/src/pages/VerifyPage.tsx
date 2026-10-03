// B4 standalone route: /dapp/verify/:deviceId/:incidentId. Opens directly (new
// tab, reload, shared link) without going through the incident page; reads the
// evidence from the API and every security fact from chain. No wallet needed.
import { useNavigate, useParams } from 'react-router'
import { AppBar } from '../components/ui/AppBar'
import { SessionActions } from '../blocks/B1/SessionActions'
import { VerifyPanel } from '../blocks/B4/VerifyPanel'
import { incidentRoute } from '../config/routes'
import { useIncidentDetail } from '../lib/incidentsApi'

const INCIDENT_ID = /^0x[0-9a-fA-F]{64}$/

export function VerifyPage() {
  const { deviceId = '', incidentId = '' } = useParams<{ deviceId: string; incidentId: string }>()
  const navigate = useNavigate()
  const validId = INCIDENT_ID.test(incidentId)
  const detail = useIncidentDetail(deviceId, validId ? incidentId : '')

  return (
    <>
      <AppBar variant="back" title="Xác minh sự cố" actions={<SessionActions />} onBack={() => navigate(incidentRoute(deviceId, incidentId))} />
      <main className="mx-auto w-full max-w-5xl p-6">
        <p className="mb-4 break-all font-mono text-[12px] text-ink-3" data-testid="verify-target">
          device {deviceId} · incident {incidentId}
        </p>
        {!validId ? <p role="alert" className="text-danger">incidentId không hợp lệ (cần bytes32 0x…).</p> : null}
        {validId && detail.isPending ? <p className="text-ink-2">Đang tải evidence từ API…</p> : null}
        {validId && detail.isError ? <p role="alert" className="text-danger">{detail.error.message}</p> : null}
        {validId && detail.data ? <VerifyPanel deviceId={deviceId} incidentId={incidentId} incident={detail.data} /> : null}
      </main>
    </>
  )
}
