# FRAME Audio Bridge

FRAME Audio Bridge is a Discord bot plus web server for OBS browser sources. Each streamer gets permanent OBS URLs, while live voice sessions can be started and stopped with `/frame` slash commands.

The MVP implements Discord login, slash command registration, guild config persistence, stable URLs, control WebSocket updates, voice-channel joining, speaking-state overlays, and PCM receive/decode/mix for OBS audio browser sources.

Within the Syronius FRAME repository, this is the optional `frame-audio-bridge` service represented
by the `frame-discord-audio-bridge` capability. It is separate from the browser-capture/HLS
`frame-audio` monitor and can be deployed independently.

## Features

- Permanent per-streamer bridge URLs:
  - `/bridge/:guildKey/audio`
  - `/bridge/:guildKey/overlay`
  - `/bridge/:guildKey/control?token=...`
- Slash commands:
  - `/frame info`
  - `/frame start`
  - `/frame stop`
  - `/frame status`
  - `/frame control`
  - `/frame links`
  - `/frame reset-links`
  - `/frame-admin setup`
  - `/frame-admin invite`
- JSON persistence under `DATA_DIR`.
- Mobile-first control page with delay, layout, per-user mute, per-user volume, and overlay hide/show controls.
- Transparent OBS overlay using Discord display names and Discord avatars.
- Optional readonly OBS token for audio/overlay browser sources.
- Session idle timeout and configurable empty-channel timeout.
- One shared Discord voice receiver per guild with separate streamer mixes.

## Discord Application Setup

1. Create an application in the Discord Developer Portal.
2. Open **Bot**, create a bot, and copy the bot token into `DISCORD_TOKEN`.
3. Copy the application client ID into `DISCORD_CLIENT_ID`.
4. In **Bot > Privileged Gateway Intents**, enable:
   - Server Members Intent
   - Voice States Intent
5. Invite the bot with these scopes:
   - `bot`
   - `applications.commands`
6. Grant the bot only the permissions it needs in streamer guilds:
   - View Channels
   - Connect
   - Manage Roles, only if you want `/frame-admin setup` and `/frame-admin invite` to create/assign the operator role

Least-invasive install options:

- Manual role management: View Channels + Connect (`permissions=1049600`).
- Bot-managed operator role: View Channels + Connect + Manage Roles (`permissions=269485056`).
- Do not request Administrator for normal installs.
- Speak and Use Voice Activity are not required because FRAME Audio Bridge listens to Discord voice and sends the mixed audio to OBS, not back into Discord.

