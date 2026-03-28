const { Plugin } = require('../../../js/core/plugin-base.js');
const ncm = require('./ncm-bridge');
const urlResolver = require('./url-resolver');
const { QueueManager } = require('./queue-manager');

const TAG = '🎵 [肥牛音乐]';

const STOP_KEYWORDS = /停止播放|停止音乐|别[放播]了|关掉音乐|不[要想听]了|停[下吧]|关[了掉]|stop\s*music/i;
const CONTROL_KEYWORDS = /暂停|继续|恢复播放|下一首|上一首|切歌|换一首|音量|声音[大小]|跳[到过]|快进/i;

class NeteaseMusic extends Plugin {
    constructor(metadata, context) {
        super(metadata, context);
        this._queue = null;
        this._currentMeta = null;
        this._isPaused = false;
        this._cfg = {};
        this._authWarnFingerprint = null;
    }

    async onInit() {
        this._queue = new QueueManager((level, msg) => this.context.log(level, msg));
        this._readConfig();
        await this._syncAuthConfig();
        this.context.log('info', `${TAG} 插件初始化完成`);
    }

    async onStart() {
        this._patchMusicPlayer();
        await this._syncAuthConfig();
        this._applyLyricsBubbleConfig();
        this._updatePlaybackPrompt();
        this.context.log('info', `${TAG} 插件已启动，musicPlayer 已注入 playFromUrl`);
    }

    _readConfig() {
        this._cfg = this.context.getPluginFileConfig() || {};
        return this._cfg;
    }

    async _syncAuthConfig() {
        const cfg = this._readConfig();
        const appId = String(cfg.appId || '').trim();
        const privateKey = String(cfg.privateKey || '').trim();
        const fingerprint = `${appId}\n${privateKey}`;

        if (!appId && !privateKey) return;

        if (!appId || !privateKey) {
            if (this._authWarnFingerprint !== fingerprint) {
                this._authWarnFingerprint = fingerprint;
                this.context.log('warn', `${TAG} 插件配置中的 appId 和 privateKey 需要同时填写，当前仅检测到部分值`);
            }
            return;
        }

        await ncm.applyAuthConfig({ appId, privateKey });
        this._authWarnFingerprint = null;
    }

    async _handleLoginRequired(actionLabel, err) {
        let status = null;
        try {
            status = await ncm.checkLogin();
        } catch {}

        if (status?.loggedIn) {
            return `${actionLabel}失败：${err.message}`;
        }

        let loginMsg = '检测到未登录，请调用 netease_login 进行扫码登录。';
        try {
            loginMsg = await this._login();
        } catch (loginErr) {
            loginMsg = `自动拉起扫码登录失败：${loginErr.message}`;
        }

        return [
            `${actionLabel}前检测到网易云未登录或登录已失效。`,
            status?.message ? `当前状态：${status.message}` : '',
            loginMsg
        ].filter(Boolean).join('\n');
    }

    _applyLyricsBubbleConfig() {
        const c = this._readConfig();
        const minW = (Number(c.lyrics_min_width) > 0) ? Number(c.lyrics_min_width) : 160;
        const maxW = (Number(c.lyrics_max_width) > 0) ? Number(c.lyrics_max_width) : 320;
        const padV = (Number(c.lyrics_padding_v) >= 0) ? Number(c.lyrics_padding_v) : 16;
        const padH = (Number(c.lyrics_padding_h) >= 0) ? Number(c.lyrics_padding_h) : 24;
        const fontSize = (Number(c.lyrics_font_size) > 0) ? Number(c.lyrics_font_size) : 16;
        const radius = (Number(c.lyrics_border_radius) >= 0) ? Number(c.lyrics_border_radius) : 24;
        const scale = (Number(c.lyrics_bubble_scale) > 0) ? Number(c.lyrics_bubble_scale) : 1;

        const rawOX = Number(c.lyrics_offset_x);
        const rawOY = Number(c.lyrics_offset_y);
        global._lyricsBubbleOffsetX = isNaN(rawOX) ? -20 : rawOX;
        global._lyricsBubbleOffsetY = isNaN(rawOY) ? -20 : rawOY;

        const css = `
#lyrics-bubble-text {
    min-width: ${minW}px !important;
    max-width: ${maxW}px !important;
    padding: ${padV}px ${padH}px !important;
    font-size: ${fontSize}px !important;
    border-radius: ${radius}px !important;
}
#lyrics-bubble-container {
    transform: scale(${scale});
    transform-origin: bottom left;
}`;
        const existing = document.getElementById('lyrics-bubble-override-style');
        if (existing) existing.remove();
        const style = document.createElement('style');
        style.id = 'lyrics-bubble-override-style';
        style.textContent = css;
        document.head.appendChild(style);

        this.context.log('info', `${TAG} 歌词气泡配置已应用 (偏移:${global._lyricsBubbleOffsetX},${global._lyricsBubbleOffsetY} 缩放:${scale})`);
    }

