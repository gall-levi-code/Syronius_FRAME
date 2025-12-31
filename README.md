# Syronius’ Frame (F.R.A.M.E.)

**Source of Truth:** [`docs/spec/v1.1.md`](docs/spec/v1.1.md)

Syronius’ Frame (F.R.A.M.E.) is a modular, containerized IRL streamer appliance stack. This repository is scaffolded to treat the spec as the canonical contract, with schemas and design decisions tracked alongside it.

## What’s in this repo

- `docs/spec/v1.1.md` — The V1 spec + V1.1 refinements (the canonical contract).
- `docs/schemas/` — JSON Schemas for on-disk and API contracts (validation at startup / install-time).
- `docs/adr/` — Architecture Decision Records (why we chose a behavior/contract).

## How to run (implementation in progress)

This scaffold currently focuses on documentation and contracts. As implementation lands, the “How to run” section will be updated with exact commands.

**Planned local run (Docker/Compose):**
1. Install Docker Engine + Docker Compose plugin.
2. Create a data directory on the host (example):
   - Linux/macOS: `/opt/frame-data`
   - Windows: `D:\FRAME_DATA`
3. Start the stack (example placeholder):
   ```bash
   docker compose up -d
   ```
4. Open the Portal in your browser (example placeholder):
   - `http://<frame-host>/dashboard`

## Contributing / Changing the spec

- Spec changes should be made via PRs with clear diffs.
- If a change modifies a contract (file format / endpoint), update or add a schema in `docs/schemas/`.
- Record non-trivial decisions in `docs/adr/` (one decision per file).

## License

See [`LICENSE`](LICENSE) (if/when added).
