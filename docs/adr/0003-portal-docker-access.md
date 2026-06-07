# ADR 0003: Portal Docker access is read-only by default

- **Status:** Accepted
- **Date:** 2026-06-07

## Context

FRAME Portal needs Docker container state and logs to provide useful system observability. Docker
socket access also grants broad visibility and can grant effective host-level control when mutation
endpoints are available.

The V1.1 specification originally described a read-write socket mount so the Portal could restart
containers.

## Decision

`frame-portal` connects to a restricted Docker socket proxy and disables Docker API POST requests
and container restart actions by default.

- Status and live-log collection remain available.
- The Docker socket is not mounted into the Portal container.
- The proxy image is pinned by digest.
- Restart controls require `ENABLE_CONTAINER_RESTARTS=true` and proxy `POST=1`.
- Basic authentication is required when Portal runs in Hybrid mode.
- The Portal must remain LAN-only unless protected by an authenticated edge service.

## Consequences

- A default Portal deployment cannot restart containers.
- Operators must make a deliberate security decision before granting mutation access.
- The proxy remains a sensitive infrastructure component and must not be publicly exposed.
