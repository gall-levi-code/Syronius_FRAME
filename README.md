# Syronius’ Frame (F.R.A.M.E.)

**Source of Truth:** [`docs/spec/v1.1.md`](docs/spec/v1.1.md)

Syronius’ Frame (F.R.A.M.E.) is a modular, containerized IRL streamer appliance stack. This repo is organized so the spec is the canonical contract, with schemas and decisions tracked alongside it.

## What’s in this repo

- `docs/spec/v1.1.md` — The V1 spec + V1.1 refinements (the canonical contract).
- `docs/schemas/` — JSON Schemas for on-disk and API contracts (validation at startup / install-time).
- `docs/adr/` — Architecture Decision Records (why we chose a behavior/contract).

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
> This repository scaffold focuses on documentation/contracts. The installer scripts + compose will be added during implementation, but the intended UX/behavior is defined below.

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

## Contributing / Changing the spec

- Spec changes should be made via PRs with clear diffs.
- If a change modifies a contract (file format / endpoint), update or add a schema in `docs/schemas/`.
- Record non-trivial decisions in `docs/adr/` (one decision per file).

## License

See [`LICENSE`](LICENSE) (if/when added).
