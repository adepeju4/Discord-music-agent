import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  type EmbedBuilder,
  type ButtonInteraction,
} from 'discord.js';
import { getOrCreateAgent, type MusicAgent } from '../agent/MusicAgent';
import {
  confidentCatalogMatch,
  normalizeText,
  plausibleMatch,
  resolveTrackIntents,
  type TrackIntent,
} from '../agent/resolveTracks';
import {
  addedToQueueEmbed,
  collectionEmbed,
  errorEmbed,
  infoEmbed,
  nowPlayingEmbed,
  type TrackInfo,
} from '../utils/embeds';
import { childLogger, createCorrelationId } from '../utils/logger';
import {
  resolveCallerVoiceChannel,
  missingVoicePermissions,
  NOT_IN_VOICE_MESSAGE,
} from '../utils/voiceState';
import type { SearchResult } from '../services/YouTubeService';
import { pickBestAudio } from '../services/YouTubeService';
import { parseSpotifyRef, SpotifyService, type SpotifyRef } from '../services/SpotifyService';
import {
  AppleMusicService,
  parseAppleMusicRef,
  type AppleMusicRef,
} from '../services/AppleMusicService';
import {
  parseYouTubePlaylistId,
  type AlbumSummary,
  type PlaylistSummary,
} from '../services/YouTubeMusicService';
import { videoIdFromUrl } from '../services/YouTubeService';
import { config } from '../config';
import { explainErrorOr } from '../utils/errors';

const log = childLogger({ module: 'cmd:play' });

// Resolution spawns a yt-dlp process per lookup. Once audio is flowing we back
// off so the import cannot starve the stream.
const IDLE_CONCURRENCY = 5;
const PLAYBACK_CONCURRENCY = 2;
const spotify = new SpotifyService();
const appleMusic = new AppleMusicService();

async function searchAndPick(
  agent: MusicAgent,
  query: string,
  intent: { title?: string; artist?: string; rawQuery?: string },
): Promise<SearchResult | null> {
  // Ask Spotify what the track actually is first. Its canonical title, artists
  // and duration turn the catalog lookup into an exact match instead of a
  // judgement call, which is how imports already behave.
  const canonical = await spotify.searchTrack(intent.title ?? query, intent.artist);
  const wanted: TrackIntent = { title: intent.title ?? query, artist: intent.artist ?? '' };
  const target = canonical && plausibleMatch(wanted, canonical) ? canonical : null;

  const candidates = await agent.youtubeService.searchCandidates(
    target ? `${target.title} ${target.artist}` : query,
  );
  if (candidates.length === 0) return null;

  if (target) {
    const exact = confidentCatalogMatch(candidates, target);
    if (exact) {
      log.debug({ query, picked: exact.title }, 'Strict catalog match');
      return exact;
    }
  }

  if (candidates.length === 1) return candidates[0];

  const llmPick = await agent.geminiAgent.pickBestSingle(
    intent,
    candidates.map((c) => ({
      title: c.title,
      channel: c.artist,
      duration: c.duration,
      album: c.album,
      source: c.source,
    })),
  );
  if (llmPick !== null) {
    log.debug({ query, pick: llmPick, title: candidates[llmPick].title }, 'LLM picked');
    return candidates[llmPick];
  }

  log.debug({ query }, 'LLM pick unavailable, using regex ranker');
  return pickBestAudio(candidates, intent.artist, query);
}

async function pickWithButtons(
  interaction: ChatInputCommandInteraction,
  embed: EmbedBuilder,
  labels: string[],
): Promise<{ index: number; pick: ButtonInteraction } | null> {
  const buttons = labels.slice(0, 5).map((label, i) =>
    new ButtonBuilder()
      .setCustomId(`pick_${i}`)
      .setLabel(label.length > 80 ? label.slice(0, 77) + '...' : label)
      .setStyle(ButtonStyle.Primary),
  );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
  const response = await interaction.editReply({ embeds: [embed], components: [row] });

  try {
    const pick = await response.awaitMessageComponent({
      componentType: ComponentType.Button,
      time: 30_000,
      filter: (i) => i.user.id === interaction.user.id,
    });
    return { index: parseInt(pick.customId.replace('pick_', ''), 10), pick };
  } catch (error) {
    log.debug(
      { error: error instanceof Error ? error.message : String(error) },
      'Button pick timed out',
    );
    await interaction.editReply({
      embeds: [infoEmbed('Timed Out', 'No selection made.')],
      components: [],
    });
    return null;
  }
}

