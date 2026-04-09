import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { getOrCreateAgent } from '../agent/MusicAgent';
import { errorEmbed, infoEmbed } from '../utils/embeds';

export const data = new SlashCommandBuilder()
  .setName('remove')
  .setDescription('Remove a track from the queue by position')
  .addIntegerOption((opt) =>
    opt
      .setName('position')
      .setDescription('Queue position to remove')
      .setRequired(true)
      .setMinValue(1),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const agent = getOrCreateAgent(interaction.guildId!);
  const position = interaction.options.getInteger('position', true);

  const removed = agent.queue.remove(position - 1);
  if (!removed) {
    await interaction.reply({
      embeds: [errorEmbed(`No track at position ${position}.`)],
      ephemeral: true,
    });
    return;
  }

  await interaction.reply({
    embeds: [infoEmbed('Removed', `Removed **${removed.title}** from the queue.`)],
  });
}
