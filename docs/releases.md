# FRAME release images and recovery

FRAME keeps its service containers separate. A release changes how those containers are built and
installed: CI builds each image once, checks the runtime image, and records its registry digest.
The installer can then pull those images instead of compiling the stack on the installation host.
Development installations can continue building the checked-out source.

## Build and publish

`.github/workflows/build-images.yml` builds all 13 FRAME service images for `linux/amd64`. Normal
pull-request/main verification runs it after the contract and service tests. Its smoke harness
starts isolated containers without host ports or production data and checks health plus the native
dependencies used by the media services: Sharp, SQLite, HEIC module loading, FFmpeg, Opus/DAVE,
SLS/SRTLA, FTP, and the Belabox maintenance executables. Discord smoke checks exercise the real web
stack without logging a bot into Discord. External integrations and a complete media session still
need their usual acceptance checks.

`.github/workflows/release-images.yml` runs when an official GitHub release is published, or when
manually dispatched from this repository's `main`. Every image must finish building and pass its
smoke check before publishing begins. Publishing loads the saved, tested images and verifies their
immutable image IDs. Images receive full source-commit tags and, for a published release, its
version tag. No `latest` tag is used.

The final job emits `frame-images.json` only after all 13 registry digests are available for the same
source commit. A published-release run attaches it to that release; a manual run provides it as a
workflow artifact. Release tags must also be valid Docker tags, such as `v0.1.0`.

The workflow uses `GITHUB_TOKEN`; package write access is confined to the publishing jobs. When
publishing these GHCR packages for the first time, make them public if installations should pull
without signing in. Keep the referenced packages available for as long as their releases are
supported. This workflow must be committed and run on GitHub before there is a release to install.

## Install a release

The [Electron online installer](../apps/frame-setup/README.md) uses the latest stable official
GitHub release and requires the `frame-images.json` asset attached to that release. A manual
workflow artifact alone is not discoverable by the app. Publish images containing the current
host runtime (`FRAME_WORKSPACE`) and launcher preflight hook before distributing this installer;
older releases are rejected with an actionable message. GHCR packages must be publicly pullable
without a registry sign-in. The app does not fall back to source builds when a release is absent.

Build the runtime package on its target OS with `npm ci` and `npm run dist:win` or
`npm run dist:linux` in `apps/frame-setup`. The package contains bootstrap tools and the UI;
release source and images download during setup. The manual **Build FRAME online installers**
workflow builds both platforms and uploads the runtime artifacts without publishing a release.
Offline image bundles are not implemented yet.

Download the official release's `frame-images.json` into the FRAME installation directory, then run:

```powershell
.\stack.cmd update --image-manifest frame-images.json
```

On Linux/macOS use `./stack.sh update --image-manifest frame-images.json`. The relative manifest path
is resolved inside the installation directory. The manifest must contain the complete service set,
the official GHCR repositories, immutable SHA-256 digests, and one full source commit. The updater
downloads that exact source commit so configuration/templates and runtime images belong together.
These update commands target installed copies; the updater refuses a Git checkout, where source
changes should continue to use Git.

The active selection is saved as `frame-release.json`; the generated `docker-compose.release.json`
supplies image digests to the existing Compose configuration. Use the stack wrappers to include both
files automatically. Release startup pulls the enabled services before replacing any containers,
then runs Compose with `--no-build --pull never --wait`. Subsequent starts keep that release selected.
The installation-owned `frame-source-commit` records a completed source overlay. A missing or
mismatched source commit blocks release reconciliation rather than combining unrelated templates
and images.

Source installations retain `stack update` for the current official `main`. An installation using
release images requires another manifest for its next update. To deliberately return to source
builds, run `stack update --source`. Native FRAME Setup also honors an existing release selection
when applying configuration and preserves its installed source resources; release selection itself
uses the command above. A packaged native installation acquires the full repository verification
tools with its first source/release update.

## Recover a deployment

Before changing deployment configuration, the installers save the previous generated files and
running services' exact local image IDs in `.frame-deployment-backup`. Startup succeeds only after
Compose's health checks pass. Electron setup collects the operator login and the selected
Cloudflare/Discord credentials before startup. The retained Tauri prototype has a different
first-install flow that defers unconfigured integrations; it is not the distributed online app.

If configuration validation or a release pull fails, the saved files are restored and the running
containers are left alone. If startup fails after container replacement begins, the saved files and
previous running services are restored using their local image IDs without building or pulling.
For a first installation with no previous running services, failure stops the candidate containers.
The command still reports the original failure even when recovery succeeds.

The last snapshot remains available for an explicit recovery:

```powershell
.\stack.cmd recover
```

Use `./stack.sh recover` on Linux/macOS. A successful recovery waits for the restored services'
health checks. If recovery itself fails, the backup remains pending for another attempt. The next
deployment replaces a completed snapshot; there is one retained deployment, not a release archive.
Keep its old local images until the new deployment is accepted: pruning them can prevent recovery.

Recovery restores `.env`, generated Compose/routes/configuration, release selection, and installed
build metadata. It does **not** rewind source files, databases, uploaded photos, or other application
data. Database migrations therefore need backward compatibility and normal data backups. The backup
contains credentials and resolved environment values; it is Git-ignored and created with restricted
permissions on POSIX systems. Keep the installation directory private on Windows as well.
Reset removes the owned recovery files so old credentials cannot be restored afterward; it retains
the selected release for the default configuration.

After recovering from a source update, the source-commit guard may prevent ordinary `stack start`.
Run `stack update --image-manifest frame-images.json` with the intended release again to restore its
matching source before reconciling. `stack recover` itself uses the saved configuration and exact
local images, so it remains available while source and release are mismatched.

## Local checks

```text
npm run verify
node scripts/smoke-images.mjs --self-test
docker build --platform linux/amd64 -t frame-auth:candidate services/frame-auth
node scripts/smoke-images.mjs --service frame-auth --image frame-auth:candidate
```

The wrapper regression tests replace Docker with a test executable and exercise pull failures,
failed health checks, exact-image recovery, first-install cleanup, and nested update/start behavior.
They never control the real stack. The image smoke harness controls only uniquely named containers
that carry its own ownership label.
