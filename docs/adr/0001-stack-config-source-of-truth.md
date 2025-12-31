# ADR 0001: stack-config.json is the single source of truth

- **Status:** Accepted
- **Date:** 2025-12-31

## Context

The FRAME stack has multiple modules (Portal, tunnel generation, overlays, today tools, audio tools) that must agree on:
- enabled capabilities
- route paths for navigation
- which routes may be exposed publicly in HYBRID mode

Without a single authoritative contract, drift and “it works on my machine” behavior becomes likely.

## Decision

The stack uses `/data/state/stack-config.json` as the single source of truth for:
- `mode` (LAN vs HYBRID)
- `capabilities` (module enablement)
- `routes` (canonical route paths)
- `public_route_prefixes` (HYBRID allowlist)

The installer and Portal validate this file at startup and treat it as authoritative.

## Consequences

- A strict schema can be enforced early, with clear errors.
- Tunnel ingress generation becomes deterministic and repeatable.
- Navigation generation becomes deterministic and repeatable.
