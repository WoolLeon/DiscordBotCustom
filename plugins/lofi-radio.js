/**
 * lofi-radio.js — Lofi / Chill Internet Radio Plugin
 *
 * Streams audio directly from HTTP radio endpoints — no YouTube, no geo-block.
 * Works reliably on Vietnamese ISPs (Viettel, VNPT, FPT) and minimal servers.
 *
 * Commands: !lofi [station], !lofi-stop, !lofi-list, !lofi-stations
 * Slash:    /lofi, /lofi-stop, /lofi-stations
 */

import {
    ApplicationCommandOptionType,
    EmbedBuilder,
} from 'discord.js';
import {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    NoSubscriberBehavior,
    VoiceConnectionStatus,
    entersState,
    getVoiceConnection,
    StreamType,
} from '@discordjs/voice';

// ─── Station Catalog ──────────────────────────────────────────────────────────
// All streams are reliable HTTP/HTTPS Icecast / SHOUTcast / Azuracast endpoints.
// Multiple fallback URLs are provided per station for resilience.
// These are public, free-to-air streams — no auth required.
export const LOFI_STATIONS = {
    lofi: {
        label: '☁️ Lofi Hip-Hop',
        emoji: '☁️',
        color: '#7289DA',
        genre: 'Lofi Hip-Hop',
        urls: [
            'https://streams.ilovemusic.de/iloveradio17.mp3',
            'https://stream.0nlineradio.com/lofi-hip-hop',
            'https://radio.plaza.one/mp3',
        ],
        thumbnail: 'https://i.imgur.com/fJ8abfj.png',
        description: 'Classic lofi hip-hop beats to relax and study to.',
    },
    chill: {
        label: '🌙 Chill Vibes',
        emoji: '🌙',
        color: '#4B6FA8',
        genre: 'Chill / Ambient',
        urls: [
            'https://streams.ilovemusic.de/iloveradio2.mp3',
            'https://live.laut.fm/chillout',
        ],
        thumbnail: 'https://i.imgur.com/fJ8abfj.png',
        description: 'Chill ambient vibes for late-night coding sessions.',
    },
    jazz: {
        label: '🎷 Jazz Coffee',
        emoji: '🎷',
        color: '#C5A028',
        genre: 'Jazz',
        urls: [
            'https://streams.ilovemusic.de/iloveradio21.mp3',
            'https://live.laut.fm/jazzy-vibes',
            'https://streaming.radio.co/s2e3b2d3b7/listen',
        ],
        thumbnail: 'https://i.imgur.com/fJ8abfj.png',
        description: 'Smooth jazz for coffee-fueled productivity.',
    },
    synthwave: {
        label: '🌊 Synthwave',
        emoji: '🌊',
        color: '#FF2281',
        genre: 'Synthwave / Retrowave',
        urls: [
            'https://streams.ilovemusic.de/iloveradio24.mp3',
            'https://live.laut.fm/synthwave',
        ],
        thumbnail: 'https://i.imgur.com/fJ8abfj.png',
        description: 'Retro 80s synthwave. Drive into the neon sunset.',
    },
    classical: {
        label: '🎻 Classical Focus',
        emoji: '🎻',
        color: '#D4A373',
        genre: 'Classical',
        urls: [
            'https://strm112.1.fm/classical_mobile_mp3',
            'https://streams.ilovemusic.de/iloveradio20.mp3',
        ],
        thumbnail: 'https://i.imgur.com/fJ8abfj.png',
        description: 'Classical compositions for deep focus work.',
    },
    nature: {
        label: '🌿 Nature Sounds',
        emoji: '🌿',
        color: '#52B788',
        genre: 'Ambient / Nature',
        urls: [
            'https://streams.ilovemusic.de/iloveradio7.mp3',
            'https://live.laut.fm/ambient',
        ],
        thumbnail: 'https://i.imgur.com/fJ8abfj.png',
        description: 'Peaceful nature ambience. Forest, rain & ocean.',
    },
    piano: {
        label: '🎹 Piano Dreams',
        emoji: '🎹',
        color: '#E2C98B',
        genre: 'Piano / Instrumental',
        urls: [
            'https://streams.ilovemusic.de/iloveradio16.mp3',
            'https://live.laut.fm/piano',
        ],
        thumbnail: 'https://i.imgur.com/fJ8abfj.png',
        description: 'Soft piano melodies. Perfect for study & relaxation.',
    },
    rock: {
        label: '🎸 Indie Rock',
        emoji: '🎸',
        color: '#E63946',
        genre: 'Indie / Alternative',
        urls: [
            'https://streams.ilovemusic.de/iloveradio11.mp3',
            'https://live.laut.fm/indie',
        ],
        thumbnail: 'https://i.imgur.com/fJ8abfj.png',
        description: 'Indie rock & alternative hits.',
    },
    electronic: {
        label: '⚡ Electronic',
        emoji: '⚡',
        color: '#00BFFF',
        genre: 'Electronic / EDM',
        urls: [
            'https://streams.ilovemusic.de/iloveradio1.mp3',
            'https://live.laut.fm/electronic',
        ],
        thumbnail: 'https://i.imgur.com/fJ8abfj.png',
        description: 'Electronic beats and EDM bangers.',
    },
    kpop: {
        label: '🌸 K-Pop',
        emoji: '🌸',
        color: '#FF69B4',
        genre: 'K-Pop',
        urls: [
            'https://streams.ilovemusic.de/iloveradio23.mp3',
            'https://live.laut.fm/kpop',
        ],
        thumbnail: 'https://i.imgur.com/fJ8abfj.png',
        description: 'Non-stop K-Pop hits.',
    },
    viet: {
        label: '🇻🇳 Nhạc Việt',
        emoji: '🇻🇳',
        color: '#DA291C',
        genre: 'Vietnamese Pop',
        urls: [
            'http://stream.zeno.fm/0r0xa792kwzuv',  // Nhạc Việt
            'http://stream.zeno.fm/p6fc4sy5fzzuv',  // VOVTV Music
        ],
        thumbnail: 'https://i.imgur.com/fJ8abfj.png',
        description: 'Nhạc pop Việt Nam sôi động.',
    },
    nhac_vang: {
        label: '🎶 Nhạc Vàng',
        emoji: '🎶',
        color: '#FFD700',
        genre: 'Vietnamese Oldies',
        urls: [
            'http://stream.zeno.fm/fn3a9tpafzzuv',
            'http://stream.zeno.fm/yn65fsygvhzuv',
        ],
        thumbnail: 'https://i.imgur.com/fJ8abfj.png',
        description: 'Nhạc vàng, nhạc bolero Việt Nam.',
    },
};