    // ==================== 播放状态保护 ====================

    _updatePlaybackPrompt() {
        const isPlaying = global.musicPlayer?.isPlaying || this._isPaused;
        const meta = this._currentMeta;
        const qInfo = this._queue?.list();

        let prompt = '可使用本插件注册的 netease_* 工具处理网易云相关请求；按用户意图选用工具即可。';

        if (isPlaying && meta) {
            const queueStr = qInfo?.total > 1 ? `，队列 ${(qInfo.currentIndex + 1)}/${qInfo.total}` : '';
            prompt += ` 当前${this._isPaused ? '暂停' : '播放'}: ${meta.title} - ${meta.artist}${queueStr}；勿因无关对话停止音乐，仅响应明确的播放控制或停止指令。`;
        }

        this.context.addSystemPromptPatch('netease_music_capability', prompt);
    }

    async onLLMRequest(request) {
        this._updatePlaybackPrompt();
    }

    // ==================== monkey-patch musicPlayer ====================

    _patchMusicPlayer() {
        const mp = global.musicPlayer;
        if (!mp) {
            this.context.log('warn', `${TAG} global.musicPlayer 不存在，延迟注入`);
            const timer = setInterval(() => {
                if (global.musicPlayer) {
                    clearInterval(timer);
                    this._injectPlayFromUrl(global.musicPlayer);
                }
            }, 2000);
            return;
        }
        this._injectPlayFromUrl(mp);
    }

    _injectPlayFromUrl(mp) {
        if (mp._neteasePatched) return;

        const plugin = this;

        mp.playFromUrl = async function (url, metadata) {
            if (this.isPlaying) {
                this.stop();
                await new Promise(r => setTimeout(r, 500));
            }

            plugin._applyLyricsBubbleConfig();

            await this.initAudioAnalyzer();
            this.currentAudio = new Audio(url);
            this.currentAudio.crossOrigin = 'anonymous';
            this.isPlaying = true;
            plugin._isPaused = false;
            plugin._currentMeta = metadata;

            this.triggerMicrophoneMotion();

            const source = this.audioContext.createMediaElementSource(this.currentAudio);
            source.connect(this.analyser);
            this.analyser.connect(this.audioContext.destination);

            this.startMouthAnimation();

            if (metadata?.lyrics) {
                this.startLyricsSync(this.currentAudio, metadata.lyrics);
            }

            this.currentAudio.onended = () => {
                this.stopMouthAnimation();
                this.stopLyricsSync();
                this.isPlaying = false;
                plugin._isPaused = false;
                if (!plugin._queue.hasNext) plugin._currentMeta = null;
                if (this.emotionMapper && !plugin._queue.hasNext) this.emotionMapper.playDefaultMotion();
                plugin._updatePlaybackPrompt();
                plugin._queue.onSongEnd(mp.playFromUrl.bind(mp));
            };

            this.currentAudio.onerror = (e) => {
                plugin.context.log('error', `${TAG} 音频播放错误: ${e?.message || '未知错误'}`);
                this.stopMouthAnimation();
                this.stopLyricsSync();
                this.isPlaying = false;
                plugin._isPaused = false;
                if (this.emotionMapper && !plugin._queue.hasNext) this.emotionMapper.playDefaultMotion();
                plugin._updatePlaybackPrompt();
                plugin._queue.onSongEnd(mp.playFromUrl.bind(mp));
            };

            await this.currentAudio.play();
            plugin._updatePlaybackPrompt();

            return {
                message: `正在播放: ${metadata.title} - ${metadata.artist}`,
                metadata
            };
        };

        mp._neteasePatched = true;
        this.context.log('info', `${TAG} playFromUrl 方法已注入`);
    }

    // ==================== 工具定义 ====================

