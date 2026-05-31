import {
    PermissionFlagsBits,
    ApplicationCommandOptionType,
    EmbedBuilder
} from 'discord.js';

// In-memory cooldown map: userId → last XP timestamp
const cooldowns = new Map();
const XP_COOLDOWN_MS  = 60_000; // 60 seconds between XP gains
const XP_PER_MESSAGE  = () => Math.floor(Math.random() * 11) + 15; // 15–25 base XP per message

export default {
    name: 'Leveling System',
    help: [
        { usage: '`!rank [@user]`',             description: 'Show your (or another user\'s) rank card.' },
        { usage: '`!levels` or `!leaderboard`', description: 'Show top 10 users & link to web leaderboard.' },
        { usage: '`!level_role <level> @role`', description: 'Award a role when a user reaches a level.' },
        { usage: '`!level_config`',             description: 'View current settings. Admins: Change settings (type, channel, stack, msg).' },
        { usage: '`!xp_boost @role <mult>`',    description: '(Admin) Configure an XP multiplier for a role.' },
        { usage: '`!xp_boost_remove @role`',    description: '(Admin) Remove an XP boost.' },
        { usage: '`!xp_boosts`',                description: 'List all active role XP boosts.' },
        { usage: '`!xp_ignore_role @role`',    description: '(Admin) Toggle ignoring XP gain for a role.' },
        { usage: '`!xp_ignore #channel`',       description: '(Admin) Toggle ignoring XP gain for a channel.' },
        { usage: '`!xp_ignored`',               description: 'List all ignored channels and roles.' },
        { usage: '`!xp_set @user <xp>`',        description: '(Admin) Set a user\'s XP directly.' },
        { usage: '`!xp_add @user <xp>`',        description: '(Admin) Add XP to a user.' },
        { usage: '`!xp_reset @user`',           description: '(Admin) Reset a user\'s XP and level.' }
    ],

    init: async (db) => {
        await db.query(`CREATE TABLE IF NOT EXISTS levels (
            guild_id  VARCHAR(64) NOT NULL,
            user_id   VARCHAR(64) NOT NULL,
            xp        INT DEFAULT 0,
            level     INT DEFAULT 0,
            PRIMARY KEY (guild_id, user_id)
        );`);

        await db.query(`CREATE TABLE IF NOT EXISTS level_settings (
            guild_id         VARCHAR(64) PRIMARY KEY,
            announce_channel VARCHAR(64),
            ignored_channels TEXT
        );`);

        await db.query(`CREATE TABLE IF NOT EXISTS level_roles (
            guild_id  VARCHAR(64) NOT NULL,
            level     INT NOT NULL,
            role_id   VARCHAR(64) NOT NULL,
            PRIMARY KEY (guild_id, level)
        );`);

        await db.query(`CREATE TABLE IF NOT EXISTS level_boosts (
            guild_id   VARCHAR(64) NOT NULL,
            role_id    VARCHAR(64) NOT NULL,
            multiplier DECIMAL(5,2) DEFAULT 1.00,
            PRIMARY KEY (guild_id, role_id)
        );`);

        // Safely add missing columns to level_settings
        const addColumnSafe = async (table, col, definition) => {
            try {
                await db.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${definition}`);
            } catch (err) {
                if (err.errno !== 1060 && !err.message.includes('Duplicate column')) {
                    console.error(`Error adding column ${col} to ${table}:`, err);
                }
            }
        };

        await addColumnSafe('level_settings', 'announce_type', "VARCHAR(32) DEFAULT 'channel'");
        await addColumnSafe('level_settings', 'announce_msg', "TEXT");
        await addColumnSafe('level_settings', 'stack_roles', "TINYINT(1) DEFAULT 1");
        await addColumnSafe('level_settings', 'ignored_roles', "TEXT");

        console.log('✅ Leveling System initialized.');
    },

    commands: [
        // ── !rank ────────────────────────────────────────────────────────────
        {
            name: 'rank',
            description: 'Show your rank card or another user\'s',
            options: [{ name: 'user', description: 'User to check', type: ApplicationCommandOptionType.User, required: false }],
            async execute(ctx, db, isSlash, args) {
                const target = isSlash
                    ? (ctx.options.getMember('user') || ctx.member)
                    : (ctx.guild.members.cache.get(args[0]?.replace(/[<@!>]/g, '')) || ctx.member);

                const row = await getUserRow(db, ctx.guild.id, target.id);
                const { level, xp } = row;
                const xpForNext   = xpToNextLevel(level);
                const xpIntoLevel = xp - xpForLevel(level);
                const progress    = Math.min(100, Math.floor((xpIntoLevel / xpForNext) * 100));

                const rankRes = await db.query(
                    'SELECT COUNT(*) AS pos FROM levels WHERE guild_id = ? AND xp > ?',
                    [ctx.guild.id, xp]
                );
                const rank = Number(rankRes[0]?.pos ?? 0) + 1;
                const bar  = buildProgressBar(progress, 20);

                const embed = new EmbedBuilder()
                    .setTitle(`📊 ${target.displayName}'s Rank`)
                    .setThumbnail(target.user.displayAvatarURL({ size: 128 }))
                    .setColor(target.displayHexColor === '#000000' ? '#5865F2' : target.displayHexColor)
                    .addFields(
                        { name: '🏅 Rank',  value: `#${rank}`,                    inline: true },
                        { name: '⭐ Level', value: `${level}`,                     inline: true },
                        { name: '✨ XP',    value: `${xp.toLocaleString()} total`, inline: true },
                        { name: `Progress to Level ${level + 1}`,
                          value: `\`${bar}\` ${progress}%\n${xpIntoLevel.toLocaleString()} / ${xpForNext.toLocaleString()} XP` }
                    )
                    .setTimestamp();

                ctx.reply({ embeds: [embed] });
            }
        },

        // ── !leaderboard ─────────────────────────────────────────────────────
        {
            name: 'leaderboard',
            description: 'Show the top 10 users by XP and a link to the web leaderboard',
            async execute(ctx, db) {
                const rows = await db.query(
                    'SELECT user_id, xp, level FROM levels WHERE guild_id = ? ORDER BY xp DESC LIMIT 10',
                    [ctx.guild.id]
                );

                const port = process.env.DASHBOARD_PORT || 3000;
                const baseDashboardUrl = process.env.DASHBOARD_URL || `http://localhost:${port}`;
                const leaderboardUrl = `${baseDashboardUrl}/leaderboard/${ctx.guild.id}`;

                if (!rows.length) {
                    return ctx.reply({ embeds: [
                        new EmbedBuilder()
                            .setTitle(`🏆 ${ctx.guild.name} Leaderboard`)
                            .setColor('#FFD700')
                            .setDescription(`ℹ️ No one has earned XP yet!\n\n🔗 **[View Full Web Leaderboard](${leaderboardUrl})**`)
                            .setTimestamp()
                    ] });
                }

                const medals = ['🥇', '🥈', '🥉'];
                const lines  = await Promise.all(rows.map(async (r, i) => {
                    const member = ctx.guild.members.cache.get(r.user_id)
                        || await ctx.guild.members.fetch(r.user_id).catch(() => null);
                    const name = member?.displayName || `Unknown (${r.user_id})`;
                    const icon = medals[i] || `**${i + 1}.**`;
                    return `${icon} **${name}** — Level ${r.level} • ${r.xp.toLocaleString()} XP`;
                }));

                const embed = new EmbedBuilder()
                    .setTitle(`🏆 ${ctx.guild.name} Leaderboard`)
                    .setColor('#FFD700')
                    .setDescription(lines.join('\n') + `\n\n🔗 **[View Full Web Leaderboard](${leaderboardUrl})**`)
                    .setTimestamp();

                ctx.reply({ embeds: [embed] });
            }
        },

        // ── !levels ──────────────────────────────────────────────────────────
        {
            name: 'levels',
            description: 'Show the top 10 users by XP and a link to the web leaderboard',
            async execute(ctx, db) {
                const cmd = ctx.client.commands.get('leaderboard');
                if (cmd) await cmd.execute(ctx, db);
            }
        },

        // ── !level_role ───────────────────────────────────────────────────────
        {
            name: 'level_role',
            description: 'Assign a role reward when a user reaches a level',
            options: [
                { name: 'level', description: 'Level required', type: ApplicationCommandOptionType.Integer, required: true },
                { name: 'role',  description: 'Role to assign', type: ApplicationCommandOptionType.Role,    required: true }
            ],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ManageRoles))
                    return ctx.reply('❌ You need **Manage Roles** permission.');

                let level, roleId;
                if (isSlash) {
                    level  = ctx.options.getInteger('level');
                    roleId = ctx.options.getRole('role').id;
                } else {
                    level  = parseInt(args[0]);
                    roleId = args[1]?.replace(/[<@&>]/g, '');
                }

                if (!level || level < 1) return ctx.reply('❌ Please provide a valid level (1+).');
                if (!roleId) return ctx.reply('❌ Please mention a valid role.');

                await db.query(
                    'INSERT INTO level_roles (guild_id, level, role_id) VALUES (?, ?, ?) ON DUPLIC KEY UPDATE role_id = ?',
                    [ctx.guild.id, level, roleId, roleId]
                );

                ctx.reply({ embeds: [
                    new EmbedBuilder()
                        .setDescription(`✅ <@&${roleId}> will be awarded at **Level ${level}**.`)
                        .setColor('#57F287')
                ] });
            }
        },

        // ── !level_config ─────────────────────────────────────────────────────
        {
            name: 'level_config',
            description: 'Configure leveling announcements, role stacking, and message templates',
            options: [
                {
                    name: 'announce_type',
                    description: 'Where level-up messages are sent',
                    type: ApplicationCommandOptionType.String,
                    required: false,
                    choices: [
                        { name: 'Disabled', value: 'disabled' },
                        { name: 'Current Channel', value: 'current' },
                        { name: 'Designated Channel', value: 'channel' },
                        { name: 'Direct Message', value: 'dm' }
                    ]
                },
                { name: 'announce_channel', description: 'Designated channel for level announcements', type: ApplicationCommandOptionType.Channel, required: false },
                { name: 'stack_roles', description: 'Enable stacking of role rewards', type: ApplicationCommandOptionType.Boolean, required: false },
                { name: 'announce_msg', description: 'Message template ({user}, {username}, {level}, {xp})', type: ApplicationCommandOptionType.String, required: false }
            ],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ManageGuild))
                    return ctx.reply('❌ You need **Manage Server** permission.');

                let type, channelId, stack, msg;

                if (isSlash) {
                    type      = ctx.options.getString('announce_type');
                    channelId = ctx.options.getChannel('announce_channel')?.id;
                    stack     = ctx.options.getBoolean('stack_roles');
                    msg       = ctx.options.getString('announce_msg');
                } else {
                    const sub = args[0]?.toLowerCase();
                    if (sub === 'type') {
                        type = args[1]?.toLowerCase();
                        if (!['disabled', 'current', 'channel', 'dm'].includes(type)) {
                            return ctx.reply('❌ Announcement type must be: `disabled`, `current`, `channel`, `dm`');
                        }
                    } else if (sub === 'channel') {
                        channelId = args[1]?.replace(/[<#>]/g, '');
                    } else if (sub === 'stack') {
                        const val = args[1]?.toLowerCase();
                        if (val === 'on' || val === 'true') stack = true;
                        else if (val === 'off' || val === 'false') stack = false;
                        else return ctx.reply('❌ Stack must be `on` or `off`.');
                    } else if (sub === 'msg') {
                        msg = args.slice(1).join(' ');
                    }
                }

                const res = await db.query('SELECT * FROM level_settings WHERE guild_id = ?', [ctx.guild.id]);
                const existing = res[0] || {};

                const newType  = type !== undefined ? type : (existing.announce_type || 'channel');
                const newChan  = channelId !== undefined ? channelId : (existing.announce_channel || null);
                const newStack = stack !== undefined ? (stack ? 1 : 0) : (existing.stack_roles ?? 1);
                const newMsg   = msg !== undefined ? msg : (existing.announce_msg || null);

                await db.query(
                    `INSERT INTO level_settings (guild_id, announce_channel, announce_type, announce_msg, stack_roles) 
                     VALUES (?, ?, ?, ?, ?) 
                     ON DUPLICATE KEY UPDATE 
                        announce_channel = ?, announce_type = ?, announce_msg = ?, stack_roles = ?`,
                    [ctx.guild.id, newChan, newType, newMsg, newStack, newChan, newType, newMsg, newStack]
                );

                if (isSlash || args.length > 0) {
                    return ctx.reply('✅ Leveling configuration updated successfully.');
                }

                const embed = new EmbedBuilder()
                    .setTitle('⚙️ Leveling Configuration')
                    .setColor('#5865F2')
                    .addFields(
                        { name: '📣 Announcement Type', value: `\`${newType}\``, inline: true },
                        { name: '📍 Announcement Channel', value: newChan ? `<#${newChan}>` : '`None`', inline: true },
                        { name: '🥞 Stack Role Rewards', value: newStack ? '`Enabled`' : '`Disabled`', inline: true },
                        { name: '✉️ Announcement Message', value: `\`\`\`${newMsg || 'Congratulations {user}! You reached **Level {level}**!'}\`\`\`` }
                    )
                    .setFooter({ text: 'Use !level_config <type/channel/stack/msg> <value> to modify.' })
                    .setTimestamp();

                ctx.reply({ embeds: [embed] });
            }
        },

        // ── !xp_boost ────────────────────────────────────────────────────────
        {
            name: 'xp_boost',
            description: 'Configure XP multiplier boost for a role',
            options: [
                { name: 'role', description: 'Role to boost', type: ApplicationCommandOptionType.Role, required: true },
                { name: 'multiplier', description: 'XP Multiplier (e.g. 1.5, 2.0)', type: ApplicationCommandOptionType.Number, required: true }
            ],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ManageGuild))
                    return ctx.reply('❌ You need **Manage Server** permission.');

                let roleId, mult;
                if (isSlash) {
                    roleId = ctx.options.getRole('role').id;
                    mult   = ctx.options.getNumber('multiplier');
                } else {
                    roleId = args[0]?.replace(/[<@&>]/g, '');
                    mult   = parseFloat(args[1]);
                }

                if (!roleId || isNaN(mult) || mult < 0) {
                    return ctx.reply('❌ Usage: `!xp_boost @role <multiplier>` (e.g. `!xp_boost @VIP 1.5`)');
                }

                await db.query(
                    'INSERT INTO level_boosts (guild_id, role_id, multiplier) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE multiplier = ?',
                    [ctx.guild.id, roleId, mult, mult]
                );

                ctx.reply({ embeds: [
                    new EmbedBuilder()
                        .setDescription(`✅ Users with role <@&${roleId}> will now receive **${mult}x** XP!`)
                        .setColor('#57F287')
                ] });
            }
        },

        // ── !xp_boost_remove ─────────────────────────────────────────────────
        {
            name: 'xp_boost_remove',
            description: 'Remove XP multiplier boost from a role',
            options: [
                { name: 'role', description: 'Role to remove boost from', type: ApplicationCommandOptionType.Role, required: true }
            ],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ManageGuild))
                    return ctx.reply('❌ You need **Manage Server** permission.');

                let roleId;
                if (isSlash) {
                    roleId = ctx.options.getRole('role').id;
                } else {
                    roleId = args[0]?.replace(/[<@&>]/g, '');
                }

                if (!roleId) return ctx.reply('❌ Please mention a valid role.');

                const res = await db.query('DELETE FROM level_boosts WHERE guild_id = ? AND role_id = ?', [ctx.guild.id, roleId]);
                if (res.affectedRows === 0) {
                    return ctx.reply('ℹ️ This role does not have an XP boost configured.');
                }

                ctx.reply(`✅ Removed XP boost for role <@&${roleId}>.`);
            }
        },

        // ── !xp_boosts ───────────────────────────────────────────────────────
        {
            name: 'xp_boosts',
            description: 'List all active role XP boosts',
            async execute(ctx, db) {
                const boosts = await db.query('SELECT role_id, multiplier FROM level_boosts WHERE guild_id = ?', [ctx.guild.id]);
                if (!boosts.length) return ctx.reply('ℹ️ No role XP boosts configured for this server.');

                const embed = new EmbedBuilder()
                    .setTitle('🚀 Active XP Boosts')
                    .setColor('#9B59B6')
                    .setDescription(boosts.map(b => `<@&${b.role_id}>: **${parseFloat(b.multiplier)}x** XP`).join('\n'))
                    .setTimestamp();

                ctx.reply({ embeds: [embed] });
            }
        },

        // ── !xp_ignore_role ──────────────────────────────────────────────────
        {
            name: 'xp_ignore_role',
            description: 'Toggle XP gain on/off for a role',
            options: [{ name: 'role', description: 'Role to toggle', type: ApplicationCommandOptionType.Role, required: true }],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ManageGuild))
                    return ctx.reply('❌ You need **Manage Server** permission.');

                let roleId;
                if (isSlash) {
                    roleId = ctx.options.getRole('role').id;
                } else {
                    roleId = args[0]?.replace(/[<@&>]/g, '');
                }
                if (!roleId) return ctx.reply('❌ Please mention a role.');

                const res = await db.query('SELECT ignored_roles FROM level_settings WHERE guild_id = ?', [ctx.guild.id]);
                const ignored = (res[0]?.ignored_roles || '').split(',').filter(Boolean);
                const idx     = ignored.indexOf(roleId);

                if (idx === -1) {
                    ignored.push(roleId);
                    await db.query(
                        'INSERT INTO level_settings (guild_id, ignored_roles) VALUES (?, ?) ON DUPLICATE KEY UPDATE ignored_roles = ?',
                        [ctx.guild.id, ignored.join(','), ignored.join(',')]
                    );
                    ctx.reply(`✅ Members with role <@&${roleId}> will no longer earn XP.`);
                } else {
                    ignored.splice(idx, 1);
                    await db.query(
                        'INSERT INTO level_settings (guild_id, ignored_roles) VALUES (?, ?) ON DUPLICATE KEY UPDATE ignored_roles = ?',
                        [ctx.guild.id, ignored.join(','), ignored.join(',')]
                    );
                    ctx.reply(`✅ Members with role <@&${roleId}> will now earn XP again.`);
                }
            }
        },

        // ── !xp_ignore (channels) ────────────────────────────────────────────
        {
            name: 'xp_ignore',
            description: 'Toggle XP gain on/off for a channel',
            options: [{ name: 'channel', description: 'Channel to toggle', type: ApplicationCommandOptionType.Channel, required: true }],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ManageGuild))
                    return ctx.reply('❌ You need **Manage Server** permission.');

                const chanId = isSlash
                    ? ctx.options.getChannel('channel').id
                    : args[0]?.replace(/[<#>]/g, '');
                if (!chanId) return ctx.reply('❌ Please mention a channel.');

                const res = await db.query('SELECT ignored_channels FROM level_settings WHERE guild_id = ?', [ctx.guild.id]);
                const ignored = (res[0]?.ignored_channels || '').split(',').filter(Boolean);
                const idx     = ignored.indexOf(chanId);

                if (idx === -1) {
                    ignored.push(chanId);
                    await db.query(
                        'INSERT INTO level_settings (guild_id, ignored_channels) VALUES (?, ?) ON DUPLICATE KEY UPDATE ignored_channels = ?',
                        [ctx.guild.id, ignored.join(','), ignored.join(',')]
                    );
                    ctx.reply(`✅ <#${chanId}> is now **ignored** — no XP will be earned there.`);
                } else {
                    ignored.splice(idx, 1);
                    await db.query(
                        'INSERT INTO level_settings (guild_id, ignored_channels) VALUES (?, ?) ON DUPLICATE KEY UPDATE ignored_channels = ?',
                        [ctx.guild.id, ignored.join(','), ignored.join(',')]
                    );
                    ctx.reply(`✅ <#${chanId}> is now **enabled** — XP will be earned there again.`);
                }
            }
        },

        // ── !xp_ignored ──────────────────────────────────────────────────────
        {
            name: 'xp_ignored',
            description: 'List all ignored channels and roles',
            async execute(ctx, db) {
                const res = await db.query('SELECT ignored_channels, ignored_roles FROM level_settings WHERE guild_id = ?', [ctx.guild.id]);
                const ignoredChans = (res[0]?.ignored_channels || '').split(',').filter(Boolean);
                const ignoredRoles = (res[0]?.ignored_roles || '').split(',').filter(Boolean);

                const embed = new EmbedBuilder()
                    .setTitle('🔕 Ignored Channels & Roles')
                    .setColor('#E67E22')
                    .addFields(
                        { name: '📺 Ignored Channels', value: ignoredChans.map(id => `<#${id}>`).join(', ') || 'None' },
                        { name: '🎭 Ignored Roles', value: ignoredRoles.map(id => `<@&${id}>`).join(', ') || 'None' }
                    )
                    .setTimestamp();

                ctx.reply({ embeds: [embed] });
            }
        },

        // ── !xp_set ───────────────────────────────────────────────────────────
        {
            name: 'xp_set',
            description: '(Admin) Set a user\'s XP directly',
            options: [
                { name: 'user', description: 'Target user', type: ApplicationCommandOptionType.User,    required: true },
                { name: 'xp',   description: 'XP amount',   type: ApplicationCommandOptionType.Integer, required: true }
            ],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.Administrator))
                    return ctx.reply('❌ Administrator only.');

                const targetId = isSlash
                    ? ctx.options.getUser('user').id
                    : args[0]?.replace(/[<@!>]/g, '');
                const newXP = isSlash ? ctx.options.getInteger('xp') : parseInt(args[1]);
                if (!targetId || isNaN(newXP) || newXP < 0) return ctx.reply('❌ Invalid input.');

                const newLevel = xpToLevel(newXP);
                await db.query(
                    'INSERT INTO levels (guild_id, user_id, xp, level) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE xp = ?, level = ?',
                    [ctx.guild.id, targetId, newXP, newLevel, newXP, newLevel]
                );
                ctx.reply(`✅ Set <@${targetId}>'s XP to **${newXP}** (Level **${newLevel}**).`);
            }
        },

        // ── !xp_add ───────────────────────────────────────────────────────────
        {
            name: 'xp_add',
            description: '(Admin) Add XP to a user',
            options: [
                { name: 'user', description: 'Target user', type: ApplicationCommandOptionType.User,    required: true },
                { name: 'xp',   description: 'XP to add',   type: ApplicationCommandOptionType.Integer, required: true }
            ],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.Administrator))
                    return ctx.reply('❌ Administrator only.');

                const targetId = isSlash
                    ? ctx.options.getUser('user').id
                    : args[0]?.replace(/[<@!>]/g, '');
                const addXP = isSlash ? ctx.options.getInteger('xp') : parseInt(args[1]);
                if (!targetId || isNaN(addXP)) return ctx.reply('❌ Invalid input.');

                const row      = await getUserRow(db, ctx.guild.id, targetId);
                const newXP    = Math.max(0, row.xp + addXP);
                const newLevel = xpToLevel(newXP);
                await db.query(
                    'INSERT INTO levels (guild_id, user_id, xp, level) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE xp = ?, level = ?',
                    [ctx.guild.id, targetId, newXP, newLevel, newXP, newLevel]
                );
                ctx.reply(`✅ Added **${addXP} XP** to <@${targetId}>. Now at **${newXP} XP** (Level **${newLevel}**).`);
            }
        },

        // ── !xp_reset ─────────────────────────────────────────────────────────
        {
            name: 'xp_reset',
            description: '(Admin) Reset a user\'s XP and level to 0',
            options: [{ name: 'user', description: 'Target user', type: ApplicationCommandOptionType.User, required: true }],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.Administrator))
                    return ctx.reply('❌ Administrator only.');

                const targetId = isSlash
                    ? ctx.options.getUser('user').id
                    : args[0]?.replace(/[<@!>]/g, '');
                if (!targetId) return ctx.reply('❌ Please mention a user.');

                await db.query(
                    'INSERT INTO levels (guild_id, user_id, xp, level) VALUES (?, ?, 0, 0) ON DUPLICATE KEY UPDATE xp = 0, level = 0',
                    [ctx.guild.id, targetId]
                );
                ctx.reply(`✅ Reset <@${targetId}>'s XP and level to 0.`);
            }
        }
    ],

    rules: [
        {
            name: 'XPGain',
            event: 'messageCreate',
            async execute(message, db) {
                if (message.author.bot || !message.guild) return;

                // Cooldown check
                const key      = `${message.guild.id}:${message.author.id}`;
                const lastGain = cooldowns.get(key) || 0;
                if (Date.now() - lastGain < XP_COOLDOWN_MS) return;
                cooldowns.set(key, Date.now());

                // Fetch leveling settings
                const settings = await db.query('SELECT * FROM level_settings WHERE guild_id = ?', [message.guild.id]);
                const cfg      = settings[0];

                // Check if this channel is ignored
                const ignoredChans = (cfg?.ignored_channels || '').split(',').filter(Boolean);
                if (ignoredChans.includes(message.channel.id)) return;

                // Check if user has an ignored role
                const ignoredRoles = (cfg?.ignored_roles || '').split(',').filter(Boolean);
                if (message.member && ignoredRoles.some(id => message.member.roles.cache.has(id))) return;

                // Calculate role-based XP boosts
                const boosts = await db.query('SELECT role_id, multiplier FROM level_boosts WHERE guild_id = ?', [message.guild.id]);
                let maxMultiplier = 1.0;
                if (message.member) {
                    for (const b of boosts) {
                        if (message.member.roles.cache.has(b.role_id)) {
                            const mult = parseFloat(b.multiplier);
                            if (mult > maxMultiplier) maxMultiplier = mult;
                        }
                    }
                }

                // Award XP
                const row      = await getUserRow(db, message.guild.id, message.author.id);
                const earned   = Math.round(XP_PER_MESSAGE() * maxMultiplier);
                const newXP    = row.xp + earned;
                const newLevel = xpToLevel(newXP);

                await db.query(
                    'INSERT INTO levels (guild_id, user_id, xp, level) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE xp = ?, level = ?',
                    [message.guild.id, message.author.id, newXP, newLevel, newXP, newLevel]
                );

                if (newLevel > row.level) {
                    await handleLevelUp(message, db, newLevel, cfg);
                }
            }
        }
    ]
};

