/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
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
