import { describe, it, expect } from 'vitest';
import { explainError, explainErrorOr, errorText } from '../src/utils/errors';

describe('explainError', () => {
  it('tells the owner how to fix expired YouTube cookies', () => {
    const msg = explainError(
      new Error("ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies"),
    );
    expect(msg).toContain('refresh-cookies');
  });

  it('distinguishes the common yt-dlp failures', () => {
    expect(explainError(new Error('ERROR: This video is private'))).toContain('private');
    expect(explainError(new Error('ERROR: Video unavailable'))).toContain('unavailable');
    expect(explainError(new Error('ERROR: Requested format is not available'))).toContain(
      'No playable audio',
    );
    expect(explainError(new Error('HTTP Error 429: Too Many Requests'))).toContain('rate-limiting');
  });

  it('recognises network, Gemini and Discord failures', () => {
    expect(explainError(new Error('connect ETIMEDOUT 1.2.3.4:443'))).toContain('Network');
    expect(explainError(new Error('429 RESOURCE_EXHAUSTED: quota exceeded'))).toContain(
      'rate-limited',
    );
    expect(explainError(new Error('DiscordAPIError[50013]: Missing Permissions'))).toContain(
      'permissions',
    );
    expect(explainError(new Error('Voice connection never became ready'))).toContain(
      'voice channel',
    );
  });

  it('returns null for anything it does not recognise, so callers stay specific', () => {
    expect(explainError(new Error('some entirely novel failure'))).toBeNull();
    expect(explainErrorOr(new Error('some entirely novel failure'), 'fallback text')).toBe(
      'fallback text',
    );
  });

  it('reads non-Error values and error causes', () => {
    expect(errorText('ERROR: Video unavailable')).toContain('Video unavailable');
    expect(explainError('ERROR: This video is private')).toContain('private');
    const wrapped = new Error('wrapper', { cause: new Error('HTTP Error 429') });
    expect(explainError(wrapped)).toContain('rate-limiting');
  });
});
