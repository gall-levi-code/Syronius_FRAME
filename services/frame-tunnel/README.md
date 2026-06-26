# FRAME Tunnel

FRAME Tunnel is the optional public access connector for FRAME Hybrid mode.

It gives selected FRAME pages a public Cloudflare Tunnel address while keeping local admin, capture,
ingest, and setup pages off the public internet.

## Who This Is For

FRAME Tunnel is for experienced users who want public access without managing router port forwards.

Use it if you want to:

- Give guests an external photo upload link.
- Share a public gallery or Photo Stage link.
- Share approved public listener, viewer, or OBS links.
- Use Cloudflare Tunnel as the public entry point for FRAME.
- Keep management pages local while exposing only selected public pages.

## What You Use It For

Use FRAME Tunnel when people outside your local network need to reach part of FRAME.

Common uses:

- Public browser photo uploads.
- Public photo gallery access.
- Photo Stage viewer access.
- Audio Monitor listener links.
- Audio Bridge OBS links, when enabled.
- Public overlay viewer links, when enabled.

FRAME Tunnel does not make every FRAME page public. FRAME still uses a public-route allowlist.

## How To Install

FRAME Tunnel is part of FRAME Hybrid mode.

Recommended setup:

```powershell
.\stack.cmd hybrid-stage
.\stack.cmd tunnel-token
.\stack.cmd portal-auth
.\stack.cmd validate --for-start
.\stack.cmd start
```

During setup:

1. Run Hybrid staging and enter the public hostname you want to use.
2. Create a remotely managed Cloudflare Tunnel in Cloudflare.
3. In Cloudflare, point the public hostname to:

```text
Type: HTTP
URL: frame-public-gateway:8080
```

4. Copy the tunnel token from Cloudflare's connector install command.
5. Run `.\stack.cmd tunnel-token` and paste only the token value.
6. Run `.\stack.cmd portal-auth` to set the required Portal login.
7. Validate and start the stack.

Do not point Cloudflare directly at the full FRAME Edge service.

## How To Operate

Use your Cloudflare public hostname for public links.

Use local FRAME addresses for admin, setup, capture, ingest, and management pages.

If a public page does not load, check that:

- The related FRAME tool is enabled.
- Hybrid mode was staged after enabling that tool.
- The Cloudflare hostname points to `frame-public-gateway:8080`.
- The tunnel token was saved with `tunnel-token`.
- Portal auth was configured.

If Cloudflare gives you a new tunnel token, run `.\stack.cmd tunnel-token` again and restart FRAME.

## Relies Upon

FRAME Tunnel relies on:

- Cloudflare
- A remotely managed Cloudflare Tunnel
- A public hostname in Cloudflare
- FRAME Portal
- FRAME Edge
- FRAME Public Gateway
- Enabled FRAME tools with public routes

Optional connections:

| Feature | Relies Upon |
| --- | --- |
| Public photo upload | FRAME Photo Upload |
| Public gallery | FRAME Photo Gallery |
| Photo Stage links | FRAME Photo Stage |
| Audio listener links | FRAME Audio Monitor |
| Discord Audio Bridge links | FRAME Audio Bridge |
| Public overlay viewers | FRAME Overlays |

## Notes For Operators

FRAME Tunnel is for public access. It is not needed for LAN-only FRAME use.

The tunnel token is private. Treat it like a password.

FRAME keeps a local public-route allowlist. This helps prevent admin and setup pages from being
exposed by mistake.

Cloudflare Tunnel must support WebSockets for Audio Bridge and other live pages.

Public access should still be tested after setup. Open the public hostname from outside your LAN and
confirm only the pages you expect are reachable.

## Optional Cloudflare Worker Offline Shield

For OBS overlays, Audio Bridge sources, or other browser sources, you may want a Cloudflare Worker in
front of the tunnel.

This prevents OBS from showing a Cloudflare tunnel error page when the FRAME tunnel is offline.
Instead, the Worker returns a blank response so the source stays invisible until FRAME comes back.

Use two hostnames:

| Hostname | What It Is |
| --- | --- |
| `frame.example.com` | Public hostname users share or put into OBS. This points to the Worker. |
| `frame-origin.example.com` | Tunnel/origin hostname. This points to the Cloudflare Tunnel. |

Use your own domain names. Do not use the examples above directly.

In Cloudflare Tunnel, point the origin hostname to:

```text
Type: HTTP
URL: frame-public-gateway:8080
```

In the Worker, set a variable named `ORIGIN_HOST` to your tunnel/origin hostname:

```text
ORIGIN_HOST=frame-origin.example.com
```

The Worker hostname and `ORIGIN_HOST` must be different. If they are the same, the Worker can loop
back into itself.

Example Worker:

```js
const OFFLINE_STATUSES = new Set([
  502, 503, 504,
  520, 521, 522, 523, 524,
  530,
]);

export default {
  async fetch(request, env) {
    if (!env.ORIGIN_HOST) {
      return offlineResponse(request);
    }

    const originUrl = new URL(request.url);
    originUrl.hostname = env.ORIGIN_HOST;
    originUrl.protocol = "https:";

    try {
      const originRequest = new Request(originUrl.toString(), request);
      const response = await fetch(originRequest);

      if (OFFLINE_STATUSES.has(response.status)) {
        response.body?.cancel?.();
        return offlineResponse(request);
      }

      return response;
    } catch {
      return offlineResponse(request);
    }
  },
};

function offlineResponse(request) {
  const isWebSocket = request.headers.get("upgrade")?.toLowerCase() === "websocket";

  return new Response(null, {
    status: isWebSocket ? 503 : 204,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
```
