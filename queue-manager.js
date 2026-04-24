const urlResolver = require('./url-resolver');
const ncm = require('./ncm-bridge');
const { findLyrics } = require('./lyrics-finder');

const MAX_CONSECUTIVE_SKIPS = 10;

/** 伴奏 / 器乐版等：正常听歌应优先人声版，仅在人声候选全部解析失败后再尝试 */
function isLikelyInstrumentalOrKaraokeName(name) {
    const s = String(name || '');
    if (!s.trim()) return false;
    return /伴奏|伴唱|无人声|纯伴奏|backing\s*track|instrumental|off[\s-]*vocal|karaoke|\binst\.?\b|\(inst\)|\[inst\]/i.test(s);
}

function sortPlayableCandidates(list) {
    const vocalFirst = [...list].sort((a, b) => {
        const ai = isLikelyInstrumentalOrKaraokeName(a.name) ? 1 : 0;
        const bi = isLikelyInstrumentalOrKaraokeName(b.name) ? 1 : 0;
        if (ai !== bi) return ai - bi;
        return 0;
    });
    return [...vocalFirst.filter(r => r.playable), ...vocalFirst.filter(r => !r.playable)];
}

class QueueManager {
    constructor(log, biliFallback) {
        this._queue = [];
        this._currentIndex = -1;
        this._isActive = false;
        this._isTransitioning = false;
        this._isBusyResolving = false;
        this._consecutiveSkips = 0;
        this._playFn = null;
        this._log = log || (() => {});
        this._shuffleMode = false;
        this._shuffleOrder = [];
        this._shuffleIndex = -1;
        this._biliFallback = biliFallback || null;
    }

    setBiliFallback(fallback) {
        this._biliFallback = fallback || null;
    }

    add(songInfo) {
        this._queue.push(songInfo);
        return this._queue.length;
    }

    addMultiple(songs) {
        this._queue.push(...songs);
        return this._queue.length;
    }

    remove(index) {
        if (index < 0 || index >= this._queue.length) return false;
        this._queue.splice(index, 1);
        if (index < this._currentIndex) this._currentIndex--;
        else if (index === this._currentIndex) this._currentIndex = Math.min(this._currentIndex, this._queue.length - 1);
        return true;
    }

    clear() {
        this._queue = [];
        this._currentIndex = -1;
        this._isActive = false;
        this._isTransitioning = false;
        this._isBusyResolving = false;
        this._consecutiveSkips = 0;
        this._shuffleOrder = [];
        this._shuffleIndex = -1;
    }

    list() {
        return {
            songs: this._queue.map((s, i) => ({
                index: i,
                name: s.name,
                artist: s.artist,
                durationStr: s.durationStr || '',
                current: i === this._currentIndex
            })),
            currentIndex: this._currentIndex,
            total: this._queue.length,
            shuffle: this._shuffleMode
        };
    }

    get currentSong() {
        if (this._currentIndex < 0 || this._currentIndex >= this._queue.length) return null;
        return this._queue[this._currentIndex];
    }

    get size() { return this._queue.length; }
    get isActive() { return this._isActive; }
    get shuffleMode() { return this._shuffleMode; }

    get hasNext() {
        if (this._shuffleMode) return this._shuffleIndex < this._shuffleOrder.length - 1;
        return this._currentIndex < this._queue.length - 1;
    }

    get hasPrev() {
        if (this._shuffleMode) return this._shuffleIndex > 0;
        return this._currentIndex > 0;
    }

    setShuffle(on) {
        this._shuffleMode = !!on;
        if (this._shuffleMode && this._queue.length > 0) {
            this._buildShuffleOrder();
        }
        return this._shuffleMode;
    }

    toggleShuffle() {
        return this.setShuffle(!this._shuffleMode);
    }

    _buildShuffleOrder() {
        const indices = Array.from({ length: this._queue.length }, (_, i) => i);
        for (let i = indices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [indices[i], indices[j]] = [indices[j], indices[i]];
        }
        if (this._currentIndex >= 0) {
            const pos = indices.indexOf(this._currentIndex);
            if (pos > 0) {
                [indices[0], indices[pos]] = [indices[pos], indices[0]];
            }
            this._shuffleIndex = 0;
        } else {
            this._shuffleIndex = -1;
        }
        this._shuffleOrder = indices;
    }

    async playAll(playFn, shuffle) {
        if (this._queue.length === 0) return null;
        if (shuffle !== undefined) this._shuffleMode = !!shuffle;
        this._isActive = true;
        this._consecutiveSkips = 0;
        this._playFn = playFn;

        if (this._shuffleMode) {
            this._buildShuffleOrder();
            this._shuffleIndex = 0;
            this._currentIndex = this._shuffleOrder[0];
        } else {
            this._currentIndex = 0;
        }
        return this._playCurrent(playFn);
    }

