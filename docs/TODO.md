# FRAME Running TODO

This is the durable implementation backlog for work intentionally deferred from the current
milestone. Items stay here until implemented, superseded by an ADR/spec change, or explicitly
removed.

## Overlay System

### Current Relay / Overlay Milestone

- [x] Build `frame-ingest-video` around the OpenIRL SRTLA Receiver.
- [x] Build a FRAME-owned, themed `frame-streams` management UI against the receiver API.
- [x] Build the `frame-overlays` connectivity renderer and wizard.
- [x] Seed `default-connectivity` as the stock preset on first run.
- [x] Let users restore or duplicate the stock default without overwriting their custom presets.
- [x] Validate that `default_preset_id` resolves to an existing preset.
- [x] Allow stock connectivity presets to remain unbound until selected in the wizard.
- [x] Warn when visibility toggles would make an overlay completely blank.
- [x] Provide stable `/overlays/view/<preset-id>` OBS URLs.
- [x] Add stream-card actions for Create Overlay, Manage Overlays, and Open Statistics.
- Add preset import/export to the wizard.
- Add live SRT publisher integration tests so renderer quality states are exercised with real traffic.

### Keep Separate For Later

- Upload progress overlay and photo-pipeline telemetry integration.
- Latest-photo overlay and Today Tools integration.
- General-purpose freeform overlay editor.
- Cross-service overlay composition and scene bundles.
- Import/export preset packs.
- Per-preset access tokens for publicly exposed OBS URLs.

## Audio Monitor

- [x] Build browser audio-device capture and one-publisher-per-source enforcement.
- [x] Relay browser audio through ffmpeg as AAC/HLS with stable listener pages.
- [x] Add always-on silence generation for uninterrupted listener URLs.
- [x] Integrate Audio Monitor with FRAME Edge, the installer, and the unified data root.
- Add authenticated Hybrid routing before exposing capture or admin routes publicly.
- Add listener-generation invalidation controls for forcibly disconnecting old listener sessions.
- Add relay retention controls and long-session soak tests.
- Add automated browser capture integration tests with a deterministic audio input.

## Installer / Platform

- [x] Add a canonical service/capability registry with dependency and profile activation tests.
- [x] Add a root `stack verify` command and GitHub verification workflow.
- [x] Decide that `frame-pipeline-photos` is an internal service activated by photo capabilities.
- Add API integration tests for implemented HTTP services.
- Add Audio Bridge session, profile, and control mutation tests before splitting `SessionManager`.
- Split installer environment/state responsibilities out of `frame-installer.mjs`.
- Expand the interactive installer beyond the current Hybrid hostname staging prompt.
- Add host-port conflict preflight detection.
- [x] Build the shared Traefik LAN HTTP edge and route implemented web services through it.
- [x] Add capability-aware Cloudflare Tunnel routing and staged HYBRID deployment.
- Add LAN HTTPS and optional Cloudflare Access policy automation.
- Define cross-platform external data-root mounting and reset boundaries.

## Photo Workflow

- [x] Freeze V1 processing, recovery, sidecar, and quarantine contracts.
- [x] Build the read-only FRAME photo gallery and thumbnail cache.
- [x] Build Today Tools with a direct multi-day gallery, OBS viewer, live EXIF display, and authenticated mobile remote.
- [x] Add protected Gallery Admin with reversible trash, album management, and authoritative latest-state recalculation.
- Build the Discord delivery outbox after Today Tools stabilizes.
- Add archive retention controls and disk-pressure policy.
- Add reliable HEIC decoding when the pinned production image runtime supports it.
- Add camera and long-running FTP soak tests.
