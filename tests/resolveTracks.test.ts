import { describe, it, expect } from 'vitest';
import {
  confidentCatalogMatch,
  normalizeText,
  resolveTrackIntents,
} from '../src/agent/resolveTracks';
import type { SearchResult } from '../src/services/YouTubeService';

function song(title: string, artist: string, duration: number): SearchResult {
  return { title, artist, duration, url: `https://youtube.com/watch?v=${title}`, source: 'music' };
}

describe('normalizeText', () => {
  it('strips accents, case and punctuation', () => {
    expect(normalizeText('Déjà Vu (feat. Ayra Starr)!')).toBe('deja vu feat ayra starr');
  });
});

describe('confidentCatalogMatch', () => {
  it('accepts a catalog song with matching title, artist and duration', () => {
    const picked = confidentCatalogMatch(
      [song('Rush', 'Ayra Starr', 185), song('Rush (Sped Up)', 'Ayra Starr', 150)],
      { title: 'Rush', artist: 'Ayra Starr', durationMs: 186_000 },
    );
    expect(picked?.title).toBe('Rush');
  });

  it('rejects when the duration is off by more than the tolerance', () => {
    const picked = confidentCatalogMatch([song('Rush', 'Ayra Starr', 240)], {
      title: 'Rush',
      artist: 'Ayra Starr',
      durationMs: 186_000,
    });
    expect(picked).toBeNull();
  });

  it('rejects a different artist and ignores video results', () => {
    const video: SearchResult = {
      title: 'Rush',
      artist: 'Ayra Starr',
      duration: 185,
      url: 'https://youtube.com/watch?v=vid',
      source: 'video',
    };
    expect(
      confidentCatalogMatch([song('Rush', 'Troye Sivan', 185), video], {
        title: 'Rush',
        artist: 'Ayra Starr',
        durationMs: 185_000,
      }),
    ).toBeNull();
  });

  it('matches on the primary artist of a collaboration', () => {
    const picked = confidentCatalogMatch([song('Commas', 'Ayra Starr, Rema', 170)], {
      title: 'Commas',
      artist: 'Ayra Starr, Rema',
      durationMs: 171_000,
    });
    expect(picked?.title).toBe('Commas');
  });
});

describe('resolveTrackIntents concurrency', () => {
  function fakes(batchSizes: number[]) {
    let inFlight = 0;
    const youtube = {
      async searchCandidates(query: string): Promise<SearchResult[]> {
        inFlight++;
        await new Promise((r) => setTimeout(r, 5));
        batchSizes[batchSizes.length - 1] = Math.max(batchSizes[batchSizes.length - 1], inFlight);
        inFlight--;
        const [title, ...rest] = query.split(' ');
        return [song(title, rest.join(' '), 180)];
      },
      toTrackInfo(r: SearchResult, requestedBy: string) {
        return { ...r, requestedBy };
      },
    };
    const gemini = {
      async pickBestBatch() {
        return [];
      },
    };
    return { youtube, gemini };
  }

  it('never exceeds the concurrency the caller asks for', async () => {
    const intents = Array.from({ length: 9 }, (_, i) => ({ title: `T${i}`, artist: 'A' }));
    const observed: number[] = [];
    const { youtube, gemini } = fakes(observed);

    await resolveTrackIntents(
      youtube as never,
      gemini as never,
      intents,
      'tester',
      () => {
        observed.push(0);
      },
      { concurrency: () => 2 },
    );

    expect(Math.max(...observed.filter((n) => n > 0))).toBeLessThanOrEqual(2);
  });

  it('caps at the built-in maximum and never stalls on a bad value', async () => {
    const intents = Array.from({ length: 6 }, (_, i) => ({ title: `T${i}`, artist: 'A' }));
    for (const value of [99, 0, -1]) {
      const observed: number[] = [0];
      const { youtube, gemini } = fakes(observed);
      const { resolved } = await resolveTrackIntents(
        youtube as never,
        gemini as never,
        intents,
        'tester',
        () => {
          observed.push(0);
        },
        { concurrency: () => value },
      );
      expect(resolved).toBe(intents.length);
      expect(Math.max(...observed)).toBeLessThanOrEqual(5);
    }
  });
});
