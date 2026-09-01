# FRAME Photo Stage

FRAME Photo Stage presents the current FRAME photo day for OBS and live production. It gives you a
fullscreen viewer, a phone-friendly remote, and a small dashboard for copying the OBS viewer URL.

Photo Stage currently opens under `/today/...` routes. Future versions may add `/stage/...` routes
while keeping `/today/...` as compatibility aliases.

## Who This Is For

FRAME Photo Stage is for streamers and operators who want to show the latest published photos during
a live production.

Use it if you want to:

- Add a fullscreen photo viewer to OBS.
- Control the photo viewer from a phone or second screen.
- Run a slideshow from the current photo day.
- Show or hide camera information.
- Send viewers to the current public gallery.

## What You Use It For

Use Photo Stage when published FRAME photos should become part of the live show.

Common uses:

- Show the newest event or stream photo in OBS.
- Play, pause, or stop a slideshow.
- Move to the previous or next photo manually.
- Scroll one tall image from top to bottom.
- Toggle camera and exposure details on the viewer.
- Copy the OBS viewer URL from one dashboard.

## How To Install

Photo Stage is part of the normal FRAME stack.

Recommended setup:

1. Open the FRAME folder.
2. Run `stack.cmd`.
3. Choose **Guided setup**.
4. Enable **Photo Stage**.
5. Enable **Photo Gallery** and **Photo Pipeline**.
6. Enable a photo input, such as **Browser Photo Upload** or **Camera FTP Upload**.
7. Start the stack.
8. Open Photo Stage Dashboard:

```text
http://localhost/today/dashboard
```

## How To Operate

Open the dashboard:

```text
http://localhost/today/dashboard
```

The **Pipeline Activity** panel shows the current worker and queue state, batch image and data
throughput, and each active photo's named processing stage. Stage names are used instead of estimated
percentages. When the pipeline becomes idle, the panel keeps the most recent ingest summary visible.

Open **Performance details** for the 60-second rolling rate and recent average, p50, and p95 queue,
processing, per-stage, and publish-lock timings. This section stays collapsed by default.

Copy the OBS viewer URL:

```text
http://localhost/today/viewer
```

Add that URL to OBS as a Browser Source.

Open the phone remote:

```text
http://localhost/today/remote
```

Use the remote to:

- Play, pause, or stop the slideshow.
- Move backward or forward through photos.
- Change the slideshow timing.
- Show or hide camera details.
- Show or hide the viewer background.
- Scroll the current image once.

Stop returns the viewer to the newest published photo. Scroll image once works when playback is
paused or stopped.

The public gallery is available at:

```text
http://localhost/today/gallery
```

## Relies Upon

Photo Stage relies on:

- FRAME Portal
- FRAME Edge
- FRAME Auth for the dashboard and remote
- FRAME Photo Pipeline
- FRAME Photo Gallery
- FRAME shared data storage

Optional connections:

| Feature | Relies Upon |
| --- | --- |
| Browser photo uploads | FRAME Photo Upload |
| Camera FTP uploads | FRAME Photo FTP |
| Public gallery access | FRAME Tunnel or configured public FRAME access |
| OBS presentation | OBS Browser Source |

Photo Stage reads live processing telemetry from `PHOTO_PIPELINE_URL`, which defaults to
`http://frame-pipeline-photos:3735` inside the FRAME stack. Set it only when running Photo Stage
outside the generated Compose network.

## Notes For Operators

Photo Stage reads published photo data. It does not upload, delete, hide, restore, or publish
photos.

Gallery management stays in FRAME Photo Gallery Admin.

Photo Stage shows useful camera and exposure details, but it does not persist or display
GPS/location metadata.
