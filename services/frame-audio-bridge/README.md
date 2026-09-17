# FRAME Audio Bridge

FRAME Audio Bridge sends Discord voice into OBS as browser-source audio and a speaking overlay.

Each streamer gets permanent OBS links, a private control page, and Discord slash commands for
starting and stopping their own mix.

## Who This Is For

FRAME Audio Bridge is for experienced Discord and OBS users who want Discord voice in a live
production.

Use it if you want to:

- Bring Discord voice into OBS without capturing the whole Discord app.
- Give each streamer their own stable OBS audio link.
- Show who is speaking with a transparent OBS overlay.
- Control delay, volume, mute, and overlay visibility from a phone or second screen.
- Let multiple streamers share one Discord voice session with separate OBS mixes.

## What You Use It For

Use Audio Bridge when Discord voice is part of the show.

Common uses:

- Add Discord guests to an OBS scene.
- Give streamers their own voice mix from the same Discord channel.
- Show active speakers on stream.
- Keep OBS links stable between sessions.
- Share private control links with trusted stream operators.

Audio Bridge is separate from FRAME Audio Monitor. Use Audio Monitor for microphones, mixer outputs,
desktop audio, or virtual audio cables.

## How To Install

Audio Bridge is optional and needs a Discord bot application before it can run.

In the Discord Developer Portal:

1. Create a Discord application.
2. Create a bot for that application.
3. Copy the bot token.
4. Copy the application client ID.
5. Turn on **Server Members Intent**.
6. Leave **Presence Intent** and **Message Content Intent** off unless you need them for another bot
   feature.

Create an OAuth/install link for the bot.

The install link must include these scopes:

- `bot`
- `applications.commands`

The bot needs these permissions:

- **View Channels**
- **Connect**

Only add this permission if you want FRAME to create or assign operator roles:

- **Manage Roles**

Do not use **Administrator** for a normal install.

Use the OAuth/install link to add the bot to your Discord server. The FRAME commands will not work
until the bot has been installed into the server.

After the Discord bot is created and installed:

1. Copy `services/frame-audio-bridge/.env.example` to `services/frame-audio-bridge/.env`.
2. Fill in at least:

```text
DISCORD_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_discord_application_client_id_here
PUBLIC_BASE_URL=http://localhost:3729
SESSION_SECRET=replace_with_a_long_random_value
```

Then import that configuration into FRAME:

```powershell
.\stack.cmd install --import-env services/frame-audio-bridge/.env
```

Enable **Discord Audio Bridge** during setup, then start the stack.

For standalone testing only:

```bash
docker compose up --build
```

Standalone mode opens on:

```text
http://localhost:3728
```

## How To Operate

In Discord, have a server admin run:

```text
/frame-admin setup
```

That creates the server setup and permanent links for the admin's bridge profile.

In OBS:

1. Add the audio URL as a Browser Source.
2. Add the overlay URL as a transparent Browser Source.
3. Keep both sources active so they can reconnect between sessions.

For each stream session:

1. Join the Discord voice channel.
2. Run `/frame start`.
3. Open the private control URL on a phone or second screen.
4. Adjust delay, mute, volume, and overlay visibility as needed.
5. Run `/frame stop` when finished.

Use `/frame links` to get your URLs again. Use `/frame reset-links` only when old links should stop
working.

To invite another streamer, have a server admin run:

```text
/frame-admin invite
```

The invited user must already be a member of the Discord server.

## Discord Setup Caveats

Discord setup has two parts: configuring the bot in the Developer Portal, then installing that bot
into your Discord server.

Use a server install link. A user-only install will not put the bot into server voice channels.

Private channel or category permissions can still block the bot, even if the server-level bot role
looks correct. The bot needs **View Channels** and **Connect** in the voice channel it will join.

If you use **Manage Roles**, the bot's role must be above the operator role in Discord's role list.

`/frame-admin` is for server admins. Users need **Manage Server** or **Administrator** to run setup
and invite operators.

`/frame-admin invite` only works for users who are already in the server.

If Discord DMs are blocked, FRAME will show the setup links so an admin can share them manually.

Discord slash commands can take a few minutes to appear after the bot starts.

Do not share control links publicly. Treat them like private production links.

## Relies Upon

Audio Bridge relies on:

- Discord
- A Discord bot application
- OBS Browser Sources
- FRAME Portal
- FRAME Edge
- FRAME shared data storage

Optional connections:

| Feature | Relies Upon |
| --- | --- |
| Public OBS access | FRAME Tunnel or configured public FRAME access |
| Private control page | The streamer's control URL |
| Portal status | FRAME Portal service token |
| Bot-managed operator roles | Discord Manage Roles permission |

## Notes For Operators

The bot listens to Discord voice and sends the mix to OBS. It does not speak back into the Discord
voice channel.

Audio and overlay links are stable, but should still be treated as private production links.

Control links are sensitive. Only share them with trusted operators.

Multiple streamers can use the same Discord voice session with separate OBS mixes.

If Audio Bridge is exposed through a tunnel or public hostname, make sure WebSockets are supported.

Each audio listener has a 96,000-byte WebSocket send-buffer limit, equivalent to 500 ms of the
48 kHz stereo 16-bit PCM stream. Before sending another complete 20 ms frame, the bridge disconnects
only listeners that would exceed that limit. Their browser sources reconnect automatically; other
listeners continue uninterrupted. This bounds the bridge's application send queue, separate from
the intentional audio delay and buffering in the network or browser.

## Mix Configuration Benchmark

Run from this service directory:

```text
npm run build
node tests/mix-inputs.bench.mjs
```

The benchmark uses the real JSON store and session mix-input derivation, with five warmed batches
of 2,000 calls per case. File setup is outside the measurement. On September 8, 2026, Node 24.17.0
on Windows with a Ryzen 7 5800X produced these per-call medians:

| Profiles / users | Config size | Config clone | Full mix-input derivation | CPU at 50 calls/sec |
| --- | --- | --- | --- | --- |
| 1 / 8 | 1.4 KB | 0.0076 ms | 0.0098 ms | 0.04% of one core |
| 8 / 64 | 33.3 KB | 0.1904 ms | 0.2825 ms | 1.33% of one core |

The full path includes the clone. It stays below 0.3 ms of the 20 ms mixer interval in these cases,
so derived-settings caching is deferred. Rerun on the deployment hardware before changing that
decision; larger guild configurations or many simultaneous guilds can change the cost.
