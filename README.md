# Discord Music Agent

A Discord music bot powered by **Gemini AI**. Unlike typical music bots that just search and play, this one uses an LLM to understand ambiguous requests, ask clarifying questions, suggest tracks for moods, and curate entire playlists on demand.

## Features

- **AI-powered `/play`** — Describe a song, a vibe, or a fragment. Gemini figures out what you want.
  - Specific request (`/play never gonna give you up`) → plays immediately
  - Ambiguous request (`/play that one sad song`) → asks you to pick from suggestions
  - Vague mood (`/play some chill vibes`) → offers curated picks
  - Non-music request (`/play what's the weather`) → politely rejects
  - Optional `insert_at:N` to drop the new track into a specific queue slot
- **LLM-picked search results** — after YouTube returns 5 candidates, Gemini picks the cleanest official audio. Official Audio > Lyric Video > Official Music Video > anything else. Regex ranker is used as a fallback.
- **Interactive `/playlist` builder** — `/playlist 90s road trip` produces a draft embed with buttons:
  - **Refine** — open a modal, tell Gemini what to change ("remove Drake, add 3 more West Coast tracks"), get a revised draft
  - **Regenerate** — same theme, fresh picks
  - **Queue it** — commit the draft and start playing
- **AI queue refinement** — `/queue` shows a **Refine with AI** button. Type an instruction, Gemini rewrites the upcoming queue (reorder, remove, add) without touching the currently playing track.
- **Bit-exact audio** — `yt-dlp` WebM/Opus piped straight to Discord with zero transcoding. `@discordjs/opus` native encoder.
- **Full playback controls** — `/skip`, `/jump to:N`, `/stop`, `/pause`, `/nowplaying`
- **Queue management** — `/queue`, `/shuffle`, `/loop`, `/remove`, `/search`
- **Channel lock** — `/setup` creates a dedicated music channel and restricts commands to it
- **Voice-channel-only** — bot refuses to join stage channels

## Tech Stack

- **TypeScript** + **Node.js 22**
- **discord.js v14** + **@discordjs/voice** + **@discordjs/opus** (native Opus encoder)
- **Google Gemini** (`@google/generative-ai`) as the LLM brain
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
                   │ • pick best of 5 search results  │
                   └──────────────────────────────────┘
                                          ↓
                          YouTubeService (yt-dlp)
                          ├── search + LLM/regex rank
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

### Reliable YouTube access (recommended)

YouTube sometimes returns "Sign in to confirm you're not a bot" when yt-dlp hits it anonymously. To avoid this, point yt-dlp at a logged-in browser session:

1. **Create a dedicated throwaway Google account** — do not use your personal one. Google may flag or lock accounts it suspects of automation.
2. **Log into YouTube in Chrome** using that throwaway account and stay logged in.
3. **Set the env var in `.env`:**
   ```
   YT_COOKIES_FROM_BROWSER=chrome
   ```
   (Other supported browsers: `firefox`, `edge`, `safari`, `brave`, `chromium`.)
4. **First run on macOS:** the Keychain may prompt once for permission to access Chrome's cookie store. Approve it.

yt-dlp reads cookies directly from the browser's local database every run — no `cookies.txt` file to manage or commit.

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

| Command | Description |
|---|---|
| `/play <query> [insert_at]` | Play a song, URL, or describe a vibe — Gemini interprets it. Optional `insert_at:N` inserts the track at a specific queue slot |
| `/playlist <theme>` | Open an interactive playlist builder — refine/regenerate via buttons, then queue it |
| `/queue [page]` | Show the queue, with a **Refine with AI** button to reorder/remove/add tracks |
| `/skip` | Skip the current track |
| `/jump <to>` | Jump to a specific position in the queue |
| `/stop` | Stop playback, clear the queue, and leave |
| `/pause` | Pause or resume |
| `/nowplaying` | Show the current track with progress |
| `/loop <off\|track\|queue>` | Set loop mode |
| `/shuffle` | Shuffle the queue |
| `/search <query>` | Search YouTube and pick from 5 results |
| `/remove <position>` | Remove a track from the queue |
| `/volume` | Info — points at Discord's per-user bot volume (the bot's pipeline is bit-exact, so no server-side volume) |
| `/setup [channel_name]` | (Admin) Create and lock a music channel |

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start the bot |
| `npm run deploy` | Register slash commands with Discord |
| `npm run build` | Compile TypeScript |
| `npm run start` | Run the compiled JS |
| `npm test` | Run unit tests |
| `npm run lint` | Lint with ESLint |
| `npm run format` | Format with Prettier |

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
│   ├── QueueManager.ts   # Queue with loop/shuffle/insert/jump/replace
│   └── playlistDrafts.ts # In-memory playlist draft store with TTL
├── commands/             # 14 slash commands
├── services/
│   └── YouTubeService.ts # yt-dlp WebM/Opus passthrough, regex ranker
└── utils/
    ├── logger.ts         # Pino with secret redaction
    ├── embeds.ts         # Discord embed builders
    ├── formatters.ts     # Duration, progress bar, truncate
    └── voiceState.ts     # Voice channel resolution helper

tests/                    # Vitest unit + integration tests
```

## Security

- All secrets live in `.env` (never committed)
- Pino logger redacts token/apiKey/secret fields automatically
- Commands are locked to a dedicated channel when `/setup` is used
- Non-music requests are rejected by Gemini before hitting YouTube