const DEFAULT_STATION = 'lofi';

// ─── Active radio sessions per guild ─────────────────────────────────────────
const activeRadios = new Map(); // guildId → { player, connection, stationKey, vcId, textChId }

// ─── Helpers ──────────────────────────────────────────────────────────────────

const getVoiceChannel = (ctx) => ctx.member?.voice?.channel;
const isSlashCtx = (ctx) => typeof ctx.isChatInputCommand === 'function' && ctx.isChatInputCommand();

async function tryStreamUrl(url) {
    // Test each URL, return the first that doesn't immediately fail
    return new Promise((resolve) => {
        // We can't do a HEAD request easily in ESM without fetch or http,
        // so we just trust the list and let ffmpeg handle errors gracefully.
        resolve(url);
    });
}

async function getWorkingUrl(urls) {
    for (const url of urls) {
        try {
            // Use native fetch (available in Node 18+) to test connectivity
            if (typeof fetch !== 'undefined') {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 5000);
                const resp = await fetch(url, { method: 'GET', signal: ctrl.signal, headers: { Range: 'bytes=0-0' } });
                clearTimeout(timer);
                if (resp.ok || resp.status === 206 || resp.status === 200) return url;
            } else {
                return url; // fallback: just use first URL
            }
        } catch {
            console.warn(`[lofi-radio] URL unreachable: ${url}`);
        }
    }
    return urls[0]; // last resort
}

function buildNowPlayingEmbed(station, stationKey) {
    return new EmbedBuilder()
        .setColor(station.color)
        .setTitle(`${station.emoji} Now Streaming — ${station.label}`)
        .setDescription(station.description)
        .addFields(
            { name: '🎵 Genre', value: station.genre, inline: true },
            { name: '📡 Station', value: stationKey, inline: true },
            { name: '⌨️ Stop', value: '`!lofi-stop`', inline: true },
        )
        .setFooter({ text: 'Lofi Radio • 24/7 streaming' })
        .setTimestamp();
}

