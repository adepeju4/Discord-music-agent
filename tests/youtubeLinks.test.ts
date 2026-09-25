import { describe, it, expect } from 'vitest';
import { parseYouTubePlaylistId } from '../src/services/YouTubeMusicService';
import { videoIdFromUrl } from '../src/services/YouTubeService';

describe('parseYouTubePlaylistId', () => {
  const list = 'PL_qctyfaggLG0Cf8d_KTFPs6Em8Ied03b';

  it('accepts music.youtube.com, youtube.com and watch urls', () => {
    expect(parseYouTubePlaylistId(`https://music.youtube.com/playlist?list=${list}`)).toBe(list);
    expect(parseYouTubePlaylistId(`https://www.youtube.com/playlist?list=${list}`)).toBe(list);
    expect(parseYouTubePlaylistId(`https://www.youtube.com/watch?v=T4G5uTd72EM&list=${list}`)).toBe(
      list,
    );
  });

  it('accepts album (OLAK) and curated radio (RDCLAK) ids', () => {
    expect(
      parseYouTubePlaylistId('https://music.youtube.com/playlist?list=OLAK5uy_mTdhLdGxpz'),
    ).toBe('OLAK5uy_mTdhLdGxpz');
    expect(
      parseYouTubePlaylistId('https://music.youtube.com/playlist?list=RDCLAK5uy_kLWIr9gv1XL'),
    ).toBe('RDCLAK5uy_kLWIr9gv1XL');
  });

  it('rejects session-bound mixes and non-playlist urls', () => {
    expect(
      parseYouTubePlaylistId('https://www.youtube.com/watch?v=T4G5uTd72EM&list=RDT4G5uTd'),
    ).toBeNull();
    expect(parseYouTubePlaylistId('https://www.youtube.com/watch?v=T4G5uTd72EM')).toBeNull();
    expect(parseYouTubePlaylistId('chill afrobeats')).toBeNull();
  });
});

describe('videoIdFromUrl', () => {
  it('extracts the id or returns null', () => {
    expect(videoIdFromUrl('https://www.youtube.com/watch?v=T4G5uTd72EM')).toBe('T4G5uTd72EM');
    expect(videoIdFromUrl('https://www.youtube.com/watch?v=T4G5uTd72EM&list=PL123')).toBe(
      'T4G5uTd72EM',
    );
    expect(videoIdFromUrl('https://music.apple.com/us/playlist/x/pl.123')).toBeNull();
  });
});
