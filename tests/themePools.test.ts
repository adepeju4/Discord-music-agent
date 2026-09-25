import { describe, it, expect, vi, afterEach } from 'vitest';
import { YouTubeMusicService } from '../src/services/YouTubeMusicService';
import type { SearchResult } from '../src/services/YouTubeService';

function song(title: string, artist: string, duration = 180): SearchResult {
  return {
    title,
    artist,
    duration,
    url: `https://www.youtube.com/watch?v=${title.slice(0, 11).padEnd(11, 'x')}`,
    source: 'music',
  };
}

// What YTM returns for generic queries: hour-long mixes with no artist.
const junk: SearchResult[] = [
  { title: 'AFROBEAT MIXTAPE 2026 🔥 Best Jams', duration: 0, url: 'https://x/1', source: 'music' },
  {
    title: 'NAIJA VIDEO MIX',
    artist: 'undefined',
    duration: 3600,
    url: 'https://x/2',
    source: 'music',
  },
  song('Some DJ Mix', 'DJ Someone', 4200),
];

function stub(svc: YouTubeMusicService, byPlaylist: Record<string, SearchResult[]>) {
  vi.spyOn(svc, 'searchPlaylists').mockImplementation(async (query: string) =>
    Object.keys(byPlaylist)
      .filter((id) => id.startsWith(query.includes('2026') ? 'recent' : 'classic'))
      .map((id) => ({ id, title: id })),
  );
  vi.spyOn(svc, 'getPlaylistTracks').mockImplementation(async (id: string) => ({
    id,
    title: id,
    tracks: byPlaylist[id] ?? [],
  }));
  vi.spyOn(svc, 'searchSongs').mockResolvedValue([]);
  vi.spyOn(svc, 'getRadio').mockResolvedValue([]);
}

describe('collectThemeTracks', () => {
  afterEach(() => vi.restoreAllMocks());

  it('drops mixes and entries with no artist or implausible length', async () => {
    const svc = new YouTubeMusicService();
    stub(svc, { classic1: [...junk, song('Calm Down', 'Rema')] });

    const pool = await svc.collectThemeTracks('afrobeats');
    expect(pool.map((t) => t.title)).toEqual(['Calm Down']);
  });

  it('reads further playlists when the first ones are all junk', async () => {
    const svc = new YouTubeMusicService();
    stub(svc, {
      classic1: junk,
      classic2: junk,
      classic3: [song('Free Mind', 'Tems')],
      classic4: [song('Balance', 'Wizkid')],
    });

    const pool = await svc.collectThemeTracks('afrobeats');
    expect(pool.map((t) => t.title).sort()).toEqual(['Balance', 'Free Mind']);
  });

  it('deduplicates across playlists and respects the limit', async () => {
    const svc = new YouTubeMusicService();
    stub(svc, {
      classic1: [song('Calm Down', 'Rema'), song('Ye', 'Burna Boy')],
      classic2: [song('Calm Down', 'Rema'), song('Water', 'Tyla')],
    });

    expect(await svc.collectThemeTracks('afrobeats')).toHaveLength(3);
    expect(await svc.collectThemeTracks('afrobeats', 6, 2)).toHaveLength(2);
  });
});

describe('collectThemePools', () => {
  afterEach(() => vi.restoreAllMocks());

  it('separates recent from established and never double-counts a track', async () => {
    const svc = new YouTubeMusicService();
    stub(svc, {
      recent1: [song('Dull', 'Asake'), song('Calm Down', 'Rema')],
      classic1: [song('Calm Down', 'Rema'), song('Ye', 'Burna Boy')],
    });

    const pools = await svc.collectThemePools('afrobeats');
    expect(pools.recent.map((t) => t.title)).toEqual(['Dull', 'Calm Down']);
    // 'Calm Down' is already in the recent pool, so it is not offered twice.
    expect(pools.classic.map((t) => t.title)).toEqual(['Ye']);
  });

  it('queries the current year for the recent pool', async () => {
    const svc = new YouTubeMusicService();
    stub(svc, { recent1: [song('Dull', 'Asake')], classic1: [song('Ye', 'Burna Boy')] });

    await svc.collectThemePools('afrobeats');
    const queries = vi.mocked(svc.searchPlaylists).mock.calls.map((c) => c[0]);
    expect(queries).toContain(`afrobeats ${new Date().getFullYear()}`);
    expect(queries).toContain('afrobeats');
  });
});
