import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from 'discord.js';
import { getOrCreateAgent } from '../agent/MusicAgent';
import { addedToQueueEmbed, errorEmbed, infoEmbed, nowPlayingEmbed } from '../utils/embeds';
import { childLogger, createCorrelationId } from '../utils/logger';

const log = childLogger({ module: 'cmd:play' });

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Play a song — give a name, URL, or describe a vibe')
  .addStringOption((opt) =>
    opt.setName('query').setDescription('Song name, YouTube URL, or a vibe').setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const correlationId = createCorrelationId();
  const query = interaction.options.getString('query', true);
  const member = interaction.member as {
    voice?: { channel?: { id: string; type: number } & import('discord.js').VoiceBasedChannel };
  };

  if (!member?.voice?.channel) {
    await interaction.reply({
      embeds: [errorEmbed('You need to be in a voice channel!')],
      ephemeral: true,
    });
    return;
  }

  // Only allow regular voice channels (type 2), not stage channels (13)
  if (member.voice.channel.type !== 2) {
    await interaction.reply({
      embeds: [errorEmbed('I can only play music in voice channels!')],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  const guildId = interaction.guildId!;
  const agent = getOrCreateAgent(guildId);
  agent.textChannel = interaction.channel as import('discord.js').TextChannel;

  try {
    await agent.join(member.voice.channel);
  } catch {
    await interaction.editReply({ embeds: [errorEmbed('Failed to join your voice channel.')] });
    return;
  }

  log.info({ correlationId, query, guildId }, 'Processing play request');

  // Ask Gemini to interpret the request
  const geminiResult = await agent.geminiAgent.interpret(query, {
    nowPlaying: agent.queue.nowPlaying,
    queueLength: agent.queue.length,
  });

  if (geminiResult.action === 'reject') {
    await interaction.editReply({ embeds: [errorEmbed(geminiResult.message)] });
    return;
  }

  if (geminiResult.action === 'clarify' || geminiResult.action === 'suggest') {
    // Show suggestions as buttons
    const buttons = geminiResult.suggestions.slice(0, 5).map((s, i) =>
      new ButtonBuilder()
        .setCustomId(`pick_${i}`)
        .setLabel(s.length > 80 ? s.slice(0, 77) + '...' : s)
        .setStyle(ButtonStyle.Primary),
    );

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
    const embed = infoEmbed(
      geminiResult.action === 'clarify' ? 'Which one?' : 'Suggestions',
      geminiResult.message,
    );

    const response = await interaction.editReply({ embeds: [embed], components: [row] });

    try {
      const pick = await response.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: 30_000,
        filter: (i) => i.user.id === interaction.user.id,
      });

      const idx = parseInt(pick.customId.replace('pick_', ''), 10);
      const selectedQuery = geminiResult.suggestions[idx];

      await pick.update({
        embeds: [infoEmbed('Searching...', `Looking for **${selectedQuery}**`)],
        components: [],
      });

      const result = await agent.youtubeService.searchOne(selectedQuery);
      if (!result) {
        await interaction.editReply({
          embeds: [errorEmbed(`No results for "${selectedQuery}".`)],
          components: [],
        });
        return;
      }

      const track = agent.youtubeService.toTrackInfo(result, interaction.user.displayName);
      const position = agent.queue.add(track);

      if (!agent.isPlaying && !agent.isPaused) {
        await agent.playNext();
        await interaction.editReply({ embeds: [nowPlayingEmbed(track, 0)], components: [] });
      } else {
        await interaction.editReply({
          embeds: [addedToQueueEmbed(track, position)],
          components: [],
        });
      }
    } catch {
      await interaction.editReply({
        embeds: [infoEmbed('Timed Out', 'No selection made.')],
        components: [],
      });
    }
    return;
  }

  // Direct play — only GeminiPlayAction reaches here
  if (geminiResult.action !== 'play') return;

  const result = await agent.youtubeService.searchOne(geminiResult.query);
  if (!result) {
    await interaction.editReply({
      embeds: [errorEmbed(`No results for "${geminiResult.query}".`)],
    });
    return;
  }

  const track = agent.youtubeService.toTrackInfo(result, interaction.user.displayName);
  const position = agent.queue.add(track);

  if (!agent.isPlaying && !agent.isPaused) {
    await agent.playNext();
    await interaction.editReply({ embeds: [nowPlayingEmbed(track, 0)] });
  } else {
    await interaction.editReply({ embeds: [addedToQueueEmbed(track, position)] });
  }
}
