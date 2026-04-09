import { Collection, ChatInputCommandInteraction, SharedSlashCommand } from 'discord.js';

import * as play from './play';
import * as skip from './skip';
import * as jump from './jump';
import * as stop from './stop';
import * as pause from './pause';
import * as nowplaying from './nowplaying';
import * as queue from './queue';
import * as volume from './volume';
import * as loop from './loop';
import * as shuffle from './shuffle';
import * as search from './search';
import * as remove from './remove';
import * as playlist from './playlist';
import * as setchannel from './setchannel';

export interface Command {
  data: SharedSlashCommand;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

const commandModules: Command[] = [
  play,
  skip,
  jump,
  stop,
  pause,
  nowplaying,
  queue,
  volume,
  loop,
  shuffle,
  search,
  remove,
  playlist,
  setchannel,
];

export const commands = new Collection<string, Command>();

for (const cmd of commandModules) {
  commands.set(cmd.data.name, cmd);
}
