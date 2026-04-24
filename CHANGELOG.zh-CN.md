# 更新说明

## 2026-04-25（v2.1.0）

### B 站音乐回退与歌词辅助

- **B 站回退**（`bili-music-fallback.js`）：当网易云搜不到或无法播放时，可自动从 B 站搜索音乐类视频，使用本机 **yt-dlp** 拉取音源，经本机临时 HTTP 服务供播放器使用。支持在插件配置中开关、最低播放量、最大时长、yt-dlp 路径等。
- **歌词辅助**（`lyrics-finder.js`）：在部分外链 / 回退场景下辅助歌词显示。
- **依赖**：`bilibili-api-ts`、`axios` 等，已写入 `package.json` 与 `package-lock.json`（与本地一致）。

### 仓库与隐私

- **`metadata.json`**：版本号 **2.1.0**。
- **`plugin_config.json`**：继续仅含字段说明；`appId` / `privateKey` 的 `value` 为空；歌词气泡偏移等为文档默认（`-20` / `-20`），不附带本机布局。
- **不纳入版本库**：`temp_bili_audio/` 临时下载目录与 cookies 等见根目录 `.gitignore`，请勿将个人凭证提交到公开仓库。
- **不纳入 `node_modules/dependencies/`**：为 `bilibili-api-ts` 的误依赖 `dependencies@0.0.1` 包，其嵌套 `request` 含测试用示例凭证，会触发 GitHub 推送保护；**运行时代码未 `require` 此包**；本机 `npm install` 后若出现该目录可忽略，勿提交到 Git。

## 2026-04-12（v2.0.3）

### 队列解析与替代版本（`queue-manager.js`）

- **伴奏 / 器乐版识别**：新增 `isLikelyInstrumentalOrKaraokeName`，识别歌名中含「伴奏」「instrumental」「off vocal」「karaoke」等常见器乐/伴奏表述。
- **解析顺序**：在「搜索到可播放版本」「播放替代版」分支中引入 `sortPlayableCandidates`：在可播放候选之间**优先尝试人声版 URL 解析**，器乐/伴奏版排在后面，降低「主歌被伴奏顶替」的概率；日志中会对器乐/伴奏候选附加标注，便于排查。

### 仓库与元数据

- **`metadata.json`**：版本号 **2.0.3**。
- **`plugin_config.json`**：与公开仓库规范一致，`appId` / `privateKey` 的 `value` 为空；歌词气泡偏移等与文档默认一致，不附带本机个人布局参数。

## 2026-04-10（v2.0.2）

- **系统提示词**：仓库 `index.js` 中的 `addSystemPromptPatch`（`_updatePlaybackPrompt`）恢复为与日常使用一致的**完整版**引导说明（工具选用、播放中勿误停音乐等），便于 Fork 后直接获得与作者推荐配置相近的 AI 行为。

## 2026-04-10（v2.0.1）

### 播放选曲逻辑（`netease_play`）

- **问题**：此前按「免费可播 → VIP 可播」排序，未考虑搜索关键词与歌名、歌手的相关性。同一歌名存在多版本（例如合作版与「伴奏」版）时，容易优先播放非 VIP 的伴奏，即使用户已登录 VIP。
- **改动**：新增 `_rankCandidates`，对未下架结果按「关键词与歌名/歌手匹配度」综合排序；对歌名中含「伴奏」「instrumental」「纯音乐」等版本降权，可播放性仅作小幅加分，避免伴奏误播为主曲。

### 仓库与隐私

- **`plugin_config.json`**：继续仅提交字段说明与空 `value`（含 `audio_quality` 默认值），不包含开放平台密钥与个人界面偏移。
- **系统提示**：v2.0.1 曾随仓库附带最短版提示；**v2.0.2 起**已改为完整版（见上文）。

## 2026-03-30

- **移除安装脚本**：删除 `setup.bat`（及此前本地的 `setup-wizard.js` 方案），避免 CMD `set /p` 无法可靠粘贴多行私钥等问题。
- **文档**：`README.md` 更新为在肥牛 **插件配置** 中填写 `appId` / `privateKey`；**首次登录**请对角色说「登录网易云」等，由 AI 调用 `netease_login` 完成扫码。

## 2026-03-29

本次同步自本地肥牛社区插件目录，与上一版公开仓库相比主要变化如下。

### 功能与代码

- **扫码登录体验**：新增 `login-qr-modal.js`，在应用内弹出扫码遮罩，登录流程由插件侧轮询 `ncm-cli` 登录状态，扫码成功后自动关闭，减少对终端窗口的依赖。
- **依赖**：增加 `qrcode` 依赖（`package.json` / `package-lock.json`），用于生成登录二维码展示。
- **歌词气泡**：`plugin_config.json` 配置项扩展（如垂直/水平内边距等），与当前插件内 `index.js` 样式注入逻辑一致。
- **元数据**：`metadata.json` 版本与描述与当前插件保持一致（如 `2.0.0`）。

### 仓库与隐私说明

- **不包含开放平台密钥**：仓库中的 `plugin_config.json` 内 `appId`、`privateKey` 的 `value` 为空，请在本机插件配置界面填写，切勿将真实密钥提交到公开仓库。
- **系统提示补丁**：公开仓库中的 `addSystemPromptPatch` 内容为最短功能说明，避免上传冗长提示词；若你需要与本地完全一致的对话引导策略，请在本地自行维护 `index.js` 中对应段落。
- **个人界面参数**：公开配置中的歌词气泡偏移等已恢复为文档默认示例值，避免附带个人布局偏好。

### 使用方式

安装、API Key 与扫码登录流程以仓库根目录 `README.md` 为准。
