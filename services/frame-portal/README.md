# FRAME Portal

FRAME Portal is the main dashboard for your FRAME setup. It shows which tools are enabled, what is
running, whether anything needs attention, and where to open each part of FRAME.

## Who This Is For

FRAME Portal is for anyone operating a FRAME install.

Use it if you want to:

- Open FRAME tools from one place.
- Check whether services are running.
- View basic health and storage warnings.
- Read service logs when something is not working.
- See which tools are ready, offline, disabled, or still need setup.

Most users should start here before opening individual FRAME tools directly.

## What You Use It For

Use Portal as the control room for FRAME.

Common uses:

- Open Stream Management, Overlays, Photo Upload, Gallery, Today tools, or Audio tools.
- Check whether FRAME containers are healthy.
- See disk space warnings before photo or video storage fills up.
- View live logs for troubleshooting.
- Restart services, if that option has been enabled by the operator.
- Confirm whether a tool is available locally only or safe to open through Hybrid/public access.

## How To Install

Portal is part of the normal FRAME stack.

Recommended setup:

1. Open the FRAME folder.
2. Run `stack.cmd`.
3. Choose **Guided setup**.
4. Finish setup and start the stack.
5. Open Portal:

```text
http://localhost/dashboard
```

For standalone testing only:

1. Open this folder:

```text
services/frame-portal
```

2. Copy `.env.example` to `.env`.
3. Start Portal:

```bash
docker compose up --build -d
```

4. Open:

```text
http://localhost:3730/dashboard
```

Most users should use the full FRAME stack instead of standalone mode.

## How To Operate

Open Portal:

```text
http://localhost/dashboard
```

Use the dashboard to open enabled FRAME tools.

Use the status page to check the stack:

```text
http://localhost/status
```

Status labels mean:

| Status | Meaning |
| --- | --- |
| Ready | The tool is running and available. |
| Needs setup | The tool is enabled but still needs configuration. |
| Offline | The tool is expected, but not currently running. |
| Disabled | The tool is not enabled in this FRAME setup. |

If something is not working:

1. Open **Status**.
2. Check whether the related service is offline or unhealthy.
3. Open its logs.
4. Fix the setup issue shown in the logs.
5. Restart the stack from `stack.cmd` if needed.

Portal does not delete your FRAME data. It only reports storage warnings.

## Relies Upon

Portal relies on:

- Docker Desktop
- The FRAME stack
- FRAME Edge for the normal `http://localhost/dashboard` route
- FRAME Auth when shared login is enabled
- The generated FRAME stack configuration
- Docker status access for health checks and logs

Optional connections:

| Feature | Relies Upon |
| --- | --- |
| Audio Bridge status | FRAME Audio Bridge |
| Public or Hybrid dashboard access | FRAME Edge, FRAME Auth, FRAME Tunnel |
| Restart buttons | Operator-enabled restart access |

## Notes For Operators

Portal login is optional for local-only use and recommended whenever other people can reach the
FRAME computer or network.

In Hybrid/public setups, protect Portal with a login.

Restart buttons are disabled by default. Only enable them on trusted systems, because they allow
Portal to restart FRAME services.

Portal shows storage warnings, but it does not automatically clean old photos, galleries, audio, or
video files.
