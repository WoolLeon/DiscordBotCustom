import path from 'path';
import {
    ApplicationCommandOptionType,
    EmbedBuilder,
} from 'discord.js';
import play from 'play-dl';
import { resolveTracks } from '../lib/music/resolver.js';
import { getMusicQueue, destroyMusicQueue } from '../lib/music/queue.js';

const getVoiceChannel = (ctx) => ctx.member?.voice?.channel;
const isSlashCtx = (ctx) => typeof ctx.isChatInputCommand === 'function' && ctx.isChatInputCommand();

const getQuery = (ctx, isSlash, args) =>
    isSlash ? ctx.options.getString('query') : args.join(' ');

const queueEmbed = (queue, title = '📜 Music Queue') => {
    const lines = [];
    if (queue.current) {
        lines.push(`**Now:** ${queue.current.title} \`[${queue.current.durationLabel}]\``);
    }
    queue.songs.slice(0, 15).forEach((s, i) => {
        lines.push(`\`${i + 1}.\` ${s.title} — ${s.requester} \`[${s.durationLabel}]\``);
    });
    if (queue.songs.length > 15) lines.push(`… and ${queue.songs.length - 15} more`);
    return new EmbedBuilder()
        .setTitle(title)
        .setColor('#5865F2')
        .setDescription(lines.length ? lines.join('\n') : 'Queue is empty.');
};

