/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  // The dApp is served by the existing nginx origin below /dapp/. Keeping the
  // same base in dev makes asset URLs and direct-route behaviour identical to
  // production (Vite redirects / to /dapp/ for convenience).
  base: '/dapp/',
  plugins: [react(), tailwindcss()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // e2e/ holds Playwright specs (`npm run test:e2e`), not Vitest ones --
    // Vitest's default include glob would otherwise pick them up and crash.
    exclude: ['**/node_modules/**', '**/dist/**', './e2e/**'],
  },
})
