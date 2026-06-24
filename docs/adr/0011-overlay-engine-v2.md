# ADR 0011: Overlay Engine V2 ownership and live-update model

## Status

Accepted — 2026-06-20

## Decision

FRAME separates immutable built-in templates, reusable user presets, and OBS sources. Presets own
only visual configuration. Sources own data binding and a permanent public identity composed of a
readable slug plus an unguessable random key. V1 preset-based URLs remain valid through persisted
legacy aliases created during schema migration.

The existing `frame-overlays` container also owns a telemetry hub. It polls each upstream stream
profile once, normalizes and timestamps the result, and fans it out to renderers using SSE. A
source-scoped REST endpoint remains available for reconnect fallback. State changes and telemetry
polls are serialized independently so neither overlapping writes nor out-of-order samples can win.

## Consequences

- Stock templates cannot be modified through state or API mutations.
- Management writes use document and entity revisions with optimistic conflict responses.
- State writes create backups and use unique temporary files before atomic rename.
- Public renderers never receive the private stream profile ID.
- No additional service or container is introduced.
