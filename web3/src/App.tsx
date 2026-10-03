import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import { BrowserRouter, Link, Route, Routes } from 'react-router'
import type { ReactNode } from 'react'
import { WagmiProvider } from 'wagmi'
import { DomainMismatchBanner, DomainStatusProvider } from './blocks/B0/domainStatus'
import { AuthProvider } from './lib/authStore'
import { useAuth } from './lib/authStore'
import { AppBar } from './components/ui/AppBar'
import { LoginForm } from './blocks/B1/LoginForm'
import { wagmiConfig } from './lib/wagmiConfig'
import { DevicePage } from './pages/DevicePage'
import { HomePage } from './pages/HomePage'
import { IncidentPage } from './pages/IncidentPage'
import { RealtimeSync } from './lib/RealtimeSync'
import { WalletPage } from './pages/WalletPage'
import { KeeperPage } from './pages/KeeperPage'
import { ParamsPage } from './pages/ParamsPage'
import { VerifyPage } from './pages/VerifyPage'
import { ROUTER_BASENAME } from './config/routes'
import { incentivesDeployment } from './lib/incentives'

const queryClient = new QueryClient()

function RequireAuth({ children }: { children: ReactNode }) {
  const { accessToken } = useAuth()
  const client = queryClient

  useEffect(() => {
    if (!accessToken) client.clear()
  }, [accessToken, client])

  if (!accessToken) {
    return (
      <>
        <AppBar variant="brand" />
        <div className="flex min-h-[calc(100vh-56px)] items-center justify-center p-6">
          <div className="w-full max-w-sm rounded-card border border-line bg-paper p-8 shadow-[0_6px_24px_-8px_rgba(14,18,16,0.08)]">
            <LoginForm />
          </div>
        </div>
      </>
    )
  }

  return children
}

function AppRoutes() {
  const { accessToken } = useAuth()
  return <>
    {accessToken ? <RealtimeSync /> : null}
    <DomainMismatchBanner />
    {incentivesDeployment ? <nav className="flex gap-4 border-b border-line px-6 py-2" aria-label="Incentives navigation">
      <Link to="/">Thiết bị</Link><Link to="/wallet">Ví token / bond</Link><Link to="/keeper">Keeper</Link><Link to="/params">Tham số / quỹ</Link>
    </nav> : null}
    <Routes>
      <Route path="/" element={<RequireAuth><HomePage /></RequireAuth>} />
      <Route path="/d/:deviceId" element={<RequireAuth><DevicePage /></RequireAuth>} />
      <Route path="/d/:deviceId/i/:incidentId" element={<RequireAuth><IncidentPage /></RequireAuth>} />
      <Route path="/verify/:deviceId/:incidentId" element={<RequireAuth><VerifyPage /></RequireAuth>} />
      <Route path="/wallet" element={<RequireAuth><WalletPage /></RequireAuth>} />
      <Route path="/keeper" element={<KeeperPage />} />
      <Route path="/params" element={<ParamsPage />} />
    </Routes>
  </>
}

function App() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <DomainStatusProvider>
            <BrowserRouter basename={ROUTER_BASENAME}>
              <AppRoutes />
            </BrowserRouter>
          </DomainStatusProvider>
        </AuthProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}

export default App
