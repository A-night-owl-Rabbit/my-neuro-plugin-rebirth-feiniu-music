const https = require('https');
const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { parseNcmCliStdout } = require('./ncm-bridge');

const _localBin = path.join(__dirname, 'node_modules', '.bin', 'ncm-cli');
const NCM_BIN = (fs.existsSync(_localBin) || fs.existsSync(_localBin + '.cmd')) ? `"${_localBin}"` : 'ncm-cli';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const INTERCEPT_DIR = path.join(os.tmpdir(), 'ncm-mpv-intercept');
const URL_FILE = path.join(INTERCEPT_DIR, 'captured_url.txt');
const NCM_PLAY_TIMEOUT = 12000;
const VALID_LEVELS = new Set(['standard', 'higher', 'exhigh', 'lossless', 'hires']);

let _resolveLock = Promise.resolve();
let _audioQuality = 'exhigh';

function setAudioQuality(level) {
    _audioQuality = VALID_LEVELS.has(level) ? level : 'exhigh';
}

function httpRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const mod = url.startsWith('https') ? https : http;
        const opts = {
            headers: { 'User-Agent': UA, 'Referer': 'https://music.163.com/', ...options.headers },
            ...options, timeout: 10000
        };
        delete opts.body;
        const req = mod.request(url, opts, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return resolve({ redirect: res.headers.location, statusCode: res.statusCode });
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve({ data: JSON.parse(data), statusCode: res.statusCode }); }
                catch { resolve({ raw: data, statusCode: res.statusCode }); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        if (options.body) req.write(options.body);
        req.end();
    });
}

/**
 * 核心策略：通过 ncm-cli play 让 fake mpv 截获带 VIP 鉴权的 URL。
 * 
 * 重要：不杀 mpv 进程！ncm-cli 维护一个持久的 mpv 守护进程，
 * 每次 play 只是发送新的 loadfile 命令。我们通过监听 URL 文件变化来捕获。
 */
async function resolveViaNcmCli(encryptedId, originalId) {
    const prevLock = _resolveLock;
    let unlockFn;
    _resolveLock = new Promise(r => { unlockFn = r; });
    await prevLock;

    try {
        return await _doResolve(encryptedId, originalId);
    } finally {
        unlockFn();
    }
}

async function _doResolve(encryptedId, originalId) {
    fs.mkdirSync(INTERCEPT_DIR, { recursive: true });

    // 记录解析前的 URL 文件内容（用于检测变化）
    let prevUrl = '';
    try { prevUrl = fs.readFileSync(URL_FILE, 'utf-8').trim(); } catch {}

    // 写入标记，区分"新 URL" vs "旧 URL"
    const marker = `__resolving_${Date.now()}`;
    try { fs.writeFileSync(URL_FILE, marker); } catch {}

    return new Promise((resolve) => {
        let settled = false;
        const done = (url) => {
            if (settled) return;
            settled = true;
            clearInterval(watcher);
            clearTimeout(timer);
            resolve(url);
        };

        const timer = setTimeout(() => done(null), NCM_PLAY_TIMEOUT);

        // 监听 URL 文件变化：当 fake mpv 写入新 URL 时捕获
        const watcher = setInterval(() => {
            try {
                if (!fs.existsSync(URL_FILE)) return;
                const content = fs.readFileSync(URL_FILE, 'utf-8').trim();
                // 必须是新的 http URL（不是标记也不是旧 URL）
                if (content.startsWith('http') && content !== prevUrl) {
                    done(content);
                }
            } catch {}
        }, 100);

        exec(
            `${NCM_BIN} play --song --encrypted-id ${encryptedId} --original-id ${originalId} --output json`,
            { timeout: NCM_PLAY_TIMEOUT, encoding: 'utf-8', windowsHide: true },
            (err, stdout) => {
                // ncm-cli play 执行完毕，再等一下看 URL 有没有出来
                setTimeout(() => {
                    if (!settled) done(null);
                }, 3000);
            }
        );
    });
}

