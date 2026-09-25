import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config';
import { childLogger, createCorrelationId } from '../utils/logger';
import type { TrackInfo } from '../utils/embeds';

const log = childLogger({ module: 'GeminiAgent' });

// gemini-3-flash-preview spends "thinking" tokens out of the same budget as the
// reply, and they routinely dwarf the JSON we actually want. These caps are the
// measured worst case plus headroom — too low and the reply is truncated
// mid-JSON, which surfaces as a silent fallback to the regex ranker.
const TOKEN_BUDGET = {
  pickSingle: 4096,
  pickBatch: 16384,
  interpret: 4096,
  playlist: 16384,
  refine: 8192,
} as const;

export interface PickCandidate {
  title: string;
  channel?: string;
  duration: number;
  album?: string;
  source?: 'music' | 'video';
}

function describeCandidate(c: PickCandidate): string {
  if (c.source === 'music') {
    const album = c.album ? `, album: "${c.album}"` : '';
    return `[CATALOG] "${c.title}" — artist: ${c.channel ?? 'Unknown'}${album}, duration: ${c.duration}s`;
  }
  return `[VIDEO] "${c.title}" — channel: ${c.channel ?? 'Unknown'}, duration: ${c.duration}s`;
}

export interface GeminiPlayAction {
  action: 'play';
  query: string;
  message: string;
}

export interface GeminiClarifyAction {
  action: 'clarify';
  message: string;
  suggestions: string[];
}

export interface GeminiSuggestAction {
  action: 'suggest';
  message: string;
  suggestions: string[];
}

export interface GeminiPlaylistAction {
  action: 'playlist';
  message: string;
  tracks: Array<{ title: string; artist: string }>;
}

export interface GeminiAlbumAction {
  action: 'album';
  artist: string;
  album?: string | null;
  message: string;
}

export interface GeminiRadioAction {
  action: 'radio';
  seed: string;
  message: string;
}

export interface GeminiCuratedAction {
  action: 'curated';
  theme: string;
  message: string;
}

export interface GeminiRejectAction {
  action: 'reject';
  message: string;
}

export type GeminiAction =
  | GeminiPlayAction
  | GeminiClarifyAction
  | GeminiSuggestAction
  | GeminiPlaylistAction
  | GeminiAlbumAction
  | GeminiRadioAction
  | GeminiCuratedAction
  | GeminiRejectAction;

