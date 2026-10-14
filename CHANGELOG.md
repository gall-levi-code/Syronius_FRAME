# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project adheres to Semantic Versioning.

## Unreleased

- Added local support-report preview/copy/save with allowlisted diagnostics and no raw logs or
  credentials. Added verified full backup/restore, container removal that preserves settings/data,
  and reconnecting the launcher to an existing managed installation. Restore uses empty original
  paths on the same OS; backups include plaintext credentials and require private storage.
- Expanded native launcher candidate checks to Windows, Ubuntu, and both Mac architectures, with
  artifact identity/checksum reports, keyboard/zoom/no-tray smoke coverage, and a separate downloaded
  package acceptance checklist. Signing and real native release acceptance remain required before distribution.
- Corrected Linux update download selection to match the actual x86_64 AppImage artifact name.
- Added separate launcher/FRAME version display, manual stable-release checks and optional daily
  checks while the launcher is open. Updates require an explicit choice; preview channels are not
  offered. Added release-pinned FRAME update and repair actions with stopped-service preservation
  and application-file recovery alongside existing deployment snapshots.
- Added explicit storage and Docker readiness guidance: internal/USB data folders, advisory NAS and
  low-space warnings, blocking checks for unavailable/unwritable/full storage, and separate Docker
  image-capacity reporting. The 10 GiB warning is a heuristic; unknown VM/containerd capacity and
  missing measured image requirements remain visible instead of being reported as verified.
- Added live container startup states and readiness checks to the launcher, followed by Portal,
  Stop FRAME and Edit configuration actions. Portal access uses localhost and the configured port.
- Extended the desktop installer into FRAME Launcher with installed-stack status, offline start/stop,
  separate managed deployment and data locations, resumable nonsecret setup, tray access and optional
  notifications. Existing installation paths and the packaged application identity are preserved.
- Protected stopped FRAME deployments from takeover by another installation folder.
- Added macOS launcher paths, menu-bar and Dock behavior, optional packaged login startup, and
  separate Intel/Apple Silicon DMG and ZIP targets. Added native Mac CI smoke checks and ARM64
  image builds with architecture-matched release manifests. Signed Mac installation and end-to-end
  media acceptance remain to be verified on real Macs before distribution.
- Extracted Audio Bridge to the independent `Syronius_FRAME_Audio_Bridge` project; removed FRAME installer, Portal, routing, and release integration. Existing installations must follow the [extraction guide](docs/audio-bridge-extraction.md) before upgrading. Earlier bridge entries below describe historical behavior.
- Added an explicit `stack update` alpha command and command-center action that resolve official
  GitHub `main` to an immutable commit, validate and stage the source archive, preserve local
  configuration and data, overlay FRAME-managed files, and run the existing stack reconciliation.
- Fixed Gallery Socials and Support copying on Firefox Mobile by preferring confirmed clipboard writes
  and keeping the LAN HTTP fallback inside the active dialog.
- Added a rebuildable Gallery metadata catalog, stable paged loading for large albums, normalized
  photo timestamps, race-safe continuation loads, mobile scroll anchoring, and stale tile-cache pruning.
- Added opt-in, journey-safe photo archive and trash retention plus disk-pressure warning and
  processing pause safeguards that retain queued work and never guess about legacy or unmatched files.
- Changed Photo Stage Viewer to render each published photo as one full JPEG instead of protected Gallery tiles.
- Kept Photo Stage Remote controls within one mobile viewport, condensed actions into an icon row,
  added fine low-second duration steps, made the header collapsible, and moved thumbnails into a
  dismissible scrolling drawer.
- Removed `frame.local` mDNS publishing and its discovery watchdog. Portal access uses localhost
  with the configured port on the host, or an explicit LAN IP/user-managed DNS name on other devices.
  Background environmental/network-change tracking is intentionally out of scope; explicit readiness
  checks and service-health reporting remain.
- Added staged Hybrid installation, a pinned Cloudflare Tunnel connector, and an internal-only
  public gateway that enforces generated capability-aware route allowlists.
- Added safe public Audio Monitor listener APIs and separate LAN capture/public listener base URLs.
- Namespaced Audio Bridge assets and WebSockets beneath `/bridge` for Hybrid routing.
- Added `frame-edge`, a pinned Traefik LAN HTTP entry point with opt-in Docker label discovery through
  the restricted socket proxy.
- Routed Portal, Stream Management, and Overlay paths through the shared edge.
- Namespaced Stream Management and Overlay browser assets/APIs to prevent cross-service route
  collisions.
- Filtered Portal container status to the unified Compose project.
- Removed private stream profile IDs from public overlay renderer payloads and visuals; preset-scoped
  stats URLs now resolve profile IDs server-side.
- Added an optional friendly stream Name field and clear active/inactive Telemetry toggle states.

- Initial documentation scaffold.
- Added canonical V1.1 spec at `docs/spec/v1.1.md`.
- Added schema placeholders in `docs/schemas/`.
- Added the complete `frame-audio-bridge` Discord voice-to-OBS service.
- Added FRAME Audio Bridge capability, route, Hybrid exposure, observability, and architecture contracts.
- Added the first `frame-portal` implementation with dynamic navigation, `/status/api`, Docker service health, disk alerts, live logs, and responsive day/night UI.
- Made Portal container restarts opt-in and Docker access read-only by default.
- Added authoritative Audio Bridge Portal telemetry, accurate container uptime/health, tool readiness states, fallback-config alerts, Portal authentication, status caching, request timeouts, and bounded live logs.
- Pinned the restricted Docker proxy and documented explicit storage/retention thresholds.
- Added the cross-platform FRAME installer, canonical config generation, shared secret management,
  generated Compose deployment, lifecycle commands, and contained destructive reset flow.
- Expanded connectivity overlay preset controls, established the stock default preset contract, and
  added a durable running implementation TODO list.
- Added the pinned OpenIRL SRTLA receiver wrapper, FRAME-owned stream management UI, and connectivity
  overlay renderer/wizard with stable OBS URLs, stock preset seeding, and installer integration.
- Made all optional FRAME services opt-in on fresh installs and moved the unified Audio Bridge
  development host-port default to `3729`.
