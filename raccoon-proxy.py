# -*- coding: utf-8 -*-
"""
商汤小浣熊 本地自动续期网关 (raccoon-proxy)
================================================
作用: 渠道只需一次配置 Base URL = http://127.0.0.1:8807/v1, API Key 随便填。
      网关内部自动管理 token, 永远用最新 key 转发到上游, 人不再需要换 key。

token 策略 (与客户端和谐共存, 避免单活会话互殴):
  1. 每次请求读 C:/Users/PC/.box-agent/config/auth.json (客户端活跃时会自动续期并写回)
  2. key 未过期 -> 直接用 (零干扰)
  3. key 已过期 -> 用 refresh_token 刷新接管, 新 token 写回 auth.json (下次客户端启动可无缝接上)
  4. 刷新失败 -> 重读 auth.json (客户端可能刚重登写入了新会话) 再试

用法: python raccoon-proxy.py [端口, 默认8807]
"""
import sys, os, json, time, base64, threading, http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

if sys.stdout and hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8807
UPSTREAM_HOST = 'xiaohuanxiong.com'
UPSTREAM_API = '/api/web/llm/v2'
AUTH_FILE = r'C:\Users\PC\.box-agent\config\auth.json'
MODELS = ['sn-deepseek-v4-1-flash', 'sn-deepseek-v4-pro', 'raccoon-chat-ml-5-5']
LOG_LOCK = threading.Lock()
AUTH_LOCK = threading.Lock()
LOG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'raccoon-proxy.log')


def log(msg):
    line = time.strftime('[%Y-%m-%d %H:%M:%S] ') + msg
    with LOG_LOCK:
        print(line, flush=True)
        try:
            with open(LOG_FILE, 'a', encoding='utf-8') as f:
                f.write(line + '\n')
        except Exception:
            pass


def jwt_exp(token):
    p = token.split('.')[1]
    p += '=' * (-len(p) % 4)
    return int(json.loads(base64.urlsafe_b64decode(p))['exp'])


def load_auth():
    with open(AUTH_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_auth(auth):
    tmp = AUTH_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(auth, f, indent=2, ensure_ascii=False)
    os.replace(tmp, AUTH_FILE)


def call_refresh(refresh_token):
    body = json.dumps({'refresh_token': refresh_token}).encode()
    conn = http.client.HTTPSConnection(UPSTREAM_HOST, timeout=30)
    conn.request('POST', '/api/web/auth/v1/refresh', body,
                 {'Content-Type': 'application/json'})
    resp = conn.getresponse()
    data = json.loads(resp.read().decode('utf-8', 'replace'))
    conn.close()
    if data.get('code') != 0 or not data.get('data', {}).get('access_token'):
        raise RuntimeError('refresh failed: ' + json.dumps(data, ensure_ascii=False))
    return data['data']


def get_access_token():
    """返回一个可用的 access_token, 必要时刷新接管"""
    with AUTH_LOCK:
        auth = load_auth()
        now = time.time()
        if jwt_exp(auth['access_token']) - now > 120:
            return auth['access_token']  # 客户端维护的新鲜key, 零干扰直接用
        log('key 过期/将过期, 尝试刷新接管...')
        try:
            new = call_refresh(auth['refresh_token'])
            auth['access_token'] = new['access_token']
            auth['refresh_token'] = new['refresh_token']
            save_auth(auth)
            log('刷新成功, 已写回 auth.json, 新key有效期至 ' +
                time.strftime('%m-%d %H:%M:%S', time.localtime(jwt_exp(new['access_token']))))
            return new['access_token']
        except Exception as e:
            log('刷新失败(%s), 重读 auth.json 看客户端是否刚写入新会话...' % e)
            auth = load_auth()  # 客户端可能刚重登并写入新链
            if jwt_exp(auth['access_token']) - time.time() > 120:
                return auth['access_token']
            raise


class Proxy(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def _send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip('/').endswith('/models'):
            self._send_json(200, {'object': 'list', 'data': [
                {'id': m, 'object': 'model', 'owned_by': 'raccoon'} for m in MODELS]})
        else:
            self._send_json(404, {'error': 'not found'})

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(length) if length else b''

        path = UPSTREAM_API + self.path.split('/v1', 1)[-1]
        if not path.startswith(UPSTREAM_API):
            self._send_json(404, {'error': 'bad path, use /v1/...'})
            return

        try:
            token = get_access_token()
        except Exception as e:
            self._send_json(401, {'error': {'message': '无法获取可用token: %s' % e, 'type': 'auth_error'}})
            return

        headers = {'Content-Type': 'application/json',
                   'Authorization': 'Bearer ' + token,
                   'Accept': 'application/json, text/event-stream'}
        try:
            conn = http.client.HTTPSConnection(UPSTREAM_HOST, timeout=600)
            conn.request('POST', path, body, headers)
            resp = conn.getresponse()
        except Exception as e:
            self._send_json(502, {'error': {'message': '上游连接失败: %s' % e, 'type': 'upstream_error'}})
            return

        log('%s -> %s 上游HTTP %d' % (self.path, path, resp.status))
        if resp.status == 401:
            # 可能是刚轮换, 二次取token重试一次
            conn.close()
            try:
                token = get_access_token()
                conn = http.client.HTTPSConnection(UPSTREAM_HOST, timeout=600)
                conn.request('POST', path, body, dict(headers, Authorization='Bearer ' + token))
                resp = conn.getresponse()
                log('401后重试 -> 上游HTTP %d' % resp.status)
            except Exception:
                pass

        self.send_response(resp.status)
        ct = resp.getheader('Content-Type', 'application/json')
        self.send_header('Content-Type', ct)
        self.send_header('Connection', 'close')
        self.send_header('Cache-Control', 'no-cache')
        self.close_connection = True
        self.end_headers()
        try:
            while True:
                chunk = resp.read(4096)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except Exception as e:
            log('流式转发中断: %s' % e)
        finally:
            conn.close()


if __name__ == '__main__':
    srv = ThreadingHTTPServer(('127.0.0.1', PORT), Proxy)
    log('网关已启动: http://127.0.0.1:%d/v1  (Ctrl+C 退出)' % PORT)
    log('渠道配置: Base URL = http://127.0.0.1:%d/v1, API Key 随意填, Models: %s' % (PORT, ', '.join(MODELS)))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log('退出')