const SYSTEM_PROMPT = `You are a music assistant for a Discord bot. You ONLY handle music-related requests. Nothing else.

Given a user's request, respond with a JSON object. Pick ONE action:

1. **play** — You're confident about the exact song. Return:
   {"action": "play", "query": "<search query for YouTube>", "message": "Now searching for <song>..."}
   The query should normally be "<song title> by <artist>", BUT you MUST preserve any disambiguation the user gave:
   - If the user excludes a version ("not the one with X", "not the remix", "original version"), include that exclusion or the word "original"/"solo"/"album version" in the query so YouTube returns the right result.
   - If the user specifies a live/acoustic/remix/cover version, include that.
   - If the user specifies a year, album, or featured artist, include that.
   Example: "stateside by pinkpantheress, not the one with zara larsson" → query: "Stateside PinkPantheress original solo version"
   Example: "hello adele live" → query: "Hello Adele live"

2. **clarify** — The request is too ambiguous. Return:
   {"action": "clarify", "message": "<friendly question>", "suggestions": ["Song - Artist", "Song - Artist", ...]}
   Provide 3-5 suggestions.

3. **radio** — The user wants more music like something: "songs like X", "more of this", "keep it going", "radio off this", "similar to <artist>". Return:
   {"action": "radio", "seed": "<song title by artist to seed from>", "message": "<friendly message>"}
   Use the currently playing track as the seed when the user says "this"/"that" and something is playing. The bot builds a real radio station from the catalog — do NOT list tracks yourself.

4. **curated** — The user describes a mood, genre, activity or vibe: "chill vibes", "afrobeats party", "study music", "90s r&b", "something to cook to". Return:
   {"action": "curated", "theme": "<2-5 word search phrase for a real playlist>", "message": "<friendly message>"}
   The theme is used to find REAL playlists in the music catalog, so phrase it the way a playlist would be named ("chill afrobeats", "90s r&b slow jams"). Do NOT list tracks yourself.

5. **suggest** — Use ONLY when the user should choose between a few specific songs you can name, and neither radio nor curated fits. Return:
   {"action": "suggest", "message": "<friendly message>", "suggestions": ["Song - Artist", "Song - Artist", ...]}
   Provide 3-5 suggestions the user can pick from.

6. **playlist** — Either of these:
   (a) The user named SEVERAL specific tracks in one request ("play X and Y", "queue A, B and C"). List EXACTLY the tracks they named, in their order, and add nothing of your own.
   (b) The user asked for a playlist built around a creative or very specific idea that a real playlist search would not match ("songs that sound like driving at 3am", "tracks that sample Fela"). Prefer "curated" for ordinary moods and genres.
   Return:
   {"action": "playlist", "message": "<friendly message about the playlist>", "tracks": [{"title": "...", "artist": "..."}, ...]}
   Provide 10-15 tracks.

7. **album** — The user wants a whole album (or EP) by an artist, e.g. "play Ayra Starr's album", "queue The Year I Turned 21", "play Burna Boy's latest album". Return:
   {"action": "album", "artist": "<artist name>", "album": "<album title if the user named or clearly implied one, otherwise null>", "message": "<friendly message>"}
   Do NOT list the tracks yourself. If you know which album they mean (e.g. "her debut album"), fill in the title. Leave it null if they just said "an album" / "their album", OR if they used a relative word like "latest", "newest", "new" or "most recent" — your knowledge of recent releases may be stale, and the bot will offer real choices with years.

8. **reject** — The request is NOT about music. Return:
   {"action": "reject", "message": "I'm a music bot — I can only help with playing songs, playlists, and music recommendations!"}

Rules:
- STRICTLY music only. If the request is not about playing music, finding songs, describing a mood/vibe for music, or requesting a playlist, ALWAYS use "reject". No exceptions.
- Do NOT answer general questions, trivia, jokes, coding help, math, or anything unrelated to music playback.
- If the user gives a specific song name AND artist, use "play".
- If the user names more than one specific track in a single request, use "playlist" with exactly those tracks — never drop one and never pad the list.
- If the user gives a specific song name but no artist, and the song is well-known enough to be unambiguous, use "play". Otherwise "clarify".
- If the user describes a mood, genre, or vibe, use "curated" — real playlists beat invented track lists.
- If the user wants more music like something, use "radio".
- Only use "playlist" when the theme is too creative or specific for a real playlist search to match.
- Use "album" whenever the user asks for an album, EP, or record by an artist — never turn it into a "playlist".
- Always include the artist in your query for "play" actions.
- Keep messages short and friendly.
- ONLY return valid JSON. No markdown, no code fences, no extra text.`;

export const DEFAULT_RECENT_SHARE = 60;

export interface ThemePools {
  recent?: Array<{ title: string; artist?: string }>;
  classic?: Array<{ title: string; artist?: string }>;
}

const PLAYLIST_BUILDER_PROMPT = `You build music playlists. You ONLY return JSON — no markdown, no code fences, no extra text.

Return exactly this shape:
{"action": "playlist", "message": "<one-line friendly summary of the playlist>", "tracks": [{"title": "...", "artist": "..."}, ...]}

Rules:
- Return 12-15 tracks.
- "title" is the song title alone and "artist" is the performing artist — never combine them in one field.
- Never repeat the same track, and never use the same artist more than twice.
- Order the tracks so the set flows as a listening experience.
- If the request is not about music, still return the JSON shape with an empty "tracks" array.`;

export class GeminiAgent {
  private model;

