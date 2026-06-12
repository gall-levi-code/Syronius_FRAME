# FRAME Video Ingest

`frame-ingest-video` wraps the pinned OpenIRL SRTLA Receiver image and preserves its SRTLA, SRT,
statistics, and stream-ID API behavior.

FRAME adds one initialization step: when `/var/lib/sls/streams.db` does not exist, the wrapper seeds
the SHA-256 hash of `SLS_API_KEY` as the initial admin key. Existing databases are never modified.
This lets other FRAME services authenticate without scraping a one-time key from container logs.

## Ports

- `5000/udp` - SRTLA publisher ingest
- `4001/udp` - direct SRT publisher ingest
- `4000/udp` - SRT player output
- `8080/tcp` - health, management API, and publisher statistics

## Upstream

- Receiver: <https://github.com/OpenIRL/srtla-receiver>
- SRT Live Server: <https://github.com/OpenIRL/srt-live-server>
- Pinned receiver image digest:
  `sha256:3202ba3584864273ff7293a4e81a0983acda71d5a79e1a2da2b7bcf0b98db2f8`

The upstream receiver is licensed under GPL-3.0. See `OPENIRL-LICENSE.txt`.
