/* ==========================================================================
   tools/relay-worker.mjs —— 自建中继（Cloudflare Worker / Cloudflare Pages `_worker.js`）
   --------------------------------------------------------------------------
   为什么需要它（本轮实测证据，见 tools/relay-deploy.md）：
     · e-hentai.org  系统 DNS 返回 NXDOMAIN；DoH 给的两个候选 IP 带真 SNI 直连都是 12s 超时
     · www.pixiv.net DoH 给出的是 **Cloudflare 真段** 104.18.42.239，带真 SNI 直连
                     **ECONNRESET ~100ms**（TLS 握手中被按 SNI 重置）
     · 15 条公共中继候选 × 2 目标 = 0 成功：cors.eu.org 全局限流 429、allorigins 不可达、
       workers.dev / r.jina.ai / vercel.app 域名本身被墙
   ⇒ 直连这条路物理上不存在，**必须有一台墙外的中继**；而公共中继要么被墙、要么被共享限流，
     所以只能自建。本文件就是那台中继，部署只需粘贴一次。

   部署方式（任选其一，都不需要买域名）：
     ① Cloudflare Worker（推荐）
        - 打开 https://dash.cloudflare.com/ → Workers & Pages → Create → Worker
        - 把这个文件的**全部内容**粘进在线编辑器 → Deploy
        - 得到 https://<名字>.<你的账号>.workers.dev —— ⚠ workers.dev **在本机实测被墙**，
          所以必须再进 Settings → Domains & Routes 加一条 **Custom Domain**，
          或改用下面的 Pages 方式（pages.dev 实测可达）。
     ② Cloudflare Pages（本机可达，最省事）
        - 建一个仓库/空项目，放一个文件 `_worker.js`（内容=本文件，注意去掉本注释也行）
        - Pages → Create project → 上传/连接 → Deploy
        - 得到 https://<项目>.pages.dev ← 本机实测**可达**
     ③ 其它平台见 tools/relay-server.js（VPS）与 tools/relay-deno.ts（Deno Deploy）

   安全（务必看）：
     · 中继会把你的出口 IP 暴露给目标站，所以**不要公开分享**这个地址；
     · 强烈建议在 Worker 里设一个环境变量/Secret：`HS_RELAY_KEY=<随机串>`
       （Settings → Variables and Secrets → 类型选 Secret），
       然后网关那边用同一个串（tools/relay.txt 或 HS_GW_RELAY，见 tools/gateway.js）。
       设了 key 之后，没带 key 的请求一律 403 —— 否则别人会拿你的中继刷站，
       你的 IP 很快就会被目标站（尤其 e-hentai）限流封禁。
     · 只允许转发 http(s)，且拒绝内网/环回/元数据地址（SSRF 防护）。

   ── 协议（tools/gateway.js 的私有中继腿与 tools/relay-check.js 都按这个来）──
     GET {base}/?url=<encodeURIComponent(目标URL)>&k=<key>      ← 网关用这种（无歧义）
     GET {base}/<目标URL原样>                                    ← 兼容路径式；这种写法下 key 只能走请求头
     请求头 x-hs-key: <key>                                      ← 另一种带 key 的方式
     请求头 x-hs-h-<名字>: <值>                                   ← 转发到上游的头（白名单见 FORWARD_HDR）
                                                                   例如 x-hs-h-cookie / x-hs-h-referer
     GET {base}/__hs/ping[?ip=1]                                 ← 健康检查；带 ip=1 时回报中继自己的出口 IP
   响应头：
     x-hs-relay: hs-relay/<版本>   中继身份（网关据此确认「这真是我的中继」）
     x-hs-final: <上游最终 URL>     跟随重定向后的落点
     access-control-allow-origin: *  （同源部署其实用不到，但浏览器直连时有用）
   ========================================================================== */
'use strict';

const RELAY_NAME = 'hs-relay';
const RELAY_VERSION = '1.0.0';
const UPSTREAM_TIMEOUT_MS = 25000;
/* 只转发这几个头 —— 别把网关自己的 Host / Accept-Encoding 之类顺手带上去。
   cookie 必须能转发：pixiv 的 R-18 检索要用户自己的 PHPSESSID。 */
const FORWARD_HDR = ['cookie', 'referer', 'accept-language', 'user-agent', 'x-requested-with', 'accept'];
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
/* 上游响应里值得原样带回来的头（content-length 故意不带：流式返回时它会打架） */
const KEEP_RES_HDR = ['content-type', 'cache-control', 'etag', 'last-modified', 'expires',
  'content-disposition', 'content-range', 'accept-ranges'];

