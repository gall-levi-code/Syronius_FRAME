# ADR 0012: Electron online installer

## Status

Accepted. Supersedes the Tauri implementation choice in ADR 0011.

## Decision

Ship one installer runtime download per platform: an Electron NSIS installer for Windows x64 and
an AppImage for Linux x64. Reuse the existing web wizard and dependency-free FRAME JavaScript
configuration, release, and recovery code. Electron bundles Node; users need a local Linux AMD64
Docker engine, Compose, internet access, and host `tar`, but no development language runtime.

New installs download the official GitHub release named by the installer's packaged `frameReleaseTag`
and its exact source commit. Developer builds without a tag use the latest stable release. The
manifest pins FRAME service images by digest. Configuration and host port checks run
before application pulls or startup. Existing release installations retain their selected release
when reconfigured. Source checkouts and source-based installations continue using the existing CLI.

The renderer uses an allowlisted preload bridge with no Node access. Credentials travel through
stdin to the shared configuration runtime, are omitted from saved plans, and are stored only in
the generated configuration needed by FRAME. Temporary readiness files are removed on completion
or normal exit. The existing CLI startup retains its image pull, health check, recovery, and local
discovery behavior; Electron supplies a host preflight hook before pull and immediately before up.

Host preflight reads canonical active Compose bindings, not every variable ending in `_PORT`.
This includes FTP passive ranges and excludes remote SSH targets and inactive services. Exact
container ownership allows reconfiguration; a foreign Docker project with the same name blocks it.
Checks cannot reserve ports between validation and startup, so Compose failure recovery remains
required. A failed/unknown check never grants readiness.

## Limits

The initial release is online-only, with standard data subfolders under `<installation>/data` for
new deployments. Existing release data roots remain unchanged. Windows packages built without
signing credentials are unsigned; Linux builds and runtime checks need a Linux runner. Docker is
installed separately. Offline image payloads, automatic Docker installation, custom subfolders,
automatic port reassignment, and ARM64 packages are deferred until needed.
