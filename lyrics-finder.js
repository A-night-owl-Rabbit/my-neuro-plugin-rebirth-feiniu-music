/**
 * lyrics-finder.js - 多源歌词查找
 *
 * 当网易云因版权被屏蔽时（比如周杰伦、林俊杰的歌），用 QQ 音乐的公开API作为备选歌词源。
 * 支持按"歌名 + 歌手"精确查找，保证拿到正确版本的歌词。
 *
 * 搜索用新版 musicu.fcg POST API（更稳定），歌词用传统 fcg_query_lyric_new 接口。
 */

const https = require('https');
const urlResolver = require('./url-resolver');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function httpRequest(url, { method = 'GET', headers = {}, body = null } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.request({
            hostname: u.hostname,
            path: u.pathname + u.search,
            method,
            headers: {
                'User-Agent': UA,
                Referer: 'https://y.qq.com/',
                ...headers
            },
            timeout: 10000
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ statusCode: res.statusCode, data }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        if (body) req.write(body);
        req.end();
    });
}

/**
 * 从 QQ 音乐搜索歌曲并返回最匹配的 songmid
 * 使用新版 u.y.qq.com/cgi-bin/musicu.fcg POST 接口（老接口 client_search_cp 经常返回500）
 */
async function qqSearchSongMid(songName, artistName) {
    try {
        const keyword = artistName ? `${songName} ${artistName}` : songName;
        const payload = JSON.stringify({
            comm: { ct: 11, cv: '1003006' },
            req: {
                method: 'DoSearchForQQMusicDesktop',
                module: 'music.search.SearchCgiService',
                param: {
                    query: keyword,
                    num_per_page: 15,
                    page_num: 1,
                    search_type: 0
                }
            }
        });

        const res = await httpRequest('https://u.y.qq.com/cgi-bin/musicu.fcg', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload
        });
        if (res.statusCode !== 200) return null;

        const json = JSON.parse(res.data);
        const songs = json.req?.data?.body?.song?.list || [];
        if (!songs.length) return null;

        const songNameLower = songName.toLowerCase();
        const artistLower = (artistName || '').toLowerCase();

        const scored = songs.map(s => {
            const nm = (s.title || s.name || '').toLowerCase();
            const singers = (s.singer || []).map(x => (x.name || '').toLowerCase());
            let score = 0;

            if (nm === songNameLower) score += 30;
            else if (nm.includes(songNameLower)) score += 15;

            if (artistLower && singers.some(sg => sg === artistLower || sg.includes(artistLower) || artistLower.includes(sg))) {
                score += 30;
            } else if (artistName) {
                score -= 10;
            }

            if (/dj|伴奏|instrumental|karaoke/i.test(nm)) score -= 15;
            if (/live|演唱会/i.test(nm)) score -= 5;

            return { song: s, score };
        }).sort((a, b) => b.score - a.score);

        if (scored[0] && scored[0].score > 0) return scored[0].song.mid;
        return null;
    } catch {
        return null;
    }
}

/**
 * 用 songmid 取 QQ 音乐歌词（LRC格式）
 */
async function qqFetchLyric(songmid) {
    try {
        const res = await httpRequest(
            `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${songmid}&format=json&nobase64=1`,
            { headers: { Referer: `https://y.qq.com/n/yqq/song/${songmid}.html` } }
        );
        if (res.statusCode !== 200) return null;
        const json = JSON.parse(res.data);
        return json.lyric || null;
    } catch {
        return null;
    }
}

/**
 * 多源歌词查找（主入口）。
 * 依次尝试：① 网易云 encryptedId  ② 网易云 songId  ③ QQ音乐按歌名+歌手搜索
 *
 * @param {object} params
 * @param {string} [params.songName] - 歌名
 * @param {string} [params.artistName] - 歌手名
 * @param {string|number} [params.songId] - 网易云 songId（原始）
 * @param {string} [params.encryptedId] - 网易云 encryptedId
 * @param {function} [log] - 日志函数
 * @returns {Promise<string|null>} LRC 格式歌词或 null
 */
async function findLyrics({ songName, artistName, songId, encryptedId } = {}, log = () => {}) {
    if (encryptedId) {
        try {
            const l = await urlResolver.fetchLyricsViaCli(encryptedId);
            if (l && l.trim().length > 50) {
                log('info', `歌词来源: 网易云 CLI (${l.length} chars)`);
                return l;
            }
        } catch {}
    }

    if (songId) {
        try {
            const l = await urlResolver.fetchLyricsViaApi(songId);
            if (l && l.trim().length > 50) {
                log('info', `歌词来源: 网易云 API (${l.length} chars)`);
                return l;
            }
        } catch {}
    }

    if (songName) {
        try {
            const songmid = await qqSearchSongMid(songName, artistName || '');
            if (songmid) {
                const l = await qqFetchLyric(songmid);
                if (l && l.trim().length > 50) {
                    log('info', `歌词来源: QQ音乐 (${l.length} chars)`);
                    return l;
                }
            }
        } catch (err) {
            log('warn', `QQ音乐歌词拉取失败: ${err.message}`);
        }
    }

    log('info', `未找到匹配的歌词 (songName=${songName}, artist=${artistName})`);
    return null;
}

module.exports = { findLyrics, qqSearchSongMid, qqFetchLyric };
