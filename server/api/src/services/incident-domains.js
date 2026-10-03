// Which EIP-712 domains the intake accepts.
//
// current: the deployment the relayer submits to. Incidents signed for it can go on-chain.
// legacy:  domains devices may still hold signed records for (old test domain, old
//          deployments). Accepted and stored as evidence, never relayed (legacy_domain).
//
// The addresses come from spec/incident/deployments through the generated module, so
// the backend and firmware cannot drift apart. Env values are only an override and must
// agree with the selected deployment.
import { getAddress, isAddress } from 'ethers';

import { INCIDENT_DEPLOYMENTS } from '../generated/incident-deployments.js';
import { normalizeIncidentDomain } from './incident-verify.js';

const DEFAULT_CHAIN_ID = '11155111';

export function getDeployment(name, deployments = INCIDENT_DEPLOYMENTS) {
    if (!name) return null;
    const deployment = deployments[name];
    if (!deployment) {
        throw new TypeError(`INCIDENT_DEPLOYMENT=${name} has no spec/incident/deployments/${name}.json (known: ${Object.keys(deployments).join(', ') || 'none'})`);
    }
    return deployment;
}

// Returns { current, legacy, deployment }. Throws on any inconsistency so the API
// refuses to start instead of verifying against the wrong domain.
export function resolveIncidentDomains(incidentConfig, deployments = INCIDENT_DEPLOYMENTS) {
    const deployment = getDeployment(incidentConfig.deployment, deployments);
    const envAddress = incidentConfig.verifyingContract;
    if (deployment && envAddress) {
        if (!isAddress(envAddress) || getAddress(envAddress) !== getAddress(deployment.address)) {
            throw new TypeError(
                `AIR_SAFETY_LOG_ADDRESS ${envAddress} does not match ${deployment.network} deployment ${deployment.address}`
            );
        }
    }
    const envChainId = incidentConfig.chainId;
    if (deployment && envChainId && String(envChainId) !== String(deployment.chainId)) {
        throw new TypeError(`INCIDENT_CHAIN_ID ${envChainId} does not match ${deployment.network} chainId ${deployment.chainId}`);
    }

    const base = {
        name: incidentConfig.domainName,
        version: incidentConfig.domainVersion,
        chainId: deployment?.chainId ?? (envChainId || DEFAULT_CHAIN_ID),
    };
    if (deployment && (base.name !== deployment.name || base.version !== deployment.version)) {
        throw new TypeError(`incident domain name/version must be ${deployment.name}/${deployment.version}`);
    }
    const current = normalizeIncidentDomain({ ...base, verifyingContract: deployment?.address ?? envAddress });

    const legacyList = incidentConfig.legacyVerifyingContracts ?? deployment?.legacyAddresses ?? [];
    const seen = new Set([current.verifyingContract]);
    const legacy = [];
    for (const address of legacyList) {
        const domain = normalizeIncidentDomain({ ...base, verifyingContract: address });
        if (seen.has(domain.verifyingContract)) continue;
        seen.add(domain.verifyingContract);
        legacy.push(domain);
    }
    return Object.freeze({ current, legacy: Object.freeze(legacy), deployment });
}

export function domainsFromSingle(domain) {
    return Object.freeze({ current: normalizeIncidentDomain(domain), legacy: Object.freeze([]), deployment: null });
}
