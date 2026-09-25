import { Innertube } from 'youtubei.js';
import { childLogger, createCorrelationId } from '../utils/logger';
import type { SearchResult } from './YouTubeService';

const log = childLogger({ module: 'YouTubeMusicService' });

const THUMB_SIZE = 544;

const MIN_SONG_SECONDS = 60;
const MAX_SONG_SECONDS = 600;
const NOT_A_SONG =
  /\b(mix|mixtape|megamix|non[- ]?stop|compilation|full album|dj\s|video mix|mashup|medley|playlist)\b/i;

/**
 * Theme searches surface hour-long DJ mixes alongside real songs, especially
 * for year-targeted queries. Those are useless as playlist material.
 */
function isLikelySong(track: SearchResult): boolean {
  if (!track.artist || /^unknown$/i.test(track.artist)) return false;
  if (track.duration < MIN_SONG_SECONDS || track.duration > MAX_SONG_SECONDS) return false;
  return !NOT_A_SONG.test(track.title);
}

function upscaleThumbnail(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return url.replace(/=w\d+-h\d+[^/]*$/, `=w${THUMB_SIZE}-h${THUMB_SIZE}-l90-rj`);
}

interface MusicSongItem {
  id?: string;
  title?: string;
  artists?: Array<{ name?: string }>;
  album?: { name?: string };
  duration?: { seconds?: number };
  thumbnails?: Array<{ url?: string }>;
}

interface MusicAlbumItem {
  id?: string;
  title?: string;
  author?: { name?: string };
  artists?: Array<{ name?: string }>;
  year?: string;
  thumbnails?: Array<{ url?: string }>;
}

export interface AlbumSummary {
  id: string;
  title: string;
  artist?: string;
  year?: string;
  thumbnail?: string;
}

export interface AlbumDetails extends AlbumSummary {
  subtitle?: string;
  tracks: SearchResult[];
}

interface MusicPlaylistItem {
  id?: string;
  title?: string;
  subtitle?: { text?: string };
  author?: { name?: string };
  item_count?: string;
  thumbnails?: Array<{ url?: string }>;
}

interface RadioItem {
  video_id?: string;
  title?: { text?: string } | string;
  artists?: Array<{ name?: string }>;
  album?: { name?: string };
  duration?: { seconds?: number };
  thumbnail?: Array<{ url?: string }>;
  thumbnails?: Array<{ url?: string }>;
}

export interface PlaylistSummary {
  id: string;
  title: string;
  author?: string;
  thumbnail?: string;
}

export interface PlaylistDetails extends PlaylistSummary {
  tracks: SearchResult[];
}

