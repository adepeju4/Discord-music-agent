import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const YT_DLP = '/opt/homebrew/bin/yt-dlp';
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

  const stats = statSync(outputPath);
  if (stats.size === 0) {
    fail(`Cookies file is empty at ${outputPath}`);
  }

  process.stdout.write('\n');
  ok(`Cookies written to ${outputPath} (${stats.size} bytes)`);
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
