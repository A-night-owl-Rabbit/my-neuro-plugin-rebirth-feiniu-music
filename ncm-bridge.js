const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const CMD_TIMEOUT = 30_000;

const _localBin = path.join(__dirname, 'node_modules', '.bin', 'ncm-cli');
const NCM_BIN = (fs.existsSync(_localBin) || fs.existsSync(_localBin + '.cmd')) ? `"${_localBin}"` : 'ncm-cli';
let _authConfigFingerprint = null;

function escapeShellArg(str) {
    return str.replace(/"/g, '\\"').replace(/\n/g, ' ');
}

/**
 * ncm-cli 在 JSON 前可能打印升级提示等非 JSON 行，整段 stdout 无法 JSON.parse。
 * 从首个 { 起按括号深度截取第一个完整对象再解析。
 */
function parseNcmCliStdout(stdout) {
    const s = String(stdout || '').trim();
    if (!s) return null;
    try {
        return JSON.parse(s);
    } catch { /* fall through */ }
    const start = s.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < s.length; i++) {
        const c = s[i];
        if (escape) {
            escape = false;
            continue;
        }
        if (c === '\\' && inString) {
            escape = true;
            continue;
        }
        if (c === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) {
                try {
                    return JSON.parse(s.slice(start, i + 1));
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

/** 把 ncm-cli 典型错误转成可读说明（与杀 mpv 假进程无关） */
function clarifyNcmCliError(raw) {
    const text = String(raw || '').trim();
    if (!text) return text;
    // 未登录或会话失效时，部分版本会报 unknown command 'search'
    if (/unknown command\s+['"]?search['"]?/i.test(text) || /unknown command.*\bsearch\b/i.test(text)) {
        return (
            `${text}\n\n` +
            '【登录状态】该错误一般表示 ncm-cli 当前未登录或登录已失效，与结束假 mpv/Node 桥接进程无关；' +
            '登录票据保存在本机 ncm-cli 配置目录，杀播放器进程不会清掉。\n' +
            '请在终端执行 `ncm-cli login --check` 确认；若未登录请 `ncm-cli login` 扫码，或在肥牛里调用 netease_login。'
        );
    }
    if (/not logged|未登录|需要登录|please login|login required/i.test(text)) {
        return `${text}\n\n请先执行 ncm-cli login（或 netease_login）完成扫码授权。`;
    }
    return text;
}

function normalizeConfigValue(value) {
    if (value == null) return '';
    return String(value).trim();
}

function isLoginRequiredError(error) {
    const text = String(error?.message || error || '').trim();
    if (!text) return false;
    return /未登录|登录已失效|需要登录|请先执行\s*ncm-cli\s+login|请先.*扫码授权|please login|login required|not logged|unknown command\s+['"]?search['"]?/i.test(text);
}

function execRaw(args) {
    return new Promise((resolve, reject) => {
        const cmd = `${NCM_BIN} ${args}`;
        exec(cmd, { timeout: CMD_TIMEOUT, encoding: 'utf-8', windowsHide: true }, (err, stdout, stderr) => {
            if (err) {
                return reject(new Error(clarifyNcmCliError(stderr || stdout || err.message)));
            }
            resolve({ stdout, stderr });
        });
    });
}

function run(args) {
    return new Promise((resolve, reject) => {
        const cmd = `${NCM_BIN} ${args} --output json`;
        exec(cmd, { timeout: CMD_TIMEOUT, encoding: 'utf-8', windowsHide: true }, (err, stdout, stderr) => {
            if (err && !stdout) {
                return reject(new Error(clarifyNcmCliError(stderr || err.message)));
            }
            const json = parseNcmCliStdout(stdout);
            if (!json) {
                return resolve({ raw: stdout, stderr });
            }
            if (json.code && json.code !== 200) {
                return reject(new Error(clarifyNcmCliError(json.message || `API错误 (code: ${json.code})`)));
            }
            resolve(json);
        });
    });
}

async function applyAuthConfig(config = {}) {
    const appId = normalizeConfigValue(config.appId);
    const privateKey = normalizeConfigValue(config.privateKey);
    const fingerprint = `${appId}\n${privateKey}`;

    if (_authConfigFingerprint === fingerprint) {
        return { changed: false, configured: !!(appId && privateKey) };
    }

    if (!appId && !privateKey) {
        _authConfigFingerprint = fingerprint;
        return { changed: false, configured: false };
    }

    if (appId) {
        await execRaw(`config set appId "${escapeShellArg(appId)}"`);
    }
    if (privateKey) {
        await execRaw(`config set privateKey "${escapeShellArg(privateKey)}"`);
    }

    _authConfigFingerprint = fingerprint;
    return { changed: true, configured: !!(appId && privateKey) };
}

function mapSongRecord(s) {
    const fee = s.fee ?? (s.vipFlag ? 1 : (s.playFlag ? 0 : -1));
    const st = s.privilege?.st ?? s.st ?? 0;
    return {
        songId: s.originalId,
        encryptedId: s.id,
        name: s.name,
        artist: (s.artists || []).map(a => a.name).join('/'),
        album: s.album?.name || '',
        duration: s.duration,
        durationStr: formatDuration(s.duration),
        playable: !!s.playFlag,
        vip: !!s.vipFlag,
        fee,
        st,
        coverUrl: s.coverImgUrl || '',
        tags: s.songTag || []
    };
}

async function searchSongs(keyword, limit = 5) {
    const result = await run(`search song --keyword "${escapeShellArg(keyword)}" --limit ${limit}`);
    if (result.code !== 200 || !result.data?.records) {
        throw new Error(result.message || '搜索失败');
    }
    return result.data.records.map(mapSongRecord);
}

async function searchAll(keyword, limit = 5) {
    const result = await run(`search all --keyword "${escapeShellArg(keyword)}"`);
    if (result.code !== 200 || !result.data) return result.data || {};

    const data = result.data;
    const out = {};

    if (data.songs?.length) {
        out.songs = data.songs.slice(0, limit).map(mapSongRecord);
    }

    if (data.playlists?.length) {
        out.playlists = data.playlists.slice(0, limit).map(p => ({
            playlistId: p.originalId,
            encryptedId: p.id,
            name: p.name,
            trackCount: p.trackCount,
            playCount: p.playCount,
            creator: p.creatorNickName || '',
            description: p.describe || ''
        }));
    }

    if (data.bestMatchResources?.length) {
        out.bestMatch = data.bestMatchResources.map(b => ({
            type: b.resourceType,
            name: b.resource?.name,
            id: b.resource?.originalId,
            encryptedId: b.resource?.id
        }));
    }

    return out;
}

async function recommendDaily(limit = 10) {
    const result = await run(`recommend daily --limit ${limit}`);
    if (result.code !== 200) throw new Error(result.message || '获取推荐失败');
    const records = Array.isArray(result.data) ? result.data : (result.data?.records || result.data?.dailySongs || []);
    return records.slice(0, limit).map(mapSongRecord);
}

async function checkLogin() {
    const result = await run('login --check');
    return { loggedIn: !!result.success, message: result.message || '' };
}

async function login() {
    const result = await run('login');
    return result;
}

function formatDuration(ms) {
    if (!ms) return '0:00';
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${sec.toString().padStart(2, '0')}`;
}

// ==================== 歌单管理 ====================

async function playlistCreated(limit = 20) {
    const result = await run(`playlist created --limit ${limit}`);
    const records = result.data?.records || [];
    return records.map(p => ({
        playlistId: p.originalId,
        encryptedId: p.id,
        name: p.name,
        trackCount: p.trackCount,
        creator: p.creatorNickName || '',
        coverUrl: p.coverImgUrl || ''
    }));
}

async function playlistCollected(limit = 20) {
    const result = await run(`playlist collected --limit ${limit}`);
    const records = result.data?.records || [];
    return records.map(p => ({
        playlistId: p.originalId,
        encryptedId: p.id,
        name: p.name,
        trackCount: p.trackCount,
        creator: p.creatorNickName || '',
        coverUrl: p.coverImgUrl || ''
    }));
}

async function playlistTracks(encryptedPlaylistId, limit = 30, offset = 0) {
    const result = await run(`playlist tracks --playlistId ${encryptedPlaylistId} --limit ${limit} --offset ${offset}`);
    const records = result.data?.records || result.data || [];
    const songs = Array.isArray(records) ? records : [];
    return songs.map(s => ({
        ...mapSongRecord(s),
        addTime: s.extMap?.addTime ? Number(s.extMap.addTime) : null
    }));
}

async function playlistDetail(encryptedPlaylistId) {
    const result = await run(`playlist get --playlistId ${encryptedPlaylistId}`);
    const p = result.data || {};
    return {
        playlistId: p.originalId,
        encryptedId: p.id,
        name: p.name,
        trackCount: p.trackCount,
        playCount: p.playCount,
        creator: p.creatorNickName || '',
        description: p.describe || '',
        coverUrl: p.coverImgUrl || ''
    };
}

async function playlistCreate(name) {
    const result = await run(`playlist create --playlistName "${escapeShellArg(name)}"`);
    return result.data || result;
}

async function playlistAddSongs(encryptedPlaylistId, encryptedSongIds) {
    const idList = JSON.stringify(encryptedSongIds);
    const result = await run(`playlist add --playlistId ${encryptedPlaylistId} --songIdList "${escapeShellArg(idList)}"`);
    return result;
}

async function playlistRemoveSongs(encryptedPlaylistId, encryptedSongIds) {
    const idList = JSON.stringify(encryptedSongIds);
    const result = await run(`playlist remove --playlistId ${encryptedPlaylistId} --songIdList "${escapeShellArg(idList)}"`);
    return result;
}

// ==================== 智能推荐 ====================

async function recommendFM(limit = 10) {
    const allSongs = [];
    const seen = new Set();
    const maxRounds = Math.ceil(limit / 3) + 1;

    for (let i = 0; i < maxRounds && allSongs.length < limit; i++) {
        try {
            const result = await run('recommend fm');
            if (result.code !== 200) break;
            const records = Array.isArray(result.data) ? result.data : (result.data?.records || []);
            for (const s of records) {
                const key = s.id || s.originalId;
                if (seen.has(key)) continue;
                seen.add(key);
                allSongs.push(mapSongRecord(s));
            }
        } catch { break; }
    }

    if (!allSongs.length) throw new Error('获取私人漫游失败');
    return allSongs.slice(0, limit);
}

async function recommendHeartbeat(playlistEncId, songEncId, count = 20) {
    if (!playlistEncId) throw new Error('心动模式需要红心歌单ID');
    let args = `recommend heartbeat --playlistId ${playlistEncId}`;
    if (songEncId) args += ` --songId ${songEncId}`;
    args += ` --count ${count}`;
    const result = await run(args);
    if (result.code !== 200) throw new Error(result.message || '获取心动推荐失败');
    const records = Array.isArray(result.data) ? result.data : (result.data?.records || []);
    return records.map(mapSongRecord);
}

async function playlistRadar() {
    const result = await run('playlist radar');
    if (result.code !== 200) throw new Error(result.message || '获取雷达歌单失败');
    const records = result.data?.records || result.data || [];
    return (Array.isArray(records) ? records : []).map(p => ({
        playlistId: p.originalId,
        encryptedId: p.id,
        name: p.name,
        trackCount: p.trackCount,
        description: p.describe || ''
    }));
}

// ==================== 用户偏好数据 ====================

async function userFavoritePlaylist() {
    const result = await run('user favorite');
    if (result.code !== 200) throw new Error(result.message || '获取红心歌单失败');
    const p = result.data || {};
    return {
        playlistId: p.originalId,
        encryptedId: p.id,
        name: p.name,
        trackCount: p.trackCount || 0
    };
}

async function userFavoriteSongs(limit = 200) {
    const info = await userFavoritePlaylist();
    if (!info.encryptedId) throw new Error('未找到红心歌单');
    let songs = [];
    let offset = 0;
    const pageSize = Math.min(limit, 500);
    while (songs.length < limit) {
        const page = await playlistTracks(info.encryptedId, pageSize, offset);
        if (!page.length) break;
        songs.push(...page);
        if (page.length < pageSize) break;
        offset += pageSize;
    }
    return songs.slice(0, limit);
}

async function userHistory(limit = 50) {
    const result = await run(`user history --limit ${limit}`);
    if (result.code !== 200) throw new Error(result.message || '获取播放历史失败');
    const records = Array.isArray(result.data) ? result.data : (result.data?.records || []);
    return records.slice(0, limit).map(s => ({
        songId: s.originalId,
        encryptedId: s.id,
        name: s.name,
        artist: (s.artists || []).map(a => a.name).join('/'),
        album: s.album?.name || '',
        tags: s.songTag || []
    }));
}

async function userListenRanking(limit = 50) {
    const result = await run(`user listen-ranking --limit ${limit}`);
    if (result.code !== 200) throw new Error(result.message || '获取听歌排行失败');
    const records = Array.isArray(result.data) ? result.data : (result.data?.records || []);
    return records.slice(0, limit).map(s => ({
        songId: s.originalId,
        encryptedId: s.id,
        name: s.name,
        artist: (s.artists || []).map(a => a.name).join('/'),
        album: s.album?.name || '',
        tags: s.songTag || []
    }));
}

module.exports = {
    parseNcmCliStdout, applyAuthConfig, isLoginRequiredError, mapSongRecord,
    searchSongs, searchAll, recommendDaily, checkLogin, login, run,
    playlistCreated, playlistCollected, playlistTracks, playlistDetail,
    playlistCreate, playlistAddSongs, playlistRemoveSongs,
    recommendFM, recommendHeartbeat, playlistRadar,
    userFavoritePlaylist, userFavoriteSongs, userHistory, userListenRanking
};
