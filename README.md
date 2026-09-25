# Discord Music Agent

A Discord music bot powered by **Gemini AI**. Unlike typical music bots that just search and play, this one uses an LLM to understand ambiguous requests, ask clarifying questions, suggest tracks for moods, and curate entire playlists on demand.

## Features

- **AI-powered `/play`** — Describe a song, a vibe, or a fragment. Gemini figures out what you want.
  - Specific request (`/play never gonna give you up`) → plays immediately
  - Ambiguous request (`/play that one sad song`) → asks you to pick from suggestions
  - Vague mood (`/play some chill vibes`) → offers curated picks
  - Non-music request (`/play what's the weather`) → politely rejects
  - Whole album (`/play ayra starr's album`) → queues the album straight from the YouTube Music catalog; if you didn't name one, you pick from her albums (with years)
  - Optional `insert_at:N` to drop the new track into a specific queue slot
- **Stations** — `/play songs like Rush` or `/play more like this` builds a real radio station from the catalog's recommendation graph: 25 tracks with no search and no guessing.
- **Real playlists, not invented ones** — `/play chill afrobeats` finds playlists people actually made for that vibe and queues the one you pick. `/playlist <theme>` still builds a custom draft, but now picks from those real tracks instead of inventing titles from memory.
- **Recency you can dial** — `/playlist <theme> recent:60` mixes roughly 60% current releases with 40% established tracks (60% is the default). Gemini's training data can't know this year's music, so the recent half comes from playlists people built for the current year.
- **Spotify & Apple Music links** — paste a track, album or playlist link and it's queued. Audio is never streamed from either service: each track's metadata is matched against the YouTube Music catalog (title + artist + duration), so you get the same studio masters. Neither service needs credentials — Spotify links fall back to the public embed page, which is also the only way to read playlists now (see below). YouTube/YouTube Music playlist links work too, and skip matching entirely.
- **Studio recordings, not music videos** — every search hits the YouTube Music catalog (the label-uploaded masters, same as Spotify) alongside regular YouTube. Catalog results come with artist, album and cover art.
- **LLM-picked search results** — Gemini picks the best candidate from both sources. Catalog song > Official Audio > Lyric Video > Official Music Video > anything else; falls back to regular YouTube for DJ sets, live sets, podcasts and other non-catalog content. Regex ranker is used as a fallback.
- **Interactive `/playlist` builder** — `/playlist 90s road trip` produces a draft embed with buttons:
  - **Refine** — open a modal, tell Gemini what to change ("remove Drake, add 3 more West Coast tracks"), get a revised draft
  - **Regenerate** — same theme, fresh picks
  - **Queue it** — commit the draft and start playing
- **AI queue refinement** — `/queue` shows a **Refine with AI** button. Type an instruction, Gemini rewrites the upcoming queue (reorder, remove, add) without touching the currently playing track.
- **Bit-exact audio** — `yt-dlp` WebM/Opus piped straight to Discord with zero transcoding, as long as volume is at 100%. `@discordjs/opus` native encoder.

### Audio quality notes

- **Raise the voice channel bitrate.** Discord defaults channels to 64 kbps; the source is ~130 kbps. Server Settings → the voice channel → Bitrate. Unboosted servers allow up to 96 kbps, boosted servers more.
- **Muffled audio on mobile while your mic is on** is the Discord app, not the bot: with a live mic the phone switches into call-processing mode. In the mobile app, Settings → Voice & Video, turn off _Echo Cancellation_, _Noise Suppression_ and _Automatic Gain Control_, and set _Attenuation_ to 0% (attenuation deliberately ducks other audio when someone speaks).
- **Full playback controls** — `/skip`, `/jump to:N`, `/stop`, `/pause`, `/nowplaying`
- **Now playing panel** — every track posts its own message with ⏮ ▶ ⏸ ⏭ ⏹ and volume controls. The previous track's panel is removed so old buttons can't act on the current song.
- **Gapless handover** — the next track's audio is fetched while the current one plays, so track changes are instant instead of the ~2.5s yt-dlp cold start.
- **Shared volume** — the panel's 🔉/🔊 buttons and `/volume` set the level for everyone in the channel. At 100% audio stays bit-exact; any other level re-encodes at 128 kbps, so the cost is only paid when you use it.
- **Queue management** — `/queue`, `/shuffle`, `/loop`, `/remove`, `/search`
- **Channel lock** — `/setup` creates a dedicated music channel and restricts commands to it
- **Voice-channel-only** — bot refuses to join stage channels

