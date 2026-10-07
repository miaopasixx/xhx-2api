/**
 * 商汤小浣熊 Cloudflare Worker 自动续期网关 + 管理控制台 + 用量观测
 * ============================================================
 * 渠道配置: Base URL = https://<域名>/v1 , API Key = 任意有效Key(见密钥管理)
 * 管理控制台: https://<域名>/admin
 *
 * 密钥体系:
 *   - 初始密钥(部署时的 GATEWAY_KEY secret): 永远有效, 管理权限(防止锁死)
 *   - 主密钥(settings表, 可在管理台替换): 管理权限
 *   - 渠道密钥(apikeys表, 管理台增删停用): 仅业务调用 /v1/*
 *
 * 请求观测: 每次 /v1/chat/completions 记录
 *   时间/模型/Key/成功/流式类型/输入输出Token/首字延迟/端到端/吞吐量/结束原因
 *   (缓存命中上游不提供; 非流式无首字概念, TTFT显示--)
 *   日志保留90天, 每天07:00保活时自动清理
 */

import ADMIN_HTML from './admin.html';

const UPSTREAM_HOST = 'https://xiaohuanxiong.com';
const UPSTREAM_API = '/api/web/llm/v2';
const REFRESH_URL = 'https://xiaohuanxiong.com/api/web/auth/v1/refresh';
const MODELS = [
  'sn-deepseek-v4-1-flash', 'sn-deepseek-v4-pro', 'raccoon-chat-ml-5-5',
  'sn-glm-5-3', 'sn-glm-5-3-flash', 'sn-kimi-k3',
  'sn-SenseNova-6-8-Flash', 'sn-SenseNova-6-8-Flash-Lite',
];
const REFRESH_ALERT_DAYS = 7;
const DB_TABLE = 'tokens';
const DB_KEY = 'raccoon';
const KEEPALIVE_PROMPT = '你好，请帮我确认一下服务是否正常运行，可以简单回复一句话即可。';
const KEEPALIVE_MODEL = 'sn-deepseek-v4-1-flash';
const LOG_RETENTION_DAYS = 90;

