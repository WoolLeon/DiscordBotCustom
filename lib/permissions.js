import { PermissionFlagsBits } from 'discord.js';

/** @type {Map<string, 'everyone'|'member'|'admin'>} */
const cache = new Map();

const LEVELS = ['everyone', 'member', 'admin'];

export function isValidLevel(level) {
    return LEVELS.includes(level);
}

function cacheKey(guildId, targetType, targetName) {
    return `${guildId}:${targetType}:${targetName}`;
}

export async function initPermissions(db) {
    await db.query(`CREATE TABLE IF NOT EXISTS command_permissions (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        guild_id     VARCHAR(64) NOT NULL,
        target_type  ENUM('plugin', 'command') NOT NULL,
        target_name  VARCHAR(128) NOT NULL,
        access_level ENUM('everyone', 'member', 'admin') NOT NULL DEFAULT 'everyone',
        UNIQUE KEY guild_target (guild_id, target_type, target_name)
    );`);
    await refreshPermissionCache(db);
}

export async function refreshPermissionCache(db) {
    cache.clear();
    const rows = await db.query('SELECT * FROM command_permissions');
    for (const row of rows) {
        cache.set(
            cacheKey(row.guild_id, row.target_type, row.target_name),
            row.access_level,
        );
    }
}

function getStoredLevel(guildId, targetType, targetName) {
    return cache.get(cacheKey(guildId, targetType, targetName));
}

/**
 * Resolve required access for a command (command rule overrides plugin rule).
 */
export function getRequiredLevel(guildId, commandName, client) {
    if (cache.has(cacheKey(guildId, 'command', commandName))) {
        return getStoredLevel(guildId, 'command', commandName);
    }

    const pluginKey = client.commandPlugins?.get(commandName);
    if (pluginKey && cache.has(cacheKey(guildId, 'plugin', pluginKey))) {
        return getStoredLevel(guildId, 'plugin', pluginKey);
    }
    return 'everyone';
}

export function isAdmin(member) {
    if (!member) return false;
    return member.permissions.has(PermissionFlagsBits.Administrator)
        || member.permissions.has(PermissionFlagsBits.ManageGuild);
}

/** Has at least one role besides @everyone */
export function isVerifiedMember(member) {
    if (!member?.guild) return false;
    return member.roles.cache.filter(r => r.id !== member.guild.id).size > 0;
}

export function meetsAccessLevel(member, level) {
    if (!member) return level === 'everyone';
    if (isAdmin(member)) return true;

    if (level === 'everyone') return true;
    if (level === 'member') return isVerifiedMember(member);
    if (level === 'admin') return false;
    return true;
}

export function canUseCommand(member, guildId, commandName, client) {
    if (!guildId || !member) return true;
    const level = getRequiredLevel(guildId, commandName, client);
    return meetsAccessLevel(member, level);
}

export function denyMessage(level) {
    if (level === 'admin') {
        return '❌ This command is restricted to **server administrators**.';
    }
    if (level === 'member') {
        return '❌ This command is restricted to **members with a role** (not @everyone-only).';
    }
    return '❌ You do not have permission to use this command.';
}

export function buildPermissionCatalog(client) {
    return (client.pluginCatalog || []).map(p => ({
        key: p.key,
        name: p.name,
        commands: p.commands.map(c => ({
            name: c.name,
            description: c.description || '',
            level: 'everyone',
        })),
        level: 'everyone',
    }));
}

export function applyPermissionState(catalog, guildId) {
    if (!guildId) return catalog;
    return catalog.map(p => ({
        ...p,
        level: cache.has(cacheKey(guildId, 'plugin', p.key))
            ? getStoredLevel(guildId, 'plugin', p.key)
            : 'everyone',
        commands: p.commands.map(c => ({
            ...c,
            level: cache.has(cacheKey(guildId, 'command', c.name))
                ? getStoredLevel(guildId, 'command', c.name)
                : (cache.has(cacheKey(guildId, 'plugin', p.key))
                    ? getStoredLevel(guildId, 'plugin', p.key)
                    : 'everyone'),
        })),
    }));
}

export async function saveGuildPermissions(db, guildId, plugins, commands) {
    await db.query('DELETE FROM command_permissions WHERE guild_id = ?', [guildId]);

    for (const [key, level] of Object.entries(plugins)) {
        if (!isValidLevel(level) || level === 'everyone') continue;
        await db.query(
            'INSERT INTO command_permissions (guild_id, target_type, target_name, access_level) VALUES (?, ?, ?, ?)',
            [guildId, 'plugin', key, level],
        );
    }

    // Save every command row from the form so per-command "everyone" can override a stricter plugin default.
    for (const [name, level] of Object.entries(commands)) {
        if (!isValidLevel(level)) continue;
        await db.query(
            'INSERT INTO command_permissions (guild_id, target_type, target_name, access_level) VALUES (?, ?, ?, ?)',
            [guildId, 'command', name, level],
        );
    }

    await refreshPermissionCache(db);
}
