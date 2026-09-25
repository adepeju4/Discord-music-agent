import { childLogger, createCorrelationId } from '../utils/logger';
import type { TrackIntent } from '../agent/resolveTracks';

const log = childLogger({ module: 'AppleMusicService' });

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15_000;

export type AppleMusicKind = 'playlist' | 'album' | 'song';

export interface AppleMusicRef {
  kind: AppleMusicKind;
  url: string;
  /** For a song link (`/album/...?i=<id>`), the track to pick off the album page. */
  trackId?: string;
}

export interface AppleMusicCollection {
  kind: AppleMusicKind;
  name: string;
  owner?: string;
  tracks: TrackIntent[];
}

const APPLE_URL_RE =
  /^(?:https?:\/\/)?music\.apple\.com\/([a-z]{2}(?:-[a-z]{2})?)\/(playlist|album)\/([^/]+)\/((?:pl\.)?[A-Za-z0-9.-]+)(?:\?([^#]*))?/i;

export function parseAppleMusicRef(input: string): AppleMusicRef | null {
  const text = input.trim();
  const m = APPLE_URL_RE.exec(text);
  if (!m) return null;

  const [, storefront, kind, slug, id, queryString] = m;
  const query = new URLSearchParams(queryString ?? '');
  // An album URL with ?i=<track id> points at a single song on that album.
  const isSingleTrack = kind.toLowerCase() === 'album' && query.has('i');
  const url = `https://music.apple.com/${storefront}/${kind.toLowerCase()}/${slug}/${id}${
    isSingleTrack ? `?i=${query.get('i')}` : ''
  }`;

  return {
    kind: isSingleTrack ? 'song' : (kind.toLowerCase() as AppleMusicKind),
    url,
    ...(isSingleTrack ? { trackId: query.get('i') ?? undefined } : {}),
  };
}

interface TrackLockup {
  title?: string;
  artistName?: string;
  duration?: number;
  contentDescriptor?: { identifiers?: { storeAdamID?: string } };
}

interface ServerSection {
  itemKind?: string;
  items?: TrackLockup[];
  header?: { title?: string; subtitle?: string };
}

function collectSections(node: unknown, out: ServerSection[]): void {
  if (Array.isArray(node)) {
    for (const child of node) collectSections(child, out);
    return;
  }
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (record.itemKind === 'trackLockup' && Array.isArray(record.items)) {
      out.push(record as ServerSection);
    }
    for (const value of Object.values(record)) collectSections(value, out);
  }
}

function extractSerializedData(html: string): unknown | null {
  const match =
    /<script type="application\/json" id="serialized-server-data">(.*?)<\/script>/s.exec(html);
  if (!match) return null;
  try {
    return JSON.parse(match[1]) as unknown;
  } catch {
    return null;
  }
}

function extractTitle(html: string): string | undefined {
  const og = /<meta property="og:title" content="([^"]+)"/.exec(html);
  if (!og) return undefined;
  return og[1]
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .trim();
}

/** Apple titles pages "<Name> by <Artist> on Apple Music"; keep just the name. */
function cleanTitle(title: string | undefined, artist?: string): string | undefined {
  if (!title) return undefined;
  let name = title.replace(/\s+on Apple Music\s*$/i, '').trim();
  if (artist) {
    const suffix = ` by ${artist}`;
    if (name.toLowerCase().endsWith(suffix.toLowerCase())) {
      name = name.slice(0, -suffix.length).trim();
    }
  }
  return name || undefined;
}

export class AppleMusicService {
  async resolve(ref: AppleMusicRef, limit = 100): Promise<AppleMusicCollection> {
    const correlationId = createCorrelationId();
    log.info({ correlationId, kind: ref.kind, url: ref.url }, 'Resolving Apple Music link');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let html: string;
    try {
      const res = await fetch(ref.url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Apple Music returned ${res.status}`);
      html = await res.text();
    } finally {
      clearTimeout(timer);
    }

    const data = extractSerializedData(html);
    if (!data) throw new Error('Apple Music page had no track data');

    const sections: ServerSection[] = [];
    collectSections(data, sections);

    const seen = new Set<string>();
    const lockups: Array<{ id?: string; track: TrackIntent }> = [];
    for (const section of sections) {
      for (const item of section.items ?? []) {
        if (!item.title || !item.artistName) continue;
        const id = item.contentDescriptor?.identifiers?.storeAdamID;
        const key = id ?? `${item.title}::${item.artistName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        lockups.push({
          id,
          track: {
            title: item.title,
            artist: item.artistName,
            durationMs: typeof item.duration === 'number' ? item.duration : undefined,
          },
        });
      }
    }

    let tracks: TrackIntent[];
    if (ref.kind === 'song') {
      // A song link points at its album page, so pick the one track it names.
      const match = ref.trackId ? lockups.find((l) => l.id === ref.trackId) : undefined;
      const chosen = match ?? lockups[0];
      if (!chosen) throw new Error('Apple Music page listed no tracks');
      tracks = [chosen.track];
    } else {
      tracks = lockups.slice(0, limit).map((l) => l.track);
    }

    const rawName =
      ref.kind === 'song' ? tracks[0]?.title : (extractTitle(html) ?? sections[0]?.header?.title);
    const name = cleanTitle(rawName, tracks[0]?.artist) ?? 'Apple Music';
    log.info(
      { correlationId, kind: ref.kind, count: tracks.length, name },
      'Apple Music link resolved',
    );

    return {
      kind: ref.kind,
      name,
      owner: ref.kind === 'song' ? tracks[0]?.artist : sections[0]?.header?.subtitle,
      tracks,
    };
  }
}
