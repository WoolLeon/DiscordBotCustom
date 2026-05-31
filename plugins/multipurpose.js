import { ApplicationCommandOptionType, PermissionFlagsBits } from 'discord.js';

export default {
    name: 'Multipurpose Tools',
    help: [
        { usage: '`!purge [1-100]`',                    description: 'Bulk delete messages.' },
        { usage: '`!add_rr [msgID] [emoji] @role`',     description: 'Add a reaction role to a message.' },
        { usage: '`!remove_rr <messageID> <emoji>`',      description: 'Remove a reaction role binding.' },
        { usage: '`!list_rr`',                          description: 'List reaction roles in this server.' },
    ],

    init: async (db) => {
        await db.query(`CREATE TABLE IF NOT EXISTS reaction_roles (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            guild_id   VARCHAR(64) NOT NULL,
            message_id VARCHAR(64) NOT NULL,
            emoji      VARCHAR(64) NOT NULL,
            role_id    VARCHAR(64) NOT NULL
        );`);
    },

    commands: [
        {
            name: 'purge',
            description: 'Bulk delete messages (1–100)',
            options: [{ name: 'amount', description: 'Number of messages to delete', type: ApplicationCommandOptionType.Integer, required: true }],
            async execute(ctx, db, isSlash, args) {
                if (!ctx.member.permissions.has(PermissionFlagsBits.ManageMessages))
                    return ctx.reply('❌ You need the **Manage Messages** permission.');

                const amt = Math.min(100, Math.max(1, parseInt(isSlash ? ctx.options.getInteger('amount') : args[0]) || 0));
                if (!amt) return ctx.reply('❌ Please provide a number between 1 and 100.');

                await ctx.channel.bulkDelete(amt, true);
                const reply = await ctx.reply(`✅ Deleted ${amt} messages.`);
                setTimeout(() => reply.delete().catch(() => {}), 2000);
            }
        },
        {
            // FIX: Renamed from 'add-rr' (invalid hyphen) → 'add_rr'
            name: 'add_rr',
            description: 'Add a reaction role (prefix only)',
            async execute(ctx, db, isSlash, args) {
                // Usage: !add_rr <messageId> <emoji> <@role>
                const [msgId, emoji, rawRole] = args;
                if (!msgId || !emoji || !rawRole)
                    return ctx.reply('❌ Usage: `!add_rr <messageID> <emoji> @role`');

                const roleId = rawRole.replace(/[<@&>]/g, '');
                await db.query(
                    'INSERT INTO reaction_roles (guild_id, message_id, emoji, role_id) VALUES (?, ?, ?, ?)',
                    [ctx.guild.id, msgId, emoji, roleId]
                );
                ctx.reply(`✅ Reaction role set! React with ${emoji} on message \`${msgId}\` to receive <@&${roleId}>.`);
            }
        },
        {
            name: 'remove_rr',
            description: 'Remove a reaction role binding',
            async execute(ctx, db, isSlash, args) {
                const [msgId, emoji] = args;
                if (!msgId || !emoji) return ctx.reply('❌ Usage: `!remove_rr <messageID> <emoji>`');

                const res = await db.query(
                    'DELETE FROM reaction_roles WHERE guild_id = ? AND message_id = ? AND emoji = ?',
                    [ctx.guild.id, msgId, emoji],
                );
                if (!res.affectedRows) return ctx.reply('❌ No matching reaction role found.');
                ctx.reply('✅ Reaction role removed.');
            },
        },
        {
            name: 'list_rr',
            description: 'List reaction roles in this server',
            async execute(ctx, db) {
                const rows = await db.query(
                    'SELECT message_id, emoji, role_id FROM reaction_roles WHERE guild_id = ?',
                    [ctx.guild.id],
                );
                if (!rows.length) return ctx.reply('ℹ️ No reaction roles configured.');
                const lines = rows.map(r =>
                    `Message \`${r.message_id}\` • ${r.emoji} → <@&${r.role_id}>`
                ).join('\n');
                ctx.reply('**Reaction roles:**\n' + lines.slice(0, 1900));
            },
        },
    ],

    rules: [
        {
            name: 'RRHandler',
            event: 'messageReactionAdd',
            async execute(r, u, db) {
                if (u.bot) return;
                if (r.partial) await r.fetch().catch(() => {});
                const emojiKey = r.emoji.id ?? r.emoji.name;
                const res = await db.query(
                    'SELECT role_id FROM reaction_roles WHERE message_id = ? AND emoji = ?',
                    [r.message.id, emojiKey],
                );
                if (res[0]) {
                    const member = r.message.guild.members.cache.get(u.id)
                        || await r.message.guild.members.fetch(u.id).catch(() => null);
                    if (member) member.roles.add(res[0].role_id).catch(() => {});
                }
            },
        },
        {
            name: 'RRRemoveHandler',
            event: 'messageReactionRemove',
            async execute(r, u, db) {
                if (u.bot) return;
                if (r.partial) await r.fetch().catch(() => {});
                const emojiKey = r.emoji.id ?? r.emoji.name;
                const res = await db.query(
                    'SELECT role_id FROM reaction_roles WHERE message_id = ? AND emoji = ?',
                    [r.message.id, emojiKey],
                );
                if (res[0]) {
                    const member = r.message.guild.members.cache.get(u.id)
                        || await r.message.guild.members.fetch(u.id).catch(() => null);
                    if (member) member.roles.remove(res[0].role_id).catch(() => {});
                }
            },
        },
    ],
};
