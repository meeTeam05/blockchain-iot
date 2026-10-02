# Run Book

Operational runbook for the `smart-air` server stack under `server/`.

This file covers manual start and stop, health verification, common operator actions, and first-response troubleshooting. It does not replace architecture or protocol documentation.

## Scope

- Stack location: `server/`
- Compose file: `server/docker-compose.yml`
- Main verification script: `scripts/check-server-connections.sh`
- Public operator entrypoint: root `Makefile`
- Architecture and contracts live elsewhere:
  - `docs/architecture/ARCHITECTURE.md`
  - `docs/reference/API_REFERENCE.md`
  - `docs/reference/MQTT_PROTOCOL.md`
- Chain worker (Sepolia relayer, indexer, alerts, unblock, relayer rotation):
  `docs/ops/CHAIN_WORKER_RUNBOOK.md`

## Current Operating Model

- Docker does not need to auto-start on boot.
- The `smart-air` stack does not auto-start when Docker starts.
- Compose services do not use `restart: unless-stopped`.
- Operators start Docker and the stack manually when needed.

## Service Inventory

Core services:

- `postgres`: primary database
- `redis`: cache and command queue
- `emqx`: MQTT broker
- `api`: Fastify API
- `nginx`: public reverse proxy
- `cloudflared`: Cloudflare Tunnel connector

Optional admin services:

- `pgadmin`: database UI
- `portainer`: Docker UI

Notes:

- `pgadmin` and `portainer` are optional and may be absent during normal runtime.

## Prerequisites

Before startup, ensure `server/.env` exists and required secrets are populated.

Create the local env file when missing:

```bash
make server-env-init
```

Then fill in the generated `server/.env` values and check required keys:

```bash
make server-env-check
```

Required at runtime for `server/api`:

- `JWT_SECRET`
- `POSTGRES_PASSWORD`
- `REDIS_PASSWORD`
- `EMQX_API_KEY`
- `EMQX_API_SECRET`
- `EMQX_MQTT_PASSWORD`

Common service credentials and settings:

- `POSTGRES_DB`
- `POSTGRES_USER`
- `PGADMIN_EMAIL`
- `PGADMIN_PASSWORD`
- `EMQX_NODE_COOKIE`
- `MQTT_LAN_BIND_IP`

Cloudflare Tunnel:

- `CLOUDFLARE_TUNNEL_TOKEN` is required before starting `cloudflared`.
- The public entrypoint terminates at `nginx`.

## Manual Lifecycle

Start Docker manually:

```bash
sudo systemctl start docker
```

Start the full local stack, including admin services:

```bash
make server-up-admin
```

If optional admin containers fail to start because they reference a missing Docker network, recreate only those admin containers:

```bash
make server-admin-recreate
```

This is the default local-ops startup path when you want the full environment:

- core services
- `pgadmin` on `http://127.0.0.1:5050/`
- `portainer` on `http://127.0.0.1:9000/`

Start the core stack only:

```bash
make server-up
```

Stop the stack:

```bash
make server-down
```

This stops core services and optional admin services when they exist.

Stop Docker after the stack is down:

```bash
sudo systemctl stop docker.socket docker.service containerd.service
```

Disable Docker auto-start after reboot or login:

```bash
sudo systemctl disable --now docker.service docker.socket containerd.service
```

## Health Verification

Quick status:

```bash
make server-ps
```

Read-only runtime verification:

```bash
make server-check
```

What the verification script checks:

- Compose runtime state for `postgres`, `redis`, `api`, `nginx`, `cloudflared`, `emqx`, `pgadmin`, `portainer`
- `postgres` accepts `SELECT 1`
- `redis` responds to `PING`
- API live endpoint: `http://127.0.0.1:3000/api/health/live`
- API ready endpoint: `http://127.0.0.1:3000/api/health/ready`
- Nginx health endpoint: `http://127.0.0.1/nginx/health`
- EMQX broker status via `emqx ctl status`
- EMQX admin API on `http://127.0.0.1:18083/api/v5/status`
- `pgadmin` and `portainer` availability when declared and running

