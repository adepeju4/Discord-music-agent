import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

process.env.SPOTIFY_CLIENT_ID = 'test-id';
process.env.SPOTIFY_CLIENT_SECRET = 'test-secret';

const calls: string[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const base = 'https://api.spotify.com/v1';
const albumId = 'AAAAAAAAAAAAAAAAAAAAAA';
const playlistId = 'PPPPPPPPPPPPPPPPPPPPPP';

function fakeFetch(url: string | URL | Request): Promise<Response> {
  const u = String(url);
  calls.push(u);
  if (u.startsWith('https://accounts.spotify.com/api/token')) {
    return Promise.resolve(json({ access_token: 'tok', expires_in: 3600 }));
  }
  if (u === `${base}/albums/${albumId}`) {
    return Promise.resolve(
      json({ name: 'The Year I Turned 21', artists: [{ name: 'Ayra Starr' }] }),
    );
  }
  if (u.startsWith(`${base}/albums/${albumId}/tracks`)) {
    const page2 = u.includes('offset=50');
    return Promise.resolve(
      json({
        items: Array.from({ length: page2 ? 3 : 50 }, (_, i) => ({
          name: `Track ${page2 ? 50 + i : i}`,
          artists: [{ name: 'Ayra Starr' }],
          duration_ms: 180_000,
        })),
        next: page2 ? null : `${base}/albums/${albumId}/tracks?offset=50&limit=50`,
        total: 53,
      }),
    );
  }
  if (u.startsWith(`${base}/playlists/${playlistId}?`)) {
    return Promise.resolve(json({ name: 'Afrobeats Mix', owner: { display_name: 'holysaint' } }));
  }
  if (u.startsWith(`${base}/playlists/${playlistId}/tracks`)) {
    return Promise.resolve(
      json({
        items: [
          { track: { name: 'Rush', artists: [{ name: 'Ayra Starr' }], duration_ms: 185_000 } },
          { track: null },
          { track: { name: 'Local', artists: [{ name: 'Me' }], duration_ms: 1, is_local: true } },
          {
            track: {
              name: 'Commas',
              artists: [{ name: 'Ayra Starr' }, { name: 'Rema' }],
              duration_ms: 170_000,
            },
          },
        ],
        next: null,
        total: 4,
      }),
    );
  }
  return Promise.resolve(json({ error: 'not found' }, 404));
}

describe('SpotifyService.resolve', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(fakeFetch));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('walks album pages, caches the token and applies the import cap', async () => {
    const { SpotifyService } = await import('../src/services/SpotifyService');
    const spotify = new SpotifyService();
    expect(spotify.isConfigured).toBe(true);

    const album = await spotify.resolve({ type: 'album', id: albumId });
    expect(album.type).toBe('album');
    expect(album.name).toBe('The Year I Turned 21');
    expect(album.owner).toBe('Ayra Starr');
    expect(album.total).toBe(53);
    expect(album.tracks).toHaveLength(53);
    expect(album.tracks[52]).toEqual({
      title: 'Track 52',
      artist: 'Ayra Starr',
      durationMs: 180_000,
    });

    const capped = await spotify.resolve({ type: 'album', id: albumId }, 10);
    expect(capped.tracks).toHaveLength(10);
    expect(capped.total).toBe(53);

    const tokenCalls = calls.filter((c) => c.includes('accounts.spotify.com'));
    expect(tokenCalls).toHaveLength(1);
  });

  it('drops unavailable and local playlist entries and joins artists', async () => {
    const { SpotifyService } = await import('../src/services/SpotifyService');
    const playlist = await new SpotifyService().resolve({ type: 'playlist', id: playlistId });
    expect(playlist.name).toBe('Afrobeats Mix');
    expect(playlist.owner).toBe('holysaint');
    expect(playlist.tracks.map((t) => t.title)).toEqual(['Rush', 'Commas']);
    expect(playlist.tracks[1].artist).toBe('Ayra Starr, Rema');
  });

  it('surfaces API errors', async () => {
    const { SpotifyService } = await import('../src/services/SpotifyService');
    await expect(
      new SpotifyService().resolve({ type: 'track', id: 'XXXXXXXXXXXXXXXXXXXXXX' }),
    ).rejects.toThrow(/404/);
  });
});

describe('SpotifyService embed fallback', () => {
  const embedHtml = (entity: unknown) =>
    `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: { pageProps: { state: { data: { entity } } } },
    })}</script></html>`;

  beforeEach(() => calls.splice(0, calls.length));
  afterEach(() => vi.unstubAllGlobals());

  it('falls back to the embed page when the tracks endpoint is forbidden', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const u = String(url);
        calls.push(u);
        if (u.startsWith('https://accounts.spotify.com'))
          return Promise.resolve(json({ access_token: 'tok', expires_in: 3600 }));
        if (u.includes('/playlists/') && u.includes('/tracks'))
          return Promise.resolve(json({ error: { status: 403, message: 'Forbidden' } }, 403));
        if (u.includes('api.spotify.com'))
          return Promise.resolve(json({ name: 'Afrobeats', owner: { display_name: 'x' } }));
        return Promise.resolve(
          new Response(
            embedHtml({
              type: 'playlist',
              name: 'Afrobeats Hits',
              subtitle: 'EMA Records',
              trackList: [
                { title: 'Rush', subtitle: 'Ayra Starr', duration: 185093 },
                { title: 'CHANEL', subtitle: 'Tyla', duration: 188059 },
                { subtitle: 'no title, dropped' },
              ],
            }),
            { status: 200 },
          ),
        );
      }),
    );

    const { SpotifyService } = await import('../src/services/SpotifyService');
    const result = await new SpotifyService().resolve({ type: 'playlist', id: playlistId });

    expect(calls.some((c) => c.includes('open.spotify.com/embed/playlist/'))).toBe(true);
    expect(result.name).toBe('Afrobeats Hits');
    expect(result.owner).toBe('EMA Records');
    expect(result.tracks).toEqual([
      { title: 'Rush', artist: 'Ayra Starr', durationMs: 185093 },
      { title: 'CHANEL', artist: 'Tyla', durationMs: 188059 },
    ]);
  });

  it('reads a single track from the entity itself', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string | URL | Request) => {
        const u = String(url);
        if (u.startsWith('https://accounts.spotify.com'))
          return Promise.resolve(json({ access_token: 'tok', expires_in: 3600 }));
        if (u.includes('api.spotify.com')) return Promise.resolve(json({ error: 'nope' }, 404));
        return Promise.resolve(
          new Response(
            embedHtml({
              type: 'track',
              name: 'Sandstorm',
              artists: [{ name: 'Darude' }],
              duration: 225493,
            }),
            { status: 200 },
          ),
        );
      }),
    );

    const { SpotifyService } = await import('../src/services/SpotifyService');
    const result = await new SpotifyService().resolve({ type: 'track', id: albumId });
    expect(result.tracks).toEqual([{ title: 'Sandstorm', artist: 'Darude', durationMs: 225493 }]);
  });
});
