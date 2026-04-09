import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { getOrCreateAgent } from '../agent/MusicAgent';
import { errorEmbed, infoEmbed } from '../utils/embeds';
import { childLogger } from '../utils/logger';

const log = childLogger({ module: 'cmd:jump' });

export const data = new SlashCommandBuilder()
  .setName('jump')
  .setDescription('Jump to a specific track in the queue')
  .addIntegerOption((opt) =>
    opt
      .setName('to')
      .setDescription('Queue position to jump to (1 = next up)')
      .setMinValue(1)
      .setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const agent = getOrCreateAgent(interaction.guildId!);
  const to = interaction.options.getInteger('to', true);

  const upcoming = agent.queue.allTracks;
  if (upcoming.length === 0) {
    await interaction.reply({
      embeds: [errorEmbed('The queue is empty — nothing to jump to.')],
      ephemeral: true,
    });
    return;
  }

  if (to > upcoming.length) {
    await interaction.reply({
      embeds: [
        errorEmbed(
          `Only ${upcoming.length} track${upcoming.length === 1 ? '' : 's'} in the queue.`,
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  const target = upcoming[to - 1];
  const dropped = agent.queue.dropBefore(to);
  agent.skip();

  log.info(
    {
      guildId: interaction.guildId,
      userId: interaction.user.id,
      to,
      dropped,
      target: target.title,
    },
    'Jumped to queue position',
  );

  await interaction.reply({
    embeds: [
      infoEmbed(
        'Jumped',
        `Jumping to **${target.title}** (position ${to}). Dropped ${dropped} track${dropped === 1 ? '' : 's'} before it.`,
      ),
    ],
  });
}
