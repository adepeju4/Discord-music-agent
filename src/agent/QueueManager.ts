import type { TrackInfo } from '../utils/embeds';

export type LoopMode = 'off' | 'track' | 'queue';

const MAX_HISTORY = 50;

export class QueueManager {
  private tracks: TrackInfo[] = [];
  private history: TrackInfo[] = [];
  private current: TrackInfo | null = null;
  public loopMode: LoopMode = 'off';

  get nowPlaying(): TrackInfo | null {
    return this.current;
  }

  get length(): number {
    return this.tracks.length;
  }

  get isEmpty(): boolean {
    return this.tracks.length === 0;
  }

  get allTracks(): TrackInfo[] {
    return [...this.tracks];
  }

  get hasPrevious(): boolean {
    return this.history.length > 0;
  }

  add(track: TrackInfo): number {
    this.tracks.push(track);
    return this.tracks.length;
  }

  insert(track: TrackInfo, position: number): number {
    const clamped = Math.max(1, Math.min(position, this.tracks.length + 1));
    this.tracks.splice(clamped - 1, 0, track);
    return clamped;
  }

  addMany(newTracks: TrackInfo[]): void {
    this.tracks.push(...newTracks);
  }

  replaceUpcoming(newTracks: TrackInfo[]): void {
    this.tracks = [...newTracks];
  }

  dropBefore(n: number): number {
    if (n < 1 || n > this.tracks.length) return -1;
    const dropped = n - 1;
    this.tracks = this.tracks.slice(dropped);
    return dropped;
  }

  next(): TrackInfo | null {
    if (this.loopMode === 'track' && this.current) {
      return this.current;
    }

    if (this.loopMode === 'queue' && this.current) {
      this.tracks.push(this.current);
    }

    if (this.current) this.pushHistory(this.current);

    const next = this.tracks.shift() ?? null;
    this.current = next;
    return next;
  }

  /**
   * What next() would return, without mutating anything. Used to prefetch the
   * upcoming track's audio while the current one is still playing.
   */
  peek(): TrackInfo | null {
    if (this.loopMode === 'track') return this.current;
    if (this.tracks.length > 0) return this.tracks[0];
    if (this.loopMode === 'queue') return this.current;
    return null;
  }

  /**
   * Steps back to the track that played before this one, pushing the current
   * track to the front of the queue so nothing is lost.
   */
  previous(): TrackInfo | null {
    const previous = this.history.pop();
    if (!previous) return null;
    if (this.current) this.tracks.unshift(this.current);
    this.current = previous;
    return previous;
  }

  private pushHistory(track: TrackInfo): void {
    this.history.push(track);
    if (this.history.length > MAX_HISTORY) this.history.shift();
  }

  setCurrent(track: TrackInfo | null): void {
    this.current = track;
  }

  remove(index: number): TrackInfo | null {
    if (index < 0 || index >= this.tracks.length) return null;
    return this.tracks.splice(index, 1)[0];
  }

  shuffle(): void {
    for (let i = this.tracks.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.tracks[i], this.tracks[j]] = [this.tracks[j], this.tracks[i]];
    }
  }

  clear(): void {
    this.tracks = [];
    this.history = [];
    this.current = null;
    this.loopMode = 'off';
  }
}
