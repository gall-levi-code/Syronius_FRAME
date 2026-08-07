# FRAME Belabox Manager

FRAME Belabox Manager installs and operates a lightweight FRAME agent on a Belabox. It provides
remote access to belaUI and the optional IRL+ Mixer, stream relay selection, photo transfer controls,
network diagnostics, and device maintenance without replacing the Belabox software.

## Who This Is For

Belabox Manager is for streamers and operators who want to manage a self-hosted Belabox through
FRAME.

Use it if you want to:

- Reach belaUI when the Belabox is away from your local network.
- Reach the IRL+ Mixer remotely when it is installed on the Belabox.
- See FRAME stream profiles in the remote belaUI relay list.
- Install, repair, update, or remove the FRAME Belabox agent.
- Send camera photos through direct FTP or stream-safe chunked HTTPS.
- Inspect Belabox interfaces, routes, upload throughput, latency, and relay reachability.
- Keep the original Belabox UI and BELABOX Cloud connection intact.

## What You Use It For

Use Belabox Manager when a Belabox should connect back to FRAME over its own outbound connection.
The Belabox does not need a stable LAN address or an inbound management port after installation.

Common uses:

- Open the stock belaUI experience through a FRAME-authenticated remote URL.
- Open the IRL+ Mixer through the same authenticated outbound-agent connection.
- Select a FRAME SRTLA destination and Stream Management publisher account from belaUI.
- Watch native-style relay availability and RTT feedback.
- Receive camera FTP uploads on the Belabox and forward prepared photos to FRAME.
- Throttle photo transfers so they are less likely to compete with a live stream.
- Test each network interface against an external endpoint or the FRAME host.
- Repair the agent after a FRAME update without removing the saved device.

The agent does not replace belaUI or patch its installed files. FRAME adds its relay choices only to
the authenticated FRAME Remote session, then translates a selected FRAME entry into belaUI's
existing manual SRTLA settings.

## How To Install

Belabox Manager is part of the normal FRAME stack.

Recommended setup:

1. Open the FRAME folder.
2. Run `stack.cmd` on Windows or `stack.sh` on Linux.
3. Choose **Guided setup**.
4. Select **HYBRID** mode and enter the public FRAME and SRTLA hostnames.
5. Enable **Video Relay and Stream Management**.
6. Enable **Belabox Manager**.
7. Start the stack.
8. Open Belabox Manager:

```text
http://localhost/belabox
```

Belabox agent install and repair are Hybrid-only. FRAME Setup selects Hybrid automatically when
Belabox Manager is selected, and both installers refuse a LAN configuration or a non-public
`wss://.../belabox/control` endpoint. The endpoint is always derived from FRAME's public base URL,
so changing the public hostname updates subsequent agent installs instead of preserving a stale
override. The local manager page remains available only on the FRAME LAN.

To add a Belabox:

1. Choose **Add device**.
2. Enter a unique device name and the Belabox LAN host or IP address.
3. Enter the Belabox SSH username and password.
4. Choose whether SSH should remain enabled after boot.
5. Configure the optional Belabox FTP Photo Agent.
6. Choose direct FTP or stream-safe chunked HTTPS transfer.
7. Review the settings and install the agent.
8. Keep the wizard open until the SSH, service, and control-connection heartbeat checks finish.

The initial installation requires working local SSH access. After installation, normal remote
operation uses one authenticated outbound secure WebSocket and does not depend on the saved LAN
route. That connection carries presence, telemetry, commands, remote HTTP traffic, media streams,
and approved proxied WebSockets.

## How To Operate

Open the local management page:

```text
http://localhost/belabox
```

### Remote belaUI

Use the device's **Remote access** action or open:

```text
https://your-frame-host/belabox/remote?key=your-device-id
```

The route is protected by the normal FRAME login. It shows an encoder-offline page while the agent
or belaUI is unreachable and reconnects when the device returns.

FRAME stream profiles with publisher keys appear as relay accounts in this remote belaUI session.
The relay entry displays a green, yellow, or red status marker and the lowest successful interface
RTT. The current probe is lightweight TCP reachability to the FRAME HTTPS control endpoint; it is
not yet a measurement of the UDP SRTLA path or a full BCRPT MTU probe.

Direct LAN access to belaUI remains unchanged and continues to show the relay list supplied by
BELABOX Cloud.

### Video Mixer

When IRL+ Mixer is installed on the Belabox, FRAME adds a **Video Mixer** tab for that device. The
tab and its access actions remain available while the service is stopped or the device is offline.
Open:

```text
https://your-frame-host/belabox/mixer?key=your-device-id
```