const PLAYLIST_URL_RE =
  /(?:music\.|www\.)?youtube\.com\/(?:playlist|watch)\?(?:[^#]*&)?list=([A-Za-z0-9_-]{10,})/i;

export function parseYouTubePlaylistId(input: string): string | null {
  const text = input.trim();
  const m = PLAYLIST_URL_RE.exec(text);
  if (!m) return null;
  const id = m[1];
  // "RD"-prefixed ids are auto-generated mixes tied to a session and do not
  // resolve as standalone playlists, except for the curated "RDCLAK" ones.
  if (/^RD/.test(id) && !/^RDCLAK/.test(id)) return null;
  return id;
}

function mapSongItem(item: MusicSongItem, fallback?: Partial<SearchResult>): SearchResult | null {
  if (!item.id || !item.title) return null;
  return {
    title: item.title,
    url: `https://www.youtube.com/watch?v=${item.id}`,
    duration: Math.floor(item.duration?.seconds ?? 0),
    thumbnail: upscaleThumbnail(item.thumbnails?.[0]?.url) ?? fallback?.thumbnail,
    artist:
      item.artists
        ?.map((a) => a.name)
        .filter(Boolean)
        .join(', ') || fallback?.artist,
    album: item.album?.name ?? fallback?.album,
    source: 'music',
  };
}

function mapRadioItem(item: RadioItem): SearchResult | null {
  const title = typeof item.title === 'string' ? item.title : item.title?.text;
  if (!item.video_id || !title) return null;
  return {
    title,
    url: `https://www.youtube.com/watch?v=${item.video_id}`,
    duration: Math.floor(item.duration?.seconds ?? 0),
    thumbnail: upscaleThumbnail(item.thumbnail?.[0]?.url ?? item.thumbnails?.[0]?.url),
    artist:
      item.artists
        ?.map((a) => a.name)
        .filter(Boolean)
        .join(', ') || undefined,
    album: item.album?.name,
    source: 'music',
  };
}

export class YouTubeMusicService {
  private client: Promise<Innertube> | null = null;

  private getClient(): Promise<Innertube> {
    if (!this.client) {
      this.client = Innertube.create({
        retrieve_player: false,
        generate_session_locally: true,
      }).catch((error: unknown) => {
        this.client = null;
        throw error;
      });
    }
    return this.client;
  }

  async searchAlbums(query: string, limit = 5): Promise<AlbumSummary[]> {
    const correlationId = createCorrelationId();
    log.debug({ correlationId, query, limit }, 'Searching YouTube Music albums');

    try {
      const yt = await this.getClient();
      const response = await yt.music.search(query, { type: 'album' });
      const items = (response.albums?.contents ?? []) as unknown as MusicAlbumItem[];

      const results: AlbumSummary[] = [];
      for (const item of items) {
        if (!item.id || !item.title) continue;
        results.push({
          id: item.id,
          title: item.title,
          artist:
            item.author?.name ??
            (item.artists
              ?.map((a) => a.name)
              .filter(Boolean)
              .join(', ') ||
              undefined),
          year: item.year,
          thumbnail: upscaleThumbnail(item.thumbnails?.[0]?.url),
        });
        if (results.length >= limit) break;
      }

      log.debug({ correlationId, count: results.length }, 'Album results found');
      return results;
    } catch (error: unknown) {
      log.error(
        { correlationId, error: error instanceof Error ? error.message : String(error) },
        'YouTube Music album search failed',
      );
      return [];
    }
  }

  async getAlbum(summary: AlbumSummary): Promise<AlbumDetails | null> {
    const correlationId = createCorrelationId();
    log.debug({ correlationId, albumId: summary.id }, 'Fetching YouTube Music album');

    try {
      const yt = await this.getClient();
      const album = await yt.music.getAlbum(summary.id);
      const header = album.header as
        | {
            title?: { text?: string } | string;
            subtitle?: { text?: string };
            thumbnail?: { contents?: Array<{ url?: string }> };
          }
        | undefined;
      const headerTitle = typeof header?.title === 'string' ? header.title : header?.title?.text;
      const title = headerTitle ?? summary.title;
      const thumbnail =
        upscaleThumbnail(header?.thumbnail?.contents?.[0]?.url) ?? summary.thumbnail;
      const items = (album.contents ?? []) as unknown as MusicSongItem[];

      const tracks = items
        .map((item) => mapSongItem(item, { thumbnail, artist: summary.artist }))
        .filter((t): t is SearchResult => t !== null)
        .map((t) => ({ ...t, album: title }));

      log.debug({ correlationId, albumId: summary.id, count: tracks.length }, 'Album loaded');
      return { ...summary, title, thumbnail, subtitle: header?.subtitle?.text, tracks };
    } catch (error: unknown) {
      log.error(
        {
          correlationId,
          albumId: summary.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'YouTube Music album fetch failed',
      );
      return null;
    }
  }

  async getRadio(videoId: string, limit = 50): Promise<SearchResult[]> {
    const correlationId = createCorrelationId();
    log.debug({ correlationId, videoId, limit }, 'Fetching YouTube Music radio');

    try {
      const yt = await this.getClient();
      const queue = await yt.music.getUpNext(videoId);
      const items = ((queue.contents ?? []) as unknown as RadioItem[])
        .map(mapRadioItem)
        .filter((t): t is SearchResult => t !== null)
        .slice(0, limit);

      log.debug({ correlationId, videoId, count: items.length }, 'Radio loaded');
      return items;
    } catch (error: unknown) {
      log.error(
        { correlationId, videoId, error: error instanceof Error ? error.message : String(error) },
        'YouTube Music radio failed',
      );
      return [];
    }
  }

  async searchPlaylists(query: string, limit = 5): Promise<PlaylistSummary[]> {
    const correlationId = createCorrelationId();
    log.debug({ correlationId, query, limit }, 'Searching YouTube Music playlists');

    try {
      const yt = await this.getClient();
      const response = await yt.music.search(query, { type: 'playlist' });
      const items = (response.playlists?.contents ?? []) as unknown as MusicPlaylistItem[];

      const results: PlaylistSummary[] = [];
      for (const item of items) {
        if (!item.id || !item.title) continue;
        results.push({
          id: item.id,
          title: item.title,
          author: item.author?.name ?? item.subtitle?.text,
          thumbnail: upscaleThumbnail(item.thumbnails?.[0]?.url),
        });
        if (results.length >= limit) break;
      }

      log.debug({ correlationId, count: results.length }, 'Playlist results found');
      return results;
    } catch (error: unknown) {
      log.error(
        { correlationId, error: error instanceof Error ? error.message : String(error) },
        'YouTube Music playlist search failed',
      );
      return [];
    }
  }

  async getPlaylistTracks(id: string, limit = 100): Promise<PlaylistDetails | null> {
    const correlationId = createCorrelationId();
    log.debug({ correlationId, playlistId: id }, 'Fetching YouTube Music playlist');

    try {
      const yt = await this.getClient();
      const playlist = await yt.music.getPlaylist(id);
      const header = playlist.header as
        | { title?: { text?: string } | string; subtitle?: { text?: string } }
        | undefined;
      const headerTitle = typeof header?.title === 'string' ? header.title : header?.title?.text;
      const items = ((playlist.items ?? playlist.contents ?? []) as unknown as MusicSongItem[])
        .map((item) => mapSongItem(item))
        .filter((t): t is SearchResult => t !== null)
        .slice(0, limit);

      if (items.length === 0) return null;

      log.debug({ correlationId, playlistId: id, count: items.length }, 'Playlist loaded');
      // The subtitle is often just "Playlist • 2026", which is noise in an embed.
      const subtitle = header?.subtitle?.text;
      return {
        id,
        title: headerTitle ?? 'Playlist',
        author: subtitle && !/^playlist\s*[•·]/i.test(subtitle) ? subtitle : undefined,
        thumbnail: items[0]?.thumbnail,
        tracks: items,
      };
    } catch (error: unknown) {
      log.error(
        {
          correlationId,
          playlistId: id,
          error: error instanceof Error ? error.message : String(error),
        },
        'YouTube Music playlist fetch failed',
      );
      return null;
    }
  }

  /**
   * Splits a theme into a recent pool and an everything-else pool.
   *
   * Track metadata carries no release date, but playlists people build for
   * "<theme> <year>" are reliably current, so the year-targeted search stands
   * in for recency.
   */
  async collectThemePools(
    theme: string,
    limit = 40,
  ): Promise<{ recent: SearchResult[]; classic: SearchResult[] }> {
    const year = new Date().getFullYear();
    const [recent, everything] = await Promise.all([
      this.collectThemeTracks(`${theme} ${year}`, 6, limit),
      this.collectThemeTracks(theme, 6, limit),
    ]);

    const key = (t: SearchResult) => `${t.title}::${t.artist ?? ''}`.toLowerCase();
    const recentKeys = new Set(recent.map(key));
    const classic = everything.filter((t) => !recentKeys.has(key(t)));

    log.debug({ theme, recent: recent.length, classic: classic.length }, 'Theme pools collected');
    return { recent, classic };
  }

  /**
   * Builds a pool of real songs for a theme.
   *
   * Playlist search is the best source of human-curated material, but generic
   * queries also return hour-long video mixes whose entries have no artist and
   * no duration. Those are filtered out, more playlists are read to make up the
   * shortfall, and catalog search plus a radio station backfill whatever is
   * still missing.
   */
  async collectThemeTracks(theme: string, playlistCount = 6, limit = 40): Promise<SearchResult[]> {
    const correlationId = createCorrelationId();
    const seen = new Set<string>();
    const pool: SearchResult[] = [];

    const absorb = (tracks: SearchResult[]) => {
      for (const track of tracks) {
        if (pool.length >= limit) return;
        if (!isLikelySong(track)) continue;
        const key = `${track.title}::${track.artist ?? ''}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        pool.push(track);
      }
    };

    const playlists = await this.searchPlaylists(theme, playlistCount);
    const BATCH = 3;
    for (let i = 0; i < playlists.length && pool.length < limit; i += BATCH) {
      const loaded = await Promise.all(
        playlists.slice(i, i + BATCH).map((p) => this.getPlaylistTracks(p.id, 40)),
      );
      for (const details of loaded) absorb(details?.tracks ?? []);
    }

    if (pool.length < limit / 2) {
      const songs = await this.searchSongs(theme, 20);
      absorb(songs);
      const seed = songs.find((t) => isLikelySong(t));
      const seedId = seed ? /[?&]v=([A-Za-z0-9_-]{11})/.exec(seed.url)?.[1] : undefined;
      if (seedId && pool.length < limit) {
        absorb(await this.getRadio(seedId, 50));
      }
    }

    log.debug(
      { correlationId, theme, playlists: playlists.length, pool: pool.length },
      'Theme pool collected',
    );
    return pool;
  }

  async searchSongs(query: string, limit = 5): Promise<SearchResult[]> {
    const correlationId = createCorrelationId();
    log.debug({ correlationId, query, limit }, 'Searching YouTube Music catalog');

    try {
      const yt = await this.getClient();
      const response = await yt.music.search(query, { type: 'song' });
      const items = (response.songs?.contents ?? []) as unknown as MusicSongItem[];

      const results = items
        .map((item) => mapSongItem(item))
        .filter((t): t is SearchResult => t !== null)
        .slice(0, limit);

      log.debug({ correlationId, count: results.length }, 'Catalog results found');
      return results;
    } catch (error: unknown) {
      log.error(
        { correlationId, error: error instanceof Error ? error.message : String(error) },
        'YouTube Music search failed',
      );
      return [];
    }
  }
}
