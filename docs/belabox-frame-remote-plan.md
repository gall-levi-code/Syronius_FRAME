# FRAME Belabox Remote And Relay Plan

This plan targets the full product goal: FRAME can replace the BELABOX Cloud remote-control
experience for paired devices, provide FRAME relay resources, and protect live streams from
FRAME-originated photo transfers. The phases below are dependency order, not an MVP ladder.

## Ultimate Goal

- A FRAME-hosted remote page loads immediately, even when the Belabox is offline.
- The page shows cached state, pending/offline status, and becomes live as soon as the agent
  reconnects.
- Users can control the same meaningful mutable surface as belaUI: stream config, start/stop,
  bitrate, relay choice, network interface participation, Wi-Fi, hotspot, modem settings, SSH,
  logs, reboot/power controls, and safe update controls.
- FRAME relay resources appear in stock belaUI for users who stay inside the local BELABOX UI.
- FRAME also offers a richer native relay page with live relay health, path quality, capacity,
  stream stats, and guided selection.
- Photo uploads from the Belabox do not starve SRTLA/SRT streaming links or cause long bitrate
  recovery.
- The system does not depend on `remote.belabox.net` or BELABOX sponsor-gated relay accounts.

## Boundaries

- Do not bypass or clone the paid BELABOX relay service.
- Do not install Codex on the Belabox.
- Do not expose a generic remote shell over MQTT.
- Prefer bridging and configuring the installed belaUI/belacoder stack over forking it.
- If we modify or redistribute belaUI/belacoder GPL code, handle the license explicitly.

## Current Product Decisions

- Preserve stock belaUI. Users should not see a broken or half-replaced local BELABOX UI.
- Provide both paths:
  - FRAME relays appear in stock belaUI for users who stay native.
  - FRAME also has a richer native relay/control page.
- Relays are self-hosted. Do not design around a FRAME-operated industrial relay fleet.
- While streaming, photo transfer should use chunked HTTPS plus throttling. Avoid pausing a live
  upload mid-file because upload dips can falsely trigger downstream photo-pipeline stability gates.
- Add a FRAME bitrate ceiling governor above belacoder rather than patching belacoder first.
- Defer Wi-Fi/modem rollback policy until the control surface is closer; do not block earlier
  phases on rollback design.

## Source Facts So Far

- belaUI local control is a websocket protocol, not a REST API.
- `remote.belabox.net` works by having belaUI connect outward to
  `wss://remote.belabox.net/ws/remote`, authenticate with `config.remote_key`, send an initial
  status snapshot, then pass remote messages through the same `handleMessage()` path as local UI
  messages.
- belaUI stores cloud relay metadata in `relays_cache.json`. Its relay list contains `servers`,
  `accounts`, and optional `bcrp_key`.
- Relay servers can include `type: "srtla"`, `addr`, `port`, `bcrp_port`, `name`, and `default`.
- Relay accounts contain display `name` and SRT `ingest_key`.
- When a relay/account is selected, belaUI maps it to the same effective stream target as manual
  `srtla_addr`, `srtla_port`, and `srt_streamid`.
- belaUI writes live bitrate limits to the bitrate file, then sends `SIGHUP` to `belacoder`.
- `belacoder` owns dynamic bitrate. It drops bitrate quickly when SRT RTT/send-buffer pressure
  rises, then recovers gradually when RTT is low and stable.
- On hard SRT connection failure, `belacoder` exits. belaUI restarts it. On restart, `belacoder`
  starts at the configured max bitrate again, which can overshoot if the network is still fragile.
- FRAME already has a signed MQTT command path, device heartbeat, telemetry cache, command audit,
  chunked photo upload path, and SRTLA stream management service.

## Target Architecture

```text
FRAME browser
  <-> FRAME manager live state channel
  <-> FRAME manager command API
  <-> MQTT over WSS broker
  <-> Belabox agent
  <-> local belaUI websocket / local config files / local process controls
  <-> belacoder + srtla_send
```

### Device Control Plane

- Keep MQTT over WSS between the Belabox agent and FRAME.
- Add a browser-facing live state channel from FRAME manager to the UI. SSE is enough for state;
  WebSocket is acceptable if we want one bidirectional browser channel.
