import express from 'express';
import bodyParser from 'body-parser';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import checkDiskSpace from 'check-disk-space';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import {
    buildPermissionCatalog,
    applyPermissionState,
    saveGuildPermissions,
} from '../lib/permissions.js';

const formatRolesArray = (val) => {
    if (!val) return '';
    if (Array.isArray(val)) return val.join(',');
    return val;
};

const buildClientGuilds = (client) => {
    if (!client?.user) return [];
    return client.guilds.cache.map(g => ({
        id: g.id,
        name: g.name,
        icon: g.iconURL() || 'https://cdn.discordapp.com/embed/avatars/0.png',
        roles: g.roles.cache
            .filter(r => r.name !== '@everyone')
            .sort((a, b) => b.position - a.position)
            .map(r => ({
                id: r.id,
                name: r.name,
                color: r.hexColor === '#000000' ? '#99aab5' : r.hexColor,
                position: r.position,
                managed: r.managed,
                hoist: r.hoist,
            })),
        channels: g.channels.cache.filter(c => c.isTextBased?.()).map(c => ({ id: c.id, name: c.name })),
        voiceChannels: g.channels.cache
            .filter(c => c.type === ChannelType.GuildVoice)
            .map(c => ({ id: c.id, name: c.name })),
        categories: g.channels.cache.filter(c => c.type === ChannelType.GuildCategory).map(c => ({
            id: c.id,
            name: c.name,
        })),
    }));
};

