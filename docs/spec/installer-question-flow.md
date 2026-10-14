# FRAME installer question flow

Status: proposed interaction specification, updated 2026-09-30. This follows the
[guided setup assessment](../installer-guided-setup-assessment.md). It describes the next interface
revision; it does not claim these screens or recovery features are implemented.

## Rules shared by all paths

- Run host checks immediately. Show specific readiness results and a Recheck action. Do not start
  deployment until required checks pass; do not discard a draft when a check fails.
- Ask about intended use before technical configuration. Only selected branches contribute questions.
- Use the existing service registry, configuration generator, and resolved Compose bindings. Do not
  maintain another independent dependency or default-port list in the question flow.
- Save partial non-secret answers automatically. Restore answers, never a passed-preflight flag.
  Credentials stay transient until applied to the deployment; ask for them again after resuming.
- Use one Back/Continue footer. Required information and all choices for the current question stay
  visible together. Long optional explanations and diagnostic output have separate detail views.
- A choice affecting data retention, public exposure, or required accounts gets a plain-language
  explanation. A default does not justify hiding its consequences.
- Reuse the existing validators in every mode. Advanced skips explanations, not checks.
- Local service health, working device connections, and public reachability are separate results.
- Background environmental/network-change tracking is intentionally out of scope. Keep explicit
  prerequisite checks, Recheck actions, final deployment validation, and service-health reporting.

## Confirmed operating policy

Agreed 2026-09-18: users can enable or disable FRAME. An enabled installation should recover after
reboot without operating-system automatic sign-in; a deliberately disabled installation stays
disabled. Users install/configure Docker themselves, with contextual instructions from FRAME Setup.
One installation should serve their selected needs. For this revision, support one FRAME deployment
per local Docker engine and direct returning users to that deployment rather than creating copies.

| Action or state | Required behavior |
| --- | --- |
| Enable FRAME | Resume installed services from local pinned images, check readiness, and report the actual result. Routine enable must not pull images, rebuild, or update FRAME. Missing deployment resources require a repair action. |
| Disable FRAME | Gracefully stop the owned FRAME containers, preserve configuration/data and deployment identity, and leave Docker and unrelated workloads running. Stay disabled across engine/host restarts. |
| Close FRAME Setup | Leave the installation's running/stopped state unchanged. The GUI need not remain open for container restart behavior. |
| Docker unavailable | Show the specific prerequisite problem and last known state with its age. Do not infer that FRAME was deliberately disabled. |
| Partial or unhealthy deployment | Identify affected services and offer the applicable retry/repair. Do not report success merely because containers exist or accept a failed stop as fully disabled. |

