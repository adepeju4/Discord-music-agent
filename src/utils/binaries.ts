import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where Homebrew, apt, pip and manual installs each put their binaries. The bot
 * runs on macOS during development and typically on Linux (often a Raspberry
 * Pi) in production, so the path cannot be assumed.
 */
export const BIN_DIRS = [
  '/opt/homebrew/bin', // macOS, Apple silicon
  '/usr/local/bin', // macOS Intel, manual installs
  '/usr/bin', // apt
  join(homedir(), '.local', 'bin'), // pip install --user
];

export function resolveBinary(
  name: string,
  override?: string,
  exists: (path: string) => boolean = existsSync,
): string {
  if (override) return override;
  for (const dir of BIN_DIRS) {
    const candidate = join(dir, name);
    if (exists(candidate)) return candidate;
  }
  // Fall back to a bare name so PATH lookup still gets a chance, and any
  // failure surfaces as a clear "not found" rather than a wrong-path error.
  return name;
}

/** Makes sure child processes can find yt-dlp and ffmpeg however they were installed. */
export function ensureBinPath(): void {
  const current = process.env.PATH ?? '';
  const missing = BIN_DIRS.filter((dir) => !current.split(':').includes(dir));
  if (missing.length > 0) {
    process.env.PATH = [...missing, current].filter(Boolean).join(':');
  }
}