export default {
    name: 'Advanced Modular Dashboard',
    help: [
        { usage: 'Web UI → `http://localhost:3000`', description: 'Admin panel for bot settings. Login with `DASHBOARD_PASSWORD` from `.env`.' },
        { usage: '`/leaderboard/:guildId`', description: 'Public XP leaderboard page for a server.' },
    ],

    init: async (db) => {
        await db.query(`CREATE TABLE IF NOT EXISTS bot_settings (
            guild_id     VARCHAR(64) PRIMARY KEY,
            accent_color VARCHAR(10) DEFAULT '#5865F2'
        );`);

        await db.query(`CREATE TABLE IF NOT EXISTS radio_settings (
            id                  INT AUTO_INCREMENT PRIMARY KEY,
            guild_id            VARCHAR(64) NOT NULL,
            station_key         VARCHAR(64) NOT NULL,
            voice_channel_hint  VARCHAR(128) DEFAULT NULL
        );`);
        // Migrate: add voice_channel_hint if missing
        await db.query(`ALTER TABLE radio_settings ADD COLUMN IF NOT EXISTS voice_channel_hint VARCHAR(128) DEFAULT NULL`).catch(() => {});

        const app = express();
        const PORT = process.env.DASHBOARD_PORT || 3000;
        const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-env';
        const PASS = process.env.DASHBOARD_PASSWORD || 'admin123';
        const viewsPath = path.join(process.cwd(), 'views');
        if (!fs.existsSync(viewsPath)) fs.mkdirSync(viewsPath, { recursive: true });

        app.set('view engine', 'ejs');
        app.set('views', viewsPath);
        app.use(bodyParser.urlencoded({ extended: true }));
        app.use('/assets', express.static(path.join(viewsPath, 'partials')));

        const getAccent = async () => {
            const res = await db.query("SELECT accent_color FROM bot_settings WHERE guild_id = 'GLOBAL'");
            return res[0]?.accent_color || '#5865F2';
        };

        const getCookie = (req, name) => {
            const rc = req.headers.cookie;
            if (!rc) return null;
            for (const part of rc.split(';')) {
                const [k, ...v] = part.split('=');
                if (k.trim() === name) return decodeURIComponent(v.join('='));
            }
            return null;
        };

        const signToken = (data, secret) => {
            const serialized = JSON.stringify(data);
            const hmac = crypto.createHmac('sha256', secret).update(serialized).digest('hex');
            return `${Buffer.from(serialized).toString('base64')}.${hmac}`;
        };

        const verifyToken = (token, secret) => {
            if (!token) return null;
            const parts = token.split('.');
            if (parts.length !== 2) return null;
            const serialized = Buffer.from(parts[0], 'base64').toString();
            const hmac = crypto.createHmac('sha256', secret).update(serialized).digest('hex');
            return hmac === parts[1] ? JSON.parse(serialized) : null;
        };

        const auth = (req, res, next) => {
            const sessionData = verifyToken(getCookie(req, 'session_token'), SESSION_SECRET);
            if (sessionData?.admin) return next();
            res.redirect('/login');
        };

        const guildName = (client, id) =>
            client?.guilds.cache.get(id)?.name || id;

        const chanName = (client, guildId, chanId) => {
            const ch = client?.guilds.cache.get(guildId)?.channels.cache.get(chanId);
            return ch ? `#${ch.name}` : chanId || '—';
        };

        const resolveRoles = (client, guildId, ids, accentColor) => {
            if (!ids?.trim()) return '<span style="color:var(--subtext)">None</span>';
            const guild = client?.guilds.cache.get(guildId);
            return ids.split(',').filter(Boolean).map(id => {
                const role = guild?.roles.cache.get(id);
                const color = role && role.hexColor !== '#000000' ? role.hexColor : accentColor;
                return role
                    ? `<span class="badge-reward" style="background:${color}22;color:${color}">@${role.name}</span>`
                    : `<code>${id}</code>`;
            }).join(' ');
        };

        // ── Auth ─────────────────────────────────────────────────────────────────
        app.get('/login', async (_req, res) => res.render('login', { accentColor: await getAccent() }));

        app.post('/login', (req, res) => {
            if (req.body.password !== PASS) return res.status(403).send('Access denied.');
            const token = signToken({ admin: true, createdAt: Date.now() }, SESSION_SECRET);
            res.cookie('session_token', token, {
                httpOnly: true,
                secure: process.env.NODE_ENV === 'production',
                sameSite: 'strict',
                maxAge: 86400000,
            });
            res.redirect('/');
        });

        app.get('/logout', (_req, res) => {
            res.clearCookie('session_token');
            res.redirect('/login');
        });

        // ── Public leaderboard ───────────────────────────────────────────────────
        app.get('/leaderboard/:guildId', async (req, res) => {
            try {
                const client = global.client;
                if (!client?.user) {
                    return res.status(503).send('<h1>Bot offline</h1><p>Try again shortly.</p>');
                }
                const guild = client.guilds.cache.get(req.params.guildId)
                    || await client.guilds.fetch(req.params.guildId).catch(() => null);
                if (!guild) return res.status(404).send('<h1>Server not found</h1>');

                const rows = await db.query(
                    'SELECT user_id, xp, level FROM levels WHERE guild_id = ? ORDER BY xp DESC LIMIT 100',
                    [req.params.guildId],
                );
                const xpForLevel = (l) => (l * (l + 1) / 2) * 100;
                const xpToNextLevel = (l) => (l + 1) * 100;
                const accentColor = await getAccent();
                const users = [];

                for (let i = 0; i < rows.length; i++) {
                    const r = rows[i];
                    const member = guild.members.cache.get(r.user_id)
                        || await guild.members.fetch(r.user_id).catch(() => null);
                    const lvl = r.level;
                    const xpIntoLevel = r.xp - xpForLevel(lvl);
                    const reqXp = xpToNextLevel(lvl);
                    users.push({
                        rank: i + 1,
                        name: member?.displayName || member?.user?.username || r.user_id,
                        avatar: member?.user?.displayAvatarURL({ size: 128 })
                            || 'https://cdn.discordapp.com/embed/avatars/0.png',
                        level: lvl,
                        xp: r.xp,
                        xpIntoLevel,
                        reqXp,
                        progress: Math.min(100, Math.floor((xpIntoLevel / reqXp) * 100)),
                    });
                }

                res.render('leaderboard', {
                    guildName: guild.name,
                    guildIcon: guild.iconURL() || 'https://cdn.discordapp.com/embed/avatars/0.png',
                    accentColor,
                    users,
                });
            } catch (err) {
                console.error('Leaderboard error:', err);
                res.status(500).send(`Error: ${err.message}`);
            }
        });

        // ── Main dashboard ───────────────────────────────────────────────────────
        app.get('/', auth, async (req, res) => {
            try {
                const client = global.client;
                const clientReady = !!client?.user;
                const accentColor = await getAccent();
                const clientGuilds = buildClientGuilds(client);

                const cpuLoad = (os.loadavg()[0] * 10).toFixed(0);
                const totalMem = os.totalmem() / 1024 ** 3;
                const freeMem = os.freemem() / 1024 ** 3;
                const memUsage = (((totalMem - freeMem) / totalMem) * 100).toFixed(0);
                const disk = await checkDiskSpace(process.platform === 'win32' ? 'C:' : '/');
                const diskUsage = (((disk.size - disk.free) / disk.size) * 100).toFixed(0);

                const [
                    roleRules, radios, lvlSettings, lvlRoles, lvlBoosts, tempSettings,
                    welcomeSettings, goodbyeSettings, autoroles, starboardSettings,
                    warnConfigs, ticketSettings, clocks, announceSettings, announceSubs,
                ] = await Promise.all([
                    db.query('SELECT * FROM role_logic'),
                    db.query('SELECT * FROM radio_settings'),
                    db.query('SELECT * FROM level_settings'),
                    db.query('SELECT * FROM level_roles'),
                    db.query('SELECT * FROM level_boosts'),
                    db.query('SELECT * FROM tc_settings'),
                    db.query('SELECT * FROM welcome_settings'),
                    db.query('SELECT * FROM goodbye_settings'),
                    db.query('SELECT * FROM autoroles'),
                    db.query('SELECT * FROM starboard_settings'),
                    db.query('SELECT * FROM warn_config'),
                    db.query('SELECT * FROM ticket_settings'),
                    db.query('SELECT * FROM clock_settings'),
                    db.query('SELECT * FROM announce_settings').catch(() => []),
                    db.query('SELECT * FROM announce_subscriptions ORDER BY guild_id, platform').catch(() => []),
                ]);

                let openTickets = 0;
                let warnings = 0;
                let leveledUsers = 0;
                try {
                    openTickets = Number((await db.query("SELECT COUNT(*) AS c FROM tickets WHERE status='open'"))[0]?.c || 0);
                    warnings = Number((await db.query('SELECT COUNT(*) AS c FROM warnings'))[0]?.c || 0);
                    leveledUsers = Number((await db.query('SELECT COUNT(*) AS c FROM levels'))[0]?.c || 0);
                } catch { /* tables may not exist yet */ }

                const plugins = client?.helpData
                    ? [...client.helpData.keys()]
                    : [];

                const roles = roleRules.map(r => {
                    const guild = client?.guilds.cache.get(r.guild_id);
                    const reward = guild?.roles.cache.get(r.reward_role);
                    return {
                        id: r.id,
                        name: r.name,
                        enabled: r.enabled !== 0 && r.enabled !== false,
                        priority: r.priority ?? 0,
                        minOptional: r.min_optional ?? 1,
                        guildName: guild?.name || r.guild_id,
                        guildIcon: guild?.iconURL() || 'https://cdn.discordapp.com/embed/avatars/0.png',
                        rewardName: reward?.name || r.reward_role,
                        rewardColor: reward && reward.hexColor !== '#000000' ? reward.hexColor : accentColor,
                        and: resolveRoles(client, r.guild_id, r.required_roles, accentColor),
                        or: resolveRoles(client, r.guild_id, r.optional_roles, accentColor),
                        forbidden: resolveRoles(client, r.guild_id, r.forbidden_roles, accentColor),
                    };
                });

                const mapGuild = (row, fn) => {
                    const g = client?.guilds.cache.get(row.guild_id);
                    return fn(g, row);
                };

                const welcomeRows = [...new Set([
                    ...welcomeSettings.map(w => w.guild_id),
                    ...goodbyeSettings.map(g => g.guild_id),
                    ...autoroles.map(a => a.guild_id),
                ])].map(gid => {
                    const w = welcomeSettings.find(x => x.guild_id === gid);
                    const g = goodbyeSettings.find(x => x.guild_id === gid);
                    const ar = autoroles.filter(x => x.guild_id === gid);
                    return {
                        guildName: guildName(client, gid),
                        welcomeCh: w ? chanName(client, gid, w.channel_id) : '—',
                        goodbyeCh: g ? chanName(client, gid, g.channel_id) : '—',
                        autoroles: ar.length
                            ? ar.map(a => `<span class="badge bg-secondary">@${client?.guilds.cache.get(gid)?.roles.cache.get(a.role_id)?.name || a.role_id}</span>`).join(' ')
                            : '—',
                    };
                });

                const permGuildId = req.query.guild || clientGuilds[0]?.id || '';
                const permissionCatalog = applyPermissionState(
                    buildPermissionCatalog(client),
                    permGuildId,
                );

                res.render('index', {
                    bot: clientReady ? client.user : { username: 'Offline', displayAvatarURL: () => 'https://cdn.discordapp.com/embed/avatars/0.png' },
                    clientReady,
                    clientGuilds,
                    accentColor,
                    permGuildId,
                    permissionCatalog,
                    plugins,
                    system: {
                        cpu: cpuLoad,
                        memUsage,
                        memVal: `${(totalMem - freeMem).toFixed(1)}/${totalMem.toFixed(1)}GB`,
                        diskUsage,
                        uptime: (os.uptime() / 3600).toFixed(1),
                    },
                    stats: {
                        guilds: clientReady ? client.guilds.cache.size : 0,
                        members: clientReady ? client.guilds.cache.reduce((n, g) => n + g.memberCount, 0) : 0,
                        commands: client?.commands?.size ?? 0,
                        openTickets,
                        warnings,
                        leveledUsers,
                    },
                    roles,
                    radios: radios.map(r => mapGuild(r, (g) => ({
                        id: r.id,
                        guildName: g?.name || r.guild_id,
                        station: r.station_key,
                        voiceChannelHint: r.voice_channel_hint || null,
                    }))),
                    levelingSettings: lvlSettings.map(s => mapGuild(s, (g) => ({
                        guildName: g?.name || s.guild_id,
                        announceType: s.announce_type,
                        announceChan: chanName(client, s.guild_id, s.announce_channel),
                    }))),
                    levelingRoles: lvlRoles.map(r => mapGuild(r, (g) => {
                        const role = g?.roles.cache.get(r.role_id);
                        return {
                            guildId: r.guild_id,
                            guildName: g?.name || r.guild_id,
                            level: r.level,
                            roleName: role?.name || r.role_id,
                            roleColor: role && role.hexColor !== '#000000' ? role.hexColor : accentColor,
                        };
                    })),
                    levelingBoosts: lvlBoosts.map(b => mapGuild(b, (g) => {
                        const role = g?.roles.cache.get(b.role_id);
                        return {
                            guildId: b.guild_id,
                            guildName: g?.name || b.guild_id,
                            roleId: b.role_id,
                            roleName: role?.name || b.role_id,
                            multiplier: parseFloat(b.multiplier),
                        };
                    })),
                    tempSettings: tempSettings.map(s => mapGuild(s, (g) => ({
                        guildId: s.guild_id,
                        channelId: s.channel_id,
                        guildName: g?.name || s.guild_id,
                        channelName: g?.channels.cache.get(s.channel_id)?.name || s.channel_id,
                        categoryName: g?.channels.cache.get(s.category_id)?.name || s.category_id,
                    }))),
                    welcomeRows,
                    starboards: starboardSettings.map(s => mapGuild(s, (g) => ({
                        guildId: s.guild_id,
                        guildName: g?.name || s.guild_id,
                        channelName: chanName(client, s.guild_id, s.channel_id),
                        threshold: s.threshold,
                    }))),
                    warnConfigs: warnConfigs.map(c => ({
                        guildName: guildName(client, c.guild_id),
                        mute_at: c.mute_at,
                        mute_duration: c.mute_duration,
                        kick_at: c.kick_at,
                        ban_at: c.ban_at,
                    })),
                    ticketRows: await Promise.all(ticketSettings.map(async (t) => {
                        const open = Number((await db.query(
                            "SELECT COUNT(*) AS c FROM tickets WHERE guild_id = ? AND status = 'open'",
                            [t.guild_id],
                        ))[0]?.c || 0);
                        const g = client?.guilds.cache.get(t.guild_id);
                        const staff = g?.roles.cache.get(t.staff_role);
                        return {
                            guildName: g?.name || t.guild_id,
                            panelCh: chanName(client, t.guild_id, t.panel_channel),
                            category: g?.channels.cache.get(t.category_id)?.name || t.category_id || '—',
                            staffRole: staff ? `@${staff.name}` : '—',
                            openCount: open,
                        };
                    })),
                    clocks: clocks.map(c => mapGuild(c, (g) => ({
                        guildId: c.guild_id,
                        guildName: g?.name || c.guild_id,
                        channelName: g?.channels.cache.get(c.channel_id)?.name || c.channel_id,
                        timezone: c.timezone,
                    }))),
                    announceSettings: announceSettings.map(a => mapGuild(a, (g) => {
                        const streamCh = a.live_channel_id
                            ? chanName(client, a.guild_id, a.live_channel_id)
                            : '—';
                        const uploadCh = a.upload_channel_id
                            ? chanName(client, a.guild_id, a.upload_channel_id)
                            : '—';
                        const streamPing = a.live_ping_role_id
                            ? g?.roles.cache.get(a.live_ping_role_id)?.name
                            : null;
                        const uploadPing = a.upload_ping_role_id
                            ? g?.roles.cache.get(a.upload_ping_role_id)?.name
                            : null;
                        const streamNote = a.live_enabled === 0 ? ' (off)' : '';
                        const uploadNote = a.upload_enabled === 0 ? ' (off)' : '';
                        return {
                            guildId: a.guild_id,
                            guildName: g?.name || a.guild_id,
                            streamChannel: streamCh + streamNote + (streamPing ? ` · @${streamPing}` : ''),
                            uploadChannel: uploadCh + uploadNote + (uploadPing ? ` · @${uploadPing}` : ''),
                            enabled: a.enabled !== 0 && a.enabled !== false,
                        };
                    })),
                    announceSubs: announceSubs.map(s => {
                        const platformLabels = { youtube: 'YouTube', twitch: 'Twitch', kick: 'Kick' };
                        const types = [
                            s.notify_live ? 'live' : null,
                            s.notify_upload ? 'upload' : null,
                        ].filter(Boolean).join(', ');
                        return {
                            id: s.id,
                            guildName: guildName(client, s.guild_id),
                            platformLabel: platformLabels[s.platform] || s.platform,
                            creatorLabel: s.creator_label || s.creator_id,
                            creatorId: s.creator_id,
                            types: types || '—',
                        };
                    }),
                });
            } catch (err) {
                console.error('Dashboard render error:', err);
                res.status(500).send(`<pre>Error: ${err.message}</pre>`);
            }
        });

        // ── Existing POST/GET actions ────────────────────────────────────────────
        app.post('/add-rule', auth, async (req, res) => {
            const clean = (id) => id?.replace(/[<@&>\s]/g, '') || '';
            await db.query(
                `INSERT INTO role_logic (
                    guild_id, name, required_roles, optional_roles, forbidden_roles,
                    reward_role, min_optional, remove_on_fail, priority, enabled
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    req.body.guild_id,
                    req.body.name?.trim() || null,
                    formatRolesArray(req.body.required_roles),
                    formatRolesArray(req.body.optional_roles),
                    formatRolesArray(req.body.forbidden_roles),
                    clean(req.body.reward_role),
                    Math.max(0, parseInt(req.body.min_optional, 10) || 1),
                    req.body.remove_on_fail === '0' ? 0 : 1,
                    parseInt(req.body.priority, 10) || 0,
                    req.body.enabled ? 1 : 0,
                ],
            );
            res.redirect('/#panel-roles');
        });

        app.get('/delete-rule/:id', auth, async (req, res) => {
            await db.query('DELETE FROM role_logic WHERE id = ?', [req.params.id]);
            res.redirect('/#panel-roles');
        });

        app.get('/toggle-rule/:id', auth, async (req, res) => {
            const rows = await db.query('SELECT enabled FROM role_logic WHERE id = ?', [req.params.id]);
            if (rows[0]) {
                const next = rows[0].enabled ? 0 : 1;
                await db.query('UPDATE role_logic SET enabled = ? WHERE id = ?', [next, req.params.id]);
            }
            res.redirect('/#panel-roles');
        });

        app.post('/update-level-settings', auth, async (req, res) => {
            const clean = (id) => id?.replace(/[<#>\s]/g, '') || '';
            const stackVal = req.body.stack_roles === '1' ? 1 : 0;
            const chan = req.body.announce_type === 'channel' ? clean(req.body.announce_channel) : null;
            await db.query(
                `INSERT INTO level_settings (guild_id, announce_channel, announce_type, announce_msg, stack_roles)
                 VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE announce_channel=?, announce_type=?, announce_msg=?, stack_roles=?`,
                [req.body.guild_id, chan, req.body.announce_type, req.body.announce_msg || null, stackVal, chan, req.body.announce_type, req.body.announce_msg || null, stackVal],
            );
            res.redirect('/');
        });

        app.post('/add-level-role', auth, async (req, res) => {
            const clean = (id) => id?.replace(/[<@&>\s]/g, '') || '';
            await db.query(
                'INSERT INTO level_roles (guild_id, level, role_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role_id = ?',
                [req.body.guild_id, parseInt(req.body.level, 10), clean(req.body.role_id), clean(req.body.role_id)],
            );
            res.redirect('/');
        });

        app.post('/add-xp-boost', auth, async (req, res) => {
            const clean = (id) => id?.replace(/[<@&>\s]/g, '') || '';
            await db.query(
                'INSERT INTO level_boosts (guild_id, role_id, multiplier) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE multiplier = ?',
                [req.body.guild_id, clean(req.body.role_id), parseFloat(req.body.multiplier), parseFloat(req.body.multiplier)],
            );
            res.redirect('/');
        });

        app.get('/delete-level-role/:guildId/:level', auth, async (req, res) => {
            await db.query('DELETE FROM level_roles WHERE guild_id = ? AND level = ?', [req.params.guildId, req.params.level]);
            res.redirect('/');
        });

        app.get('/delete-xp-boost/:guildId/:roleId', auth, async (req, res) => {
            await db.query('DELETE FROM level_boosts WHERE guild_id = ? AND role_id = ?', [req.params.guildId, req.params.roleId]);
            res.redirect('/');
        });

        app.post('/add-radio', auth, async (req, res) => {
            if (req.body.guild_id && req.body.station_key) {
                const hint = req.body.voice_channel_hint?.trim() || null;
                await db.query(
                    'INSERT INTO radio_settings (guild_id, station_key, voice_channel_hint) VALUES (?, ?, ?)',
                    [req.body.guild_id, req.body.station_key, hint],
                );
            }
            res.redirect('/');
        });

        app.get('/delete-radio/:id', auth, async (req, res) => {
            await db.query('DELETE FROM radio_settings WHERE id = ?', [req.params.id]);
            res.redirect('/');
        });

        app.post('/add-temp-channel', auth, async (req, res) => {
            const client = global.client;
            if (!client?.user) return res.status(503).send('Bot offline.');
            const guild = client.guilds.cache.get(req.body.guild_id);
            if (!guild) return res.status(404).send('Guild not found.');
            const limit = Math.min(99, Math.max(0, parseInt(req.body.default_limit, 10) || 0));
            const createChannel = await guild.channels.create({
                name: '➕ Create Channel',
                type: ChannelType.GuildVoice,
                parent: req.body.category_id,
                permissionOverwrites: [
                    { id: guild.id, allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel] },
                ],
            });
            await db.query(
                'INSERT INTO tc_settings (guild_id, channel_id, category_id, default_name, default_limit) VALUES (?, ?, ?, ?, ?)',
                [req.body.guild_id, createChannel.id, req.body.category_id, req.body.default_name || "{username}'s Channel", limit],
            );
            res.redirect('/');
        });

        app.get('/delete-temp-setting/:guildId/:channelId', auth, async (req, res) => {
            await db.query('DELETE FROM tc_settings WHERE guild_id = ? AND channel_id = ?', [req.params.guildId, req.params.channelId]);
            const guild = global.client?.guilds.cache.get(req.params.guildId);
            const chan = guild?.channels.cache.get(req.params.channelId);
            if (chan) await chan.delete().catch(() => {});
            res.redirect('/');
        });

        app.post('/update-theme', auth, async (req, res) => {
            await db.query(
                "INSERT INTO bot_settings (guild_id, accent_color) VALUES ('GLOBAL', ?) ON DUPLICATE KEY UPDATE accent_color = ?",
                [req.body.accent_color, req.body.accent_color],
            );
            res.redirect('/');
        });

        // ── New plugin dashboard routes ────────────────────────────────────────────
        app.post('/welcome-setup', auth, async (req, res) => {
            await db.query(
                'REPLACE INTO welcome_settings (guild_id, channel_id, message) VALUES (?, ?, ?)',
                [req.body.guild_id, req.body.channel_id, req.body.message || 'Welcome {user} to **{server}**!'],
            );
            res.redirect('/');
        });

        app.post('/goodbye-setup', auth, async (req, res) => {
            await db.query(
                'REPLACE INTO goodbye_settings (guild_id, channel_id, message) VALUES (?, ?, ?)',
                [req.body.guild_id, req.body.channel_id, req.body.message || '{user} left **{server}**.'],
            );
            res.redirect('/');
        });

        app.post('/autorole-add', auth, async (req, res) => {
            await db.query(
                'INSERT IGNORE INTO autoroles (guild_id, role_id) VALUES (?, ?)',
                [req.body.guild_id, req.body.role_id],
            );
            res.redirect('/');
        });

        app.post('/starboard-setup', auth, async (req, res) => {
            const threshold = Math.min(25, Math.max(1, parseInt(req.body.threshold, 10) || 3));
            await db.query(
                'REPLACE INTO starboard_settings (guild_id, channel_id, threshold) VALUES (?, ?, ?)',
                [req.body.guild_id, req.body.channel_id, threshold],
            );
            res.redirect('/');
        });

        app.get('/starboard-disable/:guildId', auth, async (req, res) => {
            await db.query('DELETE FROM starboard_settings WHERE guild_id = ?', [req.params.guildId]);
            res.redirect('/');
        });

        app.post('/warn-config', auth, async (req, res) => {
            await db.query(
                `INSERT INTO warn_config (guild_id, mute_at, mute_duration, kick_at, ban_at)
                 VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE mute_at=?, mute_duration=?, kick_at=?, ban_at=?`,
                [
                    req.body.guild_id,
                    parseInt(req.body.mute_at, 10) || 3,
                    parseInt(req.body.mute_duration, 10) || 3600,
                    parseInt(req.body.kick_at, 10) || 5,
                    parseInt(req.body.ban_at, 10) || 7,
                    parseInt(req.body.mute_at, 10) || 3,
                    parseInt(req.body.mute_duration, 10) || 3600,
                    parseInt(req.body.kick_at, 10) || 5,
                    parseInt(req.body.ban_at, 10) || 7,
                ],
            );
            res.redirect('/');
        });

        app.post('/clock-setup', auth, async (req, res) => {
            await db.query(
                'REPLACE INTO clock_settings (guild_id, channel_id, timezone) VALUES (?, ?, ?)',
                [req.body.guild_id, req.body.channel_id, req.body.timezone],
            );
            res.redirect('/');
        });

        app.get('/clock-remove/:guildId', auth, async (req, res) => {
            await db.query('DELETE FROM clock_settings WHERE guild_id = ?', [req.params.guildId]);
            res.redirect('/');
        });

        app.post('/announce-stream-setup', auth, async (req, res) => {
            const enabled = req.body.enabled ? 1 : 0;
            const pingRole = req.body.ping_role_id?.trim() || null;
            const message = req.body.message?.trim() || null;
            await db.query(
                `INSERT INTO announce_settings (guild_id, live_channel_id, live_ping_role_id, live_enabled, live_message, enabled)
                 VALUES (?, ?, ?, ?, ?, 1)
                 ON DUPLICATE KEY UPDATE live_channel_id = ?, live_ping_role_id = ?, live_enabled = ?,
                 live_message = COALESCE(?, live_message), enabled = 1`,
                [
                    req.body.guild_id,
                    req.body.channel_id,
                    pingRole,
                    enabled,
                    message,
                    req.body.channel_id,
                    pingRole,
                    enabled,
                    message,
                ],
            );
            res.redirect('/#panel-announcements');
        });

        app.post('/announce-upload-setup', auth, async (req, res) => {
            const enabled = req.body.enabled ? 1 : 0;
            const pingRole = req.body.ping_role_id?.trim() || null;
            const message = req.body.message?.trim() || null;
            await db.query(
                `INSERT INTO announce_settings (guild_id, upload_channel_id, upload_ping_role_id, upload_enabled, upload_message, enabled)
                 VALUES (?, ?, ?, ?, ?, 1)
                 ON DUPLICATE KEY UPDATE upload_channel_id = ?, upload_ping_role_id = ?, upload_enabled = ?,
                 upload_message = COALESCE(?, upload_message), enabled = 1`,
                [
                    req.body.guild_id,
                    req.body.channel_id,
                    pingRole,
                    enabled,
                    message,
                    req.body.channel_id,
                    pingRole,
                    enabled,
                    message,
                ],
            );
            res.redirect('/#panel-announcements');
        });

        app.post('/announce-add', auth, async (req, res) => {
            const { normalizeCreatorId, resolveYouTubeChannelId, PLATFORMS } = await import('../lib/announcements/checkers.js');
            const platform = String(req.body.platform || '').toLowerCase();
            if (!PLATFORMS[platform]) return res.status(400).send('Invalid platform.');

            let creatorId = normalizeCreatorId(platform, req.body.creator);
            if (!creatorId) return res.status(400).send('Invalid creator ID.');

            if (platform === 'youtube' && creatorId.startsWith('@')) {
                creatorId = await resolveYouTubeChannelId(creatorId);
                if (!creatorId) return res.status(400).send('Could not resolve YouTube handle.');
            }

            const notifyLive = req.body.notify_live ? 1 : 0;
            const notifyUpload = req.body.notify_upload ? 1 : 0;

            const insertResult = await db.query(
                `INSERT INTO announce_subscriptions
                 (guild_id, platform, creator_id, creator_label, notify_live, notify_upload)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE creator_label = VALUES(creator_label),
                 notify_live = VALUES(notify_live), notify_upload = VALUES(notify_upload)`,
                [
                    req.body.guild_id,
                    platform,
                    creatorId,
                    req.body.label?.trim() || req.body.creator?.trim() || creatorId,
                    notifyLive,
                    notifyUpload,
                ],
            );
            const { seedSubscriptionKeys } = await import('../lib/announcements/poller.js');
            let subId = insertResult.insertId;
            if (!subId) {
                const rows = await db.query(
                    'SELECT id FROM announce_subscriptions WHERE guild_id = ? AND platform = ? AND creator_id = ?',
                    [req.body.guild_id, platform, creatorId],
                );
                subId = rows[0]?.id;
            }
            if (subId) await seedSubscriptionKeys(db, subId, platform, creatorId);
            res.redirect('/#panel-announcements');
        });

        app.get('/announce-remove/:id', auth, async (req, res) => {
            await db.query('DELETE FROM announce_subscriptions WHERE id = ?', [req.params.id]);
            res.redirect('/#panel-announcements');
        });

        app.get('/announce-disable/:guildId', auth, async (req, res) => {
            await db.query('UPDATE announce_settings SET enabled = 0 WHERE guild_id = ?', [req.params.guildId]);
            res.redirect('/#panel-announcements');
        });

        app.post('/permissions/save', auth, async (req, res) => {
            try {
                const { guild_id: guildId } = req.body;
                if (!guildId) return res.status(400).send('Missing guild_id.');

                const plugins = {};
                const commands = {};
                for (const [key, value] of Object.entries(req.body)) {
                    if (key.startsWith('p_')) plugins[key.slice(2)] = value;
                    if (key.startsWith('c_')) commands[key.slice(2)] = value;
                }

                await saveGuildPermissions(db, guildId, plugins, commands);
                res.redirect(`/?guild=${guildId}#panel-permissions`);
            } catch (err) {
                res.status(500).send(`Error saving permissions: ${err.message}`);
            }
        });

        app.listen(PORT, () => console.log(`🌐 Dashboard UI → http://localhost:${PORT}`));
    },
};