Invite URL template:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&scope=bot%20applications.commands&permissions=269485056
```

Use Discord's provided install link unless you are building a separate website login flow. The Discord-provided link is already an OAuth2 install URL for guild installs.

Global slash commands are registered at startup. Discord can take a few minutes to show updated global commands.

## Environment

Copy `.env.example` to `.env` and fill in the values:

```bash
DISCORD_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_discord_application_client_id_here
PUBLIC_BASE_URL=https://your-public-host.example
PORT=3728
SESSION_SECRET=replace_with_a_long_random_value
DEFAULT_AUDIO_DELAY_MS=2000
MAX_AUDIO_DELAY_MS=10000
SESSION_IDLE_TIMEOUT_MINUTES=30
DATA_DIR=./data
```

Optional OBS readonly token:

```bash
READONLY_OBS_TOKEN=replace_with_random_readonly_token
```

When `READONLY_OBS_TOKEN` is set, `/frame-admin setup` includes `?obsToken=...` on the permanent audio and overlay URLs. The control token is separate and only appears in the private control URL.

## Run With Docker Compose

```bash
docker compose up --build
```

The app listens on `PORT` and stores guild configs in the `frame-audio-bridge-data` Docker volume at `/data`.

The Compose file treats `.env` as optional so `docker compose config` can run in clean checkouts. The app still requires valid Discord values before it can start successfully.

## Run Locally

```bash
npm install
npm run dev
```

For a production-style local run:

```bash
npm run build
npm start
```

## Optional Cloudflare Worker Proxy

`cloudflare-worker.js` can sit in front of a Cloudflare Tunnel hostname and return an empty response
when the tunnel or bridge is unavailable. Deploy it as a Worker route on the public OBS hostname,
then configure this Worker environment variable:

```text
ORIGIN_HOST=your-private-tunnel-origin.example
```

Keep the Worker hostname and `ORIGIN_HOST` different to avoid a proxy loop. WebSocket requests are
passed through while the bridge is online, so audio, overlay, and control updates continue to work.

## OBS Setup

1. In Discord, have a server admin run `/frame-admin setup`.
   - Optional: `operator-role-name:"IRL Streamer"` creates and configures an operator role.
   - Optional: `operator-role:@Role` uses an existing operator role.
   - Optional: `empty-channel-timeout-minutes:5` disconnects after the bot is alone in voice for that long.
2. Add an OBS Browser Source for the permanent audio URL.
   - The page is visually blank.
   - Keep the source active so it can reconnect between sessions.
3. Add an OBS Browser Source for the permanent overlay URL.
   - Enable transparency in OBS.
   - Use a canvas-sized browser source, for example 1920x1080.
4. Open the private control URL on a phone or stream deck browser.
5. Join a Discord voice channel and run `/frame start`.
6. Run `/frame stop` when finished.

The OBS URLs are stable for that streamer profile. They only change if `/frame reset-links` is used.

## Multi-Streamer Flow

FRAME Audio Bridge separates the Discord voice session from streamer bridge profiles:

- The bot joins a guild voice channel once.
- Each streamer has their own audio URL, overlay URL, control URL, delay, mute/volume settings, and overlay settings.
- If a voice session is already active in one channel, `/frame start` from a different channel is rejected instead of moving the bot.
- Multiple streamers in the same voice channel each run `/frame start` to activate their own mix.
- `/frame stop` stops only the caller's mix. The bot disconnects only when no streamer mixes remain active.

To invite another streamer:

1. Run `/frame-admin setup operator-role-name:"IRL Streamer"` once, or set an existing operator role with `/frame-admin setup operator-role:@Role`.
2. Run `/frame-admin invite user:@Streamer`.
3. The bot assigns the operator role, creates that user's bridge profile, and DMs their OBS/control URLs.
4. If the user blocks server DMs, the command response includes the links so an admin can share them manually.
5. Operators can run `/frame links` any time to retrieve their permanent OBS and control URLs.

## Audio Pipeline Status

This MVP joins voice, receives Discord Opus streams, decodes them with `prism-media` plus `opusscript`, mixes users into stereo PCM, applies the global delay, and sends delayed PCM chunks to the OBS audio browser source.

- `src/voice/receiver.ts` subscribes to Discord receive streams.
- `src/voice/mixer.ts` applies each profile's mute/volume settings and emits stereo PCM chunks.
- `src/voice/delayBuffer.ts` delays chunks before WebSocket delivery.
- `public/audio.html` accepts stereo 48 kHz signed 16-bit PCM binary WebSocket chunks and schedules playback.

The current engine is intentionally simple and tick-based. It should be good enough for MVP testing, but production tuning should focus on jitter buffering, clipping behavior, and long-session drift.

## Security Notes

- Control pages require the per-profile `controlToken`.
- Audio and overlay pages are tokenless by default, but use an unguessable random bridge key.
- Set `READONLY_OBS_TOKEN` if you want audio and overlay URLs to require a shared readonly query token.
- Discord bot tokens and control tokens are never embedded in the static client files.
- JSON storage is an MVP implementation behind `GuildConfigStore`, so replacing it with SQLite or Postgres later should be straightforward.

## Project Layout

```text
.
|-- Dockerfile
|-- docker-compose.yml
|-- package.json
|-- tsconfig.json
|-- .env.example
|-- README.md
|-- src/
|   |-- index.ts
|   |-- config.ts
|   |-- bot/
|   |-- voice/
|   |-- sessions/
|   |-- storage/
|   `-- web/
`-- public/
    |-- audio.html
    |-- overlay.html
    |-- control.html
    |-- control.js
    |-- overlay.js
    `-- styles.css
```
