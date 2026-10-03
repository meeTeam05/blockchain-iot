# spec/incident — single source of the EIP-712 domain

Firmware (Task 1), backend (Task 3/4) and the contract deployment (Task 2) must sign
and verify against the same `name / version / chainId / verifyingContract`. Nobody
types a contract address by hand; everything is generated from this folder.

```text
spec/incident/
  deployments/<network>.json   written by blockchain/scripts/deploy.js (localhost, sepolia)
  legacy-domains.json          seed list of old domains devices may still hold records for
  gen/gen-all.mjs              regenerates every derived file (--check for CI)
  gen/gen-firmware.mjs         -> firmware/components/core/incident/include/incident_domain.h
  gen/gen-backend.mjs          -> server/api/src/generated/incident-deployments.js (+ ABI)
  gen/gen-incentives.mjs       blockchain/deployments/<network>.incentives.json
                               -> server/api/src/generated/incentives-deployments.js (+ ABI)
```

## Flow after a deployment

```bash
cd blockchain
npm run deploy:sepolia               # or: npx hardhat node & npm run deploy:localhost
cd ..
node spec/incident/gen/gen-all.mjs   # regenerate firmware header + backend module
git add spec/incident firmware/components/core/incident/include/incident_domain.h \
        server/api/src/generated blockchain/deployments blockchain/abi
git commit                            # deployment + generated files in ONE commit
```

`gen-all.mjs` recomputes each domain separator from the recorded fields and refuses a
file whose `domainSeparator` does not match, so a hand-edited address cannot slip in.
`node spec/incident/gen/gen-all.mjs --check` fails when a generated file is stale
(`make incident-gen-check`).

## Consumers

- Firmware: Kconfig choice `SA_INCIDENT_ENV` (`SEPOLIA` / `LOCAL`) selects a block of
  `incident_domain.h`. At boot `incident_init()` recomputes the separator and refuses to
  sign if it differs, or if the selected deployment does not exist yet.
- Backend: `INCIDENT_DEPLOYMENT=<network>` in `server/.env`. The API refuses to start if
  `AIR_SAFETY_LOG_ADDRESS` (optional) disagrees, and — with `CHAIN_RPC_URL` — if the
  contract at that address reports a different domain separator.
- `legacyAddresses` of a deployment are accepted by the intake as off-chain evidence
  (`blockchain_outbox.status = legacy_domain`) and never relayed. Clear them with
  `AIR_SAFETY_LOG_LEGACY_ADDRESSES=` once every device reports an empty incident queue.

The Schema v2 golden vectors stay in `docs/test-vectors/` and keep the historical test
domain `0xCcCC…cccC`; only host tools and tests use that address.
