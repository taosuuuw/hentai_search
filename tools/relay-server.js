/* ==========================================================================
   tools/relay-server.js —— 自建中继（本机 / VPS / 任意有 Node 18+ 的墙外机器）
   --------------------------------------------------------------------------
   零依赖（只用 Node 内置 http/https/dns/url）。用途与协议和 tools/relay-worker.mjs
   完全一致，两者可以互换；网关那边只需要「一个能通的中继地址」。

   什么时候用这个而不是 Cloudflare Worker：
     · Cloudflare 也不想用；或已经有台 VPS / 家里的软路由 / 朋友的墙外机器；
     · 只想先在**本机或局域网**把链路跑通做验证（此时它当然救不了被墙的目标，
       因为出口还是同一个墙内 IP —— 它只能用来验证协议、日志与转发逻辑）。

   启动：
     node tools/relay-server.js --port=8790 --key=<随机串> [--host=127.0.0.1] [--insecure]
   参数：
     --port=     监听端口（默认 8790）
     --host=     监听地址（默认 127.0.0.1；要让网关以外的机器访问才用 0.0.0.0）
     --key=      访问密钥；设了就必须带（?k= 或 x-hs-key 头）。**强烈建议设**
     --insecure  不校验证书（只在上游证书链有问题的例外场景用）
     --allow-private  **仅离线自测用**：允许转发到内网/环回地址（默认关闭；开了就别暴露到公网）
   自检：
     curl "http://127.0.0.1:8790/__hs/ping?ip=1"      # 看它自己的出口 IP（在 VPS 上跑就知道目标站看到的是谁）
     curl "http://127.0.0.1:8790/?url=https%3A%2F%2Fe-hentai.org%2F&k=<key>"

   把地址交给网关（任选其一）：
     · tools/relay.txt 里写一行：http://<你的中继>:8790 <key>
     · 环境变量：HS_GW_RELAY=http://<你的中继>:8790|<key>
   ========================================================================== */
'use strict';

const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const { URL } = require('url');

const RELAY_NAME = 'hs-relay';
const RELAY_VERSION = '1.0.0';
const UPSTREAM_TIMEOUT_MS = 25000;
const FORWARD_HDR = ['cookie', 'referer', 'accept-language', 'user-agent', 'x-requested-with', 'accept'];
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_REDIRECT = 8;

/* ------------------------------ 参数 ------------------------------ */
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const has = (name) => argv.includes('--' + name);
const PORT = parseInt(arg('port', '8790'), 10);
const HOST = arg('host', '127.0.0.1');
const KEY = arg('key', process.env.HS_RELAY_KEY || '');
const INSECURE = has('insecure');
/* 仅供离线自测：允许转发到内网/环回地址（默认关闭，见 assertPublicTarget 注释） */
const ALLOW_PRIVATE = has('allow-private');

/* ------------------------------ SSRF 防护 ------------------------------ */
const PRIVATE_V4 = /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|198\.18\.|198\.19\.|100\.(6[4-9]|[7-9][0-9]|1[0-2][0-7])\.|22[4-9]\.|23[0-9]\.|24[0-9]\.|25[0-5]\.)/;
const BAD_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa|metadata\.google\.internal|instance-data)$/i;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return PRIVATE_V4.test(ip) || ip === '0.0.0.0';
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    return s === '::1' || s === '::' || /^fe80:/.test(s) || /^f[cd]/.test(s) || /^::ffff:(127\.|10\.|192\.168\.|169\.254\.)/.test(s);
  }
  return false;
}

async function assertPublicTarget(u) {
  if (!/^https?:\/\//i.test(u)) throw new Error('只允许 http/https');
  /* --allow-private 只给 tools/relay-check.js 的离线自测用（假上游就在 127.0.0.1），
     默认关闭 —— 生产环境绝不要开，否则中继就能被拿来打你本机/内网/云元数据。 */
  if (ALLOW_PRIVATE) return u;
  const host = new URL(u).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (BAD_HOST.test(host)) throw new Error('拒绝内网主机：' + host);
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('拒绝内网 IP：' + host);
    return u;
  }
  /* 域名要真解析一次，防止「外网域名 → 内网 IP」的 DNS rebinding 花样 */
  const addrs = await new Promise((res) => dns.lookup(host, { all: true }, (e, a) => res(e ? [] : a)));
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('域名解析到内网地址，已拒绝：' + host);
  return u;
}

