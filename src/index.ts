import {
  Client,
  Events,
  GatewayIntentBits,
  Interaction,
  ButtonInteraction,
  ModalSubmitInteraction,
  ChatInputCommandInteraction,
} from 'discord.js';
import { config } from './config';
import { commands } from './commands/index';
import { agents } from './agent/MusicAgent';
import { createCorrelationId, childLogger } from './utils/logger';
import { errorEmbed } from './utils/embeds';
import { musicChannels } from './musicChannels';
import {
  isPlaylistInteraction,
  handleButton as handlePlaylistButton,
  handleModal as handlePlaylistModal,
} from './commands/playlist';
import {
  isQueueInteraction,
  handleButton as handleQueueButton,
  handleModal as handleQueueModal,
} from './commands/queue';

const log = childLogger({ module: 'bot' });

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, (c) => {
  log.info({ user: c.user.tag, guilds: c.guilds.cache.size }, 'Bot is online');
});

interface LogCtx {
  correlationId: string;
  kind: string;
  userId: string;
  guildId: string | null;
  customId?: string;
  command?: string;
}

function unpackError(error: unknown): {
  error: string;
  stack?: string;
  innerErrors?: unknown;
} {
  if (!(error instanceof Error)) return { error: String(error) };
  const innerErrors =
    error && typeof error === 'object' && 'errors' in error
      ? (error as { errors?: unknown }).errors
      : undefined;
  return { error: error.message, stack: error.stack, innerErrors };
}

async function replyWithError(
  interaction: ButtonInteraction | ModalSubmitInteraction | ChatInputCommandInteraction,
  message = 'Something went wrong. Please try again.',
): Promise<void> {
  const reply = { embeds: [errorEmbed(message)], ephemeral: true };
  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  } catch (err) {
    log.debug({ error: unpackError(err).error }, 'Failed to send error reply');
  }
}

async function runInteraction<T extends Interaction>(
  interaction: T,
  ctx: LogCtx,
  handler: (i: T) => Promise<void>,
): Promise<void> {
  log.info(ctx, 'Interaction received');
  try {
    await handler(interaction);
    log.debug(ctx, 'Interaction completed');
  } catch (error) {
    log.error({ ...ctx, ...unpackError(error) }, 'Interaction failed');
    if (interaction.isChatInputCommand() || interaction.isButton() || interaction.isModalSubmit()) {
      await replyWithError(interaction);
    }
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  const correlationId = createCorrelationId();
  const userId = interaction.user.id;
  const guildId = interaction.guildId;

  if (interaction.isButton()) {
    if (isPlaylistInteraction(interaction.customId)) {
      return runInteraction(
        interaction,
        { correlationId, kind: 'playlist-button', userId, guildId, customId: interaction.customId },
        handlePlaylistButton,
      );
    }
    if (isQueueInteraction(interaction.customId)) {
      return runInteraction(
        interaction,
        { correlationId, kind: 'queue-button', userId, guildId, customId: interaction.customId },
        handleQueueButton,
      );
    }
    return;
  }

  if (interaction.isModalSubmit()) {
    if (isPlaylistInteraction(interaction.customId)) {
      return runInteraction(
        interaction,
        { correlationId, kind: 'playlist-modal', userId, guildId, customId: interaction.customId },
        handlePlaylistModal,
      );
    }
    if (isQueueInteraction(interaction.customId)) {
      return runInteraction(
        interaction,
        { correlationId, kind: 'queue-modal', userId, guildId, customId: interaction.customId },
        handleQueueModal,
      );
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);
  if (!command) return;

  const lockedChannel = musicChannels.get(guildId!);
  if (
    lockedChannel &&
    interaction.channelId !== lockedChannel &&
    interaction.commandName !== 'setup'
  ) {
    await interaction.reply({
      embeds: [errorEmbed(`Music commands only work in <#${lockedChannel}>.`)],
      ephemeral: true,
    });
    return;
  }

  return runInteraction(
    interaction,
    { correlationId, kind: 'command', userId, guildId, command: interaction.commandName },
    (i) => command.execute(i),
  );
});

function shutdown(signal: string) {
  log.info({ signal }, 'Shutting down gracefully');
  for (const [guildId, agent] of agents) {
    agent.destroy();
    agents.delete(guildId);
  }
  client.destroy();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  log.fatal(unpackError(error), 'Uncaught exception');
  shutdown('uncaughtException');
});

process.on('unhandledRejection', (reason) => {
  log.error(unpackError(reason), 'Unhandled promise rejection');
});

client.login(config.DISCORD_TOKEN);
