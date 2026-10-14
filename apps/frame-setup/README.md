# FRAME Launcher

FRAME Launcher combines the Electron online installer with everyday controls for the installed
FRAME stack. First-time users follow setup; returning users see the installation's actual state,
can open the dashboard, and can start or stop FRAME without reinstalling it. Existing package
identity and `FRAME-Setup` download names remain stable for compatibility.

## Requirements and releases

Install [Docker Desktop for Windows](https://docs.docker.com/desktop/setup/install/windows-install/)
with Linux containers, [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/),
or [Docker Engine with Compose on Linux](https://docs.docker.com/engine/install/).
FRAME uses a local Linux Docker engine: AMD64 on x64 hosts or ARM64 on supported ARM64 hosts,
including Apple silicon. Docker installation remains user-managed; the launcher does not install
an emulator or fall back to AMD64 images on ARM64.

Use Docker Desktop's standard local Linux engine or a standard local Docker Engine installation on
Linux. Rootless Docker and custom engine socket layouts are currently unsupported. Readiness reports
a missing Docker CLI or Compose plugin, a stopped/inaccessible engine, permission problems, and an
unsupported engine or socket configuration separately. Follow the reported guidance and Recheck;
the launcher does not change Docker's installation, permissions, or socket configuration.

The host needs `tar` to extract release source. First installation requires internet access and an
official release with matching source and a twelve-image manifest for the engine architecture:
`frame-images.json` for `linux/amd64`, or `frame-images-arm64.json` for `linux/arm64`. Both use schema
version 1 and pin images by digest. A missing or mismatched manifest blocks installation.

The packaged `frameReleaseTag` is still `v1.0.0-release`. That historical release predates Audio Bridge
extraction and is intentionally rejected by the new installer. This checkout is not a new published
release: distribute it only after selecting and testing a matching extraction-aware release and
updating the pin. See [release preparation](../../docs/releases.md).

## Returning to FRAME

The launcher discovers both running and stopped FRAME containers and checks their owning installation.
A different folder or user profile cannot silently take over an existing deployment. Missing files,
conflicting ownership, Docker unavailability, and incomplete installations remain visible.
Source/Git checkouts are detected but remain read-only; continue managing those deployments with
`stack`. Launcher lifecycle controls currently require a release-image installation.

- **Launch FRAME Portal** opens `http://localhost/dashboard` in the default browser, or
  `http://localhost:<configured-port>/dashboard` when the edge port is not 80. Other LAN devices use
  the host's LAN IP address or a DNS name the user manages, with the configured port and `/dashboard`.
- **Start FRAME** resumes existing containers without pulling images, rebuilding, updating or creating
  replacements. Missing resources require repair/reconfiguration.
- **FRAME is starting** shows the enabled deployment containers and their observed startup/health
  states. Green checks mean healthy, or running when a container has no health check. Failed,
  unhealthy and unavailable states stay visible; completing a command alone does not establish
  readiness. Once the deployment is verified, Home shows Portal, Stop FRAME and Edit configuration.
- **Stop FRAME** stops only owned FRAME containers and retains their configuration and data. This
  interrupts active FRAME streams, listeners and transfers.
- **My Setup** shows installed version, services, deployment/data locations and setup actions.
- **Edit configuration** returns to setup with the installed configuration and data locations.
  Applying edits still requires fresh readiness checks.
- **Recovery** uses the existing deployment snapshot when an interrupted deployment can be recovered
  safely. Unsupported or legacy recovery is explained rather than started silently.

Ordinary Start/Stop differs from deployment-oriented `stack start`/`stack stop` commands.
Closing or quitting the launcher never stops FRAME. Launcher startup at sign-in is separate from
Docker restart behavior and never overrides a deliberately stopped stack. Recovery before OS sign-in
remains host-dependent and unverified on standard Windows Docker Desktop. No system service or
automatic sign-in is configured by this launcher.

## Updates and repair

**Updates & repair** shows the launcher version separately from the installed FRAME release.
**Check for updates** performs a manual check against official stable GitHub releases. Preview,
alpha, beta and release-candidate channels are not offered. A release must include the matching
Docker architecture manifest before FRAME can update, and the matching OS/architecture package
before a launcher download is offered. Release notes are displayed as text.

Preferences includes **Check for updates periodically**, off by default. Enabling it checks once
per day while the launcher is open or in the tray/menu bar. It uses no OS scheduled task and stops
checking when the launcher quits. Attempts and notification identities persist across relaunches;
failed periodic checks stay quiet, while manual failures are shown on the Updates page. The existing
notifications preference also controls update notifications. Checks never install an update.

- **Download launcher installer** opens the matching official package. The user runs that installer;
  this does not update the FRAME deployment or remove its data.
- **Update FRAME** requires review of the selected release and an explicit interruption confirmation.
  It stages matching application files and pinned images, repeats readiness checks, and retains the
  previous source and deployment configuration for failure recovery.
- **Repair installation** restores missing containers/images at the installed release. It retains
  configuration and media, does not select a newer release, and requires valid installed source and
  configuration. Missing configuration needs configuration recovery or reconfiguration first.
- Updates and repairs preserve deliberately stopped services. A stopped stack stays stopped; its
  health is checked when it is subsequently started. Missing services in a running stack may be
  started by Repair. Ordinary **Start FRAME** remains an offline resume operation.

Recovery covers application files, deployment configuration, and the previous container images.
It is not a backup of media or databases and cannot reverse application data migrations. Keep normal
data backups and retain the previous images until the new release has been accepted. Interrupted
maintenance is reported explicitly and must be recovered before another update or repair.

## Support reports

**Support** offers a preview, **Copy diagnostic report**, and **Save support report**. Each action
collects current status; nothing is uploaded. The report includes operating-system/kernel and
launcher versions, the installed release/commit, Docker version and architecture, service health,
and bounded diagnostic codes with fixed explanations. Unknown names and free-form errors are omitted.
Passwords, tokens, raw environment files, paths, URLs, hostnames, and raw command logs are excluded.
The saved report uses a new JSON filename rather than overwriting another file.

## Backup, restore, and removal

**Backup & removal** keeps three operations separate:

- **Create full backup** confirms service interruption, stops FRAME, copies deployment files and
  all persistent data, verifies file hashes, then restores the previous running/stopped choices.
  A large media library can take a long time. Choose an empty backup folder outside the deployment
  and data folders. Docker images and maintenance recovery directories are not included.
- **Restore backup** verifies a completed backup and restores into empty original deployment/data
  paths on the same operating system. Remove FRAME containers first and move existing folders aside
  yourself. Restore never overwrites an existing library, starts services, or rewrites paths for a
  different host. Use **Repair installation**, then **Start FRAME** when ready.
- **Remove FRAME containers** stops and removes only the verified containers belonging to this
  installation. Configuration, media, application files, and Docker images remain. Repair can
  recreate containers from the retained installation.

Full backups contain credentials and are not encrypted. Use a private folder or encrypted drive;
on Windows, access follows the destination folder's permissions. The full procedure and interrupted
operation guidance are in [Backup and restore](../../docs/backup-and-restore.md).

Uninstalling the launcher through the OS leaves FRAME containers, deployment files, and data alone.
Reinstalling the launcher discovers an existing managed release through its saved registry/default
location and container ownership. Custom locations without a registry or containers need their
original location selected again. Permanently deleting data is a separate, manual file-manager
action after container removal and a verified backup; the launcher does not offer automatic erasure.

## Storage

| Location | Purpose |
| --- | --- |
| Windows `%LOCALAPPDATA%/Syronius/FRAME/deployment` | Managed runtime, deployment configuration and release metadata. |
| macOS `~/Library/Application Support/Syronius/FRAME/deployment` | Managed Mac deployment. |
| Linux `$XDG_DATA_HOME/syronius-frame/deployment`, falling back to `~/.local/share/syronius-frame/deployment` | Managed Linux deployment. |
| `launcher` beside `deployment` | Preferences, installation registry and nonsecret drafts. |
| User-selected FRAME data folder (suggested `~/FRAME Data`) | Photos, galleries, archives, persistent tool state and credentials. |

The selected folder retains the existing combined data format; it is not a media-only export.
Back up both deployment configuration and data. Docker image storage is separate. Existing
installations retain their configured paths; changing setup does not silently relocate data.
Preflight/cache cleanup preserves installed deployments and persistent data.

Internal disks and attached USB storage can hold FRAME data when the folder is writable and Docker
can access it. Keep external storage connected at its configured path. Network/NAS storage receives
an advisory warning about availability and performance; choosing it alone does not block setup.
A missing existing data folder/drive, an unwritable folder, or zero available space blocks setup or
Start until corrected. Storage with less than 10 GiB available receives a warning that allows the
user to continue. This threshold is a practical heuristic, not a measured FRAME installation minimum
or a guarantee that 10 GiB is sufficient for the selected tools and future media.

Docker image capacity is checked separately from deployment and data storage. The launcher measures
it only for a known, accessible classic Docker image store on the same Linux host. Docker Desktop,
containerd stores, and unknown storage layouts receive an explicit **capacity not verified** warning.
Free space on the selected FRAME data drive does not establish free space inside Docker's VM or image
store. Check [Docker's storage settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/#resources)
for Desktop, or the engine's configured image-storage location on Linux. Docker documents that
[containerd image storage can use a separate location](https://docs.docker.com/engine/storage/containerd/).

Current release manifests do not include measured image-space requirements, so the selected tools'
required image space remains unverified even when available capacity can be read. Setup warns rather
than inventing a minimum. Adding and validating measured release-image sizes remains release work.
These checks run during explicit setup/readiness and Start operations; they do not add a background
environment or network watcher.

## Tray and notifications

The tray provides Launch FRAME Portal, Show Launcher, Start/Stop, Open Data Folder, notification preferences
and Quit Launcher. Controls remain available in the window when a tray is unavailable. With tray
mode enabled, closing hides the window; explicit Quit ends launcher monitoring and removes the tray,
while FRAME services keep their current running/stopped state. On Linux, hiding requires a reachable
tray; otherwise the normal window remains the entry point.

Notifications report meaningful changes and operation results, not every refresh, and can be disabled.
Service-status monitoring works only while the launcher is running. FRAME does not publish LAN
hostnames or track environmental/network changes in the background. Explicit host, storage, port,
and deployment readiness checks remain part of setup and startup.
Required checks confirm that Docker and Compose are available, the local engine is compatible,
and the selected services' host ports are usable. Ports occupied by another application or container
block startup; an existing FRAME binding is reusable only when its installation ownership and
mapping match. Setup repeats these checks before applying changes and starting services, and
routine Start checks them again. FRAME does not stop unrelated services to resolve a conflict.
Windows notifications require verification in the installed package with its Start Menu
shortcut/application identity. An unpackaged development
run does not establish that registration. Startup at sign-in is optional in packaged Windows and
macOS builds. Linux startup registration is not implemented and remains visibly unavailable.
On macOS, the menu-bar icon and Dock activation can reopen the launcher. Login startup requires the
packaged app and may require approval in macOS Login Items settings; signed/notarized package
verification remains part of release acceptance. Closing the window with tray mode disabled keeps
the Mac application available until Quit Launcher.

## Setup and saved progress

- Quick Start applies the recommended local preset/default ports to fresh setup. Switching a fresh
  custom/Hybrid draft to Quick clears those overrides. Reconfiguration preserves deliberate settings.
- Guided/Advanced retain service explanations, dependency checks, credential handling, port validation
  and final readiness checks. Changes use the installed release.
- Continue a draft restores only nonsecret choices, rechecks the host, and requires credentials again.
  Saved progress never carries successful readiness forward.
- The folder chooser controls persistent FRAME data. Managed deployment and existing paths remain
  visible in My Setup.
- Hybrid requires a public hostname and Cloudflare Tunnel token. Belabox Manager requires Hybrid.
- Installation completes at the launcher/dashboard. Container health does not verify cameras,
  encoders, browser capture or public access; those still need functional checks.

Browser preview is clearly simulated and cannot install, save host configuration or control containers.
Audio Bridge is independent. Existing enabled legacy bridges must complete the
[standalone cutover](../../docs/audio-bridge-extraction.md) before reconfiguration. Launcher recovery
does not restart a historical snapshot containing the retired bot.

## Development

Use Node.js 22.12 or newer with npm:

```sh
cd apps/frame-setup
npm ci
npm run dev
```

Development starts Vite on `127.0.0.1:5174` and opens Electron. To inspect the browser preview, open
that address while development is running. `npm run build` builds the local UI; `npm start` opens
that built UI in Electron.

The renderer has no Node access. The preload exposes only installer operations; the main process
checks the sender and command allowlist, blocks page navigation, and opens only HTTP(S) links in the
system browser. Host and Docker commands run in the backend. The previous Tauri source is retained
for migration reference and is not part of the Electron package.

## Single-file downloads

Build Windows on Windows, Linux on Linux, and macOS on macOS:

```sh
npm run dist:win
npm run dist:linux
npm run dist:mac
```

Windows also has `apps/frame-setup/scripts/build-windows.ps1`, which installs locked dependencies
and builds the NSIS installer. Outputs go to `apps/frame-setup/release/`:

- `FRAME-Setup-<version>-win-x64.exe`
- `FRAME-Setup-<version>-linux-x86_64.AppImage`
- `FRAME-Setup-<version>-mac-x64.dmg` and `.zip`
- `FRAME-Setup-<version>-mac-arm64.dmg` and `.zip`

`npm run dist:mac` builds both Mac architectures; `dist:mac:x64` and `dist:mac:arm64` build them
individually. Use the package matching the Mac's processor.

The Linux AppImage needs executable permission (`chmod +x FRAME-Setup-*.AppImage`). Release signing
credentials are supplied by the release environment; a local build without them is unsigned. The
package contains the setup runtime and bootstrap configuration tools, not service images or secrets.

The Mac installer workflow accepts optional repository secrets `MAC_CSC_LINK` (the Developer ID
certificate, as supported by electron-builder) and `MAC_CSC_KEY_PASSWORD` (its password), mapped to
`CSC_LINK` and `CSC_KEY_PASSWORD`. Notarization uses `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
`APPLE_TEAM_ID`. Without a signing certificate, CI explicitly disables identity discovery and builds
unsigned development artifacts. Public Mac release acceptance requires signed, notarized packages
and testing the downloaded application on a real Mac; producing a DMG or ZIP alone is insufficient.

Installer CI runs an isolated development-Electron smoke on Windows Server 2022, Ubuntu 22.04,
and both Mac architectures. It checks the built UI, real preload/shell, sandboxing, native Tab focus,
Home at 200% Chromium zoom, window reopening, and a simulated no-tray fallback. It uses a temporary
profile and a simulated backend, without Docker or login-item registration. It does not launch the
packaged application or establish signing, Gatekeeper, AppImage/FUSE, native OS scaling, notification,
login-item, installation, or media-workflow acceptance. `npm run smoke:native` runs it locally after
the UI has been built; it briefly opens a test window.

CI checks exact package filenames and produces SHA-256 checksum files and scoped evidence reports.
Uploads are labelled candidates. Follow the [downloaded-package release acceptance checklist](../../docs/launcher-release-acceptance.md)
before treating them as tested releases; it names the Windows/Mac/Linux targets and remaining manual
signing, installation, keyboard, scaling, notification and tray checks.

Native macOS support is implemented, and CI is configured to build the Mac packages. That does not
establish a tested release: signed/notarized installation on a real Mac, native Docker/media
workflows, and end-to-end launcher behavior still require Mac verification. Container health alone
does not verify a camera, encoder, audio feed, photo upload, or OBS workflow.

References: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security),
[electron-builder NSIS](https://www.electron.build/nsis.html),
[electron-builder AppImage](https://www.electron.build/appimage.html).
