import { useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { AppBar } from '../components/ui/AppBar'
import { IncidentList } from '../blocks/B3/IncidentList'
import { HistoryTimeline } from '../blocks/B6/HistoryTimeline'
import { SessionActions } from '../blocks/B1/SessionActions'
import { DeviceIncentives } from '../blocks/B9/DeviceIncentives'
import { incentivesDeployment } from '../lib/incentives'

type Tab = 'incidents' | 'history'

export function DevicePage() {
  const { deviceId } = useParams<{ deviceId: string }>()
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('incidents')

  if (!deviceId) return null

  return (
    <>
      <AppBar variant="back" title="Thiết bị" actions={<SessionActions />} onBack={() => navigate('/')} />
      <div className="mx-auto w-full max-w-3xl p-6">
        <div className="mb-4 flex gap-4 border-b border-line">
          <button
            type="button"
            onClick={() => setTab('incidents')}
            className={`pb-2 text-[15px] font-medium ${tab === 'incidents' ? 'border-b-2 border-brand text-brand' : 'text-ink-3'}`}
          >
            Sự cố
          </button>
          <button
            type="button"
            onClick={() => setTab('history')}
            className={`pb-2 text-[15px] font-medium ${tab === 'history' ? 'border-b-2 border-brand text-brand' : 'text-ink-3'}`}
          >
            Lịch sử on-chain
          </button>
        </div>
        {tab === 'incidents' ? <IncidentList deviceId={deviceId} /> : <HistoryTimeline deviceId={deviceId} />}
        {incentivesDeployment ? <DeviceIncentives deviceId={deviceId} /> : null}
      </div>
    </>
  )
}
