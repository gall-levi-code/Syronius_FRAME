# Changelog

## Unreleased

- Added host-level mDNS discovery for `http://frame.local`, tied to the FRAME stack lifecycle.
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

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and this project adheres to Semantic Versioning.

## [Unreleased]
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
