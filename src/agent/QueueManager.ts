import type { TrackInfo } from '../utils/embeds';

export type LoopMode = 'off' | 'track' | 'queue';

export class QueueManager {
  private tracks: TrackInfo[] = [];
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

    const next = this.tracks.shift() ?? null;
    this.current = next;
    return next;
  }

  setCurrent(track: TrackInfo): void {
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
    this.current = null;
    this.loopMode = 'off';
  }
}
