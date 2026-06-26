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

Listeners can choose how much delay to trade for smoother playback:

- **Near realtime** is the fastest option. Use it on a strong local network.
- **Low latency** is still quick, with a little more room for small network hiccups.
- **Balanced** is the default and the best first choice for most listeners.
- **Stable** adds the most delay, but is the best choice for weak Wi-Fi or remote listeners.

The relay retains a rolling 30-second HLS playlist. Playback remains at normal speed during
recovery instead of accelerating audio to catch up.

Hybrid deployments can set `PUBLIC_BASE_URL` to the tunneled listener hostname and
`CAPTURE_BASE_URL` to the LAN-only FRAME Edge address. This keeps copied listener URLs public while
capture links continue to point at the protected LAN route.

## Best Results On Your Hardware

- Use the latest Chrome or Edge for the capture page. Firefox is a good backup.
- Safari, iPhone, and iPad are best used for listening pages, not as the main capture device.
- Open the capture page on the capture computer with `localhost` when you can.
- If you capture from another phone or computer, use a secure `https://` address. A plain LAN address
  may not be allowed to use the microphone.
- Pick the exact microphone, virtual cable, or mixer output in the capture page before going live.
- For a stream mix, send FRAME a virtual cable or mixer output instead of a room microphone.
- Set the audio device or mixer output to 48 kHz when your audio software offers that choice.
- Avoid letting another app take exclusive control of the same audio device.
- Keep the capture computer plugged in and awake. Turn off sleep mode and battery saver for long
  sessions.
- Use wired Ethernet when possible. If you use Wi-Fi, prefer a strong 5 GHz or 6 GHz connection.
- Start with **Music / Desktop** for stream audio, **Voice** for microphone-only audio, and
  **Maximum Quality** only after the connection has proven stable.
- If a listener needs the fastest possible sound, try **Near realtime** first.
- If playback gets choppy, move one step slower: **Near realtime** to **Low latency**, then
  **Balanced**, then **Stable**.
- On low-power computers, keep fewer always-on sources active and start with `128`-`160 kbps` output
  quality.

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
