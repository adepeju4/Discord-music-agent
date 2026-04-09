import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  ModalBuilder,
  ModalSubmitInteraction,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { getOrCreateAgent } from '../agent/MusicAgent';
import { errorEmbed, infoEmbed, playlistEmbed } from '../utils/embeds';
import { config } from '../config';
import { childLogger, createCorrelationId } from '../utils/logger';
import { setDraft, getDraft, deleteDraft, type PlaylistDraft } from '../agent/playlistDrafts';
import { resolveCallerVoiceChannel, NOT_IN_VOICE_MESSAGE } from '../utils/voiceState';
import { pickBestAudio } from '../services/YouTubeService';

const log = childLogger({ module: 'cmd:playlist' });

const CUSTOM_ID_PREFIX = 'pl:';

function draftButtons(userId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}queue:${userId}`)
      .setLabel('Queue it')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}refine:${userId}`)
      .setLabel('Refine')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}regen:${userId}`)
      .setLabel('Regenerate')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}cancel:${userId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger),
  );
}

export function isPlaylistInteraction(customId: string): boolean {
  return customId.startsWith(CUSTOM_ID_PREFIX);
}

export const data = new SlashCommandBuilder()
  .setName('playlist')
  .setDescription('Build a playlist interactively with AI')
  .addStringOption((opt) =>
    opt.setName('theme').setDescription('Describe a vibe, mood, or theme').setRequired(true),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const correlationId = createCorrelationId();
  const theme = interaction.options.getString('theme', true);

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

  log.info({ correlationId, theme, guildId }, 'Starting playlist draft');

  const result = await agent.geminiAgent.curatePlaylst(theme);

  if (!result.tracks || result.tracks.length === 0) {
    await interaction.editReply({ embeds: [errorEmbed(result.message)] });
    return;
  }

  const tracks = result.tracks.slice(0, config.MAX_PLAYLIST_SIZE);
  setDraft({ guildId, userId: interaction.user.id, theme, tracks });

  await interaction.editReply({
    embeds: [
      playlistEmbed(theme, tracks, {
        note: 'Draft — click **Refine** to tweak or **Queue it** to start playing.',
        footer: `${tracks.length} tracks • draft expires in 5 min`,
      }),
    ],
    components: [draftButtons(interaction.user.id)],
  });
}

// --- Button/Modal handlers ------------------------------------------------

function parseCustomId(customId: string): { action: string; userId: string } | null {
  if (!customId.startsWith(CUSTOM_ID_PREFIX)) return null;
  const rest = customId.slice(CUSTOM_ID_PREFIX.length);
  const [action, userId] = rest.split(':');
  if (!action || !userId) return null;
  return { action, userId };
}

async function rejectIfNotOwner(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  ownerUserId: string,
): Promise<boolean> {
  if (interaction.user.id !== ownerUserId) {
    await interaction.reply({
      embeds: [errorEmbed('Only the user who started this playlist can use these buttons.')],
      ephemeral: true,
    });
    return true;
  }
  return false;
}

async function replyDraftExpired(
  interaction: ButtonInteraction | ModalSubmitInteraction,
): Promise<void> {
  await interaction.reply({
    embeds: [errorEmbed('That playlist draft expired. Run `/playlist` again.')],
    ephemeral: true,
  });
}

export async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return;
  const { action, userId } = parsed;
  const guildId = interaction.guildId!;

  if (await rejectIfNotOwner(interaction, userId)) return;

  const draft = getDraft(guildId, userId);
  if (!draft && action !== 'cancel') {
    await replyDraftExpired(interaction);
    return;
  }

  const agent = getOrCreateAgent(guildId);
  agent.textChannel = interaction.channel as import('discord.js').TextChannel;

  switch (action) {
    case 'queue':
      await handleQueueIt(interaction, draft!);
      return;
    case 'refine':
      await handleShowRefineModal(interaction, draft!);
      return;
    case 'regen':
      await handleRegenerate(interaction, draft!);
      return;
    case 'cancel':
      deleteDraft(guildId, userId);
      await interaction.update({
        embeds: [infoEmbed('Cancelled', 'Playlist draft discarded.')],
        components: [],
      });
      return;
  }
}

export async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed || parsed.action !== 'refineModal') return;
  const { userId } = parsed;
  const guildId = interaction.guildId!;

  log.debug({ customId: interaction.customId, userId }, 'Refine modal submitted');

  if (await rejectIfNotOwner(interaction, userId)) return;

  const draft = getDraft(guildId, userId);
  if (!draft) {
    await replyDraftExpired(interaction);
    return;
  }

  const instruction = interaction.fields.getTextInputValue('instruction').trim();
  if (!instruction) {
    await interaction.reply({
      embeds: [errorEmbed('Please enter an instruction.')],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const agent = getOrCreateAgent(guildId);
  const correlationId = createCorrelationId();
  log.info({ correlationId, instruction }, 'Applying refinement');

  const result = await agent.geminiAgent.refinePlaylist(draft.theme, draft.tracks, instruction);

  if (!result.tracks || result.tracks.length === 0) {
    log.warn({ correlationId }, 'Refinement returned no tracks');
    await interaction.editReply({
      embeds: [errorEmbed(result.message || "Couldn't apply that change.")],
    });
    return;
  }

  const revised = result.tracks.slice(0, config.MAX_PLAYLIST_SIZE);
  const updated = setDraft({
    guildId,
    userId,
    theme: draft.theme,
    tracks: revised,
  });

  try {
    await interaction.message?.edit({
      embeds: [
        playlistEmbed(updated.theme, updated.tracks, {
          note: result.message,
          footer: `${revised.length} tracks • draft expires in 5 min`,
        }),
      ],
      components: [draftButtons(userId)],
    });
  } catch (error) {
    log.error(
      { correlationId, error: error instanceof Error ? error.message : String(error) },
      'Failed to edit original draft message',
    );
  }

  // Acknowledge in the ephemeral reply so the user sees something happened
  await interaction.editReply({
    embeds: [infoEmbed('Refined', result.message || 'Draft updated.')],
  });
}

// --- Individual button handlers -------------------------------------------

async function handleShowRefineModal(
  interaction: ButtonInteraction,
  draft: PlaylistDraft,
): Promise<void> {
  const modal = new ModalBuilder()
    .setCustomId(`${CUSTOM_ID_PREFIX}refineModal:${draft.userId}`)
    .setTitle('Refine Playlist');

  const input = new TextInputBuilder()
    .setCustomId('instruction')
    .setLabel('What would you like to change?')
    .setPlaceholder('e.g. "remove Halo, add 3 more 2020s tracks"')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(500)
    .setRequired(true);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  await interaction.showModal(modal);
}

async function handleRegenerate(
  interaction: ButtonInteraction,
  draft: PlaylistDraft,
): Promise<void> {
  await interaction.deferUpdate();

  const agent = getOrCreateAgent(interaction.guildId!);
  const correlationId = createCorrelationId();
  log.info({ correlationId, theme: draft.theme }, 'Regenerating playlist draft');

  const result = await agent.geminiAgent.curatePlaylst(draft.theme);
  if (!result.tracks || result.tracks.length === 0) {
    await interaction.followUp({
      embeds: [errorEmbed(result.message || 'Failed to regenerate.')],
      ephemeral: true,
    });
    return;
  }

  const tracks = result.tracks.slice(0, config.MAX_PLAYLIST_SIZE);
  const updated = setDraft({
    guildId: draft.guildId,
    userId: draft.userId,
    theme: draft.theme,
    tracks,
  });

  await interaction.editReply({
    embeds: [
      playlistEmbed(updated.theme, updated.tracks, {
        note: 'Regenerated. Refine again or queue it.',
        footer: `${tracks.length} tracks • draft expires in 5 min`,
      }),
    ],
    components: [draftButtons(draft.userId)],
  });
}

async function handleQueueIt(interaction: ButtonInteraction, draft: PlaylistDraft): Promise<void> {
  const guildId = draft.guildId;
  const agent = getOrCreateAgent(guildId);
  const correlationId = createCorrelationId();

  const voiceChannel = resolveCallerVoiceChannel(interaction);
  if (!voiceChannel || voiceChannel.type !== 2) {
    await interaction.reply({
      embeds: [errorEmbed(NOT_IN_VOICE_MESSAGE)],
      ephemeral: true,
    });
    return;
  }

  try {
    await agent.join(voiceChannel);
  } catch (error) {
    log.error(
      { correlationId, guildId, error: error instanceof Error ? error.message : String(error) },
      'Failed to join voice channel',
    );
    await interaction.reply({
      embeds: [errorEmbed('Failed to join your voice channel.')],
      ephemeral: true,
    });
    return;
  }

  await interaction.update({
    embeds: [
      playlistEmbed(draft.theme, draft.tracks, {
        note: 'Queueing tracks...',
        footer: `${draft.tracks.length} tracks • searching YouTube`,
      }),
    ],
    components: [],
  });

  const CONCURRENCY = 5;
  const candidateLists: Array<Awaited<ReturnType<typeof agent.youtubeService.searchCandidates>>> =
    new Array(draft.tracks.length).fill(null).map(() => []);

  for (let batchStart = 0; batchStart < draft.tracks.length; batchStart += CONCURRENCY) {
    const batch = draft.tracks.slice(batchStart, batchStart + CONCURRENCY);
    log.info(
      {
        correlationId,
        batch: `${batchStart + 1}-${Math.min(batchStart + CONCURRENCY, draft.tracks.length)}/${draft.tracks.length}`,
      },
      'Searching draft batch candidates',
    );
    const results = await Promise.all(
      batch.map((t) => agent.youtubeService.searchCandidates(`${t.title} ${t.artist}`, 5)),
    );
    for (let i = 0; i < results.length; i++) {
      candidateLists[batchStart + i] = results[i];
    }
  }

  const withCandidates = draft.tracks
    .map((t, i) => ({ i, intent: t, candidates: candidateLists[i] }))
    .filter((x) => x.candidates.length > 0);

  const llmItems = withCandidates.map((x) => ({
    intent: { title: x.intent.title, artist: x.intent.artist },
    candidates: x.candidates.map((c) => ({
      title: c.title,
      channel: c.artist,
      duration: c.duration,
    })),
  }));

  log.info({ correlationId, count: llmItems.length }, 'Running batched LLM pick');
  const llmPicks = await agent.geminiAgent.pickBestBatch(llmItems);

  let queued = 0;
  let playbackKicked = false;
  for (let k = 0; k < withCandidates.length; k++) {
    const { i, intent, candidates } = withCandidates[k];
    const llmIdx = llmPicks[k];
    const sr =
      llmIdx !== null && llmIdx >= 0 && llmIdx < candidates.length
        ? candidates[llmIdx]
        : pickBestAudio(candidates, intent.artist);

    if (!sr) {
      log.info(
        { correlationId, track: `${intent.title} - ${intent.artist}` },
        'Draft track not found — skipping',
      );
      continue;
    }
    const track = agent.youtubeService.toTrackInfo(sr, interaction.user.displayName);
    agent.queue.add(track);
    queued++;
    log.debug(
      {
        correlationId,
        playlistIndex: i,
        pickedTitle: sr.title,
        via: llmIdx !== null ? 'llm' : 'regex',
      },
      'Track resolved',
    );

    if (!playbackKicked && !agent.isPlaying && !agent.isPaused) {
      playbackKicked = true;
      await agent.playNext();
    }
  }

  log.info({ correlationId, queued, total: draft.tracks.length }, 'Draft queued');

  deleteDraft(guildId, draft.userId);

  await interaction.editReply({
    embeds: [
      playlistEmbed(draft.theme, draft.tracks, {
        note: `Queued ${queued}/${draft.tracks.length} tracks.`,
        footer: `Requested by ${interaction.user.displayName}`,
      }),
    ],
    components: [],
  });
}