function json(code, obj) {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jwtExp(token) {
  try {
    const p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = '='.repeat((4 - (p.length % 4)) % 4);
    const payload = JSON.parse(atob(p + pad));
    return payload.exp || 0;
  } catch (e) {
    return 0;
  }
}

/* ================= D1 基础 ================= */

async function ensureTables(env) {
  const db = env.raccoon_db;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS tokens (k TEXT PRIMARY KEY, v TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, ok INTEGER, rt_days REAL, reply TEXT, duration_ms INTEGER, detail TEXT, trigger_type TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS models (name TEXT PRIMARY KEY, created_at INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS apikeys (k TEXT PRIMARY KEY, label TEXT, role TEXT, status INTEGER, created_at INTEGER, last_used_at INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS reqlog (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, model TEXT, api_key TEXT, ok INTEGER, stream INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, ttft_ms INTEGER, e2e_ms INTEGER, tps REAL, finish_reason TEXT, http_status INTEGER, error TEXT)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_reqlog_ts ON reqlog (ts)'),
  ]);
  const cnt = await db.prepare('SELECT COUNT(*) AS c FROM models').first();
  if (!cnt || cnt.c === 0) {
    await db.batch(MODELS.map(function (m, i) {
      return db.prepare('INSERT OR IGNORE INTO models (name, created_at) VALUES (?, ?)').bind(m, Date.now() + i);
    }));
  }
}

async function getSetting(env, k) {
  const r = await env.raccoon_db.prepare('SELECT v FROM settings WHERE k = ?').bind(k).first();
  return r ? r.v : null;
}

async function setSetting(env, k, v) {
  await env.raccoon_db.prepare('INSERT OR REPLACE INTO settings (k, v) VALUES (?, ?)').bind(k, v).run();
}

async function getTokens(env) {
  await ensureTables(env);
  const r = await env.raccoon_db.prepare('SELECT v FROM ' + DB_TABLE + ' WHERE k = ?').bind(DB_KEY).first();
  return r ? JSON.parse(r.v) : null;
}

async function saveTokens(env, t) {
  await ensureTables(env);
  await env.raccoon_db.prepare('INSERT OR REPLACE INTO ' + DB_TABLE + ' (k, v) VALUES (?, ?)').bind(DB_KEY, JSON.stringify(t)).run();
}

async function getModels(env) {
  await ensureTables(env);
  const r = await env.raccoon_db.prepare('SELECT name FROM models ORDER BY created_at').all();
  return (r.results || []).map(function (x) { return x.name; });
}

async function saveModels(env, list) {
  const db = env.raccoon_db;
  await ensureTables(env);
  const stmts = [db.prepare('DELETE FROM models')];
  const seen = {};
  list.forEach(function (m, i) {
    if (m && !seen[m]) { seen[m] = 1; stmts.push(db.prepare('INSERT INTO models (name, created_at) VALUES (?, ?)').bind(m, Date.now() + i)); }
  });
  await db.batch(stmts);
}

async function addHistory(env, rec) {
  await env.raccoon_db.prepare(
    'INSERT INTO history (ts, ok, rt_days, reply, duration_ms, detail, trigger_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(rec.ts, rec.ok ? 1 : 0, rec.rt_days, rec.reply || '', rec.duration_ms || 0,
       JSON.stringify(rec.detail || {}), rec.trigger_type || 'cron').run();
}

async function addReqLog(env, rec) {
  try {
    await env.raccoon_db.prepare(
      'INSERT INTO reqlog (ts, model, api_key, ok, stream, prompt_tokens, completion_tokens, ttft_ms, e2e_ms, tps, finish_reason, http_status, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
    ).bind(rec.ts, rec.model || '', rec.api_key || '', rec.ok ? 1 : 0, rec.stream ? 1 : 0,
       rec.prompt_tokens == null ? null : rec.prompt_tokens, rec.completion_tokens == null ? null : rec.completion_tokens,
       rec.ttft_ms == null ? null : rec.ttft_ms, rec.e2e_ms == null ? null : rec.e2e_ms,
       rec.tps == null ? null : rec.tps, rec.finish_reason || null,
       rec.http_status == null ? null : rec.http_status, rec.error || null).run();
  } catch (e) { /* 日志失败不影响业务 */ }
}

/* ================= 鉴权(多Key + 角色) ================= */

async function authRequest(env, bearer, needAdmin) {
  if (!bearer || bearer.indexOf('Bearer ') !== 0) return null;
  const key = bearer.slice(7);
  // 1. 初始密钥(secret, 永远有效, 管理权限)
  if (env.GATEWAY_KEY && key === env.GATEWAY_KEY) return { key: key, role: 'admin', label: '初始密钥' };
  // 2. 主密钥(settings表, 可替换, 管理权限)
  try {
    await ensureTables(env);
    const mk = await getSetting(env, 'gateway_key');
    if (mk && key === mk) return { key: key, role: 'admin', label: '主密钥' };
  } catch (e) { /* 表未就绪 */ }
  // 3. apikeys 表(渠道/管理)
  try {
    const row = await env.raccoon_db.prepare('SELECT * FROM apikeys WHERE k = ?').bind(key).first();
    if (row && row.status === 1) {
      if (needAdmin && row.role !== 'admin') return null;
      return { key: key, role: row.role, label: row.label };
    }
  } catch (e) { /* 表未就绪 */ }
  return null;
}

/* ================= token 续期 ================= */

async function refreshCall(rt) {
  const resp = await fetch(REFRESH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: rt }),
  });
  const data = await resp.json();
  if (data.code !== 0 || !data.data || !data.data.access_token) {
    throw new Error(JSON.stringify(data));
  }
  return data.data;
}

async function getAccessToken(env) {
  let t = await getTokens(env);
  if (!t || !t.refresh_token) {
    throw new Error('尚未注入凭证: 请 POST {"refresh_token":"..."} 到 /init');
  }
  const now = Date.now() / 1000;
  if (t.access_token && jwtExp(t.access_token) - now > 120) return t.access_token;
  try {
    const d = await refreshCall(t.refresh_token);
    await saveTokens(env, {
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      updated_at: Date.now(),
    });
    return d.access_token;
  } catch (e) {
    t = await getTokens(env);
    if (t && t.access_token && jwtExp(t.access_token) - Date.now() / 1000 > 120) {
      return t.access_token;
    }
    throw new Error(
      'refresh_token 已失效(被客户端重登顶掉 或 闲置超30天过期). ' +
      '请从本地 auth.json 提取最新 refresh_token 后重新注入: POST /init . 上游返回: ' + e.message
    );
  }
}

