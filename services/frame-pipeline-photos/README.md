# FRAME Photo Pipeline

The internal FRAME photo publication service. Inputs move completed files to `/data/staging`; this
service claims them, validates and normalizes them to JPG, publishes sidecars with `.ready` last,
updates `latest.json`, then archives or quarantines the original.

The pipeline also owns reversible Gallery Admin changes. Trashing writes `<base>.trashed.json`
without touching `.ready`; restoring removes only that marker. Every publish or management change
atomically advances `latest.json.updated_at` and recalculates the visible latest photo and count.

The processing and recovery contract is recorded in
[`docs/adr/0007-photo-pipeline-processing-contract.md`](../../docs/adr/0007-photo-pipeline-processing-contract.md).

## Environment

- `DATA_ROOT=/data`
- `HOST_DATA_ROOT=/data` path written into `.ready` manifests for host-side StreamerBot consumers.
  Set this to the host-visible FRAME data directory when StreamerBot runs outside Docker.
- `TIMEZONE=America/Chicago`
- `PORT=3735`
- `PIPELINE_POLL_MS=1000`
- `PIPELINE_CONCURRENCY=2`
- `PHOTO_MAX_INPUT_MB=50`
- `PHOTO_MAX_MEGAPIXELS=80`
- `PHOTO_CONVERSION_ATTEMPTS=3`
- `PHOTO_ARCHIVE_ORIGINALS=true`
- `PORTAL_SERVICE_TOKEN` authenticates internal Gallery Admin management requests.
