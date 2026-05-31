import {
    PermissionFlagsBits,
    ApplicationCommandOptionType,
    EmbedBuilder
} from 'discord.js';

/**
 * Warn System Plugin
 *
 * - !warn @user [reason]       — add a warning
 * - !warnings @user            — view warning history
 * - !delwarn <id>              — delete a specific warning
 * - !clearwarns @user          — clear all warnings for a user
 * - !warnconfig                — configure auto-punishment thresholds
 *
 * Auto-punish thresholds (configurable per server):
 *   Default: 3 warns = mute 1h, 5 warns = kick, 7 warns = ban
 */

export default {
    name: 'Warn System',
    help: [
        { usage: '`!warn @user [reason]`',          description: 'Warn a user. Triggers auto-punishment at thresholds.' },
        { usage: '`!warnings @user`',               description: 'View all warnings for a user.' },
        { usage: '`!delwarn <warn ID>`',            description: 'Delete a specific warning by ID.' },
        { usage: '`!clearwarns @user`',             description: 'Clear all warnings for a user.' },
        { usage: '`!warnconfig [mute|kick|ban] <count>`', description: 'Set auto-punish thresholds. E.g. `!warnconfig mute 3`' },
    ],

    init: async (db) => {
        await db.query(`CREATE TABLE IF NOT EXISTS warnings (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            guild_id   VARCHAR(64) NOT NULL,
            user_id    VARCHAR(64) NOT NULL,
            mod_id     VARCHAR(64) NOT NULL,
            reason     TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );`);

        await db.query(`CREATE TABLE IF NOT EXISTS warn_config (
            guild_id        VARCHAR(64) PRIMARY KEY,
            mute_at         TINYINT DEFAULT 3,
            mute_duration   INT DEFAULT 3600,
            kick_at         TINYINT DEFAULT 5,
            ban_at          TINYINT DEFAULT 7,
            log_channel     VARCHAR(64)
        );`);

        console.log('✅ Warn System initialized.');
    },

    commands: [
        {
            name: 'warn',
            description: 'Warn a user',
            options: [
                { name: 'user',   description: 'User to warn',   type: ApplicationCommandOptionType.User,   required: true  },
                { name: 'reason', description: 'Reason for warn', type: ApplicationCommandOptionType.String, required: false }
            ],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ModerateMembers))
                    return ctx.reply('❌ You need the **Timeout Members** permission.');

                const target = isSlash
                    ? ctx.options.getMember('user')
                    : ctx.guild.members.cache.get(args[0]?.replace(/[<@!>]/g, ''));
                const reason = (isSlash ? ctx.options.getString('reason') : args.slice(1).join(' ')) || 'No reason provided';

                if (!target) return ctx.reply('❌ User not found.');
                if (target.id === ctx.member.id) return ctx.reply('❌ You cannot warn yourself.');
                if (target.user.bot) return ctx.reply('❌ You cannot warn bots.');
                if (target.roles.highest.position >= ctx.member.roles.highest.position)
                    return ctx.reply('❌ You cannot warn someone with an equal or higher role.');

                // Insert warning
                const result = await db.query(
                    'INSERT INTO warnings (guild_id, user_id, mod_id, reason) VALUES (?, ?, ?, ?)',
                    [ctx.guild.id, target.id, ctx.member.id, reason]
                );
                const warnId = result.insertId;

                // Count total warnings
                const countRes = await db.query(
                    'SELECT COUNT(*) AS total FROM warnings WHERE guild_id = ? AND user_id = ?',
                    [ctx.guild.id, target.id]
                );
                const total = Number(countRes[0].total);

                // Get config
                const cfgRes = await db.query('SELECT * FROM warn_config WHERE guild_id = ?', [ctx.guild.id]);
                const cfg    = cfgRes[0] || { mute_at: 3, mute_duration: 3600, kick_at: 5, ban_at: 7 };

                // Build warn embed
                const embed = new EmbedBuilder()
                    .setTitle('⚠️ Warning Issued')
                    .setColor('#FFA500')
                    .setThumbnail(target.user.displayAvatarURL({ size: 64 }))
                    .addFields(
                        { name: 'User',       value: `${target} (${target.user.tag})`, inline: true  },
                        { name: 'Moderator',  value: `${ctx.member}`,                  inline: true  },
                        { name: 'Warn ID',    value: `#${warnId}`,                     inline: true  },
                        { name: 'Reason',     value: reason,                           inline: false },
                        { name: 'Total Warns',value: `${total} warning(s)`,            inline: true  }
                    )
                    .setTimestamp();

                // Auto-punish logic
                let punishmentMsg = '';

                if (cfg.ban_at && total >= cfg.ban_at) {
                    try {
                        await target.ban({ reason: `Auto-ban: reached ${total} warnings` });
                        punishmentMsg = `🔨 **Auto-banned** for reaching ${total} warnings.`;
                        embed.addFields({ name: '🔨 Auto-Punishment', value: punishmentMsg });
                        embed.setColor('#ED4245');
                    } catch (e) {
                        console.error('Auto-ban failed:', e.message);
                    }
                } else if (cfg.kick_at && total >= cfg.kick_at) {
                    try {
                        await target.kick(`Auto-kick: reached ${total} warnings`);
                        punishmentMsg = `👢 **Auto-kicked** for reaching ${total} warnings.`;
                        embed.addFields({ name: '👢 Auto-Punishment', value: punishmentMsg });
                        embed.setColor('#FF6B35');
                    } catch (e) {
                        console.error('Auto-kick failed:', e.message);
                    }
                } else if (cfg.mute_at && total >= cfg.mute_at) {
                    try {
                        const muteDuration = cfg.mute_duration * 1000; // ms
                        await target.timeout(muteDuration, `Auto-mute: reached ${total} warnings`);
                        const durationStr = formatDuration(cfg.mute_duration);
                        punishmentMsg = `🔇 **Auto-muted** for ${durationStr} for reaching ${total} warnings.`;
                        embed.addFields({ name: '🔇 Auto-Punishment', value: punishmentMsg });
                        embed.setColor('#FEE75C');
                    } catch (e) {
                        console.error('Auto-mute failed:', e.message);
                    }
                }

                // Add upcoming threshold info if no punishment yet
                if (!punishmentMsg) {
                    const next = getNextThreshold(total, cfg);
                    if (next) embed.addFields({ name: '⏭️ Next Threshold', value: next, inline: true });
                }

                await ctx.reply({ embeds: [embed] });

                // DM the warned user
                target.send({ embeds: [
                    new EmbedBuilder()
                        .setTitle(`⚠️ You have been warned in ${ctx.guild.name}`)
                        .setColor('#FFA500')
                        .addFields(
                            { name: 'Reason',      value: reason,              inline: false },
                            { name: 'Total Warns', value: `${total}`,          inline: true  },
                            { name: 'Warn ID',     value: `#${warnId}`,        inline: true  }
                        )
                        .setTimestamp()
                ] }).catch(() => {}); // Silently fail if DMs are closed

                // Log to log channel
                await sendLog(db, ctx.guild, embed);
            }
        },

        {
            name: 'warnings',
            description: 'View all warnings for a user',
            options: [{ name: 'user', description: 'User to check', type: ApplicationCommandOptionType.User, required: true }],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ModerateMembers))
                    return ctx.reply('❌ You need the **Timeout Members** permission.');

                const target = isSlash
                    ? ctx.options.getUser('user')
                    : ctx.guild.members.cache.get(args[0]?.replace(/[<@!>]/g, ''))?.user;
                if (!target) return ctx.reply('❌ User not found.');

                const warns = await db.query(
                    'SELECT * FROM warnings WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC',
                    [ctx.guild.id, target.id]
                );

                if (!warns.length) return ctx.reply(`✅ **${target.tag}** has no warnings.`);

                const lines = warns.map(w => {
                    const date = new Date(w.created_at).toLocaleDateString('en-GB');
                    return `**#${w.id}** — ${w.reason}\n> By <@${w.mod_id}> on ${date}`;
                }).join('\n\n');

                const embed = new EmbedBuilder()
                    .setTitle(`⚠️ Warnings for ${target.tag}`)
                    .setColor('#FFA500')
                    .setThumbnail(target.displayAvatarURL({ size: 64 }))
                    .setDescription(lines.length > 4000 ? lines.substring(0, 4000) + '\n...' : lines)
                    .setFooter({ text: `${warns.length} total warning(s)` })
                    .setTimestamp();

                ctx.reply({ embeds: [embed] });
            }
        },

        {
            name: 'delwarn',
            description: 'Delete a specific warning by ID',
            options: [{ name: 'id', description: 'Warning ID', type: ApplicationCommandOptionType.Integer, required: true }],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ModerateMembers))
                    return ctx.reply('❌ You need the **Timeout Members** permission.');

                const warnId = isSlash ? ctx.options.getInteger('id') : parseInt(args[0]);
                if (!warnId) return ctx.reply('❌ Please provide a valid warning ID.');

                const warn = await db.query(
                    'SELECT * FROM warnings WHERE id = ? AND guild_id = ?',
                    [warnId, ctx.guild.id]
                );
                if (!warn.length) return ctx.reply(`❌ Warning #${warnId} not found in this server.`);

                await db.query('DELETE FROM warnings WHERE id = ?', [warnId]);
                ctx.reply({ embeds: [
                    new EmbedBuilder()
                        .setDescription(`✅ Warning **#${warnId}** has been deleted.\nOriginal reason: *${warn[0].reason}*`)
                        .setColor('#57F287')
                ] });
            }
        },

        {
            name: 'clearwarns',
            description: 'Clear all warnings for a user',
            options: [{ name: 'user', description: 'User to clear', type: ApplicationCommandOptionType.User, required: true }],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.Administrator))
                    return ctx.reply('❌ Administrator permission required.');

                const target = isSlash
                    ? ctx.options.getUser('user')
                    : ctx.guild.members.cache.get(args[0]?.replace(/[<@!>]/g, ''))?.user;
                if (!target) return ctx.reply('❌ User not found.');

                const result = await db.query(
                    'DELETE FROM warnings WHERE guild_id = ? AND user_id = ?',
                    [ctx.guild.id, target.id]
                );
                const deleted = result.affectedRows ?? 0;

                ctx.reply({ embeds: [
                    new EmbedBuilder()
                        .setDescription(`✅ Cleared **${deleted}** warning(s) for **${target.tag}**.`)
                        .setColor('#57F287')
                ] });
            }
        },

        {
            name: 'warnconfig',
            description: 'Configure auto-punishment thresholds',
            options: [
                {
                    name: 'action', description: 'Punishment type to configure',
                    type: ApplicationCommandOptionType.String, required: true,
                    choices: [
                        { name: 'Mute',         value: 'mute'     },
                        { name: 'Kick',         value: 'kick'     },
                        { name: 'Ban',          value: 'ban'      },
                        { name: 'Mute Duration',value: 'duration' },
                        { name: 'Log Channel',  value: 'log'      },
                    ]
                },
                { name: 'value', description: 'Threshold count (or channel for log)', type: ApplicationCommandOptionType.String, required: true }
            ],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.Administrator))
                    return ctx.reply('❌ Administrator permission required.');

                const action = isSlash ? ctx.options.getString('action') : args[0]?.toLowerCase();
                const value  = isSlash ? ctx.options.getString('value')  : args[1];

                if (!action || !value) return ctx.reply('❌ Usage: `!warnconfig <mute|kick|ban|duration|log> <value>`');

                // Ensure row exists
                await db.query(
                    'INSERT IGNORE INTO warn_config (guild_id) VALUES (?)',
                    [ctx.guild.id]
                );

                const validActions = { mute: 'mute_at', kick: 'kick_at', ban: 'ban_at', duration: 'mute_duration' };

                if (action === 'log') {
                    const chanId = value.replace(/[<#>]/g, '');
                    await db.query('UPDATE warn_config SET log_channel = ? WHERE guild_id = ?', [chanId, ctx.guild.id]);
                    return ctx.reply(`✅ Warn log channel set to <#${chanId}>.`);
                }

                if (!validActions[action]) return ctx.reply('❌ Unknown action. Use: `mute`, `kick`, `ban`, `duration`, `log`');

                const num = parseInt(value);
                if (isNaN(num) || num < 0) return ctx.reply('❌ Please provide a valid number.');

                const col = validActions[action];
                await db.query(`UPDATE warn_config SET ${col} = ? WHERE guild_id = ?`, [num, ctx.guild.id]);

                const labels = { mute: `Auto-mute at ${num} warns`, kick: `Auto-kick at ${num} warns`, ban: `Auto-ban at ${num} warns`, duration: `Mute duration set to ${formatDuration(num)}` };
                ctx.reply(`✅ ${labels[action]}.`);
            }
        },

        {
            name: 'warnstats',
            description: 'Show current warn config and thresholds',
            async execute(ctx, db) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ModerateMembers))
                    return ctx.reply('❌ You need the **Timeout Members** permission.');

                const cfgRes = await db.query('SELECT * FROM warn_config WHERE guild_id = ?', [ctx.guild.id]);
                const cfg    = cfgRes[0] || { mute_at: 3, mute_duration: 3600, kick_at: 5, ban_at: 7, log_channel: null };

                const embed = new EmbedBuilder()
                    .setTitle('⚙️ Warn System Config')
                    .setColor('#5865F2')
                    .addFields(
                        { name: '🔇 Mute at',       value: `${cfg.mute_at} warns`,                   inline: true },
                        { name: '⏱️ Mute duration', value: formatDuration(cfg.mute_duration),          inline: true },
                        { name: '👢 Kick at',        value: `${cfg.kick_at} warns`,                   inline: true },
                        { name: '🔨 Ban at',         value: `${cfg.ban_at} warns`,                    inline: true },
                        { name: '📋 Log channel',    value: cfg.log_channel ? `<#${cfg.log_channel}>` : 'Not set', inline: true }
                    )
                    .setFooter({ text: 'Use !warnconfig to change these settings.' });

                ctx.reply({ embeds: [embed] });
            }
        }
    ],

    rules: []
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function getNextThreshold(total, cfg) {
    if (cfg.mute_at && total < cfg.mute_at)
        return `🔇 Mute in **${cfg.mute_at - total}** more warn(s) (at ${cfg.mute_at})`;
    if (cfg.kick_at && total < cfg.kick_at)
        return `👢 Kick in **${cfg.kick_at - total}** more warn(s) (at ${cfg.kick_at})`;
    if (cfg.ban_at && total < cfg.ban_at)
        return `🔨 Ban in **${cfg.ban_at - total}** more warn(s) (at ${cfg.ban_at})`;
    return null;
}

function formatDuration(seconds) {
    if (seconds < 60)   return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
}

async function sendLog(db, guild, embed) {
    try {
        const cfgRes = await db.query('SELECT log_channel FROM warn_config WHERE guild_id = ?', [guild.id]);
        const logId  = cfgRes[0]?.log_channel;
        if (!logId) return;
        const logChannel = guild.channels.cache.get(logId);
        if (logChannel) await logChannel.send({ embeds: [embed] });
    } catch (err) {
        console.error('❌ Failed to send warn log:', err.message);
    }
}
