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
import type { Readable } from 'node:stream';
import type { VoiceBasedChannel, TextChannel } from 'discord.js';
import { QueueManager } from './QueueManager';
import { GeminiAgent } from './GeminiAgent';
import { youtubeService, type YouTubeService } from '../services/YouTubeService';
import { resolveTrackIntents } from './resolveTracks';
import { SpotifyService } from '../services/SpotifyService';
import { childLogger, createCorrelationId } from '../utils/logger';
import { errorEmbed, type TrackInfo } from '../utils/embeds';
import { errorText, explainError, explainErrorOr } from '../utils/errors';
import { NowPlayingPanel } from './NowPlayingPanel';

const log = childLogger({ module: 'MusicAgent' });

const spotifyLookup = new SpotifyService();

export const DEFAULT_VOLUME = 100;
/** prism-media caps the Opus encoder here; our source is ~130 kbps. */
export const TRANSCODE_BITRATE = 128_000;
export const MAX_VOLUME = 200;
export const VOLUME_STEP = 10;

interface PreloadedStream {
  url: string;
  stream: Readable;
  format: 'webm-opus' | 'arbitrary';
}

export class MusicAgent {
  public readonly queue = new QueueManager();
  public readonly player: AudioPlayer;
  public connection: VoiceConnection | null = null;
  private _textChannel: TextChannel | null = null;
  public readonly panel: NowPlayingPanel = new NowPlayingPanel(() => ({
    track: this.queue.nowPlaying,
    paused: this.isPaused,
    queueLength: this.queue.length,
    loopMode: this.queue.loopMode,
    hasPrevious: this.queue.hasPrevious,
    volume: this.volumePercent,
  }));
  private currentResource: AudioResource | null = null;
  private volumePercent = DEFAULT_VOLUME;
  private preload: PreloadedStream | null = null;
  private lastChannel: VoiceBasedChannel | null = null;
  private readonly guildId: string;
  private readonly youtube = youtubeService;
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

  get textChannel(): TextChannel | null {
    return this._textChannel;
  }

  set textChannel(channel: TextChannel | null) {
    this._textChannel = channel;
    this.panel.setChannel(channel);
  }

  /**
   * True whenever the player is doing anything at all. A track that was just
   * handed to play() sits in Buffering for a moment, so `isPlaying` alone reads
   * as "idle" and callers kick playNext() again, skipping the track.
   */
  get isActive(): boolean {
    return this.player.state.status !== AudioPlayerStatus.Idle;
  }

  get geminiAgent(): GeminiAgent {
    return this.gemini;
  }

  get youtubeService(): YouTubeService {
    return this.youtube;
  }

  async join(channel: VoiceBasedChannel): Promise<VoiceConnection> {
    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      return this.connection;
    }
    this.connection = null;

    const correlationId = createCorrelationId();
    log.info(
      {
        correlationId,
        guildId: this.guildId,
        channelId: channel.id,
        // Discord defaults voice channels to 64 kbps. The source is ~130 kbps
        // Opus, so a low channel bitrate is the one server-side quality lever.
        channelBitrate: channel.bitrate,
      },
      'Joining voice channel',
    );

