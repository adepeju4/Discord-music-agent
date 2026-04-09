import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

// Mutable config mock — tests can flip YT_COOKIES_FROM_BROWSER between cases
const configMock = { YT_COOKIES_FROM_BROWSER: 'chrome' as string | undefined };
vi.mock('../src/config', () => ({ config: configMock }));

// Capture yt-dlp invocations. execFile is used by search(), spawn by getStream().
const execFileCalls: { args: string[] }[] = [];
const spawnCalls: { args: string[] }[] = [];

vi.mock('node:child_process', () => {
  const execFile = (
    _bin: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
  ) => {
    execFileCalls.push({ args });
    // Return one fake search hit so search() parses it successfully
    const line = JSON.stringify({
      id: 'abc123',
      title: 'Fake Song',
      duration: 180,
      channel: 'Fake Artist',
      webpage_url: 'https://www.youtube.com/watch?v=abc123',
    });
    process.nextTick(() => cb(null, { stdout: line + '\n', stderr: '' }));
  };

  const spawn = (_bin: string, args: string[]) => {
    spawnCalls.push({ args });
    const proc = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
      kill: () => void;
    };
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.stdin = new PassThrough();
    proc.kill = () => {};
    return proc;
  };

  return { execFile, spawn };
});

// Import AFTER mocks so YouTubeService picks them up
const { YouTubeService } = await import('../src/services/YouTubeService');

describe('YouTubeService cookie handling', () => {
  beforeEach(() => {
    execFileCalls.length = 0;
    spawnCalls.length = 0;
  });

  afterEach(() => {
    configMock.YT_COOKIES_FROM_BROWSER = 'chrome';
  });

  describe('search()', () => {
    it('never passes --cookies-from-browser, even when configured', async () => {
      configMock.YT_COOKIES_FROM_BROWSER = 'chrome';
      const yt = new YouTubeService();
      const results = await yt.search('test query', 1);

      expect(execFileCalls).toHaveLength(1);
      const args = execFileCalls[0].args;
      expect(args).not.toContain('--cookies-from-browser');
      expect(args).not.toContain('chrome');
      expect(args).toContain('ytsearch1:test query');
      expect(results).toHaveLength(1);
      expect(results[0].title).toBe('Fake Song');
    });

    it('still omits cookie args when no browser is configured', async () => {
      configMock.YT_COOKIES_FROM_BROWSER = undefined;
      const yt = new YouTubeService();
      await yt.search('another query', 5);

      expect(execFileCalls[0].args).not.toContain('--cookies-from-browser');
      expect(execFileCalls[0].args).toContain('ytsearch5:another query');
    });

    it('omits --quiet so stderr surfaces on failure', async () => {
      const yt = new YouTubeService();
      await yt.search('x', 1);
      expect(execFileCalls[0].args).not.toContain('--quiet');
    });
  });

  describe('getStream()', () => {
    it('passes --cookies-from-browser chrome when configured', () => {
      configMock.YT_COOKIES_FROM_BROWSER = 'chrome';
      const yt = new YouTubeService();
      // Fire and forget — we only care about the spawn args, not the stream
      void yt.getStream('https://www.youtube.com/watch?v=abc123').catch(() => {});

      const ytdlpCall = spawnCalls.find((c) => c.args.some((a) => a.includes('bestaudio')));
      expect(ytdlpCall).toBeDefined();
      expect(ytdlpCall!.args).toContain('--cookies-from-browser');
      const idx = ytdlpCall!.args.indexOf('--cookies-from-browser');
      expect(ytdlpCall!.args[idx + 1]).toBe('chrome');
    });

    it('omits cookie args when no browser is configured', () => {
      configMock.YT_COOKIES_FROM_BROWSER = undefined;
      const yt = new YouTubeService();
      void yt.getStream('https://www.youtube.com/watch?v=abc123').catch(() => {});

      const ytdlpCall = spawnCalls.find((c) => c.args.some((a) => a.includes('bestaudio')));
      expect(ytdlpCall).toBeDefined();
      expect(ytdlpCall!.args).not.toContain('--cookies-from-browser');
    });
  });
});
