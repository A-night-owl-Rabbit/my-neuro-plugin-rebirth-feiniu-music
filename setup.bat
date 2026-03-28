@echo off
chcp 65001 >nul 2>&1
title 閲嶇敓涔嬬綉鏄撲簯娌＄伀鑲ョ墰瑕佺伀浜?- 瀹夎鍚戝

echo.
echo  ============================================
echo     閲嶇敓涔嬬綉鏄撲簯娌＄伀鑲ョ墰瑕佺伀浜?- 瀹夎鍚戝
echo  ============================================
echo.

:: 瀹氫綅鏈湴 ncm-cli
set "NCM_CLI=%~dp0node_modules\.bin\ncm-cli.cmd"
if not exist "%NCM_CLI%" (
    echo  [閿欒] 鏈壘鍒?ncm-cli锛岃纭繚 node_modules 鐩綍瀹屾暣銆?    echo  濡傛灉鏄墜鍔ㄤ笅杞界殑锛岃纭繚涓嬭浇浜嗗畬鏁寸殑浠撳簱鏂囦欢銆?    echo.
    pause
    exit /b 1
)

echo  [鎻愮ず] 寮€濮嬮厤缃綉鏄撲簯闊充箰 API 鍑瘉銆?echo  濡傛灉杩樻病鏈?API Key锛岃鍓嶅線浠ヤ笅鍦板潃鐢宠锛?echo  https://developer.music.163.com
echo.
echo  ============================================
echo.

:: 杈撳叆 appId
set /p "APP_ID=  璇疯緭鍏?appId: "
if "%APP_ID%"=="" (
    echo  [閿欒] appId 涓嶈兘涓虹┖锛?    pause
    exit /b 1
)

:: 杈撳叆 privateKey
echo.
echo  [鎻愮ず] privateKey 鍙互鐩存帴绮樿创鍐呭锛屼篃鍙互杈撳叆瀵嗛挜鏂囦欢鐨勮矾寰勩€?set /p "PRIVATE_KEY=  璇疯緭鍏?privateKey: "
if "%PRIVATE_KEY%"=="" (
    echo  [閿欒] privateKey 涓嶈兘涓虹┖锛?    pause
    exit /b 1
)

:: 閰嶇疆 appId
echo.
echo  [閰嶇疆] 姝ｅ湪璁剧疆 appId...
call "%NCM_CLI%" config set appId "%APP_ID%"
if errorlevel 1 (
    echo  [閿欒] 璁剧疆 appId 澶辫触锛?    pause
    exit /b 1
)
echo  [鎴愬姛] appId 宸茶缃?
:: 閰嶇疆 privateKey
echo  [閰嶇疆] 姝ｅ湪璁剧疆 privateKey...
call "%NCM_CLI%" config set privateKey "%PRIVATE_KEY%"
if errorlevel 1 (
    echo  [閿欒] 璁剧疆 privateKey 澶辫触锛?    pause
    exit /b 1
)
echo  [鎴愬姛] privateKey 宸茶缃?
:: 鐧诲綍
echo.
echo  ============================================
echo  [鐧诲綍] 姝ｅ湪鍚姩缃戞槗浜戦煶涔愮櫥褰?..
echo  璇风敤缃戞槗浜戦煶涔?App 鎵弿涓嬫柟閾炬帴涓殑浜岀淮鐮?echo  ============================================
echo.
call "%NCM_CLI%" login
echo.

:: 瀹屾垚
echo  ============================================
echo.
echo  瀹夎瀹屾垚锛?echo.
echo  浣跨敤鏂规硶锛?echo    1. 纭繚鏈枃浠跺す浣嶄簬:
echo       my-neuro-main\live-2d\plugins\community\rebirth-feiniu-music\
echo    2. 鍚姩锛堟垨閲嶅惎锛夎偉鐗涘簲鐢?echo    3. 瀵硅鑹茶"鎾斁xxx"鍗冲彲鍚瓕
echo.
echo  ============================================
echo.
pause