/* ================= 保活核心 ================= */

async function keepaliveCore(env, triggerType) {
  const start = Date.now();
  const rec = { ts: start, ok: 0, rt_days: null, reply: '', duration_ms: 0, detail: {}, trigger_type: triggerType };
  const t = await getTokens(env);
  if (!t || !t.refresh_token) {
    rec.detail = { error: '未注入凭证, 请 POST /init 注入' };
    try { await addHistory(env, rec); } catch (e) {}
    return { ok: false, error: '未注入凭证', duration_ms: Date.now() - start, detail: rec.detail };
  }
  try {
    const at = await getAccessToken(env);
    const resp = await fetch(UPSTREAM_HOST + UPSTREAM_API + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + at },
      body: JSON.stringify({
        model: KEEPALIVE_MODEL,
        messages: [{ role: 'user', content: KEEPALIVE_PROMPT }],
        max_tokens: 100,
      }),
    });
    if (!resp.ok) throw new Error('上游HTTP ' + resp.status);
    const data = await resp.json();
    const reply = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    const after = await getTokens(env);
    rec.ok = 1;
    rec.reply = reply;
    rec.duration_ms = Date.now() - start;
    rec.rt_days = after && after.refresh_token ? +((jwtExp(after.refresh_token) - Date.now() / 1000) / 86400).toFixed(1) : null;
    rec.detail = {
      http_status: resp.status,
      model: KEEPALIVE_MODEL,
      prompt: KEEPALIVE_PROMPT,
      usage: data.usage || null,
      access_token_exp: after && after.access_token ? new Date(jwtExp(after.access_token) * 1000).toISOString() : null,
      refresh_token_exp: after && after.refresh_token ? new Date(jwtExp(after.refresh_token) * 1000).toISOString() : null,
      refreshed: !!(t.updated_at && after && after.updated_at && after.updated_at !== t.updated_at),
    };
    try { await addHistory(env, rec); } catch (e) {}
    // 90天日志自动清理
    try {
      const cutoff = Date.now() - LOG_RETENTION_DAYS * 86400000;
      await env.raccoon_db.batch([
        env.raccoon_db.prepare('DELETE FROM reqlog WHERE ts < ?').bind(cutoff),
        env.raccoon_db.prepare('DELETE FROM history WHERE ts < ?').bind(cutoff),
      ]);
    } catch (e) {}
    return { ok: true, reply: reply, rt_days: rec.rt_days, duration_ms: rec.duration_ms, detail: rec.detail };
  } catch (e) {
    rec.duration_ms = Date.now() - start;
    rec.detail = { error: String(e.message || e) };
    try { await addHistory(env, rec); } catch (err) {}
    if (env.NOTIFY_URL) {
      try {
        await fetch(env.NOTIFY_URL, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: '【小浣熊网关】保活失败(' + triggerType + ')! 链路异常或 refresh_token 已失效. 请重新注入: POST /init . 错误: ' + e.message }),
        });
      } catch (err2) {}
    }
    return { ok: false, error: String(e.message || e), duration_ms: rec.duration_ms, detail: rec.detail };
  }
}

/* ================= 统计聚合 ================= */

function bjDayStart(offsetDays) {
  // 北京时间(UTC+8) 今日0点 或 N天前0点
  const now = Date.now() + 8 * 3600000;
  const today0 = now - (now % 86400000);
  return today0 - (offsetDays || 0) * 86400000 - 8 * 3600000; // 转回epoch(减8h)
}