    getTools() {
        return [
            {
                type: 'function',
                function: {
                    name: 'netease_search',
                    description: '搜索网易云音乐。type 为 song 时搜索歌曲，为 all 时综合搜索（含歌曲、歌单、歌手）',
                    parameters: {
                        type: 'object',
                        properties: {
                            keyword: { type: 'string', description: '搜索关键词' },
                            type: { type: 'string', enum: ['song', 'all'], description: '搜索类型，默认 song' },
                            limit: { type: 'number', description: '返回数量，默认5' }
                        },
                        required: ['keyword']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'netease_play',
                    description: '搜索歌曲并立即播放第一首匹配结果。会自动获取音频URL并通过Live2D角色播放（有嘴型同步和歌词显示）',
                    parameters: {
                        type: 'object',
                        properties: {
                            keyword: { type: 'string', description: '歌曲名或歌手名' }
                        },
                        required: ['keyword']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'netease_play_playlist',
                    description: '搜索歌单并播放整个歌单的所有歌曲。支持随机播放模式',
                    parameters: {
                        type: 'object',
                        properties: {
                            keyword: { type: 'string', description: '歌单名称关键词' },
                            playlist_id: { type: 'string', description: '歌单ID（如果已知可直接传入，无需keyword）' },
                            shuffle: { type: 'boolean', description: '是否随机播放，默认false' }
                        },
                        required: []
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'netease_control',
                    description: '播放控制：暂停(pause)、恢复(resume)、停止(stop)、下一首(next)、上一首(prev)、跳转(seek)、音量(volume)',
                    parameters: {
                        type: 'object',
                        properties: {
                            action: { type: 'string', enum: ['pause', 'resume', 'stop', 'next', 'prev', 'seek', 'volume'], description: '控制动作' },
                            value: { type: 'number', description: 'seek时为秒数，volume时为0-100' }
                        },
                        required: ['action']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'netease_state',
                    description: '查看当前播放状态（歌曲信息、进度、音量、队列位置）',
                    parameters: { type: 'object', properties: {}, required: [] }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'netease_queue',
                    description: '播放队列管理。show查看队列，add添加歌曲到队列，clear清空队列',
                    parameters: {
                        type: 'object',
                        properties: {
                            action: { type: 'string', enum: ['show', 'add', 'clear'], description: '队列操作' },
                            keyword: { type: 'string', description: 'add时的搜索关键词' }
                        },
                        required: ['action']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'netease_recommend',
                    description: '获取每日推荐歌曲。设置 play=true 时自动将全部推荐歌曲加入队列并开始播放',
                    parameters: {
                        type: 'object',
                        properties: {
                            limit: { type: 'number', description: '返回数量，默认10' },
                            play: { type: 'boolean', description: '是否立即播放推荐歌曲（加入队列播放），用户说"播放推荐"时设为true' },
                            shuffle: { type: 'boolean', description: '是否随机播放顺序' }
                        },
                        required: []
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'netease_playlist',
                    description: '歌单管理。list查看我的歌单，view查看歌单歌曲，create创建歌单，add_song添加歌曲，remove_song删除歌曲，favorite收藏歌单，search搜索歌单',
                    parameters: {
                        type: 'object',
                        properties: {
                            action: { type: 'string', enum: ['list', 'view', 'create', 'add_song', 'remove_song', 'favorite', 'search'], description: '歌单操作' },
                            playlist_id: { type: 'string', description: '歌单ID' },
                            keyword: { type: 'string', description: '搜索关键词或歌单名称' },
                            song_keyword: { type: 'string', description: 'add_song时搜索歌曲的关键词' },
                            song_id: { type: 'string', description: 'remove_song时的歌曲ID' },
                            name: { type: 'string', description: 'create时的歌单名称' },
                            description: { type: 'string', description: 'create时的歌单描述' }
                        },
                        required: ['action']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'netease_login',
                    description: '网易云音乐登录。生成二维码链接，用网易云音乐App扫码登录',
                    parameters: { type: 'object', properties: {}, required: [] }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'netease_smart_recommend',
                    description: '智能推荐：根据用户偏好分析进行个性化推荐。支持私人漫游FM、心动模式（基于当前播放歌曲推荐相似歌曲）、雷达歌单。play=true时自动播放',
                    parameters: {
                        type: 'object',
                        properties: {
                            mode: { type: 'string', enum: ['fm', 'heartbeat', 'radar'], description: 'fm=私人漫游(根据偏好推歌)，heartbeat=心动模式(基于当前歌曲推荐)，radar=雷达歌单' },
                            play: { type: 'boolean', description: '是否立即播放' },
                            shuffle: { type: 'boolean', description: '是否随机播放顺序' },
                            limit: { type: 'number', description: '返回数量，默认10' }
                        },
                        required: ['mode']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'netease_preference',
                    description: '分析用户音乐偏好。读取红心歌单和播放历史，从曲风标签、高频艺人、情绪方向等维度生成用户画像',
                    parameters: {
                        type: 'object',
                        properties: {
                            source: { type: 'string', enum: ['favorite', 'history', 'ranking', 'all'], description: '数据来源：favorite红心歌单, history播放历史, ranking听歌排行, all全部' }
                        },
                        required: []
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'netease_shuffle',
                    description: '切换随机播放模式。开启后队列歌曲随机顺序播放，关闭后恢复顺序播放',
                    parameters: {
                        type: 'object',
                        properties: {
                            enable: { type: 'boolean', description: '是否开启随机播放，不传则切换当前状态' }
                        },
                        required: []
                    }
                }
            }
        ];
    }

    // ==================== 工具执行 ====================

    async executeTool(name, params) {
        try {
            await this._syncAuthConfig();
            switch (name) {
                case 'netease_search': return await this._search(params);
                case 'netease_play': return await this._play(params);
                case 'netease_play_playlist': return await this._playPlaylist(params);
                case 'netease_control': return await this._control(params);
                case 'netease_state': return this._getState();
                case 'netease_queue': return await this._queueOp(params);
                case 'netease_recommend': return await this._recommend(params);
                case 'netease_playlist': return await this._playlistOp(params);
                case 'netease_login': return await this._login();
                case 'netease_smart_recommend': return await this._smartRecommend(params);
                case 'netease_preference': return await this._analyzePreference(params);
                case 'netease_shuffle': return this._toggleShuffle(params);
                default: return `未知工具: ${name}`;
            }
        } catch (err) {
            if (ncm.isLoginRequiredError(err)) {
                return await this._handleLoginRequired('执行网易云操作', err);
            }
            this.context.log('error', `${TAG} 工具执行错误 [${name}]: ${err.message}`);
            return `操作失败: ${err.message}`;
        }
    }

    // ---- 搜索 ----
    async _search(params) {
        const { keyword, type = 'song', limit = 5 } = params;
        if (!keyword) return '请提供搜索关键词';

        if (type === 'all') {
            const results = await ncm.searchAll(keyword, limit);
            return JSON.stringify(results, null, 2);
        }

        const songs = await ncm.searchSongs(keyword, limit);
        if (!songs.length) return `未找到关于"${keyword}"的歌曲`;

        const lines = songs.map((s, i) =>
            `${i + 1}. ${s.name} - ${s.artist} [${s.durationStr}]${s.vip ? ' (VIP)' : ''}${s.playable ? '' : ' (不可播放)'}`
        );
        return `搜索"${keyword}"的结果:\n${lines.join('\n')}`;
    }

    // ---- 播放单曲 ----
    async _play(params) {
        const { keyword } = params;
        if (!keyword) return '请提供歌曲关键词';

        const songs = await ncm.searchSongs(keyword, 10);
        if (!songs.length) return `未找到关于"${keyword}"的歌曲`;

        const mp = global.musicPlayer;
        if (!mp?.playFromUrl) return '播放器未就绪，请稍后再试';

        const playable = songs.filter(s => s.playable);
        const candidates = playable.length ? playable : songs;

        for (const song of candidates) {
            try {
                this.context.log('info', `${TAG} 尝试播放: ${song.name} - ${song.artist}`);
                const resolved = await urlResolver.resolve(song);

                // 如果当前没有活跃队列，创建一个单曲队列，确保 onSongEnd 链路完整
                if (!this._queue.isActive) {
                    this._queue.clear();
                    this._queue.add(song);
                    this._queue._currentIndex = 0;
                    this._queue._isActive = true;
                }

                await mp.playFromUrl(resolved.url, resolved.metadata);
                this._updatePlaybackPrompt();
                return `正在播放: ${song.name} - ${song.artist} [${song.durationStr}]`;
            } catch (err) {
                if (ncm.isLoginRequiredError(err)) {
                    return await this._handleLoginRequired('播放歌曲', err);
                }
                this.context.log('warn', `${TAG} ${song.name} 播放失败: ${err.message}，尝试下一首`);
                continue;
            }
        }

        return `"${keyword}"的搜索结果均无法播放（可能需要VIP权限）。\n可播放的搜索结果:\n${songs.map((s, i) => `${i + 1}. ${s.name} - ${s.artist}${s.vip ? ' (VIP)' : ''}`).join('\n')}`;
    }

    // ---- 播放歌单 ----
    async _playPlaylist(params) {
        const { keyword, playlist_id, shuffle = false } = params;

        let encPlaylistId = playlist_id;
        let playlistName = '';

        // Find the playlist encrypted ID
        if (!encPlaylistId && keyword) {
            const created = await ncm.playlistCreated(50);
            const match = created.find(p => p.name.includes(keyword));
            if (match) {
                encPlaylistId = match.encryptedId;
                playlistName = match.name;
            } else {
                const allResults = await ncm.searchAll(keyword);
                if (allResults.playlists?.length) {
                    encPlaylistId = allResults.playlists[0].encryptedId;
                    playlistName = allResults.playlists[0].name;
                }
            }
        }

        let songs = [];
        if (encPlaylistId) {
            this.context.log('info', `${TAG} 获取歌单歌曲: ${playlistName || encPlaylistId}`);
            // 分页加载，每次 500 首（API 最大值），直到全部加载
            let offset = 0;
            const pageSize = 500;
            while (true) {
                const page = await ncm.playlistTracks(encPlaylistId, pageSize, offset);
                if (!page.length) break;
                songs.push(...page);
                if (page.length < pageSize) break;
                offset += pageSize;
            }
            this.context.log('info', `${TAG} 歌单加载完成: ${songs.length}首`);
        } else if (keyword) {
            songs = await ncm.searchSongs(keyword, 20);
        } else {
            return '请提供歌单关键词或歌单ID';
        }

        if (!songs?.length) return '歌单为空或未找到歌曲';

        this._queue.clear();
        this._queue.addMultiple(songs);

        const mp = global.musicPlayer;
        if (!mp?.playFromUrl) return '播放器未就绪';

        const result = await this._queue.playAll(mp.playFromUrl.bind(mp), shuffle);
        if (!result) return '播放失败';

        const modeStr = shuffle ? ' [🔀随机播放]' : '';
        return `开始播放歌单"${playlistName || keyword}" (${this._queue.size}首)${modeStr}:\n当前: ${result.song.name} - ${result.song.artist} [${result.position}/${result.total}]`;
    }

    // ---- 播放控制 ----
    async _control(params) {
        const { action, value } = params;
        const mp = global.musicPlayer;
        if (!mp) return '播放器未就绪';
        const audio = mp.currentAudio;

        switch (action) {
            case 'pause': {
                if (!audio || !mp.isPlaying) return '当前没有播放中的音乐';
                audio.pause();
                mp.stopMouthAnimation();
                this._isPaused = true;
                this._updatePlaybackPrompt();
                const t = this._formatTime(audio.currentTime);
                const d = this._formatTime(audio.duration);
                return `已暂停: ${this._currentMeta?.title || '未知'} (${t}/${d})`;
            }
            case 'resume': {
                if (!audio) return '当前没有音乐可恢复';
                await audio.play();
                mp.startMouthAnimation();
                this._isPaused = false;
                this._updatePlaybackPrompt();
                return `继续播放: ${this._currentMeta?.title || '未知'}`;
            }
            case 'stop': {
                mp.stop();
                this._queue.clear();
                this._currentMeta = null;
                this._isPaused = false;
                this._updatePlaybackPrompt();
                return '已停止播放并清空队列';
            }
            case 'next': {
                if (!this._queue.hasNext) return '队列中没有下一首了';
                const result = await this._queue.playNext(mp.playFromUrl.bind(mp));
                if (!result) return '播放下一首失败';
                this._updatePlaybackPrompt();
                return `下一首: ${result.song.name} - ${result.song.artist} [${result.position}/${result.total}]`;
            }
            case 'prev': {
                if (!this._queue.hasPrev) return '已经是第一首了';
                const result = await this._queue.playPrev(mp.playFromUrl.bind(mp));
                if (!result) return '播放上一首失败';
                this._updatePlaybackPrompt();
                return `上一首: ${result.song.name} - ${result.song.artist} [${result.position}/${result.total}]`;
            }
            case 'seek': {
                if (!audio) return '当前没有播放中的音乐';
                const seconds = Number(value);
                if (isNaN(seconds)) return '请提供有效的秒数';
                audio.currentTime = Math.max(0, Math.min(seconds, audio.duration || 0));
                return `已跳转到 ${this._formatTime(audio.currentTime)}`;
            }
            case 'volume': {
                if (!audio) return '当前没有播放中的音乐';
                const vol = Math.max(0, Math.min(100, Number(value) || 50));
                audio.volume = vol / 100;
                return `音量已设为 ${vol}%`;
            }
            default:
                return `未知控制动作: ${action}`;
        }
    }

    // ---- 状态查询 ----
    _getState() {
        const mp = global.musicPlayer;
        const audio = mp?.currentAudio;
        const meta = this._currentMeta;

        if (!mp?.isPlaying && !this._isPaused) {
            return '当前没有播放音乐';
        }

        const qInfo = this._queue.list();
        const state = {
            status: this._isPaused ? '已暂停' : '播放中',
            song: meta?.title || '未知',
            artist: meta?.artist || '未知',
            album: meta?.album || '',
            progress: audio ? `${this._formatTime(audio.currentTime)}/${this._formatTime(audio.duration)}` : '',
            volume: audio ? `${Math.round(audio.volume * 100)}%` : '',
            queue: this._queue.size > 0 ? `${qInfo.currentIndex + 1}/${this._queue.size}` : '无队列',
            mode: this._queue.shuffleMode ? '🔀随机' : '➡️顺序'
        };

        return `状态: ${state.status}\n歌曲: ${state.song} - ${state.artist}\n专辑: ${state.album}\n进度: ${state.progress}\n音量: ${state.volume}\n队列: ${state.queue}\n模式: ${state.mode}`;
    }

    // ---- 队列操作 ----
    async _queueOp(params) {
        const { action, keyword } = params;

        switch (action) {
            case 'show': {
                const info = this._queue.list();
                if (!info.songs.length) return '播放队列为空';
                const modeStr = info.shuffle ? ' 🔀随机' : '';
                const lines = info.songs.map(s =>
                    `${s.current ? '▶ ' : '  '}${s.index + 1}. ${s.name} - ${s.artist} [${s.durationStr}]`
                );
                return `播放队列 (${info.total}首${modeStr}):\n${lines.join('\n')}`;
            }
            case 'add': {
                if (!keyword) return '请提供歌曲关键词';
                const songs = await ncm.searchSongs(keyword, 1);
                if (!songs.length) return `未找到"${keyword}"`;
                const song = songs[0];
                const pos = this._queue.add(song);
                return `已添加: ${song.name} - ${song.artist} (队列第${pos}首)`;
            }
            case 'clear': {
                this._queue.clear();
                return '队列已清空';
            }
            default:
                return `未知队列操作: ${action}`;
        }
    }

    // ---- 推荐 ----
    async _recommend(params) {
        const { limit = 10, play = false, shuffle = false } = params;
        const songs = await ncm.recommendDaily(limit);
        if (!songs.length) return '暂无推荐';

        if (play) {
            const mp = global.musicPlayer;
            if (!mp?.playFromUrl) return '播放器未就绪';

            this._queue.clear();
            this._queue.addMultiple(songs);
            const result = await this._queue.playAll(mp.playFromUrl.bind(mp), shuffle);
            this._updatePlaybackPrompt();
            if (!result) return '播放推荐失败';

            const modeStr = shuffle ? ' [🔀随机]' : '';
            const lines = songs.map((s, i) =>
                `${i === 0 ? '▶ ' : '  '}${i + 1}. ${s.name} - ${s.artist} [${s.durationStr}]`
            );
            return `开始播放每日推荐 (${songs.length}首)${modeStr}:\n${lines.join('\n')}`;
        }

        const lines = songs.map((s, i) =>
            `${i + 1}. ${s.name} - ${s.artist} [${s.durationStr}]`
        );
        return `每日推荐:\n${lines.join('\n')}\n\n提示：如需播放，我可以把这些歌加到播放队列`;
    }

    // ---- 歌单管理 ----
    async _playlistOp(params) {
        const { action, playlist_id, keyword, song_keyword, song_id, name } = params;

        switch (action) {
            case 'list': {
                const [created, collected] = await Promise.all([
                    ncm.playlistCreated(20),
                    ncm.playlistCollected(10)
                ]);
                const lines = [];
                if (created.length) {
                    lines.push('我创建的歌单:');
                    created.forEach((p, i) => lines.push(`  ${i + 1}. ${p.name} (${p.trackCount}首) [ID: ${p.encryptedId}]`));
                }
                if (collected.length) {
                    lines.push('我收藏的歌单:');
                    collected.forEach((p, i) => lines.push(`  ${i + 1}. ${p.name} (${p.trackCount}首) - ${p.creator} [ID: ${p.encryptedId}]`));
                }
                return lines.length ? lines.join('\n') : '没有找到歌单';
            }
            case 'view': {
                let encId = playlist_id;
                if (!encId && keyword) {
                    const created = await ncm.playlistCreated(50);
                    const match = created.find(p => p.name.includes(keyword));
                    if (match) encId = match.encryptedId;
                    else {
                        const result = await ncm.searchAll(keyword);
                        if (result.playlists?.length) encId = result.playlists[0].encryptedId;
                    }
                }
                if (!encId) return '请提供歌单ID或关键词';

                const [detail, tracks] = await Promise.all([
                    ncm.playlistDetail(encId),
                    ncm.playlistTracks(encId, 30)
                ]);
                const lines = [`歌单: ${detail.name}`, `创建者: ${detail.creator}`, `歌曲数: ${detail.trackCount}`, `描述: ${detail.description || '无'}`, ''];
                if (tracks.length) {
                    lines.push('歌曲列表:');
                    tracks.forEach((s, i) => lines.push(`  ${i + 1}. ${s.name} - ${s.artist} [${s.durationStr}]`));
                }
                return lines.join('\n');
            }
            case 'create': {
                if (!name) return '请提供歌单名称';
                const result = await ncm.playlistCreate(name);
                return `歌单"${name}"创建成功！`;
            }
            case 'add_song': {
                let plEncId = playlist_id;
                if (!plEncId && keyword) {
                    const created = await ncm.playlistCreated(50);
                    const match = created.find(p => p.name.includes(keyword));
                    if (match) plEncId = match.encryptedId;
                }
                if (!plEncId) return '请提供歌单ID或歌单名称关键词';
                if (!song_keyword) return '请提供要添加的歌曲关键词';

                const songs = await ncm.searchSongs(song_keyword, 1);
                if (!songs.length) return `未找到歌曲"${song_keyword}"`;
                const song = songs[0];

                await ncm.playlistAddSongs(plEncId, [song.encryptedId]);
                return `已将"${song.name} - ${song.artist}"添加到歌单`;
            }
            case 'remove_song': {
                if (!playlist_id) return '请提供歌单ID';
                if (!song_id) return '请提供要删除的歌曲加密ID';
                await ncm.playlistRemoveSongs(playlist_id, [song_id]);
                return '已从歌单中删除歌曲';
            }
            case 'favorite': {
                if (!playlist_id) return '请提供歌单ID';
                return '歌单收藏功能暂未开放CLI命令，请在网易云音乐App中操作';
            }
            case 'search': {
                if (!keyword) return '请提供搜索关键词';
                const result = await ncm.searchAll(keyword);
                if (!result.playlists?.length) return `未找到关于"${keyword}"的歌单`;
                const lines = result.playlists.map((p, i) =>
                    `${i + 1}. ${p.name} (${p.trackCount}首) 播放${p.playCount} - ${p.creator} [ID: ${p.encryptedId}]`
                );
                return `歌单搜索"${keyword}":\n${lines.join('\n')}`;
            }
            default:
                return `未知歌单操作: ${action}`;
        }
    }

    // ---- 登录 ----
    async _login() {
        await this._syncAuthConfig();
        const status = await ncm.checkLogin();
        if (status.loggedIn) return `已登录: ${status.message}`;

        const result = await ncm.login();
        const qrUrl = result.qrCodeUrl || result.clickableUrl;
        if (qrUrl && typeof document !== 'undefined') {
            try {
                const { showNeteaseLoginQrModal } = require('./login-qr-modal');
                await showNeteaseLoginQrModal({
                    qrCodeUrl: qrUrl,
                    message: result.message
                });
            } catch (e) {
                this.context.log('warn', `${TAG} 扫码弹窗失败: ${e?.message || e}`);
            }
            return [
                '已在窗口内弹出扫码遮罩；扫码成功后窗口会自动关闭（插件在轮询 ncm-cli 登录状态）。',
                '若按钮点不动，请稍等再试；本窗口会定时强制恢复可点击。',
                `备用链接：${qrUrl}`
            ].join('\n');
        }
        if (qrUrl) {
            return `请用网易云音乐App扫码登录:\n${qrUrl}\n\n扫码完成后，可以再次调用此工具确认登录状态`;
        }
        return result.message || '登录请求已发送';
    }

    // ---- 智能推荐 ----
    async _smartRecommend(params) {
        const { mode, play = false, shuffle = false, limit = 10 } = params;

        switch (mode) {
            case 'fm': {
                const songs = await ncm.recommendFM(limit);
                if (!songs.length) return '暂无私人漫游推荐';

                if (play) {
                    const mp = global.musicPlayer;
                    if (!mp?.playFromUrl) return '播放器未就绪';
                    this._queue.clear();
                    this._queue.addMultiple(songs);
                    const result = await this._queue.playAll(mp.playFromUrl.bind(mp), shuffle);
                    this._updatePlaybackPrompt();
                    if (!result) return '播放失败';
                    const modeStr = shuffle ? ' [🔀随机]' : '';
                    return `开始私人漫游${modeStr} (${songs.length}首):\n当前: ${result.song.name} - ${result.song.artist}\n\n${songs.map((s, i) => `${i === 0 ? '▶ ' : '  '}${i + 1}. ${s.name} - ${s.artist}`).join('\n')}`;
                }

                const lines = songs.map((s, i) =>
                    `${i + 1}. ${s.name} - ${s.artist} [${s.durationStr}]${s.tags?.length ? ' #' + s.tags.slice(0, 3).join(' #') : ''}`
                );
                return `私人漫游推荐:\n${lines.join('\n')}\n\n提示：设置 play=true 可立即播放`;
            }

            case 'heartbeat': {
                const currentSong = this._queue?.currentSong;
                const songEncId = currentSong?.encryptedId;
                if (!songEncId) return '心动模式需要当前正在播放歌曲。请先播放一首歌，再使用心动模式获取相似推荐';

                const favPlaylist = await ncm.userFavoritePlaylist();
                if (!favPlaylist.encryptedId) return '未找到红心歌单，请先登录网易云音乐';

                const songs = await ncm.recommendHeartbeat(favPlaylist.encryptedId, songEncId, limit);
                if (!songs.length) return '未获取到心动推荐';

                if (play) {
                    const mp = global.musicPlayer;
                    if (!mp?.playFromUrl) return '播放器未就绪';
                    this._queue.clear();
                    this._queue.addMultiple(songs);
                    const result = await this._queue.playAll(mp.playFromUrl.bind(mp), shuffle);
                    this._updatePlaybackPrompt();
                    if (!result) return '播放失败';
                    const modeStr = shuffle ? ' [🔀随机]' : '';
                    return `心动模式${modeStr}（基于"${currentSong.name}"推荐，${songs.length}首）:\n当前: ${result.song.name} - ${result.song.artist}`;
                }

                const lines = songs.map((s, i) =>
                    `${i + 1}. ${s.name} - ${s.artist}${s.tags?.length ? ' #' + s.tags.slice(0, 3).join(' #') : ''}`
                );
                return `基于"${currentSong.name}"的心动推荐:\n${lines.join('\n')}`;
            }

            case 'radar': {
                const radars = await ncm.playlistRadar();
                if (!radars.length) return '未获取到雷达歌单';

                if (play && radars[0]?.encryptedId) {
                    return await this._playPlaylist({ playlist_id: radars[0].encryptedId, shuffle });
                }

                const lines = radars.map((p, i) =>
                    `${i + 1}. ${p.name} (${p.trackCount}首) ${p.description || ''}`
                );
                return `雷达歌单:\n${lines.join('\n')}\n\n提示：设置 play=true 可播放第一个雷达歌单`;
            }

            default:
                return `未知推荐模式: ${mode}，支持 fm/heartbeat/radar`;
        }
    }

    // ---- 偏好分析 ----
    async _analyzePreference(params) {
        const { source = 'all' } = params;
        const sections = [];

        if (source === 'favorite' || source === 'all') {
            try {
                const favorites = await ncm.userFavoriteSongs(200);
                if (favorites.length) {
                    const tagCount = {};
                    const artistCount = {};
                    favorites.forEach(s => {
                        (s.tags || []).forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; });
                        if (s.artist) {
                            s.artist.split('/').forEach(a => { artistCount[a.trim()] = (artistCount[a.trim()] || 0) + 1; });
                        }
                    });

                    const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 8);
                    const topArtists = Object.entries(artistCount).sort((a, b) => b[1] - a[1]).slice(0, 8);

                    let timeAnalysis = '';
                    const hourBuckets = {};
                    favorites.forEach(s => {
                        if (s.addTime) {
                            const h = new Date(s.addTime).getHours();
                            const bucket = h < 6 ? '深夜(0-6)' : h < 9 ? '早晨(6-9)' : h < 12 ? '上午(9-12)' : h < 14 ? '中午(12-14)' : h < 18 ? '下午(14-18)' : h < 22 ? '晚上(18-22)' : '深夜(22-24)';
                            hourBuckets[bucket] = (hourBuckets[bucket] || 0) + 1;
                        }
                    });
                    if (Object.keys(hourBuckets).length) {
                        const timeParts = Object.entries(hourBuckets).sort((a, b) => b[1] - a[1]);
                        timeAnalysis = `\n  红心时段分布: ${timeParts.map(([k, v]) => `${k}:${v}首`).join('、')}`;
                    }

                    const recentFav = favorites.slice(0, 20);
                    const recentTags = {};
                    recentFav.forEach(s => (s.tags || []).forEach(t => { recentTags[t] = (recentTags[t] || 0) + 1; }));
                    const recentTopTags = Object.entries(recentTags).sort((a, b) => b[1] - a[1]).slice(0, 5);

                    sections.push(`【红心歌单分析】(共${favorites.length}首)`
                        + `\n  高频曲风: ${topTags.length ? topTags.map(([t, c]) => `${t}(${c})`).join('、') : '无标签数据'}`
                        + `\n  常听艺人: ${topArtists.map(([a, c]) => `${a}(${c}首)`).join('、')}`
                        + timeAnalysis
                        + `\n  近期趋势(最新20首): ${recentTopTags.length ? recentTopTags.map(([t, c]) => `${t}(${c})`).join('、') : '无标签'}`
                    );
                }
            } catch (err) {
                sections.push(`【红心歌单】获取失败: ${err.message}`);
            }
        }

        if (source === 'history' || source === 'all') {
            try {
                const history = await ncm.userHistory(50);
                if (history.length) {
                    const artistCount = {};
                    const tagCount = {};
                    history.forEach(s => {
                        (s.tags || []).forEach(t => { tagCount[t] = (tagCount[t] || 0) + 1; });
                        if (s.artist) {
                            s.artist.split('/').forEach(a => { artistCount[a.trim()] = (artistCount[a.trim()] || 0) + 1; });
                        }
                    });
                    const topArtists = Object.entries(artistCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
                    const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 5);

                    sections.push(`【最近播放】(${history.length}首)`
                        + `\n  常听艺人: ${topArtists.map(([a, c]) => `${a}(${c}次)`).join('、')}`
                        + `\n  曲风偏好: ${topTags.length ? topTags.map(([t, c]) => `${t}(${c})`).join('、') : '无标签数据'}`
                    );
                }
            } catch (err) {
                sections.push(`【最近播放】获取失败: ${err.message}`);
            }
        }

        if (source === 'ranking' || source === 'all') {
            try {
                const ranking = await ncm.userListenRanking(30);
                if (ranking.length) {
                    const lines = ranking.slice(0, 10).map((s, i) =>
                        `  ${i + 1}. ${s.name} - ${s.artist}`
                    );
                    sections.push(`【听歌排行Top10】\n${lines.join('\n')}`);
                }
            } catch (err) {
                sections.push(`【听歌排行】获取失败: ${err.message}`);
            }
        }

        if (!sections.length) return '未获取到任何偏好数据，请先登录网易云音乐';
        return sections.join('\n\n');
    }

    // ---- 随机播放 ----
    _toggleShuffle(params) {
        const { enable } = params;
        const newState = enable !== undefined ? this._queue.setShuffle(enable) : this._queue.toggleShuffle();
        const stateStr = newState ? '🔀 已开启随机播放' : '➡️ 已切换为顺序播放';
        const qInfo = this._queue.list();
        if (qInfo.total > 0) {
            return `${stateStr}\n队列共 ${qInfo.total} 首歌`;
        }
        return stateStr;
    }

    // ---- 工具方法 ----
    _formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '0:00';
        const s = Math.floor(seconds);
        return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
    }
}

module.exports = NeteaseMusic;
