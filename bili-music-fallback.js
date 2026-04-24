/**
 * bili-music-fallback.js - B站音乐回退模块
 *
 * 当网易云音乐搜不到或播放不了时，从B站搜索音乐视频，
 * 下载音频，通过本地HTTP服务器提供给 musicPlayer.playFromUrl 播放。
 */

const { search } = require('bilibili-api-ts/search');
const { execFile } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const TAG = '🎵 [B站回退]';
const TEMP_DIR = path.join(__dirname, 'temp_bili_audio');
const COOKIE_SOURCE = path.join(__dirname, '..', 'bilibili-tools', 'bili_config.json');
const MAX_CLEANUP_AGE_MS = 60 * 60 * 1000;

class BiliMusicFallback {
    constructor(log) {
        this._log = log || (() => {});
        this._server = null;
        this._serverPort = 0;
        this._enabled = true;
        this._minPlayCount = 10000;
        this._maxDuration = 600;
        this._ytDlpPath = 'yt-dlp';
    }

    async init(cfg) {
        this._enabled = cfg.bili_fallback_enabled !== false;
        this._minPlayCount = Number(cfg.bili_fallback_min_play_count) || 10000;
        this._maxDuration = Number(cfg.bili_fallback_max_duration) || 600;
        this._ytDlpPath = String(cfg.yt_dlp_path || 'yt-dlp').trim() || 'yt-dlp';

        if (!this._enabled) {
            this._log('info', `${TAG} B站回退已禁用`);
            return;
        }

        fs.mkdirSync(TEMP_DIR, { recursive: true });
        await this._startServer();
        this._log('info', `${TAG} 初始化完成，HTTP端口: ${this._serverPort}`);
    }

    destroy() {
        if (this._server) {
            this._server.close();
            this._server = null;
        }
    }

    /**
     * 主入口：搜索B站 -> 打分排名 -> 下载音频 -> 播放
     *
     * @param {string} keyword - 搜索关键词（"歌名 歌手" 或纯歌名）
     * @param {function} playFn - musicPlayer.playFromUrl.bind(mp)
     * @param {object} [options] - 可选项
     * @param {string} [options.lyrics] - 原版LRC歌词（通常从网易云拉取后传入）
     * @param {string} [options.songName] - 明确的歌名（覆盖从keyword解析的结果）
     * @param {string} [options.artistName] - 明确的歌手名
     * @returns {object|null} 成功返回 { title, artist, bvid }
     */
    async searchAndPlay(keyword, playFn, options = {}) {
        if (!this._enabled || !this._server) return null;

        this._log('info', `${TAG} 网易云播放失败，尝试B站回退: "${keyword}"`);

        try {
            const videos = await this._searchMusic(keyword);
            if (!videos.length) {
                this._log('warn', `${TAG} B站未搜到相关音乐视频: "${keyword}"`);
                return null;
            }

            const parts = keyword.split(/[\s/]+/).filter(Boolean);
            const songName = options.songName || parts[0] || keyword;
            const artistName = options.artistName || (parts.length > 1 ? parts.slice(1).join(' ') : '');
            const ranked = this._rankVideos(videos, songName, artistName);

            if (!ranked.length) {
                this._log('warn', `${TAG} B站搜索结果均不符合筛选条件`);
                return null;
            }

            this._log('info', `${TAG} 搜索到 ${videos.length} 个结果，最佳: "${ranked[0].title}" (播放量:${ranked[0].play}, 得分:${ranked[0]._score})`);

            for (let i = 0; i < Math.min(ranked.length, 3); i++) {
                const video = ranked[i];
                try {
                    this._log('info', `${TAG} 尝试下载第${i + 1}个: "${video.title}" (${video.bvid})`);

                    const audioPath = await this._downloadAudio(video.bvid);
                    if (!audioPath) {
                        this._log('warn', `${TAG} 下载失败: ${video.bvid}，尝试下一个`);
                        continue;
                    }

                    const audioUrl = `http://127.0.0.1:${this._serverPort}/${path.basename(audioPath)}`;
                    const metadata = {
                        title: songName,
                        artist: artistName || video.author || '未知',
                        album: 'B站音源',
                        lyrics: options.lyrics || null,
                        biliSource: {
                            bvid: video.bvid,
                            title: video.title,
                            author: video.author,
                            play: video.play,
                            url: `https://www.bilibili.com/video/${video.bvid}`
                        }
                    };

                    await playFn(audioUrl, metadata);

                    this._log('info', `${TAG} 播放成功: "${video.title}" (${video.bvid})${options.lyrics ? ' [带网易云原版歌词]' : ''}`);
                    this._cleanupOldFiles();
                    return { title: video.title, artist: video.author, bvid: video.bvid };
                } catch (err) {
                    this._log('warn', `${TAG} 第${i + 1}个视频播放失败: ${err.message}`);
                    continue;
                }
            }

            this._log('warn', `${TAG} 所有B站候选均失败`);
            return null;
        } catch (err) {
            this._log('error', `${TAG} B站回退异常: ${err.message}`);
            return null;
        }
    }

    // ==================== B站搜索 ====================