async function getStats(env) {
  const db = env.raccoon_db;
  const today0 = bjDayStart(0);
  const week0 = bjDayStart(6);
  const agg = function (rows) {
    if (!rows) return null;
    const r = rows;
    const c = r.c || 0;
    return {
      count: c,
      ok: r.ok || 0,
      success_rate: c ? +(r.ok * 100 / c).toFixed(1) : null,
      prompt_tokens: r.pt || 0,
      completion_tokens: r.ct || 0,
      avg_ttft_ms: r.attft ? Math.round(r.attft) : null,
      avg_e2e_ms: r.ae2e ? Math.round(r.ae2e) : null,
      avg_tps: r.atps ? +(+r.atps).toFixed(1) : null,
    };
  };
  const sel = 'SELECT COUNT(*) c, SUM(ok) ok, SUM(prompt_tokens) pt, SUM(completion_tokens) ct, AVG(ttft_ms) attft, AVG(e2e_ms) ae2e, AVG(tps) atps FROM reqlog WHERE ts >= ?';
  const today = await db.prepare(sel).bind(today0).first();
  const week = await db.prepare(sel).bind(week0).first();
  const byModel = await db.prepare(
    'SELECT model, COUNT(*) c, SUM(ok) ok, SUM(prompt_tokens) pt, SUM(completion_tokens) ct, AVG(ttft_ms) attft, AVG(e2e_ms) ae2e, AVG(tps) atps FROM reqlog WHERE ts >= ? GROUP BY model ORDER BY c DESC LIMIT 20'
  ).bind(week0).all();
  return {
    today: agg(today),
    week: agg(week),
    by_model: (byModel.results || []).map(function (m) { return { model: m.model, stats: agg(m) }; }),
  };
}

