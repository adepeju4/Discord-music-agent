import { PermissionFlagsBits } from 'discord.js';
import type { ChatInputCommandInteraction, ButtonInteraction, VoiceBasedChannel } from 'discord.js';

export function resolveCallerVoiceChannel(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
): VoiceBasedChannel | null {
  const cached = interaction.member as { voice?: { channel?: VoiceBasedChannel | null } } | null;
  return cached?.voice?.channel ?? null;
}

export const NOT_IN_VOICE_MESSAGE = 'Someone has to be in general voice chat';

const REQUIRED_VOICE_PERMISSIONS = [
  { flag: PermissionFlagsBits.ViewChannel, name: 'View Channel' },
  { flag: PermissionFlagsBits.Connect, name: 'Connect' },
  { flag: PermissionFlagsBits.Speak, name: 'Speak' },
] as const;

/**
 * Discord does not report a failed voice join: joinVoiceChannel() resolves even
 * when the bot cannot actually enter the channel, so a locked channel would
 * otherwise look like a track that silently never plays.
 */
export function missingVoicePermissions(channel: VoiceBasedChannel): string[] {
  const me = channel.guild.members.me;
  if (!me) return [];
  const permissions = channel.permissionsFor(me);
  if (!permissions) return [];
  return REQUIRED_VOICE_PERMISSIONS.filter((p) => !permissions.has(p.flag)).map((p) => p.name);
}
