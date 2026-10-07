# ============================================
# 商汤小浣熊 Token 刷新脚本
# 用法: powershell -File raccoon-refresh.ps1
# 输出: 新的 access_token (填入渠道 API Key), 有效期约3小时
# 注意: 每次刷新 refresh_token 会轮换并自动保存回 raccoon-auth.json
# ============================================
$ErrorActionPreference = 'Stop'
$authFile = Join-Path $PSScriptRoot 'raccoon-auth.json'

if (-not (Test-Path $authFile)) { throw "找不到 $authFile" }
$auth = Get-Content $authFile -Raw -Encoding UTF8 | ConvertFrom-Json
$rt = $auth.refresh_token
if (-not $rt) { throw 'raccoon-auth.json 中没有 refresh_token' }

Write-Output "[1/3] 正在刷新 access_token ..."
$bodyFile = Join-Path $env:TEMP 'raccoon-refresh-body.json'
('{"refresh_token":"' + $rt + '"}') | Set-Content -Path $bodyFile -Encoding ASCII -NoNewline

$raw = curl.exe -s -X POST $auth.auth_api -H 'Content-Type: application/json' --data "@$bodyFile" --noproxy '*' -m 30
if (-not $raw) { throw '刷新请求无响应(网络错误?)' }
$resp = $raw | ConvertFrom-Json

if ($resp.code -ne 0 -or -not $resp.data.access_token) {
    Write-Output ('刷新失败: ' + $raw)
    Write-Output '常见原因: refresh_token 已过期(超30天)或被重新登录轮换 -> 需要重新抓取'
    exit 1
}

# 保存轮换后的新 refresh_token 和 access_token
$auth.refresh_token = $resp.data.refresh_token
if ($auth.PSObject.Properties['access_token']) { $auth.access_token = $resp.data.access_token }
else { $auth | Add-Member -MemberType NoteProperty -Name 'access_token' -Value $resp.data.access_token }
$auth | ConvertTo-Json | Set-Content -Path $authFile -Encoding UTF8

# 解码 access_token 的 exp
$p = $resp.data.access_token.Split('.')[1].Replace('-','+').Replace('_','/')
while ($p.Length % 4) { $p += '=' }
$payload = ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p)) | ConvertFrom-Json)

Write-Output "[2/3] 刷新成功, 新 refresh_token 已保存"
Write-Output "[3/3] 渠道配置信息:"
Write-Output '-------------------------------------------'
Write-Output ('API Key (access_token): ' + $resp.data.access_token)
Write-Output ('有效期至: ' + ([DateTimeOffset]::FromUnixTimeSeconds($payload.exp).ToLocalTime()))
Write-Output ('Base URL:  ' + $auth.base_url)
Write-Output ('Model:     ' + $auth.model)
Write-Output '-------------------------------------------'
Write-Output '将上面 API Key 填入渠道即可, 自定义请求头无需填写'
