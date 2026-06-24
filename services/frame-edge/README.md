# FRAME Edge

`frame-edge` is the unified LAN HTTP entry point for FRAME. It uses the official Traefik image,
pinned by digest, and discovers only containers explicitly labeled with `traefik.enable=true`.

The edge connects to the restricted `frame-docker-proxy` over the internal FRAME network. It never
mounts the Docker socket and the proxy continues to reject Docker API mutation requests by default.

Current routes:

| Route | Service |
| --- | --- |
| `/`, `/dashboard`, `/status` | `frame-portal` |
| `/slsui/*` | `frame-streams` |
| `/overlays/*` | `frame-overlays` |

The Portal catch-all router has priority `1`. Service routers use priority `100`, so newly
implemented services can claim their own path prefix without modifying Portal.

In Hybrid mode, `frame-public-gateway` is a second internal-only Traefik instance using the generated
file-provider route allowlist. `frame-tunnel` connects Cloudflare only to that gateway, never
directly to the full LAN edge. This prevents LAN-only paths such as `/audio/admin`,
`/audio/capture`, and `/slsui` from being exposed by an overly broad Cloudflare Published
application route.

External Hybrid requests that miss the allowlist, hit a denied public path, or receive a downstream
`4xx`/`5xx` response are sent to shared FRAME error pages served by `frame-auth`.
