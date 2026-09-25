/**
 * Turns the raw failures this bot actually hits — yt-dlp stderr, Gemini quota
 * responses, Discord permission errors — into something a person in a Discord
 * channel can act on.
 */

export interface ErrorRule {
  match: RegExp;
  message: string;
}

const RULES: ErrorRule[] = [
  // YouTube / yt-dlp
  {
    match: /sign in to confirm|not a bot|cookies are no longer valid|please sign in/i,
    message:
      "YouTube is asking the bot to prove it isn't a robot. The saved cookies have expired — run `npm run refresh-cookies` on the host, then restart the bot.",
  },
  {
    match: /private video|this video is private/i,
    message: 'That video is private, so it cannot be played.',
  },
  {
    match: /age.?restricted|confirm your age|inappropriate for some users/i,
    message:
      'That video is age-restricted. YouTube will not serve it without a signed-in account — configure cookies to play these.',
  },
  {
    match: /members[- ]only|music premium|premium members/i,
    message: 'That video is limited to channel members or Premium subscribers.',
  },
  {
    match: /video unavailable|has been removed|no longer available|account associated/i,
    message: 'That video is unavailable — it may have been removed or blocked in this region.',
  },
  {
    match: /requested format is not available|no video formats/i,
    message: 'No playable audio track was found for that video.',
  },
  {
    match: /http error 429|too many requests|rate.?limit/i,
    message: 'YouTube is rate-limiting the bot right now. Give it a minute and try again.',
  },
  {
    match: /http error 4\d\d|http error 5\d\d/i,
    message: 'YouTube refused the download. Try again, or pick a different version of the track.',
  },
  {
    match: /unable to download|unable to extract|extractorerror/i,
    message:
      'YouTube changed something yt-dlp cannot read yet. Updating yt-dlp (`brew upgrade yt-dlp`) usually fixes this.',
  },

  // Network
  {
    match:
      /etimedout|econnreset|enotfound|econnrefused|socket hang up|network|fetch failed|aborted/i,
    message: 'Network trouble reaching the source. Try again in a moment.',
  },
  { match: /stream timeout/i, message: 'The audio stream never started. Try that track again.' },

  // Gemini
  {
    match: /resource_exhausted|quota|429/i,
    message: 'The AI is rate-limited right now. Try again shortly, or use a direct song name.',
  },
  {
    match: /api key|permission_denied|unauthenticated/i,
    message: 'The Gemini API key was rejected — check `GEMINI_API_KEY` on the host.',
  },

  // Discord
  {
    match: /missing permissions|missing access|50013|50001/i,
    message:
      "I'm missing permissions for that channel. I need View Channel, Connect and Speak on the voice channel, plus Send Messages and Embed Links on the text channel.",
  },
  {
    match: /voice connection never became ready/i,
    message:
      "I couldn't connect to the voice channel. If it's private or full, check that my role can join it.",
  },
];

export function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = 'cause' in error && error.cause ? ` ${String(error.cause)}` : '';
    return `${error.message}${cause}`;
  }
  return String(error);
}

/**
 * Maps an error to a message worth showing a user, or null when nothing
 * recognisable matched — callers then supply their own context-specific text
 * rather than guessing.
 */
export function explainError(error: unknown): string | null {
  const text = errorText(error);
  for (const rule of RULES) {
    if (rule.match.test(text)) return rule.message;
  }
  return null;
}

/** Same as explainError, but always returns something printable. */
export function explainErrorOr(error: unknown, fallback: string): string {
  return explainError(error) ?? fallback;
}
