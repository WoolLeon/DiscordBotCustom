import {
    PermissionFlagsBits,
    ApplicationCommandOptionType,
    EmbedBuilder,
    Events,
} from 'discord.js';

export default {
    name: 'Starboard',
    help: [
        { usage: '`!starboard_setup #channel [threshold]`', description: 'Set starboard channel (default threshold: 3 ⭐).' },
        { usage: '`!starboard_disable`', description: 'Disable the starboard.' },
        { usage: '`!starboard_config [threshold]`', description: 'View or change the star threshold.' },
    ],

    init: async (db) => {
        await db.query(`CREATE TABLE IF NOT EXISTS starboard_settings (
            guild_id   VARCHAR(64) PRIMARY KEY,
            channel_id VARCHAR(64) NOT NULL,
            threshold  TINYINT DEFAULT 3,
            emoji      VARCHAR(32) DEFAULT '⭐'
        );`);
        await db.query(`CREATE TABLE IF NOT EXISTS starboard_posts (
            guild_id            VARCHAR(64) NOT NULL,
            source_message_id   VARCHAR(64) PRIMARY KEY,
            starboard_message_id VARCHAR(64) NOT NULL
        );`);
    },

    commands: [
        {
            name: 'starboard_setup',
            description: 'Configure starboard channel',
            options: [
                { name: 'channel', type: ApplicationCommandOptionType.Channel, required: true },
                { name: 'threshold', type: ApplicationCommandOptionType.Integer, required: false },
            ],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ManageGuild))
                    return ctx.reply('❌ You need **Manage Server**.');

                const channel = isSlash
                    ? ctx.options.getChannel('channel')
                    : ctx.guild.channels.cache.get(args[0]?.replace(/[<#>]/g, ''));
                const threshold = Math.min(25, Math.max(1,
                    isSlash ? (ctx.options.getInteger('threshold') ?? 3) : parseInt(args[1], 10) || 3
                ));

                if (!channel?.isTextBased()) return ctx.reply('❌ Provide a valid text channel.');

                await db.query(
                    'REPLACE INTO starboard_settings (guild_id, channel_id, threshold) VALUES (?, ?, ?)',
                    [ctx.guild.id, channel.id, threshold],
                );
                ctx.reply(`✅ Starboard enabled in ${channel} (threshold: **${threshold}** ⭐).`);
            },
        },
        {
            name: 'starboard_disable',
            description: 'Disable starboard',
            async execute(ctx, db) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ManageGuild))
                    return ctx.reply('❌ You need **Manage Server**.');
                await db.query('DELETE FROM starboard_settings WHERE guild_id = ?', [ctx.guild.id]);
                ctx.reply('✅ Starboard disabled.');
            },
        },
        {
            name: 'starboard_config',
            description: 'View or update starboard threshold',
            options: [
                { name: 'threshold', type: ApplicationCommandOptionType.Integer, required: false },
            ],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ManageGuild))
                    return ctx.reply('❌ You need **Manage Server**.');

                const cfg = await db.query('SELECT * FROM starboard_settings WHERE guild_id = ?', [ctx.guild.id]);
                if (!cfg[0]) return ctx.reply('ℹ️ Starboard is not configured. Use `!starboard_setup`.');

                const newThreshold = isSlash
                    ? ctx.options.getInteger('threshold')
                    : (args[0] ? parseInt(args[0], 10) : null);

                if (newThreshold) {
                    const t = Math.min(25, Math.max(1, newThreshold));
                    await db.query('UPDATE starboard_settings SET threshold = ? WHERE guild_id = ?', [t, ctx.guild.id]);
                    return ctx.reply(`✅ Starboard threshold set to **${t}**.`);
                }

                ctx.reply(`**Starboard:** <#${cfg[0].channel_id}> • Threshold: **${cfg[0].threshold}** ⭐`);
            },
        },
    ],

    rules: [
        {
            name: 'StarboardReaction',
            event: Events.MessageReactionAdd,
            async execute(reaction, user, db) {
                if (user.bot) return;
                if (reaction.partial) await reaction.fetch().catch(() => {});

                const cfgRows = await db.query('SELECT * FROM starboard_settings WHERE guild_id = ?', [reaction.message.guild?.id]);
                const cfg = cfgRows[0];
                if (!cfg) return;

                const emoji = cfg.emoji || '⭐';
                if (reaction.emoji.name !== emoji && reaction.emoji.toString() !== emoji) return;

                const msg = reaction.message;
                if (!msg.guild || msg.channel.id === cfg.channel_id) return;

                const full = await msg.fetch().catch(() => msg);
                const starReaction = full.reactions.cache.find(r =>
                    r.emoji.name === emoji || r.emoji.toString() === emoji
                );
                const count = starReaction?.count ?? 0;
                const adjusted = starReaction?.me ? count - 1 : count;
                if (adjusted < cfg.threshold) return;

                const starCh = msg.guild.channels.cache.get(cfg.channel_id);
                if (!starCh?.isTextBased()) return;

                const existing = await db.query(
                    'SELECT starboard_message_id FROM starboard_posts WHERE source_message_id = ?',
                    [msg.id],
                );

                const embed = new EmbedBuilder()
                    .setDescription(full.content?.slice(0, 2048) || '*No text content*')
                    .setColor('#FEE75C')
                    .setAuthor({
                        name: full.author.tag,
                        iconURL: full.author.displayAvatarURL(),
                    })
                    .addFields({ name: 'Source', value: `[Jump to message](${full.url})` })
                    .setFooter({ text: `${adjusted} ⭐` })
                    .setTimestamp(full.createdAt);

                if (full.attachments.size > 0) {
                    const img = full.attachments.find(a => a.contentType?.startsWith('image/'));
                    if (img) embed.setImage(img.url);
                }

                if (existing[0]) {
                    const sbMsg = await starCh.messages.fetch(existing[0].starboard_message_id).catch(() => null);
                    if (sbMsg) await sbMsg.edit({ embeds: [embed] }).catch(() => {});
                } else {
                    const sent = await starCh.send({ embeds: [embed] }).catch(() => null);
                    if (sent) {
                        await db.query(
                            'INSERT INTO starboard_posts (guild_id, source_message_id, starboard_message_id) VALUES (?, ?, ?)',
                            [msg.guild.id, msg.id, sent.id],
                        );
                    }
                }
            },
        },
    ],
};
