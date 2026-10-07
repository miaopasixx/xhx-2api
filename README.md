# xhx-2api

把「商汤小浣熊」客户端的对话能力转成 **OpenAI 兼容 API** 的自建网关：token 自动续期、单文件部署到 Cloudflare Workers、自带管理控制台与用量观测。

```
渠道(NewAPI/one-api/任意客户端)
        │  Base URL: https://你的域名/v1   API Key: 网关密钥
        ▼
┌─────────────────────────────┐
│  CF Worker 网关(本仓库)      │ ← refresh_token 自动滚动续期(30天)
│  ├─ /v1/chat/completions    │    每天07:00自动"心跳"保活,闲置永不断链
│  ├─ /v1/models              │
│  ├─ /admin   管理控制台      │ ← 多Key管理/用量统计/请求日志/模型管理
│  └─ D1 存储(密钥/日志/模型)  │
└─────────────────────────────┘
        ▼
  xiaohuanxiong.com 上游(商汤小浣熊)
```

## 功能

- **OpenAI 兼容转发**：`/v1/chat/completions`（流式 SSE + 非流式）、`/v1/models`
- **Token 全自动生命周期**：access_token 3h 自动续期、refresh_token 30 天滚动、每日 07:00 心跳对话保活（闲置也永不断链）
- **多 Key 密钥体系**：初始密钥(防锁死) / 主密钥(可替换) / 渠道密钥(仅业务权限、可增删停用)
- **用量观测**：每次请求记录 时间/模型/Key/成功/流式/输入输出Token/首字延迟/端到端/吞吐量/结束原因，含今日与7日统计、按模型分组
- **管理控制台**：https://你的域名/admin —— 脉搏带心跳图表、保活历史、模型增删改（即时生效）、Key 管理、请求日志
- **到期告警**：`NOTIFY_URL` webhook + 每日 cron 检查

## 部署（Cloudflare Workers，5分钟）

```bash
# 1. 克隆
git clone https://github.com/miaopasixx/xhx-2api.git
cd xhx-2api

# 2. 登录 Cloudflare
npx wrangler login

# 3. 创建 D1 数据库, 把输出的 id 填进 wrangler.toml
npx wrangler d1 create raccoon-db

# 4. 设置网关密钥(渠道与管理台的初始密钥)
npx wrangler secret put GATEWAY_KEY

# 5. (可选)密钥到期自动提醒 webhook
npx wrangler secret put NOTIFY_URL

# 6. 部署
npx wrangler deploy

# 7. 绑自定义域名(可选): wrangler.toml 里改 routes 的 pattern 为你的域名

# 8. 注入凭证(见下文)
curl -X POST https://你的域名/init \
  -H "Authorization: Bearer <GATEWAY_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"refresh_token": "<你的refresh_token>"}'
```

## 获取 refresh_token

本仓库提供三种方式（按推荐度）：

1. **明文配置文件（最简单）**：已登录的客户端会在 `~/.box-agent/config/auth.json` 写入明文 `refresh_token`，直接读取即可
2. **PowerShell 脚本**：`raccoon-getkey.ps1` 一键提取最新 access_token / refresh_token
3. **进程内存转储（密文存储的客户端）**：`procdump -ma <pid>` 全量转储后从内存字符串中提取 JWT（详见博客文章）

> ⚠️ 上游为单活会话：refresh_token 一旦被其他端使用即轮换失效。凭证注入网关后，**不要再让原客户端登录同一账号**，否则会互相顶断。

## 文件说明

| 文件 | 用途 |
|---|---|
| `raccoon-worker.js` | CF Worker 网关主体（转发/续期/保活/多Key鉴权/观测/管理API） |
| `admin.html` | 管理控制台页面（Worker 直接托管在 /admin） |
| `wrangler.toml` | 部署配置（D1 绑定 / 自定义域名 / cron） |
| `raccoon-proxy.py` | 本地版网关（Python，零依赖，读客户端 auth.json 共享会话） |
| `raccoon-proxy-cloud.py` | VPS 版网关（Python，自持凭证滚动续期，强制网关密钥） |
| `start-raccoon-proxy.bat` | 本地网关启动器（可放 shell:startup 开机自启） |
| `raccoon-getkey.ps1` | 一键提取最新 access_token（零干扰模式） |
| `raccoon-refresh.ps1` | 用 refresh_token 手动换新 access_token（接管模式） |

## 渠道接入

| 字段 | 值 |
|---|---|
| Base URL | `https://你的域名/v1` |
| API Key | 网关密钥（或管理台创建的渠道密钥） |
| Model | `sn-deepseek-v4-1-flash` / `sn-deepseek-v4-pro` / `raccoon-chat-ml-5-5` / `sn-glm-5-3` / `sn-kimi-k3` 等（管理台可增删） |

## 声明

仅供学习研究个人使用。请遵守上游服务条款，账号封禁等风险自负。

> AI生成
