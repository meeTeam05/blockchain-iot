import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router'
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

const queryClient = new QueryClient()
// Canonical public mount. Vite's base is also /dapp/, but the router must not
// silently become root-relative in test/dev modes where BASE_URL can be '/'.
const routerBasename = '/dapp'

function AuthenticatedRoutes() {
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

  return (
    <>
      <RealtimeSync />
      <DomainMismatchBanner />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/d/:deviceId" element={<DevicePage />} />
        <Route path="/d/:deviceId/i/:incidentId" element={<IncidentPage />} />
      </Routes>
    </>
  )
}

function App() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <DomainStatusProvider>
            <BrowserRouter basename={routerBasename}>
              <AuthenticatedRoutes />
            </BrowserRouter>
          </DomainStatusProvider>
        </AuthProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}

export default App
