# FRAME Video Ingest

FRAME Video Ingest receives live video from SRTLA or SRT senders and makes it available to FRAME
Stream Management.

It is the video relay receiver behind the stream links, stats, and health data shown in FRAME.

## Who This Is For

FRAME Video Ingest is for streamers and operators who send live video into FRAME.

Use it if you want to:

- Receive video from an IRL camera, encoder, phone app, or relay sender.
- Use SRTLA for unstable mobile networks.
- Use direct SRT when SRTLA is not needed.
- Feed local stream health into FRAME Stream Management.
- Provide stream data to FRAME Overlays.

## What You Use It For

Use Video Ingest as the receiving side of your live video relay.

Common uses:

- Point an SRTLA sender at your FRAME machine.
- Point a direct SRT sender at your FRAME machine.
- Let Stream Management create and show relay links.
- Monitor bitrate, latency, dropped packets, and uptime.
- Supply stream health data to overlays.

Most users operate this through FRAME Stream Management instead of opening Video Ingest directly.

## How To Install

Video Ingest is part of the normal FRAME stack when **Video Relay and Stream Management** is enabled.

Recommended setup:

1. Open the FRAME folder.
2. Run `stack.cmd`.
3. Choose **Guided setup**.
4. Enable **Video Relay and Stream Management**.
5. Start the stack.
6. Open Stream Management:

```text
http://localhost/slsui
```

For standalone testing only:

```bash
docker compose up --build -d
```

Most users should use the full FRAME stack instead of standalone mode.

### Receiver build

FRAME builds the receiver from pinned OpenIRL source revisions rather than inheriting the published
receiver image. The build uses the
[OpenIRL receiver 1.2.0](https://github.com/OpenIRL/srtla-receiver/releases/tag/1.2.0)
architecture, its current standalone SRTLA receiver and SRT Live Server, and
[Haivision SRT 1.5.6](https://github.com/Haivision/srt/releases/tag/v1.5.6) with the OpenIRL SRTLA
reordering, NAK, and per-link statistics patches applied.

The Docker build fails if the resulting library is not SRT 1.5.6 or does not expose the OpenIRL
SRTLA socket option and statistics API.

## How To Operate

Open Stream Management:

```text
http://localhost/slsui
```

Create or select a stream, then copy the publisher link into your camera, encoder, or sending app.

Common ports:

| Port | Use |
| --- | --- |
| `5000/udp` | SRTLA sender ingest |
| `4001/udp` | Direct SRT sender ingest |
| `4000/udp` | SRT player output |
| `8080/tcp` | Receiver stats and management API |

For local testing, point your sender at the FRAME machine on your LAN.

For remote senders outside your network, you usually need to port forward the ingest port you are
using. SRTLA normally uses `5000/udp`. Direct SRT sender ingest normally uses `4001/udp`.

Forward UDP, not TCP, for SRTLA and SRT ingest.

FRAME Tunnel and the optional Cloudflare Worker are for public web pages. They do not carry SRTLA or
SRT video ingest. Remote video senders still need UDP port forwarding, a VPN, or another UDP-capable
relay path.

Do not expose the stats/API port publicly unless you know exactly why you need it.

## Relies Upon

Video Ingest relies on:

- FRAME shared data storage
- FRAME Stream Management
- A camera, encoder, phone app, or sender that supports SRTLA or SRT
- Network access to the selected ingest port

Optional connections:

| Feature | Relies Upon |
| --- | --- |
| Stream health dashboard | FRAME Stream Management |
| Stream health overlays | FRAME Overlays |
| Public stats links | FRAME Edge and configured public/Hybrid access |
| Remote senders | Router/firewall port forwarding or another network path |

## Notes For Operators

SRTLA is usually the better choice for mobile or unstable networks.

Direct SRT is useful for simpler setups, local testing, or senders that do not support SRTLA.

Keep receiver stats and management routes local or protected.

Test remote ingest from outside your LAN. Some routers cannot test their own public address from
inside the same network.

If your ISP does not give your router a real public address, normal port forwarding may not work.

Do not delete the video relay data folder unless you are ready to recreate relay streams and keys.

If a sender cannot connect, check the IP address, selected protocol, port, firewall rules, and router
port forwarding.

If stream health looks poor, lower the sender bitrate or improve the sender network before changing
FRAME settings.
