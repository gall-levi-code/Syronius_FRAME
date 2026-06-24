# FRAME Photo Pipeline

The internal FRAME photo publication service. Inputs move completed files to `/data/staging`; this
service claims them, validates and normalizes them to JPG, publishes sidecars with `.ready` last,
updates `latest.json`, then archives or quarantines the original.

The pipeline also owns reversible Gallery Admin changes. Trashing writes `<base>.trashed.json`
without touching `.ready`; restoring removes only that marker. Every publish or management change
atomically advances `latest.json.updated_at` and recalculates the visible latest photo and count.

Published manifests live under `/data/galleries/YYYY-MM-DD/`. For host-side StreamerBot, watch
`<FRAME_HOST_DATA_ROOT>\galleries` with subfolders included and process only files whose names end
exactly in `.ready`.

`.ready` is published by atomically renaming a neutral `.frame-write-<uuid>.tmp` file. StreamerBot
will report this as a `Renamed` event: use `fullPath`, not `oldFullPath`, and require `fileName` to
end exactly in `.ready`. The old path is event metadata for the complete-file handoff, not a
manifest to process.

Publication names use one shared base for every generated file:
`<sanitized-original-stem>_<FRAME-local-publication-time>`. For example,
`IMG-20250101-WA0142.jpg` published at 6:56:20 PM becomes
`IMG-20250101-WA0142_2026-06-14_18_56_20.{jpg,json,txt,orientation,ready}`. The date embedded in an
original camera filename is not interpreted as its publication date.

The processing and recovery contract is recorded in
[`docs/adr/0007-photo-pipeline-processing-contract.md`](../../docs/adr/0007-photo-pipeline-processing-contract.md).

## Environment

- `DATA_ROOT=/data`
- `HOST_DATA_ROOT=/data` path written into `.ready` manifests for host-side StreamerBot consumers.
  Set this to the host-visible FRAME data directory when StreamerBot runs outside Docker. Existing
  manifests are intentionally not rewritten when this changes because `.ready` is an event receipt.
- `TIMEZONE=America/Chicago`
- `PORT=3735`
- `PIPELINE_POLL_MS=1000`
- `PIPELINE_CONCURRENCY=2`
- `PHOTO_MAX_INPUT_MB=50`
- `PHOTO_MAX_MEGAPIXELS=80`
- `PHOTO_CONVERSION_ATTEMPTS=3`
- `PHOTO_ARCHIVE_ORIGINALS=true`
- `PORTAL_SERVICE_TOKEN` authenticates internal Gallery Admin management requests.
