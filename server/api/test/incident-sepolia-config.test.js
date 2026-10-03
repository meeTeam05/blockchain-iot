import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TypedDataEncoder } from 'ethers';

import { INCIDENT_DEPLOYMENTS } from '../src/generated/incident-deployments.js';
import { resolveIncidentDomains } from '../src/services/incident-domains.js';

test('Sepolia runtime selection uses the committed deployment and keeps old domains legacy-only', async () => {
    const spec = JSON.parse(await readFile(new URL('../../../spec/incident/deployments/sepolia.json', import.meta.url), 'utf8'));
    const selected = resolveIncidentDomains({
        deployment: 'sepolia', domainName: 'AirSafetyLog', domainVersion: '1',
        chainId: '', verifyingContract: '', legacyVerifyingContracts: null,
    });
    assert.equal(selected.current.chainId, '11155111');
    assert.equal(selected.current.verifyingContract, spec.address);
    assert.equal(INCIDENT_DEPLOYMENTS.sepolia.address, spec.address);
    assert.equal(TypedDataEncoder.hashDomain(selected.current), spec.domainSeparator);
    assert.ok(selected.legacy.some((domain) => domain.verifyingContract === spec.legacyAddresses[0]));
    assert.ok(selected.legacy.every((domain) => domain.verifyingContract !== selected.current.verifyingContract));
    assert.throws(() => resolveIncidentDomains({
        deployment: 'sepolia', domainName: 'AirSafetyLog', domainVersion: '1',
        chainId: '', verifyingContract: spec.legacyAddresses[0], legacyVerifyingContracts: null,
    }), /does not match/);
    assert.throws(() => resolveIncidentDomains({
        deployment: 'missing', domainName: 'AirSafetyLog', domainVersion: '1',
        chainId: '', verifyingContract: '', legacyVerifyingContracts: null,
    }), /no spec/);
    const example = await readFile(new URL('../../.env.example', import.meta.url), 'utf8');
    assert.match(example, /^INCIDENT_DEPLOYMENT=sepolia$/m);
    assert.match(example, /^AIR_SAFETY_LOG_ADDRESS=$/m);
});