- Commands remain signed, allowlisted, audited, and correlated by command ID.
- Long operations report phases: `queued`, `sent`, `received`, `applying`, `applied`, `failed`,
  and optional `rollback`.

### Belabox Agent Roles

- Publish heartbeat, status snapshots, stream state, relay probe results, and photo-transfer state.
- Execute only explicit allowlisted commands.
- Bridge selected commands into local belaUI when exact behavior is safest.
- Write direct config files only where belaUI already treats those files as authoritative.
- Own photo upload throttling/pausing because the agent is the sender.
- Leave room for Wi-Fi/modem rollback later, but do not block earlier phases on it.

### Agent Privilege Model

The current SSH install path can use sudo during installation, but its system service runs as the
SSH user. For the full remote-control target, keep the privilege model explicit:

- If a command can be safely driven through local belaUI websocket, prefer that. belaUI already runs
  as root on the device and owns privileged actions such as NetworkManager, ModemManager, SSH,
  reboot, poweroff, stream start/stop, and bitrate file reload.
- If a command only needs agent-owned files, keep it unprivileged.
- Use root only where belaUI cannot cover the operation cleanly:
  - writing/reloading stock `relays_cache.json` if file ownership requires it
  - restarting belaUI for relay-cache reloads
  - installing systemd units and package dependencies
  - future low-level network shaping, if app-level throttling is insufficient

Root install options:

- Root agent service: install a systemd unit as root and run the agent as root. Simplest runtime
  model, broadest trust boundary.
- User agent plus root helper: keep the main MQTT agent unprivileged and expose a local helper for
  a tiny allowlist of root actions.
- User agent plus sudoers allowlist: possible, but likely harder to keep correct as Wi-Fi, modem,
  systemd, and relay-cache operations grow.

Preferred direction: user agent plus belaUI websocket bridge first, with a tiny root helper only if
stock belaUI relay sync or future network shaping needs it.

### Stock belaUI Relay Integration

We want users who install the FRAME agent but do not use the FRAME native relay page to still see
FRAME relay resources in stock belaUI.

Options:

- Cache injection: agent writes `/opt/belaUI/relays_cache.json` and restarts belaUI while idle.
  This is the least invasive path.
- belaUI companion patch: add a local-only reload path or FRAME relay provider. This gives better
  live updates but creates GPL distribution obligations.
- BCRPT-compatible probe service: FRAME relays expose the probe behavior expected by belaUI's
  existing BCRPT integration. This allows stock latency badges if we match the protocol.
- Name annotation fallback: agent periodically writes relay names like
  `green FRAME Central (54 ms)` into the relay cache. This works without BCRPT compatibility but
  needs a belaUI restart/reload to appear in stock UI.

Ultimate target: cache injection plus BCRPT-compatible probes if the protocol can be reproduced
cleanly. Use native FRAME relay UI for richer behavior.

### FRAME Native Relay Integration

FRAME relay profiles should model both configuration and live health. Relays are self-hosted
resources, not a managed FRAME fleet:

```json
{
  "relay_id": "frame-us-central-1",
  "name": "FRAME Central",
  "srtla_host": "relay.example.com",
  "srtla_port": 5000,
  "probe_host": "relay.example.com",
  "probe_port": 5050,
  "stats_url": "https://frame.example.com/stats/main",
  "capacity": {
    "available": true,
    "active_publishers": 2,
    "max_publishers": 20
  }
}
```

The Belabox agent probes relays from the device because path quality is device-specific:

```json
{
  "relay_id": "frame-us-central-1",
  "source_ip": "192.168.8.42",
  "reachable": true,
  "rtt_min_ms": 54,
  "rtt_p50_ms": 63,
  "loss_pct": 0,
  "mtu_bytes": 1400,
  "low_mtu": false,
  "score": "green"
}
```

Availability has three layers:

- Relay health: service up, UDP ports reachable, CPU/network/capacity acceptable.
- Device path health: device can reach the relay over its current active links with acceptable
  RTT, loss, and MTU.
- Live stream health: SRTLA/SRT stats during an active stream, including bitrate, RTT, latency,
  packet loss, recovery, and uptime.

## Bitrate And Photo Upload Coordination

The failure mode to solve:

