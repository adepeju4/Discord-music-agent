import { spawn, execFile } from 'node:child_process';
import { PassThrough, Readable } from 'node:stream';
import { promisify } from 'node:util';
import { config } from '../config';
import { childLogger, createCorrelationId } from '../utils/logger';
import type { TrackInfo } from '../utils/embeds';

function cookieArgs(): string[] {
  return config.YT_COOKIES_FROM_BROWSER
    ? ['--cookies-from-browser', config.YT_COOKIES_FROM_BROWSER]
    : [];
}

const execFileAsync = promisify(execFile);
const log = childLogger({ module: 'YouTubeService' });

// Ensure homebrew binaries (yt-dlp, ffmpeg) are in PATH
if (!process.env.PATH?.includes('/opt/homebrew/bin')) {
  process.env.PATH = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`;
}

if (config.YT_COOKIES_FROM_BROWSER) {
  log.info(
    { browser: config.YT_COOKIES_FROM_BROWSER },
    'Using browser cookies for YouTube requests',
  );
} else {
  log.info('No browser cookies configured — yt-dlp will use anonymous requests');
}

export interface SearchResult {
  title: string;
  url: string;
  duration: number;
  thumbnail?: string;
  artist?: string;
}

export class YouTubeService {
  async search(query: string, limit = 5): Promise<SearchResult[]> {
    const correlationId = createCorrelationId();
    log.debug({ correlationId, query, limit }, 'Searching YouTube via yt-dlp');

    try {
      const { stdout } = await execFileAsync(
        '/opt/homebrew/bin/yt-dlp',
        [
          ...cookieArgs(),
          `ytsearch${limit}:${query}`,
          '--dump-json',
          '--flat-playlist',
          '--no-warnings',
          '--quiet',
        ],
        { timeout: 15_000 },
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
      log.error({ correlationId, error: errMsg }, 'YouTube search failed');
      return [];
    }
  }

  getStream(url: string): Promise<Readable> {
    const correlationId = createCorrelationId();
    log.debug({ correlationId }, 'Getting audio stream via yt-dlp + ffmpeg');

    return new Promise((resolve, reject) => {
      const ytdlp = spawn('/opt/homebrew/bin/yt-dlp', [
        ...cookieArgs(),
        '-f',
        'bestaudio',
        '-o',
        '-',
        '--no-warnings',
        '--quiet',
        url,
      ]);

      const ffmpeg = spawn('/opt/homebrew/bin/ffmpeg', [
        '-i',
        'pipe:0',
        '-f',
        's16le',
        '-ar',
        '48000',
        '-ac',
        '2',
        '-loglevel',
        'error',
        'pipe:1',
      ]);

      const passthrough = new PassThrough();
      ytdlp.stdout.pipe(ffmpeg.stdin);
      ffmpeg.stdout.pipe(passthrough);

      let resolved = false;

      let bytesReceived = 0;
      passthrough.on('data', (chunk: Buffer) => {
        bytesReceived += chunk.length;
      });

      // Log download progress every 2 seconds
      const progressInterval = setInterval(() => {
        if (bytesReceived > 0) {
          log.info(
            { correlationId, bytesReceived: `${(bytesReceived / 1024).toFixed(0)}KB` },
            'Audio stream progress',
          );
        }
      }, 2000);

      passthrough.once('end', () => clearInterval(progressInterval));
      passthrough.once('close', () => clearInterval(progressInterval));

      // Resolve as soon as ffmpeg starts producing audio
      passthrough.once('readable', () => {
        if (!resolved) {
          resolved = true;
          log.info({ correlationId }, 'Audio stream ready — starting playback');
          resolve(passthrough);
        }
      });

      ytdlp.stderr.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) log.error({ correlationId, stderr: msg }, 'yt-dlp stderr');
      });

      ffmpeg.stderr.on('data', (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) log.error({ correlationId, stderr: msg }, 'ffmpeg stderr');
      });

      ytdlp.once('error', (error) => {
        log.error({ correlationId, error: error.message }, 'yt-dlp process error');
        if (!resolved) {
          resolved = true;
          reject(error);
        }
      });

      ffmpeg.once('error', (error) => {
        log.error({ correlationId, error: error.message }, 'ffmpeg process error');
        if (!resolved) {
          resolved = true;
          reject(error);
        }
      });

      ytdlp.once('close', (code) => {
        log.debug({ correlationId, code }, 'yt-dlp process closed');
        ffmpeg.stdin.end();
        if (!resolved && code !== 0) {
          resolved = true;
          reject(new Error(`yt-dlp exited with code ${code}`));
        }
      });

      ffmpeg.once('close', (code) => {
        log.debug({ correlationId, code }, 'ffmpeg process closed');
        ytdlp.kill();
        if (!resolved && code !== 0) {
          resolved = true;
          reject(new Error(`ffmpeg exited with code ${code}`));
        }
      });

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          ytdlp.kill();
          ffmpeg.kill();
          reject(new Error('Stream timeout — no audio data received in 10s'));
        }
      }, 10_000);
    });
  }

  async searchOne(query: string): Promise<SearchResult | null> {
    const results = await this.search(query, 1);
    return results[0] ?? null;
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
