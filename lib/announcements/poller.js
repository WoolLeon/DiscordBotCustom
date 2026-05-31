import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import {
    PLATFORMS,
    checkYouTubeUpload,
    checkYouTubeLive,
    checkTwitchLive,
    checkKickLive,
    resolveYouTubeChannelId,
} from './checkers.js';
import { DEFAULT_LIVE_MSG, DEFAULT_UPLOAD_MSG, formatAnnounceMessage } from './templates.js';

const POLL_MS = Number(process.env.ANNOUNCE_POLL_MS) || 120_000;
let pollTimer = null;
let polling = false;

function watchButton(label, url) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(url),
    );
}

function buildLiveEmbed(platform, creatorLabel, data) {
    const meta = PLATFORMS[platform];
    const embed = new EmbedBuilder()
        .setColor(meta.color)
        .setAuthor({ name: `${creatorLabel} · ${meta.label}`, iconURL: data.avatar || undefined })
        .setTitle(data.title || 'Live now')
        .setURL(data.url)
        .setDescription(data.game ? `Playing **${data.game}**` : null)
        .setTimestamp();
    if (data.thumbnail) embed.setImage(data.thumbnail);
    return embed;
}

function buildUploadEmbed(creatorLabel, data) {
    const embed = new EmbedBuilder()
        .setColor(PLATFORMS.youtube.color)
        .setAuthor({ name: creatorLabel, iconURL: data.avatar || undefined })
        .setTitle(data.title || 'New video')
        .setURL(data.url)
        .setTimestamp();
    if (data.thumbnail) embed.setImage(data.thumbnail);
    return embed;
}

async function postAnnouncement(client, row, embed, kind, textVars) {
    const isLive = kind === 'live';
    const channelId = isLive ? row.live_channel_id : row.upload_channel_id;
    if (!channelId) return;

    const guild = client.guilds.cache.get(row.guild_id);
    if (!guild) return;
    const channel = guild.channels.cache.get(channelId);
    if (!channel?.isTextBased?.()) return;

    const pingRole = isLive ? row.live_ping_role_id : row.upload_ping_role_id;
    const template = isLive
        ? (row.live_message || DEFAULT_LIVE_MSG)
        : (row.upload_message || DEFAULT_UPLOAD_MSG);
    const content = formatAnnounceMessage(template, textVars);
    const ping = pingRole ? `<@&${pingRole}>` : '';
    const body = [ping, content].filter(Boolean).join('\n') || undefined;

    const components = textVars.url
        ? [watchButton(isLive ? 'Watch Stream' : 'Watch Video', textVars.url)]
        : [];

    await channel.send({ content: body, embeds: [embed], components });
}

