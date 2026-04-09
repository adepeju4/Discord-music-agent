import { REST, Routes } from 'discord.js';
import { config } from './config';
import { commands } from './commands/index';
import { logger } from './utils/logger';

const rest = new REST({ version: '10' }).setToken(config.DISCORD_TOKEN);

const commandData = commands.map((cmd) => cmd.data.toJSON());

logger.info(`Registering ${commandData.length} slash commands...`);

rest
  .put(Routes.applicationCommands(config.CLIENT_ID), { body: commandData })
  .then(() => {
    logger.info('Slash commands registered successfully.');
  })
  .catch((error) => {
    logger.error({ error }, 'Failed to register slash commands');
    process.exit(1);
  });
