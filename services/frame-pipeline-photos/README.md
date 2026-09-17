# FRAME Photo Pipeline

FRAME Photo Pipeline prepares uploaded photos for the FRAME gallery, Photo Stage, and related photo
tools.

It checks new photos, converts accepted images into the published format, writes the gallery files,
and keeps the latest-photo state up to date.

## Who This Is For

FRAME Photo Pipeline is mostly for operators who use FRAME photo tools.

Use it if you want to:

- Accept photos from Browser Photo Upload or Camera FTP Upload.
- Publish uploaded photos into the FRAME gallery.
- Feed Photo Stage with the newest published photos.
- Let Gallery Admin hide, restore, or permanently delete gallery photos.
- Trigger host-side tools such as StreamerBot when a new photo is ready.

## What You Use It For

Use Photo Pipeline as the processing step between photo inputs and photo outputs.

Common uses:

- Turn uploaded images into gallery-ready JPG files.
- Keep published photos organized by day.
- Update the current latest photo for Photo Stage.
- Keep original uploads archived when enabled.
- Move failed or unsupported files aside for review.

Most users do not open Photo Pipeline directly. They use Photo Upload, Photo FTP, Photo Gallery, and
Photo Stage.

## How To Install

Photo Pipeline is enabled automatically when a FRAME photo tool needs it.

Recommended setup:

1. Open the FRAME folder.
2. Run `stack.cmd`.
3. Choose **Guided setup**.
4. Enable at least one photo input, such as **Browser Photo Upload** or **Camera FTP Upload**.
5. Enable the photo outputs you want, such as **Photo Gallery** or **Photo Stage**.
6. Start the stack.

Most users should not run Photo Pipeline by itself.

## How To Operate

Use your chosen photo input to add photos.

Photo Pipeline processes accepted files, publishes them to shared gallery data, and updates the
latest-photo state automatically.

Use Photo Gallery Admin to hide, restore, permanently delete, or empty trashed gallery photos and
albums. Photo Pipeline recalculates the authoritative latest-photo state after those changes so
Photo Stage does not point at a hidden or deleted image.

Gallery Admin can also move selected photos to another gallery date, including a new date. This
corrects a batch split across midnight without reuploading. Moves preserve filenames, capture and
processing timestamps, metadata, and tracked originals; a conflicting destination filename rejects
the batch. Photos still finishing publication or in trash must finish or be restored first.

Gallery Admin receives live step progress while moves wait for the publication lock, check photos,
prepare and move files, finalize the publication, and clean up. Failed moves announce recovery before
reporting the error. Immutable JPEG, text and orientation payloads use hard links during preparation;
the move does not copy or re-encode the full images. Metadata, file checks, cache cleanup and catalog
refresh still take time, especially with large albums or many cached tiles.

The existing management endpoint returns JSON by default. A `move-photos` request with
`Accept: application/x-ndjson` receives progress records followed by a result or error record.
Progress counts reset for each step. A disconnected progress observer does not cancel an accepted move.

`trash-photos` accepts a `date_folder` and a `bases` array of 1–1000 photos. It validates the entire
selection before creating recoverable trash markers, then refreshes latest state once for the batch.
Published files and archived originals remain intact; repeating a request safely skips existing markers.

When both galleries have Explore maps, explicit photo placements move into the destination map;
each gallery keeps its own routes. If the destination has no map, the source retains its placements
so moving the photos back restores them. Moving a photo writes a new `.ready` manifest with the new
paths, which host-side watchers may treat as a new photo event.

Normal move failures roll back for retry. A durable move record also recovers interrupted moves on
restart: unfinished moves restore the source gallery, while committed moves finish removing old
source files. Recovery runs before retention and latest-photo reconciliation and preserves foreign
replacement files. Source photo bytes stay backed up until the move commits and cleanup completes.

Open `/pipeline` from FRAME Portal to set the published JPG long edge, quality, maximum output
file size, and **Original backup retention (days)**. Image processing settings apply to new photos
only. Backup retention applies to existing and new original backups; the default is 14 days from
when each backup was created. Set it to `0` to keep original backups indefinitely. Gallery photos,
albums, and trash remain until you delete them manually in Gallery Admin.

For StreamerBot or other host-side watchers, watch:

```text
<your-frame-data-folder>\galleries
```

Include subfolders, and process only files whose names end exactly in `.ready`.

Set the host-visible FRAME data path before using host-side watchers. Existing `.ready` files are not
rewritten when that path changes.

## What Gets Generated

For each accepted photo, FRAME creates a group of files in:

```text
/data/galleries/YYYY-MM-DD/
```

Example:

```text
IMG_1234_2026-06-26_14_30_05.jpg
IMG_1234_2026-06-26_14_30_05.json
IMG_1234_2026-06-26_14_30_05.txt
IMG_1234_2026-06-26_14_30_05.orientation
IMG_1234_2026-06-26_14_30_05.ready
```

| File | What It Does |
| --- | --- |
| `.jpg` | The published gallery image. FRAME converts accepted photos into JPG. |
| `.json` | Photo details such as original filename, size, format, publish time, and available camera metadata. |
| `.txt` | StreamerBot-style camera text, for example `Shot on Camera with the Lens @ 35mm` plus exposure settings. |
| `.orientation` | `1` for portrait, `0` for landscape or square. |
| `.ready` | The final "this photo is complete" signal. Watch this file for automation. |

The `.ready` file is written last. If a `.ready` file exists, the matching published files should be
ready to use.

Gallery Admin can also create:

| File | What It Does |
| --- | --- |
| `.trashed.json` | Marks a published photo as hidden or trashed without deleting the photo files. |

Restoring a photo removes the `.trashed.json` marker. Permanently deleting a trashed photo removes
the published files.

## Accepted And Rejected Files

FRAME accepts files that are recognized as images and can be converted into JPG.

Common accepted examples include JPG, PNG, TIFF, BMP, WebP, HEIC, and HEIF.

FRAME rejects:

- Files that are not detected as images.
- Files over the configured upload size limit.
- Images over the configured megapixel limit.
- Camera RAW files.
- Files that fail image decoding or conversion.

Missing EXIF or camera metadata does not reject a photo. FRAME publishes the image and records a
warning in the metadata sidecar.

When available, the sidecar keeps EXIF `DateTimeOriginal` as a timezone-free `capture_clock`, including
`SubSecTimeOriginal`. If the camera also supplies a valid `OffsetTimeOriginal`, FRAME records the
corresponding absolute UTC instant as `captured_at`. This lets Gallery distinguish precise capture
order from the later `processed_at` processing time without pretending an unknown camera timezone is UTC.

## Where Files Travel

Browser uploads and camera FTP uploads both feed the same pipeline.

| Folder | What Happens There |
| --- | --- |
| `/data/inbox` | Partial camera FTP files; Photo Pipeline never reads this folder. |
| `/data/staging` | Atomic completed-photo envelopes containing `source` and `journey.json`. |
| `/data/processing` | Temporary working area while FRAME checks and converts a photo. |
| `/data/galleries/YYYY-MM-DD` | Published photos and sidecars. This is what Gallery and Photo Stage read. |
| `/data/state/latest.json` | Current latest-photo state for Photo Stage and other tools. |
| `/data/state/photo-journeys` | Durable receipt for each photo journey, used for progress and retry safety. |
| `/data/archive/YYYY-MM-DD/<journey_id>` | Original uploaded backup after successful publish, when archiving is enabled. Backup age is tracked separately from the gallery date. |
| `/data/quarantine` | Rejected files and their error reports. |

Browser uploads build a hidden temporary envelope and atomically rename it into staging after the
upload completes.

Camera FTP uploads sit in `/data/inbox` until their size and modified time stop changing. After
that, FRAME wraps them in the same atomic staging envelope.

Photo Pipeline claims staged files by moving them into `/data/processing`. If processing succeeds,
FRAME publishes the generated files into `/data/galleries/YYYY-MM-DD`. If processing fails, FRAME
moves the original into `/data/quarantine` and writes an `.error.json` file explaining why.

Every envelope has an immutable `journey_id`. Web upload, FTP, Belabox telemetry, pipeline progress,
published metadata, and quarantine reports preserve that ID so retries and multiple observers still
represent one photo. FRAME verifies the envelope's SHA-256 content digest before processing and
quarantines any attempt to reuse a journey ID for different bytes.

## Storage Safeguards

Photo processing uses the same disk thresholds shown by FRAME Portal:

| Setting | Default | Behavior |
| --- | ---: | --- |
| `DISK_WARN_PERCENT` | `85` | Reports a warning when the FRAME data disk reaches this percentage. |
| `DISK_ERROR_PERCENT` | `95` | Pauses new photo claims at this percentage. |
| `DISK_MINIMUM_FREE_GB` | `20` | Also pauses new photo claims when less than this much space remains. Set `0` to disable the free-space floor. |

A disk pause leaves uploads in the queue and keeps the service running so Docker does not restart-loop.
The pipeline status reports the current disk state and resumes automatically after space is available.

## Pipeline Activity And Logs

Photo Stage reads live activity from `/api/internal/photo-pipeline/status`. The additive status fields
include configured and active workers, the true waiting queue, active filenames and named stages,
60-second image and MiB rates, recent average/p50/p95 stage timings, publish-lock wait and hold time,
and current/last batch summaries. Batch summaries remain available after a burst drains to idle.