async function queueSingle(
  interaction: ChatInputCommandInteraction,
  agent: MusicAgent,
  track: TrackInfo,
  position: number | undefined,
): Promise<void> {
  const landedAt =
    position !== undefined ? agent.queue.insert(track, position) : agent.queue.add(track);

  if (!agent.isActive) {
    await agent.playNext();
    await interaction.editReply({ embeds: [nowPlayingEmbed(track)], components: [] });
  } else {
    agent.prefetchNext();
    await interaction.editReply({ embeds: [addedToQueueEmbed(track, landedAt)], components: [] });
  }
}

function makeCollectionQueuer(agent: MusicAgent, position: number | undefined) {
  let queued = 0;
  let kicked = false;
  return {
    get queued() {
      return queued;
    },
    async add(track: TrackInfo): Promise<void> {
      if (position !== undefined) agent.queue.insert(track, position + queued);
      else agent.queue.add(track);
      queued++;
      if (!kicked && !agent.isActive) {
        kicked = true;
        await agent.playNext();
      } else if (queued === 1) {
        // First addition behind a playing track: start fetching it now so the
        // handover is seamless.
        agent.prefetchNext();
      }
    },
  };
}

async function queueCatalogTracks(
  interaction: ChatInputCommandInteraction,
  agent: MusicAgent,
  heading: string,
  tracks: SearchResult[],
  position: number | undefined,
  options: { note?: string; footer?: string; thumbnail?: string } = {},
): Promise<number> {
  const queuer = makeCollectionQueuer(agent, position);
  for (const sr of tracks) {
    await queuer.add(agent.youtubeService.toTrackInfo(sr, interaction.user.displayName));
  }

  await interaction.editReply({
    embeds: [
      collectionEmbed(heading, tracks, {
        note: options.note ?? `Queued ${queuer.queued} tracks.`,
        footer: options.footer ?? `Requested by ${interaction.user.displayName}`,
        thumbnail: options.thumbnail,
      }),
    ],
    components: [],
  });
  return queuer.queued;
}

async function importTrackIntents(
  interaction: ChatInputCommandInteraction,
  agent: MusicAgent,
  heading: string,
  intents: TrackIntent[],
  position: number | undefined,
  options: { total: number; footer: string; sourceLabel: string },
): Promise<{ resolved: number; failed: number }> {
  const truncated =
    options.total > intents.length
      ? `Showing the first ${intents.length} of ${options.total} tracks.`
      : undefined;

  await interaction.editReply({
    embeds: [
      collectionEmbed(heading, intents, {
        note: [`Importing from ${options.sourceLabel}…`, truncated].filter(Boolean).join(' '),
        footer: `${intents.length} tracks • matching against the YouTube Music catalog`,
      }),
    ],
    components: [],
  });

  const queuer = makeCollectionQueuer(agent, position);
  const { resolved, failed } = await resolveTrackIntents(
    agent.youtubeService,
    agent.geminiAgent,
    intents,
    interaction.user.displayName,
    (track) => queuer.add(track),
    {
      lookup: spotify,
      concurrency: () => (agent.isActive ? PLAYBACK_CONCURRENCY : IDLE_CONCURRENCY),
    },
  );

  const summary =
    failed > 0
      ? `Queued ${resolved}/${intents.length} tracks (${failed} not found).`
      : `Queued ${resolved} tracks.`;
  await interaction.editReply({
    embeds: [
      collectionEmbed(heading, intents, {
        note: [summary, truncated].filter(Boolean).join(' '),
        footer: options.footer,
      }),
    ],
    components: [],
  });

  return { resolved, failed };
}

async function resolveSingleIntent(
  interaction: ChatInputCommandInteraction,
  agent: MusicAgent,
  intent: TrackIntent,
  position: number | undefined,
): Promise<void> {
  let picked: TrackInfo | null = null;
  await resolveTrackIntents(
    agent.youtubeService,
    agent.geminiAgent,
    [intent],
    interaction.user.displayName,
    (track) => {
      picked = track;
    },
    { lookup: spotify },
  );
  if (!picked) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          `Couldn't find **${intent.title}** by ${intent.artist} on YouTube. It may not be available in this region.`,
        ),
      ],
    });
    return;
  }
  await queueSingle(interaction, agent, picked, position);
}

