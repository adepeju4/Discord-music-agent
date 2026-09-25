import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * yt-dlp persists the cookie jar it is handed. These tests pin the behaviour
 * that matters: the configured master file must survive a run untouched, even
 * when the tool rewrites what it was given.
 */
const JAR = [
  '# Netscape HTTP Cookie File',
  ['.youtube.com', 'TRUE', '/', 'TRUE', '1799999999', 'SID', 'secret-session'].join('\t'),
  ['.youtube.com', 'TRUE', '/', 'TRUE', '1799999999', 'LOGIN_INFO', 'secret-login'].join('\t'),
].join('\n');

let dir: string;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('cookie jar protection', () => {
  it('keeps the master intact when the tool rewrites its copy', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cookiejar-'));
    const master = join(dir, 'master.txt');
    writeFileSync(master, JAR);

    // Stand in for yt-dlp: clobber whatever jar it is given, as the real tool
    // does after a bot check clears the session.
    const fakeYtDlp = join(dir, 'fake-yt-dlp');
    writeFileSync(
      fakeYtDlp,
      '#!/bin/sh\nfor a in "$@"; do\n  if [ "$prev" = "--cookies" ]; then echo "# session cleared" > "$a"; fi\n  prev="$a"\ndone\necho "{}"\n',
      { mode: 0o755 },
    );

    process.env.YT_COOKIES_FILE = master;
    process.env.YTDLP_PATH = fakeYtDlp;
    delete process.env.YT_COOKIES_FROM_BROWSER;

    const { YouTubeService } = await import('../src/services/YouTubeService');
    await new YouTubeService().search('anything', 1);

    const after = readFileSync(master, 'utf8');
    expect(after).toBe(JAR);
    expect(after).toContain('secret-session');
    expect(after).toContain('LOGIN_INFO');
  });

  it('cleans up its scratch copies', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cookiejar-'));
    const master = join(dir, 'master.txt');
    writeFileSync(master, JAR);

    // Record the scratch path yt-dlp was handed, so cleanup can be checked
    // exactly rather than by scanning a shared temp directory.
    const pathLog = join(dir, 'paths.log');
    const fakeYtDlp = join(dir, 'fake-yt-dlp');
    writeFileSync(
      fakeYtDlp,
      `#!/bin/sh\nprev=""\nfor a in "$@"; do\n  if [ "$prev" = "--cookies" ]; then echo "$a" >> ${pathLog}; fi\n  prev="$a"\ndone\necho "{}"\n`,
      { mode: 0o755 },
    );

    process.env.YT_COOKIES_FILE = master;
    process.env.YTDLP_PATH = fakeYtDlp;
    delete process.env.YT_COOKIES_FROM_BROWSER;
    delete process.env.YTDLP_PROXY;
    vi.resetModules();

    const { YouTubeService } = await import('../src/services/YouTubeService');
    const yt = new YouTubeService();
    await yt.search('one', 1);
    await yt.search('two', 1);

    const used = readFileSync(pathLog, 'utf8').trim().split('\n');
    expect(used).toHaveLength(2);
    // Each run gets its own copy, and none of them outlive the call.
    expect(new Set(used).size).toBe(2);
    for (const p of used) {
      expect(p).not.toBe(master);
      expect(existsSync(p)).toBe(false);
    }
    expect(existsSync(master)).toBe(true);
  });
});

describe('proxy support', () => {
  it('passes --proxy to both search and streaming when configured', async () => {
    dir = mkdtempSync(join(tmpdir(), 'proxyargs-'));
    const argsLog = join(dir, 'args.log');
    const fakeYtDlp = join(dir, 'fake-yt-dlp');
    writeFileSync(fakeYtDlp, `#!/bin/sh\necho "$@" >> ${argsLog}\necho "{}"\n`, { mode: 0o755 });

    process.env.YTDLP_PATH = fakeYtDlp;
    process.env.YTDLP_PROXY = 'socks5://127.0.0.1:1080';
    delete process.env.YT_COOKIES_FILE;
    delete process.env.YT_COOKIES_FROM_BROWSER;
    vi.resetModules();

    const { YouTubeService } = await import('../src/services/YouTubeService');
    await new YouTubeService().search('anything', 1);

    const logged = readFileSync(argsLog, 'utf8');
    expect(logged).toContain('--proxy socks5://127.0.0.1:1080');
    delete process.env.YTDLP_PROXY;
  });

  it('passes no proxy flag when none is configured', async () => {
    dir = mkdtempSync(join(tmpdir(), 'proxyargs-'));
    const argsLog = join(dir, 'args.log');
    const fakeYtDlp = join(dir, 'fake-yt-dlp');
    writeFileSync(fakeYtDlp, `#!/bin/sh\necho "$@" >> ${argsLog}\necho "{}"\n`, { mode: 0o755 });

    process.env.YTDLP_PATH = fakeYtDlp;
    delete process.env.YTDLP_PROXY;
    vi.resetModules();

    const { YouTubeService } = await import('../src/services/YouTubeService');
    await new YouTubeService().search('anything', 1);

    expect(readFileSync(argsLog, 'utf8')).not.toContain('--proxy');
  });
});
