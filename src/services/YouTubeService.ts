import { spawn, execFile } from 'node:child_process';
import { copyFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { promisify } from 'node:util';
import { config } from '../config';
import { childLogger, createCorrelationId } from '../utils/logger';
import { ensureBinPath, resolveBinary } from '../utils/binaries';
import type { TrackInfo } from '../utils/embeds';
import { YouTubeMusicService } from './YouTubeMusicService';

interface CookieHandle {
  args: string[];
  release: () => void;
}

const NO_COOKIES: CookieHandle = { args: [], release: () => {} };

/**
 * yt-dlp writes the cookie jar back after every run, persisting whatever the
 * server said — including the cleared session it returns with a bot check. That
 * destroys the credentials on first failure, so it never gets a pristine copy:
 * it gets a throwaway duplicate and its edits are discarded.
 */
function cookieArgs(): CookieHandle {
  if (config.YT_COOKIES_FILE) {
    try {
      const scratch = join(tmpdir(), `yt-cookies-${randomUUID()}.txt`);
      copyFileSync(config.YT_COOKIES_FILE, scratch);
      return {
        args: ['--cookies', scratch],
        release: () => {
          try {
            unlinkSync(scratch);
          } catch {
            // Already gone, or never created — nothing to clean up.
          }
        },
      };
    } catch (error) {
      log.error(
        {
          file: config.YT_COOKIES_FILE,
          error: error instanceof Error ? error.message : String(error),
        },
        'Could not read the cookies file — continuing without cookies',
      );
      return NO_COOKIES;
    }
  }
  if (config.YT_COOKIES_FROM_BROWSER) {
    return { args: ['--cookies-from-browser', config.YT_COOKIES_FROM_BROWSER], release: () => {} };
  }
  return NO_COOKIES;
}

const AUDIO_BUFFER_BYTES = 2 * 1024 * 1024;

const execFileAsync = promisify(execFile);
const log = childLogger({ module: 'YouTubeService' });

ensureBinPath();
const YT_DLP = resolveBinary('yt-dlp', config.YTDLP_PATH);
log.info({ ytDlp: YT_DLP }, 'Using yt-dlp binary');

/**
 * YouTube refuses media requests from datacenter ranges ("Sign in to confirm
 * you're not a bot"), so a host like a VPS needs to exit through an address
 * YouTube will serve — a residential proxy, or a tunnel back to a home line.
 */
const PROXY_ARGS = config.YTDLP_PROXY ? ['--proxy', config.YTDLP_PROXY] : [];
if (config.YTDLP_PROXY) {
  // The value can carry credentials, so log only the shape of it.
  const shape = config.YTDLP_PROXY.replace(/\/\/[^@]*@/, '//***@');
  log.info({ proxy: shape }, 'Routing yt-dlp through a proxy');
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

export type SearchSource = 'music' | 'video';

export function videoIdFromUrl(url: string): string | null {
  const m = /[?&]v=([A-Za-z0-9_-]{11})/.exec(url);
  return m ? m[1] : null;
}

export interface SearchResult {
  title: string;
  url: string;
  duration: number;
  thumbnail?: string;
  artist?: string;
  album?: string;
  source?: SearchSource;
}

function queryTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

function queryOverlap(r: SearchResult, query?: string): number {
  if (!query) return 1;
  const wanted = queryTokens(query);
  if (wanted.length === 0) return 1;
  const haystack = queryTokens(`${r.title} ${r.artist ?? ''} ${r.album ?? ''}`);
  const hits = wanted.filter((t) => haystack.includes(t)).length;
  return hits / wanted.length;
}

function scoreResult(
  r: SearchResult,
  index: number,
  expectedArtist?: string,
  query?: string,
): number {
  const title = r.title.toLowerCase();
  const channel = (r.artist ?? '').toLowerCase();
  let score = 0;

  if (r.source === 'music') {
    const a = expectedArtist?.toLowerCase().trim();
    const artistOk = !a || a.length < 2 || channel.includes(a);
    const overlap = queryOverlap(r, query);
    if (artistOk && overlap >= 0.6) score += Math.round(300 * overlap);
    else score -= 100;
  } else if (expectedArtist) {
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

  const q = query?.toLowerCase() ?? '';
  const unwanted = (re: RegExp) => re.test(title) && !re.test(q);
  if (unwanted(/\b(live|concert|performance|tour)\b/)) score -= 40;
  if (unwanted(/\b(cover|remix|mashup|edit|sped up|slowed|nightcore|8d|acoustic)\b/)) score -= 50;
  if (unwanted(/\b(reaction|review|tutorial|how to)\b/)) score -= 80;
  if (unwanted(/\b(karaoke|instrumental|acapella)\b/)) score -= 60;

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
  query?: string,
): SearchResult | null {
  if (results.length === 0) return null;
  let best = results[0];
  let bestScore = scoreResult(best, 0, expectedArtist, query);
  for (let i = 1; i < results.length; i++) {
    const s = scoreResult(results[i], i, expectedArtist, query);
    if (s > bestScore) {
      best = results[i];
      bestScore = s;
    }
  }
  return best;
}

/**
 * Shared across guilds. The service holds no per-guild state, but it owns an
 * InnerTube client with its own session bootstrap, so one instance per guild
 * would duplicate that for nothing.
 */
export class YouTubeService {
  readonly music = new YouTubeMusicService();

  async search(query: string, limit = 5): Promise<SearchResult[]> {
    const correlationId = createCorrelationId();
    log.debug({ correlationId, query, limit }, 'Searching YouTube via yt-dlp');

    const cookies = cookieArgs();
    try {
      const { stdout } = await execFileAsync(
        YT_DLP,
        [
          ...PROXY_ARGS,
          ...cookies.args,
          `ytsearch${limit}:${query}`,
          '--dump-json',
          '--flat-playlist',
          '--no-warnings',
        ],
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
            source: 'video' as const,
          };
        });

      log.debug({ correlationId, count: results.length }, 'Search results found');
      return results;
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const stderr = (error as { stderr?: string })?.stderr;
      log.error({ correlationId, error: errMsg, stderr }, 'YouTube search failed');
      return [];
    } finally {
      cookies.release();
    }
  }

  getStream(url: string): Promise<{ stream: Readable; format: 'webm-opus' | 'arbitrary' }> {
    const correlationId = createCorrelationId();
    log.debug({ correlationId }, 'Getting audio stream via yt-dlp');

    return new Promise((resolve, reject) => {
      const cookies = cookieArgs();
      const ytdlp = spawn(YT_DLP, [
        ...PROXY_ARGS,
        ...cookies.args,
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
      let lastError = '';

      const formatLineRe = /^([a-z0-9]+)\/([a-z0-9._-]+)$/i;

      // Default highWaterMark is 16 KB — about a second of audio. Importing a
      // playlist spawns yt-dlp processes that compete for CPU, and a buffer that
      // small underruns as soon as the producer is starved, which Discord plays
      // back as stuttering. ~2 MB buffers roughly two minutes instead.
      const tap = new Transform({
        highWaterMark: AUDIO_BUFFER_BYTES,
        transform(chunk: Buffer, _enc, cb) {
          cb(null, chunk);
        },
      });

      ytdlp.stdout.pipe(tap);

      // Whoever owns the stream may drop it (skip, stop, or a discarded
      // prefetch). Without this the yt-dlp process lingers holding a socket.
      tap.once('close', () => {
        if (ytdlp.exitCode === null && !ytdlp.killed) {
          log.debug({ correlationId }, 'Stream closed early, terminating yt-dlp');
          ytdlp.kill('SIGKILL');
        }
      });

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
            if (/^ERROR:/i.test(trimmed)) lastError = trimmed;
            log.error({ correlationId, stderr: trimmed }, 'yt-dlp stderr');
          } else {
            log.debug({ correlationId, stderr: trimmed }, 'yt-dlp stderr');
          }
        }
      });

      ytdlp.once('error', (error) => {
        cookies.release();
        log.error({ correlationId, error: error.message }, 'yt-dlp process error');
        if (!resolved) {
          resolved = true;
          reject(error);
        }
      });

      ytdlp.once('close', (code) => {
        cookies.release();
        log.debug({ correlationId, code }, 'yt-dlp process closed');
        if (!resolved && code !== 0) {
          resolved = true;
          // Surface yt-dlp's own reason; an exit code alone tells a user nothing.
          reject(new Error(lastError || `yt-dlp exited with code ${code}`));
        }
      });

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ytdlp.kill();
          reject(new Error(lastError || 'Stream timeout — no audio data received in 30s'));
        }
      }, 30_000);
    });
  }

  async searchOne(query: string, expectedArtist?: string): Promise<SearchResult | null> {
    const results = await this.searchCandidates(query, 5);
    if (results.length === 0) return null;
    return pickBestAudio(results, expectedArtist, query);
  }

  async searchCandidates(query: string, limit = 5): Promise<SearchResult[]> {
    const [songs, videos] = await Promise.all([
      this.music.searchSongs(query, limit),
      this.search(query, limit),
    ]);

    const seen = new Set<string>();
    const merged: SearchResult[] = [];
    for (const r of [...songs, ...videos]) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      merged.push(r);
    }
    return merged;
  }

  toTrackInfo(result: SearchResult, requestedBy: string): TrackInfo {
    return {
      title: result.title,
      url: result.url,
      duration: result.duration,
      thumbnail: result.thumbnail,
      artist: result.artist,
      album: result.album,
      requestedBy,
    };
  }
}

export const youtubeService = new YouTubeService();
