import play from 'play-dl';

const formatDuration = (seconds) => {
    if (!seconds || seconds <= 0) return 'Live';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
};

const ytSearch = async (query, limit = 1) => {
    const results = await play.search(query, {
        limit,
        source: { youtube: 'video' },
    });
    return results;
};

const spotifyToYoutube = async (track) => {
    const q = `${track.name} ${track.artists?.[0]?.name || ''}`.trim();
    const found = await ytSearch(q, 1);
    if (!found[0]) throw new Error(`Could not find YouTube match for: ${q}`);
    const v = found[0];
    return {
        title: v.title || track.name,
        url: v.url,
        duration: v.durationInSec ?? 0,
        durationLabel: formatDuration(v.durationInSec),
        thumbnail: v.thumbnails?.[0]?.url || track.thumbnail?.url || null,
        source: 'spotify',
        streamUrl: v.url,
    };
};

const fromYoutubeVideo = (v, requester, source = 'youtube') => ({
    title: v.title || 'Unknown',
    url: v.url,
    duration: v.durationInSec ?? 0,
    durationLabel: formatDuration(v.durationInSec),
    thumbnail: v.thumbnails?.[0]?.url || null,
    source,
    requester,
    streamUrl: v.url,
});

const fromSoundCloudTrack = (t, requester) => ({
    title: t.name || t.title || 'Unknown',
    url: t.url,
    duration: t.durationInSec ?? 0,
    durationLabel: formatDuration(t.durationInSec),
    thumbnail: t.thumbnail || null,
    source: 'soundcloud',
    requester,
    streamUrl: t.url,
});

/**
 * Resolve a URL or search query into one or more queue tracks.
 * @returns {Promise<Array<{title,url,duration,durationLabel,thumbnail,source,requester,streamUrl}>>}
 */
export async function resolveTracks(input, requester) {
    const query = input?.trim();
    if (!query) throw new Error('Provide a song name or link.');

    const kind = await play.validate(query);

    if (kind === 'yt_video') {
        const info = await play.video_info(query);
        return [fromYoutubeVideo(info.video_details, requester)];
    }

    if (kind === 'yt_playlist') {
        const playlist = await play.playlist_info(query, { incomplete: true });
        const videos = await playlist.all_videos();
        if (!videos.length) throw new Error('Playlist is empty.');
        return videos.map(v => fromYoutubeVideo(v, requester));
    }

    if (kind === 'so_track') {
        const track = await play.soundcloud(query);
        return [{ ...fromSoundCloudTrack(track, requester), requester }];
    }

    if (kind === 'so_playlist') {
        const playlist = await play.soundcloud(query);
        const tracks = await playlist.all_tracks();
        return tracks.map(t => ({ ...fromSoundCloudTrack(t, requester), requester }));
    }

    if (kind === 'sp_track') {
        const track = await play.spotify(query);
        if (track.type !== 'track') throw new Error('Invalid Spotify track URL.');
        return [{ ...(await spotifyToYoutube(track)), requester }];
    }

    if (kind === 'sp_playlist' || kind === 'sp_album') {
        const sp = await play.spotify(query);
        if (sp.type === 'track') {
            return [{ ...(await spotifyToYoutube(sp)), requester }];
        }
        const tracks = await sp.all_tracks();
        if (!tracks.length) throw new Error('Spotify playlist/album is empty.');
        const out = [];
        for (const t of tracks.slice(0, 50)) {
            try {
                out.push({ ...(await spotifyToYoutube(t)), requester });
            } catch {
                /* skip unresolvable */
            }
        }
        if (!out.length) throw new Error('Could not resolve any tracks from Spotify.');
        return out;
    }

    // Search YouTube by text
    const results = await ytSearch(query, 1);
    if (!results[0]) throw new Error(`No results for: ${query}`);
    return [fromYoutubeVideo(results[0], requester, 'search')];
}

export { formatDuration };
