# FRAME Stream Management

FRAME-owned management UI for the OpenIRL SRTLA Receiver API.

- Keeps the receiver admin API key server-side.
- Creates and removes publisher/player pairs.
- Displays live bitrate, RTT, latency, buffer, dropped packets, and uptime.
- Generates SRTLA, direct SRT, player, and statistics links.
- Links each player profile directly into the FRAME Overlay Wizard.
- Connects existing BELABOX relay telemetry by full stats URL or relay ID.
- Normalizes SLS and BELABOX telemetry behind one private internal API.
- Supports optional HTTP Basic authentication.

Custom telemetry profiles are persisted under `DATA_ROOT/state/custom-streams.json`. BELABOX URLs
are fetched server-side and are never included in public overlay renderer payloads.
BELABOX-only telemetry remains available when the optional local FRAME SRTLA receiver is offline.

The service intentionally reproduces the useful management workflow rather than copying the
unlicensed OpenIRL management UI source.
