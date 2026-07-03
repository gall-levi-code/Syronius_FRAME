# FRAME Running TODO

This is the durable implementation backlog for work intentionally deferred from the current
milestone. Items stay here until implemented, superseded by an ADR/spec change, or explicitly
removed.

## Overlay System

### Current Relay / Overlay Milestone

- [x] Build `frame-ingest-video` around the OpenIRL SRTLA Receiver.
- [x] Build a FRAME-owned, themed `frame-streams` management UI against the receiver API.
- [x] Build the `frame-overlays` connectivity renderer and wizard.
- [x] Ship `default-connectivity` as an immutable built-in template.
- [x] Separate reusable presets from bound OBS sources and permanent source URLs.
- [x] Migrate V1 state with backups and preserve every legacy `/overlays/view/<preset-id>` URL.
- [x] Deduplicate telemetry polling and fan out live telemetry/config revisions over SSE.
- [x] Warn when visibility toggles would make an overlay completely blank.
- [x] Provide keyed `/overlays/view/<slug>/<source-key>` URLs while preserving V1 aliases.
- [x] Add a top-level Manage Overlays action and per-stream bound-source counts/listing.
- [x] Add the immutable upload-progress template, type-isolated presets, web-upload telemetry adapter, and multi-file renderer foundation.
- Add live SRT publisher integration tests so renderer quality states are exercised with real traffic.

### Keep Separate For Later

- FTP/BELABOX upload-progress adapters and photo-pipeline queued/processing/published correlation.
- Latest-photo overlay and Photo Stage integration.
- General-purpose freeform overlay editor.

## Audio Monitor

- [x] Build browser audio-device capture and one-publisher-per-source enforcement.
- [x] Relay browser audio through ffmpeg as AAC/HLS with stable listener pages.
- [x] Add always-on silence generation for uninterrupted listener URLs.
- [x] Integrate Audio Monitor with FRAME Edge, the installer, and the unified data root.
- Add relay retention controls and long-session soak tests.
- Remember recently seen browser audio devices so users do not have to refresh or reselect as often.

## Installer / Platform

- [x] Add a canonical service/capability registry with dependency and profile activation tests.
- [x] Add a root `stack verify` command and GitHub verification workflow.
- [x] Decide that `frame-pipeline-photos` is an internal service activated by photo capabilities.
- Add API integration tests for implemented HTTP services.
- [x] Add Audio Bridge session, profile, and control mutation tests before splitting `SessionManager`.
- [x] Add Audio Bridge HTTP route tests for portal status, bridge pages, and token gates.
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
- [x] Build Photo Stage with a direct multi-day gallery, OBS viewer, live EXIF display, and authenticated mobile remote.
- [x] Add protected Gallery Admin with reversible trash, album management, and authoritative latest-state recalculation.
- Add `/stage/*` Photo Stage routes while preserving `/today/*` compatibility aliases.
- Build the Discord delivery outbox after Photo Stage stabilizes.
- Add archive retention controls and disk-pressure policy.
- Add reliable HEIC decoding when the pinned production image runtime supports it.
- Add camera and long-running FTP soak tests.

### Remote Photo Agent / Belabox Module

- [x] Phase 4B: reuse the existing overlay SSE path for all photo-upload progress instead of adding a
  separate WebSocket transport.
- [x] Phase 4B: expose a shared upload-progress shape for `web_upload`, `belabox_agent`, and `ftp`
  adapters: transfer ID, adapter, phase, filename, received/sent bytes, optional total bytes,
  speed, elapsed time, status text, and timestamps.
- [x] Phase 4B: keep Belabox chunk/FTP connector progress authoritative from the Belabox agent because
  the sender knows the local file size and exact bytes sent.
- [x] Phase 4B: add lightweight `frame-photo-ftp` ingest progress by tracking growing inbox files and
  staged/completed events; true percent remains unavailable unless the sender reports total size.
- [x] Phase 4B: add `/api/internal/photo-ftp/progress` and enable the Overlay Wizard `ftp` adapter once
  `frame-photo-ftp` exposes progress directly.
- [ ] Add an optional upload-result bubble lane for short-lived completed/failed file notices while the
  main upload card immediately advances to the next active file.
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