  constructor() {
    const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);
    this.model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
  }

  async pickBestSingle(
    intent: { title?: string; artist?: string; rawQuery?: string },
    candidates: PickCandidate[],
  ): Promise<number | null> {
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return 0;

    const correlationId = createCorrelationId();
    const intentLine =
      intent.title && intent.artist
        ? `"${intent.title}" by ${intent.artist}`
        : intent.rawQuery
          ? `user query: "${intent.rawQuery}"`
          : '(unknown)';

    const numbered = candidates.map((c, i) => `${i}. ${describeCandidate(c)}`).join('\n');

    const prompt = `You are picking the best YouTube search result for a music track. The goal is the CLEANEST, most-studio-identical audio (the listener will only hear sound — no video).

Intended track: ${intentLine}

Candidates:
${numbered}

Rank preferences from HIGHEST to LOWEST:
1. [CATALOG] entries — the official studio recording from the YouTube Music catalog (same master as Spotify/Apple Music). Pick one whenever its title and artist match the intended track. Only skip catalog entries when the user clearly wants something the catalog doesn't hold (a DJ set, live set, podcast, mix, specific remix, or a non-music video), or when none of them is actually the intended track.
2. "Official Audio" uploads — pure studio master, no video
3. Uploads from "<Artist> - Topic" channels — auto-generated YouTube Music uploads, always clean studio audio
4. "Lyric Video" or "Lyrics" from the artist or label channel — untouched studio audio with text overlay
5. Plain title from the artist's own channel with NO video descriptor (e.g. just "Billie Jean" by "Michael Jackson") — usually the album audio, cleaner than a music video
6. "Official Music Video" — may have intros, outros, dialogue, sound effects, or edits that differ from the studio recording
7. Anything else

KEY RULE: a plain upload from the artist channel (no "video" in the title) is BETTER than an Official Music Video. Music videos often have production overlays that hurt audio-only listening.

Also strongly prefer:
- Channel name matches the artist (or ends in "- Topic" / "VEVO")
- Duration reasonable for a single (usually 2:00–6:00)

Strongly AVOID:
- Live performances, concerts, tour footage
- Covers, remixes, mashups, edits, "sped up", "slowed", nightcore, 8D
- Karaoke, instrumental, acapella versions
- Reactions, reviews, tutorials
- Uploads from random user channels (not the artist, Topic, or VEVO)

Return ONLY a JSON object: {"pick": <0-based index>, "reason": "<short reason>"}. No markdown.`;

    try {
      const result = await this.model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: TOKEN_BUDGET.pickSingle },
      });

      const text = result.response.text().trim();
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      const parsed = JSON.parse(cleaned) as { pick: number; reason?: string };

      if (typeof parsed.pick !== 'number' || parsed.pick < 0 || parsed.pick >= candidates.length) {
        log.warn({ correlationId, parsed }, 'LLM picker returned invalid index');
        return null;
      }

      log.debug(
        { correlationId, pick: parsed.pick, reason: parsed.reason },
        'LLM single-pick complete',
      );
      return parsed.pick;
    } catch (error) {
      log.error(
        { correlationId, error: error instanceof Error ? error.message : String(error) },
        'LLM single-pick failed',
      );
      return null;
    }
  }

  async pickBestBatch(
    items: Array<{
      intent: { title: string; artist: string };
      candidates: PickCandidate[];
    }>,
  ): Promise<Array<number | null>> {
    if (items.length === 0) return [];

    const correlationId = createCorrelationId();

    // Build a compact prompt: each track gets its own numbered section.
    const sections = items
      .map((item, i) => {
        const candidatesText = item.candidates
          .map((c, j) => `  ${j}. ${describeCandidate(c)}`)
          .join('\n');
        return `Track ${i}: "${item.intent.title}" by ${item.intent.artist}\n${candidatesText}`;
      })
      .join('\n\n');

    const prompt = `You are picking the best YouTube search result for each track in a playlist. The goal is the CLEANEST, most-studio-identical audio for every track (the listener will only hear sound — no video).

${sections}

For EACH track, rank preferences from HIGHEST to LOWEST:
1. [CATALOG] entries — the official studio recording from the YouTube Music catalog (same master as Spotify/Apple Music). Pick one whenever its title and artist match the intended track. Only skip catalog entries when the user clearly wants something the catalog doesn't hold (a DJ set, live set, podcast, mix, specific remix, or a non-music video), or when none of them is actually the intended track.
2. "Official Audio" uploads — pure studio master, no video
3. Uploads from "<Artist> - Topic" channels — auto-generated YouTube Music uploads, always clean studio audio
4. "Lyric Video" or "Lyrics" from the artist or label channel — untouched studio audio with text overlay
5. Plain title from the artist's own channel with NO video descriptor (e.g. just "Billie Jean" by "Michael Jackson") — usually the album audio, cleaner than a music video
6. "Official Music Video" — may have intros, outros, dialogue, sound effects, or edits that differ from the studio recording
7. Anything else

KEY RULE: a plain upload from the artist channel (no "video" in the title) is BETTER than an Official Music Video. Music videos often have production overlays that hurt audio-only listening.

Also strongly prefer:
- Channel name matches the artist (or ends in "- Topic" / "VEVO")
- Duration reasonable for a single (usually 2:00–6:00)

Strongly AVOID:
- Live performances, concerts, tour footage
- Covers, remixes, mashups, edits, "sped up", "slowed", nightcore, 8D
- Karaoke, instrumental, acapella versions
- Reactions, reviews, tutorials
- Uploads from random user channels (not the artist, Topic, or VEVO)

If no candidate is a reasonable match for the intended track, return -1 for that track.

Return ONLY a JSON object of this exact shape (no markdown):
{"picks": [{"track": 0, "pick": <index or -1>}, {"track": 1, "pick": <index or -1>}, ...]}`;

    try {
      const result = await this.model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: TOKEN_BUDGET.pickBatch },
      });

      const text = result.response.text().trim();
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');

      let parsed: { picks: Array<{ track: number; pick: number }> };
      try {
        parsed = JSON.parse(cleaned);
      } catch (parseError) {
        log.warn(
          {
            correlationId,
            error: parseError instanceof Error ? parseError.message : String(parseError),
            rawLength: cleaned.length,
            rawTail: cleaned.slice(-100),
          },
          'LLM batch-pick returned malformed JSON',
        );
        return new Array(items.length).fill(null);
      }

      const out: Array<number | null> = new Array(items.length).fill(null);
      for (const p of parsed.picks ?? []) {
        if (typeof p.track !== 'number' || p.track < 0 || p.track >= items.length) continue;
        if (typeof p.pick !== 'number') continue;
        const candList = items[p.track].candidates;
        if (p.pick === -1 || p.pick >= candList.length) continue;
        out[p.track] = p.pick;
      }

      log.debug(
        {
          correlationId,
          resolved: out.filter((v) => v !== null).length,
          total: items.length,
        },
        'LLM batch-pick complete',
      );
      return out;
    } catch (error) {
      log.error(
        { correlationId, error: error instanceof Error ? error.message : String(error) },
        'LLM batch-pick failed',
      );
      return new Array(items.length).fill(null);
    }
  }

  async interpret(
    userRequest: string,
    context?: { nowPlaying?: TrackInfo | null; queueLength?: number },
  ): Promise<GeminiAction> {
    const correlationId = createCorrelationId();
    log.debug({ correlationId, request: userRequest }, 'Interpreting music request');

    const contextStr = context?.nowPlaying
      ? `\nCurrently playing: "${context.nowPlaying.title}" by ${context.nowPlaying.artist ?? 'Unknown'}. Queue has ${context.queueLength ?? 0} tracks.`
      : '\nNothing is currently playing.';

    try {
      const result = await this.model.generateContent({
        contents: [{ role: 'user', parts: [{ text: `${userRequest}${contextStr}` }] }],
        systemInstruction: SYSTEM_PROMPT,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: TOKEN_BUDGET.interpret,
        },
      });

      const text = result.response.text().trim();
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      const parsed = JSON.parse(cleaned) as GeminiAction;

      log.debug({ correlationId, action: parsed.action }, 'Gemini response parsed');
      return parsed;
    } catch (error) {
      log.error({ correlationId, error }, 'Gemini request failed');
      return {
        action: 'play',
        query: userRequest,
        message: `Searching for "${userRequest}"...`,
      };
    }
  }

  async refineQueue(
    currentQueue: Array<{ title: string; artist?: string }>,
    instruction: string,
    nowPlaying?: { title: string; artist?: string } | null,
  ): Promise<{
    plan: Array<{ existing: number } | { new: { title: string; artist: string } }>;
    message: string;
  }> {
    const correlationId = createCorrelationId();
    log.debug({ correlationId, instruction, queueSize: currentQueue.length }, 'Refining queue');

    const numbered = currentQueue
      .map((t, i) => `${i}. ${t.title}${t.artist ? ` — ${t.artist}` : ''}`)
      .join('\n');
    const npLine = nowPlaying
      ? `\nCurrently playing (cannot be changed): "${nowPlaying.title}"${nowPlaying.artist ? ` by ${nowPlaying.artist}` : ''}`
      : '';

    const refinePrompt = `You are revising a live music play queue based on a user's instruction.${npLine}

Current queue (0-indexed):
${numbered || '(empty)'}

User instruction: "${instruction}"

Produce a revised queue as an ordered list. Each entry MUST be one of:
- {"existing": <index>}  — reuse an existing queue track by its 0-based index. DO NOT reuse the same index twice.
- {"new": {"title": "...", "artist": "..."}}  — a new track to add that isn't already in the queue.

Rules:
- Apply the instruction as a targeted edit. Preserve tracks the user didn't ask to change.
- If they say "remove X", drop it and keep the rest.
- If they say "add N more Y", append/insert new tracks without discarding existing picks unless asked.
- If they say "play X next", move/add X to position 0.
- If they say "shuffle" or "reorder", reorder existing tracks without dropping them.
- Keep the total reasonable (up to 50 entries).
- If the instruction is unclear, make a best-effort guess.

Return ONLY valid JSON in this exact shape, no markdown fences:
{"message": "<one-line summary of what you changed>", "plan": [ {"existing": 0}, {"new": {"title": "...", "artist": "..."}}, ... ]}`;

    try {
      const result = await this.model.generateContent({
        contents: [{ role: 'user', parts: [{ text: refinePrompt }] }],
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: TOKEN_BUDGET.refine,
        },
      });

      const text = result.response.text().trim();
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      const parsed = JSON.parse(cleaned) as {
        plan: Array<{ existing: number } | { new: { title: string; artist: string } }>;
        message: string;
      };

      log.debug({ correlationId, planSize: parsed.plan?.length }, 'Queue refinement parsed');
      return parsed;
    } catch (error) {
      log.error({ correlationId, error }, 'Queue refinement failed');
      return {
        plan: currentQueue.map((_, i) => ({ existing: i })),
        message: "Couldn't apply that change — try rephrasing?",
      };
    }
  }

  async refinePlaylist(
    theme: string,
    currentTracks: Array<{ title: string; artist: string }>,
    instruction: string,
  ): Promise<GeminiPlaylistAction> {
    const correlationId = createCorrelationId();
    log.debug({ correlationId, instruction }, 'Refining playlist');

    const refinePrompt = `You are revising an existing playlist based on a user's instruction.

Theme: "${theme}"

Current playlist:
${currentTracks.map((t, i) => `${i + 1}. ${t.title} — ${t.artist}`).join('\n')}

User instruction: "${instruction}"

Apply the instruction as a TARGETED edit. Preserve tracks the user didn't ask to change.
- If they say "remove X", drop it and keep the rest
- If they say "add N more Y", append/insert without discarding existing picks
- If they say "swap X for Y", do exactly that
- If they say something vague like "make it more upbeat", replace a few tracks but keep most
- Keep the total between 10 and 15 tracks
- Preserve ordering where it makes sense

Return ONLY valid JSON in this exact shape, no markdown fences:
{"action": "playlist", "message": "<one-line summary of what you changed>", "tracks": [{"title": "...", "artist": "..."}, ...]}`;

    try {
      const result = await this.model.generateContent({
        contents: [{ role: 'user', parts: [{ text: refinePrompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: TOKEN_BUDGET.refine,
        },
      });

      const text = result.response.text().trim();
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      const parsed = JSON.parse(cleaned) as GeminiPlaylistAction;

      log.debug({ correlationId, trackCount: parsed.tracks?.length }, 'Playlist refinement parsed');
      return parsed;
    } catch (error) {
      log.error({ correlationId, error }, 'Playlist refinement failed');
      return {
        action: 'playlist',
        message: "Couldn't apply that change — try rephrasing?",
        tracks: currentTracks,
      };
    }
  }

  async curatePlaylst(
    theme: string,
    pools: ThemePools = {},
    recentShare = DEFAULT_RECENT_SHARE,
  ): Promise<GeminiPlaylistAction> {
    const correlationId = createCorrelationId();
    const recent = pools.recent ?? [];
    const classic = pools.classic ?? [];
    const total = recent.length + classic.length;
    log.debug(
      { correlationId, theme, recent: recent.length, classic: classic.length, recentShare },
      'Curating playlist',
    );

    const list = (tracks: Array<{ title: string; artist?: string }>) =>
      tracks.map((t, i) => `${i + 1}. "${t.title}" — ${t.artist ?? 'Unknown'}`).join('\n');

    let poolPrompt: string;
    if (total === 0) {
      poolPrompt = `Create a playlist for the theme: "${theme}"`;
    } else if (recent.length === 0 || classic.length === 0) {
      poolPrompt = `Create a playlist for the theme: "${theme}".

These tracks come from REAL playlists that listeners made for this theme. They are known to exist:
${list(recent.length ? recent : classic)}

Build the playlist mainly from that list: pick the 12-15 that best fit the theme and order them so the set flows. Copy each title and artist EXACTLY as written above. Only add a track of your own if fewer than 10 of these genuinely fit, and never repeat an artist more than twice.`;
    } else {
      const recentCount = Math.round((12 * recentShare) / 100);
      poolPrompt = `Create a playlist for the theme: "${theme}".

All tracks below come from REAL playlists and are known to exist. They are split into two groups.

CURRENT (released recently, from this year's playlists):
${list(recent)}

ESTABLISHED (the wider catalogue for this theme, any era):
${list(classic)}

Build a 12-15 track playlist that is about ${recentShare}% CURRENT and ${100 - recentShare}% ESTABLISHED — roughly ${recentCount} from CURRENT and the rest from ESTABLISHED. Do not group them: interleave so the set flows as one listening experience. Copy each title and artist EXACTLY as written above, never repeat an artist more than twice, and do not invent tracks that are not listed.`;
    }

    try {
      const result = await this.model.generateContent({
        contents: [
          {
            role: 'user',
            parts: [{ text: poolPrompt }],
          },
        ],
        systemInstruction: PLAYLIST_BUILDER_PROMPT,
        generationConfig: {
          temperature: total > 0 ? 0.4 : 0.9,
          maxOutputTokens: TOKEN_BUDGET.playlist,
        },
      });

      const text = result.response.text().trim();
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      const parsed = JSON.parse(cleaned) as GeminiPlaylistAction;
      const tracks = (parsed.tracks ?? []).filter((t): t is { title: string; artist: string } =>
        Boolean(t?.title && t?.artist),
      );

      log.debug({ correlationId, trackCount: tracks.length }, 'Playlist curated');
      return { action: 'playlist', message: parsed.message ?? '', tracks };
    } catch (error) {
      log.error({ correlationId, error }, 'Playlist curation failed');
      return {
        action: 'playlist',
        message: "Couldn't curate a playlist right now. Try again!",
        tracks: [],
      };
    }
  }
}
