import { childLogger } from '../utils/logger';

const log = childLogger({ module: 'playlistDrafts' });

export interface PlaylistDraft {
  userId: string;
  guildId: string;
  theme: string;
  tracks: Array<{ title: string; artist: string }>;
  createdAt: number;
}

interface StoredDraft extends PlaylistDraft {
  expiry: ReturnType<typeof setTimeout>;
}

const DRAFT_TTL_MS = 5 * 60 * 1000;

const drafts = new Map<string, StoredDraft>();

function key(guildId: string, userId: string): string {
  return `${guildId}:${userId}`;
}

export function setDraft(draft: Omit<PlaylistDraft, 'createdAt'>): PlaylistDraft {
  const k = key(draft.guildId, draft.userId);

  const existing = drafts.get(k);
  if (existing) clearTimeout(existing.expiry);

  const expiry = setTimeout(() => {
    drafts.delete(k);
    log.debug({ guildId: draft.guildId, userId: draft.userId }, 'Playlist draft expired');
  }, DRAFT_TTL_MS);
  expiry.unref?.();

  const stored: StoredDraft = {
    ...draft,
    createdAt: Date.now(),
    expiry,
  };
  drafts.set(k, stored);

  return {
    userId: stored.userId,
    guildId: stored.guildId,
    theme: stored.theme,
    tracks: stored.tracks,
    createdAt: stored.createdAt,
  };
}

export function getDraft(guildId: string, userId: string): PlaylistDraft | null {
  const stored = drafts.get(key(guildId, userId));
  if (!stored) return null;
  return {
    userId: stored.userId,
    guildId: stored.guildId,
    theme: stored.theme,
    tracks: stored.tracks,
    createdAt: stored.createdAt,
  };
}

export function deleteDraft(guildId: string, userId: string): void {
  const k = key(guildId, userId);
  const stored = drafts.get(k);
  if (stored) {
    clearTimeout(stored.expiry);
    drafts.delete(k);
  }
}
