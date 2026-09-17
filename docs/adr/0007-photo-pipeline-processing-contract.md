# ADR 0007: Photo Pipeline Processing Contract

- Status: Accepted
- Date: 2026-06-12

## Context

Photo inputs and outputs share a filesystem, and uploads may be retried, interrupted, duplicated, or
observed by multiple workers. The V1 specification defines the published files but does not fully
define ownership while processing or recovery after a crash.

## Decision

The V1 photo workflow uses these contracts:

- Inputs expose completed photos as atomic `<journey-id>.frame-photo` directories in `/data/staging`.
  Each directory contains `source` plus canonical `journey.json` provenance. Legacy bare files remain
  supported during migration.
- The pipeline atomically claims a staged envelope by moving it into a unique directory under
  `/data/processing`. A claim preserves both the original filename and immutable journey identity.
- Files left in `/data/processing` are retried on startup. Re-observing staging or restarting the
  service cannot publish the same claimed file twice.
- V1 reliably accepts JPEG, PNG, WebP, TIFF, HEIC, and HEIF using the bundled decoder. Camera RAW
  formats are quarantined.
- Defaults are a 50 MiB input limit, an 80 megapixel decoded-image limit, three conversion attempts,
  and two concurrent workers. Operators may lower or raise the limits with environment variables.
- HEIC/HEIF claims share a single decode/normalize slot because their full RGBA buffers can be much
  larger than the compressed inputs; other formats still use the configured worker pool.
- Successful originals are archived by default. Rejected originals and a machine-readable error
  descriptor are retained in quarantine.
- Only original backups expire automatically, after 14 days from archive creation by default.
  The owner can change `archive_retention_days` on the existing Pipeline settings page; `0` disables
  expiry. Gallery photos, albums, and trash are deleted only through explicit owner actions.
- New archive folders record actual original filenames and ISO creation timestamps in
  `.frame-archive.json`. Legacy originals use filesystem creation time, then modified time if
  creation time is unavailable. Expiry does not depend on a corresponding gallery publication.
  Cleanup removes only known original files and never recursively deletes user data directories.
- Published sidecars use `docs/schemas/photo-sidecar.schema.json`. Quarantine descriptors use
  `docs/schemas/photo-error.schema.json`.
- All outputs are written through temporary files. `<base>.ready` is renamed into place last.
  `latest.json` is updated only after `.ready` exists.
- Startup reconciliation repairs `latest.json` from the newest `.ready` manifest when a crash occurs
  after publication but before the state update.
- Durable receipts under `/data/state/photo-journeys` make repeated delivery of one journey
  idempotent. See [`ADR 0012`](0012-canonical-photo-journeys.md).
- FTP remains a LAN-only input. Manual upload may be exposed in Hybrid mode only behind the
  configured Portal Basic Auth credentials.

## Consequences

- Every source uses the same completion boundary and cannot bypass pipeline validation.
- A host crash may cause a claimed file to be retried, but cannot expose a partial publish as ready.
- HEIC/HEIF behavior no longer depends on optional codecs in the Sharp container build.
- Original backups have a separate lifetime from gallery publications. Removing or trashing a
  gallery photo does not extend its original backup's retention period; set retention to `0` when
  the owner wants to keep original backups indefinitely.
