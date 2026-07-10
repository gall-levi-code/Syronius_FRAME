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

### Update System

- Define a GitHub Releases update manifest for FRAME releases, including version, channel,
  release archive URL, SHA256 checksum, minimum installer version, migration notes, and affected
  tool groups.
- Track installed versions in a FRAME-owned state file with separate entries for the whole FRAME
  release, user-facing tools, service/image build IDs, schema versions, and install timestamps.
- Add `stack update` and `stack update --tool <tool-id>` commands that preflight Docker, disk,
  active stream/upload risk, config validity, and migration compatibility before changing files.
- Implement stack-safe update transactions: snapshot `.env`, `docker-compose.yml`,
  `stack-config.json`, `/data/state`, and installed version state; download and verify the release;
  rerun the installer; pull/build affected services; restart only required containers; wait for
  health checks; restore the snapshot on failure.
- Extend Portal tool cards with installed version, latest version, update availability, and
  per-tool changelog dialogs.
- Let Portal show per-tool update buttons, but have the manifest decide whether the actual update is
  tool-only, tool-group, or full-stack.
- Add a top-level FRAME update panel for shared installer, auth, routing, schema, and dependency
  changes that cannot be safely presented as a single-tool update.
- Add `Update now` and `Schedule when idle` actions, with explicit blocking/warning states for live
  stream, active upload, unhealthy service, low disk, or incompatible migration.
- Keep Belabox agent updates separate from FRAME stack updates.
- Add a bootstrap-only Belabox agent updater: the current installed agent cannot learn update
  behavior over MQTT until an updater-capable agent has been installed once.
- Host signed/versioned Belabox agent update manifests and bundles from FRAME over HTTPS, with
  short-lived package URLs suitable for MQTT/WSS delivery.
- Implement signed `agent_update` commands carrying artifact name, version, manifest/package URL,
  SHA256 checksum, size, expiry, and optional rollback target.
- Have the Belabox agent download updates over HTTPS, verify command signature and checksums, stage
  files, run agent/connector self-tests, atomically swap the scripts, restart, and report the new
  heartbeat/version.
- Report update progress over MQTT with phases such as downloading, verified, installing,
  restarting, failed, and rolled back.
- Defer silent automatic updates until rollback, idle detection, and stream/upload safety are proven.

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
- Define a `frame-remote-photo-agent` capability for deploying a managed photo relay helper onto a Belabox or similar Linux encoder on the local network.
- Build a FRAME-side setup wizard that can detect or accept the Belabox LAN IP, explain how to enable Belabox SSH, and connect with the fixed `user` SSH account plus the rotating password from the Belabox Advanced/developer panel.
- Generate FRAME-managed usernames, paths, script names, and systemd unit names instead of reusing personal prototype paths from the reference scripts.
- Configure a Belabox-local FTP ingest path for cameras, with a user-chosen camera FTP password and a reinstall option that rewrites the managed helper cleanly instead of creating duplicate services.
- Keep the first production version on SFTP for reliability, landing files in a FRAME inbox/remote-agent path before the normal stability gate moves them into staging.
- Default to deleting successfully transferred files on the Belabox, with an archive-completed-files option for users who want local recovery.
- Define a remote photo upload progress event schema for future overlays: discovered, stable, queued, transferring, transferred, failed, retried, and archived/deleted.
- Add a remote-agent status dashboard showing connection health, queue depth, last transfer, failures, and installed helper version.
- Belabox Manager UX simplification pass:
  - [x] Rename `MQTT Controls` to `Photo Transfer`.
  - [x] Hide protocol terms like MQTT, WSS, chunk relay, and egress binding behind Advanced.
  - [x] Add an `Encoder Status` strip for online state, remote UI, Photo Agent, and stream health.
  - [x] Make `Open Encoder Remote` the primary online action.
  - [x] Replace raw state strings with user-facing states such as `Ready`, `Uploading`, `Processing`, `Waiting for encoder`, and `Needs setup`.
  - [x] Add a visual photo pipeline: camera received, processing, upload-ready, sending, published.
  - [x] Add a stream-safe upload preset that caps photo upload while live.
  - [x] Add transfer presets: `Protect Stream`, `Balanced`, and `Fast`.
  - [x] Show upload caps in Mbps with helper context instead of kbps-only.
  - [x] Show egress lanes as `Ethernet`, `Wi-Fi 1`, and `Wi-Fi 2` health chips.
  - [x] Show the active upload lane during transfer.
  - [x] Add a `What is slowing things down?` summary for CPU prep, network upload, FRAME ingest, or waiting.
  - [x] Collapse SSH maintenance unless the agent is missing or repair is needed.
  - [x] Rename `Install / Repair Photo Agent` to `Repair Agent`.
  - [x] Add live upload stats: current file, rate, queue depth, and ETA.
  - [x] Warn when uploads are uncapped while streaming.
  - [x] Add a diagnostics drawer for raw MQTT, route, and chunk details.
  - [x] Add a remote access URL row with copy/open buttons.
