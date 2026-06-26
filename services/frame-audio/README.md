# FRAME Audio Monitor

FRAME Audio Monitor captures audio from a browser and gives trusted listeners a stable web link to
hear it.

It is separate from FRAME Audio Bridge. Audio Monitor is for microphones, mixer outputs, virtual
audio cables, and desktop audio feeds. Audio Bridge is for Discord voice and OBS mixes.

## Who This Is For

FRAME Audio Monitor is for streamers and operators who need a simple remote audio listen page.

Use it if you want to:

- Let a producer, moderator, or remote helper listen to a live audio feed.
- Monitor a stream mix without opening the full video feed.
- Share a stable listener link for a microphone, mixer output, or virtual audio cable.
- Keep a listener page available even when the capture computer reconnects.
- Choose between faster audio and steadier playback.

## What You Use It For

Use Audio Monitor when someone needs to hear a live source from another computer.

Common uses:

- Send a stream mix to a remote producer.
- Let staff check microphone or desktop audio during a live show.
- Give a trusted listener a browser link instead of a full production tool.
- Keep audio monitoring separate from Discord Audio Bridge.

Audio Monitor is not a public music broadcast tool. Treat listener links as trusted production
links.

## How To Install

Audio Monitor is part of the normal FRAME stack when enabled.

Recommended setup:

1. Open the FRAME folder.
2. Run `stack.cmd`.
3. Choose **Guided setup**.
4. Enable **Audio Monitor**.
5. Start the stack.
6. Open Audio Monitor:

```text
http://localhost/audio/admin
```

For standalone testing only:

1. Open this folder:

```text
services/frame-audio
```

2. Start the service:

```bash
docker compose up --build -d
```

3. Open:

```text
http://localhost:3734/audio/admin
```

Most users should use the full FRAME stack instead of standalone mode.

## How To Operate

Open the admin page:

```text
http://localhost/audio/admin
```

Create an audio source, then open its capture page on the computer that has the audio device.

On the capture page:

1. Allow microphone access when the browser asks.
2. Choose the microphone, mixer output, virtual audio cable, or desktop audio source.
3. Pick a capture preset.
4. Choose whether the page should resume capture when reopened.
5. Start capture.

The capture page remembers the selected device and capture settings in that browser. If **Resume
capture on launch** is enabled, the page will try to go live again automatically when it is reopened.

Resume works best when the same browser, same capture page, and same audio device are still
available. If the device has changed, been unplugged, or another capture page is already live, choose
the correct device and start capture manually.

On a brand-new capture page, the browser may need microphone permission before device names appear.
Allow microphone access, then use **Refresh devices** to reload the device list. Use the same button
after plugging in a new microphone, changing audio routing, or adding a virtual audio device.

Share the listener page only with people who should hear the feed.

## Best Results On Your Hardware

- Use Chrome or Edge for the capture computer when possible. Firefox is a good backup.
- Safari, iPhone, and iPad are best used for listening pages, not as the main capture device.
- Open the capture page on the capture computer with `localhost` when you can.
- If you capture from another phone or computer, use a secure `https://` address. A plain LAN
  address may not be allowed to use the microphone.
- Pick the exact microphone, virtual cable, or mixer output before going live.
- For a stream mix, send FRAME a mixer output or virtual audio cable instead of a room microphone.
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

## Operating System Notes

Audio Monitor is currently best tested on Windows.

macOS and Linux may work, but should be treated as best-effort until they have been checked in your
setup.

On macOS, make sure the browser has microphone permission in system privacy settings. If you use
virtual audio routing, confirm the virtual device appears in the browser device list before going
live.

On Linux, audio device names and routing can vary depending on the system audio setup. After changing
audio devices or routing, refresh the device list or restart the browser if the expected device does
not appear.

For listeners, most modern browsers should work. For capture, Chrome or Edge are the safest first
choice.

## Relies Upon

Audio Monitor relies on:

- FRAME Portal
- FRAME Edge
- FRAME shared data storage
- The browser on the capture computer
- The audio device, mixer output, or virtual audio cable you select

Optional connections:

| Feature | Relies Upon |
| --- | --- |
| Public listener links | FRAME Tunnel or configured public FRAME access |
| OBS monitoring workflow | OBS, a mixer output, or a virtual audio cable |
| Discord voice mixes | FRAME Audio Bridge instead of Audio Monitor |

## Notes For Operators

Only one capture page can publish to a source at a time.

Always-on sources keep the listener page available while capture is offline, then reconnect when the
capture computer comes back.

Capture and admin pages should stay local or login-protected. Public routing should expose only the
listener pages needed by trusted users.