/* ------------------------------ SSRF 防护 ------------------------------ */
const PRIVATE_V4 = /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|198\.18\.|198\.19\.|100\.(6[4-9]|[7-9][0-9]|1[0-2][0-7])\.|22[4-9]\.|23[0-9]\.|24[0-9]\.|25[0-5]\.)/;
const BAD_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa|metadata\.google\.internal|instance-data)$/i;

function assertPublicTarget(u) {
  if (!/^https?:\/\//i.test(u)) throw new Error('只允许 http/https');
  const h = new URL(u).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (BAD_HOST.test(h)) throw new Error('拒绝内网主机：' + h);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
    if (PRIVATE_V4.test(h)) throw new Error('拒绝内网 IP：' + h);
  } else if (/^[0-9a-f:]+$/.test(h) && h.indexOf(':') >= 0) {
    if (/^(::1|fe80:|fc|fd|::ffff:(127|10|192\.168|169\.254))/.test(h)) throw new Error('拒绝内网 IPv6：' + h);
  }
  return u;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj, null, 1), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-hs-relay': RELAY_NAME + '/' + RELAY_VERSION },
  });
}

/** 从请求里解析出目标 URL（两种语法都支持） */
function targetOf(request, url) {
  const q = url.searchParams.get('url');
  if (q) return decodeURIComponent(q);
  /* 路径式：/https://e-hentai.org/?f_search=x —— **整个 path + search 都是目标**，
     所以这种写法下没法再用 ?k= 带 key（会被当成目标的一部分），key 只能走 x-hs-key 头。 */
  const raw = url.pathname.replace(/^\/+/, '');
  if (!raw) return '';
  let t = raw;
  try { t = decodeURIComponent(raw); } catch (e) { t = raw; }
  return t + (url.search || '');
}

async function egressIp() {
  const r = await fetch('https://api.ipify.org?format=json', { headers: { accept: 'application/json' } });
  const j = await r.json();
  return j.ip;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cfgKey = String((env && (env.HS_RELAY_KEY || env.RELAY_KEY)) || '');
    const keyIn = request.headers.get('x-hs-key') || url.searchParams.get('k') || '';

    /* 健康检查（不需要 key：方便你在浏览器里直接确认部署成功） */
    if (url.pathname === '/__hs/ping' || url.pathname === '/_hs/ping') {
      const out = { ok: true, relay: RELAY_NAME, version: RELAY_VERSION, keyRequired: !!cfgKey, time: new Date().toISOString() };
      if (url.searchParams.get('ip')) {
        try { out.egressIp = await egressIp(); } catch (e) { out.egressIpError = String(e && e.message || e); }
      }
      return json(out);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('relay: only GET/HEAD', { status: 405, headers: { 'x-hs-relay': RELAY_NAME } });
    }
    if (cfgKey && keyIn !== cfgKey) {
      return json({ ok: false, error: '需要正确的 key（x-hs-key 头或 ?k= 参数）' }, 403);
    }

    let target = '';
    try {
      target = assertPublicTarget(targetOf(request, url));
      if (!target) throw new Error('没有目标 URL');
    } catch (e) {
      return json({ ok: false, error: String(e && e.message || e) }, 400);
    }

    /* 转发白名单里的头（x-hs-h-cookie 等） */
    const hdr = { 'accept': '*/*', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', 'user-agent': BROWSER_UA };
    for (const n of FORWARD_HDR) {
      const v = request.headers.get('x-hs-h-' + n);
      if (v) hdr[n] = v;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
    let up;
    try {
      up = await fetch(target, {
        method: request.method,
        headers: hdr,
        redirect: 'follow',
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      return json({ ok: false, error: '上游取数失败：' + String(e && (e.message || e)), target: target }, 502);
    }
    clearTimeout(timer);

    const out = new Headers();
    for (const h of KEEP_RES_HDR) {
      const v = up.headers.get(h);
      if (v) out.set(h, v);
    }
    out.set('access-control-allow-origin', '*');
    out.set('access-control-expose-headers', '*');
    out.set('x-hs-relay', RELAY_NAME + '/' + RELAY_VERSION);
    out.set('x-hs-final', up.url || target);
    return new Response(request.method === 'HEAD' ? null : up.body, { status: up.status, headers: out });
  },
};
