# Changelog

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
