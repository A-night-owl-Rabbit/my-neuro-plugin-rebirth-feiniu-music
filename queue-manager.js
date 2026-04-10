const urlResolver = require('./url-resolver');
const ncm = require('./ncm-bridge');

const MAX_CONSECUTIVE_SKIPS = 10;

class QueueManager {
    constructor(log) {
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
            this._log('warn', `🎵 [网易云] 跳过: ${song.name}（已下架或无版权 st=${song.st}）`);
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

        // 三级降级：① 搜原版(歌名+歌手) → ② 搜替代版(仅歌名) → ③ 跳过
        const result = await this._findAndPlay(song, playFn);
        this._isBusyResolving = false;

        if (result) {
            this._consecutiveSkips = 0;
            this._isTransitioning = false;
            return result;
        }

        const reason = song.vip && !song.playable ? 'VIP歌曲且开放平台未授权' : !song.playable ? '开放平台未授权' : song.vip ? 'VIP歌曲' : '无法获取播放地址';
        this._log('warn', `🎵 [网易云] 跳过: ${song.name}（${reason}，原版和替代版均不可用）`);
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
        // ① 精确搜索：歌名 + 第一位歌手，找同名歌曲
        // 优先尝试 playable=true 的，再尝试 playable=false 的（VIP 用户可能仍可播放）
        try {
            const keyword = `${song.name} ${(song.artist || '').split('/')[0]}`.trim();
            const exactResults = await ncm.searchSongs(keyword, 5);
            const nameMatches = exactResults.filter(r =>
                r.name === song.name || r.name.includes(song.name) || song.name.includes(r.name)
            );
            const sorted = [...nameMatches.filter(r => r.playable), ...nameMatches.filter(r => !r.playable)];
            for (const r of sorted) {
                try {
                    const resolved = await urlResolver.resolve(r);
                    this._log('info', `🎵 [网易云] 搜索到原版: ${r.name} - ${r.artist}`);
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

        // ② 宽松搜索：仅用歌名，找任何同名/相似版本（同样优先 playable=true）
        try {
            const results = await ncm.searchSongs(song.name, 10);
            const candidates = results.filter(r =>
                r.songId !== song.songId &&
                (r.name === song.name || r.name.includes(song.name) || song.name.includes(r.name))
            );
            const sorted = [...candidates.filter(r => r.playable), ...candidates.filter(r => !r.playable)];
            for (const r of sorted) {
                try {
                    const resolved = await urlResolver.resolve(r);
                    this._log('info', `🎵 [网易云] 播放替代版: ${r.name} - ${r.artist}`);
                    const metadata = {
                        ...resolved.metadata,
                        title: `${song.name} (${r.artist}版)`,
                        originalTitle: song.name,
                        originalArtist: song.artist
                    };
                    await playFn(resolved.url, metadata);
                    return { song: { ...song, altVersion: `${r.name} - ${r.artist}` }, position: this._currentIndex + 1, total: this._queue.length };
                } catch (err) {
                    if (ncm.isLoginRequiredError(err)) throw err;
                    continue;
                }
            }
        } catch (err) {
            if (ncm.isLoginRequiredError(err)) throw err;
        }

        return null;
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
