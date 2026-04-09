import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from 'discord.js';
import { getOrCreateAgent } from '../agent/MusicAgent';
import { errorEmbed, infoEmbed, addedToQueueEmbed, nowPlayingEmbed } from '../utils/embeds';
import { formatDuration } from '../utils/formatters';
import { YouTubeService } from '../services/YouTubeService';

const youtube = new YouTubeService();

export const data = new SlashCommandBuilder()
  .setName('search')
  .setDescription('Search YouTube and pick a result')
  .addStringOption((opt) =>
    opt.setName('query').setDescription('What to search for').setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const query = interaction.options.getString('query', true);
  const member = interaction.member as {
    voice?: { channel?: import('discord.js').VoiceBasedChannel };
  };

  if (!member?.voice?.channel) {
    await interaction.reply({
      embeds: [errorEmbed('You need to be in a voice channel!')],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  const results = await youtube.search(query, 5);
  if (results.length === 0) {
    await interaction.editReply({ embeds: [errorEmbed(`No results for "${query}".`)] });
    return;
  }

  const description = results
    .map((r, i) => `\`${i + 1}.\` **${r.title}** — ${formatDuration(r.duration)}`)
    .join('\n');

  const buttons = results.map((_, i) =>
    new ButtonBuilder()
      .setCustomId(`search_${i}`)
      .setLabel(`${i + 1}`)
      .setStyle(ButtonStyle.Primary),
  );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
  const embed = infoEmbed('Search Results', description);

  const response = await interaction.editReply({ embeds: [embed], components: [row] });

  try {
    const pick = await response.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: 30_000,
      filter: (i) => i.user.id === interaction.user.id,
    });

    const idx = parseInt(pick.customId.replace('search_', ''), 10);
    const selected = results[idx];
    const agent = getOrCreateAgent(interaction.guildId!);
    agent.textChannel = interaction.channel as import('discord.js').TextChannel;

    await agent.join(member.voice.channel!);

    const track = youtube.toTrackInfo(selected, interaction.user.displayName);
    const position = agent.queue.add(track);

    if (!agent.isPlaying && !agent.isPaused) {
      await agent.playNext();
      await pick.update({ embeds: [nowPlayingEmbed(track, 0)], components: [] });
    } else {
      await pick.update({ embeds: [addedToQueueEmbed(track, position)], components: [] });
    }
  } catch {
    await interaction.editReply({
      embeds: [infoEmbed('Timed Out', 'No selection made.')],
      components: [],
    });
  }
}
