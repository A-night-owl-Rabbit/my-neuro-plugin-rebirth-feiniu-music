@echo off
chcp 65001 >nul 2>&1
title 重生之网易云没火肥牛要火了 - 安装向导

echo.
echo  ============================================
echo     重生之网易云没火肥牛要火了 - 安装向导
echo  ============================================
echo.

:: 定位本地 ncm-cli
set "NCM_CLI=%~dp0node_modules\.bin\ncm-cli.cmd"
if not exist "%NCM_CLI%" (
    echo  [错误] 未找到 ncm-cli，请确保 node_modules 目录完整。
    echo  如果是手动下载的，请确保下载了完整的仓库文件。
    echo.
    pause
    exit /b 1
)

echo  [提示] 开始配置网易云音乐 API 凭证。
echo  如果还没有 API Key，请前往以下地址申请：
echo  https://developer.music.163.com
echo.
echo  ============================================
echo.

:: 输入 appId
set /p "APP_ID=  请输入 appId: "
if "%APP_ID%"=="" (
    echo  [错误] appId 不能为空！
    pause
    exit /b 1
)

:: 输入 privateKey
echo.
echo  [提示] privateKey 可以直接粘贴内容，也可以输入密钥文件的路径。
set /p "PRIVATE_KEY=  请输入 privateKey: "
if "%PRIVATE_KEY%"=="" (
    echo  [错误] privateKey 不能为空！
    pause
    exit /b 1
)

:: 配置 appId
echo.
echo  [配置] 正在设置 appId...
call "%NCM_CLI%" config set appId "%APP_ID%"
if errorlevel 1 (
    echo  [错误] 设置 appId 失败！
    pause
    exit /b 1
)
echo  [成功] appId 已设置

:: 配置 privateKey
echo  [配置] 正在设置 privateKey...
call "%NCM_CLI%" config set privateKey "%PRIVATE_KEY%"
if errorlevel 1 (
    echo  [错误] 设置 privateKey 失败！
    pause
    exit /b 1
)
echo  [成功] privateKey 已设置

:: 登录
echo.
echo  ============================================
echo  [登录] 正在启动网易云音乐登录...
echo  请用网易云音乐 App 扫描下方链接中的二维码
echo  ============================================
echo.
call "%NCM_CLI%" login
echo.

:: 完成
echo  ============================================
echo.
echo  安装完成！
echo.
echo  使用方法：
echo    1. 确保本文件夹位于:
echo       my-neuro-main\live-2d\plugins\community\rebirth-feiniu-music\
echo    2. 启动（或重启）肥牛应用
echo    3. 对角色说"播放xxx"即可听歌
echo.
echo  ============================================
echo.
pause
