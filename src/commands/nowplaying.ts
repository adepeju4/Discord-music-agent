import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { getOrCreateAgent } from '../agent/MusicAgent';
import { errorEmbed, nowPlayingEmbed } from '../utils/embeds';

export const data = new SlashCommandBuilder()
  .setName('nowplaying')
  .setDescription('Show the currently playing track');

export async function execute(interaction: ChatInputCommandInteraction) {
  const agent = getOrCreateAgent(interaction.guildId!);
  const track = agent.queue.nowPlaying;

  if (!track) {
    await interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], ephemeral: true });
    return;
  }

  await interaction.reply({ embeds: [nowPlayingEmbed(track, agent.elapsed)] });
}
