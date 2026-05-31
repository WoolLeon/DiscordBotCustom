const columns = [
    ['live_channel_id', 'VARCHAR(64) DEFAULT NULL'],
    ['upload_channel_id', 'VARCHAR(64) DEFAULT NULL'],
    ['live_ping_role_id', 'VARCHAR(64) DEFAULT NULL'],
    ['upload_ping_role_id', 'VARCHAR(64) DEFAULT NULL'],
    ['live_enabled', 'TINYINT(1) DEFAULT 1'],
    ['upload_enabled', 'TINYINT(1) DEFAULT 1'],
    ['live_message', 'TEXT DEFAULT NULL'],
    ['upload_message', 'TEXT DEFAULT NULL'],
];

export async function migrateAnnounceSettings(db) {
    for (const [name, def] of columns) {
        try {
            await db.query(`ALTER TABLE announce_settings ADD COLUMN ${name} ${def}`);
        } catch {
            /* column exists */
        }
    }

    try {
        await db.query(`
            UPDATE announce_settings
            SET live_channel_id = COALESCE(live_channel_id, channel_id),
                upload_channel_id = COALESCE(upload_channel_id, channel_id),
                live_ping_role_id = COALESCE(live_ping_role_id, ping_role_id),
                upload_ping_role_id = COALESCE(upload_ping_role_id, ping_role_id)
            WHERE channel_id IS NOT NULL
        `);
    } catch {
        /* legacy columns missing */
    }
}
