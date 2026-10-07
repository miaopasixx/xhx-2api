@echo off
rem 商汤小浣熊本地自动续期网关启动器
rem 双击启动(最小化窗口); 关闭窗口或Ctrl+C即停止
rem 如需开机自启: Win+R 输入 shell:startup, 把本文件快捷方式放进去
cd /d G:\任务3
start "raccoon-proxy" /min python raccoon-proxy.py 8807
echo 网关已启动: http://127.0.0.1:8807/v1 (窗口已最小化)
timeout /t 2 >nul
