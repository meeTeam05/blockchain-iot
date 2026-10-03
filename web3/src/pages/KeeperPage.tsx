import { AppBar } from '../components/ui/AppBar'
import { useNavigate } from 'react-router'
import { ConnectWallet } from '../blocks/B1/ConnectWallet'
import { KeeperBoard } from '../blocks/B10/KeeperBoard'
export function KeeperPage() {
  const navigate = useNavigate()
  return <><AppBar variant="back" title="Keeper" actions={<ConnectWallet />} onBack={() => navigate('/')} /><main className="mx-auto max-w-3xl p-6"><KeeperBoard /></main></>
}