async function handleAppleMusic(
  interaction: ChatInputCommandInteraction,
  agent: MusicAgent,
  ref: AppleMusicRef,
  position: number | undefined,
  correlationId: string,
): Promise<void> {
  let collection;
  try {
    collection = await appleMusic.resolve(ref, config.MAX_IMPORT_SIZE);
  } catch (error) {
    log.error(
      { correlationId, ref, error: error instanceof Error ? error.message : String(error) },
      'Apple Music resolve failed',
    );
    await interaction.editReply({
      embeds: [
        errorEmbed(
          explainErrorOr(
            error,
            "Couldn't read that Apple Music link. Check that it opens in a browser without signing in — personal library links won't work.",
          ),
        ),
      ],
    });
    return;
  }

  if (collection.tracks.length === 0) {
    await interaction.editReply({ embeds: [errorEmbed('That Apple Music link has no tracks.')] });
    return;
  }

  if (collection.kind === 'song') {
    await resolveSingleIntent(interaction, agent, collection.tracks[0], position);
    return;
  }

  const heading = `${collection.kind === 'album' ? 'Album' : 'Playlist'}: ${collection.name}`;
  const { resolved, failed } = await importTrackIntents(
    interaction,
    agent,
    heading,
    collection.tracks,
    position,
    {
      total: collection.tracks.length,
      sourceLabel: 'Apple Music',
      footer: `Apple Music • Requested by ${interaction.user.displayName}`,
    },
  );
  log.info({ correlationId, ref, resolved, failed }, 'Apple Music import complete');
}

async function handleYouTubePlaylist(
  interaction: ChatInputCommandInteraction,
  agent: MusicAgent,
  playlistId: string,
  position: number | undefined,
  correlationId: string,
): Promise<void> {
  const playlist = await agent.youtubeService.music.getPlaylistTracks(
    playlistId,
    config.MAX_IMPORT_SIZE,
  );
  if (!playlist) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          "Couldn't load that playlist. It has to be public, and unlisted mixes tied to a session (links starting `RD`) can't be opened.",
        ),
      ],
    });
    return;
  }

  const queued = await queueCatalogTracks(
    interaction,
    agent,
    `Playlist: ${playlist.title}`,
    playlist.tracks,
    position,
    {
      footer: `${playlist.author ? `${playlist.author} • ` : ''}Requested by ${interaction.user.displayName}`,
      thumbnail: playlist.thumbnail,
    },
  );
  log.info({ correlationId, playlistId, queued }, 'YouTube playlist queued');
}

async function handleRadio(
  interaction: ChatInputCommandInteraction,
  agent: MusicAgent,
  request: { seed: string; message: string },
  position: number | undefined,
  correlationId: string,
): Promise<void> {
  const nowPlaying = agent.queue.nowPlaying;
  const seedText = request.seed?.trim() ?? '';
  let seedId: string | null = null;
  let seedLabel = seedText;

  const seedMatchesCurrent =
    nowPlaying &&
    (seedText.length === 0 ||
      normalizeText(seedText).includes(normalizeText(nowPlaying.title)) ||
      normalizeText(nowPlaying.title).includes(normalizeText(seedText)));

  if (seedMatchesCurrent && nowPlaying) {
    seedId = videoIdFromUrl(nowPlaying.url);
    seedLabel = `${nowPlaying.title}${nowPlaying.artist ? ` — ${nowPlaying.artist}` : ''}`;
  }

  if (!seedId && seedText) {
    const seedTrack = await searchAndPick(agent, seedText, { rawQuery: seedText });
    if (seedTrack) {
      seedId = videoIdFromUrl(seedTrack.url);
      seedLabel = `${seedTrack.title}${seedTrack.artist ? ` — ${seedTrack.artist}` : ''}`;
    }
  }

  if (!seedId) {
    await interaction.editReply({
      embeds: [errorEmbed(`Couldn't find anything to build a station from "${seedText}".`)],
    });
    return;
  }

  await interaction.editReply({
    embeds: [infoEmbed('Building station…', `Based on **${seedLabel}**`)],
    components: [],
  });

  const radio = await agent.youtubeService.music.getRadio(seedId, config.MAX_RADIO_SIZE + 1);
  const tracks = radio
    .filter((t) => !(nowPlaying && t.url === nowPlaying.url))
    .slice(0, config.MAX_RADIO_SIZE);

  if (tracks.length === 0) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          `Couldn't build a station from **${seedLabel}**. The catalog has no related tracks for it — this happens with live sets, mixes and uploads that aren't in the music catalog.`,
        ),
      ],
      components: [],
    });
    return;
  }

  const queued = await queueCatalogTracks(
    interaction,
    agent,
    `Station: ${seedLabel}`,
    tracks,
    position,
    {
      note: `${request.message}\n\nQueued ${tracks.length} tracks.`,
      footer: `Radio from the YouTube Music catalog • Requested by ${interaction.user.displayName}`,
      thumbnail: tracks[0]?.thumbnail,
    },
  );
  log.info({ correlationId, seedId, queued }, 'Radio queued');
}

