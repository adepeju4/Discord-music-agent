import { describe, it, expect, vi, afterEach } from 'vitest';
import { AppleMusicService, parseAppleMusicRef } from '../src/services/AppleMusicService';

describe('parseAppleMusicRef', () => {
  const pl = 'pl.f4d106fed2bd41149aaacabb233eb5eb';

  it('parses playlist links and normalizes the url', () => {
    expect(parseAppleMusicRef(`https://music.apple.com/us/playlist/todays-hits/${pl}`)).toEqual({
      kind: 'playlist',
      url: `https://music.apple.com/us/playlist/todays-hits/${pl}`,
    });
  });

  it('keeps the storefront and drops tracking query strings', () => {
    const ref = parseAppleMusicRef(
      `https://music.apple.com/gb/playlist/todays-hits/${pl}?l=en&at=123`,
    );
    expect(ref).toEqual({
      kind: 'playlist',
      url: `https://music.apple.com/gb/playlist/todays-hits/${pl}`,
    });
  });

  it('treats an album link as an album but ?i= as a single song', () => {
    expect(
      parseAppleMusicRef('https://music.apple.com/us/album/the-year-i-turned-21/1739659461'),
    ).toEqual({
      kind: 'album',
      url: 'https://music.apple.com/us/album/the-year-i-turned-21/1739659461',
    });
    expect(
      parseAppleMusicRef('https://music.apple.com/us/album/commas/1739659461?i=1739659999'),
    ).toEqual({
      kind: 'song',
      url: 'https://music.apple.com/us/album/commas/1739659461?i=1739659999',
      trackId: '1739659999',
    });
  });

  it('rejects other links and plain text', () => {
    expect(parseAppleMusicRef('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT')).toBeNull();
    expect(parseAppleMusicRef('https://music.apple.com/us/artist/ayra-starr/1234')).toBeNull();
    expect(parseAppleMusicRef('chill afrobeats')).toBeNull();
  });
});

describe('AppleMusicService.resolve', () => {
  function lockup(id: string, title: string, artistName: string, duration = 180_000) {
    return {
      title,
      artistName,
      duration,
      contentDescriptor: { identifiers: { storeAdamID: id } },
    };
  }

  function page(ogTitle: string, items: unknown[]) {
    const data = { data: [{ data: { sections: [{ itemKind: 'trackLockup', items }] } }] };
    return [
      '<html><head>',
      `<meta property="og:title" content="${ogTitle}"/>`,
      '</head><body>',
      `<script type="application/json" id="serialized-server-data">${JSON.stringify(data)}</script>`,
      '</body></html>',
    ].join('');
  }

  const album = [
    lockup('1', 'Birds Sing of Money', 'Ayra Starr', 163500),
    lockup('2', 'Commas', 'Ayra Starr', 157090),
    lockup('3', 'Rush', 'Ayra Starr', 185093),
  ];

  function stubPage(html: string) {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(html, { status: 200 }))),
    );
  }

  afterEach(() => vi.unstubAllGlobals());

  it('picks the track named by ?i= rather than the first on the album', async () => {
    stubPage(page('Rush by Ayra Starr on Apple Music', album));
    const svc = new AppleMusicService();
    const ref = parseAppleMusicRef('https://music.apple.com/us/album/rush/999?i=3')!;
    const result = await svc.resolve(ref);

    expect(ref.trackId).toBe('3');
    expect(result.kind).toBe('song');
    expect(result.tracks).toEqual([{ title: 'Rush', artist: 'Ayra Starr', durationMs: 185093 }]);
    expect(result.name).toBe('Rush');
  });

  it('strips Apple’s " by <artist> on Apple Music" suffix from collection names', async () => {
    stubPage(page('The Year I Turned 21 by Ayra Starr on Apple Music', album));
    const result = await new AppleMusicService().resolve(
      parseAppleMusicRef('https://music.apple.com/us/album/the-year-i-turned-21/999')!,
    );
    expect(result.name).toBe('The Year I Turned 21');
    expect(result.tracks).toHaveLength(3);
  });

  it('honours the import limit and drops duplicate track ids', async () => {
    stubPage(
      page('Mix on Apple Music', [...album, lockup('1', 'Birds Sing of Money', 'Ayra Starr')]),
    );
    const result = await new AppleMusicService().resolve(
      parseAppleMusicRef('https://music.apple.com/us/playlist/mix/pl.abc')!,
      2,
    );
    expect(result.name).toBe('Mix');
    expect(result.tracks.map((t) => t.title)).toEqual(['Birds Sing of Money', 'Commas']);
  });

  it('fails clearly when the page carries no track data', async () => {
    stubPage('<html><body>nothing here</body></html>');
    await expect(
      new AppleMusicService().resolve(
        parseAppleMusicRef('https://music.apple.com/us/playlist/x/pl.abc')!,
      ),
    ).rejects.toThrow(/no track data/i);
  });
});