Pipeline job and batch start/completion logs are single-line JSON at INFO level. Enable DEBUG only
while diagnosing a bottleneck to also log every named stage and publish-lock acquisition:

```env
PIPELINE_LOG_LEVEL=info
# PIPELINE_LOG_LEVEL=debug
```

The default is `info`. Named stages are used instead of percentage progress because image stages do
not have equal cost. Telemetry is in memory and resets when the service restarts.

## Original Backup Retention

Original upload backups expire after **14 days** by default. Change **Original backup retention
(days)** on `/pipeline` to any whole number from `0` to `36500`; `0` keeps backups indefinitely.
The timer starts when the original is archived, not when the photo was captured or the gallery
folder was created. Changing the setting also applies to backups already on disk.

| Setting | Default | Behavior |
| --- | ---: | --- |
| `PHOTO_ARCHIVE_RETENTION_DAYS` | `14` | Initial original-backup retention in days. The owner can save a different value on the Pipeline page; `0` disables expiry. |

Only original backups under `/data/archive` expire automatically. Their expiry is independent of
whether the published gallery photo exists or is in trash. FRAME never automatically deletes a
gallery, published photo, or trash entry. Use Gallery Admin for those decisions.

FRAME records each new backup's creation time in `.frame-archive.json`, mapping its actual filename
to an ISO timestamp. Older backups use their filesystem creation time, with modified time as the
fallback when creation time is unavailable. Cleanup removes only recognized original files; it does
not recursively delete user folders or unknown files.

The settings API exposes this value as `archive_retention_days` in the existing `GET` and `PUT`
`/pipeline/api/settings` response. Saving processing settings keeps the retention value alongside
`long_edge_px`, `jpeg_quality`, and `max_output_mb`.

## Quarantine And `.error.json`

When Photo Pipeline rejects a file, it moves the original into:

```text
/data/quarantine
```

It also writes a matching error report:

```text
/data/quarantine/<photo-name>_<job-id>.error.json
```

The error report includes:

| Field | What It Means |
| --- | --- |
| `reason_code` | Short FRAME error code. |
| `journey_id` | Canonical ID shared by every stage and observer for this photo. |
| `reason` | Simple failure category. |
| `detail` | Human-readable explanation. |
| `original_name` | The filename FRAME received. |
| `detected_mime` | File type FRAME detected, when available. |
| `attempts` | How many conversion attempts were made. |
| `timestamp` | When the file was quarantined. |
| `log_ref` | Log reference to help match the file with service logs. |

Current failure codes:

| Code | Reason | What It Usually Means |
| --- | --- | --- |
| `PPL-01` | `NOT_IMAGE` | FRAME could not detect the file as an image. |
| `PPL-02` | `CONVERT_FAILED` | The file was too large or conversion to JPG failed. |
| `PPL-03` | `RAW_UNSUPPORTED` | The file is a camera RAW format. RAW files are not supported in V1. |
| `PPL-04` | `DECODE_FAILED` | FRAME detected an image, but could not decode it, read its dimensions, or the image exceeded the megapixel limit. |
| `PPL-06` | `FILE_ACCESS_ERROR` | Envelope metadata, source size/digest, or journey identity conflicts with the staged photo. |
| `PPL-07` | `PIPELINE_INTERNAL_ERROR` | Something unexpected failed while processing the file. Check service logs with the `log_ref`. |

Reserved spec code not currently emitted by this implementation:

| Code | Meaning |
| --- | --- |
| `PPL-05` | EXIF extraction failed. Today, missing or unreadable EXIF is treated as a warning, not a rejection. |

## Relies Upon

Photo Pipeline relies on:

- FRAME shared data storage
- At least one photo input, such as FRAME Photo Upload or FRAME Photo FTP
- FRAME Portal service credentials for Gallery Admin actions

Optional connections:

| Feature | Relies Upon |
| --- | --- |
| Public gallery | FRAME Photo Gallery |
| OBS/photo presentation | FRAME Photo Stage |
| Browser photo uploads | FRAME Photo Upload |
| Camera FTP uploads | FRAME Photo FTP |
| Host-side automation | StreamerBot or another watcher pointed at `.ready` files |

## Notes For Operators

Set the FRAME timezone before an event if photo day grouping matters.

Do not edit files in the pipeline staging or processing folders while FRAME is running.

Do not delete the shared photo data folder unless you are ready to lose published gallery data.

Unsupported or failed files are moved aside instead of published.

The date in a camera filename is not used as the publication date. FRAME uses the time the photo was
published.
