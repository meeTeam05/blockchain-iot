import { defineConfig } from '@playwright/test'

// Web3_task.md mục 9 "E2E UI": kịch bản A trên hardhat, ví mô phỏng bằng mock
// connector của wagmi (xem src/lib/wagmiConfig.ts) -- không cần MetaMask thật.
// Precondition (same as server/api/test/e2e/*): a hardhat node AND the full
// docker-compose backend (postgres/redis/emqx/api/chain-worker) must already
// be running, since IncidentPage reads incidents through the real API.
const PORT = 5174

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      VITE_NETWORK: 'localhost',
      VITE_API_BASE_URL: process.env.E2E_API_URL ?? 'http://127.0.0.1:3000/api',
      VITE_RPC_URL: process.env.E2E_CHAIN_RPC_URL ?? 'http://127.0.0.1:8545',
      // Hardhat dev account #3 (KEYS.owner in test/helpers/chain-deploy.js) --
      // the owner this suite registers on-chain in e2e/scenario-a.spec.ts.
      VITE_E2E_MOCK_ACCOUNT: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    },
  },
})
