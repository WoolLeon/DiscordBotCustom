import {
    PermissionFlagsBits,
    ApplicationCommandOptionType,
    EmbedBuilder,
} from 'discord.js';
import {
    PLATFORMS,
    normalizeCreatorId,
    resolveYouTubeChannelId,
} from '../lib/announcements/checkers.js';
import { migrateAnnounceSettings } from '../lib/announcements/migrate.js';
import { startAnnouncementPoller, seedSubscriptionKeys } from '../lib/announcements/poller.js';

const platformChoices = Object.keys(PLATFORMS).map((p) => ({
    name: PLATFORMS[p].label,
    value: p,
}));

function hasManage(ctx) {
    return ctx.member.permissions.has(PermissionFlagsBits.ManageGuild);
}

async function upsertStreamChannel(db, guildId, channelId, pingRole, enabled, message) {
    await db.query(
        `INSERT INTO announce_settings (guild_id, live_channel_id, live_ping_role_id, live_enabled, live_message, enabled)
         VALUES (?, ?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE live_channel_id = ?, live_ping_role_id = ?, live_enabled = ?, live_message = COALESCE(?, live_message), enabled = 1`,
        [guildId, channelId, pingRole, enabled, message, channelId, pingRole, enabled, message],
    );
}

async function upsertUploadChannel(db, guildId, channelId, pingRole, enabled, message) {
    await db.query(
        `INSERT INTO announce_settings (guild_id, upload_channel_id, upload_ping_role_id, upload_enabled, upload_message, enabled)
         VALUES (?, ?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE upload_channel_id = ?, upload_ping_role_id = ?, upload_enabled = ?, upload_message = COALESCE(?, upload_message), enabled = 1`,
        [guildId, channelId, pingRole, enabled, message, channelId, pingRole, enabled, message],
    );
}