FRAME maps this authenticated route to the fixed agent target `http://127.0.0.1:9080`. The browser
cannot supply a host or port, and port `9080` is not opened publicly. The page reports **Mixer
unavailable** while the local service is stopped. Its encoder WebSocket bridge uses the already
configured loopback belaUI target and ignores the browser's `port` query.

The remote Mixer is an authenticated, trusted FRAME extension: its interface runs under the FRAME
origin so its existing relative APIs and login flow continue to work. Only install Mixer builds you
trust as FRAME application code. Binary and media bodies stream with bounded buffering and
backpressure, so FRAME does not impose a total file-size ceiling. HTML, CSS, JavaScript, and JSON
responses that require path rewriting are buffered to ensure replacements cannot break across
chunks and are limited to 4 MiB; that safety limit does not apply to uploads, binary responses, or
media streams. Inactive HTTP and proxy streams still close after 30 seconds; activity resets that
timer, while upgraded WebSockets remain long-lived.

### Photo Transfer

Choose one transfer mode at a time:

| Mode | Use |
| --- | --- |
| Direct FTP | Forward prepared photos to a reachable FRAME FTP server. Router forwarding may be required. |
| Chunked HTTPS | Send prepared photos through the FRAME Hybrid route without exposing FTP publicly. |

The agent queues JPEG, PNG, HEIC, and HEIF photos. Photo preparation can resize the long edge,
adjust JPEG quality, and limit output size while preserving EXIF and ICC metadata when supported;
FRAME's photo pipeline performs the final JPG normalization. Chunked HTTPS supports an upload cap
and binds workers to healthy egress interfaces.

Use **Apply changes** after editing device settings. Pending settings remain local to the manager
until they are applied to the Belabox.

### Network Diagnostics

Diagnostics can test each route-checked IPv4 interface against:

- An external Internet speed-test endpoint.
- The authenticated FRAME endpoint.

Each result includes latency, download speed, upload speed, route information, and failure details.
Speed tests are intentionally uncapped and may compete with a live stream, so run them while idle
when possible.

### Maintenance

- **Repair Agent** reinstalls the current FRAME agent and boot service while keeping the device.
- **Uninstall Agent** removes FRAME-owned Belabox services and archives the local agent folder.
- **Remove Device From FRAME** removes the FRAME-side control secret and dashboard state.

Critical SSH actions show a blocking progress dialog and detailed step log. A saved SSH password is
used only when the user selected the option to save it.

## Relies Upon

Belabox Manager relies on:

- FRAME Portal and FRAME Auth
- FRAME Edge
- FRAME Tunnel or another Hybrid public route
- A public `wss://.../belabox/control` endpoint; LAN-only agent pairing is not supported
- A Belabox with SSH access during installation and maintenance
- Outbound HTTPS/WSS access from the Belabox after installation

Optional connections:

| Feature | Relies Upon |
| --- | --- |
| FRAME relay accounts in remote belaUI | FRAME Stream Management and Video Ingest |
| Public remote belaUI | FRAME Tunnel and the configured public hostname |
| Remote Video Mixer | IRL+ Mixer listening on `127.0.0.1:9080` on the Belabox |
| Chunked photo transfer | FRAME Photo Upload and Photo Pipeline |
| Direct FTP forwarding | FRAME Photo FTP or another reachable FTP server |
| Photo upload overlays | FRAME Overlays |

## Notes For Operators

The Hybrid allowlist exposes the FRAME-login-protected `/belabox/remote` and `/belabox/mixer`
tools, plus the device-authenticated `/belabox/control` and tokenized `/belabox-chunks` transport
routes. The `/belabox` management page, `/belabox/api`, and `/belabox/assets` remain private.

Each device receives separate control and upload credentials. FRAME authenticates the control
connection with a fresh nonce/HMAC challenge, signs remote commands with Ed25519, and the agent
validates the device ID, signature, expiry, nonce, command allowlist, and arguments before acting.
A disconnect marks the device offline immediately; commands are not queued, and the agent sends a
full state snapshot after reconnecting.

The main agent runs as the Belabox SSH user. Root access is limited to explicit installation and
maintenance operations that require sudo. Normal heartbeats, diagnostics, remote UI proxying, relay
probes, and photo controls do not run the agent as root.

Relay RTT probes run every five seconds and publish a compact health message. Their interval, TCP
host, port, and timeout can be adjusted with `BELABOX_RELAY_PROBE_INTERVAL_MS`,
`BELABOX_RELAY_PROBE_HOST`, `BELABOX_RELAY_PROBE_PORT`, and
`BELABOX_RELAY_PROBE_TIMEOUT_MS` in advanced deployments.
