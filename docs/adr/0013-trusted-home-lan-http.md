# ADR 0013: Keep direct LAN access on HTTP

- **Status:** Accepted
- **Date:** 2026-08-14

## Context

FRAME is designed for an operator-controlled home or production LAN. Public routes use Cloudflare
Tunnel, which provides browser-facing HTTPS without exposing the LAN edge. Adding HTTPS directly to
the LAN edge would require operators to provide a trusted DNS name and certificate or install a
FRAME-owned certificate authority on every client device.

## Decision

`frame-edge` remains an HTTP-only LAN entry point. LAN security, segmentation, and access policy are
the operator's responsibility. FRAME does not generate self-signed certificates, distribute a local
certificate authority, or automate LAN TLS.

When the host provides a standard mDNS publisher, FRAME advertises its LAN edge as `frame.local`
and the `_http._tcp` service named `FRAME`. Discovery starts and stops with the stack; on Windows,
a per-user watchdog restores it after sign-in and follows Edge availability. This is a friendly
alias rather than a security boundary; the host's LAN address and configured Edge port
remain valid fallbacks.

Hybrid/public routes continue to use HTTPS at Cloudflare and the capability-aware
`frame-public-gateway`. The internal `cloudflared` to public-gateway hop remains HTTP on the private
Docker network.

Browser features that require a secure context should use `localhost` when running on the FRAME host
or a configured Cloudflare HTTPS route when used from another device. FRAME must document such
requirements rather than presenting an untrusted LAN certificate.

## Consequences

- A default install has no certificate, DNS, or client trust-enrollment workflow.
- Supported LAN clients can open `http://frame.local` without finding the host IP first.
- Direct LAN traffic is not encrypted by FRAME.
- Operators who require LAN encryption may place FRAME behind infrastructure they manage.
- Cloudflare Access policy automation remains an optional, separate future enhancement.
