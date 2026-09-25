import { describe, it, expect } from 'vitest';
import { parseSpotifyRef } from '../src/services/SpotifyService';

describe('parseSpotifyRef', () => {
  const id = '4cOdK2wGLETKBW3PvgPWqT';

  it('parses track, album and playlist URLs', () => {
    expect(parseSpotifyRef(`https://open.spotify.com/track/${id}`)).toEqual({ type: 'track', id });
    expect(parseSpotifyRef(`https://open.spotify.com/album/${id}`)).toEqual({ type: 'album', id });
    expect(parseSpotifyRef(`https://open.spotify.com/playlist/${id}`)).toEqual({
      type: 'playlist',
      id,
    });
  });

  it('accepts share-link query strings, locale prefixes and URIs', () => {
    expect(parseSpotifyRef(`https://open.spotify.com/track/${id}?si=abc123`)).toEqual({
      type: 'track',
      id,
    });
    expect(parseSpotifyRef(`https://open.spotify.com/intl-de/album/${id}`)).toEqual({
      type: 'album',
      id,
    });
    expect(parseSpotifyRef(`spotify:playlist:${id}`)).toEqual({ type: 'playlist', id });
    expect(parseSpotifyRef(`  open.spotify.com/track/${id}  `)).toEqual({ type: 'track', id });
  });

  it('rejects everything else', () => {
    expect(parseSpotifyRef('asake lonely at the top')).toBeNull();
    expect(parseSpotifyRef(`https://open.spotify.com/artist/${id}`)).toBeNull();
    expect(parseSpotifyRef('https://www.youtube.com/watch?v=T4G5uTd72EM')).toBeNull();
    expect(parseSpotifyRef('https://open.spotify.com/track/short')).toBeNull();
  });
});
