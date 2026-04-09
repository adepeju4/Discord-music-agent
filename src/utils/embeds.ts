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
    const list = pageTracks
      .map((t, i) => `\`${start + i + 1}.\` [${t.title}](${t.url}) — ${formatDuration(t.duration)}`)
      .join('\n');
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
): EmbedBuilder {
  const list = tracks.map((t, i) => `\`${i + 1}.\` ${t.title} — ${t.artist}`).join('\n');
  return new EmbedBuilder()
    .setTitle(`Playlist: ${theme}`)
    .setDescription(list)
    .setColor(0xfee75c)
    .setFooter({ text: `${tracks.length} tracks queued` });
}
