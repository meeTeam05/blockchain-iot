SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

ROOT_DIR := $(CURDIR)
SERVER_DIR := $(ROOT_DIR)/server
API_DIR := $(SERVER_DIR)/api
APP_DIR := $(ROOT_DIR)/app
WEB3_DIR := $(ROOT_DIR)/web3
FIRMWARE_DIR := $(ROOT_DIR)/firmware

COMPOSE := docker compose -f "$(SERVER_DIR)/docker-compose.yml" --env-file "$(SERVER_DIR)/.env"
SERVICE ?= api
TAIL ?= 200
IDF_EXPORT ?= $(HOME)/.espressif/v5.4.2/esp-idf/export.sh
EMQX_BOOTSTRAP ?= $(SERVER_DIR)/emqx/api-key.bootstrap

SERVER_REQUIRED_ENV := \
	JWT_SECRET \
	POSTGRES_PASSWORD \
	REDIS_PASSWORD \
	EMQX_API_KEY \
	EMQX_API_SECRET \
	EMQX_MQTT_PASSWORD

.PHONY: help
.PHONY: server-env-init server-env-check server-config server-up server-up-build server-up-admin server-admin-recreate server-down
.PHONY: server-ps server-check server-logs server-log server-restart server-rebuild-api
.PHONY: server-migrate server-test server-dev server-start server-render-emqx-key
.PHONY: app-pub-get app-analyze app-test app-run app-build-apk
.PHONY: web3-install web3-dev web3-build web3-test web3-test-e2e
.PHONY: firmware-build firmware-flash firmware-monitor firmware-flash-monitor firmware-menuconfig firmware-size
.PHONY: host-docker-start host-docker-stop host-docker-disable-autostart

help:
	@printf '%s\n' \
		'Usage: make <target> [SERVICE=api] [TAIL=200]' \
		'' \
		'Server:' \
		'  server-env-init          Create server/.env from server/.env.example when missing' \
		'  server-env-check         Check required server/.env keys exist and are non-empty' \
		'  server-config            Render the final Docker Compose config' \
		'  server-up                Start the core server stack' \
		'  server-up-build          Build and start the core server stack' \
		'  server-up-admin          Start the stack with optional admin services' \
		'  server-admin-recreate    Recreate optional admin containers without deleting data' \
		'  server-down              Stop the stack and remove orphan containers' \
		'  server-ps                Show compose service status' \
		'  server-check             Run read-only runtime connectivity checks' \
		'  server-logs              Show stack logs; override TAIL=200' \
		'  server-log               Show one service log; override SERVICE=api TAIL=200' \
		'  server-restart           Restart one service; override SERVICE=api' \
		'  server-rebuild-api       Rebuild and start the API service' \
		'  server-migrate           Run API database migrations' \
		'  server-test              Run API tests' \
		'  server-dev               Run API in local watch mode' \
		'  server-start             Run API locally' \
		'  server-render-emqx-key   Render EMQX API bootstrap file from server/.env' \
		'' \
		'App:' \
		'  app-pub-get              Fetch Flutter dependencies' \
		'  app-analyze              Run Flutter analyzer' \
		'  app-test                 Run Flutter tests' \
		'  app-run                  Run the Flutter app' \
		'  app-build-apk            Build Android release APK' \
		'' \
		'Web3 dApp (Task 5):' \
		'  web3-install             Install web3/ dependencies' \
		'  web3-dev                 Run the dApp dev server' \
		'  web3-build               Build the dApp for production' \
		'  web3-test                Run web3/ unit + integration tests (Vitest)' \
		'  web3-test-e2e            Run web3/ Playwright E2E tests' \
		'' \
		'Firmware:' \
		'  firmware-build           Build ESP-IDF firmware' \
		'  firmware-flash           Flash ESP-IDF firmware' \
		'  firmware-monitor         Start ESP-IDF monitor' \
		'  firmware-flash-monitor   Flash then monitor' \
		'  firmware-menuconfig      Open ESP-IDF menuconfig' \
		'  firmware-size            Show ESP-IDF size report' \
		'' \
		'Host Docker, Linux/systemd only:' \
		'  host-docker-start' \
		'  host-docker-stop' \
		'  host-docker-disable-autostart'

server-env-init:
	@test -f "$(SERVER_DIR)/.env" || cp "$(SERVER_DIR)/.env.example" "$(SERVER_DIR)/.env"