    this.lastChannel = channel;
    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: this.guildId,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      log.info({ guildId: this.guildId }, 'Voice connection disconnected');
      try {
        // Discord moving the voice server looks like a disconnect and recovers
        // on its own within a few seconds.
        await Promise.race([
          entersState(this.connection!, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection!, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        return;
      } catch {
        // Not self-healing — rejoin explicitly below.
      }

      if (await this.rejoin()) return;

      // Give up on the connection, but never on the queue: a dropped call is
      // not a reason to lose the tracks people queued.
      log.warn({ guildId: this.guildId, queued: this.queue.length }, 'Voice connection lost');
      this.connection?.destroy();
      this.connection = null;
      this.textChannel?.send({
        embeds: [
          errorEmbed(
            `I lost the voice connection. Your queue is safe — **${this.queue.length} track${this.queue.length === 1 ? '' : 's'}** still waiting. Run \`/play\` to pick it back up.`,
          ),
        ],
      });
    });

    this.connection.on('stateChange', (oldState, newState) => {
      if (oldState.status === newState.status) return;
      log.info(
        { guildId: this.guildId, from: oldState.status, to: newState.status },
        'Voice connection state changed',
      );
    });

    const subscription = this.connection.subscribe(this.player);
    if (!subscription) {
      log.error(
        { correlationId, guildId: this.guildId },
        'Voice connection refused the player subscription — audio would go nowhere',
      );
    }

    // joinVoiceChannel() resolves optimistically, so without this the bot
    // reports "Now Playing" while never actually reaching the channel.
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (error) {
      log.error(
        {
          correlationId,
          guildId: this.guildId,
          channelId: channel.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Voice connection never became ready',
      );
      this.connection.destroy();
      this.connection = null;
      throw new Error('Voice connection never became ready');
    }

    log.info(
      { correlationId, guildId: this.guildId, channelId: channel.id },
      'Voice connection ready',
    );
    return this.connection;
  }

  async playTrack(track: TrackInfo): Promise<void> {
    const correlationId = createCorrelationId();
    log.info({ correlationId, title: track.title }, 'Playing track');

    try {
      const ready = this.takePreload(track.url);
      if (ready) log.debug({ correlationId, title: track.title }, 'Using prefetched audio');
      const { stream, format } = ready ?? (await this.youtube.getStream(track.url));

      // Changing the level means decoding to PCM and re-encoding, which gives up
      // bit-exact passthrough. So only pay that when the volume is actually
      // moved off 100% — at 100% the Opus packets go through untouched.
      const needsGain = this.volumePercent !== DEFAULT_VOLUME;
      const resource = createAudioResource(stream, {
        inputType: format === 'webm-opus' ? StreamType.WebmOpus : StreamType.Arbitrary,
        inlineVolume: needsGain,
      });
      if (needsGain) {
        resource.volume?.setVolume(this.volumePercent / 100);
        resource.encoder?.setBitrate(TRANSCODE_BITRATE);
      }
      log.debug(
        { correlationId, format, volume: this.volumePercent, passthrough: !needsGain },
        'Audio resource created',
      );
      log.debug({ correlationId, format }, 'Audio resource created');

      this.currentResource = resource;
      this.queue.setCurrent(track);
      this.player.play(resource);
      void this.panel.onTrackChange();
      this.schedulePreload();
    } catch (error: unknown) {
      const errMsg = errorText(error);
      log.error(
        { correlationId, error: errMsg, stack: error instanceof Error ? error.stack : undefined },
        'Failed to play track',
      );
      const reason = explainError(error);
      const moreComing = this.queue.length > 0;
      this.textChannel?.send({
        embeds: [
          errorEmbed(
            [
              `Couldn't play **${track.title}**.`,
              reason,
              moreComing ? 'Skipping to the next track.' : null,
            ]
              .filter(Boolean)
              .join('\n\n'),
          ),
        ],
      });
      this.playNext();
    }
  }

  readonly volumeControlAvailable = true;

  get volume(): number {
    return this.volumePercent;
  }

  /**
   * Sets playback level for everyone in the channel.
   *
   * `appliedNow` is false when the running track is a bit-exact passthrough
   * stream, which has no volume stage to adjust — the change takes effect on
   * the next track.
   */
  setVolume(percent: number): { volume: number; appliedNow: boolean } {
    const clamped = Math.max(0, Math.min(MAX_VOLUME, Math.round(percent)));
    this.volumePercent = clamped;

    const gain = this.currentResource?.volume;
    if (gain) gain.setVolume(clamped / 100);
    const appliedNow = Boolean(gain) || this.queue.nowPlaying === null;

    log.debug({ guildId: this.guildId, volume: clamped, appliedNow }, 'Volume set');
    return { volume: clamped, appliedNow };
  }

  nudgeVolume(delta: number): { volume: number; appliedNow: boolean } {
    return this.setVolume(this.volumePercent + delta);
  }

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

    const results = new Map<number, TrackInfo>();
    const { failed } = await resolveTrackIntents(
      this.youtube,
      this.gemini,
      newLookups,
      requestedBy,
      (track, i) => {
        results.set(newLookups[i].index, track);
      },
      { lookup: spotifyLookup, concurrency: () => (this.isActive ? 2 : 5) },
    );
    for (const [index, track] of results) resolved[index] = track;

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

  /**
   * Starts fetching the next track's audio while this one plays. yt-dlp needs
   * roughly two seconds to spin up and connect, which is otherwise dead air
   * between songs.
   */
  prefetchNext(): void {
    this.schedulePreload();
  }

  private schedulePreload(): void {
    const next = this.queue.peek();
    // Looping a single track would mean replaying a stream that has already
    // been consumed, so there is nothing useful to prefetch.
    if (!next || next.url === this.queue.nowPlaying?.url) return;
    if (this.preload?.url === next.url) return;

    this.discardPreload();
    const url = next.url;
    void this.youtube
      .getStream(url)
      .then(({ stream, format }) => {
        // The queue may have moved on while we were fetching.
        if (this.queue.peek()?.url !== url) {
          stream.destroy();
          return;
        }
        this.preload = { url, stream, format };
        log.debug({ guildId: this.guildId, title: next.title }, 'Prefetched next track');
      })
      .catch((error: unknown) => {
        log.debug(
          {
            guildId: this.guildId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Prefetch failed, will fetch on demand',
        );
      });
  }

  private takePreload(url: string): PreloadedStream | null {
    if (!this.preload) return null;
    if (this.preload.url !== url) {
      this.discardPreload();
      return null;
    }
    const ready = this.preload;
    this.preload = null;
    return ready;
  }

  private discardPreload(): void {
    this.preload?.stream.destroy();
    this.preload = null;
  }

  /** Rebuilds a dropped connection to the same channel, keeping the queue. */
  private async rejoin(): Promise<boolean> {
    const channel = this.lastChannel;
    if (!channel) return false;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        this.connection?.destroy();
        this.connection = null;
        await this.join(channel);
        log.info({ guildId: this.guildId, attempt }, 'Rejoined voice channel');
        return true;
      } catch (error) {
        log.info(
          {
            guildId: this.guildId,
            attempt,
            error: error instanceof Error ? error.message : String(error),
          },
          'Rejoin attempt failed',
        );
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
    return false;
  }

  async playPrevious(): Promise<boolean> {
    const previous = this.queue.previous();
    if (!previous) return false;
    await this.playTrack(previous);
    return true;
  }

  async playNext(): Promise<boolean> {
    const next = this.queue.next();
    if (!next) {
      this.queue.setCurrent(null);
      void this.panel.idle();
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
    this.discardPreload();
    this.queue.setCurrent(null);
    void this.panel.idle();
  }

  destroy(): void {
    this.stop();
    void this.panel.clear();
    this.connection?.destroy();
    this.connection = null;
    log.info({ guildId: this.guildId }, 'Music agent destroyed');
  }

  private setupPlayerEvents(): void {
    // Without this, a track that never reaches Playing is indistinguishable
    // from one that plays silently — the logs look identical either way.
    this.player.on('stateChange', (oldState, newState) => {
      if (oldState.status === newState.status) return;
      log.info(
        {
          guildId: this.guildId,
          from: oldState.status,
          to: newState.status,
          track: this.queue.nowPlaying?.title,
        },
        'Player state changed',
      );
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      this.playNext();
    });

    this.player.on('error', (error) => {
      log.error({ guildId: this.guildId, error: error.message }, 'Audio player error');
      const reason = explainErrorOr(error, 'The audio stream broke mid-track.');
      this.textChannel?.send({
        embeds: [
          errorEmbed(this.queue.length > 0 ? `${reason}\n\nSkipping to the next track.` : reason),
        ],
      });
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
