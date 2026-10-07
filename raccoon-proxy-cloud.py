# -*- coding: utf-8 -*-
"""
商汤小浣熊 云端自动续期网关 (raccoon-proxy-cloud)
================================================
与本地版的区别:
  - 不依赖本地客户端的 auth.json (云端没有客户端)
  - 自持凭证: 启动时注入一次 refresh_token, 之后每次过期自动滚动续期并保存
  - 监听 0.0.0.0, 必须设置网关密钥鉴权 (公网安全)
  - 专用账号: 建议为此网关注册一个专用账号, 本地客户端不再登录该账号
    (服务端为单活会话: 本地客户端每3小时刷新会轮换 refresh_token, 顶死云端持有的链)

部署步骤:
  1. 上传本文件到云服务器 (需 Python 3.8+, 仅标准库, 无需 pip install)
  2. 初始凭证: 在同目录创建 raccoon-cloud-auth.json, 内容:
       {"refresh_token": "eyJhbGci...你的refresh_token..."}
  3. 启动 (建议 systemd 常驻, 见下方 unit 示例):
       GATEWAY_KEY=sk-你自己设的密钥 python3 raccoon-proxy-cloud.py 8807
  4. 渠道配置: Base URL = http://服务器IP:8807/v1, API Key = GATEWAY_KEY 的值
  5. 防火墙/安全组放行 8807; 有条件建议套 HTTPS (nginx 反代)

systemd 示例 (/etc/systemd/system/raccoon-proxy.service):
  [Unit]
  Description=Raccoon LLM Gateway
  After=network.target
  [Service]
  WorkingDirectory=/opt/raccoon
  Environment=GATEWAY_KEY=sk-改成你的密钥
  ExecStart=/usr/bin/python3 raccoon-proxy-cloud.py 8807
  Restart=always
  [Install]
  WantedBy=multi-user.target
  然后: systemctl enable --now raccoon-proxy

用法: python3 raccoon-proxy-cloud.py [端口, 默认8807]
环境变量:
  GATEWAY_KEY      网关鉴权密钥, 渠道 API Key 填这个 (不设则拒绝所有请求, 强制安全)
  RACCOON_TOKEN_FILE  凭证存储路径, 默认 ./raccoon-cloud-auth.json
"""
import sys, os, json, time, base64, threading, http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

if sys.stdout and hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8807
UPSTREAM_HOST = 'xiaohuanxiong.com'
UPSTREAM_API = '/api/web/llm/v2'
GATEWAY_KEY = os.environ.get('GATEWAY_KEY', '').strip()
TOKEN_FILE = os.environ.get('RACCOON_TOKEN_FILE',
                            os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                         'raccoon-cloud-auth.json'))
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


def load_tokens():
    if not os.path.exists(TOKEN_FILE):
        raise RuntimeError('凭证文件不存在: %s (请先创建并写入 {"refresh_token": "..."})' % TOKEN_FILE)
    with open(TOKEN_FILE, 'r', encoding='utf-8-sig') as f:  # utf-8-sig 兼容带BOM的编辑器产物
        t = json.load(f)
    if not t.get('refresh_token'):
        raise RuntimeError('凭证文件中没有 refresh_token')
    return t


def save_tokens(t):
    tmp = TOKEN_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(t, f, indent=2, ensure_ascii=False)
    os.replace(tmp, TOKEN_FILE)


def call_refresh(refresh_token):
    body = json.dumps({'refresh_token': refresh_token}).encode()
    conn = http.client.HTTPSConnection(UPSTREAM_HOST, timeout=30)
    conn.request('POST', '/api/web/auth/v1/refresh', body,
                 {'Content-Type': 'application/json'})
    resp = conn.getresponse()
    data = json.loads(resp.read().decode('utf-8', 'replace'))
    conn.close()
    if data.get('code') != 0 or not data.get('data', {}).get('access_token'):
        raise RuntimeError('refresh失败(可能refresh_token已被轮换/过期, 需重新注入): ' +
                           json.dumps(data, ensure_ascii=False))
    return data['data']


def get_access_token():
    with AUTH_LOCK:
        t = load_tokens()
        at = t.get('access_token')
        if at and jwt_exp(at) - time.time() > 120:
            return at
        log('access_token 缺失/过期, 用 refresh_token 自动续期...')
        new = call_refresh(t['refresh_token'])
        t['access_token'] = new['access_token']
        t['refresh_token'] = new['refresh_token']
        save_tokens(t)
        log('续期成功并已保存, 新key有效期至 ' +
            time.strftime('%m-%d %H:%M:%S', time.localtime(jwt_exp(new['access_token']))))
        return new['access_token']


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

    def _check_key(self):
        """公网安全: 渠道必须携带正确的 GATEWAY_KEY"""
        if not GATEWAY_KEY:
            self._send_json(500, {'error': {'message': '服务端未配置 GATEWAY_KEY, 拒绝服务', 'type': 'config_error'}})
            return False
        auth = self.headers.get('Authorization', '')
        if auth != 'Bearer ' + GATEWAY_KEY:
            self._send_json(401, {'error': {'message': '网关密钥错误', 'type': 'gateway_auth_error'}})
            return False
        return True

    def do_GET(self):
        if not self._check_key():
            return
        if self.path.rstrip('/').endswith('/models'):
            self._send_json(200, {'object': 'list', 'data': [
                {'id': m, 'object': 'model', 'owned_by': 'raccoon'} for m in MODELS]})
        else:
            self._send_json(404, {'error': 'not found'})

    def do_POST(self):
        if not self._check_key():
            return
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
        log('%s -> 上游HTTP %d' % (self.path, resp.status))
        if resp.status == 401:
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
        self.send_header('Content-Type', resp.getheader('Content-Type', 'application/json'))
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
    if not GATEWAY_KEY:
        log('警告: 未设置 GATEWAY_KEY, 网关将拒绝所有请求! 用环境变量 GATEWAY_KEY=xxx 启动')
    srv = ThreadingHTTPServer(('0.0.0.0', PORT), Proxy)
    log('云端网关已启动: http://0.0.0.0:%d/v1' % PORT)
    log('渠道配置: Base URL = http://你的服务器IP:%d/v1, API Key = GATEWAY_KEY 的值' % PORT)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log('退出')