/* ================= 主入口 ================= */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---- /admin 管理控制台(HTML壳) ----
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      return new Response(ADMIN_HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }

    // ---- 鉴权: 管理路径需要admin角色, /v1/* 允许渠道密钥 ----
    const isAdminPath = url.pathname === '/init' || url.pathname === '/status' || url.pathname.indexOf('/admin/api/') === 0;
    const auth = await authRequest(env, request.headers.get('Authorization') || '', isAdminPath);
    if (!auth) {
      return json(401, { error: { message: '密钥无效或权限不足', type: 'gateway_auth_error' } });
    }
    // 管理路径统一确保数据表存在(幂等)
    if (isAdminPath) {
      try { await ensureTables(env); } catch (e) { /* 建表失败由具体查询报错 */ }
    }

    /* ---------- 管理API ---------- */
    if (url.pathname === '/admin/api/overview' && request.method === 'GET') {
      const t = await getTokens(env);
      const now = Date.now() / 1000;
      const atExp = t && t.access_token ? jwtExp(t.access_token) : 0;
      const rtExp = t && t.refresh_token ? jwtExp(t.refresh_token) : 0;
      const rtDays = rtExp ? (rtExp - now) / 86400 : -1;
      const hist = await env.raccoon_db.prepare('SELECT * FROM history ORDER BY ts DESC LIMIT 40').all();
      const models = await getModels(env);
      const keys = await env.raccoon_db.prepare('SELECT k, label, role, status, created_at, last_used_at FROM apikeys ORDER BY created_at DESC').all();
      const mainKey = await getSetting(env, 'gateway_key');
      const totalReq = await env.raccoon_db.prepare('SELECT COUNT(*) c FROM reqlog').first();
      const stats = await getStats(env);
      return json(200, {
        gateway: {
          url: new URL(request.url).origin, name: 'raccoon-gateway',
          bootstrap_key: env.GATEWAY_KEY || '',       // 初始密钥(永远有效)
          main_key: mainKey || '',                    // 主密钥(可替换)
        },
        tokens: {
          access_token: {
            exp: atExp ? new Date(atExp * 1000).toISOString() : null,
            remain_minutes: atExp ? Math.max(0, Math.round((atExp - now) / 60)) : 0,
          },
          refresh_token: {
            exp: rtExp ? new Date(rtExp * 1000).toISOString() : null,
            remain_days: rtDays >= 0 ? rtDays.toFixed(1) : null,
          },
          updated_at: t && t.updated_at ? t.updated_at : null,
          alert: rtDays >= 0 && rtDays < REFRESH_ALERT_DAYS
            ? 'refresh_token 剩余不足 ' + REFRESH_ALERT_DAYS + ' 天, 请尽快重新注入(POST /init), 避免断链'
            : null,
        },
        history: (hist.results || []).map(function (h) {
          return {
            ts: h.ts, ok: !!h.ok, rt_days: h.rt_days, reply: h.reply,
            duration_ms: h.duration_ms, detail: JSON.parse(h.detail || '{}'), trigger_type: h.trigger_type,
          };
        }),
        models: models,
        default_models: MODELS,
        keys: (keys.results || []).map(function (r) { return r; }),
        stats: stats,
        reqlog_total: totalReq ? totalReq.c : 0,
      });
    }

    if (url.pathname === '/admin/api/keys' && request.method === 'POST') {
      let body;
      try { body = JSON.parse(await request.text()); } catch (e) {
        return json(400, { ok: false, error: 'body 必须是 JSON' });
      }
      const db = env.raccoon_db;
      const action = body.action;
      if (action === 'create') {
        const k = 'sk-raccoon-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
        const role = body.role === 'admin' ? 'admin' : 'channel';
        await db.prepare('INSERT INTO apikeys (k, label, role, status, created_at, last_used_at) VALUES (?,?,?,1,?,NULL)')
          .bind(k, (body.label || '').slice(0, 30), role, Date.now()).run();
        return json(200, { ok: true, key: k, label: body.label || '', role: role });
      }
      if (action === 'disable' || action === 'enable') {
        if (!body.k) return json(400, { ok: false, error: '缺少 k' });
        await db.prepare('UPDATE apikeys SET status = ? WHERE k = ?').bind(action === 'enable' ? 1 : 0, body.k).run();
        return json(200, { ok: true });
      }
      if (action === 'delete') {
        if (!body.k) return json(400, { ok: false, error: '缺少 k' });
        await db.prepare('DELETE FROM apikeys WHERE k = ?').bind(body.k).run();
        return json(200, { ok: true });
      }
      if (action === 'rename') {
        if (!body.k) return json(400, { ok: false, error: '缺少 k' });
        await db.prepare('UPDATE apikeys SET label = ? WHERE k = ?').bind((body.label || '').slice(0, 30), body.k).run();
        return json(200, { ok: true });
      }
      return json(400, { ok: false, error: '未知 action' });
    }

    if (url.pathname === '/admin/api/gateway-key' && request.method === 'POST') {
      let body;
      try { body = JSON.parse(await request.text()); } catch (e) {
        return json(400, { ok: false, error: 'body 必须是 JSON' });
      }
      const nk = (body.key || '').trim();
      if (!nk || nk.length < 8) return json(400, { ok: false, error: '新密钥至少8位' });
      if (nk === env.GATEWAY_KEY) return json(400, { ok: false, error: '不能与初始密钥相同' });
      await setSetting(env, 'gateway_key', nk);
      return json(200, { ok: true, message: '主密钥已替换, 旧主密钥立即失效' });
    }

    if (url.pathname === '/admin/api/reqlog' && request.method === 'GET') {
      const limit = Math.min(300, Math.max(1, parseInt(url.searchParams.get('limit') || '100', 10) || 100));
      const r = await env.raccoon_db.prepare('SELECT * FROM reqlog ORDER BY id DESC LIMIT ?').bind(limit).all();
      return json(200, { logs: r.results || [] });
    }

    if (url.pathname === '/admin/api/reqlog/clear' && request.method === 'POST') {
      await env.raccoon_db.prepare('DELETE FROM reqlog').run();
      return json(200, { ok: true, message: '请求日志已清空' });
    }

    if (url.pathname === '/admin/api/keepalive' && request.method === 'POST') {
      const r = await keepaliveCore(env, 'manual');
      return json(r.ok ? 200 : 502, r);
    }

    if (url.pathname === '/admin/api/models') {
      if (request.method === 'GET') {
        return json(200, { models: await getModels(env) });
      }
      if (request.method === 'POST') {
        let body;
        try { body = JSON.parse(await request.text()); } catch (e) {
          return json(400, { ok: false, error: 'body 必须是 JSON' });
        }
        if (!body || !Array.isArray(body.models)) {
          return json(400, { ok: false, error: '缺少 models 数组' });
        }
        await saveModels(env, body.models);
        return json(200, { ok: true, models: await getModels(env) });
      }
    }

    /* ---------- /init 注入凭证 ---------- */
    if (url.pathname === '/init' && request.method === 'POST') {
      let body;
      try {
        body = JSON.parse(await request.text());
      } catch (e) {
        return json(400, { error: 'body 必须是 JSON: ' + e.message });
      }
      if (!body.refresh_token) {
        return json(400, { error: '缺少 refresh_token 字段' });
      }
      const old = await getTokens(env);
      try {
        await saveTokens(env, {
          refresh_token: body.refresh_token,
          access_token: body.access_token || (old && old.access_token) || '',
          updated_at: Date.now(),
        });
      } catch (e) {
        return json(500, { error: '写入失败: ' + e.message });
      }
      const rtExp = jwtExp(body.refresh_token);
      return json(200, {
        ok: true,
        message: '凭证已注入',
        refresh_token_exp: rtExp ? new Date(rtExp * 1000).toISOString() : 'unknown',
        hint: '下次请求将自动续期access_token',
      });
    }

    /* ---------- /status ---------- */
    if (url.pathname === '/status') {
      const t = await getTokens(env);
      if (!t) {
        return json(200, { status: '未注入凭证', hint: 'POST {"refresh_token":"..."} 到 /init' });
      }
      const now = Date.now() / 1000;
      const atExp = t.access_token ? jwtExp(t.access_token) : 0;
      const rtExp = t.refresh_token ? jwtExp(t.refresh_token) : 0;
      const rtDays = rtExp ? (rtExp - now) / 86400 : -1;
      return json(200, {
        status: 'ok',
        access_token: {
          exp: atExp ? new Date(atExp * 1000).toISOString() : null,
          remain_minutes: atExp ? Math.max(0, Math.round((atExp - now) / 60)) : 0,
        },
        refresh_token: {
          exp: rtExp ? new Date(rtExp * 1000).toISOString() : null,
          remain_days: rtDays >= 0 ? rtDays.toFixed(1) : null,
        },
        updated_at: t.updated_at ? new Date(t.updated_at).toISOString() : null,
        alert: rtDays >= 0 && rtDays < REFRESH_ALERT_DAYS
          ? 'refresh_token 剩余不足 ' + REFRESH_ALERT_DAYS + ' 天, 请尽快重新注入(POST /init), 避免断链'
          : null,
      });
    }

    /* ---------- /v1/models ---------- */
    if (url.pathname.replace(/\/+$/, '').endsWith('/models') && request.method === 'GET') {
      let rtDaysHeader = '';
      try {
        const t = await getTokens(env);
        if (t && t.refresh_token) {
          rtDaysHeader = ((jwtExp(t.refresh_token) - Date.now() / 1000) / 86400).toFixed(1);
        }
      } catch (e) { /* D1未初始化, 忽略 */ }
      let list = [];
      let source = 'db';
      try { list = await getModels(env); } catch (e) {}
      if (!list.length) { list = MODELS; source = 'static'; }
      const respData = {
        object: 'list',
        data: list.map(function (m) { return { id: m, object: 'model', owned_by: 'raccoon' }; }),
      };
      return new Response(JSON.stringify(respData), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Model-Source': source, 'X-Refresh-Token-Days': rtDaysHeader },
      });
    }

    /* ---------- /v1/* POST 转发(带全量观测) ---------- */
    if (url.pathname.indexOf('/v1/') === 0 && request.method === 'POST') {
      const t0 = Date.now();
      const rawBody = await request.text();
      let meta = { model: '', stream: false };
      try {
        const j = JSON.parse(rawBody);
        meta.model = j.model || '';
        meta.stream = !!j.stream;
      } catch (e) { /* 非JSON由上游报错 */ }

      let at;
      try { at = await getAccessToken(env); } catch (e) {
        ctx.waitUntil(addReqLog(env, {
          ts: t0, model: meta.model, api_key: auth.key, ok: 0, stream: meta.stream,
          http_status: 401, error: String(e.message || e).slice(0, 200),
        }));
        return json(401, { error: { message: String(e.message || e), type: 'auth_error' } });
      }
      const doFetch = function (token) {
        return fetch(UPSTREAM_HOST + UPSTREAM_API + url.pathname.substring(3), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + token,
            'Accept': 'application/json, text/event-stream',
          },
          body: rawBody,
        });
      };
      let resp = await doFetch(at);
      if (resp.status === 401) {
        try {
          at = await getAccessToken(env);
          resp = await doFetch(at);
        } catch (e) { /* 保留原401透传 */ }
      }

      // 失败: 记录并透传
      if (!resp.ok) {
        const e2e = Date.now() - t0;
        let errText = '';
        try { errText = (await resp.text()).slice(0, 200); } catch (e) {}
        ctx.waitUntil(addReqLog(env, {
          ts: t0, model: meta.model, api_key: auth.key, ok: 0, stream: meta.stream,
          e2e_ms: e2e, http_status: resp.status, error: errText,
        }));
        return new Response(errText || 'upstream error', {
          status: resp.status,
          headers: { 'Content-Type': resp.headers.get('Content-Type') || 'application/json' },
        });
      }

      const baseRec = {
        ts: t0, model: meta.model, api_key: auth.key, ok: 1, stream: meta.stream ? 1 : 0,
      };

      if (!meta.stream) {
        // ---- 非流式: 读完整响应解析 ----
        const text = await resp.text();
        const e2e = Date.now() - t0;
        let pt = null, ct = null, finish = null, tps = null;
        try {
          const j = JSON.parse(text);
          if (j.usage) { pt = j.usage.prompt_tokens || null; ct = j.usage.completion_tokens || null; }
          if (j.choices && j.choices[0]) finish = j.choices[0].finish_reason || null;
          if (ct && e2e > 0) tps = +(ct / (e2e / 1000)).toFixed(1);
        } catch (e) {}
        ctx.waitUntil(addReqLog(env, Object.assign(baseRec, {
          prompt_tokens: pt, completion_tokens: ct, ttft_ms: null, e2e_ms: e2e,
          tps: tps, finish_reason: finish, http_status: resp.status,
        })));
        return new Response(text, {
          status: resp.status,
          headers: {
            'Content-Type': resp.headers.get('Content-Type') || 'application/json',
          },
        });
      }

      // ---- 流式: TransformStream 边转发边解析SSE ----
      const dec = new TextDecoder();
      let sseBuf = '';
      let firstAt = null, lastAt = null, usage = null, finish = null;
      let resolveDone;
      const donePromise = new Promise(function (r) { resolveDone = r; });
      const tracked = new TransformStream({
        transform: function (chunk, controller) {
          const now = Date.now();
          if (firstAt === null) firstAt = now;
          lastAt = now;
          sseBuf += dec.decode(chunk, { stream: true });
          let nl;
          while ((nl = sseBuf.indexOf('\n')) >= 0) {
            const line = sseBuf.slice(0, nl).trim();
            sseBuf = sseBuf.slice(nl + 1);
            if (line.indexOf('data:') === 0) {
              const d = line.slice(5).trim();
              if (d && d !== '[DONE]') {
                try {
                  const j = JSON.parse(d);
                  if (j.usage) usage = j.usage;
                  if (j.choices && j.choices[0] && j.choices[0].finish_reason) finish = j.choices[0].finish_reason;
                } catch (e) { /* 部分行忽略 */ }
              }
            }
          }
          controller.enqueue(chunk);
        },
        flush: function () { lastAt = Date.now(); resolveDone(); },
        cancel: function () { resolveDone(); },
      });
      ctx.waitUntil(donePromise.then(async function () {
        const e2e = Date.now() - t0;
        const pt = usage ? usage.prompt_tokens || null : null;
        const ct = usage ? usage.completion_tokens || null : null;
        let tps = null;
        if (ct && firstAt && lastAt && lastAt > firstAt) {
          const genMs = lastAt - firstAt;
          // 生成窗口过小(上游一次性吐完)时吞吐无参考意义, 不记录
          tps = genMs >= 100 ? +(ct / (genMs / 1000)).toFixed(1) : null;
        }
        await addReqLog(env, Object.assign(baseRec, {
          prompt_tokens: pt, completion_tokens: ct,
          ttft_ms: firstAt ? firstAt - t0 : null,
          e2e_ms: e2e, tps: tps, finish_reason: finish, http_status: resp.status,
        }));
      }));
      return new Response(resp.body.pipeThrough(tracked), resp);
    }

    return json(404, { error: 'not found. 可用: /admin, /v1/chat/completions, /v1/models, /init, /status' });
  },

  /* ---------- 每日07:00保活 + 90天日志清理 ---------- */
  async scheduled(event, env) {
    await keepaliveCore(env, 'cron');
  },
};
