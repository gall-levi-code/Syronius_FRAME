# FRAME Edge

FRAME Edge is the main local web entry point for FRAME.

It lets you open FRAME tools from one address, such as `http://localhost/dashboard`, and routes each
page to the right FRAME service.

## Who This Is For

FRAME Edge is for operators running the FRAME stack.

Use it if you want to:

- Open FRAME tools from one local address.
- Keep service URLs organized under simple paths.
- Use shared login on protected pages.
- Keep local management pages separate from public Hybrid access.
- Avoid remembering every individual service port.

## What You Use It For

Use FRAME Edge whenever you open FRAME in a browser.

Common paths:

| Path | Opens |
| --- | --- |
| `/dashboard` | FRAME Portal |
| `/status` | Portal status page |
| `/slsui` | Stream Management |
| `/overlays/setup` | Overlay Wizard |
| `/photos/upload` | Browser Photo Upload |
| `/gallery` or `/today/gallery` | Photo Gallery |
| `/today/dashboard` | Photo Stage dashboard |
| `/audio/admin` | Audio Monitor admin |
| `/audio/listen/...` | Audio Monitor listener pages |
| `/bridge/...` | Audio Bridge pages, when enabled |

## How To Install

FRAME Edge is part of the normal FRAME stack.

Recommended setup:

1. Open the FRAME folder.
2. Run `stack.cmd`.
3. Choose **Guided setup**.
4. Start the stack.
5. Open:

```text
http://localhost/dashboard
```

Most users should not run FRAME Edge by itself.

## How To Operate

Use `http://localhost/dashboard` as the normal starting point.

If you changed the FRAME Edge port during setup, use that port instead:

```text
http://localhost:<your-edge-port>/dashboard
```

If a page does not open:

- Make sure the related FRAME tool is enabled.
- Check Portal status.
- Confirm the stack is running.
- Check whether another app is already using the FRAME Edge port.
- Use `stack.cmd` to validate or restart the stack.

## Relies Upon

FRAME Edge relies on:

- FRAME Auth
- FRAME Portal
- FRAME Docker Proxy
- Enabled FRAME services
- The generated FRAME stack configuration

Optional connections:

| Feature | Relies Upon |
| --- | --- |
| Shared login | FRAME Auth |
| Public Hybrid access | FRAME Public Gateway and FRAME Tunnel |
| Tool routes | The related enabled FRAME service |

## Notes For Operators

Do not expose FRAME Edge directly to the public internet.

For public access, use FRAME Tunnel. Hybrid public traffic should go through FRAME Public Gateway,
which only forwards approved public routes.

Local admin, setup, capture, ingest, and management pages should stay local or login-protected.

FRAME Edge does not store your media or gallery data. It only routes browser requests to the right
FRAME service.
