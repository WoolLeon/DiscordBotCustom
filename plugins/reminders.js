import { ApplicationCommandOptionType, EmbedBuilder } from 'discord.js';

const parseDuration = (input) => {
    const m = String(input).trim().match(/^(\d+)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/i);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const unit = (m[2] || 'm').toLowerCase();
    const mult = { s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
        m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
        h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
        d: 86_400_000, day: 86_400_000, days: 86_400_000 };
    const ms = n * (mult[unit] ?? 60_000);
    if (ms < 10_000 || ms > 86_400_000 * 30) return null;
    return ms;
};

export default {
    name: 'Reminders',
    help: [
        { usage: '`!remind <time> <message>`', description: 'Set a reminder (e.g. `30m`, `2h`, `1d`). Max 30 days.' },
        { usage: '`!reminders`', description: 'List your pending reminders in this server.' },
        { usage: '`!remind_cancel <id>`', description: 'Cancel a reminder by ID.' },
    ],

    init: async (db) => {
        await db.query(`CREATE TABLE IF NOT EXISTS reminders (
            id         INT AUTO_INCREMENT PRIMARY KEY,
            user_id    VARCHAR(64) NOT NULL,
            guild_id   VARCHAR(64) NOT NULL,
            channel_id VARCHAR(64) NOT NULL,
            message    TEXT NOT NULL,
            fire_at    BIGINT NOT NULL
        );`);

        setInterval(async () => {
            try {
                const due = await db.query('SELECT * FROM reminders WHERE fire_at <= ?', [Date.now()]);
                for (const r of due) {
                    const ch = global.client.channels.cache.get(r.channel_id);
                    if (ch?.isTextBased()) {
                        const embed = new EmbedBuilder()
                            .setTitle('⏰ Reminder')
                            .setDescription(r.message)
                            .setColor('#FEE75C')
                            .setFooter({ text: `Reminder #${r.id}` });
                        await ch.send({ content: `<@${r.user_id}>`, embeds: [embed] }).catch(() => {});
                    }
                    await db.query('DELETE FROM reminders WHERE id = ?', [r.id]);
                }
            } catch (err) {
                console.error('Reminder tick error:', err.message);
            }
        }, 15_000);
    },

    commands: [
        {
            name: 'remind',
            description: 'Set a reminder',
            options: [
                { name: 'time', description: 'e.g. 30m, 2h, 1d', type: ApplicationCommandOptionType.String, required: true },
                { name: 'message', type: ApplicationCommandOptionType.String, required: true },
            ],
            async execute(ctx, db, isSlash, args) {
                const timeStr = isSlash ? ctx.options.getString('time') : args[0];
                const text = isSlash
                    ? ctx.options.getString('message')
                    : args.slice(1).join(' ');

                const ms = parseDuration(timeStr);
                if (!ms) return ctx.reply('❌ Invalid time. Examples: `30m`, `2h`, `1d` (10s – 30 days).');
                if (!text?.trim()) return ctx.reply('❌ Provide a reminder message.');

                const fireAt = Date.now() + ms;
                const userId = ctx.user?.id ?? ctx.author.id;
                const result = await db.query(
                    'INSERT INTO reminders (user_id, guild_id, channel_id, message, fire_at) VALUES (?, ?, ?, ?, ?)',
                    [userId, ctx.guild.id, ctx.channel.id, text.trim(), fireAt],
                );

                const when = Math.floor(fireAt / 1000);
                ctx.reply(`✅ Reminder **#${result.insertId}** set for <t:${when}:R> in this channel.`);
            },
        },
        {
            name: 'reminders',
            description: 'List your pending reminders',
            async execute(ctx, db) {
                const userId = ctx.user?.id ?? ctx.author.id;
                const rows = await db.query(
                    'SELECT * FROM reminders WHERE user_id = ? AND guild_id = ? ORDER BY fire_at ASC',
                    [userId, ctx.guild.id],
                );
                if (!rows.length) return ctx.reply('ℹ️ You have no pending reminders here.');

                const lines = rows.map(r =>
                    `**#${r.id}** — <t:${Math.floor(r.fire_at / 1000)}:R>: ${r.message.slice(0, 80)}`
                ).join('\n');
                ctx.reply('**Your reminders:**\n' + lines);
            },
        },
        {
            name: 'remind_cancel',
            description: 'Cancel a reminder by ID',
            options: [
                { name: 'id', type: ApplicationCommandOptionType.Integer, required: true },
            ],
            async execute(ctx, db, isSlash, args) {
                const id = isSlash ? ctx.options.getInteger('id') : parseInt(args[0], 10);
                const userId = ctx.user?.id ?? ctx.author.id;

                const res = await db.query(
                    'DELETE FROM reminders WHERE id = ? AND user_id = ? AND guild_id = ?',
                    [id, userId, ctx.guild.id],
                );
                if (res.affectedRows === 0) return ctx.reply('❌ Reminder not found or not yours.');
                ctx.reply(`✅ Cancelled reminder #${id}.`);
            },
        },
    ],
};
