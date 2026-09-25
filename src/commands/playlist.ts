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
import { DEFAULT_RECENT_SHARE } from '../agent/GeminiAgent';
import { errorEmbed, infoEmbed, playlistEmbed } from '../utils/embeds';
import { config } from '../config';
import { childLogger, createCorrelationId } from '../utils/logger';
import { setDraft, getDraft, deleteDraft, type PlaylistDraft } from '../agent/playlistDrafts';
import { resolveCallerVoiceChannel, NOT_IN_VOICE_MESSAGE } from '../utils/voiceState';
import { resolveTrackIntents } from '../agent/resolveTracks';
import { SpotifyService } from '../services/SpotifyService';

const log = childLogger({ module: 'cmd:playlist' });

const spotify = new SpotifyService();

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
  )
  .addIntegerOption((opt) =>
    opt
      .setName('recent')
      .setDescription('How much should be recent releases? Default 60%')
      .setMinValue(0)
      .setMaxValue(100)
      .setRequired(false),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const correlationId = createCorrelationId();
  const theme = interaction.options.getString('theme', true);
  const recentShare = interaction.options.getInteger('recent') ?? DEFAULT_RECENT_SHARE;

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

  const pools = await agent.youtubeService.music.collectThemePools(theme);
  const result = await agent.geminiAgent.curatePlaylst(theme, pools, recentShare);

  if (!result.tracks || result.tracks.length === 0) {
    await interaction.editReply({ embeds: [errorEmbed(result.message)] });
    return;
  }

  const tracks = result.tracks.slice(0, config.MAX_PLAYLIST_SIZE);
  setDraft({ guildId, userId: interaction.user.id, theme, tracks, recentShare });

  await interaction.editReply({
    embeds: [
      playlistEmbed(theme, tracks, {
        note: 'Draft — click **Refine** to tweak or **Queue it** to start playing.',
        footer: `${tracks.length} tracks • ~${recentShare}% recent • draft expires in 5 min`,
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
    recentShare: draft.recentShare,
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

  const pools = await agent.youtubeService.music.collectThemePools(draft.theme);
  const result = await agent.geminiAgent.curatePlaylst(draft.theme, pools, draft.recentShare);
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
    recentShare: draft.recentShare,
  });

  await interaction.editReply({
    embeds: [
      playlistEmbed(updated.theme, updated.tracks, {
        note: 'Regenerated. Refine again or queue it.',
        footer: `${tracks.length} tracks • ~${draft.recentShare}% recent • draft expires in 5 min`,
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

  const queuer = {
    queued: 0,
    kicked: false,
  };
  const { resolved, failed } = await resolveTrackIntents(
    agent.youtubeService,
    agent.geminiAgent,
    draft.tracks,
    interaction.user.displayName,
    async (track) => {
      agent.queue.add(track);
      queuer.queued++;
      if (!queuer.kicked && !agent.isActive) {
        queuer.kicked = true;
        await agent.playNext();
      } else if (queuer.queued === 1) {
        agent.prefetchNext();
      }
    },
    {
      lookup: spotify,
      concurrency: () => (agent.isActive ? 2 : 5),
    },
  );

  log.info({ correlationId, queued: resolved, failed, total: draft.tracks.length }, 'Draft queued');

  deleteDraft(guildId, draft.userId);

  await interaction.editReply({
    embeds: [
      playlistEmbed(draft.theme, draft.tracks, {
        note: `Queued ${resolved}/${draft.tracks.length} tracks.`,
        footer: `Requested by ${interaction.user.displayName}`,
      }),
    ],
    components: [],
  });
}
