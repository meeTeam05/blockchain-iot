import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { handleIncident } from '../src/services/incident-intake.js';
import { TypedDataEncoder } from 'ethers';

import { INCIDENT_DEPLOYMENTS } from '../src/generated/incident-deployments.js';
import { resolveIncidentDomains } from '../src/services/incident-domains.js';
import { domainFromConfig, verifyIncidentPayload } from '../src/services/incident-verify.js';
import {
    DEVICE_ID,
    createIncidentDb,
    createIntakeFastify,
} from './helpers/incident-fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const FIXTURE = path.join(HERE, 'fixtures/task1-firmware-wire.json');
const DOMAIN = Object.freeze({
    domainName: 'AirSafetyLog',
    domainVersion: '1',
    chainId: '11155111',
    verifyingContract: '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
});

async function loadWireFixture() {
    const raw = (await readFile(FIXTURE, 'utf8')).trimEnd();
    return { raw: Buffer.from(raw, 'utf8'), payload: JSON.parse(raw) };
}

test('exact Task 1 firmware wire payload verifies, authorizes, persists and returns parser-compatible ACK', async () => {
    const { raw, payload } = await loadWireFixture();
    assert.equal(Object.hasOwn(payload, 'calibration_canonical'), false);
    const domain = domainFromConfig(DOMAIN);
    const verified = verifyIncidentPayload(payload, domain);
    assert.equal(verified.ok, true, verified.reason);

    const store = await createIncidentDb({ signerAddress: verified.signer });
    try {
        const fastify = createIntakeFastify(store);
        const result = await handleIncident(fastify, DEVICE_ID, payload, raw, {
            domain,
            incidentConfig: { maxPayloadBytes: 4096, clockSkewSeconds: 600 },
            now: () => new Date((Number(payload.observed_at) + 86_400) * 1000),
        });
        assert.equal(result.accepted, true);
        assert.equal(result.ack.error_code, '');
        const { rows } = await store.db.query(
            'SELECT calibration_canonical, calibration_hash, raw_payload FROM incidents WHERE incident_id = $1',
            [payload.incident_id]
        );
        assert.equal(rows.length, 1);
        assert.equal(rows[0].calibration_canonical, null);
        assert.equal(rows[0].calibration_hash, payload.calibration_hash);
        assert.deepEqual(Buffer.from(rows[0].raw_payload), raw);

        const idfPath = process.env.IDF_PATH || path.join(os.homedir(), 'esp/esp-idf');
        const compile = spawnSync('python3', [
            path.join(REPO, 'firmware/components/core/incident/tools/test_incident_ack_matrix.py'),
        ], { env: { ...process.env, IDF_PATH: idfPath }, encoding: 'utf8' });
        assert.equal(compile.status, 0, `${compile.stdout}\n${compile.stderr}`);
        const firmwareParser = spawnSync('/tmp/incident_ack_matrix', [
            '--validate-json', JSON.stringify(result.ack),
        ], { encoding: 'utf8' });
        assert.equal(firmwareParser.status, 0, `${firmwareParser.stdout}\n${firmwareParser.stderr}`);
        assert.match(firmwareParser.stdout, /ACK_CONTRACT_TEST: PASS/);
    } finally {
        await store.close();
    }
});

test('backend EIP-712 domain configuration exactly matches Task 1 firmware', async () => {
    // Firmware and backend are both generated from spec/incident/deployments; nothing
    // may hard-code a verifying contract or chain id any more.
    const incidentSource = await readFile(path.join(REPO, 'firmware/components/core/incident/incident.c'), 'utf8');
    const header = await readFile(path.join(REPO, 'firmware/components/core/incident/include/incident_domain.h'), 'utf8');
    const overlay = await readFile(path.join(REPO, 'firmware/sdkconfig.incident'), 'utf8');
    assert.match(incidentSource, /#include "incident_domain.h"/);
    assert.match(incidentSource, /keccak256\(INCIDENT_DOMAIN_NAME,strlen\(INCIDENT_DOMAIN_NAME\),name\)/);
    assert.match(incidentSource, /keccak256\(INCIDENT_DOMAIN_VERSION,strlen\(INCIDENT_DOMAIN_VERSION\),version\)/);
    assert.match(incidentSource, /abi_u\(chain,INCIDENT_CHAIN_ID\)/);
    assert.doesNotMatch(overlay, /CONFIG_SA_INCIDENT_VERIFYING_CONTRACT/);
    assert.match(overlay, /^CONFIG_SA_INCIDENT_ENV_(SEPOLIA|LOCAL)=y$/m);
    assert.match(header, /#define INCIDENT_DOMAIN_NAME "AirSafetyLog"/);
    assert.match(header, /#define INCIDENT_DOMAIN_VERSION "1"/);

    const check = spawnSync(process.execPath, [path.join(REPO, 'spec/incident/gen/gen-all.mjs'), '--check'], { encoding: 'utf8' });
    assert.equal(check.status, 0, `${check.stdout}
${check.stderr}`);

    assert.ok(Object.keys(INCIDENT_DEPLOYMENTS).length > 0, 'at least one deployment is recorded');
    for (const deployment of Object.values(INCIDENT_DEPLOYMENTS)) {
        const domains = resolveIncidentDomains({
            deployment: deployment.network,
            domainName: 'AirSafetyLog',
            domainVersion: '1',
            chainId: '',
            verifyingContract: '',
            legacyVerifyingContracts: null,
        });
        const separator = TypedDataEncoder.hashDomain({ ...domains.current, chainId: BigInt(domains.current.chainId) });
        assert.equal(separator, deployment.domainSeparator);
        assert.ok(header.includes(`#  define INCIDENT_VERIFYING_CONTRACT "${deployment.address}"`));
        assert.ok(header.includes(`#  define INCIDENT_DOMAIN_SEPARATOR "${deployment.domainSeparator}"`));
        assert.ok(header.includes(`#  define INCIDENT_CHAIN_ID ${deployment.chainId}ULL`));
    }
    assert.deepEqual(domainFromConfig(DOMAIN), {
        name: 'AirSafetyLog',
        version: '1',
        chainId: '11155111',
        verifyingContract: DOMAIN.verifyingContract,
    });
});
