export const DEFAULT_LIVE_MSG = '{streamer} is now **live** on **{platform}**!';
export const DEFAULT_UPLOAD_MSG = '**{streamer}** uploaded a new video: **{title}**';

export function formatAnnounceMessage(template, vars) {
    const msg = template || '';
    return msg
        .replaceAll('{streamer}', vars.streamer || '')
        .replaceAll('{platform}', vars.platform || '')
        .replaceAll('{title}', vars.title || '')
        .replaceAll('{url}', vars.url || '')
        .replaceAll('{game}', vars.game || '')
        .trim();
}
