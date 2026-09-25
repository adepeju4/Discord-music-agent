import { describe, it, expect } from 'vitest';
import { resolveBinary, BIN_DIRS } from '../src/utils/binaries';

describe('resolveBinary', () => {
  const none = () => false;

  it('honours an explicit override above everything else', () => {
    expect(resolveBinary('yt-dlp', '/custom/path/yt-dlp', () => true)).toBe('/custom/path/yt-dlp');
    expect(resolveBinary('yt-dlp', '/custom/path/yt-dlp', none)).toBe('/custom/path/yt-dlp');
  });

  it('finds the binary wherever the platform installed it', () => {
    expect(resolveBinary('yt-dlp', undefined, (p) => p === '/opt/homebrew/bin/yt-dlp')).toBe(
      '/opt/homebrew/bin/yt-dlp',
    );
    // apt on a Raspberry Pi
    expect(resolveBinary('yt-dlp', undefined, (p) => p === '/usr/bin/yt-dlp')).toBe(
      '/usr/bin/yt-dlp',
    );
    // pip install --user
    expect(resolveBinary('yt-dlp', undefined, (p) => p.endsWith('/.local/bin/yt-dlp'))).toContain(
      '/.local/bin/yt-dlp',
    );
  });

  it('prefers the earliest matching directory when several exist', () => {
    expect(resolveBinary('yt-dlp', undefined, () => true)).toBe(`${BIN_DIRS[0]}/yt-dlp`);
  });

  it('falls back to a bare name so PATH lookup still applies', () => {
    expect(resolveBinary('yt-dlp', undefined, none)).toBe('yt-dlp');
  });
});