Healthy API readiness must report:

- `status = ok`
- `postgres = ok`
- `redis = ok`
- `mqtt = ok`

## Common Operations

View stack logs:

```bash
make server-logs
```

View logs for one service:

```bash
make server-log SERVICE=api
```

Restart one service:

```bash
make server-restart SERVICE=api
```

Rebuild and start the API:

```bash
make server-rebuild-api
```

Run database migrations:

```bash
make server-migrate
```

Render the final compose config:

```bash
make server-config
```

Render EMQX API bootstrap credentials from `server/.env`:

```bash
make server-render-emqx-key
```

## First-Response Troubleshooting

### API live is healthy, API ready is failing

Likely meaning:

- API process is up
- One dependency is not ready, usually `postgres`, `redis`, or `mqtt`

Check:

```bash
make server-check
make server-log SERVICE=api
```

Focus on:

- readiness JSON fields
- connection failures to `postgres`
- connection failures to `redis`
- MQTT bridge failures

### API ready reports `mqtt = fail`

Likely meaning:

- `api` cannot connect its MQTT bridge to `emqx`
- EMQX credentials or broker state are wrong

Check:

```bash
make server-log SERVICE=api
make server-log SERVICE=emqx
```

Focus on:

### App shows `Failed to load notifications`

Likely meaning:

- mobile app is calling `GET /api/notifications`
- the public API is still on an older build without that route, or
- the API code is updated but the database migration for `notification_events` has not run yet

Do this in order:

```bash
make server-migrate
make server-rebuild-api
```

Then verify:

- API live endpoint is healthy
- authenticated `GET /api/notifications` returns `200`

If it still fails:

- `404 Not found` usually means the API container is still running an older build
- `500` with missing relation errors usually means the `notification_events` migration did not apply

- `Connection refused`
- `Not authorized`
- `authentication_failure`
- `sa-api-bridge`
- `sa-server`

Verify:

- `EMQX_API_KEY` and `EMQX_API_SECRET` match the bootstrap config
- `EMQX_MQTT_PASSWORD` matches what the API bridge expects
- `emqx` is healthy before `api` is considered ready

### Nginx health fails

Likely meaning:

- `nginx` is up but misconfigured
- `api` upstream is not healthy

Check:

```bash
make server-log SERVICE=nginx
make server-log SERVICE=api
```

### Cloudflared is not running or public ingress is down

Likely meaning:

- `CLOUDFLARE_TUNNEL_TOKEN` missing or wrong
- tunnel not registered correctly in Cloudflare
- `nginx` upstream is unhealthy

Check:

```bash
make server-log SERVICE=cloudflared
make server-ps
```

Focus on confirmed tunnel-registration success, not just container uptime.

### Admin containers fail with `network ... not found`

Likely meaning:

- `pgadmin` or `portainer` is an old stopped container
- Docker recreated `smart-air_sa-net`
- the old container metadata still points to the deleted network ID

Fix:

```bash
make server-admin-recreate
```

This removes only the `pgadmin` and `portainer` containers, then starts the admin profile again. It does not delete `server/pgadmin/data` or `server/portainer/data`.

### Postgres is healthy but API still fails

Likely meaning:

- migration not applied
- API config mismatch
- another dependency is failing while Postgres is fine

Check:

```bash
make server-migrate
make server-log SERVICE=api
```

## Safety Notes

- `docker compose down` removes containers and networks, but keeps named volumes and bind-mounted data.
- Do not use `docker compose down -v` unless you intentionally want to destroy persisted state.
- Persistent data paths under `server/` include at least:
  - `postgres/data`
  - `redis/data`
  - `pgadmin/data`
  - `portainer/data`
- Treat `.env`, database state, Redis state, and EMQX credentials as operational data.

## References

- `server/docker-compose.yml`
- `server/.env.example`
- `Makefile`
- `scripts/check-server-connections.sh`
- `docs/architecture/ARCHITECTURE.md`
- `docs/reference/API_REFERENCE.md`
- `docs/reference/MQTT_PROTOCOL.md`
