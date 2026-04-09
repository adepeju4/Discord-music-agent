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
   {"action": "play", "query": "<song title> by <artist>", "message": "Now searching for <song>..."}

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
