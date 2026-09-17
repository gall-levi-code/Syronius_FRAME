# FRAME Setup

FRAME Setup is the Electron online installer for Windows and Linux. Users download one Windows
installer `.exe` or Linux `.AppImage`; the runtime includes Electron and Node, so they do not need
to install Node, Python, Rust, or a development checkout.

Docker is a prerequisite. Install Docker Desktop with Linux containers on Windows, or Docker Engine
with Compose on Linux, and start it before running FRAME Setup. This release targets x64 hosts and
`linux/amd64` container images. The host also needs `tar` (included with current Windows and common
Linux distributions) to extract the release source. Installation needs internet access and a published official FRAME
release with its release manifest and matching source archive.

This installer targets the official `v1.0.0-release` release. Its `frameReleaseTag` package metadata
selects that exact published GitHub tag, including tagged builds marked as GitHub prereleases; it
does not silently substitute another release. Developer packages without `frameReleaseTag` use the
latest stable official release. Existing installations continue to use their selected release.

The installer downloads that release, uses the shared installer runtime to generate
configuration, checks the selected host ports, pulls prebuilt images, and starts Docker Compose.
It waits for Docker Compose health checks before offering to open setup. Application images are not
built on the user's machine. The desktop installer may close after installation; Docker keeps FRAME
running. An offline image payload is outside this version's scope.

## Configuration and readiness

- **Quick Start** selects the recommended capabilities; **Guided Setup** explains each service;
  **Advanced** exposes more configuration values.
- Choose an installation folder; new data lives in `<installRoot>/data`. Existing release deployments
  retain their configured data root and reconfigure their pinned release. Source checkout conversions
  are not supported; keep using `stack` for those installations. Subfolder
  layouts remain managed by the shared installer.
- Review every published port, including direct service web ports, UDP relay ports, and the complete
  TCP FTP passive range. Edit conflicts and retry; automatic port reassignment is not offered.
- Photo FTP needs this machine's reachable LAN IPv4 address or DNS hostname to advertise to cameras.
  On an existing installation, leave it empty to preserve the deployed address.
- Enter the operator login, plus Discord or Cloudflare credentials when those integrations are
  selected. The interface keeps credentials in memory; the backend excludes them from saved plans
  and cleans temporary configuration on normal exit. Blank credential pairs on a loaded installation
  preserve its existing credentials.
- Readiness must pass for the current plan before Install unlocks. Edits and failed checks clear old
  results, and the backend checks again before applying the deployment.
- The browser preview is labeled as simulated and cannot install or save a configuration.

Hybrid mode requires a public hostname and Cloudflare Tunnel token. Belabox Manager selects Hybrid
mode because its agents connect through the authenticated public WebSocket endpoint. Video Relay
also needs a reachable advertised relay host when used in Hybrid mode.

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

Build Windows on Windows and Linux on Linux:

```sh
npm run dist:win
npm run dist:linux
```

Windows also has `apps/frame-setup/scripts/build-windows.ps1`, which installs locked dependencies
and builds the NSIS installer. Outputs go to `apps/frame-setup/release/`:

- `FRAME-Setup-<version>-win-x64.exe`
- `FRAME-Setup-<version>-linux-x86_64.AppImage`

The Linux AppImage needs executable permission (`chmod +x FRAME-Setup-*.AppImage`). Release signing
credentials are supplied by the release environment; a local build without them is unsigned. The
package contains the setup runtime and bootstrap configuration tools, not service images or secrets.

References: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security),
[electron-builder NSIS](https://www.electron.build/nsis.html),
[electron-builder AppImage](https://www.electron.build/appimage.html).