function parseChannel(ctx, isSlash, args) {
    if (isSlash) return ctx.options.getChannel('channel');
    return ctx.guild.channels.cache.get(args[0]?.replace(/[<#>]/g, ''));
}

function parsePingRole(ctx, isSlash, args) {
    if (isSlash) return ctx.options.getRole('ping_role')?.id ?? null;
    const roleMatch = args.find((a) => /^<@&\d+>$/.test(a));
    return roleMatch ? roleMatch.replace(/[<@&>]/g, '') : null;
}

export default {
    name: 'Stream & Social Announcements',
    help: [
        { usage: '`!stream_setup #channel [@role]`', description: 'Channel for **live stream** alerts (Twitch, Kick, YouTube live).' },
        { usage: '`!upload_setup #channel [@role]`', description: 'Channel for **new upload** alerts (YouTube videos).' },
        { usage: '`!announce_add <youtube|twitch|kick> <id>`', description: 'Follow a creator.' },
        { usage: '`!announce_remove <id>`', description: 'Remove a subscription.' },
        { usage: '`!announce_list`', description: 'View stream/upload channels and subscriptions.' },
        { usage: '`!announce_disable`', description: 'Disable all announcements.' },
    ],

    init: async (db) => {
        await db.query(`CREATE TABLE IF NOT EXISTS announce_settings (
            guild_id            VARCHAR(64) PRIMARY KEY,
            live_channel_id     VARCHAR(64) DEFAULT NULL,
            upload_channel_id   VARCHAR(64) DEFAULT NULL,
            live_ping_role_id   VARCHAR(64) DEFAULT NULL,
            upload_ping_role_id VARCHAR(64) DEFAULT NULL,
            live_enabled        TINYINT(1) DEFAULT 1,
            upload_enabled      TINYINT(1) DEFAULT 1,
            live_message        TEXT DEFAULT NULL,
            upload_message      TEXT DEFAULT NULL,
            enabled             TINYINT(1) DEFAULT 1
        );`);

        await db.query(`CREATE TABLE IF NOT EXISTS announce_subscriptions (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            guild_id        VARCHAR(64) NOT NULL,
            platform        VARCHAR(32) NOT NULL,
            creator_id      VARCHAR(128) NOT NULL,
            creator_label   VARCHAR(128) DEFAULT '',
            notify_live     TINYINT(1) DEFAULT 1,
            notify_upload   TINYINT(1) DEFAULT 1,
            last_live_key   VARCHAR(256) DEFAULT NULL,
            last_upload_key VARCHAR(256) DEFAULT NULL,
            UNIQUE KEY uniq_creator (guild_id, platform, creator_id)
        );`);

        await migrateAnnounceSettings(db);

        const attachPoller = () => {
            const client = global.client;
            if (client?.user) startAnnouncementPoller(client, db);
        };
        attachPoller();
        setTimeout(attachPoller, 5000);
    },

    commands: [
        {
            name: 'stream_setup',
            description: 'Set channel for live stream announcements',
            options: [
                { name: 'channel', type: ApplicationCommandOptionType.Channel, required: true },
                { name: 'ping_role', type: ApplicationCommandOptionType.Role, required: false },
                { name: 'message', description: 'Template: {streamer} {platform} {title} {url} {game}', type: ApplicationCommandOptionType.String, required: false },
            ],
            async execute(ctx, db, isSlash, args) {
                if (!hasManage(ctx)) return ctx.reply('❌ You need **Manage Server**.');

                const channel = parseChannel(ctx, isSlash, args);
                if (!channel?.isTextBased?.()) return ctx.reply('❌ Provide a valid text channel.');

                const pingRole = parsePingRole(ctx, isSlash, args);
                const message = isSlash ? ctx.options.getString('message') : args.slice(1).filter((a) => !a.startsWith('<@&')).join(' ') || null;

                await upsertStreamChannel(db, ctx.guild.id, channel.id, pingRole, 1, message);
                ctx.reply(`✅ **Stream** announcements → ${channel}${pingRole ? ` · ping <@&${pingRole}>` : ''}.`);
            },
        },
        {
            name: 'upload_setup',
            description: 'Set channel for new upload announcements',
            options: [
                { name: 'channel', type: ApplicationCommandOptionType.Channel, required: true },
                { name: 'ping_role', type: ApplicationCommandOptionType.Role, required: false },
                { name: 'message', description: 'Template: {streamer} {title} {url}', type: ApplicationCommandOptionType.String, required: false },
            ],
            async execute(ctx, db, isSlash, args) {
                if (!hasManage(ctx)) return ctx.reply('❌ You need **Manage Server**.');

                const channel = parseChannel(ctx, isSlash, args);
                if (!channel?.isTextBased?.()) return ctx.reply('❌ Provide a valid text channel.');

                const pingRole = parsePingRole(ctx, isSlash, args);
                const message = isSlash ? ctx.options.getString('message') : args.slice(1).filter((a) => !a.startsWith('<@&')).join(' ') || null;

                await upsertUploadChannel(db, ctx.guild.id, channel.id, pingRole, 1, message);
                ctx.reply(`✅ **Upload** announcements → ${channel}${pingRole ? ` · ping <@&${pingRole}>` : ''}.`);
            },
        },
        {
            name: 'announce_add',
            description: 'Follow a streamer or channel',
            options: [
                { name: 'platform', type: ApplicationCommandOptionType.String, required: true, choices: platformChoices },
                { name: 'creator', type: ApplicationCommandOptionType.String, required: true },
                { name: 'label', type: ApplicationCommandOptionType.String, required: false },
            ],
            async execute(ctx, db, isSlash, args) {
                if (!hasManage(ctx)) return ctx.reply('❌ You need **Manage Server**.');

                const settings = (await db.query(
                    'SELECT live_channel_id, upload_channel_id FROM announce_settings WHERE guild_id = ? AND enabled = 1',
                    [ctx.guild.id],
                ))[0];

                const platform = (isSlash ? ctx.options.getString('platform') : args[0])?.toLowerCase();
                const rawCreator = isSlash ? ctx.options.getString('creator') : args[1];
                const label = (isSlash ? ctx.options.getString('label') : args.slice(2).join(' ')) || '';

                if (!PLATFORMS[platform])
                    return ctx.reply(`❌ Platform must be: ${Object.keys(PLATFORMS).join(', ')}.`);

                const meta = PLATFORMS[platform];
                if (meta.live && !settings?.live_channel_id)
                    return ctx.reply('❌ Set a stream channel first: `!stream_setup #channel`.');
                if (meta.upload && !settings?.upload_channel_id)
                    return ctx.reply('❌ Set an upload channel first: `!upload_setup #channel`.');

                let creatorId = normalizeCreatorId(platform, rawCreator);
                if (!creatorId) return ctx.reply('❌ Invalid creator ID or username.');

                if (platform === 'youtube' && creatorId.startsWith('@')) {
                    const resolved = await resolveYouTubeChannelId(creatorId);
                    if (!resolved) return ctx.reply('❌ Could not resolve that YouTube handle.');
                    creatorId = resolved;
                }

                const result = await db.query(
                    `INSERT INTO announce_subscriptions
                     (guild_id, platform, creator_id, creator_label, notify_live, notify_upload)
                     VALUES (?, ?, ?, ?, ?, ?)
                     ON DUPLICATE KEY UPDATE creator_label = VALUES(creator_label)`,
                    [
                        ctx.guild.id,
                        platform,
                        creatorId,
                        label || rawCreator.replace(/^@/, ''),
                        meta.live ? 1 : 0,
                        meta.upload ? 1 : 0,
                    ],
                );
                const subId = result.insertId || (await db.query(
                    'SELECT id FROM announce_subscriptions WHERE guild_id = ? AND platform = ? AND creator_id = ?',
                    [ctx.guild.id, platform, creatorId],
                ))[0]?.id;
                if (subId) await seedSubscriptionKeys(db, subId, platform, creatorId);
                ctx.reply(`✅ Now watching **${label || creatorId}** on **${meta.label}**.`);
            },
        },
        {
            name: 'announce_remove',
            description: 'Remove a creator subscription',
            options: [{ name: 'id', type: ApplicationCommandOptionType.Integer, required: true }],
            async execute(ctx, db, isSlash, args) {
                if (!hasManage(ctx)) return ctx.reply('❌ You need **Manage Server**.');

                const id = parseInt(isSlash ? ctx.options.getInteger('id') : args[0], 10);
                if (!id) return ctx.reply('❌ Provide the subscription ID from `!announce_list`.');

                const result = await db.query(
                    'DELETE FROM announce_subscriptions WHERE id = ? AND guild_id = ?',
                    [id, ctx.guild.id],
                );
                if (!result.affectedRows) return ctx.reply('❌ Subscription not found.');
                ctx.reply('✅ Subscription removed.');
            },
        },
        {
            name: 'announce_list',
            description: 'List stream/upload channels and subscriptions',
            async execute(ctx, db) {
                const settings = (await db.query(
                    'SELECT * FROM announce_settings WHERE guild_id = ?',
                    [ctx.guild.id],
                ))[0];
                const subs = await db.query(
                    'SELECT * FROM announce_subscriptions WHERE guild_id = ? ORDER BY platform, id',
                    [ctx.guild.id],
                );

                const embed = new EmbedBuilder()
                    .setTitle('📡 Stream & upload announcements')
                    .setColor('#5865F2');

                if (!settings) {
                    embed.setDescription('Not configured. Use `!stream_setup` and `!upload_setup`.');
                } else {
                    const liveCh = settings.live_channel_id
                        ? ctx.guild.channels.cache.get(settings.live_channel_id)
                        : null;
                    const uploadCh = settings.upload_channel_id
                        ? ctx.guild.channels.cache.get(settings.upload_channel_id)
                        : null;
                    embed.addFields(
                        {
                            name: '🔴 Stream channel',
                            value: liveCh
                                ? `${liveCh}${settings.live_enabled ? '' : ' *(disabled)*'}`
                                : '—',
                            inline: true,
                        },
                        {
                            name: '📺 Upload channel',
                            value: uploadCh
                                ? `${uploadCh}${settings.upload_enabled ? '' : ' *(disabled)*'}`
                                : '—',
                            inline: true,
                        },
                    );
                }

                if (!subs.length) {
                    embed.addFields({ name: 'Creators', value: 'None. Use `!announce_add`.' });
                } else {
                    const lines = subs.map((s) => {
                        const p = PLATFORMS[s.platform]?.label || s.platform;
                        const name = s.creator_label || s.creator_id;
                        const flags = [s.notify_live ? 'stream' : null, s.notify_upload ? 'upload' : null]
                            .filter(Boolean).join(', ');
                        return `\`#${s.id}\` **${name}** (${p}) — ${flags}`;
                    });
                    embed.addFields({ name: 'Creators', value: lines.join('\n').slice(0, 1024) });
                }

                ctx.reply({ embeds: [embed] });
            },
        },
        {
            name: 'announce_disable',
            description: 'Disable all announcements for this server',
            async execute(ctx, db) {
                if (!hasManage(ctx)) return ctx.reply('❌ You need **Manage Server**.');

                await db.query('UPDATE announce_settings SET enabled = 0 WHERE guild_id = ?', [ctx.guild.id]);
                ctx.reply('✅ Announcements disabled for this server.');
            },
        },
    ],
};
