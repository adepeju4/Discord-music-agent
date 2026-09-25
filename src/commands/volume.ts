import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { agents, DEFAULT_VOLUME, MAX_VOLUME } from '../agent/MusicAgent';
import { errorEmbed, infoEmbed } from '../utils/embeds';

export const data = new SlashCommandBuilder()
  .setName('volume')
  .setDescription('Set playback volume for everyone in the voice channel')
  .addIntegerOption((opt) =>
    opt
      .setName('level')
      .setDescription(`0-${MAX_VOLUME}% (${DEFAULT_VOLUME}% keeps audio bit-exact)`)
      .setMinValue(0)
      .setMaxValue(MAX_VOLUME)
      .setRequired(false),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const agent = interaction.guildId ? agents.get(interaction.guildId) : undefined;
  if (!agent) {
    await interaction.reply({
      embeds: [errorEmbed('Nothing is playing right now.')],
      ephemeral: true,
    });
    return;
  }

  const level = interaction.options.getInteger('level');
  if (level === null) {
    await interaction.reply({
      embeds: [
        infoEmbed(
          `Volume: ${agent.volume}%`,
          `Use \`/volume level:<0-${MAX_VOLUME}>\` or the buttons on the now playing message.\n\n` +
            `At **${DEFAULT_VOLUME}%** audio is passed through untouched for best quality. ` +
            'Any other level re-encodes the stream, which costs a little fidelity.',
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  const { volume, appliedNow } = agent.setVolume(level);
  const note =
    volume === DEFAULT_VOLUME
      ? 'Back to bit-exact passthrough.'
      : appliedNow
        ? 'Applied to everyone in the channel.'
        : 'The current track is playing untouched, so this starts with the next track.';

  await interaction.reply({ embeds: [infoEmbed(`Volume set to ${volume}%`, note)] });
  await agent.panel.refresh();
}
