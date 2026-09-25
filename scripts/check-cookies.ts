import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { summarizeCookies } from '../src/utils/cookies';

dotenv.config();

const path =
  process.argv[2] ?? process.env.YT_COOKIES_FILE ?? resolve(homedir(), '.yt-cookies.txt');

if (!existsSync(path)) {
  process.stderr.write(`\x1b[31m✗\x1b[0m No cookies file at ${path}\n`);
  process.exit(1);
}

const summary = summarizeCookies(readFileSync(path, 'utf8'));
process.stdout.write(`\nCookies: ${path}\n`);
process.stdout.write(`  cookies found: ${summary.names.join(', ') || '(none)'}\n`);

if (summary.foreignDomains.length > 0) {
  process.stdout.write(
    `\x1b[31m✗\x1b[0m Contains cookies for ${summary.foreignDomains.length} unrelated sites: ` +
      `${summary.foreignDomains.slice(0, 8).join(', ')}` +
      `${summary.foreignDomains.length > 8 ? ', …' : ''}\n` +
      `  Do not copy this file anywhere. Re-run: npm run refresh-cookies\n\n`,
  );
  process.exit(1);
}

if (summary.signedIn) {
  process.stdout.write(
    `\x1b[32m✓\x1b[0m Signed-in session (${summary.loginCookies.join(', ')})\n\n`,
  );
} else {
  process.stdout.write(
    `\x1b[31m✗\x1b[0m No login cookies. YouTube will challenge this from a server.\n` +
      `  Sign in to YouTube in your browser, then run: npm run refresh-cookies\n\n`,
  );
  process.exit(1);
}
