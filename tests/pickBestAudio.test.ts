import { describe, it, expect } from 'vitest';
import { pickBestAudio } from '../src/services/YouTubeService';
import type { SearchResult } from '../src/services/YouTubeService';

function r(title: string, artist = 'Some Channel'): SearchResult {
  return {
    title,
    artist,
    url: 'https://youtube.com/watch?v=' + encodeURIComponent(title),
    duration: 200,
  };
}

describe('pickBestAudio', () => {
  it('prefers "Official Audio" over "Official Video"', () => {
    const picked = pickBestAudio([
      r('PinkPantheress - Stateside (Official Video)'),
      r('PinkPantheress - Stateside (Official Audio)'),
      r('PinkPantheress - Stateside (Live)'),
    ]);
    expect(picked?.title).toBe('PinkPantheress - Stateside (Official Audio)');
  });

  it('prefers Topic channels (auto-generated YouTube Music uploads)', () => {
    const picked = pickBestAudio([
      r('Stateside (Official Video)', 'PinkPantheress'),
      r('Stateside', 'PinkPantheress - Topic'),
      r('Stateside Reaction', 'SomeReactor'),
    ]);
    expect(picked?.artist).toBe('PinkPantheress - Topic');
  });

  it('penalizes live, cover, remix, reaction, karaoke', () => {
    const picked = pickBestAudio([
      r('Hello - Adele (Live at Royal Albert Hall)'),
      r('Hello - Adele (Cover by X)'),
      r('Hello - Adele Reaction Video'),
      r('Hello - Adele'),
      r('Hello - Adele Karaoke'),
    ]);
    expect(picked?.title).toBe('Hello - Adele');
  });

  it('falls back to index tiebreaker when all signals are equal', () => {
    const picked = pickBestAudio([r('Some Song'), r('Some Song Alt'), r('Some Song Third')]);
    // Plain titles with same score → earliest wins
    expect(picked?.title).toBe('Some Song');
  });

  it('returns null for empty input', () => {
    expect(pickBestAudio([])).toBeNull();
  });

  it('prefers "Official Audio" even over a Topic channel upload', () => {
    // In practice Topic channels rarely have "Official Audio" in the title —
    // either signal alone gets the pick, and Official Audio wins when both exist.
    const picked = pickBestAudio([
      r('Song Title', 'Artist - Topic'),
      r('Song Title (Official Audio)', 'ArtistVEVO'),
    ]);
    expect(picked?.title).toBe('Song Title (Official Audio)');
  });

  describe('with expectedArtist', () => {
    it('picks the artist channel upload over a fan lyric video', () => {
      // Real-world Halo search results
      const picked = pickBestAudio(
        [
          r('Beyoncé - Halo', 'Beyoncé'),
          r('Halo - Beyoncé (Lyrics)', 'Melody Music'),
          r('Beyoncé - Halo (Live From Wynn Las Vegas)', 'Beyoncé'),
          r('Beyonce - Halo - Acoustic: LIVE! Hospital', 'Trevor New'),
          r('Beyoncé - Halo (Live)', 'Beyoncé'),
        ],
        'Beyoncé',
      );
      expect(picked?.title).toBe('Beyoncé - Halo');
    });

    it('picks a Topic channel upload when present', () => {
      const picked = pickBestAudio(
        [r('Halo', 'Beyoncé'), r('Halo', 'Beyoncé - Topic'), r('Halo (Lyrics)', 'Melody Music')],
        'Beyoncé',
      );
      expect(picked?.artist).toBe('Beyoncé - Topic');
    });

    it('still prefers Official Audio over a non-official artist upload', () => {
      const picked = pickBestAudio(
        [r('Song (Live)', 'Artist'), r('Song (Official Audio)', 'Some Music Channel')],
        'Artist',
      );
      expect(picked?.title).toBe('Song (Official Audio)');
    });

    it('penalizes lyric videos by fan channels', () => {
      const picked = pickBestAudio(
        [r('Song - Artist', 'Artist'), r('Song - Artist (Lyrics)', 'Lyric Uploader')],
        'Artist',
      );
      expect(picked?.artist).toBe('Artist');
    });
  });
});

describe('pickBestAudio with catalog results', () => {
  function song(title: string, artist: string, album?: string): SearchResult {
    return {
      title,
      artist,
      album,
      url: 'https://youtube.com/watch?v=song-' + encodeURIComponent(title),
      duration: 200,
      source: 'music',
    };
  }
  function video(title: string, channel = 'Some Channel'): SearchResult {
    return { ...r(title, channel), source: 'video' };
  }

  it('prefers a matching catalog song over every video signal', () => {
    const picked = pickBestAudio(
      [
        video('Stateside (Official Audio)', 'PinkPantheress'),
        video('Stateside', 'PinkPantheress - Topic'),
        song('Stateside', 'PinkPantheress', 'Fancy That'),
      ],
      'PinkPantheress',
      'pinkpantheress stateside',
    );
    expect(picked?.source).toBe('music');
  });

  it('ignores catalog songs whose artist does not match the expected artist', () => {
    const picked = pickBestAudio(
      [
        song('Hello', 'Lionel Richie', "Can't Slow Down"),
        video('Adele - Hello (Official Audio)', 'Adele'),
      ],
      'Adele',
    );
    expect(picked?.artist).toBe('Adele');
  });

  it('ignores catalog songs that do not resemble the query', () => {
    const picked = pickBestAudio(
      [
        song('It Makes You Forget (Itgehane)', 'Peggy Gou', 'Once'),
        video('Peggy Gou Boiler Room London DJ Set', 'Boiler Room'),
      ],
      undefined,
      'peggy gou boiler room set',
    );
    expect(picked?.source).toBe('video');
  });

  it('does not penalize a variant the query asked for', () => {
    const picked = pickBestAudio(
      [
        song('Lonely At The Top', 'Asake', 'Work Of Art'),
        song('Lonely At The Top (Remix)', 'Asake, H.E.R.', 'Lonely At The Top (Remix)'),
      ],
      'Asake',
      'asake lonely at the top remix',
    );
    expect(picked?.title).toBe('Lonely At The Top (Remix)');
  });

  it('prefers the original over remix and acoustic variants by default', () => {
    const picked = pickBestAudio(
      [
        song('Lonely At The Top (Remix)', 'Asake, H.E.R.', 'Lonely At The Top (Remix)'),
        song('Lonely At The Top (Acoustic)', 'Asake, H.E.R.', 'Lonely At The Top EP'),
        song('Lonely At The Top', 'Asake', 'Work Of Art'),
      ],
      'Asake',
      'asake lonely at the top',
    );
    expect(picked?.title).toBe('Lonely At The Top');
  });

  it('accepts a catalog song when neither artist nor query is supplied', () => {
    const picked = pickBestAudio([
      video('Some Song (Official Video)', 'Artist'),
      song('Some Song', 'Artist'),
    ]);
    expect(picked?.source).toBe('music');
  });
});
