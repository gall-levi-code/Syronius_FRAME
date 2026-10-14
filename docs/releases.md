# FRAME release images and recovery

FRAME keeps its service containers separate. A release changes how those containers are built and
installed: CI builds each image once, checks the runtime image, and records its registry digest.
The installer can then pull those images instead of compiling the stack on the installation host.
Development installations can continue building the checked-out source.

## Build and publish

`.github/workflows/build-images.yml` builds all 12 FRAME service images for both `linux/amd64` and
`linux/arm64`, on native x64 and ARM64 Linux runners respectively. Normal
pull-request/main verification runs it after the contract and service tests. Its smoke harness
starts isolated containers without host ports or production data and checks health plus the native
dependencies used by the media services: Sharp, SQLite, HEIC module loading, FFmpeg, SLS/SRTLA,
FTP, and the Belabox maintenance executables. External integrations and a complete media session
still need their usual acceptance checks.

`.github/workflows/release-images.yml` runs when an official GitHub release is published, or when
manually dispatched from this repository's `main`. Every image must finish building and pass its
smoke check before publishing begins. Publishing loads the saved, tested images and verifies their
immutable image IDs and platform metadata. AMD64 images retain full source-commit tags and, for a
published release, its version tag; ARM64 tags append `-arm64`. No `latest` tag is used. For a draft release, supply its existing tag as the manual
workflow's `release-tag` input; the workflow checks out and verifies that exact tag.

The final job emits `frame-images.json` for AMD64 and `frame-images-arm64.json` for ARM64 only after
all 12 registry digests for each architecture are available from the same source commit. Each is a
schema-1 manifest with one platform and digest-pinned images. Mixed, missing, duplicate, or foreign
results fail validation before either manifest is written. A release run or manual run with
`release-tag` attaches both to that release; a manual run without a tag provides workflow artifacts.
Publishing a draft that already contains both manifests skips rebuilding its images. Release tags
and their `-arm64` suffixed form must be valid Docker tags, such as `v1.0.0-release`.

The workflow uses `GITHUB_TOKEN`; package write access is confined to the publishing jobs. When
publishing these GHCR packages for the first time, make them public if installations should pull
without signing in. Keep the referenced packages available for as long as their releases are
supported. This workflow must be committed and run on GitHub before there is a release to install.

## Install a release

The [Electron online installer](../apps/frame-setup/README.md) uses the exact official GitHub release
named by its packaged `frameReleaseTag` and requires the matching image asset attached to that
published release: `frame-images.json` for an AMD64 Docker engine, or `frame-images-arm64.json` for
ARM64. The manifest's platform must match the running engine; there is no silent fallback to an
AMD64 release on Apple Silicon. Developer packages without that field use the latest stable release. A manual
workflow artifact alone is not discoverable by the app. Publish images containing the current
host runtime (`FRAME_WORKSPACE`) and launcher preflight hook before distributing this installer;
older releases are rejected with an actionable message. GHCR packages must be publicly pullable
without a registry sign-in. The app does not fall back to source builds when a release is absent.

Build the runtime package on its target OS with `npm ci` and `npm run dist:win`,
`npm run dist:linux`, `npm run dist:mac:x64`, or `npm run dist:mac:arm64` in `apps/frame-setup`.
The package contains bootstrap tools and the UI;
release source and images download during setup. The manual **Build FRAME online installers**
workflow builds Windows x64, Linux x64, macOS Intel, and macOS Apple Silicon packages and uploads
the runtime artifacts without publishing a release. Mac jobs also run an isolated Electron smoke
check of the real window, preload, menu, and tray, without controlling Docker or registering login items.
Offline image bundles are not implemented yet.

The development launcher adds installed-stack status, offline resume/stop, tray controls and saved
setup progress. Ordinary start/stop must use the installed containers and must not select a new
release. Existing installation paths are retained. The new launcher still needs a matching release
pin before distribution; do not package the historical pre-extraction tag as a current launcher.
Test the Windows installed shortcut/notifications and tray exit behavior on the actual package,
and test the Linux window fallback when the desktop does not expose a usable tray. On both Mac
architectures, check the signed app installed in Applications, Dock reopen, menu-bar light/dark
appearance, notifications and login-item approval, Docker Desktop folder sharing, install/start/stop/
recovery, and real photo/HEIC/audio/video workflows. CI configuration and mocked platform tests do
not establish that these real-Mac acceptance checks have passed.

Prepare a release as a draft: push its tag, run the image workflow with that `release-tag`, and run
the installer workflow at the same tag. Attach the Windows `.exe`, Linux `.AppImage`, Mac Intel and
Apple Silicon `.dmg`/`.zip` packages, and a `SHA256SUMS` file beside both image manifests. Verify each
manifest's commit matches the tag and that every image can be pulled anonymously before publishing
the draft. The existing release pin still refers to the historical pre-extraction version; update
it to the actual new release before distribution. Windows builds remain unsigned and may show a
publisher warning. Mac CI builds are unsigned unless the signing/notarization secrets described in
the app README are configured; use signed, notarized Mac packages for public distribution.
Docker must already be installed and running with Linux containers.

If the installed release predates Audio Bridge extraction, first follow the
[extraction and bootstrap guide](audio-bridge-extraction.md). Its original installer expects 13
images and cannot consume a new 12-image manifest before its source helpers are updated. The normal
update commands below apply after that bootstrap, or to installations already using current helpers.

Download the official release's matching manifest into the FRAME installation directory, then run
on AMD64:

```powershell
.\stack.cmd update --image-manifest frame-images.json
```

On Linux/macOS use `./stack.sh update --image-manifest frame-images.json`. The relative manifest path
is resolved inside the installation directory. On ARM64 use
`./stack.sh update --image-manifest frame-images-arm64.json` instead. The manifest must contain the complete service set,
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
Cloudflare credentials before startup. The retained Tauri prototype has a different
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
matching source before reconciling. For a pre-extraction 13-image release, current release activation
cannot reinstall its manifest: use the retained matching historical source/helpers for a deliberate
rollback, or bootstrap the new release as described in the extraction guide. Coordinate any legacy
bot restoration with the standalone bot's Discord connection. `stack recover` itself uses the saved
configuration and exact local images, so it remains available while source and release are mismatched.

## Launcher updates and repair

The launcher checks the latest published stable release only. Publish both architecture manifests
and matching `FRAME-Setup-<version>-<os>-<arch>` packages before advertising a release as ready.
Use stable `v<major>.<minor>.<patch>` tags; the historical `-release` suffix is also accepted, but
alpha/beta/preview/RC tags are rejected even when incorrectly marked stable by GitHub. Keep the
launcher package version aligned with its release tag and update the initial-install release pin.
Version metadata for new launcher-managed installations/updates retains the selected release tag;
older installs can display a commit fallback until their provenance is established.

Native launcher maintenance keeps a source-file backup alongside the deployment snapshot so failed
or interrupted cross-version updates can restore matching application files offline. This is an
additional native-launcher recovery path; the CLI snapshot behavior described above still does not
rewind source files. Neither path restores uploaded media or reverses database migrations. Only
claim rollback compatibility for releases whose data migrations are backward compatible.

Test on each supported OS: explicit update from a published release, exact-release repair after
removing a container/image, no-service-start maintenance while stopped, preservation of individually
stopped services, download failure before interruption, failed health with source/config/image
recovery, interrupted maintenance, and retry after failed recovery. Existing fake-Docker tests verify
orchestration but do not establish native end-to-end release acceptance.

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
