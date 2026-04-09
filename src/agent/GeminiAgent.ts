import { GoogleGenerativeAI } from '@google/generative-ai';
import { config } from '../config';
import { childLogger, createCorrelationId } from '../utils/logger';
import type { TrackInfo } from '../utils/embeds';

const log = childLogger({ module: 'GeminiAgent' });

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

export interface GeminiRejectAction {
  action: 'reject';
  message: string;
}

export type GeminiAction =
  | GeminiPlayAction
  | GeminiClarifyAction
  | GeminiSuggestAction
  | GeminiPlaylistAction
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

3. **suggest** — The request is a mood/genre/vibe. Return:
   {"action": "suggest", "message": "<friendly message>", "suggestions": ["Song - Artist", "Song - Artist", ...]}
   Provide 3-5 suggestions the user can pick from.

4. **playlist** — The user explicitly asked for a playlist or multiple songs around a theme. Return:
   {"action": "playlist", "message": "<friendly message about the playlist>", "tracks": [{"title": "...", "artist": "..."}, ...]}
   Provide 10-15 tracks.

5. **reject** — The request is NOT about music. Return:
   {"action": "reject", "message": "I'm a music bot — I can only help with playing songs, playlists, and music recommendations!"}

Rules:
- STRICTLY music only. If the request is not about playing music, finding songs, describing a mood/vibe for music, or requesting a playlist, ALWAYS use "reject". No exceptions.
- Do NOT answer general questions, trivia, jokes, coding help, math, or anything unrelated to music playback.
- If the user gives a specific song name AND artist, use "play".
- If the user gives a specific song name but no artist, and the song is well-known enough to be unambiguous, use "play". Otherwise "clarify".
- If the user describes a mood, genre, or vibe, use "suggest".
- Only use "playlist" when the user explicitly asks for a playlist, a set of songs, or uses /playlist.
- Always include the artist in your query for "play" actions.
- Keep messages short and friendly.
- ONLY return valid JSON. No markdown, no code fences, no extra text.`;

export class GeminiAgent {
  private model;

  constructor() {
    const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY);
    this.model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
  }

  async pickBestSingle(
    intent: { title?: string; artist?: string; rawQuery?: string },
    candidates: Array<{ title: string; channel?: string; duration: number }>,
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

    const numbered = candidates
      .map(
        (c, i) =>
          `${i}. "${c.title}" — channel: ${c.channel ?? 'Unknown'}, duration: ${c.duration}s`,
      )
      .join('\n');

    const prompt = `You are picking the best YouTube search result for a music track. The goal is the CLEANEST, most-studio-identical audio (the listener will only hear sound — no video).

Intended track: ${intentLine}

Candidates:
${numbered}

Rank preferences from HIGHEST to LOWEST:
1. "Official Audio" uploads (pure studio master, no video at all)
2. "Lyric Video" or "Lyrics" — these typically contain the untouched studio audio with text overlaid, so the audio is identical to the studio cut
3. "Official Music Video" — still the artist's version but may have intros/outros, edits, or sound-effect overlays that hurt pure-audio listening
4. Plain artist uploads with no descriptor
5. Anything else

Also strongly prefer:
- Channel name matches the artist (or ends in "- Topic" / "VEVO") — this marks an official upload
- Duration reasonable for a single (usually 2:00–6:00)

Strongly AVOID (pick these only if nothing else is available):
- Live performances, concerts, tour footage
- Covers, remixes, mashups, edits, "sped up", "slowed", nightcore, 8D
- Karaoke, instrumental, acapella versions
- Reactions, reviews, tutorials
- Uploads from random user channels (not the artist, Topic, or VEVO)

Return ONLY a JSON object: {"pick": <0-based index>, "reason": "<short reason>"}. No markdown.`;

    try {
      const result = await this.model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 256 },
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
      candidates: Array<{ title: string; channel?: string; duration: number }>;
    }>,
  ): Promise<Array<number | null>> {
    if (items.length === 0) return [];

    const correlationId = createCorrelationId();

    // Build a compact prompt: each track gets its own numbered section.
    const sections = items
      .map((item, i) => {
        const candidatesText = item.candidates
          .map((c, j) => `  ${j}. "${c.title}" — ${c.channel ?? 'Unknown'}, ${c.duration}s`)
          .join('\n');
        return `Track ${i}: "${item.intent.title}" by ${item.intent.artist}\n${candidatesText}`;
      })
      .join('\n\n');

    const prompt = `You are picking the best YouTube search result for each track in a playlist. The goal is the CLEANEST, most-studio-identical audio for every track (the listener will only hear sound — no video).

${sections}

For EACH track, rank preferences from HIGHEST to LOWEST:
1. "Official Audio" uploads (pure studio master, no video at all)
2. "Lyric Video" or "Lyrics" — these typically contain the untouched studio audio with text overlaid, so the audio is identical to the studio cut
3. "Official Music Video" — the artist's version but may have intros/outros, edits, or sound-effect overlays that hurt pure-audio listening
4. Plain artist uploads with no descriptor
5. Anything else

Also strongly prefer:
- Channel name matches the artist (or ends in "- Topic" / "VEVO") — marks an official upload
- Duration reasonable for a single (usually 2:00–6:00)

Strongly AVOID (pick these only if nothing else is available):
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
        generationConfig: { temperature: 0.1, maxOutputTokens: 2048 },
      });

      const text = result.response.text().trim();
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      const parsed = JSON.parse(cleaned) as {
        picks: Array<{ track: number; pick: number }>;
      };

      // Build an array indexed by track, with null for anything missing/invalid
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
          maxOutputTokens: 1024,
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
          maxOutputTokens: 2048,
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
          maxOutputTokens: 2048,
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

  async curatePlaylst(theme: string): Promise<GeminiPlaylistAction> {
    const correlationId = createCorrelationId();
    log.debug({ correlationId, theme }, 'Curating playlist');

    try {
      const result = await this.model.generateContent({
        contents: [
          {
            role: 'user',
            parts: [{ text: `Create a playlist for the theme: "${theme}"` }],
          },
        ],
        systemInstruction: SYSTEM_PROMPT,
        generationConfig: {
          temperature: 0.9,
          maxOutputTokens: 2048,
        },
      });

      const text = result.response.text().trim();
      const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '');
      const parsed = JSON.parse(cleaned) as GeminiPlaylistAction;

      log.debug({ correlationId, trackCount: parsed.tracks?.length }, 'Playlist curated');
      return parsed;
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
