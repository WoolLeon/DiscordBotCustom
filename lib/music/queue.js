import {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    NoSubscriberBehavior,
    entersState,
    VoiceConnectionStatus,
    getVoiceConnection,
    StreamType,
} from '@discordjs/voice';
import play from 'play-dl';
import { EmbedBuilder } from 'discord.js';

const guildQueues = new Map();

// ─── Voice connection options tuned for minimal-server / Vietnamese ISP ──────
// Vietnamese ISPs (Viettel, VNPT, FPT, etc.) often have higher UDP packet loss.
// We increase timeouts and enable selfDeaf to reduce upstream traffic.
const VOICE_JOIN_OPTIONS = {
    selfDeaf: true,          // reduces bandwidth (no need to receive audio)
    selfMute: false,
    debug: false,
};

// How long to wait for VoiceConnectionStatus.Ready
const VOICE_READY_TIMEOUT_MS = 45_000;   // 45 s — extra slack for VN routing
// How many reconnect attempts before giving up
const MAX_RECONNECT_ATTEMPTS = 5;

export class GuildMusicQueue {
    constructor(guildId) {
        this.guildId = guildId;
        this.songs = [];
        this.current = null;
        this.textChannelId = null;
        this.voiceChannelId = null;
        this.playing = false;
        this._reconnectAttempts = 0;

        this.player = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Play,
                // Keep playing even if the connection is briefly lost
                maxMissedFrames: 1000,
            },
        });
        this.connection = null;
        this.volume = 1;

        this.player.on(AudioPlayerStatus.Idle, () => {
            if (this.playing) this.playNext().catch(console.error);
        });

        this.player.on('error', (err) => {
            console.error(`[music] Player error in ${this.guildId}:`, err.message);
            if (this.playing) this.playNext().catch(console.error);
        });
    }

    // ─── Connection management ─────────────────────────────────────────────────

    async ensureConnection(voiceChannel) {
        this.voiceChannelId = voiceChannel.id;
        const existing = getVoiceConnection(voiceChannel.guild.id);

        if (existing && existing.state.status !== VoiceConnectionStatus.Destroyed) {
            this.connection = existing;
        } else {
            this.connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: voiceChannel.guild.id,
                adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                ...VOICE_JOIN_OPTIONS,
            });

            // Auto-reconnect on disconnect (packet loss / brief ISP drops)
            this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
                if (this._reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
                    console.warn(`[music] Max reconnect attempts reached for guild ${this.guildId}. Destroying.`);
                    this.connection.destroy();
                    return;
                }
                try {
                    this._reconnectAttempts++;
                    console.log(`[music] Reconnecting… attempt ${this._reconnectAttempts}`);
                    await Promise.race([
                        entersState(this.connection, VoiceConnectionStatus.Signalling, 10_000),
                        entersState(this.connection, VoiceConnectionStatus.Connecting, 10_000),
                    ]);
                    // Successfully reconnecting
                    this._reconnectAttempts = 0;
                } catch {
                    this.connection.destroy();
                }
            });

            this.connection.on(VoiceConnectionStatus.Ready, () => {
                this._reconnectAttempts = 0; // reset on good connection
            });
        }

        this.connection.subscribe(this.player);

        await entersState(this.connection, VoiceConnectionStatus.Ready, VOICE_READY_TIMEOUT_MS).catch(() => {
            throw new Error('Could not connect to voice channel within timeout.');
        });
    }

    // ─── Stream playback ───────────────────────────────────────────────────────

    async playResource(track) {
        // Radio / direct HTTP stream — pass straight to ffmpeg
        if (track.source === 'radio' || track.isStream) {
            const resource = createAudioResource(track.streamUrl, {
                inputType: StreamType.Arbitrary,
                inlineVolume: true,
            });
            if (resource.volume) resource.volume.setVolume(this.volume);
            this.current = track;
            this.player.play(resource);
            return;
        }

        // SoundCloud
        if (track.source === 'soundcloud') {
            const info = await play.soundcloud(track.streamUrl);
            const streamData = await play.stream_from_info(info, {
                discordPlayerCompatibility: true,
            });
            const resource = createAudioResource(streamData.stream, {
                inputType: streamData.type,
                inlineVolume: true,
            });
            if (resource.volume) resource.volume.setVolume(this.volume);
            this.current = track;
            this.player.play(resource);
            return;
        }

        // YouTube / search / spotify-bridged
        const streamData = await play.stream(track.streamUrl, {
            discordPlayerCompatibility: true,
            // Use lower quality to reduce bandwidth — important for VN ISPs
            quality: 0,
        });
        const resource = createAudioResource(streamData.stream, {
            inputType: streamData.type,
            inlineVolume: true,
        });
        if (resource.volume) resource.volume.setVolume(this.volume);
        this.current = track;
        this.player.play(resource);
    }

    // ─── Queue logic ───────────────────────────────────────────────────────────

    async playNext() {
        const client = global.client;
        const guild = client?.guilds.cache.get(this.guildId);
        const textCh = this.textChannelId && guild?.channels.cache.get(this.textChannelId);

        if (!this.songs.length) {
            this.playing = false;
            this.current = null;
            if (textCh?.isTextBased()) {
                await textCh.send('✅ Queue finished.').catch(() => {});
            }
            return;
        }

        const track = this.songs.shift();
        try {
            const voiceCh = guild?.channels.cache.get(this.voiceChannelId);
            if (!voiceCh) throw new Error('Voice channel missing.');
            await this.ensureConnection(voiceCh);
            await this.playResource(track);

            if (textCh?.isTextBased() && !track.silent) {
                const embed = new EmbedBuilder()
                    .setColor('#1DB954')
                    .setTitle(track.isStream ? '📡 Now Streaming' : '🎵 Now Playing')
                    .setDescription(`**[${track.title}](${track.url || track.streamUrl})**`)
                    .addFields(
                        { name: 'Duration', value: track.durationLabel || 'Live', inline: true },
                        { name: 'Source', value: track.source || 'radio', inline: true },
                        { name: 'Requested by', value: track.requester || 'Auto', inline: true },
                    );
                if (track.thumbnail) embed.setThumbnail(track.thumbnail);
                await textCh.send({ embeds: [embed] }).catch(() => {});
            }
        } catch (err) {
            console.error('[music] Track failed:', err.message);
            if (textCh?.isTextBased()) {
                await textCh.send(`⚠️ Skipped **${track.title}**: ${err.message}`).catch(() => {});
            }
            await this.playNext();
        }
    }

    async addAndPlay(voiceChannel, textChannelId, tracks) {
        this.textChannelId = textChannelId;
        this.songs.push(...tracks);
        if (!this.playing) {
            this.playing = true;
            await this.ensureConnection(voiceChannel);
            await this.playNext();
        }
    }

    skip() {
        this.player.stop(true);
    }

    stop() {
        this.songs = [];
        this.playing = false;
        this.current = null;
        this._reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // prevent reconnect on intentional stop
        this.player.stop();
        const conn = getVoiceConnection(this.guildId);
        if (conn) conn.destroy();
        this.connection = null;
        guildQueues.delete(this.guildId);
    }

    pause() { return this.player.pause(); }
    resume() { return this.player.unpause(); }

    setVolume(percent) {
        this.volume = Math.min(1, Math.max(0, percent / 100));
        const res = this.player.state?.resource;
        if (res?.volume) res.volume.setVolume(this.volume);
        return this.volume;
    }

    shuffle() {
        for (let i = this.songs.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.songs[i], this.songs[j]] = [this.songs[j], this.songs[i]];
        }
    }

    removeAt(index) {
        if (index < 0 || index >= this.songs.length) return null;
        return this.songs.splice(index, 1)[0];
    }
}

export function getMusicQueue(guildId) {
    if (!guildQueues.has(guildId)) guildQueues.set(guildId, new GuildMusicQueue(guildId));
    return guildQueues.get(guildId);
}

export function destroyMusicQueue(guildId) {
    const q = guildQueues.get(guildId);
    if (q) q.stop();
}
