# ADR 0002: Discord Audio Bridge is a separate FRAME service

- **Status:** Accepted
- **Date:** 2026-06-06

## Context

FRAME already defines `frame-audio`, a browser-capture audio monitor that publishes AAC/HLS listener
streams. FRAME Audio Bridge solves a different problem: it receives Discord voice audio, creates
per-streamer mixes, and provides permanent OBS browser-source URLs and mobile control pages.

Combining these behaviors into one container would couple unrelated capture models, permissions,
security boundaries, and operating workflows.

## Decision

The Discord voice-to-OBS feature is implemented as the optional `frame-audio-bridge` service and
the `frame-discord-audio-bridge` capability.

- Source lives in `services/frame-audio-bridge/`.
- Dynamic public routes live below `/bridge`.
- OBS audio and overlay URLs use random bridge keys.
- Control pages additionally require a private control token.
- Discord credentials remain server-side and are never exposed to browser clients.
- Guild configuration persists under the service `DATA_DIR`.
- The service remains independent of `frame-audio`, SRTLA, and the photo pipeline.

## Consequences

- Operators may enable either audio service or both.
- The unified installer must treat `/bridge` as an allowed Hybrid route only when
  `frame-discord-audio-bridge` is enabled.
- Portal and status implementations can report Discord bridge health separately from HLS audio
  monitor streams.
- Stable OBS URLs survive temporary Discord voice sessions and service restarts when persisted data
  is retained.
