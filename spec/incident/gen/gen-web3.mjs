// spec/incident/deployments + blockchain/abi -> web3/src/generated/incident-deployments.ts
//
//   node spec/incident/gen/gen-web3.mjs [--check]
// Unlike gen-backend.mjs, web3/'s build has direct filesystem access to
// blockchain/abi/ (same repo checkout, no separate Docker build context), but
// the ABI is still embedded here so the generated module stays self-contained
// and `as const`-typed for viem's contract type inference.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { ABI_FILE, GENERATED_BANNER, REPO_ROOT, loadAllDeployments } from './common.mjs';

export const WEB3_MODULE = path.join(REPO_ROOT, 'web3/src/generated/incident-deployments.ts');

export function renderWeb3Module(deployments) {
    const abi = JSON.parse(readFileSync(ABI_FILE, 'utf8'));
    const plain = Object.fromEntries(Object.entries(deployments).map(([k, d]) => [k, { ...d }]));
    return `// ${GENERATED_BANNER}
// Regenerate with: node spec/incident/gen/gen-all.mjs

export const INCIDENT_DEPLOYMENTS = Object.freeze(${JSON.stringify(plain, null, 4)} as const);

export const AIR_SAFETY_LOG_ABI = Object.freeze(${JSON.stringify(abi)} as const);
`;
}

export function generateWeb3({ check = false } = {}) {
    const next = renderWeb3Module(loadAllDeployments());
    const current = existsSync(WEB3_MODULE) ? readFileSync(WEB3_MODULE, 'utf8').replace(/\r\n/g, '\n') : null;
    if (check) return current === next;
    mkdirSync(path.dirname(WEB3_MODULE), { recursive: true });
    if (current !== next) writeFileSync(WEB3_MODULE, next);
    return true;
}

if (process.argv[1]?.endsWith('gen-web3.mjs')) {
    const check = process.argv.includes('--check');
    const ok = generateWeb3({ check });
    if (check && !ok) {
        console.error('incident-deployments.ts is stale: run node spec/incident/gen/gen-all.mjs');
        process.exit(1);
    }
    console.log(check ? 'incident-deployments.ts up to date' : `wrote ${path.relative(REPO_ROOT, WEB3_MODULE)}`);
}