```text
photo transfer starts
FTP/HTTP fills one uplink queue
SRTLA still tries to use that path
SRT RTT/send buffer spikes
belacoder drops bitrate fast
photo transfer finishes
belacoder recovers slowly
```

FRAME should add a stream-aware upload governor above belacoder:

- Detect streaming state from local belaUI, running processes, or stream stats.
- Prefer chunked HTTPS for Belabox-to-FRAME photo transfer while streaming.
- Rate-limit photo upload while streaming.
- Avoid pausing a started file upload mid-transfer because upload dips can falsely trigger the
  downstream stability gate. Instead use chunk sizing and a steady rate cap before upload begins.
- Hold new uploads after a reconnect or severe bitrate drop.
- Optionally lower the belacoder max bitrate ceiling during recovery, then ramp it back to the
  user's target.
- Leave belacoder's internal dynamic bitrate intact unless the governor cannot solve the issue.

Policy shape:

```json
{
  "photo_upload_when_streaming": "throttle",
  "photo_upload_streaming_kbps": 256,
  "photo_upload_idle_kbps": 0,
  "photo_upload_recovery_hold_seconds": 20,
  "hold_new_uploads_when_stream_unstable": true,
  "bitrate_recovery": {
    "enabled": true,
    "initial_ceiling_kbps": 1800,
    "step_kbps": 400,
    "stable_seconds_per_step": 5
  }
}
```

`photo_upload_idle_kbps: 0` means uncapped when the stream is idle.

Governor behavior:

- Maintain a user target max bitrate and a current enforced ceiling.
- When a hard reconnect or severe congestion event occurs, temporarily lower the ceiling.
- Write the ceiling through the same bitrate file belaUI already uses, then trigger belacoder reload.
- Increase the ceiling only after stable stream windows.
- Do not interrupt an in-flight photo chunk; schedule the next chunk according to the current rate
  budget.
- If the stream becomes unstable before a new file starts, hold the file in queue instead of
  beginning an upload that cannot be safely paused.

## Phased Implementation

### Phase 1: Contracts And Reference Capture

- Document belaUI websocket message types we will support.
- Document relay cache schema and how stock belaUI consumes it.
- Document BCRPT inputs/outputs and decide whether protocol compatibility is required.
- Add fixtures for FRAME relay profiles, probe results, stream state, and command phases.
- Define telemetry/state schemas before expanding UI.

Deliverable: source-backed contracts that let implementation proceed without guessing.

### Phase 2: Agent Privilege And Local belaUI Bridge

- Use local belaUI websocket as the primary privileged bridge.
- Identify which actions still need root outside belaUI.
- Give the agent a safe way to authenticate to local belaUI, ideally with a managed local token.
- Add allowlisted command handlers for belaUI-backed actions.
- Add state snapshot publishing from local belaUI into FRAME telemetry.
- Add command phase acknowledgements.

Deliverable: FRAME can observe and drive belaUI behavior through a controlled adapter.

### Phase 3: Premium Realtime Remote Surface

- Replace polling-heavy Belabox manager views with pushed manager-to-browser state.
- Render cached state immediately on page load.
- Show pending/offline/live states based on heartbeat freshness.
- Add optimistic UI phases for bitrate, start/stop, relay changes, Wi-Fi changes, and photo
  transfer policy changes.
- Keep full command audit visible.

Deliverable: remote page feels live even before all mutable controls are complete.

### Phase 4: FRAME Relay Resource Model

- Add FRAME relay profiles and stream/account bindings.
- Add relay health, capacity, and stats endpoints.
- Add device-origin relay probes.
- Add MTU/low-MTU detection.
- Add relay recommendation scoring.

Deliverable: FRAME has first-class relay resources independent of BELABOX Cloud.

### Phase 5: Stock belaUI Relay Presence

- Generate `relays_cache.json` from FRAME relay profiles.
- Sync FRAME relay accounts into stock belaUI.
- Restart or reload belaUI only when idle unless the user confirms otherwise.
- Add optional BCRPT-compatible probe server if chosen.
- Add fallback name annotation for latency/status if exact BCRPT compatibility is deferred.

Deliverable: stock belaUI can show and use FRAME relays.

### Phase 6: Full Mutable Control Parity

