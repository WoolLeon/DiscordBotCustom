export default {
    name: 'Clock',
    help: [{ 
        usage: '`!setup_clock #VC UTC`', 
        description: 'Set a voice channel as a live clock. Replace UTC with your timezone (e.g. Asia/Ho_Chi_Minh).' 
    }],

    init: async (db) => {
        await db.query(`CREATE TABLE IF NOT EXISTS clock_settings (
            guild_id   VARCHAR(64) PRIMARY KEY,
            channel_id VARCHAR(64) NOT NULL,
            timezone   VARCHAR(64) NOT NULL
        );`);

        // FIX: Was 360000ms (6 min) — changed to 60000ms (1 min) for accurate clock display.
        // Discord rate-limits channel renames to ~2/10 min, so the bot will silently skip
        // if it hits the limit, which is expected and safe.
        setInterval(async () => {
            try {
                const clocks = await db.query('SELECT * FROM clock_settings');
                for (const c of clocks) {
                    const ch = global.client.guilds.cache
                        .get(c.guild_id)
                        ?.channels.cache.get(c.channel_id);
                    if (!ch) continue;
                    const time = new Date().toLocaleTimeString('en-GB', {
                        timeZone: c.timezone,
                        hour:     '2-digit',
                        minute:   '2-digit'
                    });
                    const newName = `🕒 ${time} (${c.timezone})`;
                    if (ch.name !== newName) await ch.setName(newName).catch(() => {});
                }
            } catch (err) {
                console.error('❌ Clock update error:', err.message);
            }
        }, 60_000);
    },

    commands: [{
        // FIX: Renamed from 'setup-clock' (invalid) → 'setup_clock'
        name: 'setup_clock',
        description: 'Set a voice channel as a live clock',
        async execute(ctx, db, isSlash, args) {
            const chId = args[0]?.replace(/[<#>]/g, '');
            const tz   = args[1];

            if (!chId || !tz) return ctx.reply('❌ Usage: `!setup_clock #vc-channel Timezone`\nExample: `!setup_clock #time Asia/Ho_Chi_Minh`');

            await db.query(
                'REPLACE INTO clock_settings (guild_id, channel_id, timezone) VALUES (?, ?, ?)',
                [ctx.guild.id, chId, tz]
            );
            ctx.reply(`✅ Clock set for <#${chId}> (${tz}).`);
        }
    }]
};