async function resolveViaOuterUrl(songId) {
    try {
        const result = await httpRequest(`https://music.163.com/song/media/outer/url?id=${songId}.mp3`, { method: 'GET' });
        if (result.redirect && !result.redirect.includes('404') && !result.redirect.includes('error')) {
            return result.redirect;
        }
    } catch {}
    return null;
}

async function resolveViaEnhanceApi(songId) {
    const levels = [_audioQuality, 'exhigh', 'standard'].filter((v, i, a) => a.indexOf(v) === i);
    for (const level of levels) {
        try {
            const body = `ids=[${songId}]&level=${level}&encodeType=`;
            const result = await httpRequest('https://music.163.com/api/song/enhance/player/url/v1', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: 'appver=1.5.0.75771; os=linux;' },
                body
            });
            const item = result.data?.data?.[0];
            if (item?.url && item.code === 200) return item.url;
        } catch {}
    }
    return null;
}

async function resolveAudioUrl(songInfo) {
    if (songInfo.encryptedId) {
        const url = await resolveViaNcmCli(songInfo.encryptedId, songInfo.songId);
        if (url) return { url, source: 'ncm-cli' };
    }
    const outerUrl = await resolveViaOuterUrl(songInfo.songId);
    if (outerUrl) return { url: outerUrl, source: 'outer' };
    const enhanceUrl = await resolveViaEnhanceApi(songInfo.songId);
    if (enhanceUrl) return { url: enhanceUrl, source: 'enhance' };
    return { url: null, source: 'none' };
}

function fetchLyricsViaCli(encryptedId) {
    return new Promise((resolve) => {
        exec(`${NCM_BIN} song lyric --songId ${encryptedId} --output json`,
            { timeout: 15000, encoding: 'utf-8', windowsHide: true },
            (err, stdout) => {
                if (err) return resolve(null);
                const json = parseNcmCliStdout(stdout);
                resolve(json?.data?.lyric || null);
            });
    });
}

async function fetchLyricsViaApi(songId) {
    try {
        const result = await httpRequest(
            `https://music.163.com/api/song/lyric?id=${songId}&lv=1&kv=1&tv=-1`,
            { method: 'GET', headers: { Cookie: 'appver=1.5.0.75771;' } }
        );
        if (result.data?.lrc?.lyric) return result.data.lrc.lyric;
    } catch {}
    return null;
}

async function resolve(songInfo) {
    const urlResult = await resolveAudioUrl(songInfo);
    let lyrics = null;
    if (songInfo.encryptedId) lyrics = await fetchLyricsViaCli(songInfo.encryptedId);
    if (!lyrics) lyrics = await fetchLyricsViaApi(songInfo.songId);
    if (!urlResult.url) {
        const reasons = [];
        if (songInfo.st < 0) reasons.push('歌曲已下架或无版权(st<0)');
        else if (songInfo.fee === 4) reasons.push('需单独购买专辑(fee=4)');
        else if (songInfo.fee === 1 || songInfo.vip) reasons.push('VIP专属歌曲，需登录VIP账号(fee=1)');
        if (!songInfo.playable) reasons.push('开放平台未授权(playFlag=false)');
        const detail = reasons.length ? reasons.join('；') : 'App可播放但开放平台API未授权';
        throw new Error(`"${songInfo.name}"无法获取播放地址：${detail}`);
    }
    return {
        url: urlResult.url, source: urlResult.source, lyrics,
        metadata: {
            title: songInfo.name, artist: songInfo.artist, album: songInfo.album || '',
            duration: songInfo.duration, songId: songInfo.songId,
            encryptedId: songInfo.encryptedId, coverUrl: songInfo.coverUrl || '', lyrics
        }
    };
}

module.exports = { resolve, resolveAudioUrl, fetchLyricsViaCli, fetchLyricsViaApi, setAudioQuality };
