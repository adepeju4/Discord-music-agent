import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from 'discord.js';
import { getOrCreateAgent, type MusicAgent } from '../agent/MusicAgent';
import { addedToQueueEmbed, errorEmbed, infoEmbed, nowPlayingEmbed } from '../utils/embeds';
import { childLogger, createCorrelationId } from '../utils/logger';
import { resolveCallerVoiceChannel, NOT_IN_VOICE_MESSAGE } from '../utils/voiceState';
import type { SearchResult } from '../services/YouTubeService';
import { pickBestAudio } from '../services/YouTubeService';

const log = childLogger({ module: 'cmd:play' });

async function searchAndPick(
  agent: MusicAgent,
  query: string,
  intent: { title?: string; artist?: string; rawQuery?: string },
): Promise<SearchResult | null> {
  const candidates = await agent.youtubeService.searchCandidates(query);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const llmPick = await agent.geminiAgent.pickBestSingle(
    intent,
    candidates.map((c) => ({ title: c.title, channel: c.artist, duration: c.duration })),
  );
  if (llmPick !== null) {
    log.debug({ query, pick: llmPick, title: candidates[llmPick].title }, 'LLM picked');
    return candidates[llmPick];
  }

  log.debug({ query }, 'LLM pick unavailable, using regex ranker');
  return pickBestAudio(candidates, intent.artist);
}

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Play a song — give a name, URL, or describe a vibe')
  .addStringOption((opt) =>
    opt.setName('query').setDescription('Song name, YouTube URL, or a vibe').setRequired(true),
  )
  .addIntegerOption((opt) =>
    opt
      .setName('insert_at')
      .setDescription(
        'Insert this NEW track at slot N (1 = play next). To jump in the queue use /jump.',
      )
      .setMinValue(1)
      .setRequired(false),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const correlationId = createCorrelationId();
  const query = interaction.options.getString('query', true);
  const position = interaction.options.getInteger('insert_at') ?? undefined;

  const voiceChannel = resolveCallerVoiceChannel(interaction);
  if (!voiceChannel) {
    await interaction.reply({
      embeds: [errorEmbed(NOT_IN_VOICE_MESSAGE)],
      ephemeral: true,
    });
    return;
  }

  if (voiceChannel.type !== 2) {
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
    await agent.join(voiceChannel);
  } catch (error) {
    log.error(
      { correlationId, guildId, error: error instanceof Error ? error.message : String(error) },
      'Failed to join voice channel',
    );
    await interaction.editReply({ embeds: [errorEmbed('Failed to join your voice channel.')] });
    return;
  }

  log.info({ correlationId, query, position, guildId }, 'Processing play request');

  const geminiResult = await agent.geminiAgent.interpret(query, {
    nowPlaying: agent.queue.nowPlaying,
    queueLength: agent.queue.length,
  });

  if (geminiResult.action === 'reject') {
    await interaction.editReply({ embeds: [errorEmbed(geminiResult.message)] });
    return;
  }

  if (geminiResult.action === 'clarify' || geminiResult.action === 'suggest') {
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

    let pick;
    try {
      pick = await response.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: 30_000,
        filter: (i) => i.user.id === interaction.user.id,
      });
    } catch (error) {
      log.debug(
        { correlationId, error: error instanceof Error ? error.message : String(error) },
        'Suggestion pick timed out',
      );
      await interaction.editReply({
        embeds: [infoEmbed('Timed Out', 'No selection made.')],
        components: [],
      });
      return;
    }

    const idx = parseInt(pick.customId.replace('pick_', ''), 10);
    const selectedQuery = geminiResult.suggestions[idx];

    await pick.update({
      embeds: [infoEmbed('Searching...', `Looking for **${selectedQuery}**`)],
      components: [],
    });

    const result = await searchAndPick(agent, selectedQuery, { rawQuery: selectedQuery });
    if (!result) {
      await interaction.editReply({
        embeds: [errorEmbed(`No results for "${selectedQuery}".`)],
        components: [],
      });
      return;
    }

    const track = agent.youtubeService.toTrackInfo(result, interaction.user.displayName);
    const landedAt =
      position !== undefined ? agent.queue.insert(track, position) : agent.queue.add(track);

    if (!agent.isPlaying && !agent.isPaused) {
      await agent.playNext();
      await interaction.editReply({ embeds: [nowPlayingEmbed(track, 0)], components: [] });
    } else {
      await interaction.editReply({
        embeds: [addedToQueueEmbed(track, landedAt)],
        components: [],
      });
    }
    return;
  }

  if (geminiResult.action !== 'play') return;

  const result = await searchAndPick(agent, geminiResult.query, { rawQuery: query });
  if (!result) {
    await interaction.editReply({
      embeds: [errorEmbed(`No results for "${geminiResult.query}".`)],
    });
    return;
  }

  const track = agent.youtubeService.toTrackInfo(result, interaction.user.displayName);
  const landedAt =
    position !== undefined ? agent.queue.insert(track, position) : agent.queue.add(track);

  if (!agent.isPlaying && !agent.isPaused) {
    await agent.playNext();
    await interaction.editReply({ embeds: [nowPlayingEmbed(track, 0)] });
  } else {
    await interaction.editReply({ embeds: [addedToQueueEmbed(track, landedAt)] });
  }
}
