// spec/incident/deployments -> firmware/components/core/incident/include/incident_domain.h
//
//   node spec/incident/gen/gen-firmware.mjs [--check]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { GENERATED_BANNER, REPO_ROOT, loadAllDeployments } from './common.mjs';

export const FIRMWARE_HEADER = path.join(REPO_ROOT, 'firmware/components/core/incident/include/incident_domain.h');

const ENV_SYMBOL = Object.freeze({ localhost: 'CONFIG_SA_INCIDENT_ENV_LOCAL', sepolia: 'CONFIG_SA_INCIDENT_ENV_SEPOLIA' });

function block(d) {
    return [
        `#  define INCIDENT_DEPLOYMENT_NAME "${d.network}"`,
        `#  define INCIDENT_CHAIN_ID ${d.chainId}ULL`,
        `#  define INCIDENT_VERIFYING_CONTRACT "${d.address}"`,
        `#  define INCIDENT_DOMAIN_SEPARATOR "${d.domainSeparator}"`,
    ].join('\n');
}

export function renderFirmwareHeader(deployments) {
    const branches = [];
    for (const network of Object.keys(ENV_SYMBOL)) {
        const d = deployments[network];
        const cond = `defined(${ENV_SYMBOL[network]})`;
        branches.push(d
            ? `${cond}\n${block(d)}`
            : `${cond}\n/* No ${network} deployment recorded yet: signing stays disabled. */\n#  define INCIDENT_DEPLOYMENT_NAME "${network}"\n#  define INCIDENT_CHAIN_ID 0ULL\n#  define INCIDENT_VERIFYING_CONTRACT ""\n#  define INCIDENT_DOMAIN_SEPARATOR ""`);
    }
    return `/* incident_domain.h - ${GENERATED_BANNER}
 *
 * Selected by the Kconfig choice SA_INCIDENT_ENV. An empty verifying contract
 * means that deployment does not exist yet; the incident module then refuses
 * to sign instead of signing for a wrong domain.
 */
#pragma once

#define INCIDENT_DOMAIN_NAME "AirSafetyLog"
#define INCIDENT_DOMAIN_VERSION "1"

#if ${branches.join('\n#elif ')}
#else
#  define INCIDENT_DEPLOYMENT_NAME "none"
#  define INCIDENT_CHAIN_ID 0ULL
#  define INCIDENT_VERIFYING_CONTRACT ""
#  define INCIDENT_DOMAIN_SEPARATOR ""
#endif
`;
}

export function generateFirmware({ check = false } = {}) {
    const next = renderFirmwareHeader(loadAllDeployments());
    const current = existsSync(FIRMWARE_HEADER) ? readFileSync(FIRMWARE_HEADER, 'utf8').replace(/\r\n/g, '\n') : null;
    if (check) return current === next;
    if (current !== next) writeFileSync(FIRMWARE_HEADER, next);
    return true;
}

if (process.argv[1]?.endsWith('gen-firmware.mjs')) {
    const check = process.argv.includes('--check');
    const ok = generateFirmware({ check });
    if (check && !ok) {
        console.error('incident_domain.h is stale: run node spec/incident/gen/gen-all.mjs');
        process.exit(1);
    }
    console.log(check ? 'incident_domain.h up to date' : `wrote ${path.relative(REPO_ROOT, FIRMWARE_HEADER)}`);
}
