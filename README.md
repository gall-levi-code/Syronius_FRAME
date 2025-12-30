# Syronius’ Frame (F.R.A.M.E.) – V1 Architecture & UX Spec

**F.R.A.M.E.** — **F**ederated **R**elay & **A**utomation for **M**edia & **E**xperiences

## Table of Contents

- [0.0 - What This Stack Is (For New IRL Streamers)](#00-what-this-stack-is-for-new-irl-streamers)
  - [A) Why These Problems Matter in IRL Streaming](#a-why-these-problems-matter-in-irl-streaming)
  - [B) Goals](#b-goals)
- [1.0 - High‑Level UX](#10-high-level-ux)
  - [A) Installation & Reconfiguration UX](#a-installation-reconfiguration-ux)
  - [B) Configuration Persistence](#b-configuration-persistence)
  - [C) Modes](#c-modes)
  - [D) Portal (Unified Navigation Shell)](#d-portal-unified-navigation-shell)
  - [E) Dashboard](#e-dashboard)
- [2.0 - Core Modules](#20-core-modules)
  - [A) Container Map (V1)](#a-container-map-v1)
  - [B) Reverse Proxy](#b-reverse-proxy)
  - [C) SRTLA + SLS](#c-srtla-sls)
  - [D) Overlay Server](#d-overlay-server)
  - [E) Photo Ingest (Inputs)](#e-photo-ingest-inputs)
  - [F) Photo Pipeline (Required for all images)](#f-photo-pipeline-required-for-all-images)
  - [G) Today Gallery + Viewer](#g-today-gallery-viewer)
  - [H) Discord Webhook (Optional)](#h-discord-webhook-optional)
  - [I) Audio Monitor (V1 – Browser Capture)](#i-audio-monitor-v1-browser-capture)
  - [J) Dependency Layering (V1)](#j-dependency-layering-v1)
- [3.0 - Storage & Contracts](#30-storage-contracts)
  - [A) Required Directories](#a-required-directories)
  - [B) Today Publishing Contract](#b-today-publishing-contract)
- [4.0 - Config & Presets](#40-config-presets)
  - [A) Static Config (`.env`)](#a-static-config-env)
  - [B) Capability Config (`/data/state/stack-config.json`)](#b-capability-config-datastatestack-configjson)
  - [C) Route Definitions (V1)](#c-route-definitions-v1)
  - [D) `latest.json` (V1)](#d-latestjson-v1)
  - [E) Dependency Enforcement Rules](#e-dependency-enforcement-rules)
  - [F) Presets](#f-presets)
- [5.0 - Network Exposure](#50-network-exposure)
  - [A) Design Principle](#a-design-principle)
  - [B) Host-Exposed Ports (Documented Defaults)](#b-host-exposed-ports-documented-defaults)
  - [C) Exposure by Mode](#c-exposure-by-mode)
- [6.0 - Observability](#60-observability)
- [7.0 - Resource Planning](#70-resource-planning)
  - [A) CPU](#a-cpu)
  - [B) RAM](#b-ram)
  - [C) Disk](#c-disk)
  - [D) Network](#d-network)
  - [E) Retention & Cleanup Defaults (V1)](#e-retention-cleanup-defaults-v1)
- [8.0 - Setup Flow](#80-setup-flow)
- [9.0 - Open Decisions](#90-open-decisions)
- [Appendix A - Starter `.env` Template](#appendix-a-starter-env-template)

---

This document defines the **V1 architecture, UX flows, and operational expectations** for the IRL Streamer Stack. It is intended to be a stable reference before implementation begins.

---

## 0.0 - What This Stack Is (For New IRL Streamers)

**Syronius’ Frame (F.R.A.M.E.)** stands for:

> **F**ederated **R**elay & **A**utomation for **M**edia & **E**xperiences

It is a **self-hosted control center for IRL streaming and live photography**, designed to orchestrate everything *around* your stream — not just the video feed.

If you are:

- transitioning from studio streaming to IRL,
- a photographer who wants tighter control over how images appear on stream,
- or someone who wants to reduce manual glue between OBS, StreamerBot, cameras, and overlays,

F.R.A.M.E. exists to make live production **predictable, observable, and intentional**.

At a high level, the stack helps you:

- **Relay live media reliably** (video, audio, photos)
- **Automate decisions and timing** instead of reacting live
- **Federate tools** like OBS, StreamerBot, cameras, and browsers into one system
- **Present media intentionally** on stream and remotely

All of this is done **locally and under your control**, with optional remote access for web pages only.

---

### A) Why These Problems Matter in IRL Streaming

IRL streaming is uniquely difficult because:

- your network conditions change constantly
- you are often multitasking (walking, shooting, talking, navigating)
- you cannot afford fragile or manual workflows
- small failures compound quickly on stream

This stack exists to **reduce cognitive load while live** by making:

- ingest reliable
- automation predictable
- visual presentation intentional

Instead of fighting tools mid‑stream, you configure behavior *before* you go live.

---

### B) Goals

#### Primary Goals

- Self‑hosted **SRTLA ingest** with management UI
- Robust **photo ingest pipeline** with JPG‑only normalization
- Deterministic **StreamerBot handoff** using `.ready` manifests
- **OBS overlays** with a wizard and live preview
- **Hybrid mode** (Cloudflare Tunnel for HTTP only)
- **Remote Audio Monitor** (Windows source, AAC, always‑on)


---

## 1.0 - High‑Level UX

### A) Installation & Reconfiguration UX

The stack ships with a single installer entrypoint (`stack.sh` for Linux/macOS and `stack.cmd` for Windows) that supports subcommands. 

Supported commands (V1):

- **install**

  - Installs or reconfigures the environment.
  - Prompts the user to build/update `.env` and `/data` structures.
  - Generates/updates `docker-compose.yml` and `stack-config.json`.
  - Validates prerequisites (Docker + Compose).
  - Validates **port conflicts** and halts on conflicts.
  - Deploys the stack (`docker compose up -d`) with selected profiles.
  - Re-running `install` allows enabling/disabling features and switching **LAN vs Hybrid**.
  - Shows a full breakdown of previous setup (or fresh install details).
  - Option: set services to be **always-on** (container restart policy `restart: always`).

- **start**

  - Brings up the container stack (`docker compose up -d`).
  - If config is missing, prompts the user to run `install`.

- **stop**

  - Stops the container stack (`docker compose down`).
  - If config is missing, prompts the user to run `install`.

- **status**

  - Prints installation status and service/container state.
  - Reports container uptime when available.
  - Lists enabled capabilities from `stack-config.json`.
  - Prints current `.env` values with sensitive fields **redacted**.

- **reset**

  - Destructive reinstall.
  - Stops and removes containers (and associated volumes where applicable).
  - Deletes `./data` directory.
  - Re-runs the interactive `install` flow to recreate `.env` and `./data`.
  - Requires explicit confirmation.

*Updates are out of scope for V1.*

### B) Configuration Persistence

- Feature choices persist across runs
- Data is never deleted when disabling features
- Only the `reset` path removes data

### C) Modes

- **LAN-Only** – everything local
- **Hybrid** – HTTP via Cloudflare Tunnel, ingest + FTP stay LAN (requires cloudflared token)

### D) Portal (Unified Navigation Shell)

A dedicated **Portal service** provides a shared navigation and landing experience.

- Nav is **not hardcoded**
- Nav is generated dynamically from `stack-config.json`
- Each item reflects:
  - Enabled / Disabled
  - Ready / Needs setup / Offline

The portal links to (never iframes) other UIs.

### E) Dashboard

Single landing page linking to:

- Stream Management (SLS UI)
- Overlay Wizard + generated OBS URLs
- Today Gallery / Viewer / Remote Controller
- Manual Upload
- Audio Monitor Admin + Listen links
- System Status

---

## 2.0 - Core Modules

This section defines the **modules** of Syronius’ Frame and how they map to **containers** in the V1 docker-compose stack.

### A) Container Map (V1)

> Container names are themed and consistent to keep `docker ps`, logs, and documentation readable.

| Container                        | Holds These Modules                                                                                                                   | Notes                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **frame-edge**                   | Traefik reverse proxy, LAN HTTPS termination, internal routing                                                                        | Single HTTP edge for all web UIs                                 |
| **frame-portal**                 | Portal shell (dashboard + nav), `/status` (or status links), capability-aware menu                                                    | Links to other UIs (no iframes)                                  |
| **frame-ingest-video**           | OpenIRL `srtla-receiver` ingest + stats                                                                                               | UDP ingest + stats endpoint                                      |
| **frame-streams**                | OpenIRL `sls-management-ui`                                                                                                           | Requires `frame-ingest-video`                                    |
| **frame-overlays**               | Overlay server (telemetry overlay + upload progress overlay), overlay wizard + presets + preview                                      | Wizard uses Stream Profiles from `frame-streams`                 |
| **frame-ingest-files**           | FTP input server                                                                                                                      | Writes uploads into `/data/inbox`                                |
| **frame-uploads** *(optional)*   | Manual upload UI (phone/browser)                                                                                                      | Can be merged into pipeline later                                |
| **frame-pipeline-photos**        | Photo pipeline: validate complete, convert to JPG-only, EXIF extract, sidecars, `.ready`, update `latest.json`, optional Discord post | Required for Gallery/Viewer/Discord                              |
| **frame-gallery**                | SFPG (Single File PHP Gallery)                                                                                                        | Browses `/data/galleries/YYYY-MM-DD`                             |
| **frame-today**                  | `/today/gallery` wrapper, `/today/viewer`, `/today/remote`                                                                            | Stream presentation + mobile control                             |
| **frame-audio**                  | Audio Monitor (admin + capture + relay + listen + HLS)                                                                                | `/audio/admin` LAN-only; `/audio/listen` + `/audio/hls` tunneled |
| **frame-tunnel** *(Hybrid only)* | Cloudflared tunnel                                                                                                                    | Exposes HTTP routes only                                         |

---

### B) Reverse Proxy

- Traefik (internal routing)
- Optional Cloudflared (Hybrid mode)

### C) SRTLA + SLS

- OpenIRL `srtla-receiver`
- OpenIRL `sls-management-ui`
- **Dependency:** SLS UI requires SRTLA receiver
- SLS Stream IDs become **Stream Profiles** usable by overlays

### D) Overlay Server

- Existing Express app
- Two overlays (telemetry + upload progress)
- Extended with:
  - Overlay Wizard
  - Live preview iframe
  - Presets
  - Placement controls (`dock`, `pad`, `scale`)

#### Telemetry Stats Source (V1)

Default stats URL pattern (from `frame-ingest-video`):

- `http://<host-ip>:8080/stats/<play-id>`

Notes:

- `<play-id>` is derived from the SLS Stream Profile.
- The overlay server should treat stats as best-effort: show a clear "NO SIGNAL" or "OFFLINE" state when unreachable.

**Dependencies (V1 default UX):**

- Bitrate overlay requires **SRTLA receiver** (stats source)
- Overlay Wizard requires **SLS UI / Stream Profiles** (stream selection without manual URLs)
- Upload progress overlay requires **Photo Pipeline** (or upload telemetry source)

### E) Photo Ingest (Inputs)

These do **not** add images to galleries directly. They only accept uploads and pass them to the Photo Pipeline.

- **FTP Server (Input):** uploads land in `/data/inbox`
- **Manual Upload Service (Input):** browser/phone uploads

#### Completed Upload Contract (V1)

Only **completed** files may enter `/data/staging`.

**Preferred (when supported by the client/server):**

- Upload into `/data/inbox/<name>.<ext>.uploading`
- On completion, atomically rename to `/data/inbox/<name>.<ext>`
- Then atomically move/rename into:
  - `/data/staging/<name>.<ext>`

**Fallback (camera/client limitations): size-stability gate**

Because some camera FTP clients may not support temp extensions or atomic rename semantics, the input layer must support a stability-based completion check:

- A file in `/data/inbox` is considered complete when its **size has not changed for 3 seconds**.
- Only then is it moved to `/data/staging`.

Notes:

- The move from inbox → staging should be an atomic rename on the same filesystem when possible.
- The pipeline must ignore `/data/inbox` entirely; it only processes `/data/staging`.

**Dependency:** FTP and Manual Upload are only useful when **Photo Pipeline** is enabled.

### F) Photo Pipeline (Required for all images)

The Photo Pipeline is the **single source of truth** for:

- when an image is considered **complete**
- what files are considered **publishable**
- how metadata is extracted and represented for overlays and StreamerBot

It processes files that arrive in:

- `/data/staging` (complete uploads only)

> Partial/temporary uploads must remain in `/data/inbox`. The **FTP input** and **Manual Upload** services are responsible for moving completed files to `/data/staging` (ideally via atomic rename).

#### V1 State Machine

`INBOX (partial) → STAGING (complete) → NORMALIZE/EXTRACT → PUBLISH → (optional) DISCORD → ARCHIVE | QUARANTINE`

#### V1 Publish Rules

- Only images that can be converted to **JPG** are publishable in V1.
- RAW formats are **not** processed in V1 (quarantine instead). RAW support is a V2 goal.
- If EXIF is missing, sidecars are still created with placeholders.

#### Output Location

Published outputs go to the current day folder:

- `/data/galleries/YYYY-MM-DD/`

`/data/today` is a convenience link to the current day folder.

**Multi-day runtime rule (V1):**

- If the stack runs across multiple days, the pipeline must keep `/data/today` up to date.
- After computing `YYYY-MM-DD` (using `.env TIMEZONE`), the pipeline:
  - ensures `/data/galleries/YYYY-MM-DD/` exists
  - updates `/data/today` → `/data/galleries/YYYY-MM-DD/` using an **atomic symlink swap** (temp link + rename)
- UI routes should treat `DATA_ROOT/state/latest.json.date_folder` as the canonical selector for the active day folder (symlink is a convenience).

#### Base Naming

`<base>` is derived from the original filename so operators can search by camera/phone file name.

V1 format:

- `<original>_YYYY-MM-DD_HH_mm_ss`

Where:

- `<original>` is the original filename **without extension**, sanitized for filesystem safety
- `YYYY-MM-DD_HH_mm_ss` is the **processing completion timestamp** (derived using `.env TIMEZONE`)

Example:

- `DSC_0421_2025-12-29_21_14_07`

Collision handling (V1):

- If `<base>` already exists in the target day folder, append a short suffix: `_2`, `_3`, etc.

#### Processing Steps (V1)

When a new file appears in `/data/staging`:

1. **Identify file type**

   - If file is not an image → **QUARANTINE** with `<base>.error`

2. **Determine target day folder**

   - Use the **current local date** at the time processing completes → `YYYY-MM-DD`
   - The local date is derived from the `.env` \`\`\*\* (TZ)\*\* setting to ensure consistent behavior across hosts and containers.
   - Rationale: ensures all images uploaded during a stream session land in **"today"** regardless of when they were taken.
   - Create `/data/galleries/YYYY-MM-DD/` if missing

3. **EXIF extraction** (best-effort)

   - Export full metadata to:
     - `/data/galleries/YYYY-MM-DD/<base>.json`
   - If no EXIF:
     - still write `<base>.json` with placeholders (e.g., `{ "exif": "unknown" }`)

4. **Normalize to JPG**

   - If already JPG/JPEG, validate it can be decoded.
   - If convertible (HEIC/PNG/etc.), convert to JPG.
   - Write the image to:
     - `/data/galleries/YYYY-MM-DD/<base>.jpg`
   - On conversion failure:
     - retry up to **3 attempts**
     - then **QUARANTINE** with `<base>.error`

5. **Create StreamerBot sidecars**

   - Formatted camera settings text:
     - `/data/galleries/YYYY-MM-DD/<base>.txt`
     - If unknown, write `(unknown)` placeholders.
   - Orientation flag:
     - `/data/galleries/YYYY-MM-DD/<base>.orientation`
     - `0` = landscape, `1` = portrait
     - Determined from final JPG dimensions (portrait if height > width).

6. **Create ****\`\`**** manifest (must be last)**

   Location:

   - `/data/galleries/YYYY-MM-DD/<base>.ready` (also visible under `/data/today/`)

   Contents (line-based):

   - Line 0: full host path to JPG
     - `DATA_ROOT/galleries/YYYY-MM-DD/<base>.jpg`
   - Line 1: full host path to TXT (used directly as an OBS text source)
     - `DATA_ROOT/galleries/YYYY-MM-DD/<base>.txt`
   - Line 2: orientation flag (`0` or `1`)

   **Atomic write rule:** `.ready` is written to a temp name then renamed into place.

7. \*\*Update \*\*\`\`

   - Update `DATA_ROOT/state/latest.json` only after `.ready` is present.
   - Write should be atomic (temp + rename).

8. **Cleanup**

   - Move or delete the staged source file after successful publish.
   - Optionally move the original into `/data/archive/` for retention.

#### Quarantine Contract

On rejection, move the original into:

- `/data/quarantine/`

And write an error descriptor:

- `/data/quarantine/<base>.error.json`

##### `error.json` schema (V1)

```json
{
  "reason_code": "PPL-01",
  "reason": "NOT_IMAGE",
  "detail": "Detected file type did not match an image container; conversion was not attempted.",
  "original_name": "IMG_1234.MOV",
  "detected_mime": "video/quicktime",
  "attempts": 0,
  "timestamp": "2025-12-29T21:14:07-06:00",
  "log_ref": "frame-pipeline-photos:2025-12-29T21:14:07-06:00:job-7f3a"
}
```

##### Reason codes (V1)

Codes are stable and machine-readable; `detail` provides human context.

- **PPL-01 — NOT\_IMAGE**
  - File is not an image (or could not be identified as an image)
- **PPL-02 — CONVERT\_FAILED**
  - File failed conversion after max attempts
- **PPL-03 — RAW\_UNSUPPORTED**
  - File appears to be a RAW format (V1 does not process RAW)
- **PPL-04 — DECODE\_FAILED**
  - File claims to be JPG/PNG/etc. but cannot be decoded (corrupt/truncated)
- **PPL-05 — EXIF\_EXTRACT\_FAILED**
  - EXIF extraction step failed (publish may still proceed with placeholders unless other failures occur)
- **PPL-06 — FILE\_ACCESS\_ERROR**
  - Permission/locking/read error while processing
- **PPL-07 — PIPELINE\_INTERNAL\_ERROR**
  - Unexpected exception; catch-all

##### Notes

- `detected_mime` is the best-effort detected media type (e.g., `image/jpeg`, `image/heic`, `application/octet-stream`). It helps answer "what did we think this was?".
- `log_ref` is a lightweight log pointer (container name + timestamp + job id). Full stack traces are optional and may live only in logs.

Rejected files do **not** update `latest.json`.

#### Parallelism & Throughput (V1)

- Pipeline processes multiple files concurrently using a bounded worker pool.
- Default concurrency should be conservative (e.g., 2–4 workers) to avoid I/O thrash.
- Per-file output generation must remain ordered such that `.ready` is always last.

#### Discord Webhook Sink (Optional)

If Discord is enabled:

- After `.ready` is written:
  1. Create a Discord-safe copy in:
     - `/data/discord/<base>_discord.jpg`
     - Ensure image is compressed to be under **10 MB**
  2. Send via webhook with the formatted camera settings from `<base>.txt`

Rate-limiting rules (V1):

- Use a separate bounded queue for Discord sends.
- Respect webhook rate limits by throttling and retrying on 429.
- Do not block photo publishing on Discord failures; failures should be logged and retried.
- \*\*After a successful Discord webhook post, delete the corresponding file from \*\*\`\` to avoid re-sends and unbounded disk growth.

**Dependencies:**

- Requires at least one input enabled: **FTP Server and/or Manual Upload**

### G) Today Gallery + Viewer

- Gallery for today’s images
- Fullscreen viewer (OBS-friendly)
- Remote controller (phone/tablet)

**Dependency:** requires **Photo Pipeline**

### H) Discord Webhook (Optional)

- Auto-post published images

**Dependency:** requires **Photo Pipeline**

### I) Audio Monitor (V1 – Browser Capture)

**V1 approach:** Audio capture is performed **in-browser** on the LAN host using WebRTC (`getUserMedia`) and a virtual audio cable/VoiceMeeter-provided virtual input device.

#### Output Transport (V1)

- Relay outputs **HLS (AAC)** for listening.
- HLS segments target **1 second** duration to keep monitoring latency low.
- **Bitrate selection (V1):** Admin can set a per-stream target bitrate (preset list, e.g., 64k / 96k / 128k).
  - Implementation note: this is applied by the encoder (ffmpeg) as a fixed bitrate per stream. True “dynamic bitrate” adaptation is a V2 item (would require ABR ladders or congestion-aware transport).

#### Publisher Model (V1)

- **One publisher per stream**. If a publisher is active, additional publishers are rejected.

#### Pages

- `/audio/admin` — Create/manage audio streams (SLS-like) (**LAN-only**)
- `/audio/capture/<streamId>` — Capture/publisher page (**LAN-only**)
- `/audio/listen/<streamId>` — Listener page (tunneled in Hybrid)
- `/audio/hls/<streamId>/...` — HLS playlist/segments (tunneled in Hybrid)

#### Stream ID Management (V1)

- **Rename streamId (V1 recommendation):** treat rename as **create a new stream + delete the old stream**.
  - Rationale: the streamId is embedded in URLs, HLS folder paths, and any saved OBS/browser bookmarks. “True rename” requires migrating state and ensuring old URLs don’t break unexpectedly.
  - UX: provide an **“Duplicate / Rename”** flow that:
    1. creates a new stream with the new id (copying settings like listener limit, bitrate preset, always-on)
    2. shows the new Capture/Listen URLs
    3. offers a final “Delete old stream” button

#### Admin UX (`/audio/admin`)

- “Add audio source” button
- Fields:
  - `streamId` (unique)
  - Listener limit (cap)
  - Always-on mode (silence when offline)
- Actions:
  - Create stream
  - **Delete stream** (removes it from registry and stops its relay)
  - View listen URL
  - View capture URL (LAN)

#### Capture UX (`/audio/capture/<streamId>`)

- Device dropdown (WebRTC device list)
- “Go Live” button
- Real-time health:
  - input metering
  - encoder bitrate/health
  - publish/reconnect status
- **Disconnect listeners** (admin/publisher-side force re-sync)
  - Implementation note: listeners are not truly “kicked” at the transport layer (HLS is pull-based), so this action invalidates the current playlist path by incrementing a `generation` value for the stream (e.g., `/audio/hls/<streamId>/<gen>/index.m3u8`). Listen pages auto-detect and reconnect.
- Optional: “Pop-out mini window” for OBS Window Capture

#### Listen UX (`/audio/listen/<streamId>`)

- Auto-play attempt; provides “Tap to listen” if required by browser policy
- Always-on listening:
  - stream continues with injected silence when capture is offline
- Shows status + listener count

#### Exposure Rules

- **LAN-only:** `/audio/admin/*`, `/audio/capture/*`
- **Hybrid/public:** `/audio/listen/*`, `/audio/hls/*` (through Cloudflare Tunnel)

#### Notes

- No authentication in V1; `streamId` is treated as an unguessable token.

---

### J) Dependency Layering (V1)

Think of the stack as layers with enforced dependencies.

#### Layer 0 — Platform

- Traefik
- (Hybrid) Cloudflared
- Shared `/data` volume

#### Layer 1 — Sources / Inputs

- SRTLA receiver
- FTP input
- Manual upload input

#### Layer 2 — Control Planes

- SLS management UI (requires SRTLA)

#### Layer 3 — Processing

- Photo Pipeline (requires FTP and/or Manual Upload)

#### Layer 4 — Presentation

- Overlays (requires SRTLA; Wizard requires SLS)
- Gallery / Viewer / Remote (requires Photo Pipeline)

#### Layer 5 — Integrations

- Discord webhook uploader (requires Photo Pipeline)
- Audio monitor (independent of SRTLA/photo)

---

## 3.0 - Storage & Contracts

Base path: `/data`

### A) Required Directories

```
/data/inbox
/data/staging
/data/today -> /data/galleries/YYYY-MM-DD
/data/galleries/YYYY-MM-DD
/data/state
/data/logs
/data/quarantine
/data/archive
```

### B) Today Publishing Contract

For each image:

- `<base>.jpg`
- `<base>.json`
- `<base>.txt`
- `<base>.orientation`
- `<base>.ready` (written last)

#### `.ready` Manifest (line‑based)

- Line 0: full path to JPG
- Line 1: full path or contents of TXT
- Line 2: orientation flag

Streamerbot watches: `/data/today/*.ready`

---

## 4.0 - Config & Presets

### A) Static Config (`.env`)

Used for:

- Docker compose profiles
- Secrets and credentials
- Low-level service configuration

`.env` is **generated and updated** by the installer and should not normally be edited by hand.

### B) Capability Config (`/data/state/stack-config.json`)

This file is generated and maintained by the installer and is the **single source of truth** for enabled user-facing features.

It defines **capabilities**, not containers.

Example schema:

```json
{
  "mode": "HYBRID",
  "capabilities": {
    "stream_management": true,
    "overlays": true,
    "photo_pipeline": true,
    "gallery": true,
    "viewer": true,
    "upload": true,
    "audio_monitor": true
  },
  "routes": {
    "dashboard": "/dashboard",
    "sls_ui": "/ui",
    "overlays_wizard": "/overlays/setup",

    "today_gallery": "/today/gallery",
    "today_viewer": "/today/viewer",
    "today_remote": "/today/remote"
  }
}
```

### C) Route Definitions (V1)

- \`\`

  - Wrapper page with SFPG embedded via `<iframe>`
  - SFPG points at the current day folder: `/data/galleries/YYYY-MM-DD`
  - Wrapper polls `DATA_ROOT/state/latest.json` every **1 second**
  - If `updated_at` changes, wrapper forces an iframe refresh

- \`\`

  - Custom fullscreen slideshow viewer (OBS-friendly)
  - Reads images from the current day folder: `/data/galleries/YYYY-MM-DD`
  - Displays EXIF/info as a live text overlay sourced from sidecar files (not burned into image)
  - Supports remote control via `/today/remote`

- \`\`

  - Mobile-friendly controller UI
  - Buttons: previous / next, start slideshow
  - Slider: image duration
  - Optional: **Show thumbnails** toggle (off by default)
  - Shows real-time readout of the currently displayed filename (and optionally a small thumbnail)

#### Viewer Remote Control Protocol (V1)

- Transport: **WebSocket** (preferred for low-latency control)
- The viewer is the source of truth for state.
- `/today/remote` sends commands; `/today/viewer` broadcasts state.

Commands:

- `NEXT`, `PREV`
- `START_SLIDESHOW`, `STOP_SLIDESHOW`
- `SET_INTERVAL_MS`
- `GOTO_INDEX`

Viewer state broadcast (at least on change):

- `current_index`, `current_base`, `current_filename`
- `slideshow_running`, `interval_ms`
- `count_today`

Thumbnail behavior:

- Thumbnails are optional and off by default.
- If enabled, viewer provides a small JPEG/WEBP preview derived from the current image (best-effort).

Controls `/today/viewer` in real time

### D) `latest.json` (V1)

Location: `DATA_ROOT/state/latest.json`

- Updated by the Photo Pipeline after each publish
- Contains at minimum:
  - `updated_at`
  - `date_folder` (e.g., `YYYY-MM-DD`)
  - `latest_image` (optional)
  - `count_today` (optional)



### E) Dependency Enforcement Rules

The installer enforces dependencies automatically:

- Overlays ⇒ require **SRTLA receiver** and **SLS UI**
- Gallery / Viewer / Discord ⇒ require **Photo Pipeline**
- FTP or Manual Upload ⇒ require **Photo Pipeline**
- Disabling a base dependency disables dependent capabilities

Users are warned of cascading changes before config is saved.

### F) Presets

- Overlay presets are stored in `/data/state/overlay-presets.json` or sqlite
- Presets generate stable URLs usable directly in OBS

---

## 5.0 - Network Exposure

### A) Design Principle

- **Traefik is the single HTTP edge** for all web UIs.
- In **Hybrid mode**, Cloudflare Tunnel exposes only HTTP/HTTPS routes.
- Non-HTTP services (SRTLA UDP ingest, FTP) remain LAN-only.

### B) Host-Exposed Ports (Documented Defaults)

> These are the default ports the installer must validate for conflicts based on enabled capabilities.

#### Always (when Portal/Web is enabled)

- **80/tcp**  — Traefik HTTP
- **443/tcp** — Traefik HTTPS

> V1 default: Traefik serves **HTTPS on LAN** by default to keep the menu system cohesive and consistent.

#### SRTLA Receiver (when enabled)

- **5000/udp** — SRTLA ingest
- **4001/udp** — SRT ingest
- **4000/udp** — Watch/play
- **8080/tcp** — Stats endpoint (recommended LAN-only; can be internal behind Traefik if desired)

#### SLS Management UI (when enabled)

- Prefer **internal behind Traefik** (no host port).
- If direct exposure is required (not recommended): **3000/tcp**

#### FTP Input (when enabled)

- **21/tcp** — FTP control
- **30000–30100/tcp** — Passive range (configurable)

### C) Exposure by Mode

#### LAN Mode

- Web UIs available on LAN via Traefik (80/443).
- SRTLA UDP ports exposed on LAN.
- FTP exposed on LAN.
- LAN-only pages remain accessible locally:
  - `/audio/admin/*`, `/audio/capture/*`

#### Hybrid Mode

- Cloudflare Tunnel exposes only Traefik HTTP routes.
- SRTLA UDP ports remain LAN-only (user may optionally port-forward manually).
- FTP remains LAN-only.
- Public/tunneled routes include:
  - `/dashboard`, `/status`
  - `/overlays/*`
  - `/today/*`
  - `/audio/listen/*`, `/audio/hls/*`
- Explicitly excluded from tunnel:
  - `/audio/admin/*`, `/audio/capture/*`

#### Hybrid Exposure Artifact (Generated by Installer)

In Hybrid mode, the installer generates the cloudflared ingress rules from `stack-config.json` capabilities.

- When a capability is enabled, its allowed public routes are added.
- When a capability is disabled (or when switching to LAN mode), the installer rewrites the tunnel config to remove those routes.

Mode switching:

- Switching **Hybrid → LAN** disables/removes the `frame-tunnel` service and deletes/rewrites the generated tunnel config so no HTTP routes remain exposed.
- Switching **LAN → Hybrid** re-enables `frame-tunnel` and regenerates ingress rules.

---

## 6.0 - Observability

`/status` endpoint shows:

- Service health
- Last ingest
- Last photo published
- Audio stream status
- Disk usage

---

## 7.0 - Resource Planning

### A) CPU

- Minimum: 4 cores
- Recommended: 6–8 cores

### B) RAM

- Minimum: 8 GB
- Recommended: 16 GB

### C) Disk

- Minimum: 250 GB
- Recommended: 1 TB+

### D) Network

- Audio monitor: \~64–128 kbps per listener

---

### E) Retention & Cleanup Defaults (V1)

Retention is conservative and designed to prevent partial files from lingering, while preserving artifacts useful for troubleshooting.

- \`\`
  - Delete temp/partial files older than **30 minutes**.
- \`\`
  - Delete files older than **30 minutes** (these should be short-lived).
- \`\`
  - Files are deleted immediately after successful webhook delivery.
  - Files that remain here are considered pending/failed sends and are retained until successfully sent.
- \`\`
  - Retained indefinitely by default (manual cleanup by end user).
- \`\`
  - Retained indefinitely by default (this is the primary archive).

> V1 assumes the operator manages disk capacity. If storage becomes low, the stack should surface warnings in `/status` and logs.

---

## 8.0 - Setup Flow

1. Run installer
2. Choose mode and modules
3. Start stack
4. Create SLS stream
5. Configure overlays via wizard
6. Test photo ingest
7. Configure audio streams

---

## 9.0 - Open Decisions

- Stream profile sync method
- Default gallery implementation
- Thumbnail strategy
- Audio transport internals
- Retention defaults

---

## Appendix A - Starter `.env` Template

```env
# === GLOBAL ===
STACK_MODE=HYBRID          # LAN or HYBRID
TIMEZONE=America/Chicago
DATA_ROOT=/opt/irlstack/data

# === MODULE TOGGLES ===
ENABLE_SRTLA=true
ENABLE_SLS_UI=true
ENABLE_OVERLAYS=true
ENABLE_FTP=true
ENABLE_GALLERY=true
ENABLE_UPLOAD=true
ENABLE_DISCORD=false
ENABLE_AUDIO_MONITOR=true

# === FTP ===
FTP_USER=camera
FTP_PASS=change_me
FTP_PASSIVE_PORTS=30000:30100

# === CLOUDFLARE (HYBRID ONLY) ===
CLOUDFLARE_TUNNEL_TOKEN=

# === DISCORD (OPTIONAL) ===
DISCORD_WEBHOOK_URL=

# === AUDIO MONITOR DEFAULTS ===
AUDIO_CODEC=AAC
AUDIO_ALWAYS_ON=true

# === OVERLAY DEFAULTS ===
OVERLAY_DEFAULT_DOCK=tr
OVERLAY_DEFAULT_PAD=20
OVERLAY_DEFAULT_SCALE=1.0
```





*End of V1 Spec*
