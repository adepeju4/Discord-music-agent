import { EmbedBuilder } from 'discord.js';
import { formatDuration } from './formatters';

export interface TrackInfo {
  title: string;
  url: string;
  duration: number; // seconds
  thumbnail?: string;
  requestedBy: string;
  artist?: string;
  album?: string;
}

/** Plain title — no YouTube link, since the source is an implementation detail. */
function trackLine(track: TrackInfo): string {
  const meta = [track.artist, track.album].filter(Boolean).join(' · ');
  return meta ? `**${track.title}**\n${meta}` : `**${track.title}**`;
}

export function nowPlayingEmbed(track: TrackInfo): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle('Now Playing')
    .setDescription(trackLine(track))
    .addFields({ name: 'Length', value: formatDuration(track.duration), inline: true })
    .setColor(0x5865f2)
    .setFooter({ text: `Requested by ${track.requestedBy}` });

  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  return embed;
}

export function queueEmbed(
  tracks: TrackInfo[],
  current: TrackInfo | null,
  page: number,
  totalPages: number,
): EmbedBuilder {
  const embed = new EmbedBuilder().setTitle('Queue').setColor(0x5865f2);

  if (current) {
    embed.setDescription(`**Now:** [${current.title}](${current.url})`);
  }

  const pageSize = 10;
  const start = page * pageSize;
  const pageTracks = tracks.slice(start, start + pageSize);

  if (pageTracks.length > 0) {
    // Discord field values are capped at 1024 chars. Long titles can blow
    // through this easily, so truncate titles and drop the hyperlink markdown
    // if we still overflow.
    const MAX_FIELD = 1024;
    const lines: string[] = [];
    for (let i = 0; i < pageTracks.length; i++) {
      const t = pageTracks[i];
      const title = t.title.length > 60 ? t.title.slice(0, 57) + '...' : t.title;
      lines.push(`\`${start + i + 1}.\` [${title}](${t.url}) — ${formatDuration(t.duration)}`);
    }
    let list = lines.join('\n');
    if (list.length > MAX_FIELD) {
      // Fall back to plain text (no URLs) if hyperlinked version is too long
      const plain = pageTracks
        .map((t, i) => {
          const title = t.title.length > 60 ? t.title.slice(0, 57) + '...' : t.title;
          return `\`${start + i + 1}.\` ${title} — ${formatDuration(t.duration)}`;
        })
        .join('\n');
      list = plain.length > MAX_FIELD ? plain.slice(0, MAX_FIELD - 3) + '...' : plain;
    }
    embed.addFields({ name: 'Up Next', value: list });
  } else if (!current) {
    embed.setDescription('The queue is empty.');
  }

  embed.setFooter({ text: `Page ${page + 1}/${totalPages} | ${tracks.length} tracks` });
  return embed;
}

export function addedToQueueEmbed(track: TrackInfo, position: number): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('Added to Queue')
    .setDescription(trackLine(track))
    .addFields(
      { name: 'Duration', value: formatDuration(track.duration), inline: true },
      { name: 'Position', value: `#${position}`, inline: true },
    )
    .setColor(0x57f287)
    .setFooter({ text: `Requested by ${track.requestedBy}` });
}

const COLLECTION_PREVIEW = 15;

export function collectionEmbed(
  heading: string,
  tracks: Array<{ title: string; artist?: string; duration?: number }>,
  options: { note?: string; footer?: string; thumbnail?: string; url?: string } = {},
): EmbedBuilder {
  const shown = tracks.slice(0, COLLECTION_PREVIEW);
  const lines = shown.map((t, i) => {
    const label = t.artist ? `${t.title} — ${t.artist}` : t.title;
    const dur = t.duration ? ` (${formatDuration(t.duration)})` : '';
    return `\`${i + 1}.\` ${label}${dur}`;
  });
  if (tracks.length > shown.length) {
    lines.push(`_…and ${tracks.length - shown.length} more_`);
  }
  const list = lines.join('\n');
  const description = options.note ? `_${options.note}_\n\n${list}` : list;

  const embed = new EmbedBuilder()
    .setTitle(heading)
    .setDescription(description || '_empty_')
    .setColor(0xfee75c)
    .setFooter({ text: options.footer ?? `${tracks.length} tracks` });
  if (options.thumbnail) embed.setThumbnail(options.thumbnail);
  if (options.url) embed.setURL(options.url);
  return embed;
}

export interface PanelStateLike {
  track: TrackInfo | null;
  paused: boolean;
  queueLength: number;
  loopMode: 'off' | 'track' | 'queue';
  volume?: number;
}

export function panelStateFrom(overrides: Partial<PanelStateLike> = {}): PanelStateLike {
  return {
    track: null,
    paused: false,
    queueLength: 0,
    loopMode: 'off',
    ...overrides,
  };
}

export function panelEmbed(state: PanelStateLike): EmbedBuilder {
  const { track } = state;
  if (!track) {
    return new EmbedBuilder()
      .setTitle('Nothing playing')
      .setDescription('Use `/play` to start something.')
      .setColor(0x4f545c);
  }

  const embed = new EmbedBuilder()
    .setTitle(state.paused ? 'Paused' : 'Now Playing')
    .setDescription(trackLine(track))
    .addFields({ name: 'Length', value: formatDuration(track.duration), inline: true })
    .setColor(state.paused ? 0xfee75c : 0x5865f2);

  const footer = [
    `Requested by ${track.requestedBy}`,
    state.queueLength > 0 ? `${state.queueLength} up next` : null,
    state.loopMode === 'track'
      ? 'Looping track'
      : state.loopMode === 'queue'
        ? 'Looping queue'
        : null,
    state.volume !== undefined && state.volume !== 100 ? `Volume ${state.volume}%` : null,
  ].filter(Boolean);
  embed.setFooter({ text: footer.join(' • ') });

  if (track.thumbnail) embed.setThumbnail(track.thumbnail);
  return embed;
}

export function errorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder().setTitle('Error').setDescription(message).setColor(0xed4245);
}

export function infoEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder().setTitle(title).setDescription(description).setColor(0x5865f2);
}

export function playlistEmbed(
  theme: string,
  tracks: Array<{ title: string; artist: string }>,
  options: { footer?: string; note?: string } = {},
): EmbedBuilder {
  const list = tracks.map((t, i) => `\`${i + 1}.\` ${t.title} — ${t.artist}`).join('\n');
  const description = options.note ? `_${options.note}_\n\n${list}` : list;
  return new EmbedBuilder()
    .setTitle(`Playlist: ${theme}`)
    .setDescription(description || '_empty_')
    .setColor(0xfee75c)
    .setFooter({ text: options.footer ?? `${tracks.length} tracks` });
}
