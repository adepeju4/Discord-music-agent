import type { GeminiAgent } from './GeminiAgent';
import { pickBestAudio, type SearchResult, type YouTubeService } from '../services/YouTubeService';
import type { TrackInfo } from '../utils/embeds';
import { childLogger, createCorrelationId } from '../utils/logger';

const log = childLogger({ module: 'resolveTracks' });

export interface TrackIntent {
  title: string;
  artist: string;
  durationMs?: number;
}

const DURATION_TOLERANCE_S = 4;
const CONCURRENCY = 5;

export interface ResolveOptions {
  /**
   * Evaluated before each batch. Every lookup spawns a yt-dlp process, so while
   * audio is playing the caller throttles this down — otherwise the import
   * starves the audio pipe and playback stutters.
   */
  concurrency?: () => number;
}

export function normalizeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function confidentCatalogMatch(
  candidates: SearchResult[],
  intent: TrackIntent,
): SearchResult | null {
  const wantTitle = normalizeText(intent.title);
  const primaryArtist = normalizeText(intent.artist.split(/,|&| feat\.? | ft\.? /i)[0] ?? '');
  const wantSeconds = intent.durationMs ? Math.round(intent.durationMs / 1000) : null;

  for (const c of candidates) {
    if (c.source !== 'music') continue;
    const title = normalizeText(c.title);
    if (title !== wantTitle && !title.startsWith(wantTitle) && !wantTitle.startsWith(title)) {
      continue;
    }
    if (primaryArtist && !normalizeText(c.artist ?? '').includes(primaryArtist)) continue;
    if (wantSeconds !== null && c.duration > 0) {
      if (Math.abs(c.duration - wantSeconds) > DURATION_TOLERANCE_S) continue;
    }
    return c;
  }
  return null;
}

export async function resolveTrackIntents(
  youtube: YouTubeService,
  gemini: GeminiAgent,
  intents: TrackIntent[],
  requestedBy: string,
  onTrack: (track: TrackInfo, index: number) => Promise<void> | void,
  options?: ResolveOptions,
): Promise<{ resolved: number; failed: number }> {
  const correlationId = createCorrelationId();
  let resolved = 0;
  let failed = 0;

  let batchStart = 0;
  while (batchStart < intents.length) {
    const requested = options?.concurrency?.() ?? CONCURRENCY;
    const size = Math.max(1, Math.min(Math.floor(requested), CONCURRENCY));
    const batch = intents.slice(batchStart, batchStart + size);
    const candidateLists = await Promise.all(
      batch.map((t) => youtube.searchCandidates(`${t.title} ${t.artist}`, 5)),
    );

    const picked: (SearchResult | null)[] = batch.map((intent, i) =>
      confidentCatalogMatch(candidateLists[i], intent),
    );

    const needLlm = batch
      .map((intent, i) => ({ intent, i }))
      .filter(({ i }) => picked[i] === null && candidateLists[i].length > 0);

    if (needLlm.length > 0) {
      const llmPicks = await gemini.pickBestBatch(
        needLlm.map(({ intent, i }) => ({
          intent: { title: intent.title, artist: intent.artist },
          candidates: candidateLists[i].map((c) => ({
            title: c.title,
            channel: c.artist,
            duration: c.duration,
            album: c.album,
            source: c.source,
          })),
        })),
      );
      needLlm.forEach(({ intent, i }, k) => {
        const idx = llmPicks[k];
        const cands = candidateLists[i];
        picked[i] =
          idx !== null && idx >= 0 && idx < cands.length
            ? cands[idx]
            : pickBestAudio(cands, intent.artist, `${intent.title} ${intent.artist}`);
      });
    }

    for (let i = 0; i < batch.length; i++) {
      const sr = picked[i];
      const index = batchStart + i;
      if (!sr) {
        failed++;
        log.info(
          { correlationId, track: `${batch[i].title} - ${batch[i].artist}` },
          'Track not found — skipping',
        );
        continue;
      }
      resolved++;
      await onTrack(youtube.toTrackInfo(sr, requestedBy), index);
    }

    batchStart += batch.length;
  }

  log.info({ correlationId, resolved, failed, total: intents.length }, 'Track intents resolved');
  return { resolved, failed };
}
