# ADR 0012: Canonical Photo Journeys

- Status: Accepted
- Date: 2026-07-21

## Context

FRAME can observe one photo through several services. A Belabox upload can appear in sender
telemetry, the chunk or FTP receiver, the staging service, and the photo pipeline. Those services
currently expose adapter-local transfer IDs. Combining their records makes one photo look like two
uploads, while matching by filename and time would incorrectly merge genuinely separate photos.

The product must describe the user's photo from source to publication. Transport attempts are
useful diagnostics, but they are not separate photos.

## Decision

FRAME separates two identities:

- `journey_id` is the immutable identity of one accepted photo. The first FRAME-aware owner creates
  it once, and every later service preserves it through preprocessing, retries, transport changes,
  staging, processing, publication, quarantine, and restart recovery.
- `transfer_id` identifies an adapter-local attempt or observation. One journey may have several
  transfer IDs.

IDs are opaque, case-sensitive strings of 8-96 ASCII letters, numbers, underscores, or dashes.
The reserved `__` sequence is forbidden because it delimits the FTP envelope. Services generate
UUID-based IDs. Identity is never inferred from a filename, timestamp, or payload hash. The same
filename with two journey IDs represents two photos.

### Transport and filesystem handoff

- HTTP handoffs carry `X-Frame-Journey-Id` and retain the existing transfer-ID header.
- File-only FTP handoffs use the versioned internal filename envelope
  `FRAMEJ1_<journey_id>__<original_name>`. The FTP receiver removes the envelope before presenting
  the filename to users.
- Direct FTP uploads write an `.uploading` remote name and rename it only after `STOR` succeeds.
- Completed inputs enter staging as one atomically renamed directory:

  ```text
  /data/staging/<journey_id>.frame-photo/
    source
    journey.json
  ```

  `journey.json` records the journey ID, original filename, SHA-256 content digest, receipt time,
  and the ingest adapter and transfer ID. Moving the directory is the visibility boundary, so the
  pipeline can never claim a photo without its provenance.
- Ingress services recover interrupted hidden envelope directories on startup. The pipeline
  validates the declared size and recomputes the digest before trusting an envelope.
- The pipeline continues to accept legacy bare staging files. It assigns each one a standalone
  legacy journey with the migration-only `legacy_staging` ingest adapter; legacy observations are
  never correlated heuristically.

### Ownership and idempotency

- Chunk manifests bind a journey ID to their integrity metadata. Reusing an ID with conflicting
  metadata is rejected.
- Chunk writes and completion receipts are atomic. Retrying a completed request returns its stored
  receipt instead of staging the photo again, and receipt recovery finishes any interrupted payload
  cleanup.
- The pipeline stores durable journey receipts below `/data/state/photo-journeys/`. A published
  receipt is terminal and immutable, so an exact-content retry resolves to the existing publication
  rather than creating another gallery item.
- A failed exact-content journey may replace its receipt with a new processing attempt under the
  same journey ID. Its quarantine descriptor remains as the audit record for the failed attempt, and
  live-claim checks prevent concurrent duplicate processing.
- Reusing a journey ID with different content is quarantined as an identity conflict without
  replacing the canonical receipt.
- New publications and identifiable quarantines include `journey_id`. The field remains optional in
  their V1 schemas so historical sidecars and malformed-input quarantine records remain readable.
  The three-line `.ready` contract remains unchanged.

### Progress and overlay behavior

- Producers add `journey_id` to progress records while preserving current fields during rollout.
- Shared receivers also expose `source_adapter`; an overlay only admits observations whose origin
  matches one of its selected upload types. Supplemental pipeline health cannot mask an outage in
  the selected source.
- The overlay retains raw adapter observations for diagnostics and reduces them into journeys by
  exact ID. Missing IDs become independent legacy journeys keyed by adapter and transfer ID.
- Counts, focus, progress, and completion bubbles operate on journeys. Metrics come from one
  authoritative active observation and are never summed across duplicate observers.
- The product lifecycle is `Uploading` → `Staged` → `Processing` → `Published`. Transfer receipt
  establishes `Staged`; only pipeline publication and creation of the `.ready` sidecar establish
  `Published` and emit the user-facing `Completed` event.
- The queue shows up to five active journeys. The journey nearest completion leads: processing and
  staged work precede uploads, and uploads with known rates use estimated time remaining before
  percentage and age fallbacks. A changed order must remain preferred for one second before
  same-membership cards exchange positions.
- The leading journey is expanded; following journeys remain compact, retain upload percentage, and
  fade by queue position. Lifecycle colors default to light blue, amber, yellow, and green.
- A new publication animates into a separate completion bubble. Additional publications reset its
  configurable inactivity window, which defaults to three seconds, and accumulate in the current
  completion count.
- A newly failed visible journey flashes red and falls out from its existing queue position. A later
  nonterminal observation with the same journey ID re-enters the active queue.
- Adapter failures, raw status text, and stale timestamps remain available in diagnostics. Product
  cards use phase-owned copy so entry methods and transport-local completion wording do not leak into
  the canonical journey UI.

## Rollout

1. Deploy the envelope-aware pipeline while retaining legacy bare-file support.
2. Add journey IDs and atomic envelopes to web upload and FTP ingest.
3. Propagate the ID through Belabox preprocessing, chunked HTTPS, direct FTP, and terminal results.
4. Enable exact-ID journey reduction in the overlay; keep raw observations in its API.
5. Remove legacy fallbacks only after deployed state and supported agents have migrated.

All fields are additive during this rollout. There is no filename/time deduplication fallback.

## Consequences

- One photo produces one product-level journey even when several services report it.
- Retries and transport switches remain observable without creating duplicate completions or
  publications.
- FTP gains a reserved internal filename envelope, but public filenames remain unchanged.
- Staging changes from bare files to atomic directories; the pipeline must support both forms during
  migration.
- Durable receipts remain the idempotency ledger. A bounded recent-receipt cache serves overlay
  polling without rereading all historical receipts; retention tooling can later compact the ledger
  only if delayed retries cannot resurrect completed journeys.
