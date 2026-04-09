import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { getOrCreateAgent } from '../agent/MusicAgent';
import { errorEmbed, infoEmbed } from '../utils/embeds';

export const data = new SlashCommandBuilder()
  .setName('skip')
  .setDescription('Skip the current track');

export async function execute(interaction: ChatInputCommandInteraction) {
  const agent = getOrCreateAgent(interaction.guildId!);

  if (!agent.queue.nowPlaying) {
    await interaction.reply({ embeds: [errorEmbed('Nothing is playing.')], ephemeral: true });
    return;
  }

  const skipped = agent.queue.nowPlaying.title;
  agent.skip();
  await interaction.reply({ embeds: [infoEmbed('Skipped', `Skipped **${skipped}**.`)] });
}