## Tech Stack

- **TypeScript** + **Node.js 22**
- **discord.js v14** + **@discordjs/voice** + **@discordjs/opus** (native Opus encoder)
- **Google Gemini** (`@google/generative-ai`) as the LLM brain
- **youtubei.js** for YouTube Music catalog search (InnerTube, no API key)
- **yt-dlp** for YouTube search and audio extraction (WebM/Opus passthrough)
- **Pino** for structured logging with correlation IDs and secret redaction
- **Zod** for env var validation (fail-fast at startup)
- **Vitest** for unit tests

## Architecture

```
User → Slash Command / Button / Modal → Router (index.ts)
                                          ↓
                                   MusicAgent (per guild)
                                          ↓
                   ┌─────────── GeminiAgent ──────────┐
                   │ • interpret (play intent)        │
                   │ • curate playlist draft          │
                   │ • refine draft / refine queue    │
                   │ • pick best search candidate     │
                   │ • curate from real catalog tracks │
                   └──────────────────────────────────┘
                                          ↓
                          YouTubeService
                          ├── YouTube Music catalog (youtubei.js)
                          │     songs · albums · playlists · radio
                          ├── YouTube search (yt-dlp)
                          ├── merge + LLM/regex rank
                          └── WebM/Opus passthrough → AudioPlayer
```

Each Discord server gets its own `MusicAgent` instance that owns the voice connection, audio player, and queue. Direct commands (`/skip`, `/pause`, `/jump`) bypass the LLM. Playlist drafts are keyed per-user with a 5-minute idle TTL.

## Prerequisites

This bot is **self-hosted** — YouTube blocks datacenter IPs, so running it on a cloud VPS will fail most of the time. Run it on your own machine or a home server (Raspberry Pi works great).

