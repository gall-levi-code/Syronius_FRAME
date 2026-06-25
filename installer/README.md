# FRAME Installer

The root `stack.cmd` and `stack.sh` entrypoints manage the FRAME appliance deployment. Both launch
the same dependency-free installer runtime through a pinned Node Docker image, then use the host's
Docker Compose v2 installation for container lifecycle commands.

## Current scope

The installer currently deploys the implemented FRAME services:

- `frame-edge`
- `frame-auth`
- `frame-public-gateway` (Hybrid only)
- `frame-tunnel` (Hybrid only)
- `frame-portal`
- `frame-audio`
- `frame-discord-audio-bridge`
- `frame-ingest-video`
- `frame-streams`
- `frame-overlays`
- `frame-pipeline-photos` (automatic internal dependency)
- `frame-photo-upload`
- `frame-photo-ftp`
- `frame-gallery`
- `frame-today`

Fresh installs enable the shared Edge and Portal only. Every optional capability is opt-in. Run
`stack.cmd` or `./stack.sh` without arguments in an interactive terminal to open the numbered FRAME
command center, or continue using direct commands for automation.

LAN HTTP routing is supported through FRAME Edge. HYBRID mode is staged through a remotely managed
Cloudflare Tunnel and a separate internal FRAME Public Gateway. The public gateway forwards only
the generated capability-aware allowlist; LAN-only admin, capture, ingest, and management routes
remain unavailable through the tunnel.

FRAME Edge also denies known LAN-only management routes when requests arrive through the configured
public hostname or Cloudflare headers. This defense-in-depth protects the stack if a remotely
managed Cloudflare Published application is accidentally pointed at FRAME Edge instead of
`http://frame-public-gateway:8080`.

The public gateway forwards the exact root path to Portal so the Portal can redirect `/` to
`/dashboard`. Stream Management links to Overlay Wizard with the relative `/overlays/setup` route,
keeping management navigation on whichever trusted LAN Edge origin opened SLSUI.

Current limitations:

- Host port conflicts are reported by Docker during `stack start`; an earlier preflight check is
  still planned.
- Data roots are repository-relative until cross-platform external-volume reset boundaries are
  defined.
- Photo `.ready` manifests use `FRAME_HOST_DATA_ROOT`; set it to the host-visible data directory
  before connecting host-side StreamerBot actions.

## Interactive command center

The no-argument command center guides both first-time and existing installations:

1. Existing installs show known setup issues first, with a choice to resolve only those issues or
   review everything.
2. Standard configuration covers deployment mode, hostname, Edge port, data path, timezone,
   capabilities, and relevant service basics.
3. Advanced configuration can edit any installer-whitelisted non-secret setting.
4. Secrets use hidden-input flows and never appear in command arguments or summaries.
5. Guided setup runs validation and verification, then explicitly offers to reconcile the complete
   Docker Compose stack.

The command center uses numbered prompts for broad terminal compatibility. Direct commands remain
stable and do not enter the menu.

## Commands

```powershell
.\stack.cmd
.\stack.cmd install
.\stack.cmd install --enable frame-audio-relay
.\stack.cmd install --enable frame-video-relay --enable frame-overlays
.\stack.cmd install --enable frame-photo-webupload --enable frame-photo-ftp
.\stack.cmd install --enable frame-photo-webupload --enable frame-photo-gallery
.\stack.cmd install --enable frame-photo-webupload --enable frame-photo-gallery --enable frame-photo-todaytools
.\stack.cmd install --host-data-root "D:\FRAME\data"
.\stack.cmd hybrid-stage
.\stack.cmd tunnel-token
.\stack.cmd portal-auth
.\stack.cmd discord-auth
.\stack.cmd validate
.\stack.cmd verify
.\stack.cmd start
.\stack.cmd status
.\stack.cmd logs frame-portal
.\stack.cmd stop
.\stack.cmd reset
```

Use `./stack.sh` with the same arguments on Linux/macOS.

Advanced automation can repeat `--set KEY=VALUE` for installer-whitelisted non-secret settings:

```powershell
.\stack.cmd install --set TIMEZONE=America/Chicago --set PHOTO_MAX_INPUT_MB=100
.\stack.cmd install --set PHOTO_UPLOAD_MAX_FILES=100 --set PHOTO_UPLOAD_MAX_SESSIONS=2
```

For host-side StreamerBot, set `--host-data-root` to the absolute host directory that backs
`FRAME_DATA_ROOT`, then watch `<host-data-root>\galleries` with subfolders included and process only
files whose names end exactly in `.ready`. Only newly published manifests receive a changed host
path; existing `.ready` files are never rewritten or replayed.

`verify` runs deterministic capability/route contract tests and JavaScript syntax checks, then
validates the generated Docker Compose configuration when it exists.

Re-running `install` preserves existing credentials and generated secrets. To migrate an existing
Audio Bridge configuration, place its ignored `.env` inside the repository and import it:

```powershell
.\stack.cmd install --import-env services/frame-audio-bridge/.env
```

The import accepts Audio Bridge settings only. It does not allow an imported file to replace
installer-owned mode, capability, port, or Portal security configuration.

## Shared portal login

Protected FRAME routes use `/auth/login` through FRAME Edge. A successful Portal login creates one
signed, `HttpOnly` session cookie for the current hostname and returns the browser to its original
URL. The session lasts seven days by default and unlocks all protected panels on that hostname.
Change `FRAME_AUTH_SESSION_DAYS` in `.env` to a value from 1 to 30, then restart the stack.

Public OBS viewers, gallery pages, overlay views, listener links, and tokenized Audio Bridge pages
do not require this shared login. Direct service ports retain their existing service-level
authentication behavior.

## Photo FTP credentials and persisted galleries

When `frame-photo-ftp` is enabled, `stack install` writes `PHOTO_FTP_USERNAME` and a generated
`PHOTO_FTP_PASSWORD` into the repository root `.env`. Re-running the installer preserves both
values. `PHOTO_FTP_MIN_PASSWORD_LENGTH` defaults to `5`; the interactive credential prompt uses
that configured minimum. The correct variable name is `PHOTO_FTP_USERNAME`; `PHOTO_FTP_USERNAEM` is
not recognized.

FTP daemon messages are bridged into `docker logs frame-photo-ftp`. When troubleshooting a camera
that connects but times out, temporarily set `PHOTO_FTP_VERBOSE_LOG=true`, restart the FTP service,
then return it to `false` after collecting logs.

The FTP credentials only authorize camera uploads. Published photos and Today/Gallery state live
under `FRAME_DATA_ROOT` (normally `./data`) and are not stored in the container image. Relaunch the
photo services through the generated Compose stack so these persistent mounts remain attached:

```powershell
.\stack.cmd start
```

Starting `frame-today` or `frame-gallery` directly from an image without the generated mounts
creates an empty view. `frame-today` requires the persisted `galleries` and `state` directories,
while `frame-gallery` requires `galleries`, its thumbnail cache, and `gallery-branding` for custom
style/logo settings.

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
External requests that miss the allowlist or receive a gateway/service error use shared FRAME error
pages instead of Traefik's bare default responses.

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
