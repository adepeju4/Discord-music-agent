import { describe, it, expect } from 'vitest';
import { YouTubeService } from '../src/services/YouTubeService';

const yt = new YouTubeService();

describe('YouTubeService', () => {
  it('searches YouTube and returns results', async () => {
    const results = await yt.search('never gonna give you up', 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty('title');
    expect(results[0]).toHaveProperty('url');
    expect(results[0]).toHaveProperty('duration');
    expect(results[0].url).toContain('youtube.com/watch');
  }, 15_000);

  it('searchOne returns a single result', async () => {
    const result = await yt.searchOne('bohemian rhapsody queen');
    expect(result).not.toBeNull();
    expect(result?.title).toBeTruthy();
  }, 15_000);

  it('streams audio data from a video', async () => {
    const result = await yt.searchOne('rick astley never gonna give you up');
    expect(result).not.toBeNull();

    const stream = await yt.getStream(result!.url);
    const bytes = await new Promise<number>((resolve, reject) => {
      let total = 0;
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > 50_000) {
          stream.destroy();
          resolve(total);
        }
      });
      stream.on('error', reject);
    });

    expect(bytes).toBeGreaterThan(50_000);
  }, 30_000);

  it('toTrackInfo converts search result correctly', () => {
    const track = yt.toTrackInfo(
      { title: 'Song', url: 'https://youtube.com/watch?v=abc', duration: 180, artist: 'Artist' },
      'user123',
    );
    expect(track.title).toBe('Song');
    expect(track.requestedBy).toBe('user123');
    expect(track.duration).toBe(180);
  });
});
