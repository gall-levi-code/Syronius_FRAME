# Syronius’ Frame (F.R.A.M.E.)

**Source of Truth:** [`docs/spec/v1.1.md`](docs/spec/v1.1.md)

Syronius’ Frame (F.R.A.M.E.) is a modular, containerized IRL streamer appliance stack. This repo is organized so the spec is the canonical contract, with schemas and decisions tracked alongside it.

## What’s in this repo

- `docs/spec/v1.1.md` — The V1 spec + V1.1 refinements (the canonical contract).
- `docs/schemas/` — JSON Schemas for on-disk and API contracts (validation at startup / install-time).
- `docs/adr/` — Architecture Decision Records (why we chose a behavior/contract).
- `services/frame-portal/` — Implemented FRAME dashboard, status API, container health, logs, and alerts.
- `services/frame-audio-bridge/` — Implemented Discord voice-to-OBS bridge service, control page, overlays, and Docker deployment.
- `docker_container_samples/` — Reference container examples that are not yet first-class FRAME services.

## Implemented Services

### FRAME Portal

`services/frame-portal/` is the shared FRAME dashboard and observability service. It builds navigation
from `stack-config.json`, reports container and disk health, and streams container logs.

```bash
cd services/frame-portal
docker compose up --build -d
```

Open `http://localhost:3730/dashboard`. See
[`services/frame-portal/README.md`](services/frame-portal/README.md) for Docker access and security
details.

### FRAME Audio Bridge

`services/frame-audio-bridge/` is a working optional FRAME service. It joins Discord voice channels,
creates separate per-streamer mixes, and serves permanent OBS audio/overlay URLs plus a mobile-first
control page.

Run it standalone while the overall stack installer is still being implemented:

```bash
cd services/frame-audio-bridge
cp .env.example .env
docker compose up --build -d
```

See [`services/frame-audio-bridge/README.md`](services/frame-audio-bridge/README.md) for Discord,
OBS, Cloudflare, security, and operating instructions.

## How to run (per V1/V1.1 spec)

V1 defines a single installer entrypoint that owns configuration, data layout, and compose generation:

- **Linux/macOS:** `stack.sh`
- **Windows:** `stack.cmd`

The installer is responsible for:
- creating/updating `.env`
- creating/updating the repo-local `./data/` directory (bind-mounted into containers as `/data`)
- generating/updating `docker-compose.yml` and `/data/state/stack-config.json`
- validating prerequisites (Docker + Compose) and port conflicts
- deploying the stack via `docker compose up -d`

### Planned commands (V1)
> The overall installer scripts + generated compose are still planned. Implemented services can be
> run from their service directories until the unified installer owns them.

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

Re-running `install` is the supported way to:
- enable/disable capabilities
- switch **LAN** ↔ **HYBRID**
- regenerate compose + tunnel ingress rules

**Lifecycle**
- Start:
  - `stack.* start` → `docker compose up -d`
- Stop:
  - `stack.* stop` → `docker compose down`
- Status:
  - `stack.* status` → prints service status + enabled capabilities (with secrets redacted)
- Reset (destructive):
  - `stack.* reset` → removes containers/volumes as applicable, deletes `./data/`, then re-runs `install` (requires confirmation)

### After install
Once running, open the Portal:
- `http://<frame-host>/dashboard`
- If a change modifies a contract (file format / endpoint), update or add a schema in `docs/schemas/`.
- Record non-trivial decisions in `docs/adr/` (one decision per file).

## License

See [`LICENSE`](LICENSE) (if/when added).
