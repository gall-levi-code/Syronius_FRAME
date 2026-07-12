# FRAME Belabox Manager

FRAME Belabox Manager installs and operates a lightweight FRAME agent on a Belabox. It provides
remote access to belaUI, stream relay selection, photo transfer controls, network diagnostics, and
device maintenance without replacing the Belabox software.

## Who This Is For

Belabox Manager is for streamers and operators who want to manage a self-hosted Belabox through
FRAME.

Use it if you want to:

- Reach belaUI when the Belabox is away from your local network.
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

To add a Belabox:

1. Choose **Add device**.
2. Enter a unique device name and the Belabox LAN host or IP address.
3. Enter the Belabox SSH username and password.
4. Choose whether SSH should remain enabled after boot.
5. Configure the optional Belabox FTP Photo Agent.
6. Choose direct FTP or stream-safe chunked HTTPS transfer.
7. Review the settings and install the agent.
8. Keep the wizard open until the SSH, service, and MQTT heartbeat checks finish.

The initial installation requires working local SSH access. After installation, normal remote
operation uses outbound MQTT over secure WebSockets and does not depend on the saved LAN route.

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

### Photo Transfer

Choose one transfer mode at a time:

| Mode | Use |
| --- | --- |
| Direct FTP | Forward prepared photos to a reachable FRAME FTP server. Router forwarding may be required. |
| Chunked HTTPS | Send prepared photos through the FRAME Hybrid route without exposing FTP publicly. |

Photo preparation can resize the long edge, adjust JPEG quality, and limit output size while
preserving EXIF and ICC metadata when supported. Chunked HTTPS supports an upload cap and binds
workers to healthy egress interfaces.

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
- **Remove Device From FRAME** removes FRAME-side credentials, MQTT ACLs, retained status, and
  dashboard state.

Critical SSH actions show a blocking progress dialog and detailed step log. A saved SSH password is
used only when the user selected the option to save it.

## Relies Upon

Belabox Manager relies on:

- FRAME Portal and FRAME Auth
- FRAME Edge
- The bundled FRAME Belabox MQTT broker
- FRAME Tunnel or another Hybrid public route
- A Belabox with SSH access during installation and maintenance
- Outbound HTTPS/WSS access from the Belabox after installation

Optional connections:

| Feature | Relies Upon |
| --- | --- |
| FRAME relay accounts in remote belaUI | FRAME Stream Management and Video Ingest |
| Public remote belaUI | FRAME Tunnel and the configured public hostname |
| Chunked photo transfer | FRAME Photo Upload and Photo Pipeline |
| Direct FTP forwarding | FRAME Photo FTP or another reachable FTP server |
| Photo upload overlays | FRAME Overlays |

## Notes For Operators

The `/belabox` management page should stay local or login-protected. Only the authenticated
`/belabox/remote` route is intended for Hybrid access.

Each device receives unique MQTT credentials and can only access its own topic namespace. FRAME
signs remote commands with Ed25519, and the agent validates the device ID, signature, expiry,
nonce, command allowlist, and arguments before acting.

The main agent runs as the Belabox SSH user. Root access is limited to explicit installation and
maintenance operations that require sudo. Normal heartbeats, diagnostics, remote belaUI proxying,
relay probes, and photo controls do not run the agent as root.

Relay RTT probes run every five seconds and publish a compact health message. Their interval, TCP
host, port, and timeout can be adjusted with `BELABOX_RELAY_PROBE_INTERVAL_MS`,
`BELABOX_RELAY_PROBE_HOST`, `BELABOX_RELAY_PROBE_PORT`, and
`BELABOX_RELAY_PROBE_TIMEOUT_MS` in advanced deployments.
