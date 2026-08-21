# ADR 0004: FRAME Edge uses Traefik Docker discovery

- **Status:** Accepted
- **Date:** 2026-06-08

## Context

FRAME Portal navigation uses stable route prefixes, but independently exposed service ports caused
Portal links to resolve against the Portal container and return 404 responses. Future optional
services also need a consistent way to attach routes only while enabled.

## Decision

`frame-edge` is the shared LAN HTTP entry point and uses Traefik's Docker provider through the
restricted `frame-docker-proxy`.

- Traefik never receives the Docker socket directly.
- `exposedByDefault=false`; each routed service must opt in with labels.
- Portal owns a low-priority `/` catch-all.
- Optional services own higher-priority, namespaced route prefixes.
- Browser-facing assets and APIs live beneath their service prefix to prevent route collisions.
- Direct service host ports remain available during development and migration.

## Consequences

- Portal links work from the shared edge without knowing individual service ports.
- New services can attach a route by adding labels and keeping browser requests inside that prefix.
- The socket proxy also permits the read-only Docker events, network, ping, and version endpoints
  required by Traefik discovery.
- LAN HTTP is the intended direct-access model; FRAME-owned LAN TLS is out of scope per ADR 0013.
  HYBRID tunnel exposure is defined separately in ADR 0005.