The Compose template already uses `restart: unless-stopped`. Reuse Docker's container restart
mechanism; the installer must not register an unconditional boot-time `compose up` that reverses a
user's Disable action. Restart after a container exits is distinct from handling a process that stays
running but fails its health check. [Docker restart policy reference](https://docs.docker.com/engine/containers/start-containers-automatically/)

Current wrapper commands need care: `stack stop` uses `compose down`, removing containers/networks,
and `stack start` performs deployment reconciliation including image pulls. Routine Enable/Disable
needs a resume/stop path retaining containers; keep install/update/reconfiguration and deliberate
service removal separate. Inspect actual state after failures before offering another action.

### Docker startup compatibility

Report current Docker readiness separately from its ability to recover before sign-in. A running
engine or enabled startup setting is not proof of a successful unattended reboot.

| Environment | Guidance and remaining verification |
| --- | --- |
| Native Linux Docker Engine managed as a system service | Docker documents enabling `docker.service` and `containerd.service` at boot. This provides a pre-login startup path. Verify the deployment's storage, network, service readiness, and recovery on the actual host. Do not infer the same behavior for every rootless or desktop setup. |
| Windows Docker Desktop running FRAME's Linux containers | Docker documents automatic startup at user sign-in. Its privileged helper can start earlier in some configurations, but helper startup is not proof that the Linux engine and FRAME are running. The standard sign-in option does not establish the requested pre-login recovery guarantee. |
| Unrecognized or untested configuration | Show startup behavior as unverified with the specific guidance still needed. Do not label it ready for unattended recovery. |

Sources checked 2026-09-18: [Linux Engine boot configuration](https://docs.docker.com/engine/install/linux-postinstall/#configure-docker-to-start-on-boot-with-systemd),
[Desktop startup settings](https://docs.docker.com/desktop/settings-and-maintenance/settings/#general),
and [Windows privileged helper behavior](https://docs.docker.com/desktop/setup/install/windows-permission-requirements/).

The no-automatic-sign-in requirement remains in force. A supported Windows pre-login Linux-container
runtime is an unresolved compatibility task, not a reason to silently redefine recovery as
"after somebody signs in." Do not configure automatic sign-in or collect Windows credentials.
Show this limitation during the early host check and in My FRAME Setup. Docker installation and
host startup configuration remain user-managed; offer instructions, preserve progress, and Recheck.

Portal access on the FRAME host uses `http://localhost/dashboard`, with the configured Edge port
when it is not 80: `http://localhost:<configured-port>/dashboard`. Other devices use the host's
explicit LAN IP address or a DNS name configured and maintained by the user, with the same port
and route. FRAME does not publish LAN hostnames or install a discovery watchdog. Verify LAN access
and boot-time storage/network availability through explicit acceptance checks; container recovery
alone does not establish that another device can reach FRAME.

## Entry and returning users

| Screen | Exact heading / content | Actions and continuation |
| --- | --- | --- |
| Host check | **Let's check this computer.** Show operating-system support, Docker access/engine, and Compose readiness separately. | Recheck failed prerequisites; expandable details. Existing draft remains available. |
| Saved draft | **Continue your FRAME setup?** Show last saved date, location if chosen, and last topic. | Continue setup / Start a new setup. Discarding a draft does not delete installed files. |
| Interrupted operation | **FRAME was still being installed.** Inspect the owned operation, deployment snapshot, files, and Docker state. | If still running, show progress without starting another operation. If stopped, offer the applicable recovery action. Never infer that a pending snapshot means the process stopped. |
| Existing installation | **What would you like to do with this installation?** Show version, location, Running/Disabled/Needs attention/Docker unavailable, and startup behavior. | Enable or Disable FRAME as appropriate / Open FRAME / View my setup / Change settings / Recover when applicable. Updating FRAME is a separate explicit action from changing settings. |
| New setup path | **How would you like to set up FRAME?** Quick Start: recommended local tools and defaults. Guided: answer questions about what you need. Advanced: choose features and settings directly. | Require one choice. No feature/configuration changes merely from opening this page. |

For reconfiguration, start from the applied configuration. Changing the amount of guidance must not
reset installed ports, credentials, storage, or exposure. Quick Start defaults apply to a fresh setup.
Discover running and stopped FRAME containers and reconcile their ownership with installed files
before offering a new deployment. The fixed Compose project/container names make a second folder
unsafe even when every port is free. Do not adopt or replace another folder's deployment implicitly;
show its location when known and offer to manage it. The per-user installer registry alone is not
sufficient evidence that this engine has no FRAME installation.
When switching a fresh custom/Hybrid draft to Quick, explain the reset of technical choices and
apply the local preset deliberately. Do not silently carry Hybrid/custom ports into Quick.

### Storage and Docker readiness

Internal disks and attached USB drives are valid data-folder choices when writable and accessible
to Docker. Warn about network/NAS availability and performance without rejecting the choice solely
because it is network storage. Keep installed data paths fixed; a missing existing folder/drive,
unwritable location, or zero available space blocks setup or Start. Less than 10 GiB available is an
advisory warning that permits continuation, not a measured installation minimum or a sufficiency
guarantee. Run checks on explicit setup/readiness and Start actions, without an environment watcher.

Show Docker image capacity separately from deployment and media/data space. Measure available image
capacity only for a known accessible classic image store on the same native Linux host. Docker
Desktop, containerd, and unknown layouts show **Docker image capacity not verified**, with guidance
to Docker's storage settings or the Linux engine's configured image-storage location. Free space on
the selected host data drive cannot verify a Docker VM's free space. Current release manifests have
no measured image requirements; warn that required space is unknown and never invent a GB minimum.
Architecture-specific, image-bound measurements for selected tools and shared dependencies remain
future release acceptance work.

Distinguish missing Docker CLI/Compose, stopped engine, denied access, incompatible engine/socket,
and occupied ports. Support standard Docker Desktop Linux engines and standard native Linux Engine;
rootless Docker and custom socket layouts are currently unsupported. Give corrective guidance and
Recheck without changing Docker permissions or configuration automatically.

## Quick Start

Order: host check -> path -> included tools -> storage -> local connection if needed -> FRAME login
-> review/check -> installation -> My FRAME Setup.

| Screen | Question / visible content | Defaults and behavior |
| --- | --- | --- |
| Included tools | **Your local FRAME setup.** Compact list: Video Relay, Overlays, Audio Monitor, Camera FTP, Browser Photo Upload, Photo Gallery, Photo Stage. | All seven enabled. Default ports. Local deployment. No Belabox choice, credential form, or disabled promotional card. Audio capture starts on this computer. |
| Storage | **Where should FRAME keep your installation and photos?** Folder picker and a short description of the data subfolder. | Explain that Docker image storage is separate. Check access/space immediately. Disclose the default original-backup retention of 14 days; published Gallery photos are not deleted by this policy. |
| Local connection | **Which address should your cameras use?** Show the suggested Ethernet/Wi-Fi address with its connection name. | One unambiguous usable address can be included as a confirmation on review. Multiple candidates require a short choice page. No loopback, Docker, or VPN address presented as a reliable camera address without context. |
| FRAME login | **Create your FRAME login.** Username, password, confirmation. | Explain this protects FRAME operator pages. Retain backend validation; confirmation is a UI typo check. No unrelated integration credentials. |
| Review | **Ready to install FRAME locally.** Features, location, local address, retention, default-port status, and prerequisite results. | Install remains locked until current checks pass. No new setup questions here. |

No ordinary port-editing screen. If a required default is unavailable, stop on a focused conflict
page with the affected feature, protocol/port, known owner, and corrective action. Recheck or make an
explicit supported port change; a chosen exception must be reflected in review and the final report.
Do not silently pick a different port or require a full Advanced walkthrough to fix one conflict.

## Guided opening

Heading: **What would you like FRAME to do?**

All four choices are visible at once, independently selectable:

| Choice | One-sentence description / visible prerequisite |
| --- | --- |
| Video streaming and overlays | Receive an encoder feed and optionally show stream statistics in OBS. |
| Photos | Receive photos, browse albums, or show photos live in OBS. |
| Audio Monitor | Capture audio on this computer and create listening links. |
| Remote Belabox management | Control a roaming Belabox. Requires Hybrid access, a domain on Cloudflare, and a tunnel. |

Continue requires at least one selected need. Unselected branches are skipped. Selecting a feature
that requires another includes the companion with a visible explanation. If a companion has multiple
valid alternatives, ask instead of choosing silently. Removing a required companion explains the
affected selection before changing it. Keep unrelated answers when a branch is removed.

Recommended order: selected feature questions -> remote web prerequisites when needed -> storage
and retention -> local addresses still needed -> FRAME login -> review/check -> deployment -> summary.
Show external-account requirements on selection even when their detailed steps occur later.

## Guided branch screens

### Video streaming and overlays

| ID | Question | Choices / behavior |
| --- | --- | --- |
| video.location | **Where will your encoder connect from?** | Same network / Over the internet / Both. Select Video Relay. An internet encoder does not by itself enable Hybrid. |
| video.destination | **What address will your remote encoder use?** Only for internet/both. | Public IP or hostname field. Explain that the video receiver needs its own reachable UDP path. Router setup may remain a clearly marked next step; no local check proves forwarding works. |
| video.overlays | **Would you like stream statistics in OBS?** | Yes, include Overlays / No, just the relay. Explain that current Overlays uses Video Relay. Actual styling and OBS links come after startup. |

Local encoder instructions use the chosen LAN address, not localhost. An encoder and OBS running on
the FRAME host may use an appropriate local address. Do not reuse the Cloudflare web hostname as a
video destination merely because Hybrid is enabled.

Compatibility detail: current generation/validation requires a non-localhost relay host whenever
Video Relay and Hybrid are enabled together, even if video stays on the LAN. Supply the confirmed
LAN relay address for that case and correct the UI's implication that it must be an internet address.
Do not make the user invent a public video destination to enable remote web features. Revisit the
validator only where it prevents the supported local-video intent; keep internet-video requirements
driven by the encoder-location answer.

### Photos

| ID | Question | Choices / behavior |
| --- | --- | --- |
| photos.input | **How will photos arrive?** | Camera FTP / Browser upload / Both. Show that camera FTP requires configuring the camera after installation. |
| photos.output | **What would you like to do with your photos?** | Keep received files / Browse albums / Show photos live in OBS. State that live OBS presentation includes Gallery. The selected input remains required. |
| photos.retention | **How long should FRAME keep original photo backups?** At the storage topic. | 14 days (default) / 30 days / Until I remove them. Explain that these are original backups, not the published Gallery photos. Map to the existing retention setting. |
| photos.address | **Which address should your cameras use?** Only for FTP and when unresolved. | Detected usable LAN addresses plus manual entry. Recommend a router address reservation. Keep passive ranges and session limits in Advanced. |

Respect the existing FTP address contract: a usable IPv4 address or DNS name; IPv6 and loopback
are currently unsupported. Filter suggestions accordingly and explain an unavailable local address.

The photo workflow in Guided assumes camera FTP on the local network. Remote browser uploads can
use the supported Hybrid route. Do not imply the web tunnel transports camera FTP. Custom remote FTP
network arrangements need Advanced guidance and are outside the automatic tunnel path.

The runtime generates the FTP password. Completion must provide a protected way to view/change/copy
the camera credentials, or link to a confirmed working protected screen. This is an implementation
requirement to verify; a secret-free PDF alone cannot finish camera configuration. Never print the
password in the report or diagnostic export.

### Audio Monitor

| ID | Question | Choices / behavior |
| --- | --- | --- |
| monitor.capture | **Where will you capture audio?** | This FRAME computer (recommended) / Another device (requires separate secure setup). |
| monitor.capture-help | **Capture from another device needs HTTPS.** Only for another device. | Explain that the standard Hybrid tunnel does not publish capture/admin routes. Offer Use this FRAME computer / Configure secure access separately / Leave Audio Monitor for later. The separate-setup choice remains an explicit pending next step, never verified capture. |
| monitor.listeners | **Who needs a listening link?** | People on this network / People outside this network / Both. Outside/both requires the remote web branch for the supported installer-managed path. |

Device permissions, mixer/virtual-cable selection, and a listening test
belong in the running Audio Monitor. A secure capture arrangement must not be represented as an
automatic feature of Advanced or Cloudflare.

### Remote Belabox management

Heading: **Prepare remote Belabox access.** Explain that a device agent will connect back to FRAME
through the supported public WSS route. Choices: Set up remote access / Set up Belabox later.

The first choice makes Hybrid mandatory and enters the remote web branch. The second removes the
manager from active selection and records the deferred task. If no active features remain, return
to needs selection rather than continuing to an empty installation. Agent pairing/install remains
a post-startup task; successful Docker health does not prove the device is connected.

## Remote web branch

| ID | Question | Choices / behavior |
| --- | --- | --- |
| web.access | **Do you need FRAME web features outside this network?** | Local access only / Set up remote access with Cloudflare. Show for relevant Guided selections; remote listeners and Belabox carry a visible requirement. Deferring required remote access also defers Belabox and remote use, not unrelated local features. |
| web.scope | **These FRAME routes will be reachable through the tunnel.** | Show the actual route groups for selected capabilities plus shared portal routes. Explain existing login/link protection. Continue / Keep this installation local. |
| domain.state | **Where are you with your domain?** | Already active on Cloudflare / Registered elsewhere / I need a domain. No tunnel-token field yet. |
| domain.prepare | **Prepare your domain on Cloudflare.** | Contextual instructions and provider links. Preserve existing DNS records. Show Waiting for activation as a resumable state; Recheck / Save and close / Continue locally. |
| tunnel.state | **Do you already have a Cloudflare tunnel for FRAME?** | Use an existing tunnel / Help me create one. |
| tunnel.route | **Connect your public address to FRAME.** | Public hostname and exact prescribed origin `http://frame-public-gateway:8080`, with copy actions. Existing and new tunnel paths converge here. |
| tunnel.token | **Add the tunnel connector token.** | One masked token field with retrieval guidance. Explain that FRAME runs the connector; the user need not launch a second host connector for this installation. |

Current Hybrid configuration derives approved public routes from all enabled capabilities. It has
no per-feature remote exposure preference. Do not present independent public/private checkboxes that
the backend cannot honor. Selective exposure is a separate future change, not implied by this flow.
The current contract forbids public audio capture/admin, overlay setup/API, Belabox API/assets,
pipeline, and SLSUI routes. Reuse the contract to generate the scope explanation.

A domain/hostname syntax check and DNS observation do not prove account control or Cloudflare zone
activation. Without an authorized account API integration, label user-confirmed dashboard readiness
and observable DNS findings honestly. Tunnel token checks cannot prove the configured public route.
After startup, test the actual supported routes and report inaccessible/unverified results separately.

Domain registration automation and Cloudflare account API integration are outside this revision.
Use the verified provider references in the assessment; free-domain approval or DNS waiting time
must never prevent saving a draft. Continuing locally shows which requested remote capabilities
will be deferred before applying that choice.

## Advanced path

Use one compact checklist of all eight implemented capabilities with immediate dependency messages.
Show technical service IDs only in details. Use named configuration pages rather than the long
environment-reference map currently embedded in Review:

1. Features.
2. Storage and retention.
3. Network and ports (active bindings only).
4. Accounts and integrations (selected services only, split into short pages as needed).
5. Service limits (only supported editable settings for selected services).
6. Review/check, then deployment and My FRAME Setup.

Use defaults for omitted values, but preserve values loaded from an existing deployment. Mark
generated/reference-only values clearly. No unsupported editable field or generic `.env` editor.
All deployment checks, missing-credential handling, and recovery behavior remain shared.

## Review, deployment, and completion

Review contains a short plan and prerequisite summary, with Edit links back to topics. It asks no
new questions. Full port/reference tables belong in details and the completion report. Fresh
validation is mandatory after relevant edits, resume, or an earlier check failure and immediately
before deployment.

Deployment shows named phases: preparing release/configuration, downloading images, applying the
deployment, starting services, checking health, and recovery when needed. Do not invent a percentage
for phases with no measurable total. Safe cancellation and interruption handling must follow the
backend operation state rather than just closing the window.

Completion heading: **My FRAME Setup**. Actions: Open FRAME dashboard / Save setup PDF / Finish.
Show installed version/features, local/device/public addresses, paths, active ports/protocols,
forwarding instructions relevant to this use, completed/pending checks, and selected-feature next
steps. Exclude credentials and token-bearing links. Provide printable notes space and a report date.
Rebuild the report from applied state on later visits. Export failure leaves deployment success intact.
Include Enable/Disable instructions, actual Docker startup limitations, tested access paths, and whether
recovery without sign-in has been tested. Preserve the distinction between configuration and verification.

Derive links from the actual routing/exposure contract, not only a feature's default local route.
In particular, a Hybrid Gallery-only installation needs the approved `/gallery` route; the registry's
local `/today/gallery` entry is not publicly reachable unless Photo Stage also enables `/today`.

Use **Installed locally; remote access needs attention** when local services work but the public
route fails. Retry the failed remote check or guide correction; do not reinstall a healthy stack.
Use **Installed; device setup remaining** for untested camera, encoder, audio, or Belabox connections.
Only describe a workflow as verified after the corresponding functional test actually succeeded.

## Screen and state acceptance

- All ordinary question choices, prerequisites, current errors, and the shared footer fit at normal
  text scale in the supported default/minimum window. Clamp the initial window to desktop work area.
- Replace the wide sidebar with a compact progress header before stacking content into tall pages.
  Show topic and within-topic progress; avoid misleading fixed step counts before branches are known.
- At 200% text zoom use an accessible vertical-scroll fallback. Never clip controls or shrink text.
- Back preserves answers; switching a feature recomputes relevant questions and readiness. Deferred
  intent is distinct from active selection. Do not let hidden stale credentials or answers enable a feature.
- Resume retains non-secret answers and rechecks the environment. Test a still-running orphaned
  deployment, stopped interrupted deployment, failed recovery, and success before registry write.
- Exercise Quick, each Guided branch alone, all compatible branches together, Advanced, and existing
  installation changes. Verify dependencies against the registry and summary against applied state.
- Test pending domain activation, occupied defaults, changed ports
  after validation, failed downloads, service health failure, remote route failure, and PDF failure.
- Verify storage warnings permit continuation for NAS and less than 10 GiB free, while zero space,
  unwritable locations, and missing existing drives block the operation. Check that Desktop and
  containerd image capacity remains unverified even when the host data folder has ample space.
- Reject a second deployment folder when another FRAME deployment exists, including when all its
  containers are stopped or the current user's installer registry is empty.
- On a supported boot-capable host, test enabled -> reboot without sign-in -> healthy services from
  another device; disabled -> reboot -> still stopped. Verify host-local and explicit LAN-IP access
  separately.
- Test offline Enable/Disable with installed images, GUI close while running, process crash versus
  unhealthy-but-running services, delayed network/storage, and failed/partial lifecycle operations.
  Preserve data and unrelated workloads. Reboot tests are an explicit manual acceptance step, never
  a reason for the installer to reboot the user's machine automatically.

## Implementation order

1. Guard deployment ownership across running and stopped containers; add durable non-secret drafts
   and safe interrupted-operation reconciliation using existing snapshots/recovery. Provide returning
   users with Enable/Disable and accurate state. Improve prerequisite guidance, including the
   unresolved Windows pre-login startup requirement, without automating Docker installation.
2. Shared question navigation, fresh Quick defaults, compact responsive layout, and conditional Guided
   branches. Preserve existing configuration when editing an installation.
3. Move credentials to their branches, disclose dependencies/exposure, and add resumable domain/tunnel
   assistance. Keep outside-account steps explicit and verifiable.
4. Replace stale `/setup` handoff with `/dashboard`; implement the applied-configuration summary,
   safe camera-credential handoff, and native PDF export.

The companion interactive preview demonstrates navigation and layout only. Its checks, examples,
credentials, and completion are simulated; it performs no installation or external configuration.