async function handleCurated(
  interaction: ChatInputCommandInteraction,
  agent: MusicAgent,
  request: { theme: string; message: string },
  position: number | undefined,
  correlationId: string,
): Promise<void> {
  const found = await agent.youtubeService.music.searchPlaylists(request.theme, 5);
  if (found.length === 0) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          `Couldn't find a playlist for **${request.theme}**.\n\nTry a broader vibe (\`chill afrobeats\`, \`90s r&b\`), or \`/playlist ${request.theme}\` to have one built from scratch.`,
        ),
      ],
    });
    return;
  }

  let chosen: PlaylistSummary | null = found.length === 1 ? found[0] : null;
  if (!chosen) {
    const picked = await pickWithButtons(
      interaction,
      infoEmbed(
        'Pick a playlist',
        `${request.message}\n\n${found
          .map((p, i) => `\`${i + 1}.\` **${p.title}**${p.author ? ` — ${p.author}` : ''}`)
          .join('\n')}`,
      ),
      found.map((p) => p.title),
    );
    if (!picked) return;
    chosen = found[picked.index];
    await picked.pick.update({
      embeds: [infoEmbed('Loading playlist…', `**${chosen.title}**`)],
      components: [],
    });
  }

  const playlist = await agent.youtubeService.music.getPlaylistTracks(
    chosen.id,
    config.MAX_IMPORT_SIZE,
  );
  if (!playlist) {
    await interaction.editReply({
      embeds: [errorEmbed(`Couldn't load **${chosen.title}**.`)],
      components: [],
    });
    return;
  }

  const queued = await queueCatalogTracks(
    interaction,
    agent,
    `Playlist: ${playlist.title}`,
    playlist.tracks,
    position,
    {
      footer: `${chosen.author ? `${chosen.author} • ` : ''}Requested by ${interaction.user.displayName}`,
      thumbnail: chosen.thumbnail ?? playlist.thumbnail,
    },
  );
  log.info({ correlationId, playlistId: chosen.id, queued }, 'Curated playlist queued');
}

/** Several named tracks, or a themed set Gemini built itself. */
async function handleTrackList(
  interaction: ChatInputCommandInteraction,
  agent: MusicAgent,
  request: { message: string; tracks: Array<{ title: string; artist: string }> },
  position: number | undefined,
  correlationId: string,
): Promise<void> {
  const intents: TrackIntent[] = (request.tracks ?? [])
    .filter((t) => t?.title)
    .slice(0, config.MAX_IMPORT_SIZE);

  if (intents.length === 0) {
    await interaction.editReply({
      embeds: [
        errorEmbed("I couldn't work out which tracks you meant. Try naming them one by one."),
      ],
    });
    return;
  }

  if (intents.length === 1) {
    await resolveSingleIntent(interaction, agent, intents[0], position);
    return;
  }

  const { resolved, failed } = await importTrackIntents(
    interaction,
    agent,
    request.message || `${intents.length} tracks`,
    intents,
    position,
    {
      total: intents.length,
      sourceLabel: 'your request',
      footer: `Requested by ${interaction.user.displayName}`,
    },
  );
  log.info({ correlationId, resolved, failed }, 'Track list queued');
}

async function handleSpotify(
  interaction: ChatInputCommandInteraction,
  agent: MusicAgent,
  ref: SpotifyRef,
  position: number | undefined,
  correlationId: string,
): Promise<void> {
  if (!spotify.isConfigured) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          'Spotify links are not enabled on this bot. Set `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in `.env` to turn them on.',
        ),
      ],
    });
    return;
  }

  let collection;
  try {
    collection = await spotify.resolve(ref);
  } catch (error) {
    log.error(
      { correlationId, ref, error: error instanceof Error ? error.message : String(error) },
      'Spotify resolve failed',
    );
    await interaction.editReply({
      embeds: [
        errorEmbed(
          explainErrorOr(
            error,
            "Couldn't read that Spotify link. Private playlists can't be opened — make it public, or paste an Apple Music or YouTube Music link instead.",
          ),
        ),
      ],
    });
    return;
  }

  const intents: TrackIntent[] = collection.tracks;
  if (intents.length === 0) {
    await interaction.editReply({ embeds: [errorEmbed('That Spotify link has no tracks.')] });
    return;
  }

  if (collection.type === 'track') {
    await resolveSingleIntent(interaction, agent, intents[0], position);
    return;
  }

  const heading = `${collection.type === 'album' ? 'Album' : 'Playlist'}: ${collection.name}`;
  const { resolved, failed } = await importTrackIntents(
    interaction,
    agent,
    heading,
    intents,
    position,
    {
      total: collection.total,
      sourceLabel: 'Spotify',
      footer: `${collection.owner ? `by ${collection.owner} • ` : ''}Requested by ${interaction.user.displayName}`,
    },
  );
  log.info({ correlationId, ref, resolved, failed }, 'Spotify import complete');
}

