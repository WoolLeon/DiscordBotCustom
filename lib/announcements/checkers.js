const YT_CHANNEL_ID = /^UC[\w-]{20,}$/i;
const YT_HANDLE = /^@?[\w.-]{2,}$/;

export const PLATFORMS = {
    youtube: { label: 'YouTube', live: true, upload: true, color: 0xff0000 },
    twitch: { label: 'Twitch', live: true, upload: false, color: 0x9146ff },
    kick: { label: 'Kick', live: true, upload: false, color: 0x53fc18 },
};

export function normalizeCreatorId(platform, raw) {
    const id = String(raw || '').trim();
    if (!id) return null;
    if (platform === 'youtube') {
        if (YT_CHANNEL_ID.test(id)) return id;
        const handle = id.replace(/^@/, '');
        if (YT_HANDLE.test(handle)) return `@${handle}`;
        return null;
    }
    if (platform === 'twitch' || platform === 'kick') {
        const login = id.replace(/^@/, '').toLowerCase();
        return /^[a-z0-9_]{2,25}$/i.test(login) ? login : null;
    }
    return null;
}

function parseFirstEntry(xml) {
    const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/i)?.[1];
    if (!entry) return null;
    const videoId = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/i)?.[1]
        || entry.match(/<id>yt:video:([^<]+)<\/id>/i)?.[1];
    const title = entry.match(/<title>(?:<!\[CDATA\[)?([^\]<]+)(?:\]\]>)?<\/title>/i)?.[1]?.trim();
    const published = entry.match(/<published>([^<]+)<\/published>/i)?.[1];
    if (!videoId) return null;
    return { id: videoId, title: title || 'New video', published, url: `https://www.youtube.com/watch?v=${videoId}` };
}

export async function checkYouTubeUpload(channelId) {
    const res = await fetch(
        `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
        { headers: { 'User-Agent': 'DiscordBot/1.0' } },
    );
    if (!res.ok) return null;
    return parseFirstEntry(await res.text());
}

export async function checkYouTubeLive(channelId) {
    const res = await fetch(`https://www.youtube.com/channel/${encodeURIComponent(channelId)}/live`, {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    if (!res.ok) return null;
    const url = res.url || '';
    if (!url.includes('watch?v=')) return null;
    const videoId = new URL(url).searchParams.get('v');
    if (!videoId) return null;
    return {
        id: videoId,
        title: 'Live stream',
        url: `https://www.youtube.com/watch?v=${videoId}`,
    };
}

let twitchToken = null;
let twitchTokenExpires = 0;

async function getTwitchToken() {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const clientSecret = process.env.TWITCH_CLIENT_SECRET;
    if (!clientId || !clientSecret) return null;
    if (twitchToken && Date.now() < twitchTokenExpires - 60_000) return twitchToken;

    const res = await fetch('https://id.twitch.tv/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            grant_type: 'client_credentials',
        }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    twitchToken = data.access_token;
    twitchTokenExpires = Date.now() + (data.expires_in || 3600) * 1000;
    return twitchToken;
}

export async function checkTwitchLive(login) {
    const token = await getTwitchToken();
    const clientId = process.env.TWITCH_CLIENT_ID;
    if (!token || !clientId) return { error: 'missing_twitch_credentials' };

    const headers = {
        'Client-ID': clientId,
        Authorization: `Bearer ${token}`,
    };
    const userRes = await fetch(
        `https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`,
        { headers },
    );
    if (!userRes.ok) return null;
    const userData = await userRes.json();
    const user = userData.data?.[0];
    if (!user) return null;

    const streamRes = await fetch(
        `https://api.twitch.tv/helix/streams?user_id=${user.id}`,
        { headers },
    );
    if (!streamRes.ok) return null;
    const streamData = await streamRes.json();
    const stream = streamData.data?.[0];
    if (!stream) return null;

    return {
        id: stream.id,
        title: stream.title,
        url: `https://twitch.tv/${login}`,
        thumbnail: stream.thumbnail_url?.replace('{width}', '1280').replace('{height}', '720'),
        game: stream.game_name,
        displayName: user.display_name,
    };
}

export async function checkKickLive(slug) {
    const res = await fetch(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'DiscordBot/1.0' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const live = data.livestream;
    if (!live) return null;
    return {
        id: String(live.id),
        title: live.session_title || `${data.user?.username || slug} is live`,
        url: `https://kick.com/${slug}`,
        thumbnail: live.thumbnail?.url || data.user?.profile_pic,
        displayName: data.user?.username || slug,
    };
}

/** Resolve @handle to UC channel id via channel page (best-effort). */
export async function resolveYouTubeChannelId(handleOrId) {
    if (YT_CHANNEL_ID.test(handleOrId)) return handleOrId;
    const handle = handleOrId.replace(/^@/, '');
    const res = await fetch(`https://www.youtube.com/@${encodeURIComponent(handle)}`, {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const html = await res.text();
    const match = html.match(/"channelId":"(UC[^"]+)"/) || html.match(/channel_id=([^&"]+)/);
    return match?.[1] || null;
}
