# ADR 0010: Photo administration uses reversible publication markers

- **Status:** Accepted
- **Date:** 2026-06-14

## Context

Operators need to remove individual photos or complete albums from the Gallery, Today viewer, and
remote without immediately destroying the publication. Restoring a photo must not recreate its
`.ready` manifest because host-side StreamerBot workflows may treat a new `.ready` write as a new
photo event.

Gallery covers, counts, time spans, Today state, and `latest.json` must all agree immediately after
an administrative change.

## Decision

The Photo Pipeline remains the sole mutation authority. Gallery Admin calls an internal,
service-token-protected pipeline API while publication and management changes share the pipeline
publish lock.

Trashing a publication atomically writes `<base>.trashed.json` beside the existing publication.
The JPG, sidecars, and original `.ready` receipt remain untouched. FRAME consumers consider a
publication visible only when `<base>.ready` exists and `<base>.trashed.json` does not.

Restoring removes only the trash marker. Permanent deletion is allowed only for a trashed
publication and removes the JPG, sidecars, `.ready`, trash marker, and cached thumbnail.
Successful source uploads retained under `/data/archive` remain governed by the separate archive
retention policy.

After every publish, trash, restore, or permanent deletion, the pipeline atomically recalculates
`state/latest.json`. `updated_at` is the visible-library revision timestamp and always advances for
management changes. `latest_photo_at` retains the publication time of `latest_base`.

## Consequences

- Restore is instant and cannot emit a second `.ready` event.
- Public Gallery, Today Remote, Today Viewer, and the Today wrapper converge through the same
  visibility rule.
- Album covers, counts, and duration spans recalculate from visible publications.
- Permanent deletion is deliberately a two-step trash-then-delete operation.
- Non-FRAME consumers that scan `.ready` directly must also honor `.trashed.json` if they need to
  reflect Gallery Admin visibility.
