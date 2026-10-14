# Installer guided setup assessment

Assessment date: 2026-09-17. This records requirements and proposed behavior; application changes
have not been implemented. Signing remains deferred.

The follow-on [installer question flow](spec/installer-question-flow.md) defines exact screen copy,
branch conditions, deferred prerequisites, and acceptance criteria for implementation.

## Setup paths

| Path | Intended experience |
| --- | --- |
| Quick Start | Current recommended local feature preset, default ports, no Hybrid/Belabox Manager. Ask for storage and operator login, confirm a usable LAN address where required, and interrupt only for a relevant problem. |
| Guided | Select intended uses first. Ask short follow-up questions only for those selections and explain required companion features immediately. Use default technical settings. |
| Advanced | Select supported features and configure grouped settings directly. Skip compulsory educational pages; preserve dependency, credential, storage, port, and deployment validation. |

Selecting Quick after another mode currently retains earlier Hybrid/custom-port settings. Fresh
drafts need to enforce the Quick defaults; reconfiguring an installed deployment must not silently
reset its existing configuration. See [mode selection](../apps/frame-setup/src/main.js).

## Guided questions

Start with four independent needs: video/overlays, photos, Audio Monitor, and remote Belabox
management. Then visit only selected branches. Remote video contribution and remote browser access
need separate questions; one generic
"remote" answer must not enable Hybrid for every workflow.

| Branch | Questions and prerequisites before installation | Follow-up after startup |
| --- | --- | --- |
| Video Relay | Will the encoder connect on the local network or over the internet? For external contribution, establish the advertised relay address and explain UDP forwarding. | Create stream profile; configure/test encoder and OBS playback. |
| Overlays | Would you like stream statistics in OBS? Explain the current Video Relay dependency when selected. | Choose design/statistics and copy the browser-source URL. |
| Audio Monitor | Where will audio be captured? Who will listen locally or remotely? Explain secure capture requirements for another device. | Select source/device, grant browser permission, and test the listener link. |
| Photo input | Camera FTP, browser upload, or both? For FTP, suggest and confirm the address cameras can reach. | Show how to obtain/change the generated camera login securely and test an upload. |
| Photo Gallery | Would you like published photo albums? Require a photo input method. | Review albums, appearance, access, and cleanup. |
| Photo Stage | Would you like photos shown live in OBS? Explain that Gallery and a photo input method are included. | Add the OBS viewer, test remote control, and optionally configure Streamer.bot. |
| Belabox Manager | Do you want remote control of a roaming Belabox? Explain Hybrid/domain requirements before collecting credentials. | Pair/install the agent and verify the control connection. |
| Remote browser access | Which supported features need remote access? Do you control a domain, is its DNS active on Cloudflare, and do you already have a tunnel? | Verify the running connector, intended routes, and remote workflow. |

The [existing service registry](../config/frame-services.json) should remain authoritative for
dependencies. Guided can add required companions with a visible explanation; where an alternative
is needed (FTP or browser input), ask the user. Advanced should flag dependency problems at selection
time instead of deferring all feedback to preflight.

Audio capture from another device needs special care: the [Audio Monitor documentation](../services/frame-audio/README.md)
recommends localhost on the capture host, or HTTPS from another device. A plain LAN address does
not establish usable microphone capture. Do not promise that enabling a tunnel automatically exposes
every protected capture/operator route.

Operator login gets a short account page. Cloudflare credentials belong after domain/tunnel setup.
Review should summarize already answered questions and check results, not introduce new credential
forms. Save non-secret answers between
steps. Defer an unavailable integration explicitly rather than installing it as if it were ready.

## Guided versus Advanced

Keep these understandable choices in Guided: data location, original-backup retention, camera/encoder
location, public exposure, required accounts, and how users recover from a blocking conflict. The
current 14-day original-backup retention default needs disclosure; it does not mean Gallery photos
are automatically deleted.

Keep direct service ports, passive FTP ranges, bind/address overrides, FTP session limits, upload
concurrency/batch limits, password-minimum policy, verbose logs, raw environment keys, container path
mappings, and Belabox transport/SSH overrides in Advanced or focused troubleshooting. Audio quality
and overlay styling normally belong in their running applications.

Advanced should use a compact feature list and named configuration sections. Distinguish editable
settings from generated/reference-only values; the current environment map does not edit every
variable it describes. No generic raw configuration editor is required for this revision.