- **Node.js 22+** (use [nvm](https://github.com/nvm-sh/nvm))
- **yt-dlp** — `brew install yt-dlp` (macOS) or [see install guide](https://github.com/yt-dlp/yt-dlp#installation)
- **ffmpeg** — `brew install ffmpeg` (macOS) or your distro's package manager
- A **Discord bot token** — [Discord Developer Portal](https://discord.com/developers/applications)
- A **Gemini API key** — [Google AI Studio](https://aistudio.google.com/apikey)

## Setup

1. Clone the repo and install dependencies:

   ```bash
   git clone <repo>
   cd discord-music-bot
   npm install
   ```

2. Create a `.env` file based on `.env.example`:

   ```
   DISCORD_TOKEN=your_bot_token
   CLIENT_ID=your_application_id
   GEMINI_API_KEY=your_gemini_key
   ```

3. Register slash commands with Discord:

   ```bash
   npm run deploy
   ```

4. Start the bot:

   ```bash
   npm run dev
   ```

5. In your Discord server:
   - Invite the bot (Bot + `applications.commands` scope, with Connect + Speak + Send Messages + Embed Links + Manage Channels permissions)
   - Run `/setup` in any text channel to create a `#music` channel and lock commands to it
   - Join a voice channel and try `/play`

### Spotify links (optional)

1. Create an app at the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) — any name, any redirect URI, choose the Web API.
2. Copy its Client ID and Client Secret into `.env`:
   ```
   SPOTIFY_CLIENT_ID=...
   SPOTIFY_CLIENT_SECRET=...
   ```
3. Restart the bot. `/play https://open.spotify.com/album/...` now works for tracks, albums and playlists (first 100 tracks of a playlist).

Credentials are optional. Spotify has withdrawn playlist track access from app-only tokens — `/playlists/{id}/tracks` answers **403 Forbidden** and the playlist object no longer embeds its tracks — along with the whole recommendations/related-artists API. The bot therefore falls back to Spotify's public embed page, which still lists up to 100 tracks and needs no credentials; editorial playlists like _Today's Top Hits_ and _RapCaviar_ work this way. Credentials are still worth setting because albums and single tracks resolve through the Web API with exact artist metadata.

### Reliable YouTube access (recommended)

YouTube sometimes returns "Sign in to confirm you're not a bot" when yt-dlp hits it anonymously. The fix is to give yt-dlp a logged-in cookie store. There are two ways.

#### Option A — cached cookies file (recommended)

Extract cookies from your browser **once**, save them to a file, and the bot reads the file for every subsequent request. This avoids the macOS Keychain prompting on every yt-dlp reinstall / Homebrew update.

1. **Create a dedicated throwaway Google account** — do not use your personal one.
2. **Log into YouTube in Chrome** (or another supported browser) with that account and stay logged in.
3. **Set both env vars in `.env`:**
   ```
   YT_COOKIES_FROM_BROWSER=chrome
   YT_COOKIES_FILE=/Users/your-username/.yt-cookies.txt
   ```
4. **Run the one-time extraction:**
   ```bash
   npm run refresh-cookies
   ```
   The Keychain will prompt **once** — click "Always Allow." After that, the bot uses the file directly with no further Keychain access.
5. **When cookies expire** (usually weeks to months), re-run `npm run refresh-cookies`.

#### Option B — direct browser cookies

Simpler but prompts Keychain every time yt-dlp is updated.

1. Same throwaway-account setup as above.
2. Set only:
   ```
   YT_COOKIES_FROM_BROWSER=chrome
   ```
3. yt-dlp reads from the browser's cookie store on every request. Keychain will prompt whenever Homebrew re-installs yt-dlp and you'll need to approve it again.

`YT_COOKIES_FILE` takes precedence if both are set, so leaving `YT_COOKIES_FROM_BROWSER=chrome` in place is actually useful — `npm run refresh-cookies` reads it to know which browser to extract from.

### Audio quality checklist

The bot ships bit-exact Opus to Discord, but Discord-side settings still matter:

1. **Raise the voice channel bitrate.** Default is 64 kbps which crushes music. Right-click the channel → Edit Channel → Bitrate → bump to at least 96 (or higher if your server has boosts).
2. **Every listener should disable Discord's voice processing** — it's tuned for calls and mangles music. User Settings → Voice & Video:
   - Noise Suppression → **None**
   - Echo Cancellation → **off**
   - Automatic Gain Control → **off**
   - Attenuation (both sliders) → **0%**
3. **On mobile with Bluetooth headsets**, don't set the headset as your mic input — that forces the OS into HFP (phone call profile) which downgrades the playback codec for the whole Discord session. Use your phone's built-in mic or a separate mic.

## Commands

| Command                      | Description                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/play <query> [insert_at]`  | Play a song, a YouTube/Spotify/Apple Music link, an album, a station ("songs like X"), or a vibe — Gemini interprets it. Optional `insert_at:N` inserts the track at a specific queue slot |
| `/playlist <theme> [recent]` | Open an interactive playlist builder — refine/regenerate via buttons, then queue it. `recent:0-100` sets how much should be current releases (default 60)                                  |
| `/queue [page]`              | Show the queue, with a **Refine with AI** button to reorder/remove/add tracks                                                                                                              |
| `/skip`                      | Skip the current track                                                                                                                                                                     |
| `/jump <to>`                 | Jump to a specific position in the queue                                                                                                                                                   |
| `/stop`                      | Stop playback, clear the queue, and leave                                                                                                                                                  |
| `/pause`                     | Pause or resume                                                                                                                                                                            |
| `/nowplaying`                | Show the current track with progress                                                                                                                                                       |
| `/loop <off\|track\|queue>`  | Set loop mode                                                                                                                                                                              |
| `/shuffle`                   | Shuffle the queue                                                                                                                                                                          |
| `/search <query>`            | Search YouTube and pick from 5 results                                                                                                                                                     |
| `/volume [level]`            | Set playback volume (0-200%) for everyone, or show the current level                                                                                                                       |
| `/remove <position>`         | Remove a track from the queue                                                                                                                                                              |
| `/volume`                    | Info — points at Discord's per-user bot volume (the bot's pipeline is bit-exact, so no server-side volume)                                                                                 |
| `/setup [channel_name]`      | (Admin) Create and lock a music channel                                                                                                                                                    |

## Scripts

| Script                    | Description                                                                                           |
| ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `npm run dev`             | Start the bot                                                                                         |
| `npm run deploy`          | Register slash commands with Discord                                                                  |
| `npm run refresh-cookies` | Extract YouTube cookies from your browser to `YT_COOKIES_FILE` (run once, re-run when cookies expire) |
| `npm run build`           | Compile TypeScript                                                                                    |
| `npm run start`           | Run the compiled JS                                                                                   |
| `npm test`                | Run unit tests                                                                                        |
| `npm run lint`            | Lint with ESLint                                                                                      |
| `npm run format`          | Format with Prettier                                                                                  |

## Project Structure

```
src/
├── index.ts              # Entry point, interaction router, graceful shutdown
├── config.ts             # Zod-validated env vars
├── deploy-commands.ts    # Slash command registration
├── musicChannels.ts      # Per-guild channel lock state
├── agent/
│   ├── GeminiAgent.ts    # LLM brain: interpret, curate, refine, pick
│   ├── MusicAgent.ts     # Per-guild voice + queue + player
│   ├── NowPlayingPanel.ts # Per-track now playing message with transport controls
│   ├── resolveTracks.ts  # Match {title, artist, duration} intents to catalog tracks
│   ├── QueueManager.ts   # Queue with loop/shuffle/insert/jump/replace
│   └── playlistDrafts.ts # In-memory playlist draft store with TTL
├── commands/             # 14 slash commands
├── services/
│   ├── AppleMusicService.ts # Apple Music link parsing + playlist/album scraping
│   ├── SpotifyService.ts # Spotify link parsing + Web API metadata (client credentials)
│   ├── YouTubeMusicService.ts # YouTube Music catalog: songs, albums, playlists, radio
│   └── YouTubeService.ts # yt-dlp search + WebM/Opus passthrough, merge + regex ranker
└── utils/
    ├── logger.ts         # Pino with secret redaction
    ├── embeds.ts         # Discord embed builders
    ├── formatters.ts     # Duration, progress bar, truncate
    └── voiceState.ts     # Voice channel resolution helper

tests/                    # Vitest unit + integration tests
```

## Deploying to a Linux host (VPS or Raspberry Pi)

Works on any Debian/Ubuntu box — a VPS, or a Pi 4/5 on 64-bit Raspberry Pi OS with 2GB+ RAM.

**Choosing between a VPS and a Pi:** a VPS gives better uptime and needs no compiling on x86. A Pi at home runs on a residential IP, which YouTube challenges far less often than datacenter ranges — the single biggest reliability factor for this bot. Cookies (below) are what make a VPS workable.

### One-shot setup

```bash
git clone https://github.com/adepeju4/Discord-music-agent.git
cd Discord-music-agent
sudo ./deploy/setup.sh
```

The script installs Node 22, ffmpeg, yt-dlp and the dependencies, builds the project, then installs and starts a `discord-music` systemd service. It is safe to re-run — that is also how you deploy an update:

```bash
git pull && sudo ./deploy/setup.sh
```

On the first run it creates `.env` from the example and stops so you can fill in `DISCORD_TOKEN`, `CLIENT_ID` and `GEMINI_API_KEY`.

### Cookies on a headless host

`npm run refresh-cookies` needs a logged-in browser, so it cannot run on a server. Generate the file on a machine that has one and copy it over:

```bash
# on your laptop
npm run refresh-cookies
scp ~/.yt-cookies.txt user@your-server:~/.yt-cookies.txt
```

Then in the server's `.env`, set `YT_COOKIES_FILE=/home/<user>/.yt-cookies.txt` and **remove `YT_COOKIES_FROM_BROWSER`** — there is no browser or keychain there, and leaving it set only produces confusing failures.

### Day to day

```bash
journalctl -u discord-music -f          # logs
sudo systemctl restart discord-music    # restart
npm run deploy                          # re-register slash commands after they change
```

### Performance and upkeep notes

- **Keep volume at 100%** on low-powered hosts. Passthrough just copies Opus packets and is nearly free; any other volume decodes and re-encodes on the CPU.
- yt-dlp starts slower on a Pi than on a laptop, so playlist imports take longer. Prefetching hides this between tracks; the first track after silence still pays the cost.
- Update yt-dlp on a schedule — most "it suddenly stopped playing" reports are a stale yt-dlp after YouTube changes something:
  ```bash
  pip3 install --user --upgrade yt-dlp && sudo systemctl restart discord-music
  ```
- Expect YouTube's "confirm you're not a bot" check more often on datacenter IPs than at home. Valid cookies are what keep a VPS working; the bot now tells you in-channel when they expire.

## Security

- All secrets live in `.env` (never committed)
- Pino logger redacts token/apiKey/secret fields automatically
- Commands are locked to a dedicated channel when `/setup` is used
- Non-music requests are rejected by Gemini before hitting YouTube
