import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { infoEmbed } from '../utils/embeds';

export const data = new SlashCommandBuilder()
  .setName('volume')
  .setDescription('How to change volume (disabled — use Discord per-user volume)');

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.reply({
    embeds: [
      infoEmbed(
        'Volume',
        'Server-side volume is disabled so playback is bit-exact high quality. ' +
          "To adjust the bot's volume, **right-click the bot in the voice channel** and use the **User Volume** slider — it's per-user, so it won't affect anyone else.",
      ),
    ],
    ephemeral: true,
  });
}