    async _searchMusic(keyword) {
        const allVideos = new Map();

        await this._doSearch(keyword, 10, allVideos);

        const parts = keyword.split(/[\s/]+/).filter(Boolean);
        if (parts.length > 1) {
            await this._doSearch(`${parts[0]} ${parts.slice(1).join(' ')} MV`, 5, allVideos);
        }

        await this._doSearch(`${parts[0]} MV`, 5, allVideos);

        return Array.from(allVideos.values());
    }

    async _doSearch(keyword, limit, resultMap) {
        try {
            const response = await search({
                keyword: keyword.trim(),
                type: 'video',
                page: 1,
                credential: null
            });
            const videoResultObject = response.result?.find(item => item.result_type === 'video');
            if (!videoResultObject?.data?.length) return;

            for (const v of videoResultObject.data.slice(0, limit)) {
                const bvid = v.bvid;
                if (!bvid || resultMap.has(bvid)) continue;

                resultMap.set(bvid, {
                    title: (v.title || '').replace(/<em class="keyword">|<\/em>/g, ''),
                    author: v.author || v.uploader || '',
                    bvid,
                    aid: v.aid,
                    play: v.play || 0,
                    duration: this._parseDuration(v.duration),
                    durationStr: v.duration || '未知',
                    tag: v.tag || '',
                    description: (v.description || '').substring(0, 100)
                });
            }
        } catch (err) {
            this._log('warn', `${TAG} B站搜索 "${keyword}" 失败: ${err.message}`);
        }
    }

    _parseDuration(str) {
        if (!str || typeof str !== 'string') return 0;
        const parts = str.split(':').map(Number);
        if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
        if (parts.length === 2) return parts[0] * 60 + parts[1];
        return Number(str) || 0;
    }

    // ==================== 打分排名 ====================

    _rankVideos(videos, songName, artistName) {
        const kw = songName.toLowerCase();
        const kwTokens = kw.split(/[\s/]+/).filter(Boolean);
        const artistLower = (artistName || '').toLowerCase();

        const scored = videos
            .filter(v => {
                if (v.duration > 0 && v.duration > this._maxDuration) return false;
                if (v.duration > 0 && v.duration < 30) return false;
                if (v.play < this._minPlayCount) return false;
                return true;
            })
            .map(v => {
                const title = v.title.toLowerCase();
                let score = 0;

                if (title === kw || title === `${kw} mv` || title === `${kw}mv`) {
                    score += 30;
                } else {
                    for (const t of kwTokens) {
                        if (title.includes(t)) score += 15;
                    }
                    if (title.includes(kw) || kw.includes(title.replace(/\s*mv\s*/i, '').trim())) {
                        score += 10;
                    }
                }

                if (artistLower && title.includes(artistLower)) score += 10;
                if (artistLower && (v.author || '').toLowerCase().includes(artistLower)) score += 5;

                score += Math.min(Math.log10(Math.max(v.play, 1)) * 5, 35);

                if (/翻唱|cover|翻弹/i.test(title)) score -= 20;
                if (/教学|tutorial|教程|吉他谱|钢琴谱/i.test(title)) score -= 30;
                if (/remix|混音|dj版/i.test(title)) score -= 15;
                if (/现场|live|演唱会|concert/i.test(title)) score -= 10;
                if (/钢琴版|piano|吉他版|guitar|二胡|古筝|小提琴/i.test(title)) score -= 15;
                if (/伴奏|instrumental|karaoke|ktv/i.test(title)) score -= 25;
                if (/react|反应|reaction|解说|盘点|合集/i.test(title)) score -= 30;
                if (/AI|ai翻唱|ai cover/i.test(title)) score -= 20;
                if (/片段|cut|短片/i.test(title)) score -= 10;

                if (/官方|official/i.test(title)) score += 10;
                if (/MV|music\s*video/i.test(title) && !/翻唱|cover/i.test(title)) score += 5;
                if (/原版|正版|原曲/i.test(title)) score += 8;
                if (/完整版|full/i.test(title)) score += 3;
                if (v.duration >= 120 && v.duration <= 480) score += 5;
                if (v.tag && /音乐|MV|原创音乐/i.test(v.tag)) score += 5;

                return { ...v, _score: score };
            })
            .sort((a, b) => b._score - a._score);

        if (scored.length === 0) {
            return videos
                .filter(v => v.duration <= this._maxDuration || v.duration === 0)
                .map(v => ({ ...v, _score: 0 }))
                .sort((a, b) => b.play - a.play)
                .slice(0, 5);
        }

        return scored;
    }

    // ==================== 音频下载 ====================

