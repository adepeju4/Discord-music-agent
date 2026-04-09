import {
  AudioPlayer,
  AudioPlayerStatus,
  VoiceConnection,
  VoiceConnectionStatus,
  createAudioPlayer,
  AudioResource,
  createAudioResource,
  StreamType,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import type { VoiceBasedChannel, TextChannel } from 'discord.js';
import { QueueManager } from './QueueManager';
import { GeminiAgent } from './GeminiAgent';
import { YouTubeService } from '../services/YouTubeService';
import { config } from '../config';
import { childLogger, createCorrelationId } from '../utils/logger';
import { errorEmbed, type TrackInfo } from '../utils/embeds';

const log = childLogger({ module: 'MusicAgent' });

export class MusicAgent {
  public readonly queue = new QueueManager();
  public readonly player: AudioPlayer;
  public connection: VoiceConnection | null = null;
  public textChannel: TextChannel | null = null;
  public volume = config.DEFAULT_VOLUME;
  private currentResource: AudioResource | null = null;
  private playStartTime = 0;
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly guildId: string;
  private readonly youtube = new YouTubeService();
  private readonly gemini = new GeminiAgent();

  constructor(guildId: string) {
    this.guildId = guildId;
    this.player = createAudioPlayer();
    this.setupPlayerEvents();
  }

  get isPlaying(): boolean {
    return this.player.state.status === AudioPlayerStatus.Playing;
  }

  get isPaused(): boolean {
    return this.player.state.status === AudioPlayerStatus.Paused;
  }

  get elapsed(): number {
    if (this.playStartTime === 0) return 0;
    return Math.floor((Date.now() - this.playStartTime) / 1000);
  }

  get geminiAgent(): GeminiAgent {
    return this.gemini;
  }

  get youtubeService(): YouTubeService {
    return this.youtube;
  }

  async join(channel: VoiceBasedChannel): Promise<VoiceConnection> {
    if (this.connection) return this.connection;

    const correlationId = createCorrelationId();
    log.info(
      { correlationId, guildId: this.guildId, channelId: channel.id },
      'Joining voice channel',
    );

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: this.guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection!, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection!, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.destroy();
      }
    });

    this.connection.subscribe(this.player);
    this.resetInactivityTimer();
    return this.connection;
  }

  async playTrack(track: TrackInfo): Promise<void> {
    const correlationId = createCorrelationId();
    log.info({ correlationId, title: track.title }, 'Playing track');

    try {
      const stream = await this.youtube.getStream(track.url);
      const resource = createAudioResource(stream, {
        inputType: StreamType.Raw,
        inlineVolume: true,
      });

      const vol = this.volume / 100;
      resource.volume?.setVolume(vol);
      log.debug({ correlationId, volume: this.volume, hasVolumeTransform: !!resource.volume }, 'Volume applied');
      this.currentResource = resource;
      this.queue.setCurrent(track);
      this.player.play(resource);
      this.playStartTime = Date.now();
      this.clearInactivityTimer();
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error(
        { correlationId, error: errMsg, stack: error instanceof Error ? error.stack : undefined },
        'Failed to play track',
      );
      this.textChannel?.send({
        embeds: [errorEmbed(`Failed to play **${track.title}**. Skipping...`)],
      });
      this.playNext();
    }
  }

  setVolume(level: number): void {
    this.volume = level;
    this.currentResource?.volume?.setVolume(level / 100);
  }

  async playNext(): Promise<boolean> {
    const next = this.queue.next();
    if (!next) {
      this.playStartTime = 0;
      this.resetInactivityTimer();
      return false;
    }

    await this.playTrack(next);
    return true;
  }

  pause(): boolean {
    if (this.isPlaying) {
      this.player.pause();
      return true;
    }
    if (this.isPaused) {
      this.player.unpause();
      return true;
    }
    return false;
  }

  skip(): boolean {
    if (!this.queue.nowPlaying) return false;
    this.player.stop();
    return true;
  }

  stop(): void {
    this.queue.clear();
    this.currentResource?.playStream?.destroy();
    this.currentResource = null;
    this.player.stop();
    this.playStartTime = 0;
  }

  destroy(): void {
    this.stop();
    this.clearInactivityTimer();
    this.connection?.destroy();
    this.connection = null;
    log.info({ guildId: this.guildId }, 'Music agent destroyed');
  }

  private setupPlayerEvents(): void {
    this.player.on(AudioPlayerStatus.Idle, () => {
      this.playNext();
    });

    this.player.on('error', (error) => {
      log.error({ guildId: this.guildId, error: error.message }, 'Audio player error');
      this.textChannel?.send({ embeds: [errorEmbed('Playback error. Skipping to next track...')] });
      this.playNext();
    });
  }

  private resetInactivityTimer(): void {
    this.clearInactivityTimer();
    this.inactivityTimer = setTimeout(() => {
      if (!this.isPlaying && !this.isPaused) {
        log.info({ guildId: this.guildId }, 'Inactivity timeout — leaving voice channel');
        this.textChannel?.send({
          embeds: [errorEmbed('Left the voice channel due to inactivity.')],
        });
        this.destroy();
        agents.delete(this.guildId);
      }
    }, config.INACTIVITY_TIMEOUT_MS);
  }

  private clearInactivityTimer(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }
}

// Global agent registry — one per guild
export const agents = new Map<string, MusicAgent>();

export function getOrCreateAgent(guildId: string): MusicAgent {
  let agent = agents.get(guildId);
  if (!agent) {
    agent = new MusicAgent(guildId);
    agents.set(guildId, agent);
  }
  return agent;
}
