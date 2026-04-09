import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { getOrCreateAgent } from '../agent/MusicAgent';
import { errorEmbed, infoEmbed } from '../utils/embeds';

export const data = new SlashCommandBuilder()
  .setName('shuffle')
  .setDescription('Shuffle the queue');

export async function execute(interaction: ChatInputCommandInteraction) {
  const agent = getOrCreateAgent(interaction.guildId!);

  if (agent.queue.isEmpty) {
    await interaction.reply({ embeds: [errorEmbed('The queue is empty.')], ephemeral: true });
    return;
  }

  agent.queue.shuffle();
  await interaction.reply({
    embeds: [infoEmbed('Shuffled', `Shuffled **${agent.queue.length}** tracks.`)],
  });
}
