import { SlashCommandBuilder, ChatInputCommandInteraction } from 'discord.js';
import { getOrCreateAgent } from '../agent/MusicAgent';
import { infoEmbed } from '../utils/embeds';
import type { LoopMode } from '../agent/QueueManager';

export const data = new SlashCommandBuilder()
  .setName('loop')
  .setDescription('Set the loop mode')
  .addStringOption((opt) =>
    opt
      .setName('mode')
      .setDescription('Loop mode')
      .setRequired(true)
      .addChoices(
        { name: 'Off', value: 'off' },
        { name: 'Track', value: 'track' },
        { name: 'Queue', value: 'queue' },
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const agent = getOrCreateAgent(interaction.guildId!);
  const mode = interaction.options.getString('mode', true) as LoopMode;

  agent.queue.loopMode = mode;

  const labels: Record<LoopMode, string> = {
    off: 'Looping is now **off**.',
    track: 'Now looping the **current track**.',
    queue: 'Now looping the **entire queue**.',
  };

  await interaction.reply({ embeds: [infoEmbed('Loop', labels[mode])] });
}
