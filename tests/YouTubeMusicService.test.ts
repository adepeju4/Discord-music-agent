import { describe, it, expect } from 'vitest';
import { YouTubeMusicService } from '../src/services/YouTubeMusicService';
import { YouTubeService } from '../src/services/YouTubeService';

describe('YouTubeMusicService', () => {
  const ytm = new YouTubeMusicService();

  it('returns catalog songs with artist, album and duration', async () => {
    const results = await ytm.searchSongs('fela kuti water no get enemy', 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(3);

    // Every result must be a well-formed catalog entry.
    for (const r of results) {
      expect(r.source).toBe('music');
      expect(r.title).toBeTruthy();
      expect(r.artist).toBeTruthy();
      expect(r.duration).toBeGreaterThan(0);
      expect(r.url).toMatch(/youtube\.com\/watch\?v=/);
      expect(r.thumbnail).toContain('=w544-h544');
    }

    // YouTube Music reorders results between identical calls and occasionally
    // swaps one out, so assert the track is in the set rather than first.
    const match = results.find(
      (r) =>
        r.title.toLowerCase().includes('water no get enemy') &&
        (r.artist ?? '').includes('Fela Kuti'),
    );
    expect(
      match,
      `expected the track among: ${results.map((r) => r.title).join(', ')}`,
    ).toBeTruthy();
    expect(match!.album).toBeTruthy();
  }, 20_000);
});

describe('YouTubeService.searchCandidates', () => {
  it('merges catalog songs ahead of video results without duplicates', async () => {
    const yt = new YouTubeService();
    const results = await yt.searchCandidates('burna boy last last', 5);
    expect(results.length).toBeGreaterThan(3);
    expect(results[0].source).toBe('music');
    expect(results.some((r) => r.source === 'video')).toBe(true);
    expect(new Set(results.map((r) => r.url)).size).toBe(results.length);
  }, 30_000);
});

describe('YouTubeMusicService albums', () => {
  it('finds albums by artist and loads their tracks as catalog entries', async () => {
    const ytm = new YouTubeMusicService();
    const albums = await ytm.searchAlbums('the year i turned 21 ayra starr', 5);
    expect(albums.length).toBeGreaterThan(0);
    const target = albums.find((a) => a.title.toLowerCase().includes('the year i turned 21'));
    expect(target).toBeTruthy();
    expect(target!.artist).toContain('Ayra Starr');

    const album = await ytm.getAlbum(target!);
    expect(album).not.toBeNull();
    expect(album!.tracks.length).toBeGreaterThan(5);
    for (const t of album!.tracks) {
      expect(t.source).toBe('music');
      expect(t.url).toMatch(/youtube\.com\/watch\?v=/);
      expect(t.duration).toBeGreaterThan(0);
      expect(t.artist).toBeTruthy();
      expect(t.album).toBe(album!.title);
    }
  }, 30_000);
});

describe('YouTubeMusicService discovery', () => {
  const ytm = new YouTubeMusicService();

  it('builds a radio station of catalog tracks from a seed video', async () => {
    const [seed] = await ytm.searchSongs('ayra starr rush', 1);
    expect(seed).toBeTruthy();
    const seedId = seed.url.split('v=')[1];

    const radio = await ytm.getRadio(seedId, 10);
    expect(radio.length).toBeGreaterThan(5);
    for (const t of radio) {
      expect(t.source).toBe('music');
      expect(t.url).toMatch(/youtube\.com\/watch\?v=/);
      expect(t.duration).toBeGreaterThan(0);
      expect(t.title).toBeTruthy();
    }
    expect(new Set(radio.map((t) => t.url)).size).toBe(radio.length);
  }, 30_000);

  it('finds real playlists for a theme and loads their tracks', async () => {
    const playlists = await ytm.searchPlaylists('chill afrobeats', 3);
    expect(playlists.length).toBeGreaterThan(0);
    expect(playlists[0].id).toBeTruthy();
    expect(playlists[0].title).toBeTruthy();

    const details = await ytm.getPlaylistTracks(playlists[0].id, 10);
    expect(details).not.toBeNull();
    expect(details!.tracks.length).toBeGreaterThan(3);
    expect(details!.tracks.every((t) => t.source === 'music')).toBe(true);
    // The generic "Playlist • 2026" subtitle is filtered out rather than shown.
    if (details!.author !== undefined) {
      expect(details!.author).not.toMatch(/^Playlist\s*[•·]/);
    }
  }, 30_000);

  it('collects a deduplicated theme pool across playlists', async () => {
    const pool = await ytm.collectThemeTracks('chill afrobeats', 2, 30);
    expect(pool.length).toBeGreaterThan(10);
    expect(pool.length).toBeLessThanOrEqual(30);
    const keys = pool.map((t) => `${t.title}::${t.artist}`.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  }, 40_000);
});
