import { describe, it, expect } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import { missingVoicePermissions } from '../src/utils/voiceState';
import type { VoiceBasedChannel } from 'discord.js';

function channel(granted: bigint[] | null, hasMe = true): VoiceBasedChannel {
  return {
    guild: { members: { me: hasMe ? {} : null } },
    permissionsFor: () => (granted === null ? null : { has: (f: bigint) => granted.includes(f) }),
  } as unknown as VoiceBasedChannel;
}

const ALL = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.Connect,
  PermissionFlagsBits.Speak,
];

describe('missingVoicePermissions', () => {
  it('returns nothing when the bot can view, connect and speak', () => {
    expect(missingVoicePermissions(channel(ALL))).toEqual([]);
  });

  it('names each missing permission on a locked channel', () => {
    expect(missingVoicePermissions(channel([]))).toEqual(['View Channel', 'Connect', 'Speak']);
    expect(missingVoicePermissions(channel([PermissionFlagsBits.ViewChannel]))).toEqual([
      'Connect',
      'Speak',
    ]);
    expect(
      missingVoicePermissions(
        channel([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect]),
      ),
    ).toEqual(['Speak']);
  });

  it('stays silent when permissions cannot be resolved', () => {
    expect(missingVoicePermissions(channel(null))).toEqual([]);
    expect(missingVoicePermissions(channel(ALL, false))).toEqual([]);
  });
});
