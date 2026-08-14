# FRAME Overlays

FRAME Overlays creates real-time browser-source overlays for OBS. Use it to display stream health,
BELABOX cloud telemetry, and live photo upload progress on top of your production scene.

## Who This Is For

FRAME Overlays is for streamers and production operators who use OBS.

Use it if you want to:

- Show SRT stream health in OBS.
- Show BELABOX cloud telemetry in OBS.
- Show live photo upload progress in OBS.
- Copy a stable browser-source URL for each overlay.
- Adjust overlay colors, layout, size, and behavior from FRAME.

## What You Use It For

Use Overlays when you want OBS viewers to see real-time feedback from your FRAME tools.

Supported overlay feeds:

| Feed | What It Shows |
| --- | --- |
| SRT stream health | Bitrate, latency, RTT, dropped packets, uptime, and connection state. |
| BELABOX cloud telemetry | BELABOX-compatible stream health from a connected telemetry source. |
| Live photo upload progress | Browser upload, FTP ingest, and Belabox connector progress for incoming photo files. |

Upload-progress sources follow one canonical photo journey across receipt, transfer, processing,
and publication. A journey completes only after Photo Pipeline publishes the image and writes its
`.ready` sidecar; the renderer then shows a short completion bubble before resetting.

The main thing users create is a **Source**.

A Source is the OBS browser-source URL plus the data feed and visual settings behind it. The wizard
walks you through creating one Source at a time.

## How To Install

Overlays is part of the normal FRAME stack.

Recommended setup:

1. Open the FRAME folder.
2. Run `stack.cmd`.
3. Choose **Guided setup**.
4. Enable Overlays.
5. Enable Stream Management if you want SRT stream health overlays.
6. Enable Browser Photo Upload, Camera FTP Upload, or Belabox Manager for upload progress overlays.
7. Start the stack.
8. Open the Overlay Wizard:

```text
http://localhost/overlays/setup
```

For standalone testing only:

1. Open this folder:

```text
services/frame-overlays
```

2. Copy `.env.example` to `.env`.
3. Start the service:

```bash
docker compose up --build -d
```

4. Open:

```text
http://localhost:3733/overlays/setup
```

Most users should use the full FRAME stack instead of standalone mode.

## How To Operate

Open the Overlay Wizard:

```text
http://localhost/overlays/setup
```

To create an OBS overlay:

1. Create a new Source.
2. Choose what the Source should display.
3. Name the Source.
4. Follow the wizard steps.
5. Copy the OBS URL.
6. Add it to OBS as a Browser Source.

In OBS:

1. Add a new **Browser Source**.
2. Paste the copied FRAME overlay URL.
3. Set the width and height you want.
4. Keep the source visible in your scene.
5. Return to FRAME Overlays whenever you want to adjust the source.

Editing a Source keeps the same OBS URL. You should not need to re-add the browser source in OBS
after normal changes.

Built-in templates are immutable. Creating a Source makes a reusable preset from the selected
template, and the permanent OBS URL slug is chosen before the first save. Connectivity and upload
presets remain type-isolated so photo settings cannot overwrite the stock connectivity design.

## Relies Upon

Overlays relies on:

- FRAME Portal
- FRAME Edge
- OBS or another app that supports browser sources

Optional connections:

| Overlay Feed | Relies Upon |
| --- | --- |
| SRT stream health | FRAME Stream Management |
| Local SRT/SRTLA relay health | FRAME Video Ingest |
| BELABOX cloud telemetry | A connected BELABOX-compatible telemetry source |
| Live photo upload progress | FRAME Photo Upload, FRAME Photo FTP, or FRAME Belabox Manager |

## Notes For Operators

The Overlay Wizard is a management page and should stay local or login-protected.

The copied OBS view URL is designed to be stable. Deleting a Source removes that OBS URL.

If you remove or rename a stream, existing Sources may need to be pointed at a new stream, but their
OBS URLs can stay the same.
