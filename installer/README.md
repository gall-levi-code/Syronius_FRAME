# FRAME Installer

The root `stack.cmd` and `stack.sh` entrypoints manage the FRAME appliance deployment. Both launch
the same dependency-free installer runtime through a pinned Node Docker image, then use the host's
Docker Compose v2 installation for container lifecycle commands.

## Current scope

The installer currently deploys the implemented FRAME services:

- `frame-portal`
- `frame-discord-audio-bridge`

LAN mode is fully supported. HYBRID mode is deliberately refused until the shared Traefik and
Cloudflare Tunnel edge exists; the installer will not claim that routes are protected or available
when that edge is absent.

Current limitations:

- Host port conflicts are reported by Docker during `stack start`; an earlier preflight check is
  still planned.
- Data roots are repository-relative until cross-platform external-volume reset boundaries are
  defined.

## Commands

```powershell
.\stack.cmd install
.\stack.cmd validate
.\stack.cmd start
.\stack.cmd status
.\stack.cmd logs frame-portal
.\stack.cmd stop
.\stack.cmd reset
```

Use `./stack.sh` with the same arguments on Linux/macOS.

Re-running `install` preserves existing credentials and generated secrets. To migrate an existing
Audio Bridge configuration, place its ignored `.env` inside the repository and import it:

```powershell
.\stack.cmd install --import-env services/frame-audio-bridge/.env
```

The import accepts Audio Bridge settings only. It does not allow an imported file to replace
installer-owned mode, capability, port, or Portal security configuration.

## Migrating standalone services

Before the unified stack's first start, stop standalone FRAME Compose deployments so their fixed
container names and host ports do not conflict.

An existing Audio Bridge's `/data` contains the guild configurations and permanent link keys. Copy
it into the unified data root before replacing the standalone container:

```powershell
docker stop frame-audio-bridge
docker cp frame-audio-bridge:/data/. ./data/audio-bridge/
docker start frame-audio-bridge
```

After verifying the copy, stop the standalone deployment and run `stack start`. Do not delete the
standalone volume until the unified Audio Bridge has been tested and its permanent URLs still work.

## Generated files

- `/.env` - stack settings and secrets
- `/docker-compose.yml` - complete deployment for implemented services
- `/data/state/stack-config.json` - canonical capability and route configuration
- `/data/state/effective-public-prefixes.json` - effective public exposure; empty in LAN mode
- `/data/state/cloudflared-ingress.yml` - LAN-safe catch-all until Hybrid support exists

Generated files and `/data` are ignored by Git. Configuration files are written atomically.

## Safety behavior

- `stack start` refuses to launch an enabled Audio Bridge with placeholder Discord credentials.
- `stack start` waits for enabled services to report healthy and fails after a bounded timeout.
- Unsupported capabilities and HYBRID mode are rejected rather than silently ignored.
- Disabling a capability never removes its data.
- `stack reset` requires explicit confirmation and can only remove the repository-relative FRAME
  data root.
- Status output never prints secrets.
