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
- Choose from the latest 60 photos in the current gallery, newest first, using the thumbnail picker.
- Change the slideshow timing.
- Show or hide camera details.
- Show or hide the viewer background.
- Scroll the current image once.

Pausing or selecting a photo holds that photo while uploads continue, including across midnight.
The remote shows how many new photos arrived. **Follow latest** returns to the newest published
photo and follows subsequent uploads; Stop also returns to this mode. Playing starts a slideshow
in the active gallery, and new uploads do not reset its countdown. Scroll image once works when
playback is paused or stopped.

The thumbnail picker stays inside the screen with a fixed heading and close button. Its larger,
uncropped previews scroll independently and keep their position as slideshow playback advances.
The current photo has a **Current** badge, and **Back to newest** returns to the top of the picker.

The remote displays the playback mode, seconds remaining, and feedback from connected viewers:
loading, photo displayed, or image unavailable. Multiple viewers are counted separately. This
confirms image rendering in viewer browsers; it does not indicate whether an OBS scene is on air.
The viewer prepares the next slideshow image in advance and changes camera details with the image.

Open **Viewer settings** beside the playback status to choose compact, full, or hidden camera
information, select its corner, or fade it out after five seconds. **Clean OBS output** keeps
connection and loading messages off the viewer and on the remote. The camera-information button
still toggles visibility and remembers the last visible style.

**Keep screen awake** is optional and applies to that remote tab. Its status reports whether a
screen wake lock is actually active. It requires a supported browser in a secure context (HTTPS,
or localhost during development); battery settings can prevent it. The lock is released in the
background and requested again when the remote becomes visible.

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

Dashboard library summaries are reused until the pipeline publication revision changes, with a
one-minute reconciliation for manual file edits. Concurrent dashboard requests share one scan.
Library and pipeline polling pause in hidden tabs and resume when the dashboard becomes visible.

Photo Stage shows useful camera and exposure details, but it does not persist or display
GPS/location metadata.
