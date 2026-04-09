import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { getOrCreateAgent } from '../agent/MusicAgent';
import { errorEmbed, playlistEmbed } from '../utils/embeds';
import { config } from '../config';
import { childLogger, createCorrelationId } from '../utils/logger';

const log = childLogger({ module: 'cmd:playlist' });

export const data = new SlashCommandBuilder()
  .setName('playlist')
  .setDescription('Let the AI curate a playlist based on a vibe or theme')
  .addStringOption((opt) =>
    opt.setName('theme').setDescription('Describe a vibe, mood, or theme').setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const correlationId = createCorrelationId();
  const theme = interaction.options.getString('theme', true);
  const member = interaction.member as {
    voice?: { channel?: import('discord.js').VoiceBasedChannel };
  };

  if (!member?.voice?.channel) {
    await interaction.reply({
      embeds: [errorEmbed('You need to be in a voice channel!')],
      ephemeral: true,
    });
    return;
  }

  if (member.voice.channel.type !== 2) {
    await interaction.reply({
      embeds: [errorEmbed('I can only play music in voice channels!')],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  const guildId = interaction.guildId!;
  const agent = getOrCreateAgent(guildId);
  agent.textChannel = interaction.channel as import('discord.js').TextChannel;

  try {
    await agent.join(member.voice.channel);
  } catch {
    await interaction.editReply({ embeds: [errorEmbed('Failed to join your voice channel.')] });
    return;
  }

  log.info({ correlationId, theme, guildId }, 'Curating playlist');

  const result = await agent.geminiAgent.curatePlaylst(theme);

  if (result.tracks.length === 0) {
    await interaction.editReply({ embeds: [errorEmbed(result.message)] });
    return;
  }

  const tracks = result.tracks.slice(0, config.MAX_PLAYLIST_SIZE);

  // Show the playlist embed immediately
  await interaction.editReply({ embeds: [playlistEmbed(theme, tracks)] });

  // Search and queue each track in the background
  let queued = 0;
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    log.info({ correlationId, track: `${t.title} - ${t.artist}`, progress: `${i + 1}/${tracks.length}` }, 'Searching playlist track');
    const searchResult = await agent.youtubeService.searchOne(`${t.title} ${t.artist}`);
    if (searchResult) {
      const track = agent.youtubeService.toTrackInfo(searchResult, interaction.user.displayName);
      agent.queue.add(track);
      queued++;

      // Start playing as soon as the first track is queued
      if (queued === 1 && !agent.isPlaying && !agent.isPaused) {
        await agent.playNext();
      }
    } else {
      log.info({ correlationId, track: `${t.title} - ${t.artist}` }, 'Playlist track not found — skipping');
    }
  }

  log.info({ correlationId, queued, total: tracks.length }, 'Playlist queued');
}
