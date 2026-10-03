# smart-air

![ESP32-S3](https://img.shields.io/badge/MCU-ESP32--S3-E7352C)
![ESP-IDF 5.4.2](https://img.shields.io/badge/ESP--IDF-5.4.2-111827)
![Expo SDK 57](https://img.shields.io/badge/Expo-SDK%2057-000020)
![Node.js 20](https://img.shields.io/badge/Node.js-20-339933)
![Solidity 0.8.28](https://img.shields.io/badge/Solidity-0.8.28-363636)
![License MIT](https://img.shields.io/badge/License-MIT-22C55E)

> `smart-air` is an ESP32-S3 indoor air quality monitor and smart home controller with a tamper-evident incident trail on Ethereum (Sepolia). Gas alarms are detected on the device, signed by the device, anchored on-chain by a backend relayer, and verified and handled by the device owner in a web dApp. A testnet token rewards fast reactions and penalises slow ones.

![Smart-Air](assets/hero.png)

## What the system does

1. **Measures and controls.** The board reads temperature, humidity, CO and NO₂, shows them on a display, drives three relays (Fan, Lamp, Filter), and streams status to the cloud over MQTT. A mobile app provisions the board over BLE, shows live data and sends commands.
2. **Warns early.** Firmware evaluates CO and NO₂ against the Vietnamese QCVN 03:2019/BYT limits (short-term and 8-hour averages), a 10-minute projection and a small on-device TFLite Micro model. It raises a local buzzer alarm; it never switches relays by itself.
3. **Proves incidents.** When the alert level changes to *early warning* or *exceeded*, the device builds a canonical evidence record and signs it with EIP-712 using a key that is stored in encrypted NVS. The server verifies the signature and queues it; a relayer writes only a minimal claim plus the evidence hash to the `AirSafetyLog` contract. The full evidence stays in TimescaleDB.
4. **Lets the owner act and verify.** In the dApp the device owner connects MetaMask, recomputes the evidence hash in the browser and checks it against the chain (no need to trust the server), then acknowledges and resolves the incident on-chain.
5. **Incentivises response.** `SafetyIncentives` and the `ASAFE` token reward owners who acknowledge and resolve on time, slash owners who ignore an incident, and slash the operator when an incident reaches the chain too late. Anyone can trigger the penalties and earns a share as a keeper bounty.

## Architecture

```text
                  BLE (Wi-Fi provisioning)
   Mobile app  <------------------------->  ESP32-S3 firmware
   (Expo, app/)                              (ESP-IDF, firmware/)
        |                                      |  MQTT over TLS/WSS
        | REST + SSE                           v
        |                                   EMQX broker
        v                                      |
   Nginx / Cloudflare Tunnel  ->  Fastify API (server/api)  <->  PostgreSQL + TimescaleDB, Redis
                                       |
                                       | incident outbox
                                       v
                               chain worker (relayer, indexer, keeper)
                                       |  JSON-RPC
                                       v
              Sepolia: AirSafetyLog  <-  SafetyIncentives  <->  AirSafeToken (ASAFE)
                                       ^
                                       | read + MetaMask transactions
                                  web dApp (web3/, served at /dapp/)
```

Incident path in one line: *device signs -> MQTT -> API verifies and stores -> relayer `logIncident` -> indexer confirms after N blocks -> owner acknowledges/resolves in the dApp*.

## Components

| Directory | What it is | Stack |
|---|---|---|
| [`firmware/`](firmware) | Device firmware: sensors, display, relays, BLE provisioning, Wi-Fi, MQTT, OTA, on-device gas AI, signed incident queue | ESP-IDF 5.4.2, ESP32-S3 (N16R8: 16 MB flash, octal PSRAM), LVGL, TFLite Micro |
| [`server/`](server) | Docker Compose stack: API, MQTT broker, databases, reverse proxy, tunnel, chain worker | Fastify 4 (Node 20 image), PostgreSQL/TimescaleDB, Redis, EMQX, Nginx, Cloudflare Tunnel, ethers 6 |
| [`app/`](app) | Mobile app: auth, homes and rooms, BLE provisioning, device dashboard, commands, OTA, calibration, notifications, link to the dApp | Expo SDK 57, React Native 0.86, expo-router, TanStack Query, Zustand, react-native-ble-plx |
| [`blockchain/`](blockchain) | Smart contracts, tests, deploy and verify scripts, ABIs, deployment records | Solidity 0.8.28, Hardhat, OpenZeppelin 5 |
| [`web3/`](web3) | Web dApp: devices, incidents, independent verification, acknowledge/resolve, token wallet and staking, keeper board, parameters | Vite, React 19, TypeScript, wagmi 3, viem 2 |
| [`spec/incident/`](spec/incident) | Single source of the EIP-712 domain; generators write the firmware header and the backend/dApp modules | Node scripts |
| [`hardware/`](hardware) | KiCad schematic, PCB, BOM | KiCad |
| [`docs/`](docs) | Architecture, protocol, API reference, runbooks, task specs | Markdown |

### Firmware

BLE provisioning, Wi-Fi, MQTT over TLS/WSS, HTTPS OTA with rollback and validation, SHT3x (temperature/humidity), GM702B (CO) and GM102B (NO₂) gas sensors, DS3231 RTC with SNTP sync, LVGL on an ILI9225 display, 3 relay channels with NVS persistence, WS2812 status LED, buzzer and a factory-reset button. The incident profile adds NVS encryption (HMAC key in eFuse), deterministic secp256k1 signing and a persistent queue of signed incidents.

### Server

- REST API for auth (JWT with refresh-token rotation), homes, rooms, devices, commands, shadow, telemetry, notifications, incidents and incentives.
- Server-Sent Events for live status, telemetry, OTA progress, command updates and incident/incentive changes. REST stays canonical for snapshots, history and command authorization.
- Per-device MQTT credentials provisioned through the API; OTA artifact hosting; the dApp build is served by Nginx under `/dapp/`.
- Chain worker (`docker compose --profile chain`): relayer for `logIncident` and device operations, indexer for `AirSafetyLog` and `SafetyIncentives` events, optional keeper, health and metrics endpoints, ops alerts. Only one worker may run per database and relayer wallet.

### Mobile app

JWT login with secure storage, multi-home and room management with member invites, 5-step BLE provisioning, device dashboard with relay and device-mode controls, live sparkline charts through SSE, command history, sensor calibration wizard, OTA screen, in-app notifications. For an incident notification the app opens the dApp page of that incident (through a MetaMask Mobile link). Blockchain actions are not performed in the app.

### Smart contracts

| Contract | Role |
|---|---|
| `AirSafetyLog` | Registry of devices (signer and owner) and of incidents. Verifies the device signature (EIP-712), stores the minimal claim and `evidenceHash`, tracks exact sequence use, and lets the device owner acknowledge and resolve. Roles: `DEVICE_MANAGER_ROLE`, `RELAYER_ROLE`. |
| `AirSafeToken` (ASAFE) | ERC-20, fixed supply of 1,000,000 minted to the Treasury, no mint, burn or pause. Testnet only, no monetary value. |
| `SafetyIncentives` | Reads `AirSafetyLog` (never writes). Owner bonds per device, an operator bond, reward fund, rules R1/R2/P1/P2, daily reward cap, unstake cooldown. |

Incentive rules at the parameters deployed on Sepolia (the admin can change them with `setParams`; the `/params` page of the dApp shows the live values):

| Rule | Condition | Effect |
|---|---|---|
| R1 | Owner acknowledged before the deadline (30 min for warning, 10 min for danger, counted from `loggedAt`) | +5 ASAFE, at most 3 rewarded incidents per device per UTC day |
| R2 | Resolved within 24 h, and R1 was paid | +5 ASAFE |
| P1 | Not acknowledged in time | -20 ASAFE from the owner bond; 50% to the keeper that called it, 50% to the Treasury |
| P2 | `loggedAt - observedAt` above 15 min | -20 ASAFE from the operator bond, split the same way |

Owner bond is 100 ASAFE per device; withdrawing a bond requires a 7-day cooldown. Known limits of these rules are listed in [`docs/tasks/Token_incentive_task.md`](docs/tasks/Token_incentive_task.md) under "Giới hạn đã biết của MVP".

### Deployments (Sepolia, chain ID 11155111)

| Contract | Address |
|---|---|
| `AirSafetyLog` | [`0x45CF175ffd4B1Ad77E87389d1e92945f9Bc88d3A`](https://sepolia.etherscan.io/address/0x45CF175ffd4B1Ad77E87389d1e92945f9Bc88d3A) |
| `AirSafeToken` | [`0xD01324896e7cCc099DB95212a54b5473a3B2DE34`](https://sepolia.etherscan.io/address/0xD01324896e7cCc099DB95212a54b5473a3B2DE34) |
| `SafetyIncentives` | [`0x4078c3a86708B4C4B3aD61aB5A282e0E6A9FAA04`](https://sepolia.etherscan.io/address/0x4078c3a86708B4C4B3aD61aB5A282e0E6A9FAA04) |

The local Hardhat network deliberately uses the same chain ID (11155111) so that the Schema v2 test vectors verify locally. Because of that, the chain ID alone does not identify the network: the dApp also checks the EIP-712 domain, the contract bytecode and the deployment receipt.

## Repository layout

```text
firmware/      ESP-IDF project (main/, components/{config,core,drivers,general,ota}, sdkconfig.* profiles)
server/        docker-compose.yml, api/ (Fastify app, worker, tests), db/migrations, emqx/, nginx/, ota-files/
app/           Expo app (app/ routes, src/{api,components,services,stores,queries,models,theme})
blockchain/    contracts/, test/, scripts/, abi/, deployments/
web3/          dApp (src/{pages,blocks,lib,generated}, e2e/, scripts/)
spec/incident/ EIP-712 domain source + generators (gen-all.mjs --check)
hardware/      KiCad project and BOM
docs/          architecture/, reference/, ops/, tasks/, test-vectors/, datasheet/, archive/
scripts/       server and database helper scripts
assets/        images and demo GIFs used by this README
tmp/           working notes, decision logs and reports (not product documentation)
Makefile       one entry point for server, app, web3 and firmware commands (run `make help`)
```

## Getting started

Prerequisites: Docker, Node.js 22 LTS for development (the API image runs Node 20), ESP-IDF 5.4.2 for firmware, Android SDK with JDK 17 for the mobile app, MetaMask for the dApp.

```bash
make help                     # list all targets

# Server stack
make server-env-init          # create server/.env from the example, then fill the secrets
make server-up                # postgres, redis, emqx, api, nginx, cloudflared
make server-check             # read-only connectivity checks

# Contracts
cd blockchain && npm ci && npm test

# dApp
make web3-install && make web3-dev        # http://127.0.0.1:5173/dapp/

# Mobile app (Android device connected over USB)
make app-install && make app-run

# Firmware (default profile; the incident profile needs the idf.py commands in docs/_RUN_BOOK.md)
make firmware-build
```

Tests:

| Area | Command |
|---|---|
| Contracts | `cd blockchain && npm test` |
| Backend | `IDF_PATH=<esp-idf path> make server-test` (one test compiles firmware C code and needs ESP-IDF) |
| Mobile app | `make app-test` |
| dApp unit and integration | `make web3-test` |
| dApp end to end (needs a Hardhat node and the Docker stack) | `make web3-test-e2e` |
| Token incentives end to end (self-contained) | `cd web3 && npm run test:incentives-e2e` |
| EIP-712 generated files are current | `make incident-gen-check` |

Configuration is read from `server/.env` (copy of `server/.env.example`). Which deployment the backend uses is selected by `INCIDENT_DEPLOYMENT` (`sepolia` or `localhost`); never type contract addresses by hand, they come from `spec/incident/deployments/`.

## Documentation

| Topic | File |
|---|---|
| Demo script, commands and expected results | [`docs/_RUN_BOOK.md`](docs/_RUN_BOOK.md) |
| Server operations | [`docs/ops/_RUN_BOOK.md`](docs/ops/_RUN_BOOK.md) |
| Chain worker operations | [`docs/ops/CHAIN_WORKER_RUNBOOK.md`](docs/ops/CHAIN_WORKER_RUNBOOK.md) |
| End-to-end run with a pre-filled `server/.env` | [`docs/ops/E2E_GUIDE_SERVER_ENV_HOLDER.md`](docs/ops/E2E_GUIDE_SERVER_ENV_HOLDER.md) |
| System, firmware, server and app architecture | [`docs/architecture/`](docs/architecture) (the app sections still describe the earlier Flutter app) |
| Incident Schema v2 (hash, signature, test vectors) | [`docs/reference/BLOCKCHAIN_INCIDENT_SCHEMA.md`](docs/reference/BLOCKCHAIN_INCIDENT_SCHEMA.md), [`docs/test-vectors/`](docs/test-vectors) |
| Firmware side of incidents | [`docs/reference/BLOCKCHAIN_INCIDENT_FIRMWARE.md`](docs/reference/BLOCKCHAIN_INCIDENT_FIRMWARE.md) |
| On-device gas AI | [`docs/reference/AI.md`](docs/reference/AI.md) |
| MQTT topics and payloads | [`docs/reference/MQTT_PROTOCOL.md`](docs/reference/MQTT_PROTOCOL.md) |
| REST and SSE API | [`docs/reference/API_REFERENCE.md`](docs/reference/API_REFERENCE.md) |
| dApp functional blocks, routes, transaction states | [`docs/tasks/Web3_task.md`](docs/tasks/Web3_task.md), [`web3/README.md`](web3/README.md) |
| Token rules, parameters and known limits | [`docs/tasks/Token_incentive_task.md`](docs/tasks/Token_incentive_task.md) |
| Contracts and deployment | [`blockchain/README.md`](blockchain/README.md) |
| Original task breakdown and history | [`docs/tasks/`](docs/tasks), [`docs/archive/`](docs/archive), [`CHANGELOG.md`](CHANGELOG.md) |

## Hardware

### Schematic

![Schematic](assets/hardware/schematic.jpg)

### PCB Layout

<p align="center">
  <img src="assets/hardware/pcb-f.jpg" alt="PCB Front" width="48%">
  <img src="assets/hardware/pcb-b.jpg" alt="PCB Back" width="48%">
</p>

### 3D Model

<p align="center">
  <img src="assets/hardware/3d-f.jpg" alt="PCB Front" width="48%">
  <img src="assets/hardware/3d-b.jpg" alt="PCB Back" width="48%">
</p>

### Assembly

<p align="center">
  <img src="assets/hardware/real-a.jpg" alt="Assembly View A" width="45%">
  <img src="assets/hardware/real-b.jpg" alt="Assembly View B" width="45%">
</p>

<p align="center">
  <img src="assets/hardware/real-c.jpg" alt="Assembly View C" width="45%">
  <img src="assets/hardware/real-d.jpg" alt="Assembly View D" width="45%">
</p>

## Firmware

### Config and build

<p align="center">
  <img src="assets/firmware/config.gif" alt="PCB Front" width="48%">
  <img src="assets/firmware/build.gif" alt="PCB Back" width="48%">
</p>

### Runtime

![Runtime](assets/firmware/run-time.gif)

## App

### Demo

<p align="center">
  <img src="assets/app/app-1.gif" alt="App Demo 1" width="23%">
  <img src="assets/app/app-2.gif" alt="App Demo 2" width="23%">
  <img src="assets/app/app-3.gif" alt="App Demo 3" width="23%">
  <img src="assets/app/app-4.gif" alt="App Demo 4" width="23%">
</p>

## Contributing

- For structural work, also read `docs/architecture/ARCHITECTURE.md`, `docs/reference/MQTT_PROTOCOL.md`, and `docs/reference/API_REFERENCE.md`.
- Changes to the incident schema or the contract domain must regenerate the derived files (`make incident-gen`) and keep `make incident-gen-check` clean.
- Keep changes narrow, update matching docs when contracts change, and run the narrowest verification for the area you touched.

## License

MIT. See [LICENSE.md](LICENSE.md).
