# FRAME Stabilization Guide

This document records the guardrails used while FRAME grows from a working service collection into
a maintainable appliance stack. The goal is to preserve working behavior while reducing the blast
radius of future changes.

## Current Checkpoint

Before beginning another service:

1. Run `stack.cmd verify` on Windows or `./stack.sh verify` on Linux/macOS.
2. Build the enabled Compose services.
3. Review `git status --short` and confirm secrets, generated Compose, and `/data` remain ignored.
4. Commit the complete deployable stack on a named branch.
5. Open a pull request and require the `Verify FRAME` workflow to pass.

The checkpoint must include new service directories, contracts, installer changes, and operational
documentation together. Runtime data and credentials must never be included.

## Verification Layers

### Fast Local Verification

`stack.* verify` runs deterministic tests and JavaScript syntax checks, then validates the generated
Docker Compose configuration when present.

### Service Verification

Every Node service must provide:

- `npm run typecheck`
- `npm run build`
- `npm test` when the service owns testable state or business rules

The GitHub `Verify FRAME` workflow runs typechecking and builds for every implemented Node service.

### Contract Verification

`config/frame-services.json` is the canonical capability, route, profile, dependency, and public
exposure registry. Tests ensure it stays aligned with the published stack-config schema and copied
runtime overlay contracts.

## Hotspot Boundaries

Large files are reduced only when related behavior is already covered by tests. Avoid broad rewrites.

### Audio Bridge `SessionManager`

Extract in this order as behavior changes require it:

1. Guild configuration and bridge-profile persistence.
2. Active session lifecycle and idle expiration.
3. Per-profile control mutations.
4. Snapshot construction and publication.

Keep the existing `SessionManager` facade until callers can migrate without a coordinated rewrite.

### Audio Bridge Control Page

Separate future changes along these boundaries:

1. WebSocket state and optimistic command handling.
2. Bridge/session information rendering.
3. Overlay editor controls.
4. User rows, meters, and per-user controls.
5. Section ordering, locking, and theme preferences.

Prefer updating stable DOM nodes over broad rerenders while sliders, buttons, or drag operations are
active.

### Installer

The service contract has moved into `installer/frame-contract.mjs`. Future extraction candidates are:

1. Environment generation and validation.
2. State and atomic-file persistence.
3. Command parsing and interactive prompting.

Installer behavior must remain available through the shared Windows and Unix wrappers.

## Shared Helper Policy

FRAME keeps services independently deployable. A helper should move into shared code only when:

- at least three services need identical behavior;
- drift would create a security, persistence, or contract risk; and
- the helper can be tested without coupling service release lifecycles.

Current candidates:

- Basic authentication parsing and timing-safe comparisons.
- Atomic JSON-file persistence.
- Shared contract validation.

Browser rendering helpers and service-specific API wrappers stay local until their behavior is truly
identical.

## Photo Pipeline Identity

`frame-pipeline-photos` is an internal required service, not a user-facing capability toggle.

Selecting any implemented photo capability automatically activates the `photo-pipeline` Compose
profile. This prevents users from enabling an input, gallery, Discord delivery, or Today Tools
without the pipeline required to safely normalize and publish images.
