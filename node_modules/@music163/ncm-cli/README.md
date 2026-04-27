# 网易云音乐 CLI

网易云音乐命令行工具，基于网易云音乐开放平台 API，提供音乐搜索、播放控制、歌单管理、每日推荐、TUI 播放器等功能，并支持通过 AI Agent 进行自然语言操作。

## 功能特性

- 音乐搜索与播放控制
- 歌单管理与每日推荐
- TUI 播放器（旋转黑胶、歌词同步、场景切换）
- AI Agent 集成支持
- 多播放器后端支持（mpv）

## 快速开始

### 安装

```bash
npm install -g @music163/ncm-cli
ncm-cli --version
```

### 配置

前往 [网易云音乐开放平台](https://developer.music.163.com/st/developer/apply/account?type=INDIVIDUAL) 完成入驻获取 API 凭证，然后运行配置向导：

```bash
ncm-cli configure
```

配置向导会引导完成以下设置：
- App ID
- Private Key
- 播放器选择

### 登录

```bash
ncm-cli login
```

使用网易云音乐 App 扫描终端中的二维码完成登录授权。

### 基本使用

```bash
ncm-cli search song --keyword "林俊杰"        # 搜索歌曲
ncm-cli play --song --encrypted-id 加密id --original-id 原始id                             # 播放
ncm-cli tui                                     # 启动 TUI 播放器
```

## 使用方式

### AI Agent 集成（推荐）

通过 Claude Code 或 OpenClaw 等 AI Agent 工具，可以使用自然语言进行音乐操作。

**Claude Code 集成**

```bash
npx skills add https://github.com/NetEase/skills
```

**OpenClaw 集成**

```bash
ln -s $(pwd)/skills/netease-music-cli ~/.openclaw/skills/
ln -s $(pwd)/skills/netease-music-assistant ~/.openclaw/skills/
```

集成后支持以下对话示例：

```
> 帮我搜一下林俊杰的歌
> 播放晴天
> 推荐一些适合深夜听的歌
> 帮我创建一个跑步歌单
```

**可用 Skills**

- **netease-music-cli** — 提供搜索、播放、歌单管理等基础操作
- **netease-music-assistant** — 基于红心歌曲的智能推荐，支持定时推送

### CLI 命令行

```bash
ncm-cli search                 # 搜索音乐
ncm-cli play                   # 播放
ncm-cli pause                  # 暂停
ncm-cli resume                 # 恢复播放
ncm-cli next                   # 下一首
ncm-cli prev                   # 上一首
ncm-cli volume 60              # 设置音量（0-100）
ncm-cli state                  # 查看播放状态
ncm-cli --help                 # 查看所有可用命令
```

### TUI 播放器

```bash
ncm-cli tui
```

全屏终端播放器，支持旋转黑胶动画、歌词同步、场景切换等功能。

**快捷键**

| 快捷键 | 功能 |
|--------|------|
| `Space` | 播放 / 暂停 |
| `←` `→` | 上一首 / 下一首 |
| `↑` `↓` | 音量 +5 / -5 |
| `S` | 随机 / 顺序播放切换 / 单曲循环 |
| `L` | 歌词视图 |
| `Q` | 播放列表视图 |
| `C` | 场景选择器 |
| `H` | 收藏 / 取消收藏 |
| `Ctrl+C` | 退出 |

## 系统要求

- **Node.js** >= 18
- **mpv**（本地播放必需）
  - macOS: `brew install mpv`
  - Linux: `sudo apt install mpv`

## 版本历史

### 0.1.2
- 支持笔记发布（图文 / 视频）

### 0.1.1
- 支持网盘歌曲上传（单文件、文件夹批量上传）
- 支持通过文件链接上传
- 后台任务管理，支持秒传加速

### 0.1.0
- 登录（手机扫码）、搜索、歌曲 / 歌单播放、播放控制
- TUI 全屏播放器（旋转黑胶动画、歌词同步、场景切换）
- 跨平台支持（macOS / Linux / Windows）
- 兼容 mpv 0.34+