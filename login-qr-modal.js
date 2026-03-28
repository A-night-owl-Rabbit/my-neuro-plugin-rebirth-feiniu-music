const path = require('path');
const ncm = require('./ncm-bridge');

const MODAL_ID = 'feiniu-netease-login-qr-modal';
/** 与主进程里 mousemove 里反复设置的穿透逻辑对抗，否则按钮永远点不到 */
const HOLD_CLICKABLE_MS = 60;
/** ncm-cli login 子进程退出后内部轮询往往已结束，由插件轮询 login --check */
const POLL_LOGIN_MS = 2000;
const POLL_LOGIN_MAX_MS = 10 * 60 * 1000;

function tryLoadQrcode() {
    try {
        return require(path.join(__dirname, 'node_modules', 'qrcode'));
    } catch {
        try {
            return require('qrcode');
        } catch {
            return null;
        }
    }
}

/**
 * @param {string} text - 写入二维码的内容（与 ncm-cli 返回的 qrCodeUrl 一致）
 * @returns {Promise<string>} data URL 或 https 图片 URL
 */
async function buildQrImageSrc(text) {
    const QRCode = tryLoadQrcode();
    if (QRCode) {
        return QRCode.toDataURL(text, { margin: 2, width: 280, errorCorrectionLevel: 'M' });
    }
    const enc = encodeURIComponent(text);
    return `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${enc}`;
}

function setMainWindowClickThrough(clickThrough) {
    try {
        const { ipcRenderer } = require('electron');
        if (!ipcRenderer?.send) return;
        if (clickThrough) {
            ipcRenderer.send('set-ignore-mouse-events', { ignore: true, options: { forward: true } });
        } else {
            ipcRenderer.send('set-ignore-mouse-events', { ignore: false, options: { forward: false } });
        }
    } catch { /* 非 Electron */ }
}

function disposeModalTimers(root) {
    if (!root) return;
    if (root._feiniuHoldTimer) {
        clearInterval(root._feiniuHoldTimer);
        root._feiniuHoldTimer = null;
    }
    if (root._feiniuPollTimer) {
        clearInterval(root._feiniuPollTimer);
        root._feiniuPollTimer = null;
    }
}

function removeExisting() {
    const el = document.getElementById(MODAL_ID);
    if (el) {
        disposeModalTimers(el);
        setMainWindowClickThrough(true);
        el.remove();
    }
}

