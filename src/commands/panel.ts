import type { ButtonInteraction } from 'discord.js';
import { agents, VOLUME_STEP } from '../agent/MusicAgent';
import { PANEL_PREFIX } from '../agent/NowPlayingPanel';
import { errorEmbed, infoEmbed } from '../utils/embeds';
import { childLogger } from '../utils/logger';
import { resolveCallerVoiceChannel } from '../utils/voiceState';

const log = childLogger({ module: 'panel' });

export function isPanelInteraction(customId: string): boolean {
  return customId.startsWith(PANEL_PREFIX);
}

export async function handleButton(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId;
  const agent = guildId ? agents.get(guildId) : undefined;

  if (!agent || !agent.queue.nowPlaying) {
    await interaction.reply({
      embeds: [errorEmbed('Nothing is playing right now.')],
      ephemeral: true,
    });
    return;
  }

  // Controls belong to whoever is actually listening.
  const callerChannel = resolveCallerVoiceChannel(interaction);
  const botChannelId = agent.connection?.joinConfig.channelId;
  if (!callerChannel || (botChannelId && callerChannel.id !== botChannelId)) {
    await interaction.reply({
      embeds: [errorEmbed('Join the voice channel to use these controls.')],
      ephemeral: true,
    });
    return;
  }

  // After a dropped connection the queue survives but there is nothing to send
  // audio down, so these buttons would appear to do nothing at all.
  if (!agent.connection) {
    try {
      await agent.join(callerChannel);
      log.info({ guildId, userId: interaction.user.id }, 'Reconnected from panel control');
    } catch {
      await interaction.reply({
        embeds: [
          errorEmbed(
            "I'm not connected to voice any more. Run `/play` to bring me back — your queue is still here.",
          ),
        ],
        ephemeral: true,
      });
      return;
    }
  }

  const action = interaction.customId.slice(PANEL_PREFIX.length);
  let volumeResult: { volume: number; appliedNow: boolean } | null = null;
  log.debug({ guildId, action, userId: interaction.user.id }, 'Panel control used');

  switch (action) {
    case 'play':
      // pause() toggles, so this unpauses when paused.
      if (agent.isPaused) agent.pause();
      break;
    case 'pause':
      if (!agent.isPaused) agent.pause();
      break;
    case 'previous':
      if (!(await agent.playPrevious())) {
        await interaction.reply({
          embeds: [errorEmbed('Nothing played before this track.')],
          ephemeral: true,
        });
        return;
      }
      break;
    case 'next':
      agent.skip();
      break;
    case 'volup':
    case 'voldown':
      volumeResult = agent.nudgeVolume(action === 'volup' ? VOLUME_STEP : -VOLUME_STEP);
      break;
    case 'stop':
      agent.stop();
      break;
    default:
      await interaction.reply({ embeds: [errorEmbed('Unknown control.')], ephemeral: true });
      return;
  }

  await interaction.deferUpdate();
  // "next" lands on the following track asynchronously, so let that settle.
  if (action === 'next') setTimeout(() => void agent.panel.refresh(), 500);
  else await agent.panel.refresh();

  if (volumeResult && !volumeResult.appliedNow) {
    await interaction.followUp({
      embeds: [
        infoEmbed(
          `Volume set to ${volumeResult.volume}%`,
          'This track is playing untouched for best quality, so the new level starts with the next track.',
        ),
      ],
      ephemeral: true,
    });
  }
}