async function processSubscription(client, db, row) {
    const platform = row.platform;
    const meta = PLATFORMS[platform];
    if (!meta) return;

    const label = row.creator_label || row.creator_id;
    const wantLive = row.notify_live !== 0
        && row.g_live_enabled !== 0
        && row.live_channel_id;
    const wantUpload = row.notify_upload !== 0
        && row.g_upload_enabled !== 0
        && row.upload_channel_id;

    if (platform === 'youtube') {
        let channelId = row.creator_id;
        if (channelId.startsWith('@')) {
            channelId = await resolveYouTubeChannelId(channelId);
            if (!channelId) return;
            await db.query(
                'UPDATE announce_subscriptions SET creator_id = ? WHERE id = ?',
                [channelId, row.id],
            );
        }

        if (wantLive) {
            const live = await checkYouTubeLive(channelId);
            if (live && live.id !== row.last_live_key) {
                const vars = {
                    streamer: label,
                    platform: meta.label,
                    title: live.title,
                    url: live.url,
                };
                await postAnnouncement(
                    client,
                    row,
                    buildLiveEmbed('youtube', label, live),
                    'live',
                    vars,
                );
                await db.query(
                    'UPDATE announce_subscriptions SET last_live_key = ? WHERE id = ?',
                    [live.id, row.id],
                );
            }
        }

        if (wantUpload) {
            const upload = await checkYouTubeUpload(channelId);
            if (upload && upload.id !== row.last_upload_key) {
                if (!row.last_upload_key) {
                    await db.query(
                        'UPDATE announce_subscriptions SET last_upload_key = ? WHERE id = ?',
                        [upload.id, row.id],
                    );
                } else {
                    const vars = {
                        streamer: label,
                        platform: meta.label,
                        title: upload.title,
                        url: upload.url,
                    };
                    await postAnnouncement(
                        client,
                        row,
                        buildUploadEmbed(label, upload),
                        'upload',
                        vars,
                    );
                    await db.query(
                        'UPDATE announce_subscriptions SET last_upload_key = ? WHERE id = ?',
                        [upload.id, row.id],
                    );
                }
            }
        }
        return;
    }

    if (platform === 'twitch' && wantLive) {
        const live = await checkTwitchLive(row.creator_id);
        if (live?.error === 'missing_twitch_credentials') return;
        if (live && live.id !== row.last_live_key) {
            const name = live.displayName || label;
            const vars = {
                streamer: name,
                platform: meta.label,
                title: live.title,
                url: live.url,
                game: live.game,
            };
            await postAnnouncement(client, row, buildLiveEmbed('twitch', name, live), 'live', vars);
            await db.query(
                'UPDATE announce_subscriptions SET last_live_key = ? WHERE id = ?',
                [live.id, row.id],
            );
        } else if (!live && row.last_live_key) {
            await db.query('UPDATE announce_subscriptions SET last_live_key = NULL WHERE id = ?', [row.id]);
        }
        return;
    }

    if (platform === 'kick' && wantLive) {
        const live = await checkKickLive(row.creator_id);
        if (live && live.id !== row.last_live_key) {
            const name = live.displayName || label;
            const vars = {
                streamer: name,
                platform: meta.label,
                title: live.title,
                url: live.url,
            };
            await postAnnouncement(client, row, buildLiveEmbed('kick', name, live), 'live', vars);
            await db.query(
                'UPDATE announce_subscriptions SET last_live_key = ? WHERE id = ?',
                [live.id, row.id],
            );
        } else if (!live && row.last_live_key) {
            await db.query('UPDATE announce_subscriptions SET last_live_key = NULL WHERE id = ?', [row.id]);
        }
    }
}

export async function runAnnouncementPoll(client, db) {
    if (!client?.user || polling) return;
    polling = true;
    try {
        const rows = await db.query(`
            SELECT s.*,
                   a.live_channel_id, a.upload_channel_id,
                   a.live_ping_role_id, a.upload_ping_role_id,
                   a.live_enabled AS g_live_enabled,
                   a.upload_enabled AS g_upload_enabled,
                   a.live_message, a.upload_message
            FROM announce_subscriptions s
            INNER JOIN announce_settings a ON a.guild_id = s.guild_id
            WHERE a.enabled = 1
        `);
        for (const row of rows) {
            try {
                await processSubscription(client, db, row);
            } catch (err) {
                console.error(`Announce poll [${row.platform}/${row.creator_id}]:`, err.message);
            }
        }
    } finally {
        polling = false;
    }
}

export function startAnnouncementPoller(client, db) {
    if (pollTimer) return;
    const tick = () => runAnnouncementPoll(client, db).catch((e) => console.error('Announce poll:', e));
    tick();
    pollTimer = setInterval(tick, POLL_MS);
    console.log(`📡 Stream/upload announce poller every ${POLL_MS / 1000}s`);
}

export function stopAnnouncementPoller() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
}

export async function seedSubscriptionKeys(db, subId, platform, creatorId) {
    let lastLive = null;
    let lastUpload = null;

    if (platform === 'youtube') {
        const upload = await checkYouTubeUpload(creatorId);
        lastUpload = upload?.id || null;
        const live = await checkYouTubeLive(creatorId);
        lastLive = live?.id || null;
    } else if (platform === 'twitch') {
        const live = await checkTwitchLive(creatorId);
        lastLive = live?.id || null;
    } else if (platform === 'kick') {
        const live = await checkKickLive(creatorId);
        lastLive = live?.id || null;
    }

    await db.query(
        'UPDATE announce_subscriptions SET last_live_key = ?, last_upload_key = ? WHERE id = ?',
        [lastLive, lastUpload, subId],
    );
}