// ── Level-up handler ─────────────────────────────────────────────────────────
async function handleLevelUp(message, db, newLevel, settings) {
    const member = message.member;
    const guild  = message.guild;

    // 1. Assign role reward if one exists for this level
    const roleRes = await db.query(
        'SELECT role_id FROM level_roles WHERE guild_id = ? AND level = ?',
        [guild.id, newLevel]
    );
    if (roleRes.length) {
        const rewardRoleId = roleRes[0].role_id;
        const role = guild.roles.cache.get(rewardRoleId);
        if (role) {
            await member.roles.add(role).catch(err =>
                console.error(`❌ Failed to assign level role: ${err.message}`)
            );

            // If stacking is disabled, remove other lower reward roles
            const isStack = settings?.stack_roles ?? 1;
            if (!isStack) {
                const allLevelRoles = await db.query(
                    'SELECT level, role_id FROM level_roles WHERE guild_id = ?',
                    [guild.id]
                );
                for (const lr of allLevelRoles) {
                    if (lr.level !== newLevel && member.roles.cache.has(lr.role_id)) {
                        await member.roles.remove(lr.role_id).catch(() => {});
                    }
                }
            }
        }
    }

    // 2. Resolve announcement
    const type = settings?.announce_type || 'channel';
    if (type === 'disabled') return;

    let targetChannel = null;
    if (type === 'current') {
        targetChannel = message.channel;
    } else if (type === 'channel') {
        const announceChannelId = settings?.announce_channel;
        if (announceChannelId) {
            targetChannel = guild.channels.cache.get(announceChannelId);
        }
    }

    // Prepare custom message
    const defaultMsg = 'Congratulations {user}! You reached **Level {level}**!';
    const rawMsg = settings?.announce_msg || defaultMsg;
    const resolvedMsg = rawMsg
        .replace(/{user}/g, `<@${member.id}>`)
        .replace(/{username}/g, member.user.username)
        .replace(/{level}/g, newLevel)
        .replace(/{xp}/g, (await getUserRow(db, guild.id, member.id)).xp.toLocaleString());

    const embed = new EmbedBuilder()
        .setTitle('⭐ Level Up!')
        .setColor('#FFD700')
        .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
        .setDescription(resolvedMsg)
        .setTimestamp();

    if (type === 'dm') {
        await member.send({ embeds: [embed] }).catch(() => {});
    } else if (targetChannel) {
        await targetChannel.send({ embeds: [embed] }).catch(() => {});
    }
}

// ── XP / Level math ──────────────────────────────────────────────────────────
function xpForLevel(level) {
    return (level * (level + 1) / 2) * 100;
}

function xpToNextLevel(level) {
    return (level + 1) * 100;
}

function xpToLevel(xp) {
    return Math.max(0, Math.floor((-1 + Math.sqrt(1 + 8 * xp / 100)) / 2));
}

async function getUserRow(db, guildId, userId) {
    const res = await db.query('SELECT * FROM levels WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    return res[0] || { xp: 0, level: 0 };
}

function buildProgressBar(percent, length = 20) {
    const filled = Math.round((percent / 100) * length);
    return '█'.repeat(filled) + '░'.repeat(length - filled);
}