- Belabox Manager UX completion goal: make first-time setup, daily monitoring, photo transfer, and
  maintenance understandable without requiring knowledge of MQTT, WSS, SSH jobs, or egress internals.
  - [x] Phase UX-1 - Device workspace: reshape the device page into a compact status band, one guided
    Photo Transfer workspace, and collapsed Maintenance/Advanced sections; remove duplicate controls and
    keep heartbeat refreshes from moving, collapsing, or replacing active fields.
    - Acceptance: the first viewport answers whether the encoder is online, what it is doing, what is
      slowing it down, and the next useful action without opening Advanced.
  - [x] Phase UX-2 - Device identity and agent lifecycle: add editable unique display names, preserve the
    immutable device ID as a technical detail, and add an installed-agent summary with version, last
    heartbeat, health, and a quiet update-available state.
    - Acceptance: users can distinguish devices and identify a missing, stale, unhealthy, or outdated
      agent without reading raw telemetry.
  - [x] Phase UX-3 - Guided photo transfer: combine Photo Agent and Photo Transfer into one operational
    flow covering camera receipt, preparation, queue, active route, upload, FRAME processing, and result;
    retain stream-safe presets and add short-lived completed/failed result notices.
    - Acceptance: routine transfers and bottlenecks can be understood and controlled without opening
      Maintenance or Advanced.
  - [x] Phase UX-4 - Safe maintenance: move uninstall, queue reset, saved-credential removal, and other
    destructive actions into explicit confirmation dialogs; keep repair/install actions blocking with
    visible steps, progress, failure detail, and a clear retry path. Queue reset must preserve settings.
    - Acceptance: no critical operation runs silently, can be triggered accidentally, or leaves the user
      without a useful success/failure state.
  - [x] Phase UX-5 - Installation and navigation polish: bring the setup wizard, manager tabs, typography,
    spacing, controls, and action dialogs into one visual system; verify hybrid/SSH gates, uniqueness checks,
    back navigation, final checks, redirect to the installed device, and last-viewed-device restoration.
    - Acceptance: setup remains inside the wizard until verification completes and returning users land on
      the device they last viewed.
  - [ ] Phase UX-6 - Production verification: test desktop/mobile layouts, keyboard and focus behavior,
    long labels, heartbeat polling during edits, offline/online recovery, failed SSH jobs, active uploads,
    and real-device install/repair/uninstall flows.
    - [x] Automated contracts, syntax checks, TypeScript builds, agent self-tests, graph refresh, container
      health, live manager/pipeline status, keyboard focus, and blocking-dialog isolation.
    - [x] Real-device Repair Agent and guarded empty-queue reset, including post-install heartbeat and
      installed-version verification.
    - [ ] Rendered desktop/mobile inspection and transfer-result checks during an actual photo upload.
    - Acceptance: no overflow, unintended navigation, stale modal, lost input, or control-state regression
      remains in the supported workflows.
- Revisit chunked HTTPS or multi-connection transfer later if SFTP reliability is not enough for bonded or multi-WAN scenarios.
- Keep remote photo overlay widgets in their own schema/preset namespace so they do not overwrite FRAME's stock connectivity presets.
- Refactor the overlay wizard so stock defaults are immutable, OBS URL slugs can be chosen before first save, and saving a renamed preset creates a new preset instead of rewriting `default-connectivity`.
