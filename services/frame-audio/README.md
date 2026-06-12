# FRAME Audio Monitor

FRAME Audio Monitor publishes browser-captured audio from a LAN machine to stable remote listener
pages using AAC/HLS.

It is separate from FRAME Audio Bridge:

- `frame-audio` captures a local microphone, virtual cable, or VoiceMeeter device for remote listening.
- `frame-audio-bridge` receives Discord voice and creates per-streamer OBS mixes.

## MVP Flow

```text
Browser getUserMedia + MediaRecorder
  -> WebSocket binary chunks
  -> frame-audio ffmpeg process
  -> one-second AAC/HLS segments
  -> remote listen page
```

## Pages

- `/audio/admin` - create, edit, and delete audio sources.
- `/audio/capture/<streamId>` - select a browser audio input and publish it.
- `/audio/listen/<streamId>` - remote HLS listener.
- `/audio/public/streams/<streamId>/*` - read/heartbeat-only listener API used by public pages.
- `/audio/hls/<streamId>/<generation>/index.m3u8` - generated HLS output.

Only one browser publisher is accepted for each audio source. When `alwaysOn` is enabled, FRAME
generates silence while capture is offline so the listen page remains available.

Source names and stream IDs must be unique. Deleting a source closes its publisher, clears active
listener state, removes its generated HLS media, and removes its registry entry. The same public ID
can be reused after deletion, but the recreated source receives a fresh internal identity so stale
browser capture settings are not restored.

## Browser Capture Quality

The capture page provides three presets plus a custom mode:

- **Voice** requests mono `96 kbps` Opus with echo cancellation, noise suppression, and automatic
  gain enabled.
- **Music / Desktop** requests stereo `256 kbps` Opus with browser voice processing disabled.
- **Maximum Quality** requests stereo `510 kbps` Opus with browser voice processing disabled.
- **Custom** exposes the Opus bitrate, channel count, and voice-processing controls individually.

Browsers may cap or ignore requested media settings. While capture is live, the page reports the
actual channel/sample-rate settings and the MediaRecorder bitrate reported by the browser.

Each source independently selects a final AAC/HLS listener quality from `64` through `320 kbps`.
Changing an always-on source updates its silence relay immediately. Changing a live source applies
the new AAC target the next time its browser capture reconnects.

Listeners can choose a local playback stability profile:

- **Low latency** targets roughly 3 seconds behind live.
- **Balanced** targets roughly 6 seconds and is the default.
- **Stable** targets roughly 12 seconds for inconsistent Wi-Fi or remote networks.

The relay retains a rolling 30-second HLS playlist. Playback remains at normal speed during
recovery instead of accelerating audio to catch up.

Hybrid deployments can set `PUBLIC_BASE_URL` to the tunneled listener hostname and
`CAPTURE_BASE_URL` to the LAN-only FRAME Edge address. This keeps copied listener URLs public while
capture links continue to point at the protected LAN route.

## Run Standalone

```bash
docker compose up --build -d
```

Open `http://localhost:3734/audio/admin`.

## Run In The FRAME Stack

```bash
stack.cmd install --enable frame-audio-relay
stack.cmd start
```

The service stores its registry and generated HLS segments under
`${FRAME_DATA_ROOT}/audio-monitor`.

## Current Boundaries

- Stream IDs are permanent URL identifiers. Create a new source to rename an ID.
- Listener counts track active FRAME listen pages, not direct HLS clients.
- Listener limits are enforced for FRAME listen pages; direct HLS requests are not authenticated in V1.
- Capture and admin routes are intended for LAN exposure. Hybrid/public routing should expose only
  `/audio/listen` and `/audio/hls`.