    async playNext(playFn) {
        const fn = playFn || this._playFn;
        if (!this.hasNext) {
            this._isActive = false;
            this._isTransitioning = false;
            this._log('info', '🎵 [网易云] 队列播放完毕');
            return null;
        }
        if (this._shuffleMode) {
            this._shuffleIndex++;
            this._currentIndex = this._shuffleOrder[this._shuffleIndex];
        } else {
            this._currentIndex++;
        }
        return this._playCurrent(fn);
    }

    async playPrev(playFn) {
        const fn = playFn || this._playFn;
        if (!this.hasPrev) return null;
        if (this._shuffleMode) {
            this._shuffleIndex--;
            this._currentIndex = this._shuffleOrder[this._shuffleIndex];
        } else {
            this._currentIndex--;
        }
        this._consecutiveSkips = 0;
        return this._playCurrent(fn);
    }

    async _playCurrent(playFn) {
        const song = this.currentSong;
        if (!song) return null;

        const modeTag = this._shuffleMode ? '🔀' : '';
        this._log('info', `🎵 [网易云] ${modeTag}播放队列 [${this._currentIndex + 1}/${this._queue.length}]: ${song.name} - ${song.artist}`);

        if (song.st < 0) {
            this._log('warn', `🎵 [网易云] 跳过: ${song.name}（已下架或无版权 st=${song.st}），尝试B站回退...`);
            if (this._biliFallback) {
                try {
                    const artist = (song.artist || '').split('/')[0];
                    const keyword = `${song.name} ${artist}`.trim();
                    const lyrics = await this._fetchSongLyrics(song);
                    const biliResult = await this._biliFallback.searchAndPlay(keyword, playFn, {
                        lyrics, songName: song.name, artistName: artist
                    });
                    if (biliResult) {
                        this._consecutiveSkips = 0;
                        this._isTransitioning = false;
                        return { song: { ...song, biliSource: biliResult }, position: this._currentIndex + 1, total: this._queue.length };
                    }
                } catch (err) {
                    this._log('warn', `🎵 [网易云] B站回退异常: ${err.message}`);
                }
            }

            this._consecutiveSkips++;
            if (this._consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
                this._log('warn', `🎵 [网易云] 连续 ${MAX_CONSECUTIVE_SKIPS} 首无法播放，暂停队列`);
                this._isActive = false;
                return null;
            }
            if (this.hasNext) return this.playNext(playFn);
            this._isActive = false;
            return null;
        }

        this._isBusyResolving = true;
        try {
            const resolved = await urlResolver.resolve(song);
            this._isBusyResolving = false;
            this._consecutiveSkips = 0;
            await playFn(resolved.url, resolved.metadata);
            this._isTransitioning = false;
            return { song, position: this._currentIndex + 1, total: this._queue.length };
        } catch (err) {
            if (ncm.isLoginRequiredError(err)) {
                this._isBusyResolving = false;
                this._isTransitioning = false;
                throw err;
            }
            this._log('warn', `🎵 [网易云] 直接解析失败: ${song.name}，搜索可播放版本...`);
        }

        // 三级降级：① 搜原版(歌名+歌手) → ② 搜替代版(仅歌名) → ③ B站回退
        const result = await this._findAndPlay(song, playFn);
        this._isBusyResolving = false;

        if (result) {
            this._consecutiveSkips = 0;
            this._isTransitioning = false;
            return result;
        }

        const reason = song.vip && !song.playable ? 'VIP歌曲且开放平台未授权' : !song.playable ? '开放平台未授权' : song.vip ? 'VIP歌曲' : '无法获取播放地址';
        this._log('warn', `🎵 [网易云] ${song.name}（${reason}，原版和替代版均不可用），尝试B站回退...`);

        if (this._biliFallback) {
            try {
                const artist = (song.artist || '').split('/')[0];
                const keyword = `${song.name} ${artist}`.trim();
                const lyrics = await this._fetchSongLyrics(song);
                const biliResult = await this._biliFallback.searchAndPlay(keyword, playFn, {
                    lyrics, songName: song.name, artistName: artist
                });
                if (biliResult) {
                    this._consecutiveSkips = 0;
                    this._isTransitioning = false;
                    return { song: { ...song, biliSource: biliResult }, position: this._currentIndex + 1, total: this._queue.length };
                }
            } catch (err) {
                this._log('warn', `🎵 [网易云] B站回退异常: ${err.message}`);
            }
        }

        this._log('warn', `🎵 [网易云] 跳过: ${song.name}（B站回退也失败）`);
        this._consecutiveSkips++;
        this._isTransitioning = false;

        if (this._consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
            this._log('warn', `🎵 [网易云] 连续 ${MAX_CONSECUTIVE_SKIPS} 首无法播放，暂停队列`);
            this._isActive = false;
            return null;
        }

        if (this.hasNext) return this.playNext(playFn);
        this._isActive = false;

        return null;
    }