    async _downloadAudio(bvid) {
        const videoUrl = `https://www.bilibili.com/video/${bvid}`;
        const outputTemplate = path.join(TEMP_DIR, `${bvid}.%(ext)s`);

        const args = [
            '--format', 'bestaudio[ext=m4a]/bestaudio/best',
            '--output', outputTemplate,
            '--no-playlist',
            '--no-progress',
            '--quiet',
            '--retries', '3',
            '--socket-timeout', '30',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            '--referer', 'https://www.bilibili.com/'
        ];

        const cookieFile = this._prepareCookieFile();
        if (cookieFile) {
            args.push('--cookies', cookieFile);
        }

        args.push(videoUrl);

        return new Promise((resolve) => {
            execFile(this._ytDlpPath, args, {
                timeout: 60000,
                encoding: 'utf-8',
                windowsHide: true,
                cwd: TEMP_DIR
            }, (err, stdout, stderr) => {
                if (err) {
                    this._log('warn', `${TAG} yt-dlp 下载失败 (${bvid}): ${err.message}`);
                    if (stderr) this._log('warn', `${TAG} yt-dlp stderr: ${stderr.trim().substring(0, 200)}`);
                    resolve(null);
                    return;
                }

                try {
                    const files = fs.readdirSync(TEMP_DIR);
                    for (const file of files) {
                        if (file.startsWith(bvid + '.')) {
                            const fullPath = path.join(TEMP_DIR, file);
                            const stat = fs.statSync(fullPath);
                            if (stat.size > 1024) {
                                this._log('info', `${TAG} 下载完成: ${file} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
                                resolve(fullPath);
                                return;
                            }
                        }
                    }
                } catch (e) {
                    this._log('warn', `${TAG} 查找下载文件失败: ${e.message}`);
                }
                resolve(null);
            });
        });
    }

    _prepareCookieFile() {
        try {
            if (!fs.existsSync(COOKIE_SOURCE)) return null;

            const config = JSON.parse(fs.readFileSync(COOKIE_SOURCE, 'utf-8'));
            if (!config.SESSDATA || !config.bili_jct) return null;

            const cookiePath = path.join(TEMP_DIR, 'bili_cookies.txt');
            const lines = [
                '# Netscape HTTP Cookie File',
                '# Generated by bili-music-fallback.js',
                ''
            ];

            const expiry = '1999999999';
            const entries = [
                ['SESSDATA', config.SESSDATA],
                ['bili_jct', config.bili_jct],
                ['DedeUserID', config.DedeUserID],
                ['buvid3', config.buvid3],
                ['buvid4', config.buvid4],
                ['b_nut', String(config.b_nut || '')]
            ];

            for (const [name, value] of entries) {
                if (value) {
                    lines.push(`.bilibili.com\tTRUE\t/\tFALSE\t${expiry}\t${name}\t${value}`);
                }
            }

            fs.writeFileSync(cookiePath, lines.join('\n'), 'utf-8');
            return cookiePath;
        } catch (err) {
            this._log('warn', `${TAG} 准备Cookie文件失败: ${err.message}`);
            return null;
        }
    }

    // ==================== 本地HTTP服务器 ====================

    _startServer() {
        return new Promise((resolve) => {
            this._server = http.createServer((req, res) => {
                const filename = decodeURIComponent(req.url.replace(/^\//, '').split('?')[0]);
                const filePath = path.join(TEMP_DIR, filename);

                if (!filePath.startsWith(TEMP_DIR) || !fs.existsSync(filePath)) {
                    res.writeHead(404);
                    res.end('Not Found');
                    return;
                }

                const stat = fs.statSync(filePath);
                const ext = path.extname(filePath).toLowerCase();
                const mimeTypes = {
                    '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
                    '.wav': 'audio/wav', '.webm': 'audio/webm', '.aac': 'audio/aac', '.opus': 'audio/opus'
                };
                const contentType = mimeTypes[ext] || 'application/octet-stream';

                const range = req.headers.range;
                if (range) {
                    const parts = range.replace(/bytes=/, '').split('-');
                    const start = parseInt(parts[0], 10);
                    const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
                    const chunkSize = end - start + 1;

                    res.writeHead(206, {
                        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                        'Accept-Ranges': 'bytes',
                        'Content-Length': chunkSize,
                        'Content-Type': contentType,
                        'Access-Control-Allow-Origin': '*'
                    });
                    fs.createReadStream(filePath, { start, end }).pipe(res);
                } else {
                    res.writeHead(200, {
                        'Content-Length': stat.size,
                        'Content-Type': contentType,
                        'Accept-Ranges': 'bytes',
                        'Access-Control-Allow-Origin': '*'
                    });
                    fs.createReadStream(filePath).pipe(res);
                }
            });

            this._server.listen(0, '127.0.0.1', () => {
                this._serverPort = this._server.address().port;
                resolve();
            });

            this._server.on('error', (err) => {
                this._log('error', `${TAG} HTTP服务器启动失败: ${err.message}`);
                this._server = null;
                resolve();
            });
        });
    }

    // ==================== 清理 ====================

    _cleanupOldFiles() {
        try {
            const now = Date.now();
            const files = fs.readdirSync(TEMP_DIR);
            for (const file of files) {
                if (file === 'bili_cookies.txt') continue;
                const filePath = path.join(TEMP_DIR, file);
                const stat = fs.statSync(filePath);
                if (now - stat.mtimeMs > MAX_CLEANUP_AGE_MS) {
                    fs.unlinkSync(filePath);
                    this._log('info', `${TAG} 清理旧文件: ${file}`);
                }
            }
        } catch (_) { /* 清理失败不影响使用 */ }
    }
}

module.exports = { BiliMusicFallback };
