import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { agents, getOrCreateAgent } from '../agent/MusicAgent';
import { infoEmbed } from '../utils/embeds';

export const data = new SlashCommandBuilder()
  .setName('stop')
  .setDescription('Stop playback, clear the queue, and leave the voice channel');

export async function execute(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId!;
  const agent = getOrCreateAgent(guildId);

  agent.destroy();
  agents.delete(guildId);

  await interaction.reply({
    embeds: [infoEmbed('Stopped', 'Cleared the queue and left the channel.')],
  });
}
