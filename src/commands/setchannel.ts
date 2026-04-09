import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';
import { musicChannels } from '../musicChannels';
import { infoEmbed, errorEmbed } from '../utils/embeds';

export const data = new SlashCommandBuilder()
  .setName('setup')
  .setDescription('Create a music channel and lock all music commands to it')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((opt) =>
    opt.setName('channel_name').setDescription('Channel name (default: music)'),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const guild = interaction.guild;
  if (!guild) return;

  const channelName = interaction.options.getString('channel_name') ?? 'music';

  await interaction.deferReply();

  // Check if a channel with that name already exists
  const existing = guild.channels.cache.find(
    (ch) => ch.name === channelName && ch.type === ChannelType.GuildText,
  );

  if (existing) {
    musicChannels.set(guild.id, existing.id);
    await interaction.editReply({
      embeds: [
        infoEmbed(
          'Setup Complete',
          `Found existing <#${existing.id}>. Music commands are now locked to it.`,
        ),
      ],
    });
    return;
  }

  try {
    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      topic: 'Use music bot commands here!',
    });

    musicChannels.set(guild.id, channel.id);

    await interaction.editReply({
      embeds: [
        infoEmbed(
          'Setup Complete',
          `Created <#${channel.id}>. All music commands are now locked to it.`,
        ),
      ],
    });
  } catch {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          "Couldn't create the channel. Make sure I have the **Manage Channels** permission.",
        ),
      ],
    });
  }
}
