import { describe, it, expect } from 'vitest';
import {
  collectionEmbed,
  errorEmbed,
  infoEmbed,
  playlistEmbed,
  panelEmbed,
  type TrackInfo,
} from '../src/utils/embeds';

// Exactly what broke: a whole track list pasted in as the theme.
const PASTED_LIST = Array.from(
  { length: 40 },
  (_, i) => `${i + 1}. Stranger Things — Kyle Dixon & Michael Stein`,
).join('\n');

const track: TrackInfo = {
  title: 'Stranger Things',
  url: 'https://youtube.com/watch?v=x',
  duration: 200,
  requestedBy: 'holysaint',
};

/** Discord's documented ceilings — over any of them the whole message is rejected. */
function withinDiscordLimits(embed: { toJSON: () => Record<string, unknown> }) {
  const d = embed.toJSON() as {
    title?: string;
    description?: string;
    footer?: { text: string };
  };
  expect((d.title ?? '').length).toBeLessThanOrEqual(256);
  expect((d.description ?? '').length).toBeLessThanOrEqual(4096);
  expect((d.footer?.text ?? '').length).toBeLessThanOrEqual(2048);
}

describe('embeds stay inside Discord limits', () => {
  it('survives a pasted track list used as a playlist theme', () => {
    const embed = playlistEmbed(PASTED_LIST, [{ title: 'A', artist: 'B' }]);
    withinDiscordLimits(embed);
    expect(embed.toJSON().title).toContain('Playlist:');
  });

  it('survives long collection headings and footers', () => {
    withinDiscordLimits(
      collectionEmbed(PASTED_LIST, [{ title: 'A', artist: 'B' }], { footer: PASTED_LIST }),
    );
  });

  it('survives an enormous track list in a description', () => {
    const many = Array.from({ length: 400 }, (_, i) => ({
      title: `Track number ${i} with a long title`,
      artist: 'Some Artist With A Long Name',
      duration: 200,
    }));
    withinDiscordLimits(collectionEmbed('Big import', many));
  });

  it('survives long error and info text', () => {
    withinDiscordLimits(errorEmbed(PASTED_LIST.repeat(30)));
    withinDiscordLimits(infoEmbed(PASTED_LIST, PASTED_LIST.repeat(30)));
  });

  it('survives a long requester name in the now playing panel', () => {
    withinDiscordLimits(
      panelEmbed({
        track: { ...track, requestedBy: 'x'.repeat(3000) },
        paused: false,
        queueLength: 3,
        loopMode: 'off',
        volume: 100,
      }),
    );
  });

  it('keeps short text untouched', () => {
    expect(infoEmbed('Title', 'Body').toJSON().title).toBe('Title');
    expect(errorEmbed('Something broke').toJSON().description).toBe('Something broke');
  });
});
