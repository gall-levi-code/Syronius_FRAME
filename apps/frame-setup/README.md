# FRAME Setup

FRAME Setup is the native host-facing installer and launcher prototype for the reduced Scenario 2
stack.

It is intentionally split from the container web UI:

- The Tauri app handles host concerns: Docker readiness, storage path selection, exposed port checks,
  previous-install detection, writing the stack configuration, and starting Docker Compose.
- The container web UI handles app concerns: tutorials, service-specific setup, OBS URLs, auth,
  Cloudflare, profiles, overlays, and operator controls.

The native Install FRAME action can detect host state, check ports, write
`state/frame-install-plan.json`, generate the stack `.env` and `docker-compose.yml`, prepare the
selected data folders, run `docker compose config --quiet`, start the stack with
`docker compose up -d --build --remove-orphans`, and open `http://localhost/setup`.
During install, the UI streams progress from the native backend and waits for the FRAME web edge to
accept connections before launching the browser.

The packaged installer bundles the current FRAME stack resources and copies them into the selected
install root before running Docker Compose.

## Setup modes

- **Quick Start** enables every implemented FRAME tool with basic defaults.
- **Guided Setup** explains each service and lets the user opt in with checkboxes.
- **Advanced** exposes the environment-variable model and subfolder overrides.

## Exposed ports

The target Scenario 2 stack exposes only:

- FRAME web edge: TCP 80 by default.
- Photo FTP control and passive range, when FTP ingest is enabled.
- SRTLA/SRT UDP ports, when Stream Relay is enabled.

Other tools route through FRAME Edge.

## Development

```bash
cd apps/frame-setup
npm install
npm run dev
npm run tauri dev
```

## Windows installer build

The preferred path for the Windows `.exe` installer is a native Windows build machine rather than a
Docker container.

Install the Tauri Windows prerequisites first:

- Node.js and npm.
- Rust through rustup.
- Microsoft C++ Build Tools with the "Desktop development with C++" workload.
- Microsoft Edge WebView2 Runtime. This is already present on most current Windows 10/11 systems.

Then run:

```powershell
.\apps\frame-setup\scripts\build-windows.ps1
```

The generated bundles will be under `apps/frame-setup/src-tauri/target/release/bundle/`.

Official references:

- https://v2.tauri.app/start/prerequisites/
- https://v2.tauri.app/distribute/windows-installer/