server-env-check:
	@test -f "$(SERVER_DIR)/.env" || { echo "Missing server/.env. Run: make server-env-init"; exit 1; }
	@missing=0; \
	for key in $(SERVER_REQUIRED_ENV); do \
		if ! awk -F= -v key="$$key" '\
			/^[[:space:]]*#/ || /^[[:space:]]*$$/ { next } \
			{ name=$$1; gsub(/^[[:space:]]+|[[:space:]]+$$/, "", name); value=substr($$0, index($$0, "=") + 1); gsub(/^[[:space:]]+|[[:space:]]+$$/, "", value); if (name == key && value != "") found=1 } \
			END { exit found ? 0 : 1 }' "$(SERVER_DIR)/.env"; then \
			echo "Missing or empty server/.env key: $$key"; \
			missing=1; \
		fi; \
	done; \
	exit "$$missing"

server-config: server-env-check
	$(COMPOSE) config

server-up: server-env-check
	$(COMPOSE) up -d

server-up-build: server-env-check
	$(COMPOSE) up -d --build

server-up-admin: server-env-check
	$(COMPOSE) --profile admin up -d

server-admin-recreate: server-env-check
	$(COMPOSE) --profile admin rm -sf pgadmin portainer
	$(COMPOSE) --profile admin up -d

server-down:
	$(COMPOSE) --profile admin down --remove-orphans

server-ps: server-env-check
	$(COMPOSE) ps

server-check:
	$(ROOT_DIR)/scripts/check-server-connections.sh

server-logs: server-env-check
	$(COMPOSE) logs --tail=$(TAIL)

server-log: server-env-check
	$(COMPOSE) logs --tail=$(TAIL) $(SERVICE)

server-restart: server-env-check
	$(COMPOSE) restart $(SERVICE)

server-rebuild-api: server-env-check
	$(COMPOSE) up -d --build api

server-migrate:
	cd "$(API_DIR)" && npm run migrate

server-test:
	cd "$(API_DIR)" && npm test

# Regenerate firmware/backend EIP-712 domain files from spec/incident/deployments.
.PHONY: incident-gen incident-gen-check e2e-chain-local
incident-gen:
	node "$(ROOT_DIR)/spec/incident/gen/gen-all.mjs"

incident-gen-check:
	node "$(ROOT_DIR)/spec/incident/gen/gen-all.mjs" --check

# Chain E2E against a hardhat node already running on :8545 (cd blockchain && npx hardhat node).
e2e-chain-local:
	cd "$(ROOT_DIR)/blockchain" && npx hardhat compile
	cd "$(API_DIR)" && E2E_CHAIN_RPC_URL=http://127.0.0.1:8545 node --test test/e2e/chain-e2e.test.js

server-dev:
	cd "$(API_DIR)" && npm run dev

server-start:
	cd "$(API_DIR)" && npm start

server-render-emqx-key:
	"$(SERVER_DIR)/emqx/render-api-key-bootstrap.sh" "$(SERVER_DIR)/.env" "$(EMQX_BOOTSTRAP)"

app-pub-get:
	cd "$(APP_DIR)" && flutter pub get

app-analyze:
	cd "$(APP_DIR)" && flutter analyze

app-test:
	cd "$(APP_DIR)" && flutter test

app-run:
	cd "$(APP_DIR)" && flutter run

app-build-apk:
	cd "$(APP_DIR)" && flutter build apk --release

web3-install:
	cd "$(WEB3_DIR)" && npm install

web3-dev:
	cd "$(WEB3_DIR)" && npm run dev

web3-build:
	cd "$(WEB3_DIR)" && npm run build

web3-test:
	cd "$(WEB3_DIR)" && npm run test

web3-test-e2e:
	cd "$(WEB3_DIR)" && npm run test:e2e

firmware-build:
	cd "$(FIRMWARE_DIR)" && . "$(IDF_EXPORT)" && idf.py build

firmware-flash:
	cd "$(FIRMWARE_DIR)" && . "$(IDF_EXPORT)" && idf.py flash

firmware-monitor:
	cd "$(FIRMWARE_DIR)" && . "$(IDF_EXPORT)" && idf.py monitor

firmware-flash-monitor:
	cd "$(FIRMWARE_DIR)" && . "$(IDF_EXPORT)" && idf.py flash monitor

firmware-menuconfig:
	cd "$(FIRMWARE_DIR)" && . "$(IDF_EXPORT)" && idf.py menuconfig

firmware-size:
	cd "$(FIRMWARE_DIR)" && . "$(IDF_EXPORT)" && idf.py size

host-docker-start:
	sudo systemctl start docker

host-docker-stop:
	sudo systemctl stop docker.socket docker.service containerd.service

host-docker-disable-autostart:
	sudo systemctl disable --now docker.service docker.socket containerd.service
