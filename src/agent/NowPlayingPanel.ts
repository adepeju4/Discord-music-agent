import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  type Message,
  type TextChannel,
} from 'discord.js';
import { panelEmbed, type TrackInfo } from '../utils/embeds';
import { MAX_VOLUME } from './MusicAgent';
import { childLogger } from '../utils/logger';
import type { LoopMode } from './QueueManager';

const log = childLogger({ module: 'NowPlayingPanel' });

export const PANEL_PREFIX = 'np:';
const UNKNOWN_MESSAGE = 10008;

export interface PanelState {
  track: TrackInfo | null;
  paused: boolean;
  queueLength: number;
  loopMode: LoopMode;
  hasPrevious: boolean;
  volume: number;
}

export function panelComponents(state: PanelState): ActionRowBuilder<ButtonBuilder>[] {
  const idle = state.track === null;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PANEL_PREFIX}previous`)
      .setEmoji('⏮️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(idle || !state.hasPrevious),
    new ButtonBuilder()
      .setCustomId(`${PANEL_PREFIX}play`)
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Success)
      .setDisabled(idle || !state.paused),
    new ButtonBuilder()
      .setCustomId(`${PANEL_PREFIX}pause`)
      .setEmoji('⏸️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(idle || state.paused),
    new ButtonBuilder()
      .setCustomId(`${PANEL_PREFIX}next`)
      .setEmoji('⏭️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(idle),
    new ButtonBuilder()
      .setCustomId(`${PANEL_PREFIX}stop`)
      .setEmoji('⏹️')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(idle),
  );

  const volumeRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PANEL_PREFIX}voldown`)
      .setEmoji('🔉')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(idle || state.volume <= 0),
    new ButtonBuilder()
      .setCustomId(`${PANEL_PREFIX}volup`)
      .setEmoji('🔊')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(idle || state.volume >= MAX_VOLUME),
    new ButtonBuilder()
      .setCustomId(`${PANEL_PREFIX}volume`)
      .setLabel(`${state.volume}%`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );

  return [row, volumeRow];
}

/**
 * Posts a now-playing message with transport controls for every track.
 *
 * The previous track's message is removed as the next one goes up: the buttons
 * act on the player rather than on a specific song, so leaving old panels
 * around would give people stale controls that silently affect whatever is
 * playing now.
 */
export class NowPlayingPanel {
  private message: Message | null = null;
  private channel: TextChannel | null = null;
  private refreshing = false;

  constructor(private readonly getState: () => PanelState) {}

  setChannel(channel: TextChannel | null): void {
    if (channel && this.channel && channel.id !== this.channel.id) {
      void this.clear();
    }
    this.channel = channel;
  }

  /** A new track started: retire the old message and post a fresh one. */
  async onTrackChange(): Promise<void> {
    await this.post();
  }

  /** Updates the current message in place (progress, pause state, controls). */
  async refresh(): Promise<void> {
    if (!this.channel || this.refreshing) return;
    this.refreshing = true;
    try {
      if (!this.message) {
        await this.send();
        return;
      }
      try {
        this.message = await this.message.edit(this.payload());
      } catch (error) {
        if (!(error instanceof DiscordAPIError && error.code === UNKNOWN_MESSAGE)) throw error;
        this.message = null;
        await this.send();
      }
    } catch (error) {
      this.logFailure('Panel refresh failed', error);
    } finally {
      this.refreshing = false;
    }
  }

  private async post(): Promise<void> {
    if (!this.channel || this.refreshing) return;
    this.refreshing = true;
    try {
      await this.deleteMessage();
      await this.send();
    } catch (error) {
      this.logFailure('Panel post failed', error);
    } finally {
      this.refreshing = false;
    }
  }

  /** Switches the panel to its idle state. */
  async idle(): Promise<void> {
    await this.refresh();
  }

  async clear(): Promise<void> {
    await this.deleteMessage();
  }

  private payload() {
    const state = this.getState();
    return { embeds: [panelEmbed(state)], components: panelComponents(state) };
  }

  private async send(): Promise<void> {
    if (!this.channel) return;
    this.message = await this.channel.send(this.payload());
  }

  private async deleteMessage(): Promise<void> {
    const message = this.message;
    this.message = null;
    if (!message) return;
    try {
      await message.delete();
    } catch (error) {
      if (error instanceof DiscordAPIError && error.code === UNKNOWN_MESSAGE) return;
      this.logFailure('Panel delete failed', error);
    }
  }

  private logFailure(message: string, error: unknown): void {
    log.debug(
      {
        channelId: this.channel?.id,
        error: error instanceof Error ? error.message : String(error),
      },
      message,
    );
  }
}