function openUrlExternal(url) {
    try {
        const { shell } = require('electron');
        if (shell?.openExternal) {
            shell.openExternal(url);
            return;
        }
    } catch { /* ignore */ }
    try {
        const { exec } = require('child_process');
        const u = String(url).replace(/"/g, '');
        if (process.platform === 'win32') {
            exec(`cmd /c start "" "${u}"`);
        } else if (process.platform === 'darwin') {
            exec(`open "${u}"`);
        } else {
            exec(`xdg-open "${u}"`, () => {});
        }
    } catch { /* ignore */ }
    try {
        window.open(url, '_blank', 'noopener,noreferrer');
    } catch { /* ignore */ }
}

/**
 * 在渲染进程内弹出居中遮罩。弹窗显示期间持续刷新「不穿透」，避免被 Live2D 的 mousemove 逻辑改回穿透。
 * 扫码成功后由插件轮询 ncm-cli login --check 检测并自动关闭（不依赖已退出的 login 子进程）。
 * @param {{ qrCodeUrl: string, message?: string }} opts
 */
async function showNeteaseLoginQrModal(opts) {
    if (typeof document === 'undefined') return;
    const url = opts.qrCodeUrl;
    if (!url) return;

    removeExisting();

    const root = document.createElement('div');
    root.id = MODAL_ID;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', '网易云扫码登录');
    root.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:2147483646',
        'display:flex', 'align-items:center', 'justify-content:center',
        'background:rgba(0,0,0,0.55)', 'font-family:system-ui,Segoe UI,sans-serif',
        '-webkit-app-region:no-drag', 'pointer-events:auto'
    ].join(';');

    const card = document.createElement('div');
    card.style.cssText = [
        'background:#fff', 'border-radius:12px', 'padding:20px 24px', 'max-width:92vw',
        'box-shadow:0 12px 40px rgba(0,0,0,0.35)', 'text-align:center', 'pointer-events:auto'
    ].join(';');

    const title = document.createElement('div');
    title.textContent = '网易云音乐 · 扫码登录';
    title.style.cssText = 'font-size:17px;font-weight:600;margin-bottom:8px;color:#1a1a1a;';

    const sub = document.createElement('div');
    sub.textContent = '请使用网易云音乐 App 扫描下方二维码';
    sub.style.cssText = 'font-size:13px;color:#555;margin-bottom:14px;';

    const img = document.createElement('img');
    img.alt = '登录二维码';
    img.style.cssText = [
        'width:280px', 'height:280px', 'display:block', 'margin:0 auto',
        'border-radius:8px', 'background:#fff', 'object-fit:contain'
    ].join(';');

    let qrOk = false;
    try {
        const src = await buildQrImageSrc(url);
        if (src) {
            img.src = src;
            qrOk = true;
        }
    } catch { /* 备用链接 */ }

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px;color:#666;margin-top:14px;line-height:1.45;max-width:320px;margin-left:auto;margin-right:auto;';
    hint.textContent = '正在等待扫码… 成功后窗口将自动关闭（也可点「关闭」）。';

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'margin-top:18px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '关闭';
    closeBtn.style.cssText = [
        'padding:8px 22px', 'border-radius:8px', 'border:1px solid #ccc',
        'background:#f5f5f5', 'cursor:pointer', 'font-size:14px', 'pointer-events:auto'
    ].join(';');

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.textContent = '在浏览器中打开';
    openBtn.style.cssText = [
        'padding:8px 16px', 'border-radius:8px', 'border:none',
        'background:#d33', 'color:#fff', 'cursor:pointer', 'font-size:14px', 'pointer-events:auto'
    ].join(';');

    const close = () => {
        disposeModalTimers(root);
        setMainWindowClickThrough(true);
        if (root.parentNode) root.remove();
    };

    closeBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        close();
    });
    openBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openUrlExternal(url);
    });
    root.addEventListener('click', (e) => {
        if (e.target === root) close();
    });
    card.addEventListener('click', (e) => e.stopPropagation());

    card.appendChild(title);
    card.appendChild(sub);
    if (qrOk) {
        card.appendChild(img);
    } else {
        const fallback = document.createElement('div');
        fallback.style.cssText = 'font-size:13px;color:#b71c1c;padding:12px;';
        fallback.textContent = '无法生成二维码图片，请点击「在浏览器中打开」完成登录。';
        card.appendChild(fallback);
    }
    card.appendChild(hint);
    btnRow.appendChild(openBtn);
    btnRow.appendChild(closeBtn);
    card.appendChild(btnRow);
    root.appendChild(card);
    document.body.appendChild(root);

    setMainWindowClickThrough(false);
    root._feiniuHoldTimer = setInterval(() => setMainWindowClickThrough(false), HOLD_CLICKABLE_MS);

    const pollDeadline = Date.now() + POLL_LOGIN_MAX_MS;
    let pollBusy = false;
    const tick = async () => {
        if (pollBusy || !document.getElementById(MODAL_ID)) return;
        if (Date.now() > pollDeadline) {
            if (root._feiniuPollTimer) {
                clearInterval(root._feiniuPollTimer);
                root._feiniuPollTimer = null;
            }
            hint.textContent = '长时间未检测到登录，请关闭后重试或再次调用 netease_login。';
            return;
        }
        pollBusy = true;
        try {
            const st = await ncm.checkLogin();
            if (st.loggedIn) {
                hint.textContent = '已登录，正在关闭…';
                disposeModalTimers(root);
                setMainWindowClickThrough(true);
                if (root.parentNode) root.remove();
                return;
            }
        } catch { /* 忽略单次失败 */ } finally {
            pollBusy = false;
        }
    };

    root._feiniuPollTimer = setInterval(() => {
        tick();
    }, POLL_LOGIN_MS);
    setTimeout(() => tick(), 800);
}

module.exports = { showNeteaseLoginQrModal };
