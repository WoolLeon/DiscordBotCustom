import {
    PermissionFlagsBits,
    ApplicationCommandOptionType,
    EmbedBuilder,
    Events,
} from 'discord.js';

const DEFAULT_WELCOME = 'Welcome {user} to **{server}**! You are member #{membercount}.';
const DEFAULT_GOODBYE = '{user} has left **{server}**. We now have {membercount} members.';

const formatTemplate = (template, member) => {
    const g = member.guild;
    return template
        .replaceAll('{user}', member.toString())
        .replaceAll('{username}', member.user.username)
        .replaceAll('{server}', g.name)
        .replaceAll('{membercount}', String(g.memberCount));
};

export default {
    name: 'Welcome & Auto-Role',
    help: [
        { usage: '`!welcome_setup #channel [message]`', description: 'Set welcome channel and message. Placeholders: `{user}` `{server}` `{membercount}`' },
        { usage: '`!goodbye_setup #channel [message]`', description: 'Set goodbye channel and message (same placeholders).' },
        { usage: '`!welcome_disable`', description: 'Disable welcome messages.' },
        { usage: '`!goodbye_disable`', description: 'Disable goodbye messages.' },
        { usage: '`!autorole @role`', description: 'Add a role given to new members on join.' },
        { usage: '`!autorole_remove @role`', description: 'Remove an auto-role.' },
        { usage: '`!autorole_list`', description: 'List configured auto-roles.' },
    ],

    init: async (db) => {
        await db.query(`CREATE TABLE IF NOT EXISTS welcome_settings (
            guild_id   VARCHAR(64) PRIMARY KEY,
            channel_id VARCHAR(64) NOT NULL,
            message    TEXT NOT NULL
        );`);
        await db.query(`CREATE TABLE IF NOT EXISTS goodbye_settings (
            guild_id   VARCHAR(64) PRIMARY KEY,
            channel_id VARCHAR(64) NOT NULL,
            message    TEXT NOT NULL
        );`);
        await db.query(`CREATE TABLE IF NOT EXISTS autoroles (
            id       INT AUTO_INCREMENT PRIMARY KEY,
            guild_id VARCHAR(64) NOT NULL,
            role_id  VARCHAR(64) NOT NULL,
            UNIQUE KEY guild_role (guild_id, role_id)
        );`);
    },

    commands: [
        {
            name: 'welcome_setup',
            description: 'Configure welcome messages',
            options: [
                { name: 'channel', type: ApplicationCommandOptionType.Channel, required: true },
                { name: 'message', type: ApplicationCommandOptionType.String, required: false },
            ],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ManageGuild))
                    return ctx.reply('❌ You need **Manage Server**.');

                const channel = isSlash
                    ? ctx.options.getChannel('channel')
                    : ctx.guild.channels.cache.get(args[0]?.replace(/[<#>]/g, ''));
                if (!channel?.isTextBased?.()) return ctx.reply('❌ Provide a valid text channel.');

                const message = (isSlash ? ctx.options.getString('message') : args.slice(1).join(' '))
                    || DEFAULT_WELCOME;

                await db.query(
                    'REPLACE INTO welcome_settings (guild_id, channel_id, message) VALUES (?, ?, ?)',
                    [ctx.guild.id, channel.id, message],
                );
                ctx.reply(`✅ Welcome messages will be sent in ${channel}.`);
            },
        },
        {
            name: 'goodbye_setup',
            description: 'Configure goodbye messages',
            options: [
                { name: 'channel', type: ApplicationCommandOptionType.Channel, required: true },
                { name: 'message', type: ApplicationCommandOptionType.String, required: false },
            ],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ManageGuild))
                    return ctx.reply('❌ You need **Manage Server**.');

                const channel = isSlash
                    ? ctx.options.getChannel('channel')
                    : ctx.guild.channels.cache.get(args[0]?.replace(/[<#>]/g, ''));
                if (!channel?.isTextBased?.()) return ctx.reply('❌ Provide a valid text channel.');

                const message = (isSlash ? ctx.options.getString('message') : args.slice(1).join(' '))
                    || DEFAULT_GOODBYE;

                await db.query(
                    'REPLACE INTO goodbye_settings (guild_id, channel_id, message) VALUES (?, ?, ?)',
                    [ctx.guild.id, channel.id, message],
                );
                ctx.reply(`✅ Goodbye messages will be sent in ${channel}.`);
            },
        },
        {
            name: 'welcome_disable',
            description: 'Disable welcome messages',
            async execute(ctx, db) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ManageGuild))
                    return ctx.reply('❌ You need **Manage Server**.');
                await db.query('DELETE FROM welcome_settings WHERE guild_id = ?', [ctx.guild.id]);
                ctx.reply('✅ Welcome messages disabled.');
            },
        },
        {
            name: 'goodbye_disable',
            description: 'Disable goodbye messages',
            async execute(ctx, db) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ManageGuild))
                    return ctx.reply('❌ You need **Manage Server**.');
                await db.query('DELETE FROM goodbye_settings WHERE guild_id = ?', [ctx.guild.id]);
                ctx.reply('✅ Goodbye messages disabled.');
            },
        },
        {
            name: 'autorole',
            description: 'Add an auto-role for new members',
            options: [
                { name: 'role', type: ApplicationCommandOptionType.Role, required: true },
            ],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ManageRoles))
                    return ctx.reply('❌ You need **Manage Roles**.');

                const role = isSlash
                    ? ctx.options.getRole('role')
                    : ctx.mentions.roles.first()
                        ?? ctx.guild.roles.cache.get(args[0]?.replace(/[<@&>]/g, ''));
                if (!role) return ctx.reply('❌ Provide a valid role.');
                if (role.managed) return ctx.reply('❌ Cannot use bot/integration roles.');
                if (role.position >= ctx.guild.members.me.roles.highest.position)
                    return ctx.reply('❌ That role is above my highest role.');

                await db.query(
                    'INSERT IGNORE INTO autoroles (guild_id, role_id) VALUES (?, ?)',
                    [ctx.guild.id, role.id],
                );
                ctx.reply(`✅ New members will receive ${role}.`);
            },
        },
        {
            name: 'autorole_remove',
            description: 'Remove an auto-role',
            options: [
                { name: 'role', type: ApplicationCommandOptionType.Role, required: true },
            ],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ManageRoles))
                    return ctx.reply('❌ You need **Manage Roles**.');

                const roleId = isSlash
                    ? ctx.options.getRole('role').id
                    : (ctx.mentions.roles.first()?.id ?? args[0]?.replace(/\D/g, ''));

                await db.query('DELETE FROM autoroles WHERE guild_id = ? AND role_id = ?', [ctx.guild.id, roleId]);
                ctx.reply('✅ Auto-role removed.');
            },
        },
        {
            name: 'autorole_list',
            description: 'List auto-roles',
            async execute(ctx, db) {
                const rows = await db.query('SELECT role_id FROM autoroles WHERE guild_id = ?', [ctx.guild.id]);
                if (!rows.length) return ctx.reply('ℹ️ No auto-roles configured.');
                ctx.reply('**Auto-roles:**\n' + rows.map(r => `<@&${r.role_id}>`).join('\n'));
            },
        },
    ],

    rules: [
        {
            name: 'MemberWelcome',
            event: Events.GuildMemberAdd,
            async execute(member, db) {
                if (member.user.bot) return;

                const roles = await db.query('SELECT role_id FROM autoroles WHERE guild_id = ?', [member.guild.id]);
                for (const r of roles) {
                    await member.roles.add(r.role_id).catch(() => {});
                }

                const cfg = await db.query('SELECT * FROM welcome_settings WHERE guild_id = ?', [member.guild.id]);
                if (!cfg[0]) return;

                const ch = member.guild.channels.cache.get(cfg[0].channel_id);
                if (!ch?.isTextBased()) return;

                const text = formatTemplate(cfg[0].message, member);
                const embed = new EmbedBuilder()
                    .setDescription(text)
                    .setColor('#57F287')
                    .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
                    .setTimestamp();
                ch.send({ embeds: [embed] }).catch(() => {});
            },
        },
        {
            name: 'MemberGoodbye',
            event: Events.GuildMemberRemove,
            async execute(member, db) {
                if (member.user?.bot) return;

                const cfg = await db.query('SELECT * FROM goodbye_settings WHERE guild_id = ?', [member.guild.id]);
                if (!cfg[0]) return;

                const ch = member.guild.channels.cache.get(cfg[0].channel_id);
                if (!ch?.isTextBased()) return;

                const text = formatTemplate(cfg[0].message, member);
                ch.send(text).catch(() => {});
            },
        },
    ],
};
