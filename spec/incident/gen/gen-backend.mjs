// spec/incident/deployments + blockchain/abi -> server/api/src/generated/incident-deployments.js
//
//   node spec/incident/gen/gen-backend.mjs [--check]
// The ABI is embedded because the API Docker build context is server/api only.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { ABI_FILE, GENERATED_BANNER, REPO_ROOT, loadAllDeployments } from './common.mjs';

export const BACKEND_MODULE = path.join(REPO_ROOT, 'server/api/src/generated/incident-deployments.js');

export function renderBackendModule(deployments) {
    const abi = JSON.parse(readFileSync(ABI_FILE, 'utf8'));
    const plain = Object.fromEntries(Object.entries(deployments).map(([k, d]) => [k, { ...d }]));
    return `// ${GENERATED_BANNER}
// Regenerate with: node spec/incident/gen/gen-all.mjs

export const INCIDENT_DEPLOYMENTS = Object.freeze(${JSON.stringify(plain, null, 4)});

export const AIR_SAFETY_LOG_ABI = Object.freeze(${JSON.stringify(abi)});
`;
}

export function generateBackend({ check = false } = {}) {
    const next = renderBackendModule(loadAllDeployments());
    const current = existsSync(BACKEND_MODULE) ? readFileSync(BACKEND_MODULE, 'utf8').replace(/\r\n/g, '\n') : null;
    if (check) return current === next;
    mkdirSync(path.dirname(BACKEND_MODULE), { recursive: true });
    if (current !== next) writeFileSync(BACKEND_MODULE, next);
    return true;
}

if (process.argv[1]?.endsWith('gen-backend.mjs')) {
    const check = process.argv.includes('--check');
    const ok = generateBackend({ check });
    if (check && !ok) {
        console.error('incident-deployments.js is stale: run node spec/incident/gen/gen-all.mjs');
        process.exit(1);
    }
    console.log(check ? 'incident-deployments.js up to date' : `wrote ${path.relative(REPO_ROOT, BACKEND_MODULE)}`);
}
