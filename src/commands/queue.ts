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
import { errorEmbed, infoEmbed, queueEmbed } from '../utils/embeds';
import { childLogger, createCorrelationId } from '../utils/logger';

const log = childLogger({ module: 'cmd:queue' });

const CUSTOM_ID_PREFIX = 'q:';

export function isQueueInteraction(customId: string): boolean {
  return customId.startsWith(CUSTOM_ID_PREFIX);
}

function refineButtonRow(userId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}refine:${userId}`)
      .setLabel('Refine with AI')
      .setStyle(ButtonStyle.Primary),
  );
}

export const data = new SlashCommandBuilder()
  .setName('queue')
  .setDescription('Show the current queue')
  .addIntegerOption((opt) => opt.setName('page').setDescription('Page number').setMinValue(1));

export async function execute(interaction: ChatInputCommandInteraction) {
  const agent = getOrCreateAgent(interaction.guildId!);
  const tracks = agent.queue.allTracks;
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(tracks.length / pageSize));
  const page = Math.min((interaction.options.getInteger('page') ?? 1) - 1, totalPages - 1);

  const embed = queueEmbed(tracks, agent.queue.nowPlaying, page, totalPages);

  const components = tracks.length > 0 ? [refineButtonRow(interaction.user.id)] : [];

  await interaction.reply({ embeds: [embed], components });
}

function parseCustomId(customId: string): { action: string; userId: string } | null {
  if (!customId.startsWith(CUSTOM_ID_PREFIX)) return null;
  const rest = customId.slice(CUSTOM_ID_PREFIX.length);
  const [action, userId] = rest.split(':');
  if (!action || !userId) return null;
  return { action, userId };
}

export async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return;

  if (parsed.action === 'refine') {
    const modal = new ModalBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}refineModal:${interaction.user.id}`)
      .setTitle('Refine Queue');

    const input = new TextInputBuilder()
      .setCustomId('instruction')
      .setLabel('What should change?')
      .setPlaceholder('e.g. "remove slow songs, add 2 more upbeat ones"')
      .setStyle(TextInputStyle.Paragraph)
      .setMaxLength(500)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await interaction.showModal(modal);
  }
}

export async function handleModal(interaction: ModalSubmitInteraction): Promise<void> {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed || parsed.action !== 'refineModal') return;

  const guildId = interaction.guildId!;
  const agent = getOrCreateAgent(guildId);
  const correlationId = createCorrelationId();

  const instruction = interaction.fields.getTextInputValue('instruction').trim();
  if (!instruction) {
    await interaction.reply({
      embeds: [errorEmbed('Please enter an instruction.')],
      ephemeral: true,
    });
    return;
  }

  const currentUpcoming = agent.queue.allTracks;
  if (currentUpcoming.length === 0 && !agent.queue.nowPlaying) {
    await interaction.reply({
      embeds: [errorEmbed('The queue is empty. Nothing to refine.')],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  log.info({ correlationId, instruction, queueSize: currentUpcoming.length }, 'Refining queue');

  try {
    const result = await agent.geminiAgent.refineQueue(
      currentUpcoming.map((t) => ({ title: t.title, artist: t.artist })),
      instruction,
      agent.queue.nowPlaying
        ? { title: agent.queue.nowPlaying.title, artist: agent.queue.nowPlaying.artist }
        : null,
    );

    if (!result.plan || (result.plan.length === 0 && currentUpcoming.length > 0)) {
      log.warn({ correlationId }, 'Refinement plan is empty');
    }

    const summary = await agent.applyQueueRefinement(result.plan, interaction.user.displayName);

    const newTracks = agent.queue.allTracks;
    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(newTracks.length / pageSize));
    const embed = queueEmbed(newTracks, agent.queue.nowPlaying, 0, totalPages);

    await interaction.editReply({
      embeds: [
        infoEmbed(
          'Queue Refined',
          `${result.message}\n\n_Kept ${summary.kept} • Added ${summary.added}${summary.failed > 0 ? ` • ${summary.failed} not found` : ''}_`,
        ),
        embed,
      ],
      components: newTracks.length > 0 ? [refineButtonRow(interaction.user.id)] : [],
    });
  } catch (error) {
    log.error(
      { correlationId, error: error instanceof Error ? error.message : String(error) },
      'Queue refinement handler failed',
    );
    await interaction.editReply({
      embeds: [errorEmbed("Couldn't refine the queue. Try again.")],
    });
  }
}
