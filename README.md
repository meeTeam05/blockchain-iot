# blockchain-iot

![ESP32-S3](https://img.shields.io/badge/MCU-ESP32--S3-E7352C)
![ESP-IDF 5.4.2](https://img.shields.io/badge/ESP--IDF-5.4.2-111827)
![Expo SDK 57](https://img.shields.io/badge/Expo-SDK%2057-000020)
![Node.js 20](https://img.shields.io/badge/Node.js-20-339933)
![Solidity 0.8.28](https://img.shields.io/badge/Solidity-0.8.28-363636)
![License MIT](https://img.shields.io/badge/License-MIT-22C55E)

An ESP32-S3 indoor air quality monitor and smart home controller with a tamper-evident incident trail on Ethereum (Sepolia). The device detects gas alarms and signs them (EIP-712), a backend relayer anchors them on-chain, and the device owner verifies, acknowledges and resolves them in a web dApp. A testnet token (ASAFE) rewards fast reactions and penalises slow ones.

## Architecture

```text
                  BLE (Wi-Fi provisioning)
   Mobile app  <------------------------->  ESP32-S3 firmware
   (Expo, app/)                              (ESP-IDF, iot_code/)
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

Incident path: *device signs -> MQTT -> API verifies and stores -> relayer `logIncident` -> indexer confirms after N blocks -> owner acknowledges/resolves in the dApp*.

## Components

| Directory | Role | Stack |
|---|---|---|
| [`iot_code/`](iot_code) | Device firmware: sensors, display, relays, BLE provisioning, MQTT, OTA, on-device gas AI, signed incident queue | ESP-IDF 5.4.2, ESP32-S3, LVGL, TFLite Micro |
| [`server/`](server) | API, MQTT broker, databases, reverse proxy, tunnel, chain worker | Fastify 4, PostgreSQL/TimescaleDB, Redis, EMQX, Nginx, ethers 6 |
| [`app/`](app) | Mobile app: homes, BLE provisioning, dashboard, commands, OTA, calibration | Expo SDK 57, React Native, expo-router |
| [`contracts/`](contracts) | Smart contracts: `AirSafetyLog`, `AirSafeToken`, `SafetyIncentives`, tests, deploy scripts | Solidity 0.8.28, Hardhat, OpenZeppelin 5 |
| [`web3/`](web3) | dApp: verify evidence, acknowledge/resolve, token wallet, staking, keeper board | Vite, React 19, wagmi 3, viem 2 |
| [`spec/incident/`](spec/incident) | Single source of the EIP-712 domain and its generators | Node scripts |
| [`hardware/`](hardware) | KiCad schematic, PCB, BOM | KiCad |
| [`docs/`](docs) | Architecture, protocol, API reference, runbooks, test vectors, datasheets | Markdown |

## Course submission layout

| Required item | Location |
|---|---|
| `README.md` | this file |
| `/contracts` (Solidity) | [`contracts/`](contracts), sources in [`contracts/contracts/`](contracts/contracts) |
| `/ai_model` (model file) | [`ai_model/`](ai_model) |
| `/iot_code` (device firmware) | [`iot_code/`](iot_code) |
| `Report_Nhom10.pdf` | [`Report_Nhom10.pdf`](Report_Nhom10.pdf) |

## Sepolia deployment (chain ID 11155111)

| Contract | Address |
|---|---|
| `AirSafetyLog` | [`0x45CF175ffd4B1Ad77E87389d1e92945f9Bc88d3A`](https://sepolia.etherscan.io/address/0x45CF175ffd4B1Ad77E87389d1e92945f9Bc88d3A) |
| `AirSafeToken` | [`0xD01324896e7cCc099DB95212a54b5473a3B2DE34`](https://sepolia.etherscan.io/address/0xD01324896e7cCc099DB95212a54b5473a3B2DE34) |
| `SafetyIncentives` | [`0x4078c3a86708B4C4B3aD61aB5A282e0E6A9FAA04`](https://sepolia.etherscan.io/address/0x4078c3a86708B4C4B3aD61aB5A282e0E6A9FAA04) |

The local Hardhat network uses the same chain ID, so the dApp also checks the EIP-712 domain, the contract bytecode and the deployment receipt.

## Getting started

Prerequisites: Docker, Node.js 22 LTS for development (the API image runs Node 20), ESP-IDF 5.4.2 for firmware, Android SDK with JDK 17 for the mobile app, MetaMask for the dApp.

```bash
make help                     # list all targets

make server-env-init          # create server/.env from the example, then fill the secrets
make server-up                # postgres, redis, emqx, api, nginx, cloudflared
make server-check             # read-only connectivity checks

cd contracts && npm ci && npm test

make web3-install && make web3-dev        # http://127.0.0.1:5173/dapp/
make app-install && make app-run          # Android device connected over USB
make firmware-build                       # default profile; the incident profile is in docs/_RUN_BOOK.md
```

Demo: the offline part (firmware build, contract tests, backend tests, token incentives in a real browser) needs only the commands above and the test table below. The live part (real board, Sepolia, phone) needs a Sepolia `server/.env`. The step-by-step script with expected results is [`docs/_RUN_BOOK.md`](docs/_RUN_BOOK.md).

Configuration is read from `server/.env`. The backend deployment is selected by `INCIDENT_DEPLOYMENT` (`sepolia` or `localhost`); contract addresses come from `spec/incident/deployments/`, never type them by hand.

| Area | Test command |
|---|---|
| Contracts | `cd contracts && npm test` |
| Backend | `IDF_PATH=<esp-idf path> make server-test` |
| Mobile app | `make app-test` |
| dApp unit and integration | `make web3-test` |
| dApp end to end (needs a Hardhat node and the Docker stack) | `make web3-test-e2e` |
| Token incentives end to end | `cd web3 && npm run test:incentives-e2e` |
| EIP-712 generated files are current | `make incident-gen-check` |

## Documentation

| Topic | File |
|---|---|
| Demo script, commands and expected results | [`docs/_RUN_BOOK.md`](docs/_RUN_BOOK.md) |
| Chain worker operations | [`docs/ops/CHAIN_WORKER_RUNBOOK.md`](docs/ops/CHAIN_WORKER_RUNBOOK.md) |
| End-to-end run with a pre-filled `server/.env` | [`docs/ops/E2E_GUIDE_SERVER_ENV_HOLDER.md`](docs/ops/E2E_GUIDE_SERVER_ENV_HOLDER.md) |
| Architecture | [`docs/architecture/`](docs/architecture) |
| Incident Schema v2 and test vectors | [`docs/reference/BLOCKCHAIN_INCIDENT_SCHEMA.md`](docs/reference/BLOCKCHAIN_INCIDENT_SCHEMA.md), [`docs/test-vectors/`](docs/test-vectors) |
| Firmware side of incidents | [`docs/reference/BLOCKCHAIN_INCIDENT_FIRMWARE.md`](docs/reference/BLOCKCHAIN_INCIDENT_FIRMWARE.md) |
| On-device gas AI | [`docs/reference/AI.md`](docs/reference/AI.md) |
| MQTT topics and payloads | [`docs/reference/MQTT_PROTOCOL.md`](docs/reference/MQTT_PROTOCOL.md) |
| REST and SSE API | [`docs/reference/API_REFERENCE.md`](docs/reference/API_REFERENCE.md) |
| Contracts, incentive rules, deployment | [`contracts/README.md`](contracts/README.md) |
| dApp | [`web3/README.md`](web3/README.md) |
| Change history | [`CHANGELOG.md`](CHANGELOG.md) |

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

## License

MIT. See [LICENSE.md](LICENSE.md).