export default {
    name: 'Music Player',
    help: [
        { usage: '`!play <url or search>`', description: 'Play YouTube, Spotify, or SoundCloud link / search query.' },
        { usage: '`!queue`', description: 'Show the current queue.' },
        { usage: '`!skip`', description: 'Skip the current song.' },
        { usage: '`!stop`', description: 'Stop playback and clear the queue.' },
        { usage: '`!pause` / `!resume`', description: 'Pause or resume playback.' },
        { usage: '`!nowplaying`', description: 'Show the song that is playing.' },
        { usage: '`!shuffle`', description: 'Shuffle the queue.' },
        { usage: '`!remove <#>`', description: 'Remove a song from the queue by position.' },
        { usage: '`!volume <0-100>`', description: 'Set playback volume.' },
        { usage: '`!leave`', description: 'Disconnect from voice.' },
    ],

    init: async () => {
        try {
            const ffmpegStatic = (await import('ffmpeg-static')).default;
            if (ffmpegStatic) {
                const dir = path.dirname(ffmpegStatic);
                process.env.PATH = `${dir}${path.delimiter}${process.env.PATH || ''}`;
            }
        } catch {
            console.warn('[music] ffmpeg-static not found — ensure ffmpeg is on PATH.');
        }

        if (process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET) {
            try {
                await play.setToken({
                    spotify: {
                        client_id: process.env.SPOTIFY_CLIENT_ID,
                        client_secret: process.env.SPOTIFY_CLIENT_SECRET,
                    },
                });
                console.log('✅ Music: Spotify API configured.');
            } catch (err) {
                console.warn('[music] Spotify token setup failed:', err.message);
            }
        } else {
            console.log('ℹ️ Music: Set SPOTIFY_CLIENT_ID/SECRET in .env for Spotify links.');
        }

        console.log('✅ Music Player initialized.');
    },

    commands: [
        {
            name: 'play',
            description: 'Play a song from YouTube, Spotify, or SoundCloud',
            options: [
                {
                    name: 'query',
                    description: 'URL or search terms',
                    type: ApplicationCommandOptionType.String,
                    required: true,
                },
            ],
            async execute(ctx, _db, isSlash, args) {
                const voice = getVoiceChannel(ctx);
                if (!voice) return ctx.reply('❌ Join a voice channel first.');

                const query = getQuery(ctx, isSlash, args);
                if (!query?.trim()) return ctx.reply('❌ Provide a URL or search query.');

                const requester = ctx.member?.displayName || ctx.author.username;
                const slash = isSlashCtx(ctx);
                let loadingMsg;
                if (slash) await ctx.deferReply();
                else loadingMsg = await ctx.reply('🔍 Searching…');

                const sendResult = async (payload) => {
                    if (slash) await ctx.editReply(payload);
                    else await loadingMsg.edit(payload);
                };

                try {
                    const tracks = await resolveTracks(query, requester);
                    const queue = getMusicQueue(ctx.guild.id);
                    const wasPlaying = queue.playing;
                    await queue.addAndPlay(voice, ctx.channel.id, tracks);

                    const embed = new EmbedBuilder()
                        .setColor('#57F287')
                        .setTitle(wasPlaying ? '➕ Added to Queue' : '▶️ Playback Started')
                        .setDescription(
                            tracks.length === 1
                                ? `**${tracks[0].title}**`
                                : `**${tracks.length}** tracks added.`,
                        );
                    if (tracks[0].thumbnail) embed.setThumbnail(tracks[0].thumbnail);
                    await sendResult({ content: null, embeds: [embed] });
                } catch (err) {
                    await sendResult({ content: `❌ ${err.message}`, embeds: [] });
                }
            },
        },
        {
            name: 'queue',
            description: 'Show the music queue',
            async execute(ctx) {
                const queue = getMusicQueue(ctx.guild.id);
                if (!queue.current && !queue.songs.length) {
                    return ctx.reply('ℹ️ Nothing in the queue.');
                }
                ctx.reply({ embeds: [queueEmbed(queue)] });
            },
        },
        {
            name: 'skip',
            description: 'Skip the current song',
            async execute(ctx) {
                const queue = getMusicQueue(ctx.guild.id);
                if (!queue.playing && !queue.current) return ctx.reply('ℹ️ Nothing is playing.');
                queue.skip();
                ctx.reply('⏭️ Skipped.');
            },
        },
        {
            name: 'stop',
            description: 'Stop music and clear the queue',
            async execute(ctx) {
                destroyMusicQueue(ctx.guild.id);
                ctx.reply('⏹️ Stopped and cleared queue.');
            },
        },
        {
            name: 'pause',
            description: 'Pause playback',
            async execute(ctx) {
                const queue = getMusicQueue(ctx.guild.id);
                if (!queue.playing) return ctx.reply('ℹ️ Nothing is playing.');
                queue.pause();
                ctx.reply('⏸️ Paused.');
            },
        },
        {
            name: 'resume',
            description: 'Resume playback',
            async execute(ctx) {
                const queue = getMusicQueue(ctx.guild.id);
                if (!queue.playing) return ctx.reply('ℹ️ Nothing to resume.');
                queue.resume();
                ctx.reply('▶️ Resumed.');
            },
        },
        {
            name: 'nowplaying',
            description: 'Show current song',
            async execute(ctx) {
                const queue = getMusicQueue(ctx.guild.id);
                const t = queue.current;
                if (!t) return ctx.reply('ℹ️ Nothing is playing.');
                const embed = new EmbedBuilder()
                    .setColor('#1DB954')
                    .setTitle('🎵 Now Playing')
                    .setDescription(`**[${t.title}](${t.url})**`)
                    .addFields(
                        { name: 'Duration', value: t.durationLabel, inline: true },
                        { name: 'Source', value: t.source, inline: true },
                        { name: 'Requested by', value: t.requester, inline: true },
                    );
                if (t.thumbnail) embed.setThumbnail(t.thumbnail);
                ctx.reply({ embeds: [embed] });
            },
        },
        {
            name: 'shuffle',
            description: 'Shuffle the queue',
            async execute(ctx) {
                const queue = getMusicQueue(ctx.guild.id);
                if (!queue.songs.length) return ctx.reply('ℹ️ Queue is empty.');
                queue.shuffle();
                ctx.reply('🔀 Queue shuffled.');
            },
        },
        {
            name: 'remove',
            description: 'Remove a track from the queue',
            options: [
                {
                    name: 'position',
                    type: ApplicationCommandOptionType.Integer,
                    description: 'Queue position (1 = next up)',
                    required: true,
                },
            ],
            async execute(ctx, _db, isSlash, args) {
                const pos = isSlash
                    ? ctx.options.getInteger('position')
                    : parseInt(args[0], 10);
                if (!pos || pos < 1) return ctx.reply('❌ Provide a valid queue number.');
                const queue = getMusicQueue(ctx.guild.id);
                const removed = queue.removeAt(pos - 1);
                if (!removed) return ctx.reply('❌ No track at that position.');
                ctx.reply(`🗑️ Removed **${removed.title}** from the queue.`);
            },
        },
        {
            name: 'volume',
            description: 'Set volume (0–100)',
            options: [
                {
                    name: 'level',
                    type: ApplicationCommandOptionType.Integer,
                    description: 'Volume percent',
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
                const queue = getMusicQueue(ctx.guild.id);
                queue.setVolume(level);
                ctx.reply(`🔊 Volume set to **${level}%**.`);
            },
        },
        {
            name: 'leave',
            description: 'Disconnect from voice',
            async execute(ctx) {
                destroyMusicQueue(ctx.guild.id);
                ctx.reply('👋 Left voice channel.');
            },
        },
    ],
};
