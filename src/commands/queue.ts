import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { getOrCreateAgent } from '../agent/MusicAgent';
import { queueEmbed } from '../utils/embeds';

export const data = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('Show the current queue')
  .addIntegerOption((opt) => opt.setName('page').setDescription('Page number').setMinValue(1));

export async function execute(interaction: ChatInputCommandInteraction) {
  const agent = getOrCreateAgent(interaction.guildId!);
  const tracks = agent.queue.allTracks;
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(tracks.length / pageSize));
  const page = Math.min((interaction.options.getInteger('page') ?? 1) - 1, totalPages - 1);

  await interaction.reply({
    embeds: [queueEmbed(tracks, agent.queue.nowPlaying, page, totalPages)],
  });
}