function buildStationListEmbed(accentColor = '#7289DA') {
    const entries = Object.entries(LOFI_STATIONS)
        .map(([key, s]) => `${s.emoji} **${key}** — ${s.label} *(${s.genre})*`)
        .join('\n');
    return new EmbedBuilder()
        .setColor(accentColor)
        .setTitle('📻 Available Radio Stations')
        .setDescription(entries)
        .setFooter({ text: 'Use !lofi <station> or /lofi station:<name>' })
        .setTimestamp();
}

async function startRadio(ctx, stationKey, isSlash) {
    const voiceCh = getVoiceChannel(ctx);
    if (!voiceCh) return ctx.reply('❌ Join a voice channel first.');

    const station = LOFI_STATIONS[stationKey];
    if (!station) {
        const keys = Object.keys(LOFI_STATIONS).join(', ');
        return ctx.reply(`❌ Unknown station. Available: \`${keys}\``);
    }

    // Stop existing session
    const existing = activeRadios.get(ctx.guild.id);
    if (existing) {
        existing.player.stop();
        const conn = getVoiceConnection(ctx.guild.id);
        if (conn) conn.destroy();
        activeRadios.delete(ctx.guild.id);
    }

    if (isSlash) await ctx.deferReply();

    try {
        const streamUrl = await getWorkingUrl(station.urls);
        console.log(`[lofi-radio] Starting station "${stationKey}" for guild ${ctx.guild.id} → ${streamUrl}`);

        const connection = joinVoiceChannel({
            channelId: voiceCh.id,
            guildId: voiceCh.guild.id,
            adapterCreator: voiceCh.guild.voiceAdapterCreator,
            selfDeaf: true,    // saves upstream bandwidth
            selfMute: false,
        });

        // Auto reconnect on packet loss (VN ISP resilience)
        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
                await Promise.race([
                    entersState(connection, VoiceConnectionStatus.Signalling, 10_000),
                    entersState(connection, VoiceConnectionStatus.Connecting, 10_000),
                ]);
            } catch {
                connection.destroy();
                activeRadios.delete(ctx.guild.id);
            }
        });

        await entersState(connection, VoiceConnectionStatus.Ready, 45_000);

        const player = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Play,
                maxMissedFrames: 1000, // tolerate packet loss
            },
        });

        const resource = createAudioResource(streamUrl, {
            inputType: StreamType.Arbitrary,  // raw HTTP stream → ffmpeg
            inlineVolume: true,
        });
        if (resource.volume) resource.volume.setVolume(0.8);

        connection.subscribe(player);
        player.play(resource);

        // Handle stream ending (rare but happens with Icecast reconnects)
        player.on(AudioPlayerStatus.Idle, async () => {
            const session = activeRadios.get(ctx.guild.id);
            if (!session) return;
            console.log(`[lofi-radio] Stream ended for guild ${ctx.guild.id}, restarting…`);
            try {
                const newUrl = await getWorkingUrl(station.urls);
                const newResource = createAudioResource(newUrl, {
                    inputType: StreamType.Arbitrary,
                    inlineVolume: true,
                });
                if (newResource.volume) newResource.volume.setVolume(session.volume ?? 0.8);
                player.play(newResource);
            } catch (err) {
                console.error('[lofi-radio] Failed to restart stream:', err.message);
                activeRadios.delete(ctx.guild.id);
            }
        });

        player.on('error', (err) => {
            console.error(`[lofi-radio] Player error in guild ${ctx.guild.id}:`, err.message);
        });

        activeRadios.set(ctx.guild.id, {
            player,
            connection,
            stationKey,
            vcId: voiceCh.id,
            textChId: ctx.channel?.id ?? ctx.channelId,
            volume: 0.8,
        });

        const embed = buildNowPlayingEmbed(station, stationKey);
        if (isSlash) {
            await ctx.editReply({ embeds: [embed] });
        } else {
            await ctx.reply({ embeds: [embed] });
        }
    } catch (err) {
        console.error('[lofi-radio] Failed to start:', err);
        const msg = `❌ Failed to start radio: ${err.message}`;
        if (isSlash) await ctx.editReply({ content: msg }).catch(() => {});
        else await ctx.reply(msg).catch(() => {});
    }
}

async function stopRadio(ctx, isSlash) {
    const session = activeRadios.get(ctx.guild.id);
    if (!session) return ctx.reply('ℹ️ No radio is playing.');

    session.player.stop();
    const conn = getVoiceConnection(ctx.guild.id);
    if (conn) conn.destroy();
    activeRadios.delete(ctx.guild.id);
    return ctx.reply('📻 Radio stopped. Thanks for listening!');
}

