# FRAME Photo Upload

A mobile-first, Portal-authenticated browser upload input. Uploads stream into `/data/inbox` with
an `.uploading` suffix and move atomically into `/data/staging` only after completion.

Open authenticated `/photos/upload` through FRAME Edge. The mobile-first queue sends selected files
with individual progress feedback and uses up to `PHOTO_UPLOAD_MAX_SESSIONS` concurrent upload
requests. `PHOTO_UPLOAD_MAX_FILES` controls how many files can be selected at once; both default to
`10`. The service intentionally performs only transfer limits and safe naming; the Photo Pipeline
remains the source of truth for image validation.

Each browser request supplies a stable transfer ID and exact file size. The service tracks received
bytes, elapsed time, average speed, and terminal queued/failed state per file. Authenticated FRAME
services can read the short-lived multi-transfer snapshot from
`/api/internal/photo-upload/progress`; it is not exposed through the public `/photos` surface.
