import { spawn, execFile } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { promisify } from 'node:util';
import { config } from '../config';
import { childLogger, createCorrelationId } from '../utils/logger';
import type { TrackInfo } from '../utils/embeds';

function cookieArgs(): string[] {
  if (config.YT_COOKIES_FILE) {
    return ['--cookies', config.YT_COOKIES_FILE];
  }
  if (config.YT_COOKIES_FROM_BROWSER) {
    return ['--cookies-from-browser', config.YT_COOKIES_FROM_BROWSER];
  }
  return [];
}

const execFileAsync = promisify(execFile);
const log = childLogger({ module: 'YouTubeService' });

if (!process.env.PATH?.includes('/opt/homebrew/bin')) {
  process.env.PATH = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`;
}

if (config.YT_COOKIES_FILE) {
  log.info({ file: config.YT_COOKIES_FILE }, 'Using cookies file for YouTube requests');
} else if (config.YT_COOKIES_FROM_BROWSER) {
  log.info(
    { browser: config.YT_COOKIES_FROM_BROWSER },
    'Using browser cookies for YouTube requests',
  );
} else {
  log.info('No cookies configured — yt-dlp will use anonymous requests');
}

export interface SearchResult {
  title: string;
  url: string;
  duration: number;
  thumbnail?: string;
  artist?: string;
}

function scoreResult(r: SearchResult, index: number, expectedArtist?: string): number {
  const title = r.title.toLowerCase();
  const channel = (r.artist ?? '').toLowerCase();
  let score = 0;

  if (expectedArtist) {
    const a = expectedArtist.toLowerCase().trim();
    if (a.length >= 2) {
      if (channel === `${a} - topic`) score += 150;
      else if (channel === `${a}vevo` || channel === `${a}vevo`.replace(/\s+/g, '')) {
        score += 120;
      } else if (channel === a) score += 110;
      else if (channel.includes(a)) score += 70;
    }
  }

  if (/\bofficial audio\b/.test(title)) score += 100;
  else if (/\bofficial (music )?video\b/.test(title)) score += 40;
  else if (/\bofficial\b/.test(title)) score += 25;
  else if (/\baudio\b/.test(title)) score += 20;

  if (!expectedArtist || !channel.includes(expectedArtist.toLowerCase().trim())) {
    if (/- topic$/.test(channel)) score += 80;
    if (/vevo$/.test(channel)) score += 60;
  }

  if (/\b(live|concert|performance|tour)\b/.test(title)) score -= 40;
  if (/\b(cover|remix|mashup|edit|sped up|slowed|nightcore|8d)\b/.test(title)) score -= 50;
  if (/\b(reaction|review|tutorial|how to)\b/.test(title)) score -= 80;
  if (/\b(karaoke|instrumental|acapella)\b/.test(title)) score -= 60;

  if (/\b(lyrics|lyric video)\b/.test(title)) {
    if (expectedArtist && channel.includes(expectedArtist.toLowerCase().trim())) {
      score += 10;
    } else {
      score -= 30;
    }
  }

  score -= index;
  return score;
}

export function pickBestAudio(
  results: SearchResult[],
  expectedArtist?: string,
): SearchResult | null {
  if (results.length === 0) return null;
  let best = results[0];
  let bestScore = scoreResult(best, 0, expectedArtist);
  for (let i = 1; i < results.length; i++) {
    const s = scoreResult(results[i], i, expectedArtist);
    if (s > bestScore) {
      best = results[i];
      bestScore = s;
    }
  }
  return best;
}

export class YouTubeService {
  async search(query: string, limit = 5): Promise<SearchResult[]> {
    const correlationId = createCorrelationId();
    log.debug({ correlationId, query, limit }, 'Searching YouTube via yt-dlp');

    try {
      const { stdout } = await execFileAsync(
        '/opt/homebrew/bin/yt-dlp',
        [...cookieArgs(), `ytsearch${limit}:${query}`, '--dump-json', '--flat-playlist', '--no-warnings'],
        { timeout: 30_000 },
      );

      const results: SearchResult[] = stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const data = JSON.parse(line);
          return {
            title: data.title ?? 'Unknown',
            url: data.url ? `https://www.youtube.com/watch?v=${data.id}` : data.webpage_url,
            duration: Math.floor(data.duration ?? 0),
            thumbnail: data.thumbnail ?? data.thumbnails?.[0]?.url,
            artist: data.channel ?? data.uploader,
          };
        });

      log.debug({ correlationId, count: results.length }, 'Search results found');
      return results;
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const stderr = (error as { stderr?: string })?.stderr;
      log.error({ correlationId, error: errMsg, stderr }, 'YouTube search failed');
      return [];
    }
  }

  getStream(url: string): Promise<{ stream: Readable; format: 'webm-opus' | 'arbitrary' }> {
    const correlationId = createCorrelationId();
    log.debug({ correlationId }, 'Getting audio stream via yt-dlp');

    return new Promise((resolve, reject) => {
      const ytdlp = spawn('/opt/homebrew/bin/yt-dlp', [
        ...cookieArgs(),
        '-f',
        'bestaudio[acodec=opus][ext=webm]/251/bestaudio',
        '--print',
        'before_dl:%(ext)s/%(acodec)s',
        '-o',
        '-',
        '--no-warnings',
        url,
      ]);

      let resolved = false;
      let detectedFormat: 'webm-opus' | 'arbitrary' = 'arbitrary';

      const formatLineRe = /^([a-z0-9]+)\/([a-z0-9._-]+)$/i;

      const tap = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          cb(null, chunk);
        },
      });

      ytdlp.stdout.pipe(tap);

      tap.once('readable', () => {
        if (!resolved) {
          resolved = true;
          log.info({ correlationId, format: detectedFormat }, 'Audio stream ready');
          resolve({ stream: tap, format: detectedFormat });
        }
      });

      ytdlp.stderr.on('data', (data: Buffer) => {
        const msg = data.toString();
        for (const line of msg.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          const m = formatLineRe.exec(trimmed);
          if (m) {
            const [, ext, acodec] = m;
            if (ext.toLowerCase() === 'webm' && acodec.toLowerCase() === 'opus') {
              detectedFormat = 'webm-opus';
            } else {
              detectedFormat = 'arbitrary';
            }
            log.debug({ correlationId, ext, acodec, detectedFormat }, 'yt-dlp format detected');
            continue;
          }

          if (/^(ERROR|WARNING):/i.test(trimmed)) {
            log.error({ correlationId, stderr: trimmed }, 'yt-dlp stderr');
          } else {
            log.debug({ correlationId, stderr: trimmed }, 'yt-dlp stderr');
          }
        }
      });

      ytdlp.once('error', (error) => {
        log.error({ correlationId, error: error.message }, 'yt-dlp process error');
        if (!resolved) {
          resolved = true;
          reject(error);
        }
      });

      ytdlp.once('close', (code) => {
        log.debug({ correlationId, code }, 'yt-dlp process closed');
        if (!resolved && code !== 0) {
          resolved = true;
          reject(new Error(`yt-dlp exited with code ${code}`));
        }
      });

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ytdlp.kill();
          reject(new Error('Stream timeout — no audio data received in 30s'));
        }
      }, 30_000);
    });
  }

  async searchOne(query: string, expectedArtist?: string): Promise<SearchResult | null> {
    const results = await this.search(query, 5);
    if (results.length === 0) return null;
    return pickBestAudio(results, expectedArtist);
  }

  async searchCandidates(query: string, limit = 5): Promise<SearchResult[]> {
    return this.search(query, limit);
  }

  toTrackInfo(result: SearchResult, requestedBy: string): TrackInfo {
    return {
      title: result.title,
      url: result.url,
      duration: result.duration,
      thumbnail: result.thumbnail,
      artist: result.artist,
      requestedBy,
    };
  }
}
