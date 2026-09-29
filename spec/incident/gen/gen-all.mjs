// Regenerate (or with --check, verify) every file derived from spec/incident.
//
//   node spec/incident/gen/gen-all.mjs          # write
//   node spec/incident/gen/gen-all.mjs --check  # CI: fail when a generated file is stale
import { generateBackend } from './gen-backend.mjs';
import { generateFirmware } from './gen-firmware.mjs';

const check = process.argv.includes('--check');
const results = { firmware: generateFirmware({ check }), backend: generateBackend({ check }) };
const stale = Object.entries(results).filter(([, ok]) => !ok).map(([name]) => name);
if (stale.length) {
    console.error(`stale generated files: ${stale.join(', ')}; run node spec/incident/gen/gen-all.mjs`);
    process.exit(1);
}
console.log(check ? 'generated incident domain files are up to date' : 'generated incident domain files written');
