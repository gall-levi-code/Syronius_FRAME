# ADR 0011: Native FRAME Setup App Boundary

## Status

Accepted

## Context

The reduced Scenario 2 stack should feel like one product while still keeping Docker-native service
boundaries. A browser inside Docker cannot safely choose arbitrary host folders or rewrite host
Compose mounts before containers exist, so host setup needs a small native layer.

## Decision

FRAME will prototype a Tauri-based native setup and launcher app under `apps/frame-setup`.

The native app owns host concerns:

- Docker and Docker Compose readiness detection.
- User-guided Docker installation help when the tools are missing.
- One required host storage root and optional advanced subfolder overrides.
- Previous-install detection through app registry files, data-root markers, Docker labels, Compose
  project identity, and local health probes.
- Exposed-port checks for the web edge, FTP, and SRT/SRTLA ports.
- Opening the local web setup page after install.

The container web UI owns product concerns:

- Service tutorials.
- OBS and operator links.
- Cloudflare, auth, stream, photo, overlay, and audio configuration.
- Runtime health and logs.

The first implementation is a safe setup planner. It writes a plan marker only after explicit user
action. Future iterations can connect the same flow to Compose reconciliation.

## Consequences

- The installer can use real native folder selection instead of asking users to type paths.
- The main web UI does not need Docker socket access just to choose host folders.
- Scenario 2 can later reduce container count while keeping the host setup layer stable.
- Building native installers requires Tauri prerequisites on release builders.
- Windows `.exe` installer builds should run on a native Windows host or CI runner with Node, Rust,
  Microsoft C++ Build Tools, and WebView2 available. Docker can still run the FRAME stack, but it is
  not the preferred packaging environment for this shell.