function albumLabel(a: AlbumSummary): string {
  return a.year ? `${a.title} (${a.year})` : a.title;
}

async function handleAlbum(
  interaction: ChatInputCommandInteraction,
  agent: MusicAgent,
  request: { artist: string; album?: string | null; message: string },
  position: number | undefined,
  correlationId: string,
): Promise<void> {
  const music = agent.youtubeService.music;
  const query = [request.album, request.artist].filter(Boolean).join(' ');
  const found = await music.searchAlbums(query, 8);
  const wantArtist = normalizeText(request.artist);
  const byArtist = found.filter((a) => normalizeText(a.artist ?? '').includes(wantArtist));
  const albums = (byArtist.length > 0 ? byArtist : found).slice(0, 5);

  if (albums.length === 0) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          `Couldn't find an album by **${request.artist}** in the music catalog.\n\nSingles and features won't show up here — try \`/play <song> <artist>\` for those.`,
        ),
      ],
    });
    return;
  }

  let chosen: AlbumSummary | null = null;
  if (request.album) {
    const want = normalizeText(request.album);
    chosen =
      albums.find((a) => normalizeText(a.title) === want) ??
      albums.find((a) => normalizeText(a.title).includes(want)) ??
      null;
  }
  if (!chosen && albums.length === 1) chosen = albums[0];

  if (!chosen) {
    const picked = await pickWithButtons(
      interaction,
      infoEmbed(
        'Which album?',
        `${request.message}\n\n${albums.map((a, i) => `\`${i + 1}.\` ${albumLabel(a)}`).join('\n')}`,
      ),
      albums.map((a) => `${a.title}${a.year ? ` (${a.year})` : ''}`),
    );
    if (!picked) return;
    chosen = albums[picked.index];
    await picked.pick.update({
      embeds: [
        infoEmbed(
          'Loading album…',
          `**${albumLabel(chosen)}** by ${chosen.artist ?? request.artist}`,
        ),
      ],
      components: [],
    });
  }

  const album = await music.getAlbum(chosen);
  if (!album || album.tracks.length === 0) {
    await interaction.editReply({
      embeds: [errorEmbed(`Couldn't load **${chosen.title}**.`)],
      components: [],
    });
    return;
  }

  const tracks = album.tracks.slice(0, config.MAX_IMPORT_SIZE);
  const queuer = makeCollectionQueuer(agent, position);
  for (const sr of tracks) {
    await queuer.add(agent.youtubeService.toTrackInfo(sr, interaction.user.displayName));
  }

  log.info({ correlationId, albumId: album.id, queued: queuer.queued }, 'Album queued');

  await interaction.editReply({
    embeds: [
      collectionEmbed(`Album: ${album.title}`, tracks, {
        note: `Queued ${queuer.queued} tracks.`,
        footer: `${[album.artist, album.subtitle].filter(Boolean).join(' • ')} • Requested by ${interaction.user.displayName}`,
        thumbnail: album.thumbnail,
      }),
    ],
    components: [],
  });
}

