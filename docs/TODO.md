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
- [x] Add a numbered interactive command center with issue-first Standard/Advanced guided setup.
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

### Remote Photo Agent / Belabox Module

- Define a `frame-remote-photo-agent` capability for deploying a managed photo relay helper onto a Belabox or similar Linux encoder on the local network.
- Build a FRAME-side setup wizard that can detect or accept the Belabox LAN IP, explain how to enable Belabox SSH, and connect with the fixed `user` SSH account plus the rotating password from the Belabox Advanced/developer panel.
- Generate FRAME-managed usernames, paths, script names, and systemd unit names instead of reusing personal prototype paths from the reference scripts.
- Configure a Belabox-local FTP ingest path for cameras, with a user-chosen camera FTP password and a reinstall option that rewrites the managed helper cleanly instead of creating duplicate services.
- Keep the first production version on SFTP for reliability, landing files in a FRAME inbox/remote-agent path before the normal stability gate moves them into staging.
- Default to deleting successfully transferred files on the Belabox, with an archive-completed-files option for users who want local recovery.
- Define a remote photo upload progress event schema for future overlays: discovered, stable, queued, transferring, transferred, failed, retried, and archived/deleted.
- Add a remote-agent status dashboard showing connection health, queue depth, last transfer, failures, and installed helper version.
- Revisit chunked HTTPS or multi-connection transfer later if SFTP reliability is not enough for bonded or multi-WAN scenarios.
- Keep remote photo overlay widgets in their own schema/preset namespace so they do not overwrite FRAME's stock connectivity presets.
- Refactor the overlay wizard so stock defaults are immutable, OBS URL slugs can be chosen before first save, and saving a renamed preset creates a new preset instead of rewriting `default-connectivity`.
