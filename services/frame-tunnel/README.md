# FRAME Tunnel

`frame-tunnel` is the optional Hybrid-mode Cloudflare Tunnel connector. It uses Cloudflare's
official `cloudflared` image pinned by digest and runs only under the `hybrid` Compose profile.

The connector never points directly at the full FRAME Edge. Its Cloudflare Published application
must use:

```text
Type: HTTP
URL:  frame-public-gateway:8080
```

`frame-public-gateway` is an internal-only Traefik file-provider instance. The installer generates
its route list from enabled FRAME capabilities and excludes LAN-only routes.

## Staged setup

```text
stack hybrid-stage
stack tunnel-token
stack portal-auth
stack validate --for-start
stack start
```

The tunnel token is stored under the configured FRAME data root at
`state/cloudflare-tunnel-token` and mounted read-only at runtime. It is not placed in the container
environment.

Creating the remotely managed tunnel, assigning the public hostname, and configuring Cloudflare
Access policies remain explicit Cloudflare dashboard actions.
