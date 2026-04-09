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
import { YouTubeService, pickBestAudio } from '../services/YouTubeService';
import { childLogger, createCorrelationId } from '../utils/logger';
import { errorEmbed, type TrackInfo } from '../utils/embeds';

const log = childLogger({ module: 'MusicAgent' });

export class MusicAgent {
  public readonly queue = new QueueManager();
  public readonly player: AudioPlayer;
  public connection: VoiceConnection | null = null;
  public textChannel: TextChannel | null = null;
  private currentResource: AudioResource | null = null;
  private playStartTime = 0;
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
      } catch (error) {
        log.debug(
          {
            guildId: this.guildId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Voice reconnect failed, destroying agent',
        );
        this.destroy();
      }
    });

    this.connection.subscribe(this.player);
    return this.connection;
  }

  async playTrack(track: TrackInfo): Promise<void> {
    const correlationId = createCorrelationId();
    log.info({ correlationId, title: track.title }, 'Playing track');

    try {
      const { stream, format } = await this.youtube.getStream(track.url);

      const resource = createAudioResource(stream, {
        inputType: format === 'webm-opus' ? StreamType.WebmOpus : StreamType.Arbitrary,
      });
      log.debug({ correlationId, format }, 'Audio resource created');

      this.currentResource = resource;
      this.queue.setCurrent(track);
      this.player.play(resource);
      this.playStartTime = Date.now();
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

  readonly volumeControlAvailable = false;

  async applyQueueRefinement(
    plan: Array<{ existing: number } | { new: { title: string; artist: string } }>,
    requestedBy: string,
  ): Promise<{ kept: number; added: number; failed: number }> {
    const correlationId = createCorrelationId();
    const current = this.queue.allTracks;
    log.info(
      { correlationId, planSize: plan.length, currentSize: current.length },
      'Applying queue refinement',
    );

    const resolved: (TrackInfo | null)[] = new Array(plan.length).fill(null);
    const newLookups: { index: number; title: string; artist: string }[] = [];
    const usedExisting = new Set<number>();

    for (let i = 0; i < plan.length; i++) {
      const entry = plan[i];
      if ('existing' in entry) {
        const idx = entry.existing;
        if (idx >= 0 && idx < current.length && !usedExisting.has(idx)) {
          resolved[i] = current[idx];
          usedExisting.add(idx);
        }
      } else if ('new' in entry) {
        newLookups.push({
          index: i,
          title: entry.new.title,
          artist: entry.new.artist,
        });
      }
    }

    const CONCURRENCY = 5;
    const candidatesPerLookup: Array<Awaited<ReturnType<typeof this.youtube.searchCandidates>>> =
      new Array(newLookups.length).fill(null).map(() => []);

    for (let batchStart = 0; batchStart < newLookups.length; batchStart += CONCURRENCY) {
      const batch = newLookups.slice(batchStart, batchStart + CONCURRENCY);
      const results = await Promise.all(
        batch.map((l) => this.youtube.searchCandidates(`${l.title} ${l.artist}`, 5)),
      );
      for (let j = 0; j < results.length; j++) {
        candidatesPerLookup[batchStart + j] = results[j];
      }
    }

    const llmItems = newLookups.map((l, i) => ({
      intent: { title: l.title, artist: l.artist },
      candidates: candidatesPerLookup[i].map((c) => ({
        title: c.title,
        channel: c.artist,
        duration: c.duration,
      })),
    }));
    const llmPicks = await this.gemini.pickBestBatch(llmItems);

    let failed = 0;
    for (let j = 0; j < newLookups.length; j++) {
      const lookup = newLookups[j];
      const cands = candidatesPerLookup[j];
      if (cands.length === 0) {
        failed++;
        log.info(
          { correlationId, track: `${lookup.title} - ${lookup.artist}` },
          'Refinement new-track not found',
        );
        continue;
      }
      const llmIdx = llmPicks[j];
      const sr =
        llmIdx !== null && llmIdx >= 0 && llmIdx < cands.length
          ? cands[llmIdx]
          : pickBestAudio(cands, lookup.artist);
      if (!sr) {
        failed++;
        continue;
      }
      resolved[lookup.index] = this.youtube.toTrackInfo(sr, requestedBy);
    }

    const finalTracks = resolved.filter((t): t is TrackInfo => t !== null);
    const kept = Array.from(usedExisting).length;
    const added = newLookups.length - failed;

    this.queue.replaceUpcoming(finalTracks);

    log.info(
      { correlationId, kept, added, failed, total: finalTracks.length },
      'Queue refinement applied',
    );

    return { kept, added, failed };
  }

  async playNext(): Promise<boolean> {
    const next = this.queue.next();
    if (!next) {
      this.playStartTime = 0;
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
