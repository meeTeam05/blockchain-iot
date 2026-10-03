import { defineConfig } from '@playwright/test'

// Isolated local RPC + real Task 7 routes/indexers on PGlite. No external broker,
// Sepolia credentials, or changes to checked-in deployment artifacts are needed.
export default defineConfig({
  testDir: './e2e', testMatch: 'incentives.spec.ts', workers: 1, timeout: 120_000,
  use: { baseURL: 'http://127.0.0.1:5176/dapp/', trace: 'retain-on-failure',
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } },
  webServer: [
    { command: 'node e2e/incentives-harness.mjs', url: 'http://127.0.0.1:3006/__test/ready', timeout: 60_000, reuseExistingServer: false },
    { command: 'npm run dev -- --config vite.incentives-e2e.config.ts --port 5176 --strictPort',
      url: 'http://127.0.0.1:5176/dapp/', timeout: 30_000, reuseExistingServer: false,
      env: { VITE_NETWORK: 'localhost', VITE_API_BASE_URL: 'http://127.0.0.1:3006/api', VITE_RPC_URL: 'http://127.0.0.1:18545',
        VITE_E2E_MOCK_ACCOUNT: '0x90F79bf6EB2c4f870365E785982e1f101E93b906',
        VITE_E2E_KEEPER_ACCOUNT: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65' } },
  ],
})