    async _findAndPlay(song, playFn) {
        // ① 精确搜索：歌名 + 歌手都必须匹配（拒绝 INKK 这类山寨/翻唱）
        // 只在找到原版不同版本（如高音质版、Remastered版）时才会命中，
        // 失败后直接走B站回退，不会降级到其他歌手的翻唱版
        try {
            const mainArtist = (song.artist || '').split('/')[0].trim();
            const keyword = `${song.name} ${mainArtist}`.trim();
            const exactResults = await ncm.searchSongs(keyword, 5);
            const mainArtistLower = mainArtist.toLowerCase();
            const nameAndArtistMatches = exactResults.filter(r => {
                const nameOk = r.name === song.name || r.name.includes(song.name) || song.name.includes(r.name);
                if (!nameOk) return false;
                // 歌手严格匹配：拆分 "A/B/C" 后每一段与 mainArtist exact 对比
                const parts = (r.artist || '').toLowerCase().split(/[\/,、;&·・]/).map(a => a.trim());
                return parts.some(p => p === mainArtistLower);
            });
            const sorted = sortPlayableCandidates(nameAndArtistMatches);
            for (const r of sorted) {
                try {
                    const resolved = await urlResolver.resolve(r);
                    const verTag = isLikelyInstrumentalOrKaraokeName(r.name) ? '（器乐/伴奏版）' : '';
                    this._log('info', `🎵 [网易云] 搜索到可播放版本${verTag}: ${r.name} - ${r.artist}`);
                    await playFn(resolved.url, resolved.metadata);
                    return { song, position: this._currentIndex + 1, total: this._queue.length };
                } catch (err) {
                    if (ncm.isLoginRequiredError(err)) throw err;
                    continue;
                }
            }
        } catch (err) {
            if (ncm.isLoginRequiredError(err)) throw err;
        }

        // ② 直接走B站回退（不再做"宽松搜索"降级到其他歌手的翻唱版）
        if (this._biliFallback) {
            try {
                const artist = (song.artist || '').split('/')[0];
                const keyword = `${song.name} ${artist}`.trim();
                this._log('info', `🎵 [网易云] 未找到原版可播放版本，走B站回退: ${keyword}`);
                const lyrics = await this._fetchSongLyrics(song);
                const biliResult = await this._biliFallback.searchAndPlay(keyword, playFn, {
                    lyrics, songName: song.name, artistName: artist
                });
                if (biliResult) {
                    this._log('info', `🎵 [网易云] B站回退成功: ${biliResult.title} (${biliResult.bvid})`);
                    return { song: { ...song, biliSource: biliResult }, position: this._currentIndex + 1, total: this._queue.length };
                }
            } catch (err) {
                this._log('warn', `🎵 [网易云] B站回退异常: ${err.message}`);
            }
        }

        return null;
    }

    /**
     * 多源拉取歌词（供B站回退使用）。
     * 先试网易云，失败则降级到 QQ 音乐。
     */
    async _fetchSongLyrics(song) {
        const log = (level, msg) => this._log(level, `🎵 [歌词] ${msg}`);
        return await findLyrics({
            songName: song.name,
            artistName: (song.artist || '').split('/')[0],
            songId: song.songId,
            encryptedId: song.encryptedId
        }, log);
    }

    onSongEnd(playFn) {
        // 如果正在搜索替代版本，不要触发切歌
        if (this._isBusyResolving) {
            this._log('info', '🎵 [网易云] 正在搜索替代版本，忽略 onSongEnd');
            return;
        }

        if (!this._isActive || !this.hasNext) {
            this._isActive = false;
            this._isTransitioning = false;
            return;
        }

        if (this._isTransitioning) return;
        this._isTransitioning = true;

        const fn = playFn || this._playFn;

        setTimeout(async () => {
            try {
                await this.playNext(fn);
            } catch (err) {
                this._log('error', `🎵 [网易云] 自动切歌失败: ${err.message}`);
                this._isTransitioning = false;
                if (this.hasNext && this._consecutiveSkips < MAX_CONSECUTIVE_SKIPS) {
                    setTimeout(() => this.onSongEnd(fn), 2000);
                } else {
                    this._isActive = false;
                }
            }
        }, 1000);
    }
}

module.exports = { QueueManager };
