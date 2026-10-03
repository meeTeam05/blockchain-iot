import '@testing-library/jest-dom/vitest'

// jsdom's own `fetch`/`Response` doesn't fully implement the Fetch spec once
// a DOM is actively rendered (response.headers can come back undefined),
// which crashes viem's http transport and wagmi connectors' internal
// rpc.http() calls mid-parse. Force a real, spec-compliant fetch (undici)
// globally for every test, not just the ones that happen to hit it first.
import { fetch as undiciFetch } from 'undici'

globalThis.fetch = undiciFetch as unknown as typeof fetch
