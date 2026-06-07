# ADR 0004: Use one shared Docker-hosted installer runtime

- **Status:** Accepted
- **Date:** 2026-06-07

## Context

FRAME requires `stack.cmd` and `stack.sh` entrypoints with identical configuration, validation, and
data-safety behavior. Reimplementing those rules independently in PowerShell and shell would make
configuration drift likely. Requiring Node, Python, or PowerShell on every host would add another
prerequisite to an already Docker-based appliance.

## Decision

Both entrypoints are thin lifecycle wrappers around one dependency-free JavaScript installer
runtime executed through a pinned Node Docker image. The shared runtime owns config generation,
normalization, validation, secret generation, and reset boundaries. The host wrappers use Docker
Compose v2 to build and manage containers.

The initial installer supports the implemented services in LAN mode. It refuses HYBRID deployment
until the shared HTTP edge and tunnel service exist.

## Consequences

- Windows and Unix hosts use the same configuration logic.
- Docker and Docker Compose v2 are the only host runtime prerequisites.
- Installer behavior is testable without installing language tooling on the host.
- The first installer invocation may pull the pinned Node runtime image.
- External data roots are deferred until a cross-platform mounting and reset-safety contract exists.
