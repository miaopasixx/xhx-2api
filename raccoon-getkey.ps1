# ============================================
# 商汤小浣熊 API Key 一键获取脚本 (零干扰模式)
# 原理: 客户端活跃时会自动续期并把最新凭证明文写入 auth.json
#       本脚本直接读取, 不触发刷新, 不顶掉客户端会话
# 用法: powershell -File raccoon-getkey.ps1
# ============================================
$ErrorActionPreference = 'Stop'
$authFile = 'C:\Users\PC\.box-agent\config\auth.json'

if (-not (Test-Path $authFile)) { throw "找不到 $authFile (客户端未安装或未登录过?)" }
$auth = Get-Content $authFile -Raw -Encoding UTF8 | ConvertFrom-Json
$at = $auth.access_token
if (-not $at) { throw 'auth.json 中没有 access_token' }

# 解码 JWT 的 exp, 计算剩余时间
$p = $at.Split('.')[1].Replace('-','+').Replace('_','/')
while ($p.Length % 4) { $p += '=' }
$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p)) | ConvertFrom-Json
$expLocal = [DateTimeOffset]::FromUnixTimeSeconds($payload.exp).ToLocalTime()
$remain = ($expLocal - (Get-Date)).TotalMinutes

if ($remain -le 0) {
    Write-Output 'access_token 已过期!'
    Write-Output '处理: 打开小浣熊客户端随便发一条消息(触发自动续期), 然后重新运行本脚本'
    exit 1
}

Write-Output '=== 渠道配置信息 ==='
Write-Output '-------------------------------------------'
Write-Output ('API Key (access_token): ' + $at)
Write-Output ('有效期至: ' + $expLocal + ' (剩余约 ' + [math]::Round($remain) + ' 分钟)')
Write-Output ('Base URL:  https://xiaohuanxiong.com/api/web/llm/v2')
Write-Output ('Models:    sn-deepseek-v4-1-flash / sn-deepseek-v4-pro / raccoon-chat-ml-5-5')
Write-Output '-------------------------------------------'
if ($remain -lt 6) {
    Write-Output '警告: 剩余不足6分钟, 客户端马上会自动轮换此key, 建议稍后重跑本脚本'
} else {
    Write-Output '说明: 客户端每约2.8小时自动刷新一次, 刷新后此key立即失效, 重跑本脚本即可取新key'
}
