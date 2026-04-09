import { EmbedBuilder } from 'discord.js';
import { formatDuration, progressBar } from './formatters';

export interface TrackInfo {
  title: string;
  url: string;
  duration: number; // seconds
  thumbnail?: string;
  requestedBy: string;
  artist?: string;
}

export function nowPlayingEmbed(track: TrackInfo, elapsed: number): EmbedBuilder {
  const bar = progressBar(elapsed, track.duration);
  const elapsedStr = formatDuration(elapsed);
  const totalStr = formatDuration(track.duration);

  const embed = new EmbedBuilder()
    .setTitle('Now Playing')
    .setDescription(`**[${track.title}](${track.url})**`)
    .addFields({ name: 'Progress', value: `${bar} \`${elapsedStr} / ${totalStr}\`` })
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
    .setDescription(`**[${track.title}](${track.url})**`)
    .addFields(
      { name: 'Duration', value: formatDuration(track.duration), inline: true },
      { name: 'Position', value: `#${position}`, inline: true },
    )
    .setColor(0x57f287)
    .setFooter({ text: `Requested by ${track.requestedBy}` });
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
