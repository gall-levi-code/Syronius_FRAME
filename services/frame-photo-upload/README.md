# FRAME Photo Upload

A mobile-first, Portal-authenticated browser upload input. Uploads stream into `/data/inbox` with
an `.uploading` suffix and move atomically into `/data/staging` only after completion.

Open authenticated `/photos/upload` through FRAME Edge. The mobile-first queue sends selected files
sequentially with individual progress feedback. The service intentionally performs only transfer
limits and safe naming; the Photo Pipeline remains the source of truth for image validation.