## Domain and tunnel preparation

For FRAME's intended stable public Cloudflare path, establish these facts in order:

1. The user controls an eligible domain and its DNS administration.
2. Its DNS is active in the intended Cloudflare account. Registration can remain with another registrar.
3. The user chooses a public hostname and creates/selects a tunnel.
4. The published hostname routes to FRAME's prescribed gateway origin; the connector token is supplied.
5. After startup, verify the connector and actual supported public routes separately from local health.

Provide "already on Cloudflare", "domain elsewhere", and "need a domain" choices before tunnel
instructions. A pending DNS activation needs a saved waiting state, recheck, and a clear way to
return to a local installation without claiming deferred Hybrid features are enabled.

Cloudflare's [tunnel prerequisites](https://developers.cloudflare.com/tunnel/get-started/)
include a domain on Cloudflare for published applications. Its
[DNS FAQ](https://developers.cloudflare.com/dns/faq/) confirms that moving domain registration is
unnecessary. Review existing website/mail records before guiding a nameserver change.

Free options exist, but must not be an assumed prerequisite that completes instantly:

- [DigitalPlat](https://domain.digitalplat.org/) advertises free names including `qzz.io` and
  `dpdns.org`, with external nameserver delegation. Its
  [nameserver guide](https://github.com/DigitalPlatDev/FreeDomain/blob/main/documents/tutorial/platform/1.3-connect-nameservers.md)
  uses Cloudflare as an example. Confirm the exact name can become an active Cloudflare zone before
  declaring it ready; no registration/activation was performed for this assessment.
- [EU.org](https://nic.eu.org/) offers free delegated names. Its
  [registration instructions](https://nic.eu.org/register.html) require human validation, so do not
  promise availability within the installation session.
- A free hostname is not automatically an eligible independently managed Cloudflare zone. Cloudflare
  documents its [domain eligibility rules](https://developers.cloudflare.com/learning-paths/personal-website/domain-setup/add-domain/).
- [Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
  provide temporary testing URLs and do not support SSE. They are not the supported persistent Hybrid path.

The first guide should accept an existing eligible domain and offer optional domain-provider links;
do not add domain-registration automation or make a particular free provider part of installer logic.

## Layout requirements

The current window is 1120 x 760 with a 900 x 640 minimum
([Electron configuration](../apps/frame-setup/electron/main.cjs)). Below 1040px, the
[stylesheet](../apps/frame-setup/src/styles.css) retains a 230px sidebar while collapsing most grids
to one column. Guided also combines four explanation blocks, technical limits, and its own navigation
inside a scrolling page. Ports and Review combine too many unrelated tasks for CSS alone to fix.

- Give each page one question/topic, with all relevant options and prerequisites visible together.
  Aim for 3-5 short choices or a small field group; split larger tasks into named substeps.
- Put only optional explanation behind Learn more. Never hide a required choice or prerequisite
  inside collapsed help.
- Use one persistent Back/Continue footer. Replace Guided's second navigation row with the same footer.
- Reclaim sidebar space with a compact progress header on smaller windows. Size the initial window
  to the available desktop work area, accounting for taskbar and window chrome.
- Keep Review concise. Show a clear check summary and failures; full logs, exhaustive port tables,
  and longer help may have dedicated detail views. My FRAME Setup contains the full reference.
- Preserve keyboard order, visible focus, readable text, and accessible validation. At high zoom,
  allow one vertical scrolling region instead of clipping fields or shrinking text.

Acceptance checks when implemented:

- Ordinary Quick/Guided questions expose every option, prerequisite, error, and navigation control
  at default/minimum sizes at normal text scale without requiring resize or page scrolling.
- Check 1366 x 768 at 100% and 1920 x 1080 at 125%/150% display scaling; clamp the window to the work
  area. Verify 200% text/renderer zoom remains fully usable with the scroll fallback.
- Exercise long paths/hostnames, long labels, multiple errors, and keyboard-only navigation.
- Skip unused branches without losing other answers; revisit selections and immediately update
  dependencies, required questions, review, and validation state.
- Switch a fresh Hybrid/custom-port draft to Quick and verify local defaults;
  separately verify that reconfiguring an installed deployment preserves deliberate settings.
- Treat DNS pending and a deferred integration as explicit states.

This assessment used source inspection and current provider documentation. It did not run a visual
layout test, register a domain, or change application behavior.
