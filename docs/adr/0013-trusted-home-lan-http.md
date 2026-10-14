# ADR 0013: Keep direct LAN access on HTTP

- **Status:** Accepted
- **Date:** 2026-08-14
- **Updated:** 2026-09-30 — removed automatic LAN hostname discovery.

## Context

FRAME is designed for an operator-controlled home or production LAN. Public routes use Cloudflare
Tunnel, which provides browser-facing HTTPS without exposing the LAN edge. Adding HTTPS directly to
the LAN edge would require operators to provide a trusted DNS name and certificate or install a
FRAME-owned certificate authority on every client device.

## Decision

`frame-edge` remains an HTTP-only LAN entry point. LAN security, segmentation, and access policy are
the operator's responsibility. FRAME does not generate self-signed certificates, distribute a local
certificate authority, or automate LAN TLS.

On the FRAME host, Portal access uses `http://localhost/dashboard`, including the configured Edge
port when it is not 80: `http://localhost:<configured-port>/dashboard`. Other LAN devices use the
host's LAN IP address or a DNS name the operator configures and maintains, with the same port and
route. FRAME does not publish LAN hostnames or install a discovery watchdog. Background tracking
of host environment or network changes is outside the launcher scope; explicit readiness checks
and observed service health remain required.

Hybrid/public routes continue to use HTTPS at Cloudflare and the capability-aware
`frame-public-gateway`. The internal `cloudflared` to public-gateway hop remains HTTP on the private
Docker network.

Browser features that require a secure context should use `localhost` when running on the FRAME host
or a configured Cloudflare HTTPS route when used from another device. FRAME must document such
requirements rather than presenting an untrusted LAN certificate.

## Consequences

- A default install has no certificate, DNS, or client trust-enrollment workflow.
- LAN clients need the host's LAN IP address or operator-managed DNS name and configured Edge port.
- Direct LAN traffic is not encrypted by FRAME.
- Operators who require LAN encryption may place FRAME behind infrastructure they manage.
- Cloudflare Access policy automation remains an optional, separate future enhancement.
