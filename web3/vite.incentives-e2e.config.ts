import { defineConfig, mergeConfig } from 'vite'
import { fileURLToPath } from 'node:url'
import base from './vite.config.ts'

// Only the ephemeral deployment receipt differs: addresses, ABI, bytecode,
// linkage and domain are all produced by real local deployments and validated
// through the normal Task 5 guard. Production always uses the normal generator.
export default mergeConfig(base, defineConfig({ resolve: { alias: [
  { find: /(?:\.\.\/)+generated\/incident-deployments$/,
    replacement: fileURLToPath(new URL('./.incentives-e2e/incident-deployments.ts', import.meta.url)) },
] } }))
