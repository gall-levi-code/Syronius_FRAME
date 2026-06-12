# Syronius’ Frame (F.R.A.M.E.)

**Source of Truth:** [`docs/spec/v1.1.md`](docs/spec/v1.1.md)

**Running Backlog:** [`docs/TODO.md`](docs/TODO.md)

Syronius’ Frame (F.R.A.M.E.) is a modular, containerized IRL streamer appliance stack. This repo is organized so the spec is the canonical contract, with schemas and decisions tracked alongside it.

## What’s in this repo

- `docs/spec/v1.1.md` — The V1 spec + V1.1 refinements (the canonical contract).
- `docs/schemas/` — JSON Schemas for on-disk and API contracts (validation at startup / install-time).
- `docs/adr/` — Architecture Decision Records (why we chose a behavior/contract).
- `services/frame-portal/` — Implemented FRAME dashboard, status API, container health, logs, and alerts.
- `services/frame-audio-bridge/` — Implemented Discord voice-to-OBS bridge service, control page, overlays, and Docker deployment.
- `services/frame-audio/` — Implemented browser-capture audio monitor, AAC/HLS relay, and remote listener pages.
- `services/frame-ingest-video/` — Pinned OpenIRL SRTLA receiver wrapper with deterministic FRAME API-key seeding.
- `services/frame-streams/` — FRAME-owned stream profile management and live relay telemetry UI.
- `services/frame-overlays/` — Stable OBS connectivity overlays and mobile-friendly preset wizard.
- `docker_container_samples/` — Reference container examples that are not yet first-class FRAME services.

## Implemented Services

### FRAME Edge

`services/frame-edge/` is the shared Traefik LAN HTTP entry point. It routes Portal, Stream
Management, and Overlay paths through one address while direct service ports remain available for
development and migration.

### FRAME Tunnel

`services/frame-tunnel/` documents the optional staged Hybrid connector. Cloudflare traffic reaches
an internal-only generated public gateway before FRAME Edge, keeping LAN-only routes unavailable.

### FRAME Portal

`services/frame-portal/` is the shared FRAME dashboard and observability service. It builds navigation
from `stack-config.json`, reports container and disk health, and streams container logs.

```bash
cd services/frame-portal
docker compose up --build -d
```

Open `http://localhost/dashboard` through FRAME Edge. The direct development fallback remains
`http://localhost:3730/dashboard`. See
[`services/frame-portal/README.md`](services/frame-portal/README.md) for Docker access and security
details.

### FRAME Audio Bridge

`services/frame-audio-bridge/` is a working optional FRAME service. It joins Discord voice channels,
creates separate per-streamer mixes, and serves permanent OBS audio/overlay URLs plus a mobile-first
control page.

It can still run standalone, or be managed by the root FRAME installer:

```bash
cd services/frame-audio-bridge
cp .env.example .env
docker compose up --build -d
```

See [`services/frame-audio-bridge/README.md`](services/frame-audio-bridge/README.md) for Discord,
OBS, Cloudflare, security, and operating instructions.

### FRAME Audio Monitor

`services/frame-audio/` captures a LAN browser audio input such as a virtual audio cable or
VoiceMeeter output, relays it through ffmpeg as AAC/HLS, and serves stable remote listen pages.
It is separate from FRAME Audio Bridge and does not require a Discord bot.

```bash
stack.cmd install --enable frame-audio-relay
stack.cmd start
```

Open Audio Monitor at `http://localhost/audio/admin` through FRAME Edge. The direct development
fallback remains `http://localhost:3734/audio/admin`. See
[`services/frame-audio/README.md`](services/frame-audio/README.md) for capture and listener details.

### FRAME Video Relay And Overlays

The video relay module wraps OpenIRL's SRTLA receiver, adds a FRAME-owned stream management UI, and
serves stable OBS connectivity overlay URLs from a preset wizard.

```bash
stack.cmd install --enable frame-video-relay --enable frame-overlays
stack.cmd start
```

Open Stream Management at `http://localhost/slsui` and the Overlay Wizard at
`http://localhost/overlays/setup`. Direct development ports `3732` and `3733` remain available.
The relay exposes SRTLA on `5000/udp`, SRT player output on
`4000/udp`, direct SRT publisher ingest on `4001/udp`, and receiver statistics on `8080/tcp`.

## Unified installer

The implemented installer entrypoints own configuration, data layout, shared secrets, generated
Compose, and lifecycle for deployable FRAME services:

- **Linux/macOS:** `stack.sh`
- **Windows:** `stack.cmd`

The installer is responsible for:
- creating/updating `.env`
- creating/updating the repo-local `./data/` directory (bind-mounted into containers as `/data`)
- generating/updating `docker-compose.yml` and `/data/state/stack-config.json`
- validating prerequisites, canonical configuration, and startup requirements
- deploying the stack via `docker compose up -d`

Fresh installations enable only FRAME Edge and Portal. All media, integration, and Discord services
are opt-in so a new deployment never starts a bot or claims their network ports without an explicit
capability choice.

### Commands
> Docker and Docker Compose v2 are the only host runtime prerequisites. Both entrypoints use the
> same shared installer runtime, preventing Windows and Unix behavior from drifting.

**Install / reconfigure**
- Windows:
  ```bat
  stack.cmd install
  ```
- Linux/macOS:
  ```bash
  chmod +x stack.sh
  ./stack.sh install
  ```

Import an existing ignored Audio Bridge environment when moving to the unified stack:

```bat
stack.cmd install --import-env services/frame-audio-bridge/.env
```

Existing standalone service containers and Audio Bridge data require a one-time handoff before the
unified first start. Follow the migration steps in [`installer/README.md`](installer/README.md).

Re-running `install` is the supported way to:
- enable/disable capabilities
- change direct host ports or the repository-relative data root
- import an existing Audio Bridge `.env`

**Lifecycle**
- Start:
  - `stack.* start` → `docker compose up -d`
- Stop:
  - `stack.* stop` → `docker compose down`
- Status:
  - `stack.* status` → prints service status + enabled capabilities (with secrets redacted)
- Reset (destructive):
  - `stack.* reset` → removes containers/volumes as applicable, deletes `./data/`, then re-runs `install` (requires confirmation)

The installer supports LAN deployment and staged Hybrid deployment through a remotely managed
Cloudflare Tunnel. Run `stack.cmd hybrid-stage` to generate the public allowlist and required
configuration without launching the tunnel. Hybrid startup remains blocked until the tunnel token
and Portal credentials are supplied. See [`installer/README.md`](installer/README.md).

### Verification

Run the deterministic contract and syntax checks before committing or deploying changes:

```bat
stack.cmd verify
```

```bash
./stack.sh verify
```

GitHub pull requests also run service typechecks and builds through
`.github/workflows/verify.yml`. The canonical capability, route, dependency, Compose-profile, and
Hybrid-exposure registry is [`config/frame-services.json`](config/frame-services.json). See
[`docs/STABILIZATION.md`](docs/STABILIZATION.md) for the current maintenance boundaries.

### After install
Once running, open the Portal:
- `http://<frame-host>/dashboard`
- If a change modifies a contract (file format / endpoint), update or add a schema in `docs/schemas/`.
- Record non-trivial decisions in `docs/adr/` (one decision per file).

## License

See [`LICENSE`](LICENSE) (if/when added).
