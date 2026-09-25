import { describe, it, expect } from 'vitest';
import { panelComponents, PANEL_PREFIX, type PanelState } from '../src/agent/NowPlayingPanel';
import { panelEmbed } from '../src/utils/embeds';
import type { TrackInfo } from '../src/utils/embeds';

const track: TrackInfo = {
  title: 'Rush',
  url: 'https://www.youtube.com/watch?v=-Xd1VSwCi2o',
  duration: 186,
  artist: 'Ayra Starr',
  album: '19 & Dangerous',
  requestedBy: 'holysaint',
};

function state(overrides: Partial<PanelState> = {}): PanelState {
  return {
    track,
    paused: false,
    queueLength: 3,
    loopMode: 'off',
    hasPrevious: true,
    volume: 100,
    ...overrides,
  };
}

describe('panelEmbed', () => {
  it('notes the volume in the footer only when it is not 100%', () => {
    expect(panelEmbed(state()).toJSON().footer?.text).not.toContain('Volume');
    expect(panelEmbed(state({ volume: 60 })).toJSON().footer?.text).toContain('Volume 60%');
  });

  it('shows the track, artist, album and progress while playing', () => {
    const data = panelEmbed(state()).toJSON();
    expect(data.title).toBe('Now Playing');
    expect(data.description).toContain('Rush');
    expect(data.description).toContain('Ayra Starr · 19 & Dangerous');
    // The YouTube URL is an implementation detail, not something to show off.
    expect(data.description).not.toContain('youtube.com');
    expect(data.description).not.toContain('](');
    expect(data.fields?.[0]).toEqual({ name: 'Length', value: '3:06', inline: true });
    expect(data.footer?.text).toContain('3 up next');
    expect(data.thumbnail).toBeUndefined();
  });

  it('switches title and colour when paused, and reports loop mode', () => {
    const paused = panelEmbed(state({ paused: true, loopMode: 'track' })).toJSON();
    expect(paused.title).toBe('Paused');
    expect(paused.footer?.text).toContain('Looping track');
    expect(paused.color).not.toBe(panelEmbed(state()).toJSON().color);
  });

  it('renders an idle panel when nothing is playing', () => {
    const idle = panelEmbed(state({ track: null })).toJSON();
    expect(idle.title).toBe('Nothing playing');
    expect(idle.description).toContain('/play');
    expect(idle.fields ?? []).toHaveLength(0);
    expect(JSON.stringify(idle)).not.toContain('▓');
  });
});

describe('panelComponents', () => {
  function buttons(s: PanelState) {
    return panelComponents(s).flatMap((row) => row.toJSON().components);
  }
  function ids(s: PanelState): string[] {
    return buttons(s).map((b) => ('custom_id' in b ? b.custom_id : ''));
  }
  function disabled(s: PanelState): boolean[] {
    return buttons(s).map((b) => Boolean(b.disabled));
  }

  it('exposes transport controls then volume controls', () => {
    expect(ids(state())).toEqual([
      `${PANEL_PREFIX}previous`,
      `${PANEL_PREFIX}play`,
      `${PANEL_PREFIX}pause`,
      `${PANEL_PREFIX}next`,
      `${PANEL_PREFIX}stop`,
      `${PANEL_PREFIX}voldown`,
      `${PANEL_PREFIX}volup`,
      `${PANEL_PREFIX}volume`,
    ]);
  });

  it('greys out play while playing and pause while paused', () => {
    expect(disabled(state()).slice(0, 5)).toEqual([false, true, false, false, false]);
    expect(disabled(state({ paused: true })).slice(0, 5)).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
  });

  it('disables previous when there is no history', () => {
    expect(disabled(state({ hasPrevious: false }))[0]).toBe(true);
  });

  it('shows the level and stops at the volume limits', () => {
    const label = buttons(state({ volume: 80 })).find(
      (b) => 'custom_id' in b && b.custom_id === `${PANEL_PREFIX}volume`,
    );
    expect(label && 'label' in label ? label.label : null).toBe('80%');

    const [down, up] = disabled(state({ volume: 0 })).slice(5);
    expect(down).toBe(true);
    expect(up).toBe(false);

    const [downMax, upMax] = disabled(state({ volume: 200 })).slice(5);
    expect(downMax).toBe(false);
    expect(upMax).toBe(true);
  });

  it('disables every control when idle', () => {
    expect(disabled(state({ track: null })).every(Boolean)).toBe(true);
  });
});