// ─── Plugin Export ────────────────────────────────────────────────────────────

export default {
    name: 'Lofi Radio',
    help: [
        { usage: '`!lofi [station]`', description: 'Start a lofi radio station in your voice channel. Default: `lofi`.' },
        { usage: '`!lofi-stop`', description: 'Stop the radio and disconnect.' },
        { usage: '`!lofi-list`', description: 'Show all available stations.' },
        { usage: '`/lofi`', description: 'Start radio via slash command with station picker.' },
        { usage: '`/lofi-stop`', description: 'Stop radio via slash command.' },
        { usage: '`/lofi-stations`', description: 'List all stations.' },
        { usage: 'Available stations:', description: Object.entries(LOFI_STATIONS).map(([k, s]) => `\`${k}\` — ${s.label}`).join(', ') },
    ],

    init: async () => {
        console.log('✅ Lofi Radio plugin initialized.');
        console.log(`   📻 ${Object.keys(LOFI_STATIONS).length} stations loaded.`);
    },

    commands: [
        // ─── !lofi / /lofi ───────────────────────────────────────────────────
        {
            name: 'lofi',
            description: 'Start a lofi radio station in your voice channel',
            options: [
                {
                    name: 'station',
                    description: 'Station name (lofi, chill, jazz, synthwave, viet, nhac_vang, ...)',
                    type: ApplicationCommandOptionType.String,
                    required: false,
                    choices: Object.entries(LOFI_STATIONS).slice(0, 25).map(([k, s]) => ({
                        name: `${s.emoji} ${s.label}`,
                        value: k,
                    })),
                },
            ],
            async execute(ctx, _db, isSlash, args) {
                const stationKey = isSlash
                    ? (ctx.options.getString('station') || DEFAULT_STATION)
                    : (args[0]?.toLowerCase() || DEFAULT_STATION);
                await startRadio(ctx, stationKey, isSlash);
            },
        },

        // ─── !lofi-stop / /lofi-stop ─────────────────────────────────────────
        {
            name: 'lofi-stop',
            description: 'Stop the lofi radio',
            async execute(ctx, _db, isSlash) {
                await stopRadio(ctx, isSlash);
            },
        },

        // ─── !lofi-list / /lofi-stations ─────────────────────────────────────
        {
            name: 'lofi-list',
            description: 'Show all available radio stations',
            async execute(ctx) {
                ctx.reply({ embeds: [buildStationListEmbed()] });
            },
        },
        {
            name: 'lofi-stations',
            description: 'Show all available radio stations',
            async execute(ctx) {
                ctx.reply({ embeds: [buildStationListEmbed()] });
            },
        },

        // ─── !lofi-volume ─────────────────────────────────────────────────────
        {
            name: 'lofi-volume',
            description: 'Set radio volume (0–100)',
            options: [
                {
                    name: 'level',
                    type: ApplicationCommandOptionType.Integer,
                    description: 'Volume 0–100',
                    required: true,
                },
            ],
            async execute(ctx, _db, isSlash, args) {
                const level = isSlash
                    ? ctx.options.getInteger('level')
                    : parseInt(args[0], 10);
                if (Number.isNaN(level) || level < 0 || level > 100) {
                    return ctx.reply('❌ Volume must be 0–100.');
                }
                const session = activeRadios.get(ctx.guild.id);
                if (!session) return ctx.reply('ℹ️ No radio is playing.');
                const vol = level / 100;
                session.volume = vol;
                const res = session.player.state?.resource;
                if (res?.volume) res.volume.setVolume(vol);
                ctx.reply(`🔊 Radio volume set to **${level}%**.`);
            },
        },

        // ─── !lofi-nowplaying ─────────────────────────────────────────────────
        {
            name: 'lofi-nowplaying',
            description: 'Show current radio station',
            async execute(ctx) {
                const session = activeRadios.get(ctx.guild.id);
                if (!session) return ctx.reply('ℹ️ No radio is playing.');
                const station = LOFI_STATIONS[session.stationKey];
                if (!station) return ctx.reply('ℹ️ No station info found.');
                ctx.reply({ embeds: [buildNowPlayingEmbed(station, session.stationKey)] });
            },
        },
    ],

    // Expose for dashboard use
    getActiveRadios: () => activeRadios,
    getStations: () => LOFI_STATIONS,
};
