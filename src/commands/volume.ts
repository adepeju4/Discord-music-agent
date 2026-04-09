import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { getOrCreateAgent } from '../agent/MusicAgent';
import { infoEmbed } from '../utils/embeds';

export const data = new SlashCommandBuilder()
  .setName('volume')
  .setDescription('Set the playback volume')
  .addIntegerOption((opt) =>
    opt
      .setName('level')
      .setDescription('Volume level (0-100)')
      .setRequired(true)
      .setMinValue(0)
      .setMaxValue(100),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const agent = getOrCreateAgent(interaction.guildId!);
  const level = interaction.options.getInteger('level', true);

  agent.setVolume(level);

  await interaction.reply({
    embeds: [infoEmbed('Volume', `Volume set to **${level}%**.`)],
  });
}