export const data = new SlashCommandBuilder()
  .setName('play')
  .setDescription('Play a song, album, playlist link, station, or vibe — Gemini works it out')
  .addStringOption((opt) =>
    opt
      .setName('query')
      .setDescription('Song, vibe, album, "songs like X", or a YouTube/Spotify/Apple Music link')
      .setRequired(true),
  )
  .addIntegerOption((opt) =>
    opt
      .setName('insert_at')
      .setDescription(
        'Insert this NEW track at slot N (1 = play next). To jump in the queue use /jump.',
      )
      .setMinValue(1)
      .setRequired(false),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  const correlationId = createCorrelationId();
  const query = interaction.options.getString('query', true);
  const position = interaction.options.getInteger('insert_at') ?? undefined;

  const voiceChannel = resolveCallerVoiceChannel(interaction);
  if (!voiceChannel) {
    await interaction.reply({
      embeds: [errorEmbed(NOT_IN_VOICE_MESSAGE)],
      ephemeral: true,
    });
    return;
  }

  if (voiceChannel.type !== 2) {
    await interaction.reply({
      embeds: [errorEmbed('I can only play music in voice channels!')],
      ephemeral: true,
    });
    return;
  }

  const missingPermissions = missingVoicePermissions(voiceChannel);
  if (missingPermissions.length > 0) {
    await interaction.reply({
      embeds: [
        errorEmbed(
          `I can't play in **${voiceChannel.name}** — I'm missing: ${missingPermissions.join(', ')}.\n\n` +
            'Give my role those permissions on that channel (or on the server) and try again.',
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  const guildId = interaction.guildId!;
  const agent = getOrCreateAgent(guildId);
  agent.textChannel = interaction.channel as import('discord.js').TextChannel;

  try {
    await agent.join(voiceChannel);
  } catch (error) {
    log.error(
      { correlationId, guildId, error: error instanceof Error ? error.message : String(error) },
      'Failed to join voice channel',
    );
    await interaction.editReply({
      embeds: [
        errorEmbed(
          `Couldn't connect to **${voiceChannel.name}**. If it's a private or user-limited channel, check that my role can join it.`,
        ),
      ],
    });
    return;
  }

  log.info({ correlationId, query, position, guildId }, 'Processing play request');

  const spotifyRef = parseSpotifyRef(query);
  if (spotifyRef) {
    await handleSpotify(interaction, agent, spotifyRef, position, correlationId);
    return;
  }

  const appleRef = parseAppleMusicRef(query);
  if (appleRef) {
    await handleAppleMusic(interaction, agent, appleRef, position, correlationId);
    return;
  }

  const playlistId = parseYouTubePlaylistId(query);
  if (playlistId) {
    await handleYouTubePlaylist(interaction, agent, playlistId, position, correlationId);
    return;
  }

  const geminiResult = await agent.geminiAgent.interpret(query, {
    nowPlaying: agent.queue.nowPlaying,
    queueLength: agent.queue.length,
  });

  if (geminiResult.action === 'reject') {
    await interaction.editReply({ embeds: [errorEmbed(geminiResult.message)] });
    return;
  }

  if (geminiResult.action === 'album') {
    await handleAlbum(interaction, agent, geminiResult, position, correlationId);
    return;
  }

  if (geminiResult.action === 'radio') {
    await handleRadio(interaction, agent, geminiResult, position, correlationId);
    return;
  }

  if (geminiResult.action === 'curated') {
    await handleCurated(interaction, agent, geminiResult, position, correlationId);
    return;
  }

  if (geminiResult.action === 'playlist') {
    await handleTrackList(interaction, agent, geminiResult, position, correlationId);
    return;
  }

  if (geminiResult.action === 'clarify' || geminiResult.action === 'suggest') {
    const embed = infoEmbed(
      geminiResult.action === 'clarify' ? 'Which one?' : 'Suggestions',
      geminiResult.message,
    );
    const picked = await pickWithButtons(interaction, embed, geminiResult.suggestions);
    if (!picked) return;

    const selectedQuery = geminiResult.suggestions[picked.index];
    await picked.pick.update({
      embeds: [infoEmbed('Searching...', `Looking for **${selectedQuery}**`)],
      components: [],
    });

    const result = await searchAndPick(agent, selectedQuery, { rawQuery: selectedQuery });
    if (!result) {
      await interaction.editReply({
        embeds: [
          errorEmbed(
            `No results for **${selectedQuery}**.\n\nTry the artist name with the song title, or paste a link.`,
          ),
        ],
        components: [],
      });
      return;
    }

    await queueSingle(
      interaction,
      agent,
      agent.youtubeService.toTrackInfo(result, interaction.user.displayName),
      position,
    );
    return;
  }

  if (geminiResult.action !== 'play') return;

  const result = await searchAndPick(agent, geminiResult.query, { rawQuery: query });
  if (!result) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          `No results for **${geminiResult.query}**.\n\nTry the artist name with the song title, or paste a link.`,
        ),
      ],
    });
    return;
  }

  await queueSingle(
    interaction,
    agent,
    agent.youtubeService.toTrackInfo(result, interaction.user.displayName),
    position,
  );
}
