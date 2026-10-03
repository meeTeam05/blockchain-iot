import { AppBar } from '../components/ui/AppBar'
import { SessionActions } from '../blocks/B1/SessionActions'
import { KeeperBoard } from '../blocks/B10/KeeperBoard'

export function KeeperPage() {
  return (
    <>
      <AppBar variant="brand" actions={<SessionActions />} />
      <main className="mx-auto max-w-3xl p-6">
        <KeeperBoard />
      </main>
    </>
  )
}
