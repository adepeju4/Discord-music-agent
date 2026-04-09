import type { ChatInputCommandInteraction, ButtonInteraction, VoiceBasedChannel } from 'discord.js';

export function resolveCallerVoiceChannel(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
): VoiceBasedChannel | null {
  const cached = interaction.member as { voice?: { channel?: VoiceBasedChannel | null } } | null;
  return cached?.voice?.channel ?? null;
}

export const NOT_IN_VOICE_MESSAGE = 'Someone has to be in general voice chat';