/* ------------------------------ 取数 ------------------------------ */
function once(target, method, hdr, insecure) {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: hdr,
      rejectUnauthorized: !insecure,
      servername: u.hostname,          /* SNI 必须显式给，否则有些站会给默认证书 */
    }, (up) => resolve({ up, u }));
    req.setTimeout(UPSTREAM_TIMEOUT_MS, () => req.destroy(new Error('上游超时 ' + UPSTREAM_TIMEOUT_MS + 'ms')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchUpstream(target0, method, hdr) {
  let target = target0;
  for (let hop = 0; hop <= MAX_REDIRECT; hop++) {
    const { up, u } = await once(target, method, hdr, INSECURE);
    const st = up.statusCode || 0;
    if (st >= 300 && st < 400 && up.headers.location) {
      up.resume();                                   /* 丢弃中间响应体 */
      const next = new URL(up.headers.location, u).toString();
      await assertPublicTarget(next);
      target = next;
      continue;
    }
    return { up, finalUrl: target };
  }
  throw new Error('重定向次数超过 ' + MAX_REDIRECT);
}

/* ------------------------------ 路由 ------------------------------ */
const KEEP_RES_HDR = ['content-type', 'cache-control', 'etag', 'last-modified', 'expires',
  'content-disposition', 'content-range', 'accept-ranges'];

function relayHeaders(extra) {
  return Object.assign({
    'x-hs-relay': RELAY_NAME + '/' + RELAY_VERSION,
    'access-control-allow-origin': '*',
    'access-control-expose-headers': '*',
  }, extra || {});
}

function sendJson(res, obj, status) {
  const body = JSON.stringify(obj, null, 1);
  res.writeHead(status || 200, relayHeaders({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }));
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const here = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1'));
  const keyIn = req.headers['x-hs-key'] || here.searchParams.get('k') || '';

  if (here.pathname === '/__hs/ping' || here.pathname === '/_hs/ping') {
    const out = { ok: true, relay: RELAY_NAME, version: RELAY_VERSION, keyRequired: !!KEY, host: HOST, port: PORT, time: new Date().toISOString() };
    if (here.searchParams.get('ip')) {
      try {
        const r = await once('https://api.ipify.org?format=json', 'GET', { accept: 'application/json' }, INSECURE);
        let s = '';
        for await (const c of r.up) s += c;
        out.egressIp = JSON.parse(s).ip;
      } catch (e) { out.egressIpError = String(e && e.message || e); }
    }
    return sendJson(res, out);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, { ok: false, error: '只支持 GET/HEAD' }, 405);
  if (KEY && keyIn !== KEY) return sendJson(res, { ok: false, error: '需要正确的 key' }, 403);

  /* 目标 URL：?url= 优先，其次路径式（此时 ?k= 会算进目标里，key 只能走请求头） */
  let target = here.searchParams.get('url') ? decodeURIComponent(here.searchParams.get('url')) : '';
  if (!target) {
    const raw = here.pathname.replace(/^\/+/, '');
    if (raw) {
      let t = raw;
      try { t = decodeURIComponent(raw); } catch (e) { /* 保留原样 */ }
      target = t + (here.search || '');
    }
  }
  try { target = await assertPublicTarget(target); } catch (e) { return sendJson(res, { ok: false, error: String(e && e.message || e) }, 400); }

  const hdr = { accept: '*/*', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', 'user-agent': BROWSER_UA };
  for (const n of FORWARD_HDR) {
    const v = req.headers['x-hs-h-' + n];
    if (v) hdr[n] = v;
  }

  try {
    const { up, finalUrl } = await fetchUpstream(target, req.method, hdr);
    const out = {};
    for (const h of KEEP_RES_HDR) if (up.headers[h]) out[h] = up.headers[h];
    out['x-hs-final'] = finalUrl;
    res.writeHead(up.statusCode || 502, relayHeaders(out));
    if (req.method === 'HEAD') { up.resume(); return res.end(); }
    up.pipe(res);
    up.on('error', () => { try { res.destroy(); } catch (e) { /* noop */ } });
  } catch (e) {
    return sendJson(res, { ok: false, error: '上游取数失败：' + String(e && e.message || e), target }, 502);
  }
});

server.listen(PORT, HOST, () => {
  console.log('[' + RELAY_NAME + '] listening on http://' + HOST + ':' + PORT +
    '  key=' + (KEY ? '已设置' : '**未设置（任何知道地址的人都能用）**') +
    '  insecure=' + INSECURE);
});

module.exports = { server };
