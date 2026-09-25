import { config } from '../config';
import { childLogger, createCorrelationId } from '../utils/logger';

const log = childLogger({ module: 'SpotifyService' });

export type SpotifyRefType = 'track' | 'album' | 'playlist';

export interface SpotifyRef {
  type: SpotifyRefType;
  id: string;
}

export interface SpotifyTrack {
  title: string;
  artist: string;
  /** Absent when the embed page omits it; matching then falls back to title+artist. */
  durationMs?: number;
}

export interface SpotifyCollection {
  type: SpotifyRefType;
  name: string;
  owner?: string;
  tracks: SpotifyTrack[];
  total: number;
}

const EMBED_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const EMBED_TIMEOUT_MS = 15_000;

const URL_RE =
  /^(?:https?:\/\/)?open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(?:embed\/)?(track|album|playlist)\/([A-Za-z0-9]{22})(?:[/?#].*)?$/i;
const URI_RE = /^spotify:(track|album|playlist):([A-Za-z0-9]{22})$/i;

export function parseSpotifyRef(input: string): SpotifyRef | null {
  const text = input.trim();
  const m = URL_RE.exec(text) ?? URI_RE.exec(text);
  if (!m) return null;
  return { type: m[1].toLowerCase() as SpotifyRefType, id: m[2] };
}

interface RawArtist {
  name: string;
}

interface RawTrack {
  name: string;
  artists: RawArtist[];
  duration_ms: number;
  is_local?: boolean;
}

interface EmbedTrack {
  title?: string;
  subtitle?: string;
  duration?: number;
}

interface EmbedEntity {
  name?: string;
  title?: string;
  subtitle?: string;
  duration?: number;
  artists?: Array<{ name: string }>;
  trackList?: EmbedTrack[];
}

interface EmbedPayload {
  props?: { pageProps?: { state?: { data?: { entity?: EmbedEntity } } } };
}

interface RawPage<T> {
  items: T[];
  next: string | null;
  total: number;
}

function toTrack(t: RawTrack): SpotifyTrack {
  return {
    title: t.name,
    artist: t.artists.map((a) => a.name).join(', '),
    durationMs: t.duration_ms,
  };
}

export class SpotifyService {
  private token: { value: string; expiresAt: number } | null = null;

  get isConfigured(): boolean {
    return Boolean(config.SPOTIFY_CLIENT_ID && config.SPOTIFY_CLIENT_SECRET);
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 30_000) return this.token.value;

    const credentials = Buffer.from(
      `${config.SPOTIFY_CLIENT_ID}:${config.SPOTIFY_CLIENT_SECRET}`,
    ).toString('base64');
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      throw new Error(`Spotify auth failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return this.token.value;
  }

  private async get<T>(url: string): Promise<T> {
    const token = await this.getToken();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`Spotify request failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  private async getAllPages<T>(
    firstUrl: string,
    limit: number,
  ): Promise<{ items: T[]; total: number }> {
    const items: T[] = [];
    let url: string | null = firstUrl;
    let total = 0;
    while (url && items.length < limit) {
      const page: RawPage<T> = await this.get<RawPage<T>>(url);
      items.push(...page.items);
      total = page.total;
      url = page.next;
    }
    return { items: items.slice(0, limit), total };
  }

  /**
   * Spotify removed playlist track access for app-only (client credentials)
   * tokens: /playlists/{id}/tracks answers 403 and the playlist object no
   * longer embeds its tracks. The public embed page still lists them, so the
   * Web API is tried first and the embed covers whatever it will not serve.
   */
  async resolve(ref: SpotifyRef, limit = config.MAX_IMPORT_SIZE): Promise<SpotifyCollection> {
    const correlationId = createCorrelationId();
    log.info({ correlationId, type: ref.type, id: ref.id }, 'Resolving Spotify reference');

    if (this.isConfigured) {
      try {
        return await this.resolveViaApi(ref, limit);
      } catch (error) {
        log.info(
          {
            correlationId,
            type: ref.type,
            error: error instanceof Error ? error.message : String(error),
          },
          'Spotify Web API refused, falling back to the embed page',
        );
      }
    }

    return this.resolveViaEmbed(ref, limit);
  }

  private async resolveViaEmbed(ref: SpotifyRef, limit: number): Promise<SpotifyCollection> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
    let html: string;
    try {
      const res = await fetch(`https://open.spotify.com/embed/${ref.type}/${ref.id}`, {
        headers: { 'User-Agent': EMBED_USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Spotify embed returned ${res.status}`);
      html = await res.text();
    } finally {
      clearTimeout(timer);
    }

    const match = /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s.exec(html);
    if (!match) throw new Error('Spotify embed page had no track data');

    const entity = (JSON.parse(match[1]) as EmbedPayload)?.props?.pageProps?.state?.data?.entity;
    if (!entity) throw new Error('Spotify embed page had no entity');

    const list = entity.trackList ?? [];
    let tracks: SpotifyTrack[];
    if (list.length > 0) {
      tracks = list
        .flatMap<SpotifyTrack>((t) =>
          t.title ? [{ title: t.title, artist: t.subtitle ?? '', durationMs: t.duration }] : [],
        )
        .slice(0, limit);
    } else {
      // A single-track embed describes the track on the entity itself.
      const title = entity.name ?? entity.title;
      tracks = title
        ? [
            {
              title,
              artist: (entity.artists ?? []).map((a) => a.name).join(', '),
              durationMs: entity.duration,
            },
          ]
        : [];
    }

    return {
      type: ref.type,
      name: entity.name ?? entity.title ?? 'Spotify',
      owner: entity.subtitle,
      tracks,
      total: list.length || tracks.length,
    };
  }

  private async resolveViaApi(ref: SpotifyRef, limit: number): Promise<SpotifyCollection> {
    const base = 'https://api.spotify.com/v1';

    if (ref.type === 'track') {
      const t = await this.get<RawTrack>(`${base}/tracks/${ref.id}`);
      const track = toTrack(t);
      return { type: 'track', name: track.title, tracks: [track], total: 1 };
    }

    if (ref.type === 'album') {
      const album = await this.get<{ name: string; artists: RawArtist[] }>(
        `${base}/albums/${ref.id}`,
      );
      const { items, total } = await this.getAllPages<RawTrack>(
        `${base}/albums/${ref.id}/tracks?limit=50`,
        limit,
      );
      return {
        type: 'album',
        name: album.name,
        owner: album.artists.map((a) => a.name).join(', '),
        tracks: items.map(toTrack),
        total,
      };
    }

    const playlist = await this.get<{ name: string; owner?: { display_name?: string } }>(
      `${base}/playlists/${ref.id}?fields=name,owner.display_name`,
    );
    const { items, total } = await this.getAllPages<{ track: RawTrack | null }>(
      `${base}/playlists/${ref.id}/tracks?limit=100&fields=next,total,items(track(name,duration_ms,is_local,artists(name)))`,
      limit,
    );
    const tracks = items
      .map((i) => i.track)
      .filter((t): t is RawTrack => Boolean(t && !t.is_local && t.name))
      .map(toTrack);
    return {
      type: 'playlist',
      name: playlist.name,
      owner: playlist.owner?.display_name,
      tracks,
      total,
    };
  }
}
