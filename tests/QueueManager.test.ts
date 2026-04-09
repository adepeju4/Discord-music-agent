import { describe, it, expect, beforeEach } from 'vitest';
import { QueueManager } from '../src/agent/QueueManager';
import type { TrackInfo } from '../src/utils/embeds';

function makeTrack(title: string): TrackInfo {
  return {
    title,
    url: `https://youtube.com/watch?v=${title}`,
    duration: 200,
    requestedBy: 'tester',
  };
}

describe('QueueManager', () => {
  let queue: QueueManager;

  beforeEach(() => {
    queue = new QueueManager();
  });

  it('starts empty', () => {
    expect(queue.isEmpty).toBe(true);
    expect(queue.length).toBe(0);
    expect(queue.nowPlaying).toBeNull();
  });

  it('adds tracks and returns position', () => {
    const pos1 = queue.add(makeTrack('A'));
    const pos2 = queue.add(makeTrack('B'));
    expect(pos1).toBe(1);
    expect(pos2).toBe(2);
    expect(queue.length).toBe(2);
  });

  it('next() returns tracks in order', () => {
    queue.add(makeTrack('A'));
    queue.add(makeTrack('B'));

    const first = queue.next();
    expect(first?.title).toBe('A');
    expect(queue.nowPlaying?.title).toBe('A');

    const second = queue.next();
    expect(second?.title).toBe('B');

    const empty = queue.next();
    expect(empty).toBeNull();
  });

  it('remove() removes by index', () => {
    queue.add(makeTrack('A'));
    queue.add(makeTrack('B'));
    queue.add(makeTrack('C'));

    const removed = queue.remove(1);
    expect(removed?.title).toBe('B');
    expect(queue.length).toBe(2);
  });

  it('remove() returns null for invalid index', () => {
    queue.add(makeTrack('A'));
    expect(queue.remove(5)).toBeNull();
    expect(queue.remove(-1)).toBeNull();
  });

  it('clear() resets everything', () => {
    queue.add(makeTrack('A'));
    queue.add(makeTrack('B'));
    queue.next();
    queue.loopMode = 'track';

    queue.clear();
    expect(queue.isEmpty).toBe(true);
    expect(queue.nowPlaying).toBeNull();
    expect(queue.loopMode).toBe('off');
  });

  it('shuffle() preserves all tracks', () => {
    for (let i = 0; i < 10; i++) {
      queue.add(makeTrack(`Track${i}`));
    }
    const before = queue.allTracks.map((t) => t.title).sort();
    queue.shuffle();
    const after = queue.allTracks.map((t) => t.title).sort();

    expect(after).toEqual(before);
    expect(queue.length).toBe(10);
  });

  describe('loop modes', () => {
    it('loop track repeats the current track', () => {
      queue.add(makeTrack('A'));
      queue.add(makeTrack('B'));
      queue.loopMode = 'track';

      const first = queue.next();
      expect(first?.title).toBe('A');

      const repeated = queue.next();
      expect(repeated?.title).toBe('A');
    });

    it('loop queue cycles through all tracks', () => {
      queue.add(makeTrack('A'));
      queue.add(makeTrack('B'));
      queue.loopMode = 'queue';

      const t1 = queue.next();
      expect(t1?.title).toBe('A');

      const t2 = queue.next();
      expect(t2?.title).toBe('B');

      // A should be back in the queue since loop mode is 'queue'
      const t3 = queue.next();
      expect(t3?.title).toBe('A');
    });
  });

  it('addMany() adds multiple tracks', () => {
    queue.addMany([makeTrack('A'), makeTrack('B'), makeTrack('C')]);
    expect(queue.length).toBe(3);
  });

  describe('dropBefore()', () => {
    beforeEach(() => {
      queue.add(makeTrack('A'));
      queue.add(makeTrack('B'));
      queue.add(makeTrack('C'));
      queue.add(makeTrack('D'));
    });

    it('drops tracks before position n', () => {
      const dropped = queue.dropBefore(3);
      expect(dropped).toBe(2);
      expect(queue.allTracks.map((t) => t.title)).toEqual(['C', 'D']);
    });

    it('drops nothing when jumping to position 1', () => {
      const dropped = queue.dropBefore(1);
      expect(dropped).toBe(0);
      expect(queue.length).toBe(4);
    });

    it('returns -1 when position is out of range', () => {
      expect(queue.dropBefore(99)).toBe(-1);
      expect(queue.dropBefore(0)).toBe(-1);
      expect(queue.length).toBe(4);
    });
  });

  describe('replaceUpcoming()', () => {
    it('replaces the upcoming queue without touching nowPlaying', () => {
      queue.add(makeTrack('A'));
      queue.add(makeTrack('B'));
      queue.next(); // A becomes current
      expect(queue.nowPlaying?.title).toBe('A');
      expect(queue.allTracks.map((t) => t.title)).toEqual(['B']);

      queue.replaceUpcoming([makeTrack('X'), makeTrack('Y'), makeTrack('Z')]);

      expect(queue.nowPlaying?.title).toBe('A');
      expect(queue.allTracks.map((t) => t.title)).toEqual(['X', 'Y', 'Z']);
    });

    it('can clear the upcoming queue with an empty array', () => {
      queue.add(makeTrack('A'));
      queue.add(makeTrack('B'));
      queue.replaceUpcoming([]);
      expect(queue.length).toBe(0);
    });
  });

  describe('insert()', () => {
    beforeEach(() => {
      queue.add(makeTrack('A'));
      queue.add(makeTrack('B'));
      queue.add(makeTrack('C'));
    });

    it('inserts at position 1 (play next)', () => {
      const pos = queue.insert(makeTrack('X'), 1);
      expect(pos).toBe(1);
      expect(queue.allTracks.map((t) => t.title)).toEqual(['X', 'A', 'B', 'C']);
    });

    it('inserts at an arbitrary middle position', () => {
      const pos = queue.insert(makeTrack('X'), 2);
      expect(pos).toBe(2);
      expect(queue.allTracks.map((t) => t.title)).toEqual(['A', 'X', 'B', 'C']);
    });

    it('clamps positions beyond the end to append', () => {
      const pos = queue.insert(makeTrack('X'), 999);
      expect(pos).toBe(4);
      expect(queue.allTracks.map((t) => t.title)).toEqual(['A', 'B', 'C', 'X']);
    });

    it('clamps non-positive positions to the front', () => {
      const pos = queue.insert(makeTrack('X'), 0);
      expect(pos).toBe(1);
      expect(queue.allTracks.map((t) => t.title)).toEqual(['X', 'A', 'B', 'C']);
    });

    it('inserts into an empty queue', () => {
      const empty = new QueueManager();
      const pos = empty.insert(makeTrack('X'), 5);
      expect(pos).toBe(1);
      expect(empty.allTracks.map((t) => t.title)).toEqual(['X']);
    });
  });
});
