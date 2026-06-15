# ADR 0005: Hybrid traffic uses a dedicated public allowlist gateway

- **Status:** Accepted
- **Date:** 2026-06-11

## Context

FRAME Edge intentionally routes all LAN web tools, including administration and capture surfaces.
Pointing a Cloudflare Tunnel directly at that edge would make a dashboard mistake capable of
exposing LAN-only routes.

Remotely managed Cloudflare Tunnels are convenient to install with a connector token, but their
Published application configuration is controlled outside the FRAME installer.

## Decision

Hybrid deployments run two additional internal-only services:

- `frame-public-gateway` is a second Traefik instance using a generated file-provider configuration.
- `frame-tunnel` is a pinned `cloudflared` connector using a read-only token file.

Cloudflare Published applications route the public hostname to
`http://frame-public-gateway:8080`. The public gateway forwards only the effective public prefixes
computed from `stack-config.json` and the enabled capabilities. It has no Docker provider and cannot
discover additional services. Traefik access logs drop query parameters so control tokens embedded
in URLs are not written to gateway logs.

When `/dashboard` is public, the gateway also forwards the exact `/` path so Portal can redirect the
root hostname to the dashboard. This exact-path route does not expose any additional prefixes.

FRAME Edge also carries a high-priority deny router for known LAN-only management paths when a
request uses the configured public hostname or Cloudflare request headers. The deny router is a
defense-in-depth boundary for remotely managed tunnel routes that accidentally bypass the public
gateway.

The installer stages Hybrid mode without starting it. Startup validation requires:

- a valid public hostname,
- a configured Cloudflare tunnel token file, and
- Portal credentials.

## Consequences

- A broad or mistaken Cloudflare route still cannot reach FRAME's LAN-only HTTP paths.
- The tunnel token is not exposed through container environment inspection.
- Cloudflare account API credentials are not required by FRAME.
- Creating the tunnel and Published application remains an explicit Cloudflare dashboard step.
- Cloudflare Access policy automation and LAN HTTPS remain separate follow-up work.
