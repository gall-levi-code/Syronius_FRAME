# ADR 0006: Photo Pipeline Activation

- Status: Accepted
- Date: 2026-06-11

## Context

FRAME exposes user-facing photo capabilities for FTP input, browser upload, gallery, Discord
delivery, and Today Tools. Every one of these features depends on the photo pipeline to decide when
an upload is complete, normalize it, publish it, and maintain shared state.

Exposing the pipeline as another independent toggle would allow invalid configurations where photo
features are enabled but no safe publishing path exists.

## Decision

`frame-pipeline-photos` is an internal required service rather than a user-facing capability.

Every photo capability activates the `photo-pipeline` Compose profile. Output capabilities continue
to require at least one enabled photo input. The canonical relationship is stored in
`config/frame-services.json`.

## Consequences

- Users choose desired photo workflows rather than infrastructure dependencies.
- The installer can never deploy an implemented photo feature without its pipeline.
- Disabling all photo capabilities disables the pipeline without deleting photo data.
- The pipeline service must remain compatible with every photo input and output contract.
