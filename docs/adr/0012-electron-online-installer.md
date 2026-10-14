# ADR 0012: Electron online installer

## Status

Accepted. Supersedes the Tauri implementation choice in ADR 0011. Extended by the FRAME Launcher
and native macOS/ARM64 work described below; the original Windows/Linux x64 scope is retained as
historical context rather than a current platform restriction.

## Decision

Ship Electron installer/launcher packages: NSIS for Windows x64, AppImage for Linux x64, and separate
DMG/ZIP downloads for Intel (x64) and Apple silicon (ARM64) Macs. Reuse the existing web wizard and
dependency-free FRAME JavaScript configuration, release, and recovery code. Electron bundles Node;
users need a local Linux Docker engine, Compose, internet access, and host `tar`, but no development
language runtime. Windows uses Docker Desktop in Linux-container mode, macOS uses Docker Desktop,
and Linux uses Docker Engine with Compose.

The current backend supports native Linux AMD64 and ARM64 engines and selects matching release
assets: `frame-images.json` for `linux/amd64`, `frame-images-arm64.json` for `linux/arm64`. Both retain
manifest schema version 1 and explicit platform metadata. An absent or mismatched native image set
blocks installation; the launcher does not silently install emulation or substitute AMD64 images.
Unsupported operating systems/architectures are reported separately from Docker being stopped.

New installs download the official GitHub release named by the installer's packaged `frameReleaseTag`
and its exact source commit. Developer builds without a tag use the latest stable release. The
manifest pins FRAME service images by digest. Configuration and host port checks run
before application pulls or startup. Existing release installations retain their selected release
when reconfigured. Source checkouts and source-based installations continue using the existing CLI.

The renderer uses an allowlisted preload bridge with no Node access. Credentials travel through
stdin to the shared configuration runtime, are omitted from saved plans, and are stored only in
the generated configuration needed by FRAME. Temporary readiness files are removed on completion
or normal exit. The existing CLI startup retains its image pull, health check, and recovery
behavior; Electron supplies a host preflight hook before pull and immediately before up.

Host preflight reads canonical active Compose bindings, not every variable ending in `_PORT`.
This includes FTP passive ranges and excludes remote SSH targets and inactive services. Exact
container ownership allows reconfiguration; a foreign Docker project with the same name blocks it.
Checks cannot reserve ports between validation and startup, so Compose failure recovery remains
required. A failed/unknown check never grants readiness.

## Launcher and storage

The desktop app remains available after setup with observed service status, dashboard access,
start/stop/recovery controls, and nonsecret setup drafts. Closing or quitting it leaves FRAME's
service state unchanged. Tray behavior and optional packaged Windows/macOS startup at sign-in are
launcher preferences; they do not configure Docker startup, automatic OS sign-in, or a system service.
Linux startup registration is not implemented.

Fresh installations separate managed deployment files from the user-selected persistent data folder.
Existing deployments retain their actual deployment/data paths during reconfiguration. Docker image
storage remains separately managed by Docker. The original installer placed fresh data under
`<installation>/data`; this remains valid for those existing installations.

## Limits and verification

The launcher remains online-only and uses standard data subfolders. Docker is installed separately.
Offline image payloads, automatic Docker installation, custom subfolders, and automatic port
reassignment remain outside this decision. The initial implementation deferred ARM64 and shipped
only Windows/Linux x64 packages; native engine support and Mac packaging now extend that scope.

Windows, Linux, and macOS packages require their corresponding build runners. Packages built without
release signing credentials are unsigned. Mac packaging CI is configured, but a configured workflow
is not evidence of a completed signed/notarized Mac release. Real Mac installation, native media
workflows, and end-to-end launcher QA remain unverified until tested on the target hardware.
