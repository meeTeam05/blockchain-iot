import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router'
import type { ReactNode } from 'react'
import { WagmiProvider } from 'wagmi'
import { DomainMismatchBanner, DomainStatusProvider } from './blocks/B0/domainStatus'
import { AuthProvider } from './lib/authStore'
import { useAuth } from './lib/authStore'
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
import { AppBar } from './components/ui/AppBar'
import { ROUTER_BASENAME } from './config/routes'
import heroImage from './assets/smartair_hero.png'

// Chain reads are rate limited on the RPC side: no refetch storm on tab focus,
// and data younger than 10 s is reused across components and navigations.
const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 10_000 } },
})

function RequireAuth({ children }: { children: ReactNode }) {
  const { accessToken } = useAuth()
  const client = queryClient

  useEffect(() => {
    if (!accessToken) client.clear()
  }, [accessToken, client])

  if (!accessToken) {
    return (
      <div className="min-h-screen bg-white flex flex-col font-['Be_Vietnam_Pro',system-ui,sans-serif] text-[#0f1712]">
        {/* Full-width top header with only logo and "SMART AIR" */}
        <AppBar variant="brand" showNav={false} />

        {/* Split screen content */}
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-2">
          {/* Left Column: #f3f8f5 */}
          <aside className="hidden lg:flex flex-col justify-between bg-[#f3f8f5] p-10 xl:px-16 xl:py-12 border-r border-[#e3ece6] overflow-hidden">
            {/* Centered Showcase Content: max-w-[580px] */}
            <div className="my-auto flex flex-col gap-7 max-w-[580px] w-full mx-auto py-8">
              <div className="flex flex-col gap-3.5">
                <h1 className="m-0 text-3xl xl:text-[38px] font-bold leading-[1.18] tracking-[-0.02em] text-[#0f1712]">
                  <span className="block">Giám sát chất lượng không khí</span>
                  <span className="block text-[#0a8f4e]">minh bạch và tức thì</span>
                </h1>
                <p className="m-0 text-[15px] xl:text-[16px] leading-[1.65] text-[#4a5750]">
                  Đồng bộ dữ liệu cảm biến đa chỉ số (AQI, PM2.5, CO, NO₂), xác thực qua chữ ký EIP-712 và lưu trữ bất biến trên Blockchain.
                </p>
              </div>

              {/* Hero Card with Real Image */}
              <div className="relative w-full aspect-[16/10] rounded-[20px] overflow-hidden bg-[#e6eee9] shadow-[0_20px_40px_-24px_rgba(15,40,25,0.25)] border border-[#dfe8e2]">
                <img
                  src={heroImage}
                  alt="Ảnh thiết bị SMART AIR"
                  className="w-full h-full object-cover"
                  loading="eager"
                />
              </div>

              {/* 3 Pills */}
              <div className="flex flex-wrap gap-3">
                <span className="flex items-center gap-2 px-4 py-2 rounded-full bg-white border border-[#dfe8e2] text-[14px] font-medium text-[#0f1712] shadow-2xs">
                  <span className="w-2 h-2 rounded-full bg-[#1ee07f]" />
                  Realtime SSE
                </span>
                <span className="flex items-center gap-2 px-4 py-2 rounded-full bg-white border border-[#dfe8e2] text-[14px] font-medium text-[#0f1712] shadow-2xs">
                  <span className="w-2 h-2 rounded-full bg-[#1ee07f]" />
                  Blockchain · EIP-712
                </span>
                <span className="flex items-center gap-2 px-4 py-2 rounded-full bg-white border border-[#dfe8e2] text-[14px] font-medium text-[#0f1712] shadow-2xs">
                  <span className="w-2 h-2 rounded-full bg-[#1ee07f]" />
                  AQI · PM2.5 · CO
                </span>
              </div>
            </div>

            {/* Footer Note */}
            <div className="text-[13px] text-[#7a877f]">
              © 2026 SMART AIR · IoT Sentinel
            </div>
          </aside>

          {/* Right Column: Clean White Background, Centered Form */}
          <main className="flex flex-col justify-center items-center p-8 sm:p-14 lg:p-16 bg-white">
            <div className="w-full max-w-[450px]">
              <LoginForm />
            </div>
          </main>
        </div>
      </div>
    )
  }

  return children
}

function AppRoutes() {
  const { accessToken } = useAuth()
  return <>
    {accessToken ? <RealtimeSync /> : null}
    <DomainMismatchBanner />
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