- Stream: config, start, stop, bitrate, autostart, latency, pipeline, audio source/codec.
- Network participation: enable/disable interface use for SRTLA.
- Wi-Fi: scan, connect saved, connect new, disconnect, forget.
- Hotspot: start, stop, SSID/password/channel.
- Modems: APN, username, password, roaming, operator, network type, scan.
- SSH: status, start, stop, password reset.
- Device: logs, reboot, poweroff, safe software update controls.
- Identify which Wi-Fi/modem operations will later need rollback or confirmation.

Deliverable: FRAME can operate the practical belaUI surface remotely.

### Phase 7: Stream-Aware Photo And Bitrate Governor

- Add upload throttling to chunked HTTPS and direct FTP transfer paths.
- Default Belabox photo transfer to chunked HTTPS while streaming.
- Throttle in-flight chunked uploads with a steady rate cap.
- Hold new uploads based on stream stability.
- Add post-reconnect and post-drop recovery holds.
- Add max-bitrate ceiling ramp to avoid belacoder overshoot after hard reconnects.
- Publish user-facing transfer states such as `Queued`, `Holding for stream`, `Uploading at
  256 kbps`, and `Waiting for stream stability`.

Deliverable: photo delivery no longer causes avoidable stream bitrate collapse.

### Phase 8: Hardening, Installer, And Soak Tests

- Add installer support for managed agent permissions, service install/repair/remove, and relay
  profile sync.
- Add long-running stream/photo soak tests.
- Add Wi-Fi rollback tests after rollback policy is selected.
- Add relay failover and bad-path simulations.
- Add stream recovery tests around photo upload bursts.
- Add support bundle collection for agent, belaUI, belacoder, srtla, relay probes, and transfer
  governor state.

Deliverable: shippable full-stack behavior.

## Decisions Needed

1. Stock belaUI integration level:
   - selected: preserve stock belaUI and support both stock relay list and FRAME-native relay UI
   - open: cache injection only, BCRPT compatibility, or both

2. Agent privilege model:
   - selected direction: local belaUI websocket bridge first
   - open: root helper only if relay sync or network shaping needs it

3. Local belaUI authentication:
   - agent writes/owns a local persistent belaUI token
   - user provides belaUI password during pairing
   - agent avoids websocket auth and only uses files/processes where possible

4. FRAME relay deployment model:
   - selected: self-hosted relay resources only, no FRAME-hosted industrial fleet

5. Probe compatibility:
   - implement a BCRPT-compatible server if feasible
   - use FRAME-native probes only
   - start with native probes and later add BCRPT compatibility

6. Browser realtime transport:
   - SSE for state plus REST for commands
   - WebSocket for both state and commands

7. Photo transfer policy while streaming:
   - selected: force chunked HTTPS while streaming and throttle steadily
   - selected: hold new uploads when the stream is unstable
   - avoid pausing started file transfers mid-trigger-window

8. Default streaming upload cap:
   - suggested starting values: 128 kbps, 256 kbps, or 512 kbps

9. Bitrate recovery policy:
   - selected: add FRAME ceiling governor above belacoder
   - open: fixed policy vs user-selectable conservative/balanced/aggressive profiles

10. Network rollback policy:
    - selected for now: defer rollback design
    - later: automatic rollback, explicit confirmation, or both depending on operation

11. Update and power controls:
    - include in full remote parity
    - expose only behind extra confirmation
    - defer software update while keeping reboot/poweroff

12. Licensing posture:
    - bridge stock GPL components without distributing modified copies
    - distribute a belaUI patch and comply with GPL obligations
    - keep all FRAME-native UI code independent

## Recommended Decisions

- Use MQTT over WSS for device control, and add a manager-to-browser live state channel.
- Use local belaUI websocket as the main privileged bridge instead of making the whole agent root.
- Let the agent own a local belaUI token if that is compatible with stock belaUI's auth storage.
- Build FRAME-native relay probes first, but keep the relay profile schema compatible with stock
  belaUI's relay cache.
- Sync FRAME relay profiles into stock belaUI with cache injection and idle restart first.
- Research BCRPT compatibility after relay profiles and native probes exist.
- Default photo transfer to chunked HTTPS while streaming.
- Add the FRAME bitrate ceiling governor instead of patching belacoder first.
