# FRAME Stream Management

FRAME-owned management UI for the OpenIRL SRTLA Receiver API.

- Keeps the receiver admin API key server-side.
- Creates and removes publisher/player pairs.
- Displays live bitrate, RTT, latency, buffer, dropped packets, and uptime.
- Generates SRTLA, direct SRT, player, and statistics links.
- Publishes unauthenticated read-only statistics at `/stats/:stream-id`; Hybrid links use the configured tunnel hostname while `/slsui` management remains LAN-only.
- Supports stats output adapters, including `/stats/:stream-id?output=bbox_receiver` for Datagutt BBox-receiver style integrations such as IRL+ Chat.
- Opens Overlay Studio from the top toolbar and shows the overlay sources bound to each stream.
- Connects existing BELABOX relay telemetry by full stats URL or relay ID.
- Normalizes SLS and BELABOX telemetry behind one private internal API.
- Supports optional HTTP Basic authentication.

Custom telemetry profiles are persisted under `DATA_ROOT/state/custom-streams.json`. BELABOX URLs
are fetched server-side and are never included in public overlay renderer payloads.
BELABOX-only telemetry remains available when the optional local FRAME SRTLA receiver is offline.

The service intentionally reproduces the useful management workflow rather than copying the
unlicensed OpenIRL management UI source.
