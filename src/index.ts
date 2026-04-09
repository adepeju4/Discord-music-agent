import { Client, Events, GatewayIntentBits } from 'discord.js';
import { config } from './config';
import { commands } from './commands/index';
import { agents } from './agent/MusicAgent';
import { createCorrelationId, childLogger } from './utils/logger';
import { errorEmbed } from './utils/embeds';
import { musicChannels } from './musicChannels';

const log = childLogger({ module: 'bot' });

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, (c) => {
  log.info({ user: c.user.tag, guilds: c.guilds.cache.size }, 'Bot is online');
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);
  if (!command) return;

  const lockedChannel = musicChannels.get(interaction.guildId!);
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

  const correlationId = createCorrelationId();
  const logCtx = {
    correlationId,
    command: interaction.commandName,
    userId: interaction.user.id,
    guildId: interaction.guildId,
  };

  log.info(logCtx, 'Command received');

  try {
    await command.execute(interaction);
    log.debug(logCtx, 'Command completed');
  } catch (error) {
    log.error({ ...logCtx, error }, 'Command failed');
    const reply = {
      embeds: [errorEmbed('Something went wrong. Please try again.')],
      ephemeral: true,
    };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
});

// Graceful shutdown
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

client.login(config.DISCORD_TOKEN);
