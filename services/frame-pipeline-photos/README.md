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

Use Photo Gallery Admin to hide, restore, permanently delete, or empty trashed gallery photos.

Open `/pipeline` from FRAME Portal to set the published JPG long edge, quality, and maximum output
file size. These settings apply to new photos only.

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

Common accepted examples include JPG, PNG, TIFF, BMP, WebP, HEIC, and HEIF when the runtime can
decode them.

FRAME rejects:

- Files that are not detected as images.
- Files over the configured upload size limit.
- Images over the configured megapixel limit.
- Camera RAW files.
- HEIC/HEIF files when the current runtime cannot decode them.
- Files that fail image decoding or conversion.

Missing EXIF or camera metadata does not reject a photo. FRAME publishes the image and records a
warning in the metadata sidecar.

## Where Files Travel

Browser uploads and camera FTP uploads both feed the same pipeline.

| Folder | What Happens There |
| --- | --- |
| `/data/inbox` | First landing area for incoming browser or FTP uploads. |
| `/data/staging` | Completed files waiting for Photo Pipeline. |
| `/data/processing` | Temporary working area while FRAME checks and converts a photo. |
| `/data/galleries/YYYY-MM-DD` | Published photos and sidecars. This is what Gallery and Photo Stage read. |
| `/data/state/latest.json` | Current latest-photo state for Photo Stage and other tools. |
| `/data/archive/YYYY-MM-DD` | Original uploaded files after successful publish, when archiving is enabled. |
| `/data/quarantine` | Rejected files and their error reports. |

Browser uploads are written as temporary `.uploading` files first, then moved into staging after the
upload completes.

Camera FTP uploads sit in `/data/inbox` until their size and modified time stop changing. After
that, FRAME moves them into staging.

Photo Pipeline claims staged files by moving them into `/data/processing`. If processing succeeds,
FRAME publishes the generated files into `/data/galleries/YYYY-MM-DD`. If processing fails, FRAME
moves the original into `/data/quarantine` and writes an `.error.json` file explaining why.

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
| `PPL-02` | `CONVERT_FAILED` | The file was too large, HEIC/HEIF decoding was unavailable, or conversion to JPG failed. |
| `PPL-03` | `RAW_UNSUPPORTED` | The file is a camera RAW format. RAW files are not supported in V1. |
| `PPL-04` | `DECODE_FAILED` | FRAME detected an image, but could not decode it, read its dimensions, or the image exceeded the megapixel limit. |
| `PPL-07` | `PIPELINE_INTERNAL_ERROR` | Something unexpected failed while processing the file. Check service logs with the `log_ref`. |

Reserved/spec codes not currently emitted by this implementation:

| Code | Meaning |
| --- | --- |
| `PPL-05` | EXIF extraction failed. Today, missing or unreadable EXIF is treated as a warning, not a rejection. |
| `PPL-06` | File access error. Today, unexpected file access failures are reported as `PPL-07`. |

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
