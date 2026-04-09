import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { getOrCreateAgent } from '../agent/MusicAgent';
import { errorEmbed, infoEmbed } from '../utils/embeds';

export const data = new SlashCommandBuilder()
  .setName('pause')
  .setDescription('Pause or resume the current track');

export async function execute(interaction: ChatInputCommandInteraction) {
  const agent = getOrCreateAgent(interaction.guildId!);

  if (!agent.queue.nowPlaying) {
    await interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], ephemeral: true });
    return;
  }

  agent.pause();
  const state = agent.isPaused ? 'Paused' : 'Resumed';
  await interaction.reply({ embeds: [infoEmbed(state, `${state} playback.`)] });
}
