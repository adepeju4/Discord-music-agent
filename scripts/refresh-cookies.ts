import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { resolveBinary } from '../src/utils/binaries';
import { filterToYouTube, summarizeCookies } from '../src/utils/cookies';

dotenv.config();

const YT_DLP = resolveBinary('yt-dlp', process.env.YTDLP_PATH);
const DEFAULT_OUTPUT = resolve(homedir(), '.yt-cookies.txt');
const PROBE_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

function fail(message: string): never {
  process.stderr.write(`\n\x1b[31m✗ ${message}\x1b[0m\n\n`);
  process.exit(1);
}

function ok(message: string): void {
  process.stdout.write(`\x1b[32m✓\x1b[0m ${message}\n`);
}

function info(message: string): void {
  process.stdout.write(`  ${message}\n`);
}

async function main() {
  const browser = process.env.YT_COOKIES_FROM_BROWSER;
  if (!browser) {
    fail(
      'YT_COOKIES_FROM_BROWSER is not set in .env. Set it to "chrome", "firefox", etc. so this script knows which browser to read cookies from.',
    );
  }

  const outputPath = process.env.YT_COOKIES_FILE || DEFAULT_OUTPUT;

  process.stdout.write(`\n\x1b[1mRefreshing YouTube cookies\x1b[0m\n`);
  info(`Browser:  ${browser}`);
  info(`Output:   ${outputPath}`);
  process.stdout.write('\n');

  if (!existsSync(YT_DLP)) {
    fail(`yt-dlp not found at ${YT_DLP}. Install it with: brew install yt-dlp`);
  }

  info('Extracting cookies (Keychain may prompt once — click "Always Allow") ...');

  const args = [
    '--cookies-from-browser',
    browser,
    '--cookies',
    outputPath,
    '--skip-download',
    '--quiet',
    '--no-warnings',
    PROBE_URL,
  ];

  const proc = spawn(YT_DLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  let stderr = '';
  proc.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const code: number = await new Promise((res) => proc.on('close', res));

  if (code !== 0) {
    process.stderr.write(`\n${stderr}\n`);
    fail(`yt-dlp exited with code ${code}. Cookies not refreshed.`);
  }

  if (!existsSync(outputPath)) {
    fail(`yt-dlp exited cleanly but no cookies file was written at ${outputPath}`);
  }

  let stats = statSync(outputPath);
  if (stats.size === 0) {
    fail(`Cookies file is empty at ${outputPath}`);
  }

  // yt-dlp exports the entire browser jar — thousands of cookies covering every
  // site you are signed into. Everything outside youtube.com is a live session
  // that has no business in a file destined for a server.
  const { kept, dropped } = filterToYouTube(readFileSync(outputPath, 'utf8'));
  if (dropped > 0) {
    writeFileSync(outputPath, kept, { mode: 0o600 });
    info(`Removed ${dropped} cookies for other sites (kept youtube.com only)`);
  }

  // A jar with only visitor cookies looks fine but proves nothing to YouTube,
  // which is the difference between playback working and every request being
  // challenged — especially from a server.
  const summary = summarizeCookies(readFileSync(outputPath, 'utf8'));
  if (!summary.signedIn) {
    process.stderr.write(
      `\n  Exported ${summary.names.length} cookies, but none prove a signed-in session:\n` +
        `    ${summary.names.join(', ') || '(none)'}\n\n` +
        `  Sign in to YouTube in ${browser} (use a throwaway Google account), keep\n` +
        `  that profile open, and run this again. If ${browser} has several profiles,\n` +
        `  point at the right one, e.g. YT_COOKIES_FROM_BROWSER="${browser}:Profile 1".\n`,
    );
    fail('No login cookies found — this file would not get past YouTube on a server.');
  }

  stats = statSync(outputPath);
  process.stdout.write('\n');
  ok(`Cookies written to ${outputPath} (${stats.size} bytes, mode 600)`);
  ok(`Signed-in session confirmed (${summary.loginCookies.join(', ')})`);
  process.stdout.write('\n');
  info('Add this to your .env if not already set:');
  info(`  YT_COOKIES_FILE=${outputPath}`);
  process.stdout.write('\n');
  info('The bot will now use the file for playback. Re-run this script if');
  info('cookies expire (usually weeks to months).');
  process.stdout.write('\n');
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
});
