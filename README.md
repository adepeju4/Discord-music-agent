# Discord Music Agent

A Discord music bot powered by **Gemini AI**. Unlike typical music bots that just search and play, this one uses an LLM to understand ambiguous requests, ask clarifying questions, suggest tracks for moods, and curate entire playlists on demand.

## Features

- **AI-powered `/play`** — Describe a song, a vibe, or a fragment. Gemini figures out what you want.
  - Specific request (`/play never gonna give you up`) → plays immediately
  - Ambiguous request (`/play that one sad song`) → asks you to pick from suggestions
  - Vague mood (`/play some chill vibes`) → offers curated picks
  - Non-music request (`/play what's the weather`) → politely rejects (no wasted tokens)
- **AI playlist curation** — `/playlist 90s road trip` and Gemini builds you a 10–15 track queue
- **Full playback controls** — `/skip`, `/stop`, `/pause`, `/nowplaying`, `/volume`
- **Queue management** — `/queue`, `/shuffle`, `/loop`, `/remove`, `/search`
- **Channel lock** — `/setup` creates a dedicated music channel and restricts commands to it
- **Voice-channel-only** — bot refuses to join stage channels
- **Auto-leave** after 5 minutes of inactivity

## Tech Stack

- **TypeScript** + **Node.js 22**
- **discord.js v14** + **@discordjs/voice** for Discord integration
- **Google Gemini** (`@google/generative-ai`) as the LLM brain
- **yt-dlp** + **ffmpeg** for YouTube search and audio streaming
- **Pino** for structured logging with secret redaction
- **Zod** for env var validation (fail-fast at startup)
- **Vitest** for unit tests

## Architecture

```
User → Slash Command → Command Handler → MusicAgent (per guild)
                                              ↓
                                        GeminiAgent (intent)
                                              ↓
                                    ┌─ play ─→ YouTubeService → AudioPlayer
                                    ├─ clarify → ask user
                                    ├─ suggest → offer picks
                                    ├─ playlist → curate queue
                                    └─ reject → decline politely
```

Each Discord server gets its own `MusicAgent` instance that owns the voice connection, audio player, and queue. Direct commands (`/skip`, `/pause`) bypass the LLM to save tokens.

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

## Commands

| Command | Description |
|---|---|
| `/play <query>` | Play a song, URL, or describe a vibe — Gemini interprets it |
| `/playlist <theme>` | Let Gemini curate a themed playlist |
| `/skip` | Skip the current track |
| `/stop` | Stop playback, clear the queue, and leave |
| `/pause` | Pause or resume |
| `/nowplaying` | Show the current track with progress |
| `/queue [page]` | Show the queue |
| `/volume <0-100>` | Adjust playback volume |
| `/loop <off\|track\|queue>` | Set loop mode |
| `/shuffle` | Shuffle the queue |
| `/search <query>` | Search YouTube and pick from 5 results |
| `/remove <position>` | Remove a track from the queue |
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
├── index.ts              # Entry point, graceful shutdown
├── config.ts             # Zod-validated env vars
├── deploy-commands.ts    # Slash command registration
├── musicChannels.ts      # Per-guild channel lock state
├── agent/
│   ├── GeminiAgent.ts    # LLM brain
│   ├── MusicAgent.ts     # Per-guild voice + queue + player
│   └── QueueManager.ts   # Queue with loop/shuffle
├── commands/             # 13 slash commands
├── services/
│   └── YouTubeService.ts # yt-dlp + ffmpeg pipeline
└── utils/
    ├── logger.ts         # Pino with secret redaction
    ├── embeds.ts         # Discord embed builders
    └── formatters.ts     # Duration, progress bar, truncate

tests/                    # Vitest unit + integration tests
```

## Security

- All secrets live in `.env` (never committed)
- Pino logger redacts token/apiKey/secret fields automatically
- Commands are locked to a dedicated channel when `/setup` is used
- Non-music requests are rejected by Gemini before hitting YouTube
