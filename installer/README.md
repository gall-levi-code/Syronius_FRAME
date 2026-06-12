# FRAME Installer

The root `stack.cmd` and `stack.sh` entrypoints manage the FRAME appliance deployment. Both launch
the same dependency-free installer runtime through a pinned Node Docker image, then use the host's
Docker Compose v2 installation for container lifecycle commands.

## Current scope

The installer currently deploys the implemented FRAME services:

- `frame-edge`
- `frame-public-gateway` (Hybrid only)
- `frame-tunnel` (Hybrid only)
- `frame-portal`
- `frame-audio`
- `frame-discord-audio-bridge`
- `frame-ingest-video`
- `frame-streams`
- `frame-overlays`

Fresh installs enable the shared Edge and Portal only. Every optional capability is opt-in and must
be explicitly enabled with `stack install --enable <capability>`.

LAN HTTP routing is supported through FRAME Edge. HYBRID mode is staged through a remotely managed
Cloudflare Tunnel and a separate internal FRAME Public Gateway. The public gateway forwards only
the generated capability-aware allowlist; LAN-only admin, capture, ingest, and management routes
remain unavailable through the tunnel.

Current limitations:

- Host port conflicts are reported by Docker during `stack start`; an earlier preflight check is
  still planned.
- Data roots are repository-relative until cross-platform external-volume reset boundaries are
  defined.

## Commands

```powershell
.\stack.cmd install
.\stack.cmd install --enable frame-audio-relay
.\stack.cmd install --enable frame-video-relay --enable frame-overlays
.\stack.cmd hybrid-stage
.\stack.cmd validate
.\stack.cmd verify
.\stack.cmd start
.\stack.cmd status
.\stack.cmd logs frame-portal
.\stack.cmd stop
.\stack.cmd reset
```

Use `./stack.sh` with the same arguments on Linux/macOS.

`verify` runs deterministic capability/route contract tests and JavaScript syntax checks, then
validates the generated Docker Compose configuration when it exists.

Re-running `install` preserves existing credentials and generated secrets. To migrate an existing
Audio Bridge configuration, place its ignored `.env` inside the repository and import it:

```powershell
.\stack.cmd install --import-env services/frame-audio-bridge/.env
```

The import accepts Audio Bridge settings only. It does not allow an imported file to replace
installer-owned mode, capability, port, or Portal security configuration.

## Staging Hybrid mode

Run `stack.cmd hybrid-stage` or `./stack.sh hybrid-stage`. The installer asks for the public
hostname, generates the Hybrid route allowlist, and enables the Hybrid Compose profile without
starting it.

Before `stack start` will proceed:

1. Create a remotely managed `cloudflared` tunnel in Cloudflare.
2. In its Published applications tab, add the staged hostname with service type **HTTP** and URL
   `frame-public-gateway:8080`.
3. Run `stack.cmd tunnel-token` or `./stack.sh tunnel-token` and paste the token from Cloudflare's
   connector install command. Store only the `eyJ...` token, not the entire command.
4. Run `stack.cmd portal-auth` or `./stack.sh portal-auth` to set the required Portal credentials.
5. Run `stack validate --for-start`, then `stack start`.

Both credential commands hide typed input. The tunnel token is mounted into `frame-tunnel` as a read-only file and is not stored in container
environment variables. Cloudflare Tunnel supports WebSockets, which are required by Audio Bridge.
The generated `public-routes.yml` remains the final local allowlist even if the Cloudflare
Published application route is broad.

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
- `/data/state/cloudflared-ingress.yml` - reference Cloudflare ingress for the staged hostname
- `/data/state/public-routes.yml` - effective public-route allowlist consumed by FRAME Public Gateway
- `/data/state/cloudflare-tunnel-token` - user-supplied remotely managed tunnel token

Generated files and `/data` are ignored by Git. Configuration files are written atomically.

## Safety behavior

- `stack start` refuses to launch an enabled Audio Bridge with placeholder Discord credentials.
- `stack start` waits for enabled services to report healthy and fails after a bounded timeout.
- Hybrid startup is refused until its hostname, tunnel token, and Portal credentials are configured.
- Hybrid public traffic passes through an internal-only allowlist gateway before FRAME Edge.
- Optional services are disabled on fresh installs until explicitly enabled.
- Traefik discovers only services explicitly labeled for FRAME Edge.
- Disabling a capability never removes its data.
- `stack reset` requires explicit confirmation and can only remove the repository-relative FRAME
  data root.
- Status output never prints secrets.
- The receiver management API key is generated once and shared with management services without
  being exposed in either browser UI.
