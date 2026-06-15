# FRAME Portal

FRAME Portal is the shared dashboard and observability service for Syronius FRAME. It provides
capability-aware navigation, container health, disk alerts, live logs, and the canonical
`/status/api` endpoint.

The UI carries the same FRAME logo, blue accent system, and persistent day/night themes as FRAME
Audio Bridge.

## Current Features

- `/dashboard` navigation-first tool launcher and `/status` operational status view.
- Public/LAN access-context awareness that disables LAN-only management links on the public dashboard.
- `/status/api` machine-readable FRAME status response.
- Dynamic tools generated from `/data/state/stack-config.json`.
- Docker container status, health, and uptime for containers whose names begin with `frame-`.
- FRAME data disk usage and low-space alerts.
- Live container logs over Server-Sent Events.
- Optional container restart actions.
- Visible standalone fallback warning while the unified FRAME installer is still being built.
- Authoritative Audio Bridge bot, voice, mix, engine, and client telemetry.
- Ready, Needs setup, Offline, and Disabled tool states.
- Short server-side status cache, Docker request timeouts, and bounded browser log history.

## Security Model

FRAME Portal uses a restricted Docker socket proxy by default and disables Docker API POST requests
and restart actions.

The proxy exposes container-read endpoints for status and log collection without mounting the
Docker socket into the Portal container. Hybrid mode may expose the Portal through the generated
allowlist gateway. LAN-only management surfaces remain disabled on the public dashboard and are
defensively denied at FRAME Edge.

Basic authentication is optional in LAN mode and required in HYBRID mode:

```text
PORTAL_USERNAME=frame
PORTAL_PASSWORD=replace_with_a_long_random_password
```

Only send Basic authentication credentials over HTTPS. Hybrid deployments must terminate HTTPS at
the authenticated FRAME edge before traffic reaches Portal.

To enable restart actions, set:

```text
ENABLE_CONTAINER_RESTARTS=true
DOCKER_PROXY_POST=1
```

Proxy POST access grants the Portal substantial control over containers and should only be enabled
for trusted operators.

## Environment

Copy `.env.example` to `.env` when running standalone:

```text
PORT=3730
FRAME_MODE=LAN
DATA_ROOT=/data
STACK_CONFIG_PATH=/data/state/stack-config.json
DOCKER_HOST=http://frame-docker-proxy:2375
DOCKER_SOCKET_PATH=/var/run/docker.sock
SERVICE_NAME_PREFIX=frame-
ENABLE_CONTAINER_RESTARTS=false
DOCKER_PROXY_POST=0
STATUS_REFRESH_MS=5000
STATUS_CACHE_MS=4000
REQUEST_TIMEOUT_MS=3000
AUDIO_BRIDGE_STATUS_URL=http://host.docker.internal:3728/api/internal/portal-status
AUDIO_BRIDGE_STATUS_TOKEN=replace_with_the_same_service_token_as_audio_bridge
PORTAL_USERNAME=
PORTAL_PASSWORD=
PORTAL_REALM=FRAME Portal
DISK_WARN_PERCENT=85
DISK_ERROR_PERCENT=95
DISK_MINIMUM_FREE_GB=20
```

## Run With Docker Compose

```bash
docker compose up --build -d
```

Open:

```text
http://localhost:3730/dashboard
```

The standalone Compose file mounts `./data` as `/data`. In the unified FRAME stack, point the Portal
at the shared FRAME data root and generated `state/stack-config.json`.

Use the same long random value for Audio Bridge `PORTAL_SERVICE_TOKEN` and Portal
`AUDIO_BRIDGE_STATUS_TOKEN`.

## Storage and Retention

Portal displays free space and raises configurable low-disk alerts. It never deletes FRAME data.
Before enabling photo or video ingest, select a `DATA_ROOT` with sufficient capacity and decide how
long archive, quarantine, and published gallery data should remain. Automatic deletion should only
be added after that policy is explicit.

## API

- `GET /healthz`
- `GET /api/portal`
- `GET /status/api`
- `GET /status/logs/:serviceName`
- `POST /status/services/:serviceName/restart` when restarts are enabled

The Portal does not expose private Audio Bridge control URLs or tokens. Its Discord Audio Bridge
tool opens the service-health section instead.

## Development

```bash
npm install
npm run dev
```

Production verification:

```bash
npm run typecheck
docker build -t frame-portal .
```
