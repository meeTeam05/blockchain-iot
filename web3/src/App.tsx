import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Route, Routes } from 'react-router'
import { WagmiProvider } from 'wagmi'
import { DomainMismatchBanner, DomainStatusProvider } from './blocks/B0/domainStatus'
import { AuthProvider } from './lib/authStore'
import { wagmiConfig } from './lib/wagmiConfig'
import { DevicePage } from './pages/DevicePage'
import { HomePage } from './pages/HomePage'
import { IncidentPage } from './pages/IncidentPage'

const queryClient = new QueryClient()

function App() {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <DomainStatusProvider>
            <DomainMismatchBanner />
            <BrowserRouter>
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/d/:deviceId" element={<DevicePage />} />
                <Route path="/d/:deviceId/i/:incidentId" element={<IncidentPage />} />
              </Routes>
            </BrowserRouter>
          </DomainStatusProvider>
        </AuthProvider>
      </QueryClientProvider>
    </WagmiProvider>
  )
}

export default App
