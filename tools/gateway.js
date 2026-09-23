#!/usr/bin/env node
/* ==========================================================================
   gateway.js — EroMeta 本地网关（零依赖，只用 Node 内置模块）

   为什么需要它：
     禁漫天堂 / 哔咔 / 拷贝漫画 的官方 API 都要求「自定义请求头 + 签名」，
     响应还常常是 AES 加密的。浏览器受同源策略（CORS）限制，无法发送这些
     头，也没法在 file:// 下安全地完成签名 —— 这正是 jasmine、venera 这类
     项目全部采用原生客户端（Rust / 原生 socket 直连）的原因。
     本网关把「签名 + 解密 + 取页面」放到本机，浏览器只跟 127.0.0.1 说话。

   用法：
     node tools/gateway.js                 # 默认 http://127.0.0.1:8788
     node tools/gateway.js --port 9000
     node tools/gateway.js --picacg-email a@b.com --picacg-password xxx
     set PICACG_TOKEN=xxxx && node tools/gateway.js     # 直接用现成 token

   打开 http://127.0.0.1:8788/ 使用（同源，连跨域都省了）。
   ========================================================================== */
'use strict';

const http = require('http');
const https = require('https');
const tls = require('tls');
const zlib = require('zlib');
const dnsNative = require('dns');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

/* ------------------------------ 出口代理 ------------------------------
   本机若挂着系统代理（Clash / v2ray 之类，Chrome 走它、Node 默认不走），
   网关必须也走，否则 nhentai / E-Hentai / 紳士漫畫 / kemono 这些站全部
   DNS 不可达。这里自动探测常见的本地代理端口，命中就带着环境变量重启自己
   （Node 的 NODE_USE_ENV_PROXY 只在启动时读取，所以必须重启而不是运行时设）。
   --------------------------------------------------------------------- */
const PROXY_PORTS = [7897, 7890, 7891, 10809, 10808, 1080, 2080, 8889, 8118, 20171, 4780, 1087];
const EGRESS_TARGET = 'e-hentai.org:443';   // 本机 DNS 打不开的站，只有代理通才算真通

function testProxyPort(port, timeout) {
  return new Promise(resolve => {
    let done = false;
    const finish = ok => { if (!done) { done = true; resolve(ok); } };
    let req;
    try {
      req = http.request({ host: '127.0.0.1', port: port, method: 'CONNECT', path: EGRESS_TARGET, timeout: timeout || 3000 });
    } catch (e) { return finish(false); }
    req.on('connect', (res, socket) => { try { socket.destroy(); } catch (e) {} finish(res.statusCode === 200); });
    req.on('timeout', () => { try { req.destroy(); } catch (e) {} finish(false); });
    req.on('error', () => finish(false));
    req.end();
  });
}

async function pickLocalProxy() {
  for (const port of PROXY_PORTS) {
    /* eslint-disable no-await-in-loop */
    if (await testProxyPort(port)) return 'http://127.0.0.1:' + port;
  }
  return '';
}

/* 启动时先决定出口；需要的话重启自己一次，让 Node 在启动阶段就拿到代理配置 */
function ensureEgress() {
  if (String(process.env.HS_GW_NO_PROXY || '') === '1' || argv.indexOf('--no-proxy') >= 0) {
    return Promise.resolve('direct');
  }
  if (process.env.HS_GW_PROXIED === '1') return Promise.resolve('proxy');
  const explicit = argOf('proxy') || process.env.HTTPS_PROXY || process.env.https_proxy ||
    process.env.HTTP_PROXY || process.env.http_proxy || '';
  return Promise.resolve(explicit || pickLocalProxy()).then(proxy => {
    if (!proxy) return 'direct';
    log('检测到可用出口代理：' + proxy + '，带着它重启网关（Node 只在启动时读代理配置）…');
    const env = Object.assign({}, process.env, {
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy,
      NO_PROXY: 'localhost,127.0.0.1,::1',
      HS_GW_PROXIED: '1'
    });
    const child = spawn(process.execPath, [__filename].concat(process.argv.slice(2)), { env: env, stdio: 'inherit' });
    child.on('exit', code => process.exit(code == null ? 0 : code));
    return 'reexec';
  });
}

/* ------------------------------ 配置 ------------------------------ */
const argv = process.argv.slice(2);
const argOf = name => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : '';
};
const PORT = parseInt(argOf('port') || process.env.PORT || '8788', 10);
const ROOT = path.resolve(argOf('root') || path.join(__dirname, '..'));
const UA_CHROME = 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ1A.230305.002; wv) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36';
const GW_VERSION = '1.3.0';

const state = {
  picacgToken: String(process.env.PICACG_TOKEN || '').trim(),
  picacgTokenAt: 0,
  picacgEmail: argOf('picacg-email') || process.env.PICACG_EMAIL || '',
  picacgPassword: argOf('picacg-password') || process.env.PICACG_PASSWORD || '',
  jmHost: '',            // 最近一次成功的禁漫域名
  jmHostAt: 0,
  jmCookie: '',
  jmCdn: 'https://cdn-msp.jmapinodeudzn.net',
  jmCdnAt: 0,
  jmDomains: null,       // 远程域名列表缓存
  jmDomainsAt: 0,
  copyApi: '',
  copyApiAt: 0,
  wnHost: '',            // 最近一次取到图的紳士漫畫域名（镜像会换）
  wnHostAt: 0,
  ehCookie: String(argOf('ehentai-cookie') || process.env.HS_EH_COOKIE || '').trim(),
  /* 搜索进缓存后，这几次用同一个关键词的翻页/重搜就不用再打上游（也顺手压住风控） */
  ehLastSearch: null,
  ehLastSearchAt: 0
};

const log = (...a) => console.log('[gateway]', ...a);

/* 网关是常驻服务，日志管道断掉（被父进程回收、终端关掉、管道写满）不能把它带走。
   Node 默认会因 stdout 的 EPIPE 抛未捕获异常直接退出，这里把它咽掉。 */
const ignorePipeError = () => {};
try { process.stdout.on('error', ignorePipeError); } catch (e) {}
try { process.stderr.on('error', ignorePipeError); } catch (e) {}
/* 单个请求的意外 reject 也不该让整个网关倒下，记一笔继续跑 */
process.on('unhandledRejection', e => {
  try { log('未处理的 Promise 异常（已忽略）：' + ((e && e.message) || e)); } catch (x) {}
});

/* ------------------------------ 小工具 ------------------------------ */
const md5 = s => crypto.createHash('md5').update(String(s), 'utf8').digest('hex');
const sha256hex = (keyBuf, msg) => crypto.createHmac('sha256', keyBuf).update(msg, 'utf8').digest('hex');
const nowSec = () => Math.floor(Date.now() / 1000);
const uuidNoDash = () => crypto.randomUUID().replace(/-/g, '');
const b64 = s => Buffer.from(String(s), 'base64');

/** AES-ECB 解密（key 必须是 16/24/32 字节；JM 用的是 32 字节 ASCII 的 md5 hex 串） */
function aesEcbDecrypt(buf, key) {
  const keyBuf = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8');
  const algo = keyBuf.length === 32 ? 'aes-256-ecb' : (keyBuf.length === 24 ? 'aes-192-ecb' : 'aes-128-ecb');
  try {
    const d = crypto.createDecipheriv(algo, keyBuf, null);
    d.setAutoPadding(true);
    return Buffer.concat([d.update(buf), d.final()]);
  } catch (e) {
    const d = crypto.createDecipheriv(algo, keyBuf, null);
    d.setAutoPadding(false);
    const out = Buffer.concat([d.update(buf), d.final()]);
    /* 去掉尾部填充字节 */
    let end = out.length;
    while (end > 0 && out[end - 1] === 0) end--;
    return out.slice(0, end);
  }
}

/** 从一堆杂质里抠出 JSON */
function sliceJson(text) {
  const s = String(text).replace(/^\uFEFF/, '').trim();
  const i = Math.min(...['{', '['].map(c => { const k = s.indexOf(c); return k < 0 ? Infinity : k; }));
  if (!isFinite(i)) throw new Error('响应里没有 JSON');
  const j1 = s.lastIndexOf('}'), j2 = s.lastIndexOf(']');
  const j = Math.max(j1, j2);
  return JSON.parse(s.slice(i, j + 1));
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ==========================================================================
   出口 / 解析 / 兜底 —— 「无 VPN 也要能用」的三层补偿
   --------------------------------------------------------------------------
   tools/netprobe.js 在本机无 VPN 环境下的实测（这是设计的全部依据）：

   ① **真正的元凶是出口被粘死，不是站点被墙**：网关启动时若探测到本地代理，
      就把 HTTPS_PROXY 写进环境变量重启自己，此后**再不重判**。VPN 一关，
      每一次请求都先撞那个已经没人监听的端口 —— 日志里是 ms=5 的 fetch failed，
      连本来直连就通的禁漫 APP 接口（www.cdnbea.net）/ 拷贝漫画 API
      （api.copy2000.online）/ 绅士镜像（www.wn03.ru）也一起被废掉。
   ② 紳士漫畫（www.wnacg.com）与 hitomi.la 是**纯 DNS 污染**：系统 DNS 给假 IP，
      带 SNI 直连真 IP 就 200。而且解析器会互相打脸 —— 实测 hitomi.la：
      阿里 DNS 给 202.160.128.14（假）、腾讯 DoH 给 185.165.169.231（真，✓200）。
      所以 DoH 必须**多解析器并取候选，再用「能不能带 SNI 连上」验真**。
   ③ nhentai / E-Hentai / danbooru / kemono / i.pximg.net 直连彻底不通（SNI 阻断），
      但 Cloudflare 上的中继在境内直连可达，能把这些站的内容带回来：
         · api.allorigins.win/raw?url=…  文字 / JSON / 图片都行（实测 nhentai API 真回 JSON、
           E-Hentai favicon 回 image/x-icon）—— 会限流，所以只当最后手段且带冷却
         · i0.wp.com/<host>/<path>       图片专用（实测 nhentai 缩略图 → 200 image/jpeg 112KB）
         · wsrv.nl / images.weserv.nl    **不可用**（实测 400 Domain or TLD blocked by policy）
         · corsproxy.io 401 / codetabs SNI 阻断 / thingproxy 死 / isomorphic 403

   三层按顺序生效，任一层成功即返回；每台主机记住「哪一层有效」（hostPlan，10 分钟），
   所以只有第一次付探测成本：
     ① 原路（全局 fetch + 启动时探测到的代理）—— **有 VPN 时走的就是这一层，行为一字未改**
     ② 直连强化：DoH 多解析器并取 → 带 SNI 逐个验真 → 钉住可用 IP，用 node:https 直连
     ③ 中继：境内可达的 Cloudflare 中继代取（仅 GET、无自定义签名头时才允许）
   ========================================================================== */

/* ------------------------------ 统一响应对象 ------------------------------ */
function makeRes(status, rawHeaders, buf) {
  const h = {};
  Object.keys(rawHeaders || {}).forEach(k => { h[String(k).toLowerCase()] = rawHeaders[k]; });
  return {
    status: status,
    ok: status >= 200 && status < 300,
    headers: {
      raw: h,
      get: n => {
        const v = h[String(n).toLowerCase()];
        return Array.isArray(v) ? v.join(', ') : (v == null ? null : String(v));
      }
    },
    buf: buf,
    text: () => buf.toString('utf8'),
    json: () => JSON.parse(buf.toString('utf8'))
  };
}

/* ------------------------------ ① IP 钉选（DoH + 验真） ------------------------------ */
/* 解析器会互相打脸，所以「并取候选」而不是「信第一个」 */
const DOH_SERVERS = [
  { id: 'dnspod', url: 'https://doh.pub/dns-query' },
  { id: 'alidns', url: 'https://dns.alidns.com/resolve' },
  { id: 'cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { id: 'quad9', url: 'https://dns.quad9.net:5053/dns-query' }
];
const DNS_OK_TTL = 5 * 60e3;
const DNS_BAD_TTL = 60e3;
const PIN_TTL = 10 * 60e3;
const dnsCache = new Map();         // host -> { at, ttl, ips:[{ip,src}] }
const pinCache = new Map();         // host -> { ip, src, at, ttl }
const hostPlan = new Map();         // host -> { mode, at, ttl }
const PLAN_TTL = 10 * 60e3;

/* ★「别先烧预算，直接走中继」的预置通路★（2026-09-23）
   背景：outFetch 的三条腿是**串行**的（原路 → 直连强化 → 中继），而 e-hentai 的前两条
   在本机出口是**注定失败**的，代价却极高 —— DoH 腿要给多解析器 × 多候选 IP 逐个做
   TLS 验真，实测吃掉 5.4s。于是中继腿拿到手的只剩「总预算 − 5.4s」。
   真机实测（/api/diag，本机、无代理）：ehentai via=relay 成功一次要 **10978ms**，
   而 ehentaiSearch 的硬闸是 6000ms ⇒ **接力成功的那一次也被自己掐死**，
   用户看到的就是「E-Hentai 永远连不上」。这不是中继慢（cors.eu.org 实测 233–691ms），
   是前面 5.4s 白烧了。
   处置：把这些**实测「直连+DoH 恒失败、中继恒成功」**的主机预先标成 relay，
   outFetch 一进门就直奔中继 —— 首搜从 10978ms 降到一次中继往返。
   · 只列 e-hentai.org：它的 cors.eu.org 通路实测 8/8 成功、且不需要任何凭证。
   · **不要**把 www.pixiv.net 列进来：它也「直连恒失败」，但中继对它一律 403
     （Cloudflare WAF block_waf，pixiv 按机房 IP 封），预置成 relay 只是把
     「三条腿全灭」换成「一条腿必灭」，除了丢掉 DoH 的报错细节外没有任何收益。
   · 真按域名处理：hath.network 图床节点本机**直连可用**（历史实测 200/1780ms），
     不在表里，仍走原来的「原路优先」。
   · 表里命中的主机一旦真的失败，setPlan(host,'') 会把记忆清掉，
     后面的请求还能回到正常的竞速探测 —— 预置不会把它永久钉死。 */
const RELAY_PREFERRED = new Map([
  ['e-hentai.org', '自建中继（/api/ping 里标 private 的那条，顺序第一）实测 400ms 出 25 条；' +
    '它没配时公共中继 cors.eu.org 也能用（历史实测 8/8 成功、233–691ms）。直连与 DoH 在本机恒失败']
]);

/* ★「中继对这几种主机只会回空壳」：既不当候选，也绝不让它记通路★（2026-09-23 第 18 轮）
   ★决定性取证（同一秒并发三方对照，.tmp/_r18-copy-decisive.js）★
     · 本机**直连** api.copy-manga.com / api.copy2000.online 的同一个检索 URL
       ⇒ HTTP 200 `code=200 total=2186 list=30`（**真数据**，2.8–2.9s）
     · 同一条自建中继转发**一模一样**的 URL + 同一套签名头
       ⇒ HTTP 200 `code=200 total=0 list=0`（0.4–1.2s）
     · 更狠的一条：连**不带关键词**的列表接口 /api/v3/comics 经中继也是 total=0，
       而直连同时是 5 条真数据 ⇒ 不是「这个词没货」，是上游对 CF 机房出口发了空壳。
   危害是双层的：
     ① 空壳比直连的**真答案先到**（0.9s vs 2.9s），而竞速/通路选择是「先到先得」，
        于是真结果被丢掉 —— 第 17 轮把这件事误判成「上游检索服务在静默空转」，
        其实**同一秒直连就有 2186 条**；
     ② 空壳是「合法的 200 JSON」，outFetch 会顺手 `setPlan(host,'relay')` —— 一旦记上，
        这台主机**之后每次都先走中继**，拷贝漫画就此长期「搜不到」，直到网关重启。
        这正是用户说的「时好时坏」（取决于冷启动那一次竞速谁先到）。
   处置：这几个主机**不当中继候选**（不试、不记通路），直连/DoH 失败就如实报错，
   绝不拿中继的空壳冒充「上游返回 0 条」。 */
const RELAY_BAD_HOSTS = new Set([
  'api.copy-manga.com', 'api.copy2000.online', 'api.mangacopy.com'
]);

/* ★「200 但不是内容」的统一判据★（2026-09-23）
   本仓库踩过三次同一类坑，表现都是 **HTTP 200 + 一小段正文**，光看状态码一定会被骗：
     ① AllOrigins 抓不到时回 200 + 0 字节空壳            （gateway.js 的 guardEmpty 处理）
     ② cors.eu.org 把上游报错当 200 交回来：172B「Gallery not found.」
        （relayFetchOnce 的 rel.fakeOk 处理）
     ③ e-hentai 的**限流封禁**也回 200 + 242/243B：
        「This IP address has been temporarily banned due to an excessive request rate…」
        （ehBodyErr 处理「用户可见的报错」，但 /api/diag 的健康判定没管它 —— 见 ④）
   这一条是给「**健康判定**」用的共享判据，别再各写一份正则。
   ④ 为什么必须有：/api/diag 原来只判 `r.status < 500`，于是封禁期它照样报
      `ehentai: { ok: true, status: 200, ms: 711 }` —— 页面据此显示「E-Hentai 可达」，
      用户去搜却是全空。真机实测就是这么骗过一轮的（243B 的封禁页被算成健康）。 */
const TRAP_MARK = /temporarily banned|excessive request rate|gallery not found|access denied|bad gateway|not found\.\s*If you just added/i;
/** 真·内容（不是空壳、不是封禁/报错页）。只用于小的响应；大页面照旧一律算内容 */
function isTrapBody(buf) {
  if (!buf || !buf.length) return true;                 /* 空壳也算「不是内容」 */
  if (buf.length > 2048) return false;                  /* 够大就不可能是这些短错误页 */
  return TRAP_MARK.test(buf.slice(0, 1200).toString('utf8'));
}

const stripHost = u => String(u || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();

/** 钉选表的 lookup：命中就返回钉住的 IP，否则交回系统 DNS（**只有验真过的 IP 才会进表**） */
function hsLookup(hostname, options, cb) {
  if (typeof options === 'function') { cb = options; options = {}; }
  const pin = pinCache.get(hostname);
  if (pin && pin.ip && Date.now() - pin.at < pin.ttl) {
    if (options && options.all) return cb(null, [{ address: pin.ip, family: 4 }]);
    return cb(null, pin.ip, 4);
  }
  return dnsNative.lookup(hostname, options, cb);
}

const directAgent = new https.Agent({ keepAlive: true, maxSockets: 12, lookup: hsLookup });

/** 一次最原始的请求（可指定出口 agent；keepAlive 复用连接，读图才不会每张握一次手）
    ★必须自己跟随重定向★：node:http(s) 不像 fetch 那样自动跟，而这两个站的正常应答就是 3xx ——
      绅士漫画 www.wn03.ru → 301 → www.wn07.ru、www.wnacg.date → 301 → www.wnacg.com、
      porn-comic /q/<词>-<页>.html → 302 → 规范化地址。
      不跟的话，/api/proxy 把 301 原样回给浏览器，浏览器再去直连上游（跨域必失败），
      整个源就表现为「取不到」—— 之前绅士「经常检索不到」有一份就出在这里。 */
const HS_MAX_REDIRECT = 5;
function hsRequest(urlStr, o) {
  o = o || {};
  const hop = o._hop || 0;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('URL 不合法：' + urlStr)); }
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const headers = Object.assign({
      'user-agent': o.ua || UA_CHROME,
      accept: '*/*',
      /* ★千万别写 identity★（这个坑实测踩过）：
         E-Hentai 的 Varnish 对**不带压缩协商**的请求会回
         「HTTP 200 + content-type: text/html + content-length: 0」的空壳 ——
         状态码是成功的、正文是空的，上层只会看到「搜索 0 条 / 页面没匹配到作品」，
         究其原因能查很久。如实声明客户端支持的编码即可，解压由下面的
         gunzip / inflate / brotli 处理（本来就已经在处理了）。 */
      'accept-encoding': 'gzip, deflate, br'
    }, o.headers || {});
    const opt = {
      protocol: u.protocol, hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search, method: o.method || 'GET', headers: headers,
      agent: o.agent || (isHttps ? directAgent : undefined),
      timeout: o.timeout || 15000
    };
    if (isHttps && !o.agent) opt.servername = u.hostname;
    const req = mod.request(opt, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
        } catch (e) { /* 解压失败就按原样返回 */ }
        /* 空正文单独记原始响应头：这是最难查的一类「看起来成功了」——
           实测 E-Hentai 经 node:https 会回 200 + text/html + 0 字节，不看头根本没法判断是谁的问题 */
        if (!buf.length && res.statusCode < 400) {
          log('  ↑ 上游回空正文（HTTP ' + res.statusCode + '）：' +
            JSON.stringify(res.headers).slice(0, 320));
        }
        const code = res.statusCode;
        const loc = res.headers.location;
        /* 只跟 GET 的重定向；303 一律降级成 GET。hop 上限防环。 */
        if (loc && code >= 300 && code < 400 && o.redirect !== 'manual' && hop < HS_MAX_REDIRECT &&
            String(o.method || 'GET').toUpperCase() === 'GET') {
          let next;
          try { next = new URL(loc, urlStr).toString(); }
          catch (e) { return resolve(makeRes(code, res.headers, buf)); }
          log('  跟随重定向 ' + code + ' → ' + stripHost(next));
          resolve(hsRequest(next, Object.assign({}, o, { _hop: hop + 1 })));
          return;
        }
        resolve(makeRes(code, res.headers, buf));
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(o.body || undefined);
  });
}

/** 多解析器并取候选 A 记录（缓存 5 分钟；全空只缓存 60 秒） */
async function dohResolve(host, timeout) {
  const now = Date.now();
  const hit = dnsCache.get(host);
  if (hit && now - hit.at < hit.ttl) return hit.ips;
  const one = async s => {
    const tk = withTimeout(timeout || 4000);
    try {
      const r = await hsRequest(s.url + '?name=' + encodeURIComponent(host) + '&type=A', {
        headers: { accept: 'application/dns-json' }, timeout: timeout || 4000
      });
      if (!r.ok) return [];
      const j = JSON.parse(r.text());
      return (j.Answer || [])
        .filter(a => a.type === 1 && a.data)
        .map(a => String(a.data).trim())
        .filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip))
        .map(ip => ({ ip: ip, src: s.id }));
    } catch (e) { return []; } finally { tk.done(); }
  };
  const got = await Promise.all(DOH_SERVERS.map(one));
  const seen = {};
  const ips = [];
  got.forEach(list => list.forEach(x => { if (!seen[x.ip]) { seen[x.ip] = 1; ips.push(x); } }));
  dnsCache.set(host, { at: now, ips: ips, ttl: ips.length ? DNS_OK_TTL : DNS_BAD_TTL });
  if (ips.length) log('DoH 解析 ' + host + ' → ' + ips.map(x => x.ip + '(' + x.src + ')').join(' '));
  return ips;
}

/** 带 SNI 试握手：能握上（**并且证书真的覆盖这个域名**）才算这个 IP 在服务这个域名。
    证书校验刻意打开 —— 验真必须跟真实请求同一个口径，否则会把「同一台机器上的另一个站」
    钉进来（实测 api.copy-manga.com 被墙外 DNS 解析到 api.copy2000.online 的 IP 上，
    证书不覆盖它：宽松验真会钉一个用过就 100% 失败的 IP）。 */
function tlsCheck(ip, host, timeout) {
  return new Promise(resolve => {
    let done = false;
    let sock;
    const fin = ok => { if (!done) { done = true; try { sock.destroy(); } catch (e) {} resolve(ok); } };
    try {
      sock = tls.connect({ host: ip, port: 443, servername: host, rejectUnauthorized: true });
    } catch (e) { return resolve(false); }
    sock.setTimeout(timeout || 4000);
    sock.on('secureConnect', () => fin(true));
    sock.on('timeout', () => fin(false));
    sock.on('error', () => fin(false));
    sock.on('close', () => fin(false));
  });
}

const lookupSysIps = host => new Promise(resolve => {
  dnsNative.lookup(host, { all: true, verbatim: true }, (e, list) => {
    resolve(e ? [] : (Array.isArray(list) ? list : [list])
      .filter(x => x && x.family === 4).map(x => x.address));
  });
});

/** 候选 IP 并行验真，第一个握上的就赢（**不是**一个个顺序等超时 ——
    顺序等的话，系统 DNS 那个假 IP 会先吃掉 2.5s，DoH 的真 IP 就轮不到了） */
async function raceTls(cands, host, perTimeout) {
  const list = [];
  const seen = {};
  cands.forEach(c => { if (c && c.ip && !seen[c.ip]) { seen[c.ip] = 1; list.push(c); } });
  if (!list.length) return null;
  return new Promise(resolve => {
    let left = list.length;
    let settled = false;
    list.forEach(c => {
      tlsCheck(c.ip, host, perTimeout).then(ok => {
        if (ok && !settled) { settled = true; resolve(c); }
        else if (--left === 0 && !settled) { settled = true; resolve(null); }
      }).catch(() => { if (--left === 0 && !settled) { settled = true; resolve(null); } });
    });
  });
}

/** 墙外解析：境内 DoH 有时也给污染值（实测 hitomi.la 前一次给真 IP、后一次给假 IP），
    这时借中继去问墙外的 Google DoH —— 解析结果照样要过「带 SNI 验真」这一关，所以不怕它乱说。 */
async function relayDohResolve(host, timeout) {
  if (!relayUsable('allorigins')) return [];
  const inner = 'https://dns.google/resolve?name=' + encodeURIComponent(host) + '&type=A';
  const via = 'https://api.allorigins.win/raw?url=' + encodeURIComponent(inner);
  try {
    const r = await hsRequest(via, { timeout: timeout || 6000, headers: { accept: 'application/dns-json' } });
    if (!r.ok) return [];
    const j = JSON.parse(r.text());
    const ips = (j.Answer || [])
      .filter(a => a.type === 1 && a.data)
      .map(a => String(a.data).trim())
      .filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
    if (ips.length) log('墙外解析 ' + host + ' → ' + ips.join(' ') + '（经中继问 Google DoH）');
    return ips.map(ip => ({ ip: ip, src: 'relay-dns' }));
  } catch (e) { return []; }
}

/** 给某台主机钉一个验真过的 IP；钉不上返回 ''（调用方就该走中继了）
    系统 DNS 与 DoH **同时**问、候选 IP 一起并行验真，所以这一层的耗时 ≈ 一次握手，
    而不是「系统 DNS 超时 + DoH 超时 + 逐个验真」的累加。 */
async function pinHost(host, budget) {
  const hit = pinCache.get(host);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.ip;
  const per = Math.max(1500, Math.min(2500, budget || 2500));
  const [sysIps, dohIps] = await Promise.all([
    lookupSysIps(host),
    dohResolve(host, Math.max(1500, Math.min(3500, budget || 2500))).catch(() => [])
  ]);
  let win = await raceTls(
    sysIps.map(ip => ({ ip: ip, src: 'sysdns' })).concat(dohIps), host, per);
  /* 结点偶发抽风（实测拷贝漫画的节点会「这一次握不上、下一次没问题」）→ 短退避重试一次 */
  if (!win) {
    await sleep(400);
    win = await raceTls(
      sysIps.map(ip => ({ ip: ip, src: 'sysdns' })).concat(dohIps), host, per);
  }
  /* 境内解析器集体说谎（全给了污染值）→ 借中继问一次墙外 DNS 再验 */
  if (!win) {
    const far = await relayDohResolve(host, per + 2000);
    if (far.length) win = await raceTls(far, host, per);
  }
  if (win) {
    pinCache.set(host, { ip: win.ip, src: win.src, at: Date.now(), ttl: PIN_TTL });
    log('IP 钉选 ' + host + ' → ' + win.ip + '（来自 ' + win.src + '，带 SNI 验真通过）');
    return win.ip;
  }
  return '';
}

/* ------------------------------ ② 运行期出口（不再粘死） ------------------------------ */
const egress = {
  live: '',            // 当前真的活着的本地代理（'' = 走直连）
  lastLive: null,
  checkedAt: 0,
  switching: false
};

function envProxyUrl() { return String(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''); }
function portOfUrl(u) {
  const m = String(u || '').match(/^[a-z]+:\/\/([^:/]+)(?::(\d+))?/i);
  if (!m) return 0;
  return m[2] ? parseInt(m[2], 10) : 0;
}

/** 出口健康检查：启动时代理能用 ≠ 现在还能用，反之亦然。
    间隔刻意**不对称**：
      · 当前有可用代理 → 60 秒探一次（省得反复去打它）
      · 当前没有可用代理 → 10 秒探一次（用户随时可能开 VPN，等一分钟才认出来太迟钝）
    另外：任何请求失败都会把 checkedAt 清零、立刻重探（见 outFetch）。
    关掉的端口是 ECONNREFUSED、秒回，所以这个频率不花钱。 */
async function probeEgress() {
  const now = Date.now();
  const interval = egress.live ? 60e3 : 10e3;
  if (now - egress.checkedAt < interval) return egress;
  egress.checkedAt = now;
  let live = '';
  const envp = envProxyUrl();
  if (envp) {
    const p = portOfUrl(envp);
    if (p && await testProxyPort(p)) live = envp;
  }
  if (!live) {
    const found = await pickLocalProxy();
    if (found) live = found;
  }
  egress.live = live;
  if (egress.lastLive !== null && live !== egress.lastLive) {
    log('出口变化：' + (egress.lastLive || '直连') + ' → ' + (live || '直连') + '，清掉各主机记住的通路');
    hostPlan.clear();
  }
  egress.lastLive = live;
  return egress;
}

/** 经本地 HTTP 代理建隧道（CONNECT + TLS）；只有「原路是直连、但运行期发现了可用代理」时才用 */
class ProxyTunnelAgent extends https.Agent {
  constructor(proxy, opt) {
    super(Object.assign({ keepAlive: true, maxSockets: 8 }, opt || {}));
    this.proxyUrl = new URL(proxy);
  }
  createConnection(options, cb) {
    const target = (options.host || options.hostname) + ':' + (options.port || 443);
    const req = http.request({
      host: this.proxyUrl.hostname,
      port: this.proxyUrl.port || 80,
      method: 'CONNECT',
      path: target,
      headers: { host: target },
      timeout: options.timeout || 10000
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return cb(new Error('代理 CONNECT 返回 HTTP ' + res.statusCode));
      }
      const t = tls.connect({
        socket: socket,
        servername: options.servername || options.host || options.hostname,
        rejectUnauthorized: false
      });
      t.on('secureConnect', () => cb(null, t));
      t.on('error', e => cb(e));
    });
    req.on('timeout', () => req.destroy(new Error('代理 CONNECT 超时')));
    req.on('error', e => cb(e));
    req.end();
  }
}
const tunnelAgents = new Map();
function tunnelAgentFor(proxy) {
  if (!tunnelAgents.has(proxy)) tunnelAgents.set(proxy, new ProxyTunnelAgent(proxy));
  return tunnelAgents.get(proxy);
}

/* ------------------------------ ③ 中继（真被墙时的最后一条腿） ------------------------------ */
/* 全部为**境内实测直连可达**的中继，墙外取内容再带回来。
   AllOrigins 会限流（实测同一接口重复打会回 {"error":…}），所以带冷却 + 失败即换下一个。

   ★cors.eu.org 排第一（2026-09-23 本机实测，见下面 fakeOk 那段的长注释）★
   实测数据（无代理、无 VPN，本机直连出口）：
     · https://e-hentai.org/                  → HTTP 200 · 66139B · 268–787ms（8/8 全成功）
     · https://e-hentai.org/g/<gid>/<token>/  → HTTP 200 · 20114B ·  233–783ms（5 并发也全成功）
     · /?f_search=fate&f_apply=Apply+Filter   → HTTP 200 · 67612B · ~320ms（搜索页真结果）
     · /s/<ptoken>/<gid>-<n>                  → HTTP 200 ·  4662B · ~223ms（含 <img id="img">）
     · 大图 https://<node>.hath.network/…/x/0 → HTTP 200 · 237188B · 691ms · image/jpeg
       sha=b313a632ad6f —— 与 tools/reader-eh-rootcause.md 记的那张**逐字节一致**
     · 5 个不同 URL 并发 → 全 200，未触发限流
   对照 AllOrigins 同日：/raw 16.2s 回 520/522、/get 5.4–5.9s 才回 200（第 3 次 500）
   ⇒ cors.eu.org 是**唯一能进 12s 预算**的 e-hentai 通路，allorigins 只能当后备。
   语法是**路径式**：https://cors.eu.org/<完整 URL>。?url= 与 /api 两种写法实测都回 500。
   对 pixiv **无效**：www.pixiv.net 一律 403，正文是 Cloudflare WAF 的 block_waf 页
   （「あなたの環境からはpixivにアクセスできません」）—— 那是 pixiv 按**机房 IP** 封的，
   与本机被墙是两回事，换中继解决不了，所以 pixiv 那条路不要往这里挂。 */
/* ------------------------- 自建中继（2026-09-23 第 12 轮新增） -------------------------
   为什么必须自建（实测证据见 tools/relay-deploy.md，别凭印象删掉这一段）：
     · e-hentai.org：系统 DNS 直接 NXDOMAIN；自带 DoH 拿到的候选 IP 带真 SNI 直连全部超时；
     · www.pixiv.net：DoH 给出的是 Cloudflare **真段** 104.18.42.239，带真 SNI 直连 ~100ms 被
       ECONNRESET（TLS 握手中按 SNI 重置 —— 所以「钉 IP + 真 SNI」这条万能解在这里也无效）；
     · 15 条公共中继候选 × 2 目标 = 0 成功：cors.eu.org 全局限流 429、allorigins 不可达、
       workers.dev / r.jina.ai / vercel.app 这三个**域名本身**被墙。
   ⇒ 「公共中继」这条路在本机出口上物理不存在，唯一出路是用户自己的一台墙外中继。
     部署方式（都免费、都不用买域名）见 tools/relay-deploy.md，Cloudflare Pages 最省事。
   配置（两种，可同时用；都不配 = 行为与之前完全一致）：
     · tools/relay.txt —— 每行一条 `地址[ 空格或| key]`，`#` 后面是注释；
     · 环境变量 HS_GW_RELAY —— 逗号分隔，写法 `地址|key`。
   地址里可以写 `{url}` 占位（替换成 encodeURIComponent 后的目标）；不写就自动追加
   `?url=<encoded>[&k=<key>]`。
   ★私有中继的三条特殊待遇（下面 relayFetch / relayFetchOnce 里都标了 private 分支）★
     1) 排在公共中继**前面**先试；
     2) 请求带 `x-hs-key`（公共中继没有 key 这回事）；
     3) **只有它允许转发 cookie / 签名头** —— 用户自己的登录凭据绝不能交给第三方中继。
        公共中继在「带 cookie 的请求」上会被整条跳过，这正是 pixiv R-18 一直走不通的根本原因。
   ⚠ relay.txt 里可能有 key，别把它提交进仓库（.gitignore 已加）。 */
const PRIVATE_RELAY = (function loadPrivateRelays() {
  const items = [];
  try {
    const f = path.join(__dirname, 'relay.txt');
    if (fs.existsSync(f)) {
      fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach(line => {
        const s = line.replace(/#.*$/, '').trim();
        if (s) items.push(s);
      });
    }
  } catch (e) { /* 读不到就当没配 */ }
  String(process.env.HS_GW_RELAY || '').split(',').forEach(s => { if (s.trim()) items.push(s.trim()); });
  const out = [];
  items.forEach(raw => {
    const parts = raw.indexOf('|') >= 0 ? raw.split('|') : raw.split(/\s+/);
    const url = String(parts[0] || '').trim();
    const key = String(parts[1] || '').trim();
    if (!/^https?:\/\//i.test(url)) return;
    out.push({
      id: 'private' + (out.length ? String(out.length + 1) : ''),
      kind: 'any', private: true, key: key, base: url,
      tpl: u => (url.indexOf('{url}') >= 0
        ? url.replace('{url}', encodeURIComponent(u))
        : url + (url.indexOf('?') >= 0 ? '&' : '?') + 'url=' + encodeURIComponent(u) +
          (key ? '&k=' + encodeURIComponent(key) : '')),
    });
  });
  return out;
})();
/* 允许转给**用户自己的**中继的请求头（中继会以 x-hs-h-* 的形式再发给上游）。
   只给私有中继用；公共中继一个都不给。 */
const PRIVATE_FORWARD_HDR = ['cookie', 'referer', 'accept-language', 'user-agent', 'x-requested-with', 'accept'];
const hasSecretHeaders = (o) => Object.keys((o && o.headers) || {})
  .map(k => k.toLowerCase()).some(k => /token|signature|authorization|x-auth|umstring|cookie/.test(k));

const relayUrlInline = u => String(u);
const RELAYS = [
  { id: 'cors-eu', kind: 'any', fakeOk: 'cors-eu', tpl: u => 'https://cors.eu.org/' + relayUrlInline(u) },
  { id: 'allorigins', kind: 'any', tpl: u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
  /* 同一个服务的另一个端点：返回体是 {"contents":"…"}。
     它有独立的工作进程与缓存，实测主端点回 522 时它常常还能答上来 ——
     所以当**第二路**用（不占第一路的位置，只在主端点 5xx / 报错时兜）。 */
  { id: 'allorigins-get', kind: 'text', json: true, tpl: u => 'https://api.allorigins.win/get?url=' + encodeURIComponent(u) },
  { id: 'i0.wp', kind: 'image', tpl: u => 'https://i0.wp.com/' + String(u).replace(/^https?:\/\//i, '') }
];
/* 自建中继插到**最前面**（倒序 unshift 以保持 relay.txt 里的书写顺序）：
   公共中继在本机出口上已知全灭（见上面注释），用户自己的一定要先试。 */
PRIVATE_RELAY.slice().reverse().forEach(r => RELAYS.unshift(r));
const relayState = new Map();       // relayId -> 冷却截止时间
/* ★(中继 × 目标主机) 记忆（2026-09-23 第 12 轮新增）★
   自建中继实测：Cloudflare Pages 的机房出口对 e-hentai / mangadex / porncomic / hitomi 是 200，
   对 nhentai / danbooru / jmcomic / pixiv 一律 403（目标站按**机房 IP** 封，与中继好坏无关）。
   旧逻辑遇到上游 4xx 只 push 一句错误、下一轮还拿同一条腿去撞；更糟的是 5xx/超时会把整条中继
   按 15–45s **全局**冷却 —— 于是「pixiv/nhentai 被 403、502」会把 e-hentai 一起拖下水。
   第 12 轮实测：私有腿排进 relays[0] 之后 nhentai 从 58.3% 掉到 16.7%、e-hentai 只剩 8.3%，
   根因就是这套「一荣俱荣、一损俱损」的冷却。
   ⇒ 现在按 (中继, 主机) 记一笔：
     · 4xx（429 除外）= 目标拒绝这条腿 ⇒ 10 分钟内不再拿这条腿试**这个主机**；
     · 私有中继的 5xx/超时 = 它那一刻打不到**这个主机** ⇒ 90 秒内只对这个主机退避；
     · 其它主机、其它目标完全不受影响。 */
const relayHostDead = new Map();    // 'relayId|host' -> 冷却截止时间
const RELAY_HOST_DEAD_MS = 10 * 60e3;   // 目标按出口 IP 拒绝（403/404）：10 分钟
const RELAY_HOST_SOFT_MS = 90e3;        // 私有中继打不到该主机（5xx / 空 200）：90 秒
/* ★「慢」和「打不通」要分开★（第 16 轮实测）：私有腿**吃满了预算**才超时（timeout），
   说明目标站那一刻只是慢 —— porn-comic 经中继的实测分布是 1.6–2.9s（第 90 百分位约 3.9s，
   偶尔 5.4s）。旧代码统一记 90s 站点退避，于是一次偶发慢响应把唯一能通的通路锁 90 秒，
   后面几分钟的检索全落到 6–9s 的 Chrome 上 ⇒ 整轮硬闸超时。
   ⇒ 超时（不是拒绝）只退避 30 秒，且下一次成功会立刻恢复。 */
const RELAY_HOST_SLOW_MS = 30e3;
const relayHostKey = (id, host) => id + '|' + host;
/* ★私有腿的 4xx 要「连续两次才算站」★（第 16 轮实测，tools/_p12.js）
   porn-comic 的多词搜索 `/q/big%20boobs-1.html` 会被站点自己 302 到
   `https://search.porn-comic.com/q/big boobs-1-<hash>.html`，而那个子域对**任何**请求都回
   403「Just a moment...」（CF 挑战）—— 换编码（%20 / + / 连字符）都一样。
   旧逻辑「一次 4xx ⇒ 判 (private × porn-comic.com) 死 10 分钟」于是把**路径级**的拒绝
   升级成**主机级**封禁：big boobs 撞了一次之后，连正常能通的 `anal`（1928ms / 24 条）也被
   自己人挡在门外，整条中继腿 3 分钟不可用。
   ⇒ 私有腿的 4xx 先记一笔「可疑」，同一个 (腿 × 主机) 在 5 分钟内**再撞一次**才判 10 分钟；
     任何一次成功（2xx 且正文非空）立刻清零。公共腿（共享出口、且它们本来就不转 cookie）
     维持原样：一次 4xx 就退避该主机。 */
const relayHost4xx = new Map();         // 'relayId|host' -> { n, at }
const RELAY_4XX_WINDOW_MS = 5 * 60e3;   // 「连续」的判定窗口
function relayHostUsable(id, host) {
  return (relayHostDead.get(relayHostKey(id, host)) || 0) < Date.now();
}
function relayHostBlockedCount(id) {
  let n = 0;
  const pre = id + '|';
  relayHostDead.forEach((until, k) => { if (k.indexOf(pre) === 0 && until > Date.now()) n++; });
  return n;
}
function hostOfUrl(u) { try { return new URL(u).host; } catch (e) { return String(u); } }
/* ★预置「私有腿打不通的主机」（2026-09-23 实测真值表，见 tools/relay-deploy.md 第 5 节）★
   Cloudflare Pages 的机房出口对这些站一律拒绝（目标站按**机房 IP** 封，与中继好坏无关）：
   nhentai 403 / danbooru 403 / wnacg 403 / jmcomic 403 / pixiv 403(Cloudflare WAF) /
   lectormanga 530。每次都去撞它们的代价不只是慢：12 轮压测里这批必败请求把 Cloudflare 边缘
   打到回 `429 {"error":"Rate limit exceeded"}`，private 因此吃 45s **全局**冷却，
   而 e-hentai 只有这条腿能走 ⇒ e-hentai 只剩 8.3%（tools/stability-report-r12b.md）。
   预置成 (中继, 主机) 退避后：这些站直接落到公共中继/直连，private 的额度只花在它真能通的站
   （e-hentai / mangadex / porncomic / hitomi）。TTL 与运行时学到的一致（10 分钟），
   所以把 relay.txt 换成住宅出口后重启，这些站会重新被尝试。 */
/* ★★ 2026-09-23 更正：**必须按「真实端点」判，不能按域名判** ★★
   最初把 nhentai.net 也列进了下面这张表（当时只探了根路径 `/search/?q=`，403 "Just a moment..."）。
   随后按**网关真正使用的端点**复测，nhentai 的 JSON API 走私有腿是**通的**：
     `https://nhentai.net/api/v2/search?query=naruto` ⇒ 200 / 9822B / 826ms
     `https://nhentai.net/api/v2/search?query=test`   ⇒ 200 / 11358B / 386ms
   （同一个域名下 HTML 搜索页 403、API 200 —— Cloudflare 只挡了 HTML 路由。）
   把它移出黑名单后 nhentai 从 0% 回到可用（tools/stability-report-r12e）。
   ⇒ 教训：探针要打**代码里那一行 URL**，不要打站点首页。 */
const PRIVATE_BLOCKED_HOSTS = [
  'danbooru.donmai.us', 'www.wnacg.com', 'jmcomic.me',
  'www.pixiv.net', 'lectormanga.com'
];
PRIVATE_RELAY.forEach(rel => PRIVATE_BLOCKED_HOSTS.forEach(h =>
  relayHostDead.set(relayHostKey(rel.id, h), Date.now() + RELAY_HOST_DEAD_MS)));
/* 两档冷却：429 是真限流（等久一点）；5xx / 522 / 524 多是中继自己那一刻打不到上游，
   属于**瞬时**故障 —— 罚它 45 秒会让「本来下一秒就能成功」的请求全部落空。 */
const RELAY_COOLDOWN = 45e3;
const RELAY_SOFT_COOLDOWN = 15e3;
/* 私有腿被**目标站限流**（429）时的退避：只退避 (中继 × 主机)，比「打不通」短一点 ——
   限流是会自己好的，60 秒足够让同一条腿去服务别的目标站。 */
const RELAY_HOST_LIMIT_MS = 60e3;
function relayUsable(id) { return (relayState.get(id) || 0) < Date.now(); }

function looksLikeImage(url) {
  try {
    const u = new URL(url);
    return /\.(jpe?g|png|webp|gif|avif|bmp|ico)(\?|$)/i.test(u.pathname + u.search);
  } catch (e) { return false; }
}

/** 中继取内容：只允许「GET + 没有自定义签名头」（有签名头的接口中继转不了，也不该转） */
async function relayFetch(url, o) {
  o = o || {};
  const method = String(o.method || 'GET').toUpperCase();
  if (method !== 'GET' || o.body) throw new Error('中继只支持 GET');
  /* 带签名/cookie 的请求（pixiv 的 PHPSESSID 就是这一类）：只允许走**用户自己的**中继。
     公共中继一个凭据都不给 —— 这是安全边界，不是性能取舍。 */
  if (hasSecretHeaders(o) && !PRIVATE_RELAY.length) {
    throw new Error('这条请求带自定义签名头，公共中继转不了（也不该把你的签名交给第三方）；'
      + '要打通这条通路得自建中继：见 tools/relay-deploy.md');
  }
  const wantImg = o.image === true || looksLikeImage(url);
  const errs = [];
  /* 中继会把上游的 3xx 原样回给我们（它自己不跟），所以这里要自己跟 —— 
     porn-comic 的 /q/<词>-<页>.html 就是 302 到规范化地址的。 */
  let cur = url;
  for (let hop = 0; hop <= 3; hop++) {
    const one = await relayFetchOnce(cur, o, wantImg);
    if (one.res) return one.res;
    if (one.redirect) { cur = one.redirect; continue; }
    errs.push(one.err || '未知原因');
    break;
  }
  throw new Error('中继全失败：' + errs.slice(0, 3).join('；'));
}

async function relayFetchOnce(url, o, wantImg) {
  const errs = [];
  /* ★逐腿分预算★（2026-09-23）：中继腿是**串行**的，而每条腿原来都拿 `o.timeout` 全量，
     于是「3 条腿 × 各 20s」能拖到 60s —— 真机实测：cors-eu 报错走进 42s 冷却后，
     allorigins 与 allorigins-get 各自把整个 6s 预算烧光，用户白等 6648ms 拿到一句
     「超过 6000ms 硬闸」。这与 outFetch 那边「leg() 按同一个 t0 扣时间」是同一个毛病，
     只是这里没跟着修。现在给每条腿**平均分剩下的预算**并夹上限：
     实测 cors.eu.org 只需 233–691ms，18s 上限对它绰绰有余；
     真正慢的 allorigins（实测 5.4–16.2s）拿不到 18s 就快速让位给下一条，
     整条中继链因此有上界，而不是「腿数 × 全量超时」。 */
  const needSecret = hasSecretHeaders(o);   /* 带凭据的请求只走私有中继（见下面循环里的跳过） */
  const LEG_MAX = 18000;
  const total = Math.max(600, o.timeout || 20000);
  const legCount = Math.max(1, RELAYS.filter(r =>
    !(r.kind === 'image' && !wantImg) && !(r.json && wantImg)).length);
  const perLeg = Math.max(600, Math.min(LEG_MAX, Math.floor(total / legCount)));
  /* ★私有腿要单独分预算（2026-09-23 第三次压测发现）★
     「平均分」对**自建中继**是错的：它排在第一位，而且常常是这一发**唯一**能通的腿
     （e-hentai 的原路/DoH 在本机恒失败，公共中继 429/超时）。
     而 e-hentai 检索的总预算只有 EH_STEP_SEARCH=4000ms，除以 5 条腿 ⇒ 每条 800ms，
     自建中继实测要 1.4–2.0s（被 Cloudflare 边缘 + e-hentai 限流时更久）
     ⇒ 实测报「private 连不上 e-hentai.org：timeout」，e-hentai 掉到 50%
     （tools/stability-report-r12c.json）。现在给私有腿 60% 预算（上限仍是 18s）：
     4000ms 的一发里它能拿到 2400ms，够它答完；答不完也只是提前把预算还给别的腿。 */
  const perLegPrivate = Math.max(perLeg, Math.min(LEG_MAX, Math.floor(total * 0.6)));
  /* ★r18★ 调用方可以给**公共后备腿**单独加一个更短的上限（o.legCap）。
     动机：nhentai 图库接口那一发只是取 ~3KB JSON，健康时 455ms，
     被限流时却让 allorigins / allorigins-get **各烧满 perLeg=4750ms** ⇒ 用户白等 12 秒。
     取小 JSON 时给公共腿 2000ms 上限，慢腿提前让位，整条阶梯的墙钟有硬上界。
     私有腿不受影响（它常是唯一能通的腿，预算仍按 60%/relayLegMs 走）。
     ★注意 0 与「没传」必须区分（第 12 轮踩过）：没传 o.legCap 时 legCap 必须是 **0 = 不设上限**，
     否则 `Math.max(600, 0)` 会给**所有**调用方的公共腿压成 600ms（e-hentai 的 cors-eu 实测 233–691ms，
     就被这一下误杀了）。 */
  const legCapRaw = Math.min(LEG_MAX, parseInt(o.legCap, 10) || 0);
  const legCap = legCapRaw > 0 ? Math.max(600, legCapRaw) : 0;
  /* 这条请求要打的目标主机：用来查/写「中继 × 主机」记忆（见 relayHostDead 注释） */
  const tHost = hostOfUrl(url);
  for (const rel of RELAYS) {
    /* eslint-disable no-await-in-loop */
    if (!relayUsable(rel.id)) { errs.push(rel.id + ' 冷却中'); continue; }
    if (!relayHostUsable(rel.id, tHost)) {
      errs.push(rel.id + ' 已记「被 ' + tHost + ' 按出口 IP 挡」（' +
        Math.round(RELAY_HOST_DEAD_MS / 60000) + ' 分钟内不试这条腿）');
      continue;
    }
    if (rel.kind === 'image' && !wantImg) { continue; }
    if (rel.json && wantImg) { continue; }        /* 图片不要走 get 端点（它会把二进制塞进 JSON） */
    /* ★凭据只给用户自己的中继★：请求里带 cookie / 签名头时，公共中继整条跳过
       （否则等于把用户的 PHPSESSID 交给第三方）。pixiv R-18 之前必然失败就卡在这里。 */
    if (needSecret && !rel.private) {
      errs.push(rel.id + ' 不支持带 cookie/签名头的请求（只有自建中继可以）');
      continue;
    }
    const via = rel.tpl(url);
    /* 私有中继：带 key，并按白名单把请求头以 x-hs-h-* 的形式转给它（它再发给上游） */
    const reqHeaders = { accept: '*/*' };
    if (rel.private) {
      if (rel.key) reqHeaders['x-hs-key'] = rel.key;
      const hh = o.headers || {};
      Object.keys(hh).forEach(k => {
        const lk = k.toLowerCase();
        if (PRIVATE_FORWARD_HDR.indexOf(lk) >= 0 && hh[k]) reqHeaders['x-hs-h-' + lk] = hh[k];
      });
    }
    let r;
    let t0leg = 0;
    try {
      /* 中继本身必须**直连**取（它就在墙上边；跟着死代理走就没意义了），并且不要再跟 3xx */
      /* ★o.relayLegMs★（第 16 轮加）：调用方可以给「私有腿」单独指定一个更大的预算。
        为什么需要：perLegPrivate 是从**本次请求总预算**算出来的（60%），而 porn-comic
        的列表页经 Cloudflare Worker 取回实测要 2286ms，总预算 4000ms 时私有腿只分到 2400ms
        ⇒ 实测报「private 连不上 porn-comic.com：timeout」，随后 relayHostDead 把这条腿
        记 90 秒并连累整条中继通路。调用方知道自己在打一个「只有私有腿能通、且它要 2-3s」
        的目标时，就直接把这条腿的预算说明白。 */
      const legPrivateMs = Math.max(perLegPrivate, Math.min(LEG_MAX, o.relayLegMs || 0));
      /* ★私有腿的 4 秒地板（第 16 轮实测定案）★
         现象：网关日志报「private 连不上 porn-comic.com：timeout」，而**同一个时刻**用 node 直连
         同一条中继取同一个页面是 1000–2629ms（tools/_p11.js 十二次全 200 + 真内容）。
         根因就在这一行上面：legPrivateMs 是从**本次请求总预算**算出来的（perLegPrivate = 60%），
         而调用方往往只剩几百毫秒 —— 实测诊断日志 `预算 600ms（total=900 …）`。
         600ms 打不通一个要 2s 的 Worker，这不是「主机不可达」，但旧代码照样把
         (private × porn-comic.com) 记 90 秒退避 ⇒ 下一次预算充足的请求被自己人挡在门外。
         所以：① 给私有腿一个不超过总预算的 4s 地板；② 低于 3s 的腿失败**不记站点退避**
         （一条只拿到 600ms 的腿说明不了主机任何事）。 */
      const legFloor = Math.min(4000, total);
      const legMs = Math.max(legPrivateMs, legFloor);
      /* ★临时诊断（第 16 轮，查 porncomic 的 private timeout）★ */
      t0leg = Date.now();
      log('  [腿诊断] ' + rel.id + ' → ' + tHost + '：预算 ' +
        (rel.private ? legMs : (legCap ? Math.min(perLeg, legCap) : perLeg)) + 'ms（total=' + total + ' perLeg=' + perLeg +
        ' perLegPrivate=' + perLegPrivate + ' relayLegMs=' + (o.relayLegMs || 0) + ' legCap=' + legCap +
        ' needSecret=' + needSecret + '）');
      r = await hsRequest(via, {
        timeout: rel.private ? legMs : (legCap ? Math.min(perLeg, legCap) : perLeg), headers: reqHeaders, redirect: 'manual'
      });
    } catch (e) {
      log('  [腿诊断] ' + rel.id + ' → ' + tHost + ' 失败于 ' + (Date.now() - t0leg) + 'ms：' + ((e && e.message) || e));
      /* ★超时 / 连不上要分清是谁的错★（2026-09-23 实测事故）：
         - 公共中继：多半是这条公共出口自己过载或被限流 ⇒ 整条腿软冷却（保持原行为）。
         - 私有中继：我们自己的 Worker 是活的，是这个**目标主机**打不通（被墙 / 挂死）
           ⇒ 只记 (中继 × 主机)。否则 nhentai / pixiv 的一次超时会把 private 整条腿
           软冷却 15s，e-hentai 正好只有这条腿能走 ⇒ 整轮 e-hentai 全灭
           （tools/stability-report-r12b.md：ehentai 8.3%，错误原文「private 冷却中」）。
         - ★预算不足的私有腿不算数★：见上面 legFloor 的注释 —— 只给几百毫秒就超时的腿，
           记 90 秒站点退避纯属自伤（实测把 porn-comic 唯一能通的通路锁死）。 */
      const legBudget = rel.private ? Math.max(perLegPrivate, Math.min(LEG_MAX, o.relayLegMs || 0),
        Math.min(4000, total)) : perLeg;
      if (rel.private && legBudget < 3000) {
        errs.push(rel.id + ' 这一发只分到 ' + legBudget + 'ms 预算（本次请求总预算 ' + total +
          'ms），超时不算主机的错');
      } else if (rel.private) {
        const isTimeout = /timeout/i.test(((e && e.message) || e) + '');
        const softMs = isTimeout ? RELAY_HOST_SLOW_MS : RELAY_HOST_SOFT_MS;
        relayHostDead.set(relayHostKey(rel.id, tHost), Date.now() + softMs);
        errs.push(rel.id + ' 连不上 ' + tHost + '：' + ((e && e.message) || e) +
          '（' + Math.round(softMs / 1000) + 's 内只对这一个站退避）');
      } else {
        relayState.set(rel.id, Date.now() + RELAY_SOFT_COOLDOWN);
        errs.push(rel.id + ' 连不上：' + ((e && e.message) || e));
      }
      continue;
    }

    /* get 端点：把 {"contents":…} 拆出来，合成为普通响应 */
    if (rel.json) {
      let j = null;
      try { j = JSON.parse(r.text()); } catch (e) { /* 下面统一处理 */ }
      if (!j || typeof j.contents !== 'string') {
        relayState.set(rel.id, Date.now() + RELAY_SOFT_COOLDOWN);
        errs.push(rel.id + ' 返回体不是 {contents}（HTTP ' + r.status + '）');
        continue;
      }
      const code = (j.status && j.status.http_code) || 200;
      const body = j.contents;
      /* ★空 200 必须当成失败★：AllOrigins 的 /get 在自己没抓到时会回
         {"contents":"","status":{"http_code":200}} —— 当成成功就会把一个空页面
         当成「搜索 0 条」上报，用户看到的是「没结果」而不是「没取到」。 */
      if (code >= 400 || !body) {
        relayState.set(rel.id, Date.now() + RELAY_SOFT_COOLDOWN);
        errs.push(rel.id + (code >= 400 ? ' 上游 HTTP ' + code : ' 回了空 contents（http_code=' + code + '）'));
        continue;
      }
      log('中继取回 ' + stripHost(url) + ' ← ' + rel.id + '（' + Buffer.byteLength(body) + 'B）');
      return { res: makeRes(code, { 'content-type': 'text/html; charset=utf-8' }, Buffer.from(body, 'utf8')) };
    }

    const head = r.buf.slice(0, 160).toString('utf8');
    if (r.status === 429 || /^\s*\{\s*"(error|status)"\s*:/i.test(head)) {
      /* ★私有中继的 429 ≠ 中继坏了（2026-09-23 第五次压测发现）★
         r12f 里 e-hentai 连过 6 轮（374–1217ms）之后突然「中继全部在冷却中（最久还需 38s）」，
         后面 5 轮全灭、当时正在走的 nhentai 也被连坐成 50%。
         根因就是这一行：**任何** 429 都写 45 秒**全局**冷却，而私有中继上的 429 其实是
         **上游**（e-hentai / nhentai 按出口 IP 限流）在拒绝，我们自己的 Worker 是好的 ——
         下一个不同的目标用同一条腿照样能成功。所以私有腿改成只退避 (中继 × 主机)，
         公共中继（cors.eu.org 自己限流）保持原来的全局 45s。 */
      if (rel.private) {
        relayHostDead.set(relayHostKey(rel.id, tHost), Date.now() + RELAY_HOST_LIMIT_MS);
        errs.push(rel.id + ' 被 ' + tHost + ' 限流了（HTTP ' + r.status + '，' + r.buf.length + 'B）：' +
          Math.round(RELAY_HOST_LIMIT_MS / 1000) + 's 内只对这一个站退避，其它目标不受影响｜正文=' +
          r.buf.slice(0, 80).toString('utf8').replace(/\s+/g, ' '));
        continue;
      }
      relayState.set(rel.id, Date.now() + RELAY_COOLDOWN);
      /* ★429 要把正文说出来★（2026-09-23）：中继限流时回的是**服务方自己的 HTML 错误页**
         （实测 cors.eu.org 回 429 + `<!doctype html>…`），只写「限流/报错（HTTP 429）」的话，
         用户/下一轮排查根本看不出是谁在限流、为什么。这里截一小段正文并压成单行。 */
      errs.push(rel.id + (r.status === 429 ? ' 中继自己限流了（HTTP 429，' +
        r.buf.length + 'B）：' : ' 限流/报错（HTTP ' + r.status + ' ' + head.slice(0, 60) + '），') +
        '冷却 ' + Math.round(RELAY_COOLDOWN / 1000) + 's｜正文=' +
        r.buf.slice(0, 80).toString('utf8').replace(/\s+/g, ' '));
      continue;
    }
    if (r.status >= 500) {
      if (rel.private) {
        /* 私有中继 5xx = 它那一刻打不到**这个主机**（实测 nhentai 会这样）。
           只对 (中继, 主机) 退避，不冷却整条中继 —— 否则 e-hentai 会被连坐。 */
        relayHostDead.set(relayHostKey(rel.id, tHost), Date.now() + RELAY_HOST_SOFT_MS);
        errs.push(rel.id + ' HTTP ' + r.status + '（中继自己打不到 ' + tHost + '，' +
          Math.round(RELAY_HOST_SOFT_MS / 1000) + 's 后只对这一个站重试；其它目标不受影响）');
      } else {
        relayState.set(rel.id, Date.now() + RELAY_SOFT_COOLDOWN);
        errs.push(rel.id + ' HTTP ' + r.status + '（中继自己打不到上游，' +
          Math.round(RELAY_SOFT_COOLDOWN / 1000) + 's 后自动重试）');
      }
      continue;
    }
    /* 上游的 3xx 经中继原样回来：交给调用方再中继一次（换个地址） */
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      return { redirect: r.headers.get('location'), err: rel.id + ' → 上游 ' + r.status };
    }
    if (!r.ok) {
      /* 4xx（429 上面已单独处理）= **目标站对这条中继的拒绝**（机房 IP 被 WAF 挡），
         不是中继故障：只记 (中继, 主机)，绝不冷却整条中继。 */
      if (r.status >= 400 && r.status < 500) {
        const deadMin = Math.round(RELAY_HOST_DEAD_MS / 60000);
        if (rel.private) {
          /* 见 relayHost4xx 的注释：路径级 403 不该升级成主机级封禁 */
          const k4 = relayHostKey(rel.id, tHost);
          const prev4 = relayHost4xx.get(k4);
          const n4 = (prev4 && (Date.now() - prev4.at) < RELAY_4XX_WINDOW_MS) ? prev4.n + 1 : 1;
          relayHost4xx.set(k4, { n: n4, at: Date.now() });
          if (n4 >= 2) {
            relayHostDead.set(k4, Date.now() + RELAY_HOST_DEAD_MS);
            errs.push(rel.id + ' HTTP ' + r.status + '（连续 ' + n4 + ' 次被 ' + tHost +
              ' 按出口 IP 挡，' + deadMin + ' 分钟内不再拿它试这个站；其它目标不受影响）');
          } else {
            errs.push(rel.id + ' HTTP ' + r.status + '（' + tHost + ' 这一条路径被挡；私有腿第一次不判死，' +
              '5 分钟内再撞一次才退避 ' + deadMin + ' 分钟）');
          }
        } else {
          relayHostDead.set(relayHostKey(rel.id, tHost), Date.now() + RELAY_HOST_DEAD_MS);
          errs.push(rel.id + ' HTTP ' + r.status + '（' + tHost + ' 按出口 IP 挡了这条中继，' +
            deadMin + ' 分钟内不再拿它试这个站；其它目标不受影响）');
        }
      } else {
        errs.push(rel.id + ' HTTP ' + r.status);
      }
      continue;
    }
    /* 空 200 同样当失败（中继偶尔会先回一个空壳，正文随后才到 / 或干脆没抓到） */
    if (!r.buf.length) {
      if (rel.private) {
        relayHostDead.set(relayHostKey(rel.id, tHost), Date.now() + RELAY_HOST_SOFT_MS);
        errs.push(rel.id + ' 回了空响应（HTTP 200 但 0 字节）→ 只对 ' + tHost + ' 退避 ' +
          Math.round(RELAY_HOST_SOFT_MS / 1000) + 's');
      } else {
        relayState.set(rel.id, Date.now() + RELAY_SOFT_COOLDOWN);
        errs.push(rel.id + ' 回了空响应（HTTP 200 但 0 字节）');
      }
      continue;
    }
    /* 拿到非空正文 ⇒ 这条腿对该主机是好的：把 4xx 可疑计数清零 */
    relayHost4xx.delete(relayHostKey(rel.id, tHost));
    if (wantImg && !/^image\//i.test(r.headers.get('content-type') || '')) {
      errs.push(rel.id + ' 回的不是图片（' + (r.headers.get('content-type') || '?') + '）');
      continue;
    }
    /* ★把「中继把上游的报错当 200 交回来」认出来★（判据统一走 isTrapBody，别各写一份）
       ✓ 判据形状：`rel.fakeOk` 只管**文本**（`allorigins-get` / `cors-eu`），
         **图片类中继（i0.wp）绝不能套** —— 那张检查会读正文前 1200 字节，
         而真图片的前几个字节就可能正好匹配到关键字，会把好图判成坏图。
       ✓ 为什么只对 fakeOk 打开：其他中继没实测出这个毛病，多一道闸就多一次误杀机会。 */
    if (rel.fakeOk && isTrapBody(r.buf)) {
      relayState.set(rel.id, Date.now() + RELAY_SOFT_COOLDOWN);
      errs.push(rel.id + ' 把上游报错当 200 交回来了（' + r.buf.length + 'B：' +
        r.buf.slice(0, 90).toString('utf8').replace(/\s+/g, ' ') + '）');
      continue;
    }
    log('中继取回 ' + stripHost(url) + ' ← ' + rel.id + '（' + r.buf.length + 'B）');
    return { res: r };
  }
  return { err: errs.slice(0, 3).join('；') };
}

/* ------------------------------ 路由记忆 ------------------------------ */
function planOf(host) {
  const p = hostPlan.get(host);
  return (p && Date.now() - p.at < p.ttl) ? p.mode : '';
}
function setPlan(host, mode) {
  if (host) hostPlan.set(host, { mode: mode, at: Date.now(), ttl: PLAN_TTL });
}
const errMsg = e => (e && (e.code || e.message)) || String(e);

/** 出口的一句话说明（前端 filters.js 直接显示这串，所以是**字符串**） */
function egressText() {
  if (egress.live) return '经本地代理 ' + egress.live;
  if (envProxyUrl()) return '直连（启动时的代理 ' + envProxyUrl() + ' 现在不可用，已自动改走直连）';
  return '直连（未检测到可用本地代理；被墙的站会走 DoH 钉 IP 或境内中继）';
}

/** 各主机记住的通路（/api/ping 与 /api/diag 都带上，排查时一眼看出谁在靠哪一层） */
function planSummary() {
  const out = {};
  hostPlan.forEach((v, k) => {
    if (Date.now() - v.at < v.ttl) out[k] = v.mode;
  });
  return out;
}

/* ------------------------- 出口自检（/api/diag 与 /api/warm 共用） -------------------------
   出口自检：网关现在到底能打到哪些站（决定哪些源能用），并且**说清楚靠哪一层打通的**：
       env   = 原路（全局 fetch，有 VPN 时就是这条）
       doh   = 直连强化（DoH 多解析器并取 + 带 SNI 验真 + 钉 IP）
       relay = 中继（境内可达的 Cloudflare 中继代取，不需要 VPN）
   键名与前端的信息源 id 对齐，页面可以直接拿它修正「站点不可达」的误判。 */
const DIAG_CACHE_MS = 60e3;    /* 自检结论进程内缓存：/api/diag 与 /api/warm 共用一个格子 */
const WARM_CACHE_MS = 90e3;
/* ★r18★ 预热的每一个数字都是实测调出来的（第一次实现整段跑了 31.2 秒，
   正好变成用户要消灭的「等一会」）：diag 段 4s、钉 IP 2.6s、上游巡检 3.5s 三段并行，
   整段再套 8s 保险丝。Preheat 只做「把路问通」，不需要每个目标都给出终局结论。 */
const WARM_PROBE_MS = 5000;    /* 预热时每个目标只给 5 秒（弹窗要的是「马上就好」；实测 wnacg 首页 ~5s） */
const WARM_HARD_MS = 6000;     /* diag 段的保险丝 */
const WARM_PIN_MS = 3500;      /* 图片主机钉 IP 段（并行；与 diag 段抢带宽，给足余量） */
const WARM_UP_MS = 3500;       /* 上游巡检段（拷贝漫画列表接口，实测慢起来 12s） */
const WARM_TOTAL_MS = 9000;    /* 整段预热的最后保险丝 */
let diagCache = { at: 0, data: null };

/* 预热要钉的图片/接口主机：都是实测存在的（tools/round17-*.md 取证、assets/js/sources.js 的封面地址）。
   只做「系统 DNS + DoH 并取 + 带 SNI 的 TLS 验真」，不取任何内容 —— 代价 ≈ 一次握手。 */
const WARM_PIN_HOSTS = [
  'api.mangadex.org', 'uploads.mangadex.org', 'e-hentai.org', 'www.wnacg.com', 'api.copy2000.online'
];

/* ------------------------- 失败也要记一笔（负缓存，r18 需求②） -------------------------
   「时好时坏」的用户感受有一半来自这里：**失败不被记忆** —— 同一个词每按一次回车，
   整条通路都要重跑一遍（拷贝漫画实测 3–7 秒、porn-comic 更长），运气好出结果、
   运气不好再等一轮，看上去就是随机的。现在失败（含上游「静默空结果」）也进一个**短**缓存：
   这段时间里同一个查询毫秒级返回同一条失败原因（并写明还剩多少秒），
   既不再烧上游配额，也不会让用户以为「卡住了」。
   刻意**只给拷贝漫画 / porn-comic 用**：E-Hentai 与紳士漫畫自己有更精确的断路器
   （ehBanUntil 倒计时 / 镜像冷却），再套一层负缓存反而会把「还有 12 秒解封」这类
   准确文案盖掉。 */
const SW_FAIL_MS = 45e3;
const swFail = new Map();          // 'src|query' -> { at, err, upstreamEmpty }
function swKey(src, q) { return String(src) + '|' + String(q || '').toLowerCase(); }
function swFailGet(src, q) {
  const hit = swFail.get(swKey(src, q));
  if (!hit) return null;
  if (Date.now() - hit.at > SW_FAIL_MS) { swFail.delete(swKey(src, q)); return null; }
  return hit;
}
function swFailSet(src, q, err) {
  if (swFail.size > 200) { const k = swFail.keys().next().value; swFail.delete(k); }
  swFail.set(swKey(src, q), {
    at: Date.now(), err: String((err && err.message) || err || '').slice(0, 400),
    upstreamEmpty: (err && err.upstreamEmpty) ? 1 : 0
  });
}
function swFailClear(src, q) { swFail.delete(swKey(src, q)); }
function swFailBody(source, hit) {
  const left = Math.max(1, Math.ceil((SW_FAIL_MS - (Date.now() - hit.at)) / 1000));
  return {
    ok: false, source: source, items: [], failCached: true,
    upstreamEmpty: hit.upstreamEmpty || undefined,
    error: hit.err + '（这条查询刚刚失败过，' + left + ' 秒内直接复用同一结论、不再重跑 —— ' +
      '可以换个关键词，或稍后再试）'
  };
}

/* ★拷贝漫画的「时好时坏」有一半是上游的★（tools/round17-source-degradation-and-pixiv.md 取证）：
   三个官方节点对**任何**查询（连不带关键词的 /comics 列表接口）都回 HTTP 200 + 空列表。
   预热时顺手打一次列表接口，把这个事实告诉前端 —— 横幅才不会把「上游故障」说成「你没连上网」。 */
async function warmUpstreamCheck() {
  const out = {};
  try {
    const t0 = Date.now();
    const r = await outFetch('https://api.copy2000.online/api/v3/comics?limit=5&offset=0&platform=3',
      { timeout: 6000, headers: { accept: 'application/json, text/plain, */*' } });
    let listEmpty = false, total = null;
    try {
      const j = JSON.parse(r.buf.toString('utf8'));
      const rs = (j && j.results) || {};
      total = typeof rs.total === 'number' ? rs.total : null;
      listEmpty = !(rs.list && rs.list.length);
    } catch (e) { /* 不是 JSON 就当没结论 */ }
    out.copymanga = { ok: r.status === 200, status: r.status, ms: Date.now() - t0, listEmpty, total };
  } catch (e) {
    out.copymanga = { ok: false, error: (e && e.message) || String(e) };
  }
  return out;
}

async function diagProbe(timeoutMs) {
  const jmHost = state.jmHost || JM_FALLBACK_HOSTS[0];
  const eg = await probeEgress();
  const urls = {
    mangadex: 'https://api.mangadex.org/ping',
    nhentai: 'https://nhentai.net/api/v2/search?query=test',
    ehentai: 'https://e-hentai.org/',
    /* ★r18★ wnacg 换成 02.cc 做自检：真机实测 www.wnacg.com 首页要 4900–7200ms，
       4–5 秒的自检预算下常常只等到硬超时，于是网关明明能取（第 17 轮已证）却被标成
       「连网关也打不通」—— 横幅误报的另一个来源。02.cc 同一个站群、1511ms 就有应答。 */
    wnacg: 'https://www.wnacg02.cc/',
    hitomi: 'https://hitomi.la/',
    kemono: 'https://kemono.cr/',
    danbooru: 'https://danbooru.donmai.us/posts.json?limit=1',
    pixiv: 'https://www.pixiv.net/',
    copymanga: 'https://api.copy2000.online/api/v3/system/network2?platform=3',
    jmcomic: 'https://' + jmHost + '/'
  };
  const out = {};
  await Promise.all(Object.keys(urls).map(async k => {
    const t0 = Date.now();
    /* ★r18★ 自检也要有**真**死线：outFetch 的 timeout 是逐层的（原路 → DoH 钉 IP → 中继），
       传 6000 不等于 6 秒内有结论 —— 实测 /api/warm 第一次实现因此跑了 31.2 秒，
       而那正好是用户要消灭的「等一会」。这里每个目标再套一层硬超时，
       超时的标 unknown（**不能**当成「连网关也打不通」，否则又是误报）。 */
    const hard = k === 'ehentai' && ehBanUntil > Date.now();
    if (hard) {
      out[k] = {
        ok: false, banned: true, unknown: false, ms: 0, status: 0,
        error: 'E-Hentai 按出口 IP 限流封禁中，还有 ' + Math.ceil((ehBanUntil - Date.now()) / 1000) +
          ' 秒 —— 这段时间不再重试（第 17 轮取证：封禁正是重试刷出来的）'
      };
      return;
    }
    try {
      const r = await withHardTimeout(outFetch(urls[k], { timeout: timeoutMs }),
        timeoutMs + 900, k + ' 自检');
      /* ★别只看状态码★：e-hentai 的限流封禁、cors.eu.org 的假 200 都是
         「HTTP 200 + 一小段错误正文」，只判 status < 500 会把它们算成健康 ——
         页面于是显示「可达」，用户去搜却全空（真机实测被骗过一轮，见 isTrapBody 注释）。 */
      const trap = isTrapBody(r.buf);
      const txt = r.buf ? r.buf.slice(0, 5000).toString('utf8') : '';
      /* ★r18 需求②★ 自检撞上限流封禁时，要把窗口**记下来**（与搜索路径的 ehHtml 同一套
         ehBanUntil）：自检每次开机、每次点「检测」都会 GET 一次 e-hentai，如果封禁期间
         继续打，就会像第 17 轮取证的那样把 5 分钟窗口一次次刷新 —— 越自检越连不上。
         记录之后，下一次自检/预热会直接跳过它（见上面的 hard 分支），静默期才真的存在。 */
      const eban = /temporarily banned|Your IP address has been|excessive request rate/i.test(txt);
      if (k === 'ehentai' && eban) {
        /* 封禁页有时只有 240B、把「This ban expires in …」截掉了（真机实测）——
           那就按 10 分钟静默兜底：读不到解除时间时，宁可多静默，也不要一秒一次把窗口刷新。 */
        const left = ehBanLeftMs(txt);
        ehBanUntil = Date.now() + (left ? left + 3000 : 600e3);
        ehBanEgress = egress.live || '';   /* ★r18★ 与 ehHtml 同一套记忆：自检学到的封禁也绑出口 */
        log('自检撞上 E-Hentai 限流封禁：' +
          (left ? Math.round(left / 1000) + ' 秒' : '未写明解除时间，按 10 分钟静默') + '内不再重试');
      }
      out[k] = {
        ok: r.status < 500 && !trap, status: r.status, ms: Date.now() - t0,
        via: planOf(stripHost(urls[k])) || '?',
        ...(eban ? { banned: true } : {}),
        ...(trap ? { trap: true, why: 'HTTP ' + r.status + ' 但不是内容（' + r.buf.length +
          'B）：' + r.buf.slice(0, 90).toString('utf8').replace(/\s+/g, ' ') } : {})
      };
    } catch (e) {
      const msg = (e && e.message) || String(e);
      out[k] = {
        ok: false, error: msg, ms: Date.now() - t0,
        /* 「硬超时」= 我们没等到结论，不等于目标不可达 —— 预热路径要把它标出来，
           免得把一次超时当成「这个源连网关也打不通」写进横幅。 */
        unknown: /硬超时/.test(msg) || undefined,
        tiers: (e && e.tiers) || undefined
      };
    }
    /* ★r18 需求②④★ 「直连被 Cloudflare 拦」不等于「这个源不能用」★
       danbooru.donmai.us 前置 CF，直连/中继拿到的都是 403 拦截页（这个站就是这样），
       而它的检索本来就走 tbib / xbooru 镜像（见 danbooruMirrorFetch）。旧自检只打直连
       ⇒ 每次开机 ~16 秒后横幅都会弹一条「Danbooru 连网关也打不通」，而同一时刻网关
       日志是「danbooru 镜像兜底：tbib ← tags=… → 8 条」（真机取证：横幅清单里就一条
       「Danbooru 连接失败（11ms）」，用户去搜却明明有结果）。这里补一次**有界**的镜像
       自检：镜像有应答就如实报「可用（走镜像）」，别再让人以为自己这边断了。 */
    if (k === 'danbooru' && out[k] && !out[k].ok) {
      const tm0 = Date.now();
      try {
        const m = await withHardTimeout(danbooruMirrorFetch({ tags: 'solo', limit: 1, page: 1 }),
          Math.max(2500, Math.min(timeoutMs, 5000)), 'Danbooru 镜像自检');
        const mvia = (m && m.via) || '?';
        out[k] = {
          ok: true, status: 200, ms: Date.now() - tm0, via: 'mirror:' + mvia, mirror: true,
          note: '直连 danbooru.donmai.us 被 Cloudflare 拦（这个站的常态），镜像 ' + mvia +
            ' 有应答 ⇒ 检索可用'
        };
      } catch (e2) {
        out[k].mirrorError = (e2 && e2.message) || String(e2);
      }
    }
  }));
  return {
    egress: egressText(),
    egressDetail: {
      startup: process.env.HS_GW_PROXIED === '1',
      startupProxy: envProxyUrl(),
      liveProxy: eg.live,
      hostPlan: planSummary()
    },
    targets: out
  };
}

/* ------------------------------ 统一出站入口 ------------------------------
   契约与改造前逐字一致：{ status, ok, headers(.get), buf, text(), json() }
   只是**在失败之后**才多出两层补偿 —— 有 VPN 且原路通时，下面第二三层一行都不执行。

   首次遇到一台主机时，①原路 与 ②直连强化 **并行竞速**（先成功的算数，另一条丢弃）：
   否则「系统 DNS 被污染」的主机会先让 ① 干等到超时，把 ② 的预算吃光，
   结果本该 2 秒打通的站被推去走限流的中继（实测 hitomi 就是这样从 doh 掉到 relay 的）。
   带签名头的接口（禁漫 / 拷贝漫画）**不参与竞速**：那两个站直连本来就通，
   多发一次带 token 的请求只会白吃上游风控。 */
function hasSignatureHeaders(headers) {
  return Object.keys(headers || {}).map(k => k.toLowerCase())
    .some(k => /token|signature|authorization|x-auth|umstring|cookie/.test(k));
}

async function outFetch(url, opts) {
  opts = opts || {};
  const ms = opts.timeout || 15000;
  const host = stripHost(url);
  const t0 = Date.now();
  /* ★真·死线★：整次出网调用共享 ms 这一个预算，所有腿都从同一个 t0 扣时间。
     旧实现是 Math.max(2500, ms - 已用)，即每条腿都有 2.5s 保底 —— 而腿是**串行**的
     （原路 → 直连强化 → 中继 → https 升级），于是 timeout:8000 实测能拖到 14–18 秒，
     上层按预算排好的超时全被击穿（这正是「E-Hentai 检索实测 p50 14.2s」的机制之一）。
     现在按真实剩余时间发腿（leg() 只保留 900ms 的最小可用时间，避免退化成 timeout:0）；
     到点之后的腿只允许这 900ms 的收尾，不再各自重置预算。 */
  const left = () => ms - (Date.now() - t0);
  const leg = max => Math.max(900, Math.min(max || ms, left()));
  let plan = opts.force === true ? '' : (planOf(host) || (RELAY_PREFERRED.has(host) ? 'relay' : ''));
  /* ★r18★ 中继对拷贝漫画 API 节点只会回空壳（见 RELAY_BAD_HOSTS 的取证）：
     ① 不承认历史记忆里那条 relay 通路（它就是这么被记上的），
     ② 下面彻底不把中继当候选 —— 否则空壳会冒充「0 条结果」，
        而且「先到先得」的竞速会让比直连更快到达的空壳把真结果挤掉。 */
  const noRelay = RELAY_BAD_HOSTS.has(host);
  if (noRelay && plan === 'relay') { plan = ''; setPlan(host, ''); }
  /* ★预置成 relay 的主机，在「没有任何中继能接这一发」时要**毫秒级如实失败**，别去白烧预算★
     （2026-09-23）RELAY_PREFERRED 的语义是「这台主机的原路与 DoH **实测恒失败**」，
     所以中继一断，剩下的路一条都不可能通。可原来的流程会掉进下面的
     「首次定通路」竞速：原路 + DoH 并行 → DoH 要给多解析器 × 多候选 IP 逐个做 TLS 验真，
     实测吃满整个预算（真机：`超过 6000ms 硬闸`，用户白等 6 秒拿到一句「网络层失败」）。
     典型触发场景正是**中继共享出口被 e-hentai 限流封禁**的时候 —— 也就是用户最需要
     快速得到「等一会儿」这句指引的时候，反而等了最久。

     ★判据必须「按这一发请求」算，不能只写 RELAYS.every(!relayUsable)★
     第一版就是这么写错的：表里的 `i0.wp` 是 **kind:'image'**（只代取图片，不代取页面），
     它常年不冷却，于是 `every` 永远为 false，快速失败一次都没生效
     （真机复核：连打两发仍是 6641ms / 3ms，而那 3ms 是 180s 断路器给的，不是这段）。
     现在按 relayFetchOnce 的**同一套准入规则**筛：能接这一发、且不在冷却里的中继才是候选。
     只要有候选就照常往下走；**一个候选都没有**才立刻失败。 */
  if (RELAY_PREFERRED.has(host)) {
    const wantImg = opts.image === true || looksLikeImage(url);
    const eligible = RELAYS.filter(r =>
      relayUsable(r.id) && !(r.kind === 'image' && !wantImg) && !(r.json && wantImg));
    if (RELAYS.length && !eligible.length) {
      /* 全部在冷却：报**还要等最久**的那条（最短的那个会误导用户以为马上就好） */
      const wait = Math.max.apply(null, RELAYS.map(r =>
        Math.max(0, Math.ceil(((relayState.get(r.id) || 0) - Date.now()) / 1000))));
      const e = new Error('中继全部在冷却中（最久还需 ' + wait + 's）：' +
        RELAY_PREFERRED.get(host) + '，而中继是这台主机唯一能通的通路 —— 再试也只是白烧预算');
      e.tiers = ['预置 relay：原路/DoH 实测恒失败，且没有可用的中继腿（' +
        RELAYS.map(r => r.id + (relayUsable(r.id) ? '(可用)' : '(冷却)')).join(' ') + '）'];
      throw e;
    }
  }
  const method = String(opts.method || 'GET').toUpperCase();
  const canRace = opts.race !== false && method === 'GET' && !opts.body && !hasSignatureHeaders(opts.headers);
  const errs = [];

  /* opts.relayOnly：调用方明说「就走中继」。
     用途是「同一个站换个出口 IP 再试一次」—— 例如 E-Hentai 的搜索侧按出口 IP 限制，
     当前出口返回空集，中继是另一个出口，重试一次常常就有真结果（实测 0 条 → 25 条）。
     这种主动调用不该给主机记通路（否则会把正常请求也带偏）。 */
  if (opts.relayOnly) {
    const r = await relayFetch(url, Object.assign({}, opts, { timeout: ms }));
    r.via = 'relay';
    return r;
  }

  /* 给响应盖上「这一发是哪条腿给的」的戳：出问题时（尤其**空响应**）能一眼看出是谁的锅 —— 
     AllOrigins 的 raw 端点在它自己抓不到时也会回 HTTP 200 + 0 字节，
     没有这个戳就只能靠猜。 */
  const mark = (r, via) => { if (r && typeof r === 'object') r.via = via; return r; };

  /* ★200 + 空正文 = 失败★（实测踩到过，很隐蔽）
     E-Hentai 的 Varnish 在**限流/反爬软封锁**时会回一个
     「HTTP 200 + content-type: text/html + content-length: 0」的空壳。
     不拦的话它会被当成**成功**一路返回：上层看到的是「搜索 0 条」「页面没匹配到作品」，
     而不是「没取到」—— 错误被静默吞掉（这正是「E-Hentai 老是说搜不到」的一半原因）。
     所以这里对 GET 的 200 空正文一律当失败，并**顺手把这台主机拉进 60 秒空壳冷却**：
     软封锁期间继续硬撞只会让封锁更久，冷却期内直接改走中继（另一个出口 IP）更划算。 */
  const guardEmpty = (r, via) => {
    if (r && r.status === 200 && r.buf && r.buf.length === 0 && opts.allowEmpty !== true &&
        String(opts.method || 'GET').toUpperCase() === 'GET') {
      emptyShellUntil.set(host, Date.now() + EMPTY_SHELL_COOLDOWN);
      throw new Error('上游回了 200 但正文是空的（via=' + via + '）');
    }
    return r;
  };

  /* 空壳冷却期内：跳过原路与直连强化，直接用中继换出口 IP。
     ★r18★ 拷贝漫画的节点除外：它们的中继出口只会回空壳，跳过去等于自投罗网。 */
  const shellCooling = !opts.relayOnly && !noRelay && (emptyShellUntil.get(host) || 0) > Date.now();

  /* ① 原路：全局 fetch（启动时若探测到代理，undici 会自己走它）—— 有 VPN 时就是这条路 */
  const tierEnv = async () => {
    const tk = withTimeout(leg());
    try {
      const res = await fetch(url, {
        method: opts.method || 'GET',
        headers: Object.assign({ 'user-agent': opts.ua || UA_CHROME, accept: '*/*' }, opts.headers || {}),
        body: opts.body,
        redirect: 'follow',
        signal: tk.signal
      });
      const buf = Buffer.from(await res.arrayBuffer());
      return guardEmpty(mark({
        status: res.status,
        ok: res.ok,
        headers: res.headers,
        buf,
        text: () => buf.toString('utf8'),
        json: () => JSON.parse(buf.toString('utf8'))
      }, 'env'), 'env');
    } finally { tk.done(); }
  };

  /* ② 直连强化：钉一个验真过的 IP，用 node:https 直连 */
  const tierDoh = async () => {
    const eg = await probeEgress().catch(() => egress);
    /* 运行期发现可用代理、而原路不是它 → 先用代理隧道试（「开着网关再开 VPN」的情形） */
    if (eg.live && eg.live !== envProxyUrl()) {
      return guardEmpty(mark(await hsRequest(url, {
        method: opts.method, headers: opts.headers, body: opts.body, ua: opts.ua,
        timeout: leg(), agent: tunnelAgentFor(eg.live)
      }), 'doh'), 'doh');
    }
    const pin = await pinHost(host, leg(5000));
    if (!pin) throw new Error('DoH 没给出能验真的 IP');
    return guardEmpty(mark(await hsRequest(url, {
      method: opts.method, headers: opts.headers, body: opts.body, ua: opts.ua, timeout: leg()
    }), 'doh'), 'doh');
  };

  /* ③ 中继：真被墙（SNI 阻断 / 整段不可达）时的最后一条腿 */
  const tierRelay = async () => guardEmpty(mark(await relayFetch(url, Object.assign({}, opts, { timeout: leg() })), 'relay'), 'relay');

  /* 原路是「经代理」却失败 → 立刻重判出口，别让它继续粘死 */
  const onEnvFail = async e => {
    errs.push('原路：' + errMsg(e));
    if (process.env.HS_GW_PROXIED === '1' || envProxyUrl()) {
      egress.checkedAt = 0;
      await probeEgress().catch(() => {});
    }
  };

  let envTried = false;
  let dohTried = false;

  if (shellCooling) {
    /* 刚被空壳拒过：这段时间里直连基本没戏（软封锁通常按出口 IP 计），
       直接交给中继，省掉两次注定失败的往返。 */
    errs.push('原路/直连强化：刚被空壳拒过，冷却中');
    envTried = true; dohTried = true;
  } else if (plan === 'env') {
    try { return await tierEnv(); } catch (e) { await onEnvFail(e); envTried = true; }
  } else if (plan === 'doh') {
    try { return await tierDoh(); } catch (e) { errs.push('直连强化：' + errMsg(e)); setPlan(host, ''); dohTried = true; }
  } else if (plan === 'relay') {
    /* 记了 relay 也包含 RELAY_PREFERRED 预置的那批：它们的原路/DoH **实测恒失败**
       （e-hentai 的 DoH 腿要烧 5.4s 做多候选 TLS 验真，全部 ECONNRESET），
       所以这里失败后**不再回头补跑那两条**，直接把原因带到中继腿去。
       dohTried=true 就是「原路/直连都别再试了」的那个闸。 */
    try { return await tierRelay(); } catch (e) { errs.push('中继：' + errMsg(e)); setPlan(host, ''); dohTried = true; envTried = true; }
  }

  /* 没有记忆（或记忆里那条不通了）：第一次给这台主机定通路 */
  if (!dohTried && opts.doh !== false) {
    /* ★RELAY_PREFERRED 的主机：第一次也**直接走中继**，不要跑竞速★（2026-09-23 补）
       上面 `plan === 'relay'` 那一支只在「已经有记忆」时生效；而 hostPlan 是**进程内存**，
       所以每次**冷启动后的第一次**请求仍然是 `!plan`，会掉进下面的 env/DoH 竞速 ——
       DoH 那腿要给多解析器 × 多候选 IP 逐个做 TLS 验真，对 e-hentai 是 100% 白烧，
       实测把首搜拖到 **6646ms**（`超过 6000ms 硬闸`）。
       这与「预置 relay」的初衷矛盾：预置的全部意义就是**别在死腿上花时间**。
       这里把它补齐：预置表里的主机第一次就只走中继。
       ★只跳过 env/DoH，中继腿本身照旧★ —— 中继挂了就在毫秒级如实失败，
       不会像以前那样白等 6 秒才说「网络层失败」。 */
    const preferRelay = RELAY_PREFERRED.has(host);
    if (preferRelay) {
      dohTried = true; envTried = true;
      errs.push('预置 relay：跳过原路/DoH（实测恒失败，跳过省下 ~5.4s）');
    } else if (!plan && !envTried && canRace) {
      /* 两条都成功时**以先到的为准**，并且只给赢的那条记通路 ——
         否则后到的那条会把 plan 覆盖掉（上一版实测：mangadex 明明原路就通，却被记成 doh） */
      const envP = tierEnv().then(r => ({ tier: 'env', r: r }),
        e => onEnvFail(e).then(() => Promise.reject(e)));
      const dohP = tierDoh().then(r => ({ tier: 'doh', r: r }),
        e => { errs.push('直连强化：' + errMsg(e)); return Promise.reject(e); });
      envP.catch(() => {}); dohP.catch(() => {});          /* 输掉的那条别变成未处理异常 */
      try {
        const w = await Promise.any([envP, dohP]);
        setPlan(host, w.tier);
        return w.r;
      } catch (e) {
        /* 两条都挂了：errs 里已有原因，落到中继 */
      }
    } else {
      if (!envTried && !plan) {
        try { return await tierEnv(); } catch (e) { await onEnvFail(e); }
      }
      try { return await tierDoh(); } catch (e) { errs.push('直连强化：' + errMsg(e)); }
    }
  }

  if (noRelay) {
    errs.push('中继：已跳过（中继对拷贝漫画 API 节点只会回空壳 total=0，会把「取不到」伪装成「0 条结果」）');
  }
  if (opts.relay !== false && !noRelay) {
    try {
      const r = await tierRelay();
      setPlan(host, 'relay');
      return r;
    } catch (e) { errs.push('中继：' + errMsg(e)); }
  }

  /* ④ http → https 升级重试（实测结论，必须留着）：
     绅士漫画的正文图给的是 `http://img5.qy0.ru/…?verify=…`，而**同一个地址**换成 https 就
     正常返回 200 image/jpeg —— 明文 HTTP 的 Host 头会被拦成 ECONNRESET。
     这条不是「兜底猜一下」：同一 URL 两种协议实测一个 200 一个 ECONNRESET，所以值得多花一次往返。 */
  if (/^http:\/\//i.test(url) && !opts.schemeTried) {
    try {
      const r = await outFetch(url.replace(/^http:/i, 'https:'),
        Object.assign({}, opts, { schemeTried: true }));
      log('http 被重置、https 正常，已改用 https：' + stripHost(url));
      return r;
    } catch (e) { errs.push('https 升级：' + errMsg(e)); }
  }

  const err = new Error('取不到 ' + host + '：' + (errs.length ? errs.join('；') : '所有通路都失败'));
  err.tiers = errs;
  log('三层都没打通 ' + host + '：' + (errs.join('；') || '（无原因记录）'));
  throw err;
}

/* ==========================================================================
   禁漫天堂（18comic / JMComic）—— 官方 APP API
   参考实现：ComicSparks/comics_modules 的 jasmine.js、venera-configs 的 jm.js
     token      = md5(timestamp + "18comicAPPContent")
     tokenparam = "<timestamp>,<appVersion>"
     响应 data  = AES-256-ECB(base64)，密钥 = md5(timestamp + "185Hcomic3PAPP7R")
   ========================================================================== */
const JM_APP_SECRET = '18comicAPPContent';
const JM_DATA_SECRET = '185Hcomic3PAPP7R';
const JM_APP_VERSION = '2.0.16';
const JM_FALLBACK_HOSTS = [
  'www.cdnbea.net', 'www.cdnhth.net', 'www.cdngwc.cc', 'www.cdnhth.club',
  'www.cdnplaystation6.vip', 'www.cdntwice.org', 'www.cdnsha.org',
  'www.cdnaspa.cc', 'www.cdnntr.cc'
];
/* 远程域名列表：venera 用的口径（base64 → AES-ECB → JSON.Server[]） */
const JM_DOMAIN_URL = 'https://rup4a04-c02.tos-cn-hongkong.bytepluses.com/newsvr-2025.txt';
const JM_DOMAIN_SECRETS = ['diosfjckwpqpdfjkvnqQjsik', 'diosfjckwpqpdfvnqQjsik'];

async function jmRemoteHosts() {
  if (state.jmDomains && Date.now() - state.jmDomainsAt < 6 * 3600e3) return state.jmDomains;
  const r = await outFetch(JM_DOMAIN_URL, { timeout: 8000 });
  const buf = b64(r.text().trim());
  for (const secret of JM_DOMAIN_SECRETS) {
    try {
      const txt = aesEcbDecrypt(buf, md5(secret)).toString('utf8');
      const j = sliceJson(txt);
      const arr = j.Server || j.server || j.hosts || [];
      const hosts = arr.map(stripHost).filter(Boolean);
      if (hosts.length) {
        state.jmDomains = hosts; state.jmDomainsAt = Date.now();
        log('禁漫远程域名：' + hosts.join(', '));
        return hosts;
      }
    } catch (e) { /* 换下一个密钥 */ }
  }
  throw new Error('远程域名列表解密失败');
}

async function jmHostsList(extra) {
  const list = [];
  const push = h => { h = stripHost(h); if (h && list.indexOf(h) < 0) list.push(h); };
  if (state.jmHost && Date.now() - state.jmHostAt < 10 * 60e3) push(state.jmHost);
  String(extra || '').split(/[\s,;，、]+/).forEach(push);
  try { (await jmRemoteHosts()).forEach(push); } catch (e) { /* 用兜底 */ }
  JM_FALLBACK_HOSTS.forEach(push);
  return list;
}

/* 候选主机里挑一个能用的：**分批竞速 + 失败冷却**。
   旧实现是 `for (host of hosts.slice(0, 6))` 顺序试 —— 远程域名列表一变长，
   排在第 7 位之后的兜底域名（www.cdnbea.net 这类实测直连可用的）就永远轮不到，
   表现正是「有 VPN 好好的，没 VPN 全废」。 */
const hostDead = new Map();          // host -> 冷却截止时间
const HOST_DEAD_MS = 90e3;

/** 硬超时：到点就 reject，不管里面那一层还有多少事没做完。
    为什么需要它：outFetch 的 timeout 是**逐层**的（原路 → DoH 钉 IP → 中继），
    一层超时还会试下一层，所以「传 7000」并不等于「7 秒内一定有结论」——
    实测绅士某一轮就是因此把整条路径拖到 15.6s。
    竞速/探针这类「只要一个答案」的场景必须用硬超时把预算钉死，
    否则上面算好的 deadline 形同虚设。 */
function withHardTimeout(promise, ms, label) {
  let t = 0;
  const timer = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error((label || '请求') + ' 硬超时 ' + ms + 'ms')), Math.max(200, ms));
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

async function pickProbe(hosts, probe, opt) {
  const batch = (opt && opt.batch) || 3;
  /* opt.deadline：到这个时刻就**不再开新的批次**。
     没有它的时候，一批 3 个域名各 7s、下一批还能再等 7s，整条路径能拖到 14s 以上 ——
     这就是「绅士有时要等 19s」的来源（两次网关请求各拖一轮）。
     注意：已经发出去的批次会等它自然结束，不做硬中断（免得把半截结果丢掉）。 */
  const deadline = (opt && opt.deadline) || 0;
  const now = Date.now();
  const live = hosts.filter(h => (hostDead.get(h) || 0) < now);
  const list = live.length ? live : hosts;      // 全在冷却里就硬着头皮全试一遍
  const errs = [];
  for (let i = 0; i < list.length; i += batch) {
    if (deadline && Date.now() > deadline) break;
    /* eslint-disable no-await-in-loop */
    const slice = list.slice(i, i + batch).filter(h => h);
    if (!slice.length) continue;
    /* ★先到先得，不等同批的慢腿★（第 16 轮，2026-09-23）
       旧实现是 `await Promise.all(slice.map(…))` —— **整批一起等**：www.wnacg.com 实测
       298ms 就答上来了，却要陪同批的 www.wnacg.net（7.6s）、www.wnacg.org（14.9s）
       一起等到 7.4s 才返回。实测绅士冷启动 8 个词全部 5.2–7.5s，而冠军镜像只要 0.3s；
       7.4s 已经顶到前端整轮 cap（9500ms），偶发一次就吃掉全轮。
       现在任何一个 host 成功就立刻返回；同批剩下的腿在后台继续跑完（失败照样记
       hostDead / errs，不浪费），只是不再挡住结果。 */
    const got = await raceFirstOk(slice, probe, errs);
    if (got) return got;
  }
  const err = new Error('候选主机全不可用（' + list.length + ' 个）：' + errs.slice(0, 4).join('；'));
  err.all = errs;
  throw err;
}

/** 一批主机里**第一个成功**的即返回（不等慢腿）；全失败才等到最后一个 */
function raceFirstOk(slice, probe, errs) {
  return new Promise(resolve => {
    let pending = slice.length;
    let settled = false;
    const fail = (h, e) => {
      /* 连不上/返回不对 → 冷却，避免同一轮里反复撞。
         「返回 0 条」是**正常的空结果**（不是主机坏了），不记冷却。 */
      if (!/code 210|接口闸门|返回 0 条/.test((e && e.message) || '')) hostDead.set(h, Date.now() + HOST_DEAD_MS);
      errs.push(h + '：' + ((e && e.message) || e));
      if (--pending === 0 && !settled) { settled = true; resolve(null); }
    };
    if (!slice.length) { resolve(null); return; }
    slice.forEach(h => {
      let p;
      try { p = probe(h); } catch (e) { fail(h, e); return; }
      Promise.resolve(p).then(
        val => { if (!settled) { settled = true; resolve({ host: h, val: val }); } },
        e => fail(h, e));
    });
  });
}

/** 找一个能用的禁漫 APP 域名 */
async function jmResolveHost(extra) {
  const hosts = await jmHostsList(extra);
  const pick = await pickProbe(hosts,
    h => jmApi(h, '/setting?app_img_shunt=1&express=', { timeout: 6000 }),
    { batch: 3, deadline: Date.now() + 9000 });
  const data = pick.val;
  const img = data && (data.img_host || (data.setting && data.setting.img_host));
  if (img) { state.jmCdn = String(img).replace(/\/+$/, ''); state.jmCdnAt = Date.now(); }
  state.jmHost = pick.host; state.jmHostAt = Date.now();
  return pick.host;
}

/* ★记住的域名直接用，不再每次搜索都重新探测★
   旧实现：jmSearch → jmResolveHost → 每次都跑一遍 pickProbe（批量 3 个域名 × 6s）。
   域名一多、只要前几个在冷却里，就要跑好几批 —— 实测「触手」这一个词要 20.3s，
   而其中绝大部分时间花在**探测**上，不是花在搜索上。
   现在：5 分钟内记住的域名直接用（省掉整轮探测，一次搜索只剩 1 个上游请求）；
   只有超过 5 分钟、或这次请求失败了，才重新探测。 */
const JM_HOST_TTL = 5 * 60e3;
async function jmPickHost(extra) {
  const fresh = state.jmHost && (Date.now() - (state.jmHostAt || 0) < JM_HOST_TTL);
  if (fresh && !extra) return state.jmHost;
  return jmResolveHost(extra);
}

/* 禁漫搜索：总预算 + 结果缓存（见 jmSearch 里的说明） */
const JM_BUDGET_MS = 11000;        /* 整段上限；前端给 16s，留足余量 */
const JM_SEARCH_CACHE_MS = 5 * 60e3;
const JM_SEARCH_CACHE_MAX = 80;
const jmSearchCache = new Map();
function jmSearchCacheGet(k) {
  const h = jmSearchCache.get(k);
  if (!h) return null;
  if (Date.now() - h.at > JM_SEARCH_CACHE_MS) { jmSearchCache.delete(k); return null; }
  return h.val;
}
function jmSearchCacheSet(k, v) {
  jmSearchCache.delete(k);
  jmSearchCache.set(k, { at: Date.now(), val: v });
  while (jmSearchCache.size > JM_SEARCH_CACHE_MAX) {
    const oldest = jmSearchCache.keys().next().value;
    if (oldest === undefined) break;
    jmSearchCache.delete(oldest);
  }
}

function jmHeaders(host, ts) {
  const h = {
    token: md5(ts + JM_APP_SECRET),
    tokenparam: ts + ',' + JM_APP_VERSION,
    'X-Requested-With': 'com.example.app',
    Origin: 'https://localhost',
    Referer: 'https://localhost/',
    accept: 'application/json',
    'accept-encoding': 'gzip, deflate',
    'user-agent': UA_CHROME
  };
  if (state.jmCookie) h.cookie = state.jmCookie;
  return h;
}

/** 调一次 APP API，返回解密后的 JSON */
async function jmApi(host, apiPath, opts) {
  const ts = nowSec();
  const r = await outFetch('https://' + host + apiPath, {
    headers: jmHeaders(host, ts),
    timeout: (opts && opts.timeout) || 9000
  });
  const sc = r.headers.get('set-cookie');
  if (sc) state.jmCookie = String(sc).split(';')[0];
  const text = r.text();
  if (/^\s*</.test(text)) throw new Error('返回的是网页而不是 API（这个域名不是 APP 接口域名）');
  let outer;
  try { outer = JSON.parse(text); } catch (e) { throw new Error('响应不是 JSON'); }
  if (outer && outer.code && outer.code !== 200 && outer.code !== '200') {
    throw new Error(outer.message || outer.msg || ('接口返回 code ' + outer.code));
  }
  const data = outer && (outer.data !== undefined ? outer.data : outer);
  if (typeof data === 'string') {
    const plain = aesEcbDecrypt(b64(data), md5(ts + JM_DATA_SECRET)).toString('utf8');
    return sliceJson(plain);
  }
  return data;
}

const asArray = v => Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
const jmCover = (raw, id, host) => {
  const s = String(raw || '').trim();
  if (/^https?:/i.test(s)) return s;
  if (!s && id) return state.jmCdn + '/media/albums/' + id + '_3x4.jpg';
  if (s.charAt(0) === '/') return state.jmCdn + s;
  return state.jmCdn + '/media/' + s;
};

function jmNormalizeItem(it, host, webHost) {
  const id = String(it.id != null ? it.id : (it.aid || it.album_id || ''));
  const cat = it.category || it.cat || {};
  const catTitle = typeof cat === 'string' ? cat : (cat.title || cat.name || '');
  const tags = asArray(it.tags).map(t => (typeof t === 'string' ? t : (t && (t.title || t.name)) || '')).filter(Boolean);
  const author = asArray(it.author).map(a => (typeof a === 'string' ? a : (a && a.name) || '')).filter(Boolean);
  const name = it.name || it.title || it.subtitle || '';
  const coverRaw = it.image || it.cover || it.thumb || it.thumb_url || '';
  return {
    id: id,
    title: String(name).replace(/\s+/g, ' ').trim(),
    cover: jmCover(coverRaw, id, host),
    url: 'https://' + (webHost || '18comic.vip') + '/album/' + id,
    artist: author.join(' / '),
    tags: tags.length ? tags : (catTitle ? [catTitle] : []),
    pages: parseInt(it.page_count || it.pages || 0, 10) || null,
    note: '官方 APP API · ' + host
  };
}

async function jmSearch(query) {
  const q = String(query.q || '').trim();
  const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
  const o = String(query.o || 'mr').replace(/[^a-z_]/gi, '') || 'mr';
  if (!q) throw new Error('缺少关键词 q');

  /* 结果缓存：同一关键词 5 分钟内不重复打上游（详情页 / 重搜 / 追加页会反复问到同一批串） */
  const ck = [q, page, o].join('|');
  const hit = jmSearchCacheGet(ck);
  if (hit) return Object.assign({}, hit, { cached: true });

  /* ★总预算★：整段（可能的探测 + 搜索）不超过 JM_BUDGET_MS。
     为什么要它：旧实现没有任何总预算，域名探测（批量 3 × 6s）+ 搜索（9s）
     串起来最坏能到 20s 以上 —— 实测「触手」20.3s。现在按剩余预算给每一步超时，
     预算耗尽就把已有的结论返回（宁可少试一个域名，也不许把整次检索拖死）。 */
  const t0 = Date.now();
  const left = () => JM_BUDGET_MS - (Date.now() - t0);

  let host = '';
  let probeErr = null;
  try { host = await jmPickHost(query.hosts); } catch (e) { probeErr = e; }
  const apiPath = '/search?search_query=' + encodeURIComponent(q).replace(/%20/g, '+') +
    '&page=' + page + '&o=' + o;

  let data = null, apiErr = null;
  if (host) {
    try {
      data = await jmApi(host, apiPath, { timeout: Math.max(3000, Math.min(9000, left() - 500)) });
    } catch (e) {
      apiErr = e;
      /* 记住的那个域名失效了（换域名 / 被打回网页）→ 清掉记忆、重探一次再试一把。
         只在还有预算时做，避免在慢链路上滚雪球。 */
      state.jmHost = ''; state.jmHostAt = 0;
      if (left() > 4000 && !query.hosts) {
        try {
          host = await jmResolveHost(query.hosts);
          data = await jmApi(host, apiPath, { timeout: Math.max(3000, Math.min(9000, left() - 500)) });
          apiErr = null;
        } catch (e2) { apiErr = e2; }
      }
    }
  }
  if (!data) {
    const e = apiErr || probeErr || new Error('禁漫没有可用域名');
    e.soft = 1;                       /* 「没取到」不是通路故障，交给调用方降级处理 */
    throw e;
  }
  if (query.raw) return data;
  const rows = asArray(data && (data.search || data.list || data.content || data));
  const items = rows.filter(x => x && typeof x === 'object')
    .map(x => jmNormalizeItem(x, host, query.web))
    .filter(x => x.id && x.title);
  const out = { source: 'jmcomic', host: host, total: (data && data.total) || items.length, items: items, ms: Date.now() - t0 };
  jmSearchCacheSet(ck, out);
  return out;
}

/* ==========================================================================
   哔咔 PicACG —— 官方 APP API（HMAC-SHA256 签名）
   参考实现：venera-configs 的 picacg.js、wgh136/PicaComic
     signature = HMAC_SHA256(key, lowercase(path + time + nonce + METHOD + apiKey))
   ========================================================================== */
const PICA_HOST = 'picaapi.picacomic.com';
const PICA_API_KEY = 'C69BAF41DA5ABD1FFEDC6D2FEA56B';
const PICA_SECRET = '~d}$Q7$eIni=V)9\\RK/P.RM4;9[7|@/CA}b~OW!3?EV`:<>M7pddUBL5n|0/*Cn';
const PICA_NONCE = 'b1ab87b4800d4d4590a11701b8551afa';

function picaSignature(pathWithQuery, method, time) {
  const raw = (pathWithQuery + time + PICA_NONCE + method + PICA_API_KEY).toLowerCase();
  return sha256hex(Buffer.from(PICA_SECRET, 'utf8'), raw);
}

function picaHeaders(pathWithQuery, method, token) {
  const time = String(nowSec());
  const h = {
    'api-key': PICA_API_KEY,
    accept: 'application/vnd.picacomic.com.v1+json',
    'app-channel': '3',
    'app-version': '2.2.1.3.3.4',
    'app-uuid': 'defaultUuid',
    'app-platform': 'android',
    'app-build-version': '45',
    version: 'v1.5.4',
    'image-quality': 'original',
    time: time,
    nonce: PICA_NONCE,
    signature: picaSignature(pathWithQuery, method, time),
    'user-agent': 'okhttp/3.8.1',
    'content-type': 'application/json; charset=UTF-8'
  };
  if (token) h.authorization = token;
  return h;
}

async function picaLogin(email, password) {
  const p = '/auth/sign-in';
  const r = await outFetch('https://' + PICA_HOST + p, {
    method: 'POST',
    headers: picaHeaders(p, 'POST', ''),
    body: JSON.stringify({ email: email, password: password }),
    timeout: 12000
  });
  const j = r.json();
  const token = j && j.data && j.data.token;
  if (!token) throw new Error((j && (j.message || j.error)) || ('登录失败 HTTP ' + r.status));
  state.picacgToken = token;
  state.picacgTokenAt = Date.now();
  return token;
}

async function picaToken() {
  if (state.picacgToken) return state.picacgToken;
  if (state.picacgEmail && state.picacgPassword) return picaLogin(state.picacgEmail, state.picacgPassword);
  return '';
}

async function picacgSearch(query) {
  const q = String(query.q || '').trim();
  const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
  const sort = String(query.sort || 'dd').replace(/[^a-z]/gi, '') || 'dd';
  if (!q) throw new Error('缺少关键词 q');
  const token = await picaToken();
  if (!token) {
    const e = new Error('哔咔需要登录：用 --picacg-email / --picacg-password 启动网关，或在 App 里抓一个 token 设为 PICACG_TOKEN');
    e.status = 401;
    throw e;
  }
  const p = '/comics/advanced-search?page=' + page;
  const r = await outFetch('https://' + PICA_HOST + p, {
    method: 'POST',
    headers: picaHeaders(p, 'POST', token),
    body: JSON.stringify({ keyword: q, sort: sort, categories: [] }),
    timeout: 15000
  });
  const j = r.json();
  if (j && j.code && j.code !== 200) throw new Error(j.message || ('接口返回 code ' + j.code));
  if (query.raw) return j;
  const docs = (((j || {}).data || {}).comics || {}).docs || [];
  const items = docs.map(d => {
    const thumb = d.thumb || {};
    const cover = (thumb.fileServer && thumb.path)
      ? String(thumb.fileServer).replace(/\/+$/, '') + '/static/' + thumb.path
      : '';
    const cats = asArray(d.categories).map(c => (typeof c === 'string' ? c : (c && c.title) || '')).filter(Boolean);
    const tags = asArray(d.tags).map(t => (typeof t === 'string' ? t : (t && t.title) || '')).filter(Boolean);
    return {
      id: String(d._id || d.id || ''),
      title: d.title || d.name || '',
      cover: cover,
      url: 'https://www.picacomic.com/comic/' + (d._id || d.id || ''),
      artist: d.author || '',
      tags: cats.concat(tags),
      pages: parseInt(d.pagesCount || 0, 10) || null,
      note: '官方 APP API · 已签名'
    };
  }).filter(x => x.id && x.title);
  return { source: 'picacg', host: PICA_HOST, total: items.length, items: items };
}

/* ==========================================================================
   拷贝漫画（copymanga）—— 官方 API（HMAC-SHA256 签名，密钥 base64）
   参考实现：venera-configs 的 copy_manga.js
   ========================================================================== */
const COPY_SECRET_B64 = 'M2FmMDg1OTAzMTEwMzJlZmUwNjYwNTUwYTA1NjNhNTM=';
const COPY_UMSTRING = 'b4c89ca4104ea9a97750314d791520ac';
const COPY_VERSION = '3.0.6';
/* 阅读器的章节清单：上游 limit 实测封顶 100（写 200/500/1000 直接 code 210），
   所以只能靠 offset 翻页；硬上限 500 章（haizeiwang 实测 398 章能全部取回）。 */
const COPY_CHAPTER_PAGE = 100;
const COPY_MAX_CHAPTERS = 500;

/* asHint=true：只把发现结果记到 state.copyApiHint 给**下一次**搜索当候选，
   绝不改写 state.copyApi（那是「上次真跑通」的节点，比一个还没验证的发现结果可信） */
async function copyApiBase(asHint) {
  if (!asHint && state.copyApi && Date.now() - state.copyApiAt < 3600e3) return state.copyApi;
  try {
    const r = await outFetch('https://api.copy-manga.com/api/v3/system/network2?platform=3', { timeout: 7000 });
    const j = r.json();
    const api = j && j.results && j.results.api;
    if (Array.isArray(api) && api[0] && api[0][0]) {
      const b = stripHost(api[0][0]);
      if (asHint) { state.copyApiHint = b; state.copyApiHintAt = Date.now(); }
      else { state.copyApi = b; state.copyApiAt = Date.now(); }
      return b;
    }
  } catch (e) { /* 用默认 */ }
  if (!asHint) { state.copyApi = 'api.copy2000.online'; state.copyApiAt = Date.now(); }
  return 'api.copy2000.online';
}

function copyHeaders() {
  const ts = String(nowSec());
  return {
    'x-auth-timestamp': ts,
    'x-auth-signature': sha256hex(b64(COPY_SECRET_B64), ts),
    umstring: COPY_UMSTRING,
    source: 'copyApp',
    platform: '3',
    version: COPY_VERSION,
    region: '1',
    accept: 'application/json',
    referer: 'com.copymanga.app-' + COPY_VERSION,
    'user-agent': 'COPY/' + COPY_VERSION
  };
}

/* 阅读器那几条接口（comic2 / group/…/chapters / chapter2）跟检索用的头**不一样**，
   而且实测非常挑（本机实测，出口同一个代理）：
     · 用检索那套头（region='1'，没有下面这几个）打这三条接口 → **稳定** code 210
       （上游原话：请到官网更新最新APP…等待1小时）
     · 补上 deviceinfo/device/pseudoid/dt 之后 → 连续多次 200
     · 但**再**带上 authorization: Token 时，一旦请求变密就又回 210；
       实测剔除实验：同样条件下「去 authorization」→ 200，其余每一种去法 → 210。
   所以这里准备两套头，按「轻 → 重」的顺序试：
     light = 检索头 + deviceinfo/device/pseudoid/dt（region '0'，**不带** authorization）
     heavy = light + authorization: Token
   **检索那条线一个字不动**，保持既有行为。 */
function copyReaderHeaders(heavy) {
  const ts = String(nowSec());
  const h = copyHeaders();
  h.region = '0';
  h.deviceinfo = '7381256V-4821';
  h.device = 'SM-G988N';
  h.pseudoid = uuidNoDash().slice(0, 16);
  h.dt = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
  if (heavy) h.authorization = 'Token';
  h['x-auth-timestamp'] = ts;
  h['x-auth-signature'] = sha256hex(b64(COPY_SECRET_B64), ts);
  return h;
}

/** 阅读器：带 in_mainland/request_id 的 GET（这几条接口不要 platform=3）
    并且串行 + 最小间隔 —— 实测连着打太快（第 6 次起）就开始回 code 210。 */
let copyNextAt = 0;
let copyChain = Promise.resolve();
const COPY_MIN_GAP = 1200;
function copyReaderGet(base, apiPath, heavy, timeout) {
  const run = copyChain.then(async () => {
    const gap = copyNextAt - Date.now();
    if (gap > 0) await sleep(gap);
    copyNextAt = Date.now() + COPY_MIN_GAP;
    return outFetch('https://' + base + apiPath, {
      timeout: timeout || 15000,
      headers: copyReaderHeaders(heavy)
    });
  });
  copyChain = run.then(() => {}, () => {});
  return run;
}

/** 拷贝漫画的 code 210 是**可重试**的反破解/限流闸（上游原话：请到官网更新最新APP…等待1小时）。
   实测结论：头在「轻/重」两套之间有一个非常窄的可用区间，而且打太快也会触发；
   所以这里「两套头 × 退避」地试，并且绝不把它当作致命错误。 */
async function copyReaderJson(base, apiPath, what) {
  const plan = [[false, 0], [true, 0], [false, 2500], [true, 6000], [false, 15000]];
  let lastMsg = '';
  for (let i = 0; i < plan.length; i++) {
    const heavy = plan[i][0], wait = plan[i][1];
    if (wait) await sleep(wait);
    let r;
    try { r = await copyReaderGet(base, apiPath, heavy); }
    catch (e) { lastMsg = '连不上 ' + base + '：' + ((e && e.message) || e); continue; }
    let j;
    try { j = r.json(); }
    catch (e) { lastMsg = base + ' 返回的不是 JSON（HTTP ' + r.status + '）'; continue; }
    if (j && j.code === 210) {
      lastMsg = '拷贝漫画的接口闸门（code 210）：' + (j.message || '请稍后重试');
      continue;
    }
    if (j && j.code && j.code !== 200) {
      lastMsg = (j.message || ('接口返回 code ' + j.code));
      continue;
    }
    return j;
  }
  throw new Error(what + ' 失败：' + (lastMsg || '未知原因'));
}

/** chapter2 返回的 contents 顺序是打乱的，按 words 还原成原站顺序 */
function copyChapterPages(chapter) {
  const urls = asArray(chapter && chapter.contents).map(c => (c && (c.url || c)) || '').filter(Boolean);
  const words = asArray(chapter && chapter.words);
  if (!urls.length) return [];
  if (words.length !== urls.length) return urls;      /* 没有 words 就不动顺序 */
  const out = new Array(urls.length);
  for (let i = 0; i < urls.length && i < words.length; i++) {
    const w = parseInt(words[i], 10);
    out[isFinite(w) && w >= 0 && w < urls.length ? w : i] = urls[i];
  }
  return out.filter(Boolean);
}

/* ★第 11 轮★：拷贝漫画的节点预算（原来只有一句 `timeout: 12000` 串行试，没有任何总预算）
   依据：稳定性压测 p50 = 17.3s、max 21.0s、30 轮里 20 轮 >10s，而前端聚合器的硬闸是
   assets/js/sources.js:2231 的 S.RUN_CAP_MS = 9500 —— 到点就把还没回来的源标成
   「超过 9.5s 未返回，已跳过」并**丢弃迟到结果**（sources.js:2362 `if (drop()) return null;`
   与 :2373-2386）。也就是说 17s 才拿到的那些结果，用户从来没看见过，
   只是白白占着网关、拖慢同一轮里其它源的响应。
   现在：先在「上次走通的那个节点」上单独试一小会儿，不行就把**所有节点并行竞速**
   （和绅士漫画 pickProbe 同一套路），外面再套一条 8500ms 硬闸，保证在前端放弃之前一定有答复。 */
/* ★r17 调参（真机实测）★ 旧值 6000/6500 的表现是「同一个节点，这次 3.3s 成功、
   下次被 6300ms 硬超时掐死」：.tmp/_r17-clean.js 三次检索里两次抛
   「拷贝漫画节点竞速 硬超时 6300ms」，而 .tmp/_r17-copy-raw.js 里同一个词 3304ms
   就拿到了真实结果（code 200 / total 125）。也就是说 6.3s 砍掉的是**本来会成功**的请求 ——
   私有中继（Cloudflare Pages）到 api.copy2000.online 的往返在 3.3s–7s 之间抖。
   ⇒ 竞速窗口 6000 → 7200，函数级硬闸 6500 → 7800。 */
const COPY_ATTEMPT_MS = 7200;      // 竞速阶段单节点超时（见下面「2500ms 会掐死能用的节点」）
/* 7800 = 前端单次 8200ms（assets/js/sources.js 里 copymangaSearch 的 run()）再减 400ms 余量，
   而 8200 又早于聚合器 9500ms 硬闸（S.RUN_CAP_MS）。三级闸门必须**严格递增**，
   否则前一级先抛「超时」，网关查出来的真实原因（哪个节点、什么错）就永远带不回来，
   用户只看到一个含糊的超时。 */
const COPY_HARD_MS = 7800;
/* 节点发现（/system/network2，copyApiBase 里 timeout: 7000）现在**完全在关键路径之外**：
   ★第 11 轮真机复测（tools/_copy-probe.js）★
     · 发现接口本身要 3548ms（另一次 3681/1985/2857ms）
     · 它返回的节点是 t66y.com，而这台机器上 t66y.com 打签名检索 **10697ms 后 fetch failed**
     · 真正能用的是内置兜底：api.copy-manga.com 2179ms / api.copy2000.online 3984ms（都返回真实结果）
   ⇒ 旧实现「先发现再竞速」= 先白烧 2~3.5s，再把剩下的时间给一堆节点、还给不够，
     能用的节点 3984ms 被 2543ms 的窗口掐死，于是 0 条。
   现在：发现结果只当作**下一次**搜索的候选（state.copyApiHint），从不挡当前这次搜索。 */
const COPY_DISCOVER_MS = 5000;
/* ★r17★「上游答了但是空」的宽限期（见 raceFirstPrefer）。
   ★r18 修正★ 第 17 轮把「所有节点、任何查询、连列表接口都空」记成「拷贝漫画自己的检索
   服务在静默空转」—— **那个结论是错的**：同一秒本机直连拿到 `total=2186 list=30`，
   而中继转发同一发请求是 `total=0`（见 RELAY_BAD_HOSTS 的取证）。空的来源是**通路**，
   不是上游。现在拷贝漫画的节点已经不走中继了，空只可能来自「某个节点对这个词真没货」，
   而真答案实测要 2.8–2.9s（直连）—— 所以宽限期从 1.5s 提到 3.0s：
   给慢一点但给真结果的节点留出机会，别让另一个节点的空包把它挤掉。 */
const COPY_EMPTY_GRACE_MS = 3000;

/* ★r17 结果缓存★ 拷贝漫画一次成功要 2.2–5s（三个官方节点只有私有中继能带签名头），
   而这个源在前端一轮检索里会被问**好几次**：阶梯换词（tryVariants）、
   补一路「整串当标题」（addTitleLane）、翻页重绘。每次都真去竞速，等于把
   3.3s–7s 的抖动反复赌一遍，还把出口 IP 往限流上推。
   缓存键与检索口径一致（q|page|limit），5 分钟，容量 60 条，raw 探测不写缓存。 */
const copySearchCache = new Map();
const COPY_CACHE_MS = 5 * 60e3;

/* 外套一条函数级硬闸（与 nhentai / porn-comic 同款）：内部无论哪一步慢，
   都在前端 9500ms 聚合闸之前如实给出答复 —— 成功或失败都算答复。 */
async function copymangaSearch(query) {
  const ck = [String(query.q || '').trim(), parseInt(query.page || '1', 10) || 1,
    parseInt(query.limit || '30', 10) || 30].join('|');
  if (!query.raw) {
    const hit = copySearchCache.get(ck);
    if (hit && Date.now() - hit.at < COPY_CACHE_MS) {
      log('拷贝漫画缓存命中：' + ck);
      return Object.assign({}, hit.pack, {
        cached: true, cachedAge: Date.now() - hit.at
      });
    }
  }
  let timer = null;
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('超过 ' + (COPY_HARD_MS + 200) +
      'ms 硬闸（拷贝漫画整条路超过预算）')), COPY_HARD_MS + 200);
  });
  try {
    const pack = await Promise.race([copymangaSearchInner(query), guard]);
    if (!query.raw && pack && pack.items && pack.items.length) {
      copySearchCache.set(ck, { at: Date.now(), pack: pack });
      if (copySearchCache.size > 60) copySearchCache.delete(copySearchCache.keys().next().value);
    }
    return pack;
  } catch (e) {
    /* 三个官方节点都必须由自建中继带签名头（公共 CORS 中继明确不支持），
       所以「全节点失败」几乎总是出口 IP 被目标按速率拒了 —— 这句要写进文案，
       否则用户只会去怀疑网关没启动。 */
    const err = new Error('拷贝漫画取数失败：' + ((e && e.message) || e) +
      (e && e.upstreamEmpty ? '' :
        '。三个官方节点都只能经自建中继签名访问，实测受出口 IP 限流影响很大：' +
        '等 1–2 分钟再搜一次通常就通了'));
    /* ★r17★：只有「节点不通/被限流」这类可重试的失败才标 soft（让前端 tryVariants
       换词再试）。上游静默空转是**上游的事**，换多少词都一样，再试只是白烧时间
       和出口配额 —— 硬失败立刻上报，前端也就不必把这一源挂到超时。 */
    if (!(e && e.upstreamEmpty)) err.soft = 1;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* 「第一个成功者胜」的竞速：与 pickProbe 的区别是**不等整批**。
   pickProbe 用 Promise.all 等一批全部落地才挑结果，所以只要批里有一个 10.7s 才失败的
   死节点，能用的那个 2.2s 的成功也要陪跑到底（拷贝漫画就是这么被拖死的）。
   这里谁先成功就用谁，最先成功者之前的所有失败只是噪声。 */
function raceFirst(hosts, probe) {
  return new Promise((resolve, reject) => {
    const list = (hosts || []).filter(Boolean);
    if (!list.length) return reject(new Error('没有候选节点'));
    let left = list.length;
    const errs = [];
    list.forEach(h => {
      Promise.resolve()
        .then(() => probe(h))
        .then(v => resolve(v), e => {
          const msg = (e && e.message) || String(e);
          if (!/code 210|接口闸门|返回 0 条/.test(msg)) hostDead.set(h, Date.now() + HOST_DEAD_MS);
          errs.push(h + '：' + msg);
          if (--left === 0) reject(new Error('候选节点全失败（' + list.length + ' 个）：' + errs.slice(0, 4).join('；')));
        });
    });
  });
}

/* ★r17★「优先非空」竞速：给拷贝漫画这种「上游静默空转」的目标用。
   raceFirst 只认「成功」，可这里的 probeFn 还会给出第三种答案 ——「答了，但空」：
   它不是失败（节点通、HTTP 200、JSON 也合法），也不是成功（没有结果）。
   旧实现把空直接 throw 成失败，于是三个节点一路陪跑到 7.5s 硬闸，用户看到的只有
   一句毫无信息量的「拷贝漫画节点竞速 硬超时 7500ms」，白白等 7.5 秒还查不出原因。
   规则：第一个**非空**答案立即胜；空答案先记住并起一个 graceMs 定时器，
   期间若没有节点给出非空结果，就用这份空包 settle（= 上游确实空）；
   只有「全部节点都失败」（既无空包也无成功）才 reject。 */
function raceFirstPrefer(hosts, probe, graceMs) {
  return new Promise((resolve, reject) => {
    const list = (hosts || []).filter(Boolean);
    if (!list.length) return reject(new Error('没有候选节点'));
    let left = list.length, emptyGot = null, graceTimer = null, done = false;
    const errs = [];
    const finish = v => {
      if (done) return;
      done = true;
      if (graceTimer) clearTimeout(graceTimer);
      resolve(v);
    };
    list.forEach(h => {
      Promise.resolve()
        .then(() => probe(h))
        .then(v => {
          if (v && v.empty) {
            if (!emptyGot) {
              emptyGot = v;
              graceTimer = setTimeout(() => finish(emptyGot), Math.max(0, graceMs || 0));
            }
            return;
          }
          finish(v);
        }, e => {
          const msg = (e && e.message) || String(e);
          if (!/code 210|接口闸门|返回 0 条/.test(msg)) hostDead.set(h, Date.now() + HOST_DEAD_MS);
          errs.push(h + '：' + msg);
          if (--left === 0) {
            if (done) return;
            if (emptyGot) return finish(emptyGot);
            done = true;
            if (graceTimer) clearTimeout(graceTimer);
            reject(new Error('候选节点全失败（' + list.length + ' 个）：' + errs.slice(0, 4).join('；')));
          }
        });
    });
  });
}

async function copymangaSearchInner(query) {
  const t0 = Date.now();             // ★从函数第一行动表
  const q = String(query.q || '').trim();
  const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
  const limit = Math.min(60, Math.max(10, parseInt(query.limit || '30', 10) || 30));
  if (!q) throw new Error('缺少关键词 q');

  /* 候选节点：上次真跑通的 → 上次发现到的（还没验证过）→ 内置兜底。
     全部**同时**发出去竞速，谁先成功用谁。 */
  const bases = [];
  const pushBase = b => { b = stripHost(b); if (b && bases.indexOf(b) < 0) bases.push(b); };
  if (state.copyApi && !(hostDead.get(state.copyApi) > Date.now())) pushBase(state.copyApi);
  if (state.copyApiHint && !(hostDead.get(state.copyApiHint) > Date.now())) pushBase(state.copyApiHint);
  ['api.copy2000.online', 'api.mangacopy.com', 'api.copy-manga.com'].forEach(pushBase);

  /* 发现节点：**不在关键路径上**。它的结果只留给下一次搜索（见常量区取证）。 */
  try {
    const d = copyApiBase(true);
    d.catch(() => {});
    withHardTimeout(d, COPY_DISCOVER_MS, '拷贝漫画节点发现').catch(() => {});
  } catch (e) { /* 纯背景动作，失败无所谓 */ }

  const apiPath = '/api/v3/search/comic?limit=' + limit + '&offset=' + ((page - 1) * limit) +
    '&q=' + encodeURIComponent(q) + '&q_type=&platform=3';
  const left0 = Math.max(1500, Math.min(COPY_ATTEMPT_MS, COPY_HARD_MS - (Date.now() - t0)));
  const probeFn = async (base, ms) => {
    const r = await outFetch('https://' + base + apiPath, { headers: copyHeaders(), timeout: ms });
    const j = r.json();
    if (query.raw) return { base: base, raw: j };
    if (j && j.code && j.code !== 200) throw new Error(j.message || ('接口返回 code ' + j.code));
    const res = (j && j.results) || {};
    const list = res.list || res.comics || [];
    const items = asArray(list).map(c => {
      const author = asArray(c.author).map(a => (typeof a === 'string' ? a : (a && a.name) || '')).filter(Boolean);
      const theme = asArray(c.theme).map(t => (typeof t === 'string' ? t : (t && t.name) || '')).filter(Boolean);
      return {
        id: String(c.uuid || c.id || c.path_word || ''),
        title: c.name || c.title || '',
        cover: c.cover || c.cover_url || '',
        url: 'https://www.copy20.com/comic/' + (c.path_word || c.id || ''),
        artist: author.join(' / '),
        tags: theme,
        pages: null,
        note: '官方 API · 已签名'
      };
    }).filter(x => x.id && x.title);
    /* ★r17★：空答案不是失败（见 raceFirstPrefer 的注释）。旧写法
       `throw new Error('返回 0 条')` 把「上游活着但静默空转」伪装成「节点不通」，
       于是竞速等满 7.5s 硬闸、用户只看到一句「硬超时」，真实原因永远带不回来。 */
    if (!items.length) {
      return { base: base, empty: true, pack: { source: 'copymanga', host: base,
        total: res.total || 0, items: [],
        note: '上游返回 0 条（HTTP 200 + 空列表）' } };
    }
    return { base: base, pack: { source: 'copymanga', host: base, total: res.total || items.length, items: items } };
  };

  let got = null;
  try {
    got = await withHardTimeout(raceFirstPrefer(bases, h => probeFn(h, left0), COPY_EMPTY_GRACE_MS),
      left0 + 300, '拷贝漫画节点竞速');
  } catch (e) {
    throw new Error('拷贝漫画所有 API 节点都失败：' + ((e && e.message) || e).slice(0, 400));
  }
  /* ★r18★「空」先重试一轮，别急着下结论★
     决定性取证（.tmp/_r18-copy-ip.js，同一个域名、同一个 IP、同一套签名头）：
       · 171.244.199.189 上同一发检索，一次回 `code=200 total=2186 list=30`（真数据），
         另一次回 `code=200 total=0 list=0`；耗时 0.4s → 11s 摇摆。
       · 而自建中继（CF 机房出口）对同一发请求**恒**回 total=0（连无关键词的列表接口也空）。
     也就是说「空」既可能来自上游自己的抽风，也可能来自通路 —— 无论哪种，
     立刻回一句「0 条 / 上游空转」都是把一个**可重试**的瞬间状态说成了结论。
     所以：只要预算还够，就用**另一轮**竞速再问一次；这一轮里真结果立刻胜出。 */
  if (got.empty) {
    const retryBudget = COPY_HARD_MS - 500 - (Date.now() - t0);
    if (retryBudget >= 1500) {
      const per = Math.max(1200, Math.min(COPY_ATTEMPT_MS, retryBudget));
      try {
        const got2 = await withHardTimeout(
          raceFirstPrefer(bases, h => probeFn(h, per), Math.min(COPY_EMPTY_GRACE_MS, retryBudget)),
          retryBudget + 300, '拷贝漫画节点竞速(空结果重试)');
        if (got2 && !got2.empty) {
          log('拷贝漫画：第一轮空、重试一轮拿到 ' + (got2.pack.items || []).length + ' 条（' + got2.base + '）');
          got = got2;
        } else if (got2 && got2.empty) {
          got = got2;                      /* 两轮都空 ⇒ 下面才做「上游 vs 这个词没货」的判定 */
        }
      } catch (e) { /* 重试全失败：保留第一轮的空包，继续走下面的判定 */ }
    }
  }
  /* ★r17★：上游"答了但空"要分两种，别一概而论：
     ① 上游检索服务在**静默空转** —— 连不带关键词的列表接口都是 0 条；
     ② 上游好好的，只是**这个词确实没货**（比如乱敲的词）。
     判据：用同一个节点打 `/api/v3/comics?limit=5&offset=0&platform=3`（无关键词）。
     实测上游故障期它也是 `{"code":200,...,"total":0}`，而正常期它是 5 条真数据 ——
     这条判据就是「空」这件事唯一能站得住的证据（详见 COPY_EMPTY_GRACE_MS 的取证）。 */
  if (got.empty) {
    let listOk = false, checked = false;
    /* 复核也要受总预算约束：空答复可能到得很晚，别为了复核把自己顶过 COPY_HARD_MS
       （真机踩过：空答复 ~6s 到，复核再花 3s ⇒ 8018ms 撞死「超过 8000ms 硬闸」，
       比原来的含糊超时还差）。剩余不足 900ms 就不复核，如实说明没复核成。 */
    const rest = Math.min(3000, COPY_HARD_MS - 400 - (Date.now() - t0));
    if (rest >= 900) {
      try {
        const r2 = await outFetch('https://' + got.base + '/api/v3/comics?limit=5&offset=0&platform=3',
          { headers: copyHeaders(), timeout: rest });
        const j2 = r2.json();
        const res2 = (j2 && j2.results) || {};
        listOk = asArray(res2.list || res2.comics || []).length > 0;
        checked = true;
      } catch (e) { /* 列表接口也打不通：按上游故障处理（checked 保持 false） */ }
    }
    if (listOk) {
      /* 列表有货 ⇒ 上游是好的，如实回「这个词 0 条」（不是错误） */
      log('拷贝漫画：上游正常，但「' + q + '」0 条（列表接口有货）');
      return { source: 'copymanga', host: got.base, total: 0, items: [],
        note: '拷贝漫画检索服务正常，但「' + q + '」确实 0 条结果 —— 换个关键词' };
    }
    /* 列表也是空的 ⇒ 上游故障。必须抛**非 soft** 错：soft 会让前端 tryVariants
       把上游故障当成「这一级没货」换词重试，把出口 IP 往限流上再推一轮，
       最后还是失败；硬失败立刻上报，前端也就不必把这一源挂到超时。 */
    const e = new Error('拷贝漫画上游返回空结果（HTTP 200 + 空列表，不是超时、也不是节点不通）：' +
      '候选节点（' + bases.length + ' 个：' + bases.slice(0, 4).join(' / ') + '）都答了，' +
      (checked ? '但连不带关键词的列表接口 /api/v3/comics 也是 0 条，'
        : '（本次剩余预算不足以复核列表接口，未能进一步确认）') +
      '而同一时刻同一条自建中继取 E-Hentai / 禁漫天堂都正常 ⇒ 是拷贝漫画自己的检索服务在静默空转。' +
      '稍后再试，或先用禁漫天堂 / 紳士漫畫 / nhentai');
    e.upstreamEmpty = 1;
    throw e;
  }
  state.copyApi = got.base; state.copyApiAt = Date.now();
  if (got.raw) return got.raw;
  log('拷贝漫画节点可用：' + got.base + '（' + got.pack.items.length + ' 条，' + (Date.now() - t0) + 'ms）');
  return got.pack;
}

/* ==========================================================================
   通用代理：让浏览器能取到「不返回跨域头」的网页（wnacg / hitomi / 漫画柜 …）
   取不到的域名进冷却，避免一次检索里被反复重试
   ========================================================================== */
const deadHosts = new Map();          // host -> 冷却截止时间戳
/* 空壳冷却（见 outFetch 的 guardEmpty）：某些站在限流时会回「200 + 0 字节」，
   识别到之后这段时间里别再用直连去撞，直接换中继出口。 */
const emptyShellUntil = new Map();
const EMPTY_SHELL_COOLDOWN = 60e3;
/* 三层都打不通才记冷却。45 秒太短了：前端取源时会拿一整排镜像域名竞速
   （绅士漫画 10 个域名 × 3 种路径），其中真被 SNI 阻断的那几个只能靠中继，
   而中继**是限流的公共资源**（AllOrigins 实测会被打成 429，之后整条中继腿对所有人都失效）。
   冷却拉长到 3 分钟，一次检索烧掉的那点配额就不会被下一次检索重复烧一遍。 */
const DEAD_MS = 180e3;

/* 进程内响应缓存（只缓存 GET 的 200）：
   · 中继是限流资源，同一张封面 / 同一页 HTML 不该反复穿过它
   · 前端「镜像竞速」会把同一个 URL 打很多次（不同检索、翻页、重绘）
   按总字节数封顶，先进先出淘汰，绝不无限涨。 */
const proxyCache = new Map();
const PROXY_CACHE_MS = 5 * 60e3;
const PROXY_CACHE_MAX = 64 * 1024 * 1024;
const PROXY_ONE_MAX = 6 * 1024 * 1024;
/* ★r18 需求③★ 批量预取的闸门（见 /api/prefetch）：
   条数上限、并发上限、整批总死线 —— 三个数就是「预取不许影响主流程」的保证。 */
const PRE_MAX = 24;
const PRE_CONC = 4;
const PRE_HARD_MS = 12000;
let proxyCacheBytes = 0;

function proxyCacheGet(key) {
  const hit = proxyCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > PROXY_CACHE_MS) {
    proxyCache.delete(key); proxyCacheBytes -= hit.buf.length;
    return null;
  }
  return hit;
}
function proxyCacheSet(key, entry) {
  if (entry.buf.length > PROXY_ONE_MAX) return;
  const old = proxyCache.get(key);
  if (old) proxyCacheBytes -= old.buf.length;
  proxyCache.set(key, entry);
  proxyCacheBytes += entry.buf.length;
  while (proxyCacheBytes > PROXY_CACHE_MAX && proxyCache.size) {
    const k = proxyCache.keys().next().value;
    const v = proxyCache.get(k);
    proxyCache.delete(k);
    proxyCacheBytes -= v.buf.length;
  }
}

const inflight = new Map();   // ck -> Promise<out>：同一把 key 的在途合并（见 proxyFetch）

async function proxyFetch(url, referer, opts) {
  const o = opts || {};
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('url 必须是 http(s)');
  const u = new URL(url);
  const ck = url + '\u0000' + (referer || '');
  const cached = proxyCacheGet(ck);
  if (cached) {
    return { status: cached.status, buf: cached.buf, headers: cached.headers, type: cached.type, cached: true };
  }
  const until = deadHosts.get(u.host) || 0;
  if (until > Date.now()) {
    throw new Error(u.host + ' 近期取源失败，已临时跳过（' + Math.ceil((until - Date.now()) / 1000) + 's 后可重试）');
  }
  /* ★r18 需求③：在途合并★
     阅读器按窗口预取 + 用户快速翻页时，同一个 URL（同一张图 / 同一页 HTML）常常被**同时**要两三次：
     预取与「进入窗口」撞车、纵向窗口与横向窗口重叠、重试与重绘重叠。
     以前每一次都会真的穿透出网（多数还要穿过限流的中继），于是「取图慢、还容易失败」。
     这里把同一把 key 的在途请求合成一次：后来者直接等前一个的结果，不再各自出网。
     · key 与缓存键一致（url + referer），所以预取填的缓存正好被可见图片命中；
     · **失败不进合并表**：等到的若是异常，后来者拿到同一个异常，但下一次调用会重新出网（不缓存失败）。 */
  const pend = inflight.get(ck);
  if (pend) return pend;
  const p = proxyFetchOnce(url, referer, o, u, ck);
  inflight.set(ck, p);
  try {
    return await p;
  } finally {
    if (inflight.get(ck) === p) inflight.delete(ck);
  }
}

async function proxyFetchOnce(url, referer, o, u, ck) {
  const headers = { 'user-agent': UA_CHROME, accept: 'text/html,application/xhtml+xml,*/*' };
  headers.referer = referer || (u.origin + '/');
  /* danbooru 的图床（*.donmai.us）：有「刚过完 CF 的 cookie + 同一个 UA」就原样带上，
     让 /api/proxy 也能取到图（这样用户 IP 不必暴露给图床，见上面 CF 通行证缓存）。
     没有凭证 / 凭证过期 / 从没撞过 CF / 是别的主机 → 这一段一行都不执行，
     请求头与改动前逐字节一致（其它源的透传是硬要求，别在这里动任何东西）。 */
  const cred = cfCredInjectable(u.hostname) ? cfCredHeaderFor(u.hostname, u.pathname) : null;
  if (cred) {
    headers.cookie = cred.cookie;
    if (cred.ua) headers['user-agent'] = cred.ua;
  }
  try {
    /* relay 的候选要靠 image 判断（图片走 i0.wp.com，网页只能走 AllOrigins） */
    /* opts.timeout / opts.allowEmpty 透传给 outFetch：
       · timeout —— booru 镜像那条路必须自己带死线，否则一次镜像没命中就要磨掉 30 秒以上；
       · allowEmpty —— 调用方明说「HTTP 200 + 空正文」对它是有意义的答案（booru 镜像的末页
         就是这个样子），别按空壳当失败、更别把主机拉进 60 秒空壳冷却（那会把后续请求
         全赶到中继上，实测 30 秒起步）。 */
    const r = await outFetch(url, {
      headers: headers,
      timeout: o.timeout || 12000,
      image: looksLikeImage(url),
      allowEmpty: o.allowEmpty === true
    });
    deadHosts.delete(u.host);
    /* 带出去的凭证被上游否了（CF 又拦了）：立刻丢掉，免得后面每一页都先白撞一次 403。
       回给浏览器的仍然是上游那一个原始响应，语义一点不变。 */
    if (cred && cfCredRejected(r.status, r.headers)) {
      cfCredDrop(u.hostname);
      log('CF 通行证对 ' + u.hostname + ' 已失效（HTTP ' + r.status + '），已丢弃；本条仍按原样返回，' +
        '下次渲染过验证时会重新缓存');
    }
    /* headers 也带出来：/api/proxy 要靠 cf-mitigated 判断「这张/这段是不是 CF 挑战页」 */
    const out = {
      status: r.status, buf: r.buf, headers: r.headers,
      type: r.headers.get('content-type') || 'text/html; charset=utf-8'
    };
    if (r.status === 200 && r.buf.length) proxyCacheSet(ck, { at: Date.now(), status: 200, buf: r.buf, headers: r.headers, type: out.type });
    /* 空响应单独记一笔：这是「看起来成功、其实什么都没拿到」的唯一形态，
       不记的话前端只会表现为「结果为空」，排查时无从下手。 */
    if (!r.buf.length) {
      log('取到空响应（HTTP ' + r.status + ' via=' + (r.via || '?') + '）：' + stripHost(url));
    }
    return out;
  } catch (e) {
    /* 冷却分两档：中继限流是**短时**状态（45 秒后中继自己就恢复了，不该把一个站也一起罚 3 分钟），
       站点真的不可达才用长冷却。 */
    const msg = (e && e.message) || '';
    const transient = /限流|HTTP 429|冷却中|timeout|超时|ETIMEDOUT|ECONNRESET|UND_ERR/.test(msg);
    /* ★r19★ 投机性预热（warmReaderImages）失败时**不许**把主机拉进冷却：
       实测（第 12 轮 A/B）预热并发失败一次 → 主机被记死 → 浏览器真正要的那张图
       2ms 直接 502（缓存了失败结论），而同一时刻别的实例取同一张图 213ms 就回来了。
       预热只是提速手段，它的失败不该惩罚用户当前这次阅读。 */
    if (o.noCooldown !== true) deadHosts.set(u.host, Date.now() + (transient ? 45e3 : DEAD_MS));
    throw e;
  }
}

/* ==========================================================================
   nhentai（nhentai.net）—— 非官方 JSON API v2
     GET /api/v2/search?query=<关键词>&page=<页码>[&sort=date|popular]
     · 本机直连 nhentai 的 TLS 会被重置（实测「基础连接已经关闭：接收时发生错误」），
       浏览器直连必失败；公共 CORS 代理又慢又常挂 —— 所以由网关统一代取，
       带上站点 Referer，出口走系统代理（网关启动时会自动探测）。
     · v2 只返回数字 tag_ids，站点没有名字映射（v1 /api/gallery/* 已 403、
       /api/v2/tags 已 404），所以 tags 恒为空数组 —— 绝不把数字当标签显示。
     · 上游 cover 给的是相对路径（galleries/<media_id>/thumb.webp），这里补成
       https://t.nhentai.net/… 绝对地址；前端 u.coverViaGateway 会按 nhentai.net
       的规则再带 Referer 走 /api/proxy。
   ========================================================================== */
const NH_HOST = 'https://nhentai.net';
const NH_IMG = 'https://t.nhentai.net';

/** 上游 thumbnail 可能是相对路径；拿不到就按 media_id 拼 cover.jpg */
function nhentaiCover(row) {
  const thumb = String((row && row.thumbnail) || '').trim();
  if (thumb) return /^https?:\/\//i.test(thumb) ? thumb : (NH_IMG + '/' + thumb.replace(/^\/+/, ''));
  const media = String((row && row.media_id) || '').trim();
  return media ? (NH_IMG + '/galleries/' + media + '/cover.jpg') : '';
}

/* ★第 11 轮★：函数级硬闸（绅士漫画同款，见 withHardTimeout 的注释）。
   这一源的 NH_BUDGET_MS = 6800 只是**软预算**：outFetch 的 timeout 是逐层的
   （原路 → DoH 钉 IP → 中继），一层超时还会走下一层，所以实测压测里这一源
   max = 19019ms（30 轮里 9 轮 >10s），而前端 9.5s 聚合闸早就把结果丢了。
   外套一条 NH_HARD_MS 硬闸，保证在前端放弃之前如实给出答复（成功或失败都算答复）。 */
const NH_HARD_MS = 8000;
async function nhentaiSearch(query) {
  let timer = null;
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('超过 ' + NH_HARD_MS + 'ms 硬闸（nhentai 各层叠加的总耗时超过预算）')), NH_HARD_MS);
  });
  try {
    return await Promise.race([nhentaiSearchInner(query), guard]);
  } catch (e) {
    const err = new Error('nhentai 取数失败：' + ((e && e.message) || e));
    err.soft = 1;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function nhentaiSearchInner(query) {
  const q = String(query.q || '').trim();
  if (!q) throw new Error('缺少关键词 q');
  const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
  const sort = String(query.sort || '').toLowerCase();
  let url = NH_HOST + '/api/v2/search?query=' + encodeURIComponent(q) + '&page=' + page;
  if (sort === 'date' || sort === 'popular') url += '&sort=' + sort;

  /* 第 10 轮：nhentai 对同一出口 IP 的限流很敏感（本机机房 IP 实测：连搜十几次就开始
     稳定回 429，而且会持续好几分钟）。12 轮压测里有 6 轮栽在这个 429 上。
     这里补一次**退避重试**：429 / 5xx 时等一小会儿再打一次（尊重 Retry-After，但设上限），
     仍然失败才如实报错；成功与「成功但 0 条」完全不受影响。
     ★ 整个函数加 6800ms 总预算（两条腿的超时都按剩余预算给）★：退避重试是「补救」，
     不许把单源耗时推到前端 9000ms 超时之上 —— 不设预算时实测出现过 **12720ms 的失败**
     （第一腿 429 很快，第二腿一直挂着），它单独一轮就把整轮墙钟顶到 cap 9500ms。 */
  const NH_BUDGET_MS = 6800;
  const nhT0 = Date.now();
  const nhLeft = () => NH_BUDGET_MS - (Date.now() - nhT0);
  let r = null;
  const nhTryFetch = () => outFetch(url, {
    timeout: Math.max(2500, Math.min(20000, nhLeft())),
    headers: { accept: 'application/json', referer: NH_HOST + '/' }
  });
  try {
    r = await nhTryFetch();
  } catch (e) {
    throw new Error('连不上 nhentai：' + ((e && e.message) || e) +
      '（本机直连会被重置，需要出口代理；网关启动时会自动探测本地代理端口）');
  }
  /* 第 10 轮（第二次加固）：429 是**持续几分钟**的限流，单次退避往往还不够 ——
     12 轮压测里就有 2 轮是「重试一次仍然 429」。改成最多两次退避（≥900ms → ≥2600ms，
     尊重 Retry-After 但设上限），两次之间受同一条 6800ms 预算夹住；
     预算不够就如实报错，绝不硬拖到前端超时之上。 */
  let nhRetries = 0;
  const NH_WAITS = [900, 2600];
  while (!r.ok && (r.status === 429 || r.status >= 500) && nhRetries < NH_WAITS.length) {
    const ra = parseInt(String((r.headers && r.headers.get && r.headers.get('retry-after')) || ''), 10);
    const raMs = isFinite(ra) && ra > 0 ? ra * 1000 : 0;
    const wait = Math.max(400, Math.min(Math.max(raMs, NH_WAITS[nhRetries]), 3500));
    if (nhLeft() - wait < 1800) {
      log('nhentai 返回 HTTP ' + r.status + '，但剩余预算不足（' + nhLeft() + 'ms）→ 不再重试，如实报错');
      break;
    }
    nhRetries++;
    log('nhentai 返回 HTTP ' + r.status + '，第 ' + nhRetries + ' 次退避 ' + wait + 'ms 后重试：' + stripHost(url));
    await new Promise(ok => setTimeout(ok, wait));
    try { r = await nhTryFetch(); } catch (e) { /* 保留上一次的失败响应，下面照常如实报错 */ }
  }
  if (!r.ok) {
    throw new Error('nhentai 返回 HTTP ' + r.status +
      (r.status === 429 ? '（上游限流了，等几分钟再搜）'
        : r.status === 403 ? '（可能被 Cloudflare 挡住，换一个出口代理再试）'
          : '（上游拒绝或改版了）'));
  }
  let j;
  try { j = r.json(); } catch (e) { throw new Error('nhentai 返回的不是 JSON（可能被挡或改版了）'); }

  const rows = asArray(j && j.result).filter(x => x && typeof x === 'object');
  const items = rows.map(row => {
    const id = String(row.id == null ? '' : row.id);
    const title = String(row.english_title || row.pretty_title || row.japanese_title || '')
      .replace(/\s+/g, ' ').trim();
    return {
      id: id,
      title: title || ('nhentai #' + id),
      url: NH_HOST + '/g/' + id + '/',
      cover: nhentaiCover(row),
      artist: '',
      pages: (typeof row.num_pages === 'number' && row.num_pages > 0) ? row.num_pages : null,
      /* tag_ids 全是数字 id、没有名字映射 —— 留空（跟前端适配器现口径一致） */
      tags: [],
      cats: [],
      /* 语言靠检索词里的 language: 限制，标题里没有可解析的语种字段 —— 留空 */
      lang: '',
      langs: [],
      note: 'nhentai（经网关）'
    };
  }).filter(x => x.id);

  return {
    ok: true, source: 'nhentai', page: page,
    total: (j && j.total) || items.length,
    resultPages: (j && j.num_pages) || null,     /* 注意：顶层的 num_pages 是「结果页数」，不是作品页数 */
    items: items
  };
}

/* nhentai 检索结果的进程内 TTL 缓存（压 429）
   实测：nhentai 对同一出口 IP 限流很敏感（连续十几次检索就开始回 HTTP 429），
   而「同一关键词重复搜」「继续加载同一页」会反复打同一个查询 —— 缓存能省掉这些。
   写法跟网关既有的 CF 渲染缓存一致：Map + TTL + 条数上限，先清过期再按插入序淘汰。
   ★ 只缓存**成功**的响应（含「成功但 0 条」——那也是一个有效答案），失败（4xx/超时/非 JSON）一律不缓存。 */
const NH_CACHE_TTL = 75e3;      /* 75 秒（要求 60–90s） */
const NH_CACHE_MAX = 50;        /* 最多 50 条 */
const nhCache = new Map();      /* 'q|page|sort' -> { at, body } */

function nhCacheGet(key) {
  const hit = nhCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > NH_CACHE_TTL) { nhCache.delete(key); return null; }
  return hit.body;
}

function nhCacheSet(key, body) {
  if (nhCache.size >= NH_CACHE_MAX) {
    const now = Date.now();
    for (const [k, v] of nhCache) if (now - v.at > NH_CACHE_TTL) nhCache.delete(k);
    while (nhCache.size >= NH_CACHE_MAX) nhCache.delete(nhCache.keys().next().value);
  }
  nhCache.set(key, { at: Date.now(), body: body });
}

/* ==========================================================================
   Kemono（kemono.cr）—— 存档站的公开 JSON API
     GET /api/v1/posts?q=<关键词>&o=<偏移>   →  { count, true_count, posts:[…] }
     每页固定 50 条；返回体没有 ACAO，所以必须由网关代取
   ========================================================================== */
const KEMONO_HOSTS = ['kemono.cr', 'kemono.su', 'kemono.party'];

function kemonoCover(p) {
  const file = p && p.file;
  let rel = (file && file.path) || '';
  if (!rel && Array.isArray(p.attachments) && p.attachments.length) rel = p.attachments[0].path || '';
  if (!rel) return '';
  if (/^https?:/i.test(rel)) return rel;
  return 'https://' + KEMONO_HOSTS[0] + '/data' + (rel.charAt(0) === '/' ? rel : '/' + rel);
}

async function kemonoSearch(query) {
  const q = String(query.q || '').trim();
  if (!q) throw new Error('缺少关键词 q');
  const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
  const offset = (page - 1) * 50;
  let lastErr = null;
  for (const host of KEMONO_HOSTS) {
    const url = 'https://' + host + '/api/v1/posts?q=' + encodeURIComponent(q) + '&o=' + offset;
    try {
      const r = await outFetch(url, { timeout: 20000, headers: { accept: 'application/json' } });
      if (r.status === 404) throw new Error('404');
      const j = r.json();
      const posts = (j && (j.posts || j.results)) || (Array.isArray(j) ? j : []);
      if (query.raw) return j;
      const items = posts.map(p => {
        const id = String(p.id || '');
        const svc = String(p.service || '');
        const title = String(p.title || '').replace(/\s+/g, ' ').trim();
        return {
          id: id,
          title: title || (svc + ' #' + id),
          cover: kemonoCover(p),
          url: 'https://' + host + '/' + svc + '/user/' + p.user + '/post/' + id,
          artist: '',
          tags: [svc].filter(Boolean),
          pages: null,
          note: 'Kemono · ' + svc
        };
      }).filter(x => x.id && x.title);
      return {
        source: 'kemono', host: host, total: (j && (j.true_count || j.count)) || items.length,
        items: items, trueTotal: (j && j.true_count) || null
      };
    } catch (e) { lastErr = new Error(host + '：' + ((e && e.message) || e)); }
  }
  throw lastErr || new Error('Kemono 不可达');
}

/* ==========================================================================
   Pixiv（www.pixiv.net）—— 官方搜索 AJAX 接口
     GET /ajax/search/artworks/{关键词}?word=<关键词>&order=date_d
         &mode=<all|r18>&p=<页码>&s_mode=s_tag&type=all&lang=zh
     · 响应 JSON：优先 body.illustManga.data，兼容旧版 body.illust.data
     · i.pximg.net 有防盗链（请求不带 Referer 直接 403），所以封面统一返回
       本网关的相对代理地址，由 /api/proxy 带上 Referer 去取
     · mode=r18 必须带用户自己的登录 cookie（PHPSESSID），否则固定 0 条
   ========================================================================== */
/* ==========================================================================
   第 11 轮：Pixiv 网络断路器
   实测（2026-09-23，本机出口）www.pixiv.net 是**链路层**死路，不是代码问题：
     · 系统 DNS 被投毒（HTTPS RR 的 ipv4hint 指向 Facebook 的 66.220.149.18）；
     · DoH 能给出真 IP，但带 SNI=www.pixiv.net 的 TLS 握手立刻被 ECONNRESET
       （GFW 按 SNI 关键字阻断）；
     · HTTPS RR 里没有 ech= 配置，而 Cloudflare 的 DoH（cloudflare-dns.com / 1.1.1.1）
       本身也被 RESET / TIMEOUT ⇒ 没有 ECH 这条穿墙路可走；
     · 15 条公共中继全挂（timeout / 401 要 key / 429 限流 / 证书过期 / NXDOMAIN）。
   outFetch 的三层腿串行跑完要 15.3s，用户连搜几个词就是连续十几个 15 秒的纯失败。
   这里加断路器：确认真·网络层失败后，冷却期内毫秒级返回同一结论。
   用户一旦挂上代理（--proxy / HTTPS_PROXY），这条路自然恢复 —— 断路器只是临时状态。
   ========================================================================== */
const PIXIV_NET_COOLDOWN_MS = 180e3;
/* 预算 8s：本机出口是死路时，outFetch 的「真·死线」之外每条腿还各留 900ms 收尾，
   实测 timeout:15000 会被拖到 17.5s。pixiv 官方 API 在有代理时通常 1–3s 就回，
   8s 余量充足；无代理时这根最长的钉子也能从 17.5s 压到 ~10s。 */
const PIXIV_BUDGET_MS = 8000;
let pixivNetDownUntil = 0;
let pixivNetDownWhy = '';
/* 出口感知：与 ehentai 的 ehNetDownEgress 同一套路 —— 用户挂上代理后 egress.live 变了，
   断路器必须立刻失效并重新试一次，而不是把人锁在 180 秒冷却里干等。 */
let pixivNetDownEgress = '';

/* 本机出口到 E-Hentai / Pixiv 的死因（2026-09-23 实测）：系统 DNS 被投毒、
   带 SNI 的 TLS 被按域名关键字阻断；DoH 钉 IP 拿不到能验真的 IP。
   ★2026-09-23 更新★：**e-hentai 已经有非代理通路了** —— cors.eu.org 中继实测
   首页 268ms / 图集页 233ms / 大图 691ms（sha b313a632ad6f 与历史取证逐字节一致），
   所以下面这段不该再写成「直连无解、只能挂代理」。现在它只在
   ① 中继也全灭（例如 cors.eu.org 的共享出口被 e-hentai 限流封禁）或
   ② pixiv（WAF 按机房 IP 封，中继也 403，非代理确实无解）这两种情况下才出现。
   把「怎么办」写进错误文案，用户看到的才不是死路。 */
/* ★r17 拆开★（2026-09-23 真机实测）：以前 e-hentai 与 pixiv 共用这一段 DEAD_SITE_FIX，
   于是 **pixiv 的报错里会粘上「e-hentai 已经由自建中继打通…」** 这种跟它毫无关系的话，
   用户读到一大段废话、也找不到自己该做什么。现在按源分开，每段只讲这一源
   「为什么不通 + 怎么办」，而且「怎么办」必须是可执行的动作。 */
const EH_DEAD_FIX = '直连这条路是死的（本机 DNS 被投毒 + TLS 按域名关键字阻断，DoH 钉 IP / ECH 都试过）。' +
  'e-hentai 现在靠**自建中继**（Cloudflare Pages，/api/ping 里 relays[0]=private）出去；' +
  '中继的共享出口被上游按 IP 限流时，上游就回这种封禁页 —— 网关会按它给的解封倒计时冷却，' +
  '不再反复去撞同一个出口。想立刻恢复：把**你自己的墙外出口**给网关' +
  '（启动加 --proxy http://127.0.0.1:你的端口，或先设 HTTPS_PROXY 再启网关）。' +
  '替代源：nhentai / wnacg / hitomi。';

const PIXIV_DEAD_FIX = '直连这条路是死的（本机 DNS 被投毒 + TLS 按域名关键字阻断，DoH 钉 IP / ECH 都试过）。' +
  'pixiv 的性质不同：它对**数据中心出口**一律 403（正文是 Cloudflare WAF 的 block_waf 页，' +
  '自建中继的出口同样被挡 —— 实测 private HTTP 403 / 372KB），所以这不是改代码能修的，' +
  '必须要有一个**住宅/家宽出口**：把你的代理交给网关' +
  '（启动加 --proxy http://127.0.0.1:你的端口；或先设 HTTPS_PROXY；' +
  '7897 / 7890 / 7891 / 10809 / 10808 / 1080 / 2080 / 8889 / 8118 这些常见端口网关会自动探测），' +
  '重启网关即通。R-18 检索还要在「设置 → 信息源 → Pixiv」里填你自己的 PHPSESSID。' +
  '替代源：danbooru / kemono / nhentai。';


async function pixivSearch(query) {
  const q = String(query.q || '').trim();
  if (!q) throw new Error('缺少关键词 q');
  if (Date.now() < pixivNetDownUntil && pixivNetDownEgress === (egress.live || '')) {
    throw new Error('Pixiv 连不上（' + pixivNetDownWhy + '）：本机出口到 www.pixiv.net 不通，' +
      Math.ceil((pixivNetDownUntil - Date.now()) / 1000) + ' 秒内不再重试（避免把整轮检索拖慢）。' +
      PIXIV_DEAD_FIX);
  }
  const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
  const mode = String(query.mode || 'all') === 'r18' ? 'r18' : 'all';
  const cookie = String(query.cookie || '').trim();
  const api = 'https://www.pixiv.net/ajax/search/artworks/' + encodeURIComponent(q) +
    '?word=' + encodeURIComponent(q) + '&order=date_d&mode=' + mode + '&p=' + page +
    '&s_mode=s_tag&type=all&lang=zh';
  const headers = {
    'user-agent': UA_CHROME,
    referer: 'https://www.pixiv.net/',
    accept: 'application/json'
  };
  if (cookie) headers.cookie = cookie;

  let body;
  try {
    /* r17 真机实测：outFetch 的 timeout 是**逐层**的（原路 → DoH 钉 IP → 中继，
       每条腿还各留 900ms 收尾），所以「无代理」时 8s 预算会被拖到 **15926ms**——
       HTTP 响应就吊在那儿 16 秒，前端早把这一源丢了，网关却还在等。
       外面再套一层函数级硬闸，把这根钉子钉在 ~8.4s 内（有代理时官方 API 1–3s 就回）。 */
    const r = await withHardTimeout(
      outFetch(api, { headers: headers, timeout: PIXIV_BUDGET_MS }),
      PIXIV_BUDGET_MS + 400, 'Pixiv 取数');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    try {
      body = r.json();
    } catch (je) {
      /* 200 但不是 JSON：实测中继**确实连得上**，但它会剥掉请求头里的 Referer，
         而 pixiv 的 /ajax/ 接口对 Referer 敏感，于是回一个 HTML 登录/错误页。
         对一个 .json 端点来说这就是链路层失败，照网络层拉闸。把 via 带出来方便取证。 */
      throw new Error('返回的不是 JSON（via=' + (r.via || '?') + '）：' +
        String((je && je.message) || je).slice(0, 60));
    }
  } catch (e) {
    const msg = String((e && e.message) || e);
    /* 只有「链路层」失败才值得拉闸：fetch failed / DoH 找不出能验真的 IP / 中继全灭 /
       JSON 端点拿到 HTML。HTTP 4xx 与「0 条结果」不是网络问题，不能因此冷却
       —— 否则用户挂上代理之后仍会被误锁 180 秒。 */
    if (/fetch failed|没给出能验真的 IP|中继全失败|返回的不是 JSON|硬超时/.test(msg)) {
      pixivNetDownUntil = Date.now() + PIXIV_NET_COOLDOWN_MS;
      pixivNetDownWhy = msg.slice(0, 120);
      pixivNetDownEgress = egress.live || '';
    }
    const linkDown = /fetch failed|没给出能验真的 IP|中继全失败|返回的不是 JSON|硬超时/.test(msg);
    throw new Error('Pixiv 请求失败：' + msg +
      (linkDown ? '。' + PIXIV_DEAD_FIX : ''));
  }
  if (!body || typeof body !== 'object' || body.error === true) {
    throw new Error('Pixiv 返回错误：' + ((body && body.message) || '响应异常'));
  }

  const inner = (body.body && (body.body.illustManga || body.body.illust)) || {};
  const rows = asArray(inner.data).filter(x => x && typeof x === 'object');
  if (!rows.length) {
    if (mode === 'r18' && !cookie) {
      throw new Error('Pixiv 的 R-18 检索需要登录 cookie（设置 → 信息源 → Pixiv 填 PHPSESSID）');
    }
    throw new Error('Pixiv 返回 0 条');
  }

  const items = rows.map(item => {
    const id = String(item.id || '');
    const tags = asArray(item.tags).map(t => String(t)).filter(Boolean);
    /* R-18 标记只按数据本身判定：pixiv 在未登录时对 mode=r18 会**静默回落成全年龄结果**
       （实测返回的 id 与 mode=all 完全一致），所以不能拿"我请求了 r18"当依据，
       否则会把全年龄条目误标成 R-18。xRestrict：0=全年龄 1=R-18 2=R-18G */
    const isR18 = Number(item.xRestrict || 0) >= 1 ||
      tags.some(t => /^r-?18g?$/i.test(String(t).trim()));
    if (isR18 && tags.indexOf('R-18') < 0) tags.push('R-18');
    const note = 'Pixiv 官方搜索 · ' + (isR18 ? 'R-18' : '全年龄') +
      (mode === 'r18' && !cookie ? '（未登录，R-18 已回落为全年龄）' : '');
    return {
      id: id,
      title: item.title || '',
      /* i.pximg.net 防盗链：封面必须由网关带 Referer 代取，这里给相对代理地址 */
      cover: item.url ? ('/api/proxy?url=' + encodeURIComponent(item.url) +
        '&referer=' + encodeURIComponent('https://www.pixiv.net/')) : '',
      url: 'https://www.pixiv.net/artworks/' + id,
      artist: item.userName || '',
      pages: null,
      /* 分级如实上报：xRestrict / R-18 标签说了算（未登录时 pixiv 会静默回落成全年龄，
         这时就是 false —— 前端默认会把非成人向筛掉，这是有意的，别用请求参数反推） */
      adult: isR18,
      tags: tags,
      cats: [],
      note: note
    };
  }).filter(x => x.id && x.title);

  return { source: 'pixiv', host: 'www.pixiv.net', total: rows.length, items: items };
}

/* ==========================================================================
   Cloudflare 人机验证求解器（用本机 Chrome 跑一遍验证）
     Node 不会执行 JS，「Just a moment…」这类挑战永远过不去 —— 这正是
     porn-comic 一直报错的根因。这里用 CDP 驱动本机已装的 Chrome/Edge：
       --headless=new + 真身 UA + 反自动化补丁 → WebSocket(CDP) 取回渲染好的 HTML
     Node 22+ 自带全局 WebSocket，所以依然零 npm 依赖。

     实测要点（porn-comic 这个站）：
       · 它不发 cf_clearance，每个新 URL 都要自己过一次验证；
       · 同一浏览器里连续硬闯，CF 会越卡越死，所以这里做了结果缓存 + 失败冷却，
         绝不连着重试（重试只会把 IP 名声烧掉）；
       · profile 会攒下过期状态，所以每次启动都用全新 profile，用完即删。
   ========================================================================== */
const CF_RENDER_TTL = 5 * 60e3;      /* 同一 URL 5 分钟内直接用缓存 */
const CF_RENDER_MAX = 40;            /* 缓存条数上限 */
const CF_FAIL_COOLDOWN = 90e3;       /* 验证失败后 90 秒内不再硬闯 */
/* 第一次失败只罚 15 秒：CF 的挑战本来就时好时坏（换个 target / 换一秒就可能过），
   一次没过就把整个源锁死 90 秒，正是「porn-comic 经常无法检索」的重要成因。
   只有**环境性**失败（Chrome 根本起不来）和**连续第 2 次**失败才用长冷却。 */
const CF_FAIL_SOFT_COOLDOWN = 15e3;
const cfCache = new Map();           /* url -> { html, at } */
let cfCooldownUntil = 0;
let cfLastErr = '';
let cfConsecFails = 0;
const CF_CHALLENGE_RE = /just a moment|请稍候|attention required|checking your (browser|connection)|verifying you are human|正在验证|人机验证|cf-chl|_cf_chl_/i;

/* --- 「这是不是 Cloudflare 的挑战页」的可复用判断（porn-comic 与 danbooru 共用）-------
   为什么不能只看 403：CF 的拦截页在实测里用过 403 / 429 / 503 / 520–527 中的任意一个，
   甚至能回 200 + 挑战页；而 danbooru 的图床（cdn.donmai.us）回 403 时**响应头带
   `cf-mitigated: challenge`** —— 那是最硬的证据。所以三层一起看：
     ① 响应头 cf-mitigated: challenge
     ② 正文特征（标题 Just a moment…、#challenge-running / #challenge-error-text、
        cf-chl* 脚本、cf-mitigated 字样）
     ③ 状态码 403 / 429 / 503 / 520–527
   正常页面里也会引用 cdn-cgi/challenge-platform 的脚本，所以调用方可以传 okRe
   （「这是真内容」的特征），okRe 命中就一律判「不是挑战页」—— 真内容优先。 */
function cfMitigatedHeader(headers) {
  if (!headers) return '';
  try {
    if (typeof headers.get === 'function') return String(headers.get('cf-mitigated') || '');
    return String(headers['cf-mitigated'] || headers['CF-Mitigated'] || '');
  } catch (e) { return ''; }
}

/** 只看正文：是不是 CF 的挑战/拦截页 */
function cfChallengeHtml(html) {
  const s = String(html || '');
  if (!s) return false;
  if (CF_CHALLENGE_RE.test(s)) return true;
  if (/<title>\s*(just a moment|请稍候|attention required)/i.test(s)) return true;
  if (/id="(challenge-running|challenge-stage|challenge-form|challenge-error-text|cf-chl)/i.test(s)) return true;
  if (/cf-mitigated/i.test(s)) return true;
  return false;
}

/** 状态码 + 响应头 + 正文 三层合判；okRe 命中 → 一律判「不是挑战页」 */
function cfIsChallenge(status, headers, html, okRe) {
  const s = String(html || '');
  if (okRe && okRe.test(s)) return false;
  if (/challenge/i.test(cfMitigatedHeader(headers))) return true;
  if (cfChallengeHtml(s)) return true;
  const st = Number(status) || 0;
  return st === 403 || st === 429 || st === 503 || (st >= 520 && st <= 527);
}

/** 「过不去 CF」时给一句**可行动**的中文（谁失败、现在能不能救、接下来做什么）
 *  —— 不抛栈、不把挑战页当正文，也不建议用户「稍后重试」了事。 */
function cfSolverHint(what, e) {
  const why = cfUnavailableReason();
  const left = Math.ceil(cfCooldownLeft() / 1000);
  let why2;
  if (why) {
    why2 = '本机 Chrome 通道在当前环境不可用（' + why + '）';
  } else if (left > 0) {
    why2 = '网关刚刚在这条通道上失败过一次，冷却中（还有 ' + left + ' 秒，共 ' +
      Math.round(CF_FAIL_COOLDOWN / 1000) + ' 秒；连着硬闯只会让出口 IP 名声更差，所以不自动重试）' +
      (cfLastErr ? '；上次失败：' + cfLastErr : '');
  } else {
    why2 = '本机 Chrome 没能过 Cloudflare 验证' + (e && e.message ? '（' + e.message + '）' : '') +
      (cfLastErr ? '；最近一次失败：' + cfLastErr : '');
  }
  return what + '：' + why2 + '。可以：① 确认这台机器上 Chrome 能打开对应网站' +
    '（沙箱/受限环境里 Chrome 常因命名管道被禁而起不来，报错就是「Chrome 没能启动」）；' +
    '② 换一个出口代理再试（网关用 --proxy http://127.0.0.1:7897 或先设 HTTPS_PROXY，' +
    '过验证的成功率跟出口 IP 名声直接相关）；③ 过一会儿再来。';
}

/** 最近一次真实尝试是不是失败（失败时间晚于最近一次成功）——
 *  /api/ping 用来说实话：只看可执行文件在不在的话，沙箱里也会报「可用」。 */
function cfSolverFailing() { return cfState.lastFailAt > (cfState.lastOkAt || 0); }

let cfProfileDir = '';
const CF_PROFILE_PREFIX = 'erometa-cf-';

/** 清掉历史残留的 profile：Chrome 一个 profile 能写到 100MB，
 *  一次性浏览器意味着每个搜索都会新建一个，不清理迟早把磁盘塞满。 */
function cfSweepProfiles(keepDir) {
  try {
    const base = os.tmpdir();
    for (const name of fs.readdirSync(base)) {
      if (name.indexOf(CF_PROFILE_PREFIX) !== 0) continue;
      const full = path.join(base, name);
      if (full === keepDir) continue;
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (Date.now() - st.mtimeMs < 15 * 60e3) continue;   /* 太新的可能是别的网关正在用 */
      try { fs.rmSync(full, { recursive: true, force: true }); } catch (e) {}
    }
  } catch (e) {}
}

/* headless 会被 Cloudflare 直接识破；这几处是最常被查的指纹，逐个抹平 */
const CF_STEALTH_JS = `(function(){
  var d = Object.defineProperty;
  try { d(navigator,'webdriver',{get:function(){return false;},configurable:true}); } catch(e){}
  try { d(navigator,'languages',{get:function(){return ['en-US','en'];},configurable:true}); } catch(e){}
  try { d(navigator,'hardwareConcurrency',{get:function(){return 8;},configurable:true}); } catch(e){}
  try { d(navigator,'deviceMemory',{get:function(){return 8;},configurable:true}); } catch(e){}
  try { d(navigator,'plugins',{get:function(){
      var a=[{name:'PDF Viewer',filename:'internal-pdf-viewer',description:'Portable Document Format'},
             {name:'Chrome PDF Viewer',filename:'internal-pdf-viewer',description:'Portable Document Format'},
             {name:'Chromium PDF Viewer',filename:'internal-pdf-viewer',description:'Portable Document Format'}];
      a.item=function(i){return a[i]||null;};
      a.namedItem=function(n){for(var i=0;i<a.length;i++){if(a[i].name===n)return a[i];}return null;};
      return a;},configurable:true}); } catch(e){}
  try { d(navigator,'mimeTypes',{get:function(){var a=[];a.item=function(){return null;};a.namedItem=function(){return null;};return a;},configurable:true}); } catch(e){}
  try { if(!window.chrome){window.chrome={runtime:{},app:{isInstalled:false},csi:function(){},loadTimes:function(){}};} } catch(e){}
  try { var q=navigator.permissions&&navigator.permissions.query;
        if(q){navigator.permissions.query=function(p){return p&&p.name==='notifications'
          ?Promise.resolve({state:(window.Notification&&Notification.permission)||'default',onchange:null})
          :q.call(navigator.permissions,p);};} } catch(e){}
  try { [WebGLRenderingContext,WebGL2RenderingContext].forEach(function(C){
          if(!C||!C.prototype.getParameter)return; var g=C.prototype.getParameter;
          C.prototype.getParameter=function(p){
            if(p===37445)return 'Intel Inc.';
            if(p===37446)return 'Intel Iris OpenGL Engine';
            return g.call(this,p);};}); } catch(e){}
})();`;

const CF_PROBE_JS = `(function(){
  var t = document.title || '';
  var el = document.querySelector('#challenge-running,#challenge-stage,#cf-challenge-running,.cf-error-title,[id^="cf-chl"]');
  /* thumbs / works：给「这页到底渲染出来没有」一个可判定的依据。
     只看正文字节数会被**骨架页**骗过去 —— porn-comic 的标签页先出骨架、作品网格稍后才补，
     两种阶段的 innerHTML 长度差不了多少（实测 17.1KB vs 17.7KB），拿字节数当判据必然误判。 */
  var thr = 0, wk = 0;
  try {
    thr = document.querySelectorAll('a.thumb').length;
    wk = document.querySelectorAll('a[href^="/h/"],a[href^="/hentai/"],a[href^="/gif/"]').length;
  } catch (e) {}
  return { title: t, href: location.href, dom: !!el,
    body: document.body ? document.body.innerHTML.length : 0,
    thumbs: thr, works: wk };
})()`;

function cfChromePath() {
  const cands = [
    process.env.HS_CHROME, process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : '',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ];
  for (const c of cands) { if (c && fs.existsSync(c)) return c; }
  return '';
}

/** 能不能用；不能用时返回原因（给前端看的提示） */
function cfUnavailableReason() {
  if (typeof WebSocket === 'undefined') return '当前 Node 版本没有全局 WebSocket（需要 22+）';
  if (!cfChromePath()) return '没找到本机 Chrome / Edge（可用 HS_CHROME 环境变量指定）';
  if (String(process.env.HS_CF_SOLVER || '') === '0') return '已用 HS_CF_SOLVER=0 关闭';
  return '';
}

const cfState = {
  proc: null, ws: null, ua: '', uaParams: null,
  ready: null, chain: Promise.resolve(), nextId: 0, pending: new Map(),
  timer: null, solvedAt: 0, renders: 0,
  /* 「真验证过没有、最近一次成没成」的如实记录。
     available 只回答「可执行文件在不在」，在沙箱里照样是 true（实测），
     所以 /api/ping 另外暴露 verified / failing / lastOkAt / lastErrorAt。 */
  lastOkAt: 0, lastFailAt: 0
};

function cdpSend(method, params, sid) {
  const id = ++cfState.nextId;
  const msg = { id: id, method: method, params: params || {} };
  if (sid) msg.sessionId = sid;
  return new Promise((res, rej) => {
    cfState.pending.set(id, { res: res, rej: rej });
    try { cfState.ws.send(JSON.stringify(msg)); }
    catch (e) { cfState.pending.delete(id); return rej(new Error('Chrome 连接已断开')); }
    setTimeout(() => {
      if (cfState.pending.has(id)) { cfState.pending.delete(id); rej(new Error(method + ' 超时')); }
    }, 40000);
  });
}

function cdpConnect(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url);
    cfState.ws = ws;
    ws.onopen = () => { if (!settled) { settled = true; resolve(); } };
    ws.onerror = () => { if (!settled) { settled = true; reject(new Error('连不上 Chrome 调试端口')); } };
    ws.onmessage = ev => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      const p = cfState.pending.get(m.id);
      if (!p) return;
      cfState.pending.delete(m.id);
      if (m.error) p.rej(new Error(m.error.message)); else p.res(m.result);
    };
    ws.onclose = () => {
      cfState.ws = null; cfState.ready = null;
      if (!settled) { settled = true; reject(new Error('Chrome 调试连接被关闭')); }
      for (const p of cfState.pending.values()) p.rej(new Error('Chrome 调试连接已断开'));
      cfState.pending.clear();
    };
  });
}

function cfStop() {
  const proc = cfState.proc;
  cfState.proc = null;
  try { if (cfState.ws) cfState.ws.close(); } catch (e) {}
  cfState.ws = null; cfState.ready = null;
  if (proc) { try { proc.kill(); } catch (e) {} }
  /* 用完即删：留着只会让下一次验证过不去。Chrome 退出要一点时间，稍后再删一次 */
  const dir = cfProfileDir;
  cfProfileDir = '';
  if (dir && !process.env.HS_CF_PROFILE) {
    const wipe = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} };
    setTimeout(wipe, 2500).unref?.();
    wipe();
  }
}
process.on('exit', cfStop);

/** Chrome 安装目录里的版本号子目录（用来拼一个「真身」UA） */
function cfChromeVersion(exe) {
  try {
    const vers = fs.readdirSync(path.dirname(exe))
      .filter(n => /^\d+\.\d+\.\d+\.\d+$/.test(n))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (vers.length) return vers[0];
  } catch (e) {}
  return '';
}

/* 第 10 轮：给 Chrome 的解析器钉 IP（--host-resolver-rules）。键 = 主机名，值 = 验真过的 IP。
   为什么需要：Chrome 不认网关的 DoH 钉选、用的是系统 DNS，被污染的域名在 Chrome 里
   直接变成 chrome-error://chromewebdata/（实测 danbooru.donmai.us），CF 验证根本没机会做。 */
const cfPinRules = new Map();

/* 第 10 轮：CF 的**挑战脚本**本身也要能解析。只钉被测站是不够的 —— 这台机器的系统 DNS
   被污染，challenges.cloudflare.com 解析不出来，验证页的 JS 于是永远加载不完，
   网关这边看到的就是「CF 验证没通过（无标题）」，白烧 12 秒后进 90 秒冷却。 */
const CF_ASSET_HOSTS = ['challenges.cloudflare.com', 'static.cloudflareinsights.com'];

/** 让即将交给 cfRender 的那个主机在 Chrome 里也走验真过的 IP。
 *  钉不上（DoH 也没给出可用 IP）就什么都不做，保持原来的系统 DNS 行为。
 *  浏览器已经起来、规则里又没有这个主机 ⇒ 关掉它，让下一次 cfLaunch 带上新规则
 *  （--host-resolver-rules 是进程级参数，只能启动时给）。 */
async function cfPinHostForChrome(url) {
  let host = '';
  try { host = new URL(String(url)).hostname; } catch (e) { return; }
  if (!host) return;
  let added = false;
  for (const h of [host].concat(CF_ASSET_HOSTS)) {
    if (cfPinRules.has(h)) continue;
    let ip = '';
    try { ip = await pinHost(h, 2500); } catch (e) { ip = ''; }
    if (!ip) { log('Chrome 解析器钉选：' + h + ' 没验真出可用 IP（Chrome 继续用系统 DNS）'); continue; }
    cfPinRules.set(h, ip);
    added = true;
    log('Chrome 解析器钉选：' + h + ' → ' + ip + '（绕开系统 DNS 污染）');
  }
  if (added && cfState.proc) { try { cfStop(); } catch (e) {} }
}

async function cfLaunch() {
  const bad = cfUnavailableReason();
  if (bad) throw new Error('无法过 Cloudflare 验证：' + bad);
  const exe = cfChromePath();
  /* 每次都用全新 profile：残留的 CF 状态会让验证一直卡住（实测）。
     目录名固定成每个进程一个，同时扫掉历史残留，保证磁盘上最多只留一份。 */
  const pinned = String(process.env.HS_CF_PROFILE || '');
  cfProfileDir = pinned || path.join(os.tmpdir(), CF_PROFILE_PREFIX + process.pid);
  if (!pinned) { try { fs.rmSync(cfProfileDir, { recursive: true, force: true }); } catch (e) {} }
  try { fs.mkdirSync(cfProfileDir, { recursive: true }); } catch (e) {}
  if (!pinned) cfSweepProfiles(cfProfileDir);

  /* --user-agent 必须启动时就给：只靠 CDP 覆盖的话进程级 UA 仍是 HeadlessChrome，
     第一次导航能过、第二次就被 Cloudflare 拦下（实测如此）。 */
  const ver0 = cfChromeVersion(exe);
  const major0 = ver0 ? ver0.split('.')[0] : '131';
  const launchUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' +
    major0 + '.0.0.0 Safari/537.36';

  /* HS_CF_HEADFUL=1：真·有头 Chrome 名声更好，headless 被卡时可以作为兜底 */
  const headful = String(process.env.HS_CF_HEADFUL || '') === '1';
  const args = [
    '--remote-debugging-port=0',
    '--user-data-dir=' + cfProfileDir,
    '--user-agent=' + launchUA,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--mute-audio', '--disable-blink-features=AutomationControlled',
    '--window-size=1280,900', '--lang=en-US',
    'about:blank'
  ];
  if (headful) args.push('--window-position=-2400,-2400');
  else args.unshift('--headless=new');
  /* 系统 DNS 污染是 Chrome 打不开被墙站的**唯一**原因（网关自己走 DoH 钉 IP 所以没事），
     这里把已经验真过的 IP 钉进 Chrome 的解析器，CF 验证才有机会做。 */
  if (cfPinRules.size) {
    const rules = [];
    for (const pair of cfPinRules) rules.push('MAP ' + pair[0] + ' ' + pair[1]);
    args.push('--host-resolver-rules=' + rules.join(','));
  }
  /* 站点的出口必须和网关一致：走了代理就用同一个代理 */
  const proxy = (process.env.HS_GW_PROXIED === '1' && process.env.HTTPS_PROXY) || argOf('proxy') || '';
  if (proxy) args.push('--proxy-server=' + proxy);

  log('启动本机 Chrome 过 Cloudflare 验证（首次约 6 秒）…');
  const proc = spawn(exe, args, { stdio: 'ignore' });
  proc.on('exit', () => {
    if (cfState.proc === proc) {
      cfState.proc = null; cfState.ws = null; cfState.ready = null;
    }
  });
  proc.on('error', e => log('Chrome 启动失败：' + ((e && e.message) || e)));
  cfState.proc = proc;

  const portFile = path.join(cfProfileDir, 'DevToolsActivePort');
  try { fs.rmSync(portFile, { force: true }); } catch (e) {}   /* 别读到上一次留下的旧端口 */
  let port = '', wsPath = '/devtools/browser';
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    if (fs.existsSync(portFile)) {
      const txt = fs.readFileSync(portFile, 'utf8').split('\n');
      if ((txt[0] || '').trim()) {
        port = txt[0].trim();
        wsPath = (txt[1] || '').trim() || '/devtools/browser';   /* 第二行是带 UUID 的调试路径，必须用 */
        break;
      }
    }
    if (proc.exitCode !== null) break;
  }
  if (!port) {
    cfStop();
    throw new Error('Chrome 没能启动（调试端口未就绪）。若网关在沙箱/受限环境里运行，请放行它启动浏览器进程');
  }

  let ver;
  try {
    await cdpConnect('ws://127.0.0.1:' + port + wsPath);
    ver = await cdpSend('Browser.getVersion');
  } catch (e) {
    cfStop();                                   /* 起不来就别把僵尸 Chrome 留在那儿占着 profile */
    throw new Error('Chrome 调试连接失败（' + ((e && e.message) || e) + '）');
  }
  /* headless 的 UA 里带 HeadlessChrome，是最好认的破绽，直接换成真身 */
  const ua = String(ver.userAgent || '').replace(/HeadlessChrome/g, 'Chrome');
  const full = (String(ver.product || '').match(/\/([\d.]+)$/) || [])[1] || (ver0 || '0.0.0.0');
  const major = (ua.match(/Chrome\/(\d+)/) || [])[1] || full.split('.')[0];

  cfState.ua = ua;
  /* 每次取页面都新开一个 target：同一个 target 连着导航三次以后 CF 会开始拒绝
     （实测第二次还行、第三次就卡在「Just a moment…」），新 target 则一直好使。 */
  cfState.uaParams = {
    userAgent: ua,
    acceptLanguage: 'en-US,en;q=0.9',
    platform: 'Win32',
    userAgentMetadata: {
      brands: [
        { brand: 'Chromium', version: major },
        { brand: 'Google Chrome', version: major },
        { brand: 'Not?A_Brand', version: '24' }
      ],
      fullVersionList: [
        { brand: 'Chromium', version: full },
        { brand: 'Google Chrome', version: full },
        { brand: 'Not?A_Brand', version: '24.0.0.0' }
      ],
      fullVersion: full, platform: 'Windows', platformVersion: '15.0.0',
      architecture: 'x86', model: '', mobile: false, bitness: '64', wow64: false
    }
  };
  log('Chrome 就绪：' + ua.replace(/^.*?Chrome\//, 'Chrome/'));
}

/** 开一个「调教好」的新标签页（新 target 才有干净的反检测环境） */
async function cfOpenPage() {
  const t = await cdpSend('Target.createTarget', { url: 'about:blank' });
  const at = await cdpSend('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  const sid = at.sessionId;
  await cdpSend('Page.enable', {}, sid);
  await cdpSend('Network.enable', {}, sid);
  await cdpSend('Emulation.setUserAgentOverride', cfState.uaParams, sid);
  await cdpSend('Page.addScriptToEvaluateOnNewDocument', { source: CF_STEALTH_JS }, sid);
  return { targetId: t.targetId, sid: sid };
}

async function cfClosePage(page) {
  try { await cdpSend('Target.closeTarget', { targetId: page.targetId }); } catch (e) {}
}

const cfEval = async (expr, sid) => {
  const r = await cdpSend('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid);
  if (r && r.exceptionDetails) return undefined;
  return r && r.result ? r.result.value : undefined;
};

function cfCacheGet(url) {
  const hit = cfCache.get(url);
  if (hit && Date.now() - hit.at < CF_RENDER_TTL) return hit.html;
  if (hit) cfCache.delete(url);
  return '';
}
function cfCacheSet(url, html) {
  cfCache.set(url, { html: html, at: Date.now() });
  while (cfCache.size > CF_RENDER_MAX) cfCache.delete(cfCache.keys().next().value);
}
function cfCooldownLeft() { return Math.max(0, cfCooldownUntil - Date.now()); }

/* ------------------ CF 通行证（cookie + UA）进程内短缓存 ------------------
   为什么要有这一段：danbooru 的**接口和图床都在 Cloudflare 后面**。接口能靠本机 Chrome
   渲染捞回来（cfRender），但图片字节没法从渲染层拿（Chrome 对一张图只会给 <img> 外壳）——
   于是 /api/proxy 打 cdn.donmai.us 一直是 403 挑战页，只能让**浏览器自己直连图床**
   （代价：用户 IP 暴露给图床，这正是本轮要改掉的）。
   办法：cfRender 成功那一刻，用同一条 CDP 连接把这次「过了验证」的浏览器状态取出来：
     · cookie —— 浏览器里的 cookie 里，只留属于这个站点 zone 的（逐条按 domain 过滤）；
     · User-Agent —— 页面自己看到的 navigator.userAgent（Emulation 覆盖后的那个）。
   cf_clearance 绑定**出口 IP + UA**，所以这两样必须成对、原样带上，而且：
     · 出口一致：Chrome 启动时带的 --proxy-server 就是网关自己的出口（见 cfLaunch）；
     · UA 用页面里读到的那个，不是 UA_CHROME，也不是 headless 的 UA。
   只在**进程内存**里（Map + TTL）：不写盘、不进日志 —— 日志最多说「缓存了几个、主机是谁」。
   ------------------------------------------------------------------------ */
const CF_CRED_TTL = 15 * 60e3;    /* 通行证 15 分钟：太短会频繁惊动 Chrome，太长会拿着失效凭证空打 */
const CF_CRED_MAX = 16;           /* 主机条目上限（实际只会有 danbooru 一族） */
const cfCreds = new Map();        /* host / zone -> { at, ua, cookies:[{name,value,domain,path}] } */

/** 主机名 → 查询键：先精确主机，再退到 zone（后两段，如 cdn.donmai.us → donmai.us）。
 *  为什么要 zone：cfRender 渲染的是接口域 danbooru.donmai.us，而要代取的是图床域
 *  cdn.donmai.us；cf_clearance 常挂在 zone（.donmai.us）上，一份凭证得能被同 zone 查到。 */
function cfCredKeys(host) {
  const h = String(host || '').toLowerCase().replace(/^\./, '').replace(/:\d+$/, '');
  const out = [];
  if (h) out.push(h);
  const p = h.split('.');
  if (p.length > 2) {
    const zone = p.slice(-2).join('.');
    if (out.indexOf(zone) < 0) out.push(zone);
  }
  return out;
}

/** cookie 的 domain 能不能发给这个主机（host-only 与 .zone 两种都按后缀规则判） */
function cfCookieDomainMatch(domain, host) {
  const d = String(domain || '').toLowerCase().replace(/^\./, '');
  const h = String(host || '').toLowerCase();
  if (!d || !h) return false;
  return d === h || (h.length > d.length && h.slice(-(d.length + 1)) === '.' + d);
}

/** cookie 的 path 能不能发给这个请求路径 */
function cfCookiePathMatch(cpath, reqPath) {
  const cp = String(cpath || '/');
  const rp = String(reqPath || '/');
  if (cp === '/' || cp === rp) return true;
  if (rp.indexOf(cp) !== 0) return false;
  return cp.slice(-1) === '/' || rp.charAt(cp.length) === '/' || rp.charAt(cp.length) === '?';
}

/** 某一条记录的所有别名键（主机 + zone）一起清掉 */
function cfCredExpire(rec) {
  let n = 0;
  for (const [k, v] of Array.from(cfCreds.entries())) if (v === rec) { cfCreds.delete(k); n++; }
  return n;
}

/** 取一份还没过期的凭证；过期即删（连别名键一起）—— 拿不到就当作「没有缓存」，调用方走直连 */
function cfCredGet(host) {
  for (const k of cfCredKeys(host)) {
    const hit = cfCreds.get(k);
    if (!hit) continue;
    if (Date.now() - hit.at > CF_CRED_TTL) { cfCredExpire(hit); continue; }
    return hit;
  }
  return null;
}

/** 存一份凭证：主机键与 zone 键指向同一条记录；条数超上限按插入序淘汰 */
function cfCredStore(host, cookies, ua) {
  const rec = { at: Date.now(), ua: String(ua || ''), cookies: cookies || [] };
  for (const k of cfCredKeys(host)) cfCreds.set(k, rec);
  while (cfCreds.size > CF_CRED_MAX) cfCreds.delete(cfCreds.keys().next().value);
  return rec;
}

/** 丢掉某个主机的凭证（上游说这张通行证不好使了 → 立刻回到「今天的直连透传」） */
function cfCredDrop(host) {
  let n = 0;
  for (const k of cfCredKeys(host)) if (cfCreds.delete(k)) n++;
  return n;
}

/** 给这个主机 + 这个路径算一条 Cookie 头；没有可用凭证时返回 null（= 一个字段都不加） */
function cfCredHeaderFor(host, pathname) {
  const rec = cfCredGet(host);
  if (!rec) return null;
  const path = String(pathname || '/');
  const parts = (rec.cookies || [])
    .filter(c => c && c.name && cfCookieDomainMatch(c.domain, host) && cfCookiePathMatch(c.path, path))
    .map(c => c.name + '=' + c.value);
  if (!parts.length) return null;
  return { cookie: parts.join('; '), ua: rec.ua || '', count: parts.length };
}

/** 只有 danbooru 这一族（*.donmai.us）会被注入凭证 —— 别的主机**一个字段都不加**（硬要求） */
function cfCredInjectable(host) { return DANBOORU_CF_HOST_RE.test(String(host || '')); }

/** 「带出去的凭证被否了」的判定：CF 的拦截页（403/429/503/520–527 或 cf-mitigated 头）。
 *  只看状态码与响应头，不去猜图片二进制里有没有挑战页字样。 */
function cfCredRejected(status, headers) {
  if (/challenge/i.test(cfMitigatedHeader(headers))) return true;
  const st = Number(status) || 0;
  return st === 403 || st === 429 || st === 503 || (st >= 520 && st <= 527);
}

/** 给 /api/ping 看的只读摘要：主机 + cookie 条数 + 多久前抓的（**绝不含 cookie 值**） */
function cfCredSummary() {
  const seen = [];
  const out = [];
  for (const k of Array.from(cfCreds.keys())) {
    const rec = cfCredGet(k);
    if (!rec || seen.indexOf(rec) >= 0) continue;
    seen.push(rec);
    out.push({
      host: k, cookies: (rec.cookies || []).length,
      ageSec: Math.round((Date.now() - rec.at) / 1000),
      ttlSec: Math.round(CF_CRED_TTL / 1000)
    });
  }
  return out;
}

/** cfRender 成功那一刻的「过验证状态快照」→ 进程内存。
 *  抓不到也不抛：JSON 已经取回来了，只是图片这一路回到今天的直连行为。
 *  cookie 值只进内存，绝不写盘、绝不进日志。 */
async function cfCredCapture(url, sid) {
  const host = stripHost(url);
  try {
    let ua = '';
    try { ua = String((await cfEval('navigator.userAgent', sid)) || ''); } catch (e) {}
    if (!ua) ua = String(cfState.ua || '');
    /* 优先要「浏览器里全部 cookie」再按 zone 过滤（图床域上那份如果有，也能一起拿到）；
       Storage 域不好使时退回只问这次渲染的那个地址。 */
    let list = [];
    try {
      const r0 = await cdpSend('Storage.getCookies', {}, sid);
      list = (r0 && r0.cookies) || [];
    } catch (e) {
      const origin = (String(url).match(/^(https?:\/\/[^/]+)/i) || [])[1] || '';
      const r1 = await cdpSend('Network.getCookies', { urls: [origin + '/'] }, sid);
      list = (r1 && r1.cookies) || [];
    }
    /* 抓取范围按 **zone**（donmai.us），不是只按渲染的那个主机：渲染的是 danbooru.donmai.us，
       而要代取的是 cdn.donmai.us —— 图床域上那份 host-only 的 cookie 也必须一起收下
       （cf_clearance 通常挂在 zone 上，但不保证；只按 host 收就会漏掉它，图片代理白跑一趟 403）。
       发送时仍由 cfCredHeaderFor 按「请求主机 ↔ cookie 的 domain/path」逐条过滤，
       所以只会发回它自己的域，绝不会串给别的主机（其它源的透传依旧逐字节不变）。 */
    const zone = cfCredKeys(host).slice(-1)[0];
    const inZone = d0 => {
      const d = String(d0 || '').toLowerCase().replace(/^\./, '');
      return !!d && (d === zone || d.slice(-(zone.length + 1)) === '.' + zone);
    };
    const kept = list.filter(c => c && c.name && inZone(c.domain)).map(c => ({
      name: String(c.name),
      value: String(c.value == null ? '' : c.value),
      domain: String(c.domain || ''),
      path: String(c.path || '/')
    }));
    if (!kept.length) {
      log('CF 通过：这次没取到可复用的 cookie（主机 ' + host + '），/api/proxy 照旧直连透传');
      return null;
    }
    const rec = cfCredStore(host, kept, ua);
    log('CF 通过：已缓存 ' + kept.length + ' 个 cookie，主机 ' + host + '（' +
      Math.round(CF_CRED_TTL / 60000) + ' 分钟内 /api/proxy 对 *.donmai.us 带上它，UA 一并带上）');
    return rec;
  } catch (e) {
    log('CF 通过，但 cookie 缓存失败（不影响取数，图片回到直连）：' + ((e && e.message) || e));
    return null;
  }
}

/** 一次性闯关：起一个全新的 Chrome（全新 profile）→ 过验证 → 取 HTML → 关掉。
 *  为什么要「一次性」：实测这个站只在浏览器刚起来的那一次验证上放行，
 *  同一个 Chrome 里连着闯第二次就会被 CF 卡死在「Just a moment…」；
 *  换新浏览器（含新 profile）则次次都过。所以这里不省这点启动开销。
 *  失败不重试，直接进冷却 —— 连着重试只会把出口 IP 的名声烧得更差。 */
async function cfRender(url, opt) {
  opt = opt || {};
  const timeout = opt.timeout || 40000;
  /* 「这页算取到了」的正文长度门槛。默认 500（porn-comic 的列表页）；
     但 danbooru 的 JSON 查看器页面只有 <pre> 里那点 JSON，小条目的正文可能不到 500 字节，
     所以允许调用方调低（见 cfFetchWithSolver 的 minBody）。 */
  const minBody = Number(opt.minBody) > 0 ? Number(opt.minBody) : 500;
  if (!opt.force) {
    const cached = cfCacheGet(url);
    if (cached) { log('CF 缓存命中：' + url.replace(/^https:\/\/[^/]+/, '')); return cached; }
    const left = cfCooldownLeft();
    if (left > 0) {
      throw new Error('Cloudflare 刚拒绝了验证，冷却中（还有 ' + Math.ceil(left / 1000) + ' 秒）' +
        (cfLastErr ? '：' + cfLastErr : ''));
    }
  }
  const task = async () => {
    await cfPinHostForChrome(url);          /* 先钉 IP：Chrome 不认 DoH，只认系统 DNS */
    await cfLaunch();                       /* 每次都用「刚起来的」浏览器 */
    const page = await cfOpenPage();
    let last = null;
    try {
      await cdpSend('Page.navigate', { url: url }, page.sid);
      const deadline = Date.now() + timeout;
      let seenTitle = '';
      /* ★readyWhen / readyGrace：等「真的渲染出来了」再抓★
         只看正文字节数会被**骨架页**骗过去：porn-comic 的标签页先出骨架，
         作品网格随后异步补上，两个阶段的 innerHTML 只差几千字节
         （实测 /tags/naruto.html：1s 时 13509B、0 个 a.thumb，页面标题却已经是
          "naruto comics Page 1 - porn-comic"）。旧逻辑在这一刻就判「取到了」并抓走，
         结果是一张**没有任何作品链接**的真页面 —— 上层只能报「0 条」或「站点改版」。
         调用方用 opt.readyWhen(st) 说清「什么时候才算就绪」（例如 thumbs>0）；
         一直不就绪也不会死等：给 readyGrace 毫秒，到点仍按「至少不是挑战页」抓回去。 */
      let fallbackAt = 0, captured = '', challengeAt = 0, sig = '', sigAt = 0;
      const challengeGrace = Number(opt.challengeGrace) || 6000;
      /* 列表页是**渐进渲染**的：第一条作品链接出现时后面往往还有几十条。
         只看「有没有列表」会抓到一个只含 1 条的真页面（实测 fate 只回了 1 条）。
         所以再加一层「稳定判据」：条目数/正文规模连续 readyStableMs 毫秒不变，
         才认为这一页渲染完了。 */
      const stableMs = Number(opt.readyStableMs) || 1200;
      const capture = async () => {
        const html = await cfEval('document.documentElement.outerHTML', page.sid);
        if (!html) return '';
        cfState.renders++; cfState.solvedAt = Date.now(); cfState.lastOkAt = Date.now();
        cfCacheSet(url, String(html));
        /* 顺手把「这次过了验证」的 cookie + UA 记进内存 —— /api/proxy 代取 *.donmai.us
           的图片要用它（cf_clearance 绑 IP + UA，所以两样一起存、一起带）。
           抓不到不影响本次取数，见 cfCredCapture。 */
        await cfCredCapture(url, page.sid);
        return String(html);
      };
      while (Date.now() < deadline) {
        await sleep(600);
        const st = await cfEval(CF_PROBE_JS, page.sid);
        if (!st || typeof st !== 'object') continue;
        last = st;
        if (st.title !== seenTitle) {
          seenTitle = st.title;
          log('  CF[' + url.replace(/^https:\/\/[^/]+/, '') + '] ' + Math.round((Date.now() - (deadline - timeout)) / 1000) + 's 标题="' + String(st.title).slice(0, 60) + '" len=' + st.body + ' dom=' + st.dom + ' 列表=' + (st.thumbs || 0) + '/' + (st.works || 0));
        }
        if (/^chrome-error:/i.test(String(st.href))) throw new Error('Chrome 打不开这个地址（' + st.href + '）');
        /* ★挑战页不要死等★ 标题命中 CF 挑战特征就记时；超过 challengeGrace 还没过去就判失败。
           旧逻辑会一直空转到整个 timeout（默认 40 秒，porn-comic 这条给了 10 秒），
           而实测这一类挑战在本 profile 下**根本不会自己过去** ——
           白等的那几秒本来正是下一个入口（/tags/ 空结果页）要用的。 */
        if (CF_CHALLENGE_RE.test(String(st.title))) {
          if (!challengeAt) challengeAt = Date.now();
          if (Date.now() - challengeAt > challengeGrace) {
            throw new Error('Cloudflare 验证没通过（等了 ' + Math.round(challengeGrace / 1000) +
              's 仍是「' + String(st.title).slice(0, 40) + '」）');
          }
        } else { challengeAt = 0; }
        const settled = !st.dom && !CF_CHALLENGE_RE.test(String(st.title)) && st.body > minBody;
        if (settled) {
          const ready = !opt.readyWhen || opt.readyWhen(st);
          if (ready) {
            /* 用「条目数 + 正文规模（按 2KB 分桶）」当指纹：任一变化都说明还在加载 */
            const fp = (st.thumbs || 0) + ':' + (st.works || 0) + ':' + Math.round(st.body / 2000);
            if (fp !== sig) { sig = fp; sigAt = Date.now(); }
            if (Date.now() - sigAt >= stableMs) {
              await sleep(500);                   /* 末条图/标题补完 */
              captured = await capture();
              if (captured) return captured;
            }
          } else if (!fallbackAt) {
            fallbackAt = Date.now();
          }
        }
        if (fallbackAt && Date.now() - fallbackAt > (Number(opt.readyGrace) || 6000)) {
          captured = await capture();
          if (captured) {
            log('  CF[' + url.replace(/^https:\/\/[^/]+/, '') + '] 等够 ' +
              Math.round((Number(opt.readyGrace) || 6000) / 1000) + 's 仍未就绪，按当前 DOM 抓回（列表=' +
              (last && last.thumbs || 0) + '/' + (last && last.works || 0) + '）');
            return captured;
          }
        }
      }
      throw new Error('Cloudflare 验证没通过（' + ((last && last.title) || '无标题') + '）');
    } finally {
      await cfClosePage(page);
      cfStop();                                  /* 关掉浏览器并删掉 profile，下次重新来 */
    }
  };
  const p = cfState.chain.then(task, task);
  cfState.chain = p.then(() => undefined, () => undefined);
  return p.then(html => { cfConsecFails = 0; return html; }, e => {
    cfConsecFails++;
    cfLastErr = (e && e.message) || String(e);
    /* 环境性失败（Chrome 起不来）跟「这次挑战没过」要分开：前者重试也没用，直接长冷却 */
    const envFail = /Chrome 没能启动|调试连接失败|浏览器不可用|无法启动/.test(cfLastErr);
    const wait = (envFail || cfConsecFails >= 2) ? CF_FAIL_COOLDOWN : CF_FAIL_SOFT_COOLDOWN;
    cfCooldownUntil = Date.now() + wait;
    cfState.lastFailAt = Date.now();               /* /api/ping 据此把 available 降级成 false */
    log('CF 验证失败（本进程连续第 ' + cfConsecFails + ' 次' + (envFail ? '，环境性' : '') + '），' +
      Math.round(wait / 1000) + ' 秒内不再硬闯：' + cfLastErr);
    throw e;
  });
}

/* ==========================================================================
   通用「先直连、撞 CF 再交给 Chrome」的取数 + 结果复用
   --------------------------------------------------------------------------
   给 danbooru（接口与图床都在 CF 后面）用；porn-comic 那条路继续走自己的 pcFetchPage。
   实测（网关出口 = 本地代理 127.0.0.1:7897，2026-09）：
     · GET https://danbooru.donmai.us/posts/1.json
         → HTTP 403，正文 "Just a moment…"，响应头 cf-mitigated: challenge
         → 同一个 URL 在用户浏览器里是 HTTP 200 + 合法 JSON（浏览器自己有 CF 通行证）
     · GET https://cdn.donmai.us/180x180/<md5>.jpg（经网关 /api/proxy）
         → 同一个 403 挑战页，**带不带 Referer 完全一样**（所以不是防盗链，是 CF）
         → 用户浏览器直连同一个 URL → 200 真出图
   两条结论决定了下面的实现：接口必须靠 Chrome 渲染捞回来；图片只能让浏览器自己去取。
   ========================================================================== */
const CF_HOST_BLOCK_MS = 10 * 60e3;   /* 某主机「必须过 CF」的记忆时长（比死布尔 pcNeedsRender 稳） */
const cfHostBlocked = new Map();      /* host -> 最近一次被 CF 挡住的时间戳 */

function cfHostBlockedRecently(host) {
  const at = cfHostBlocked.get(host) || 0;
  if (!at) return false;
  if (Date.now() - at < CF_HOST_BLOCK_MS) return true;
  cfHostBlocked.delete(host);         /* 过期就再直连试一次：换出口代理/CF 改判都能自己恢复 */
  return false;
}
function cfMarkHostBlocked(host) { if (host) cfHostBlocked.set(host, Date.now()); }

/** 把 HTML 实体还原（Chrome 的 outerHTML 里 " < > & 都是转义过的，不还原会 JSON.parse 失败） */
function cfHtmlUnescape(s) {
  return String(s || '')
    .replace(/&(quot|#34|#x22);/gi, '"')
    .replace(/&(apos|#39|#x27);/gi, "'")
    .replace(/&(lt|#60|#x3c);/gi, '<')
    .replace(/&(gt|#62|#x3e);/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&(amp|#38|#x26);/gi, '&');     /* & 一定放最后，否则会把 &amp;lt; 还原错 */
}

/** 从 Chrome 渲染出来的页面里把 JSON 抠回来。
 *  Chrome 打开一个 JSON 地址时会套一个查看器，实测 DOM 是
 *    <html><head>…</head><body><pre style="word-wrap:break-word;white-space:pre-wrap;">{…}</pre></body></html>
 *  所以先取 <pre> 的文本；顺带对整个 <body> 去标签再试一次（结构变了也不至于立刻放弃）。
 *  返回解析好的值；抠不出来返回 null（调用方据此报「Chrome 取回来了但不是 JSON」，绝不静默）。 */
function cfJsonFromRenderedHtml(html) {
  const s = String(html || '');
  const tries = [];
  const pre = s.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (pre) { tries.push(pre[1]); tries.push(pre[1].replace(/<[^>]+>/g, '')); }
  const body = (s.match(/<body[^>]*>([\s\S]*)<\/body>/i) || [])[1];
  if (body) tries.push(body.replace(/<[^>]+>/g, ''));
  if (/^\s*[[{]/.test(s)) tries.push(s);
  for (const raw of tries) {
    const txt = cfHtmlUnescape(raw).trim();
    if (!txt) continue;
    try { return JSON.parse(txt); } catch (e) { /* 换下一个候选 */ }
  }
  return null;
}

/** 先直连，判定为 CF 挑战页就改走 cfRender（本机 Chrome）重取。
 *  opt: { what, headers, timeout, okRe, minBody, renderTimeout, pre }
 *    · okRe —— 「这是真内容」的特征（命中就不当挑战页）
 *    · pre  —— 调用方已经拿到的响应（省一次直连请求），需要 { status, headers, text() }
 *  返回 { text, status, via }，via = 'http' | 'chrome'。
 *  失败一律抛中文错误，并且**保证不会把挑战页当成正文返回**。 */
async function cfFetchWithSolver(url, opt) {
  opt = opt || {};
  const what = opt.what || ('取 ' + stripHost(url));
  const host = stripHost(url);
  let r = opt.pre || null;
  if (!r && !cfHostBlockedRecently(host)) {
    try {
      r = await outFetch(url, { timeout: opt.timeout || 15000, headers: opt.headers });
    } catch (e) {
      /* 连不上也可能是 CF 在 TLS 层就掐了（浏览器过得去、Node 过不去）→ 有 Chrome 就试一次 */
      if (cfUnavailableReason()) {
        throw new Error('连不上 ' + what + '：' + ((e && e.message) || e) +
          '；本机 Chrome 通道也不可用（' + cfUnavailableReason() + '）');
      }
      cfMarkHostBlocked(host);
      log(what + '：直连失败（' + ((e && e.message) || e) + '），改走本机 Chrome 过验证');
      r = null;
    }
  }
  if (r) {
    const text = typeof r.text === 'function' ? r.text() : String(r.text || '');
    if (!cfIsChallenge(r.status, r.headers, text, opt.okRe)) {
      if (r.status >= 400) {
        throw new Error(readerUpstreamErr(what, { status: r.status, buf: Buffer.from(text, 'utf8') }));
      }
      return { text: text, status: r.status, via: 'http' };
    }
    cfMarkHostBlocked(host);
    log(what + '：被 Cloudflare 挡住（HTTP ' + r.status + '），切换本机 Chrome 过验证');
  }
  /* Chrome 通道不可用就别白等（cfRender 也会抛，但这里能连原始状态码一起说清楚） */
  if (cfUnavailableReason()) {
    throw new Error(cfSolverHint(what + '（直连被 Cloudflare 挡住，HTTP ' +
      ((r && r.status) || '网络错误') + '）', null));
  }
  let html;
  try {
    html = await cfRender(url, { timeout: opt.renderTimeout || 45000, minBody: opt.minBody });
  } catch (e) {
    throw new Error(cfSolverHint(what, e));       /* cfRender 自带的 90 秒冷却在这里被如实说出来 */
  }
  if (cfChallengeHtml(html)) {
    /* 双保险：cfRender 自己已经拦过挑战页，这里再确认一次 —— 绝不把挑战页当正文往上送 */
    throw new Error(cfSolverHint(what + '：Chrome 取回来的仍是 Cloudflare 挑战页（这次验证没通过）', null));
  }
  return { text: String(html), status: 200, via: 'chrome' };
}

/* ==========================================================================
   porn-comic.com —— 纯 HTML 站，全站前置 Cloudflare 人机验证
     搜索入口 /q/{关键词}-{页}.html（302 到 /tags/{词}.html 或 search 子域）
     兜底 /tags/{关键词}.html、/language/{语言}.html、/h/ 列表
     列表结构：<a class="thumb" href="/h/872078.html" title="…"><img src="…"></a>
     先用普通请求打；一旦被 CF 挡住，就自动切到上面的 Chrome 通道（并记住）
   ========================================================================== */
const PC_BASE = 'https://porn-comic.com';
const PC_HEADERS = {
  accept: 'text/html,application/xhtml+xml',
  referer: PC_BASE + '/',
  cookie: 'age_verified=1; adult=1'
};

function pcSlug(q) {
  return String(q || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9\-_]/g, '');
}

function pcParse(html, host, limit) {
  const base = 'https://' + (host || 'porn-comic.com');
  const out = [], seen = {};
  const re = /<a\b[^>]*class="[^"]*\bthumb\b[^"]*"[^>]*>[\s\S]{0,400}?<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const seg = m[0];
    const href = (seg.match(/href="([^"]+)"/) || [])[1] || '';
    if (!/^\/(h|hentai|gif)\/\d+\.html$/.test(href)) continue;
    const id = (href.match(/\/(\d+)\.html/) || [])[1] || href;
    if (seen[id]) continue;
    seen[id] = 1;
    const imgTag = (seg.match(/<img\b[^>]*>/) || [])[0] || '';
    const cover = (imgTag.match(/src="([^"]+)"/) || [])[1] || '';
    let title = (seg.match(/title="([^"]*)"/) || [])[1] || (imgTag.match(/alt="([^"]*)"/) || [])[1] || '';
    title = title.replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
    out.push({
      id: id, title: title || ('porn-comic #' + id), cover: cover,
      url: base + href, artist: '', tags: [], pages: null, note: 'porn-comic · HTML'
    });
    if (out.length >= limit) break;
  }
  return out;
}

/* 三条通路的「暂时别试了」时间戳。用时间戳而不是布尔量：
   VPN 开关、中继限流都是**会变**的状态，钉死成 true 就再也回不来了。 */
let pcDirectDeadUntil = 0;
let pcRelayDeadUntil = 0;
/* ★Chrome 通道也要有熔断★（本轮新增，2026-09-22 实测）
   症状：这个站点在本机**完全够不着** —— 浏览器直连 `ERR_CONNECTION_TIMED_OUT`、
   网关直连 403（CF）、公共中继整条超时、Chrome 通道起不来（沙箱禁命名管道）。
   但没有熔断时，**每一次检索**都要把 Chrome 路径完整走一遍（每次挑战宽限 4.5s），
   实测一轮搜索里它连撞 30 次、每次 6–9 秒 —— 这正是「porn-comic 偶尔超时」的真相：
   不是偶尔，而是它每次都在偷前端聚合器 22 秒预算里的一大块。
   所以：连续失败 3 次就熔断 15 分钟（成功一次立刻清零），冷却期内**直接跳过** Chrome。
   站点恢复时最多等 15 分钟就能自己回来（熔断到期后第一条检索会真试一次）。 */
const PC_CHROME_FAIL_LIMIT = 3;
const PC_CHROME_COOLDOWN = 15 * 60e3;
let pcChromeDeadUntil = 0;
let pcChromeFails = 0;

/* ★「超时」的根因就在这里，改之前先看清账★（2026-09-21 实测，本机出口）
     直连  → HTTP 403（CF 挡），**快**（<1s），且一次就够（进 5 分钟冷却）
     中继  → 公共代理（allorigins / allorigins-get）现在**整体在超时**：
           中继内部是「逐个中继各给一份 timeout」，两个中继 × 20s = 40s 的潜在开销，
           实测冷启动一次就吃掉 16–18s —— 把整个预算耗光，连 Chrome 都轮不上
     本机 Chrome → 过验证成功能取到真页面，**每次 6–9 秒**，是本环境下唯一真能出数的通路
   于是「一次成功检索」= 0.5s + 20s + 6s ≈ 26.5s，而前端聚合器的硬上限只有 22s
   （sources.js 的 RUN_CAP_MS）—— 结果就是用户看到的「porn-comic 经常超时无返回」。

   四处改动，缺一不可：
     ① **通路顺序改成 直连 → 本机 Chrome → 中继**。
        旧顺序把中继排在 Chrome 前面，理由是「中继比 Chrome 稳」；那是中继还能用时的结论，
        现在实测反了：中继每次都超时，Chrome 每次都能出数。把最不可能成功的排在最前，
        等于每次检索都先白等十几秒。中继退到最后当「Chrome 起不来时」的兜底。
     ② 中继超时 20s → 6s，并且**只给它剩余预算**（不再吃满全线）；
        中继失败冷却 60s → 3 分钟（它是整条链在超时，不是偶发 522）。
     ③ **记住上一条走得通的通路**，下次先走它（10 分钟内有效）——
        Chrome 一旦通，后续检索直接落在 6–9 秒，不必每次重走一遍直连。
     ④ 每条通路都受**总预算**约束：预算耗尽就跳过、cfRender 也带上剩余时间，
        保证 pcFetchPage 一定在 PC_BUDGET_MS 内返回（不管成功还是失败）。 */
/* ★第 16 轮（2026-09-23）重定标：私有中继取 porn-comic 的实测分布是 1.6–2.9s，
   90 百分位约 3.9s，偶发 5.4s（tools/_p11.js / _p14.js / _p16 实测）。旧值 6000/5000
   把「偶发 5.4s」判成失败，而那次失败又会锁住唯一能通的通路（见 PC_RELAY_COOLDOWN）。
   6 秒 → 8 秒：给偶发慢响应留量，同时仍受 PC_HARD_MS 总闸约束。 */
const PC_RELAY_TIMEOUT = 8000;
/* 3 分钟 → 30 秒：中继失败（超时/挑战）只是**这一刻**打不通，锁 3 分钟等于把
   后面几次用户检索全部推给 6–9s 的 Chrome（实测就是这么整轮硬闸超时的）。 */
const PC_RELAY_COOLDOWN = 30e3;
const PC_DIRECT_TIMEOUT = 8000;
/* Chrome 单次上限：它能出数的页面 6–9 秒就出来了，出不来的是**挑战页**（永远不会就绪）。
   给 10 秒足够，多给的每一秒都是在偷下一个入口的预算。 */
const PC_CHROME_TIMEOUT = 9000;
const PC_BUDGET_MS = 9000;          /* 单次取页的总预算（第 8 轮 20000 → 8000 → 第 16 轮 9000） */
/* 9000 = 前端整源预算 9500ms（assets/js/sources.js:1302 的 BUDGET）再减 500ms 余量：
   硬闸必须早于前端自己的超时，真实原因才带得回来；聚合器总闸 RUN_CAP_MS = 9500。
   （第 16 轮 8000/7500 → 9500/9000：私有中继偶发 5.4s + Chrome 6–9s 都需要这点余量） */
const PC_HARD_MS = 9000;            /* ★第 11 轮引入、第 16 轮重定标★ 函数级硬闸 */
const PC_STICKY_MS = 10 * 60e3;     /* 「上次走通的那条路」有效期 */

let pcLastGood = { ch: '', at: 0 };

/* 判断是不是 CF 的验证中间页。
   注意：正常页面里也会引用 cdn-cgi/challenge-platform 的脚本，所以绝不能只看那个字符串 ——
   先认列表特征（a.thumb / 作品链接），有列表就一定是真页面。
   挑战页本身复用通用的 cfChallengeHtml；状态码/响应头那一层交给 cfIsChallenge。 */
const PC_OK_RE = /class="[^"]*\bthumb\b|href="\/(h|hentai|gif)\/\d+\.html"/;
function pcIsChallenge(html) {
  return !PC_OK_RE.test(String(html || '')) && cfChallengeHtml(html);
}

/** 这一页到底算不算「站点真的把页面给我们了」（不是挑战页、不是错误页） */
function pcLooksReal(html) {
  const s = String(html || '');
  if (s.length < 2048) return false;
  return !cfChallengeHtml(s);
}

/* ★站点自述「没有这个结果」★
   实测 /tags/zzqqxxqqzz.html 渲染后 <title> 就是 `zzqqxxqqzz no result`
   —— 这是站点自己给的、精确无疑的空结果标记，比任何启发式都可靠。
   只有认到这个标记才敢回答「0 条」；「真页面 + 0 个 a.thumb」不算数
   （那可能是列表还没渲染完 / 站点改版），得继续试下一个入口。 */
function pcNoResult(html) {
  const s = String(html || '');
  const m = s.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
  return !!(m && pcNoResultTitle(m[1]));
}
/** 同一个判据的「只有标题」版本：CF 探针在页面里就能拿到 title，不用等 outerHTML */
function pcNoResultTitle(t) { return /\bno\s+result/i.test(String(t || '')); }

/** 取一页，三条通路依次试；带总预算 + 「上次走通的那条优先」 */
async function pcFetchPage(pathname, budgetMs, opts) {
  opts = opts || {};
  const url = PC_BASE + pathname;
  const budget = budgetMs || PC_BUDGET_MS;
  const deadline = Date.now() + budget;
  const left = () => deadline - Date.now();
  const now = Date.now();
  log('  [pc] ' + pathname + ' 预算 ' + budget + 'ms（directDead=' + Math.max(0, pcDirectDeadUntil - Date.now()) +
    ' relayDead=' + Math.max(0, pcRelayDeadUntil - Date.now()) + ' chromeDead=' + Math.max(0, pcChromeDeadUntil - Date.now()) +
    ' allowRelay=' + (opts.allowRelay !== false) + ' forceChrome=' + !!opts.forceChrome + '）');

  const byDirect = async () => {
    const r = await outFetch(url, { headers: PC_HEADERS, timeout: Math.min(PC_DIRECT_TIMEOUT, left()) });
    const html = r.text();
    if (!cfIsChallenge(r.status, r.headers, html, PC_OK_RE)) {
      return { html: html, status: r.status, via: planOf('porn-comic.com') || 'http' };
    }
    pcDirectDeadUntil = Date.now() + 5 * 60e3;
    log('porn-comic 直连被 Cloudflare 挡住（HTTP ' + r.status + '），改试中继 / 本机 Chrome');
    return null;
  };

  const byRelay = async () => {
    /* 中继不转 cookie，也不该转；实测这几个页面本来就不需要 cookie。
       ⚠ 中继内部是「逐个中继各给一份 timeout」⇒ 真正的开销是 timeout × 中继条数。
       给它**人均一份剩余预算**，既不超过 PC_RELAY_TIMEOUT，也保证整条中继链
       在 left() 之内收手 —— 旧版让每个中继各吃满 20 秒，实测冷启动一次就耗掉 16–18 秒。 */
    /* ★私有腿要有地板 + 单独的腿预算★（第 16 轮实测）：
       自建中继取 porn-comic 主页只要 886ms、/tags/anal.html 要 2286ms，而「人均分摊」
       在 5 条腿时只算出 1200ms⇒2s 下限 —— 正好把 2286ms 那一次卡在门外，整条中继通路
       被判死并进 3 分钟冷却（表现为「只有 chrome 一条错误」）。
       更关键的是：中继腿的预算是按**本次请求总预算的 60%** 算的，总预算 4000ms 时私有腿
       只有 2400ms，实测网络日志就是「private 连不上 porn-comic.com：timeout」。
       所以这里①把本次请求总预算提到 PC_RELAY_TIMEOUT(8s)，②用 relayLegMs 明确告诉
       outFetch「这条私有腿单独给 7s」（整链仍受 left() 与硬闸约束）。
        第 16 轮复测（tools/_p16-out.txt）：中继取 /tags/anal.html 连续 6 次 = 2945/1741/1582/1652/
        1750/1632ms，偶发一次 5.4s ⇒ 旧的 5s 腿预算会把偶发慢响应判成失败，提到 7s。 */
    const t = Math.max(3000, Math.min(PC_RELAY_TIMEOUT, left() - 500));
    const r = await outFetch(url, {
      headers: { accept: PC_HEADERS.accept, referer: PC_HEADERS.referer },
      timeout: t, relayOnly: true, relayLegMs: 7000
    });
    const html = r.text();
    if (!cfIsChallenge(r.status, r.headers, html, PC_OK_RE)) return { html: html, status: r.status, via: 'relay' };
    pcRelayDeadUntil = Date.now() + PC_RELAY_COOLDOWN;
    log('porn-comic 中继取回的也是 CF 挑战页，改走本机 Chrome');
    return null;
  };

  const byChrome = async () => {
    /* Chrome 通道已经确认过标题和正文，这里直接信它。
       ★必须把剩余预算喂给 cfRender★：它默认自己给 40 秒，
       不受外层总预算约束 —— 实测过「预算 19 秒、实际跑了 45 秒」的破口。
       ★readyWhen★：这一站的列表页先出骨架、作品网格随后异步补上，
       只看正文字节数会把骨架页当成成品抓走（见 cfRender 里的注释）。
       三个「真就绪」信号任一成立即可：
         · thumbs/works > 0 —— 作品网格已经渲染出来；
         · 站点自述 no result —— 它已经把「没有结果」写进标题了，等下去也不会有；
         · 不是上面两种就一直等（readyGrace 到点仍按当前 DOM 抓回去，绝不空手而归）。
       force：上一跳是被 search 子域的 CF 挑战挡住的，而这一跳打的是主域 ——
       主域页面前一刻刚渲染成功过，没有理由跟着一起冷却（见 porncomicSearch）。 */
    const html = await cfRender(url, {
      timeout: Math.max(5000, Math.min(left(), PC_CHROME_TIMEOUT)),
      force: !!opts.forceChrome,
      readyWhen: st => !st.dom && ((st.thumbs || 0) > 0 || (st.works || 0) > 0 || pcNoResultTitle(st.title)),
      readyGrace: 5000,
      /* 挑战页在本 profile 下基本不会自己过去，等 4.5 秒足够判死；
         多等的每一秒都是从「下一个入口」的预算里偷的。 */
      challengeGrace: 4500
    });
    return { html: html, status: 200, via: 'chrome' };
  };

  const CH = { direct: byDirect, relay: byRelay, chrome: byChrome };
  /* ★顺序 = 实测成功率 × 速度★：直连最便宜（有 VPN 时就是它）。
     ★第 16 轮（2026-09-23）再改一次：用户自建中继上线后，「中继最慢、Chrome 唯一能出数」
     的旧结论反了★ —— 实测这条私有腿取 porn-comic 主页 886ms / 列表页 2286ms 就拿到**真内容**
     （带 a.thumb 与 /h/<id>.html 链接，PC_OK_RE 判定为真页面），而本机 Chrome 每次 6–9s，
     连不上 5 次还会熔断 7 分钟（chrome-error）—— 8.3% 就是这么来的。
     没有私有腿时维持旧顺序：公共中继已知整条链在超时，排 Chrome 后面当兜底。
     ★中继仍受 allowRelay 约束★（调用方说「不是最后一个入口」时直接不给它机会）：
     旧注释的理由（让它夹在中间吃光下一个入口的预算）在私有腿身上已经不成立 —— 它 1–2s 就回。 */
  const order = opts.allowRelay === false ? ['direct', 'chrome']
    : (PRIVATE_RELAY.length ? ['direct', 'relay', 'chrome'] : ['direct', 'chrome', 'relay']);
  /* 上一次真的走通过的那条，先试它（有效期内）。失败时下面的循环会把其余通路补齐。 */
  if (pcLastGood.ch && (now - pcLastGood.at) < PC_STICKY_MS && CH[pcLastGood.ch]) {
    order.splice(order.indexOf(pcLastGood.ch), 1);
    order.unshift(pcLastGood.ch);
  }

  const errs = [];
  /* 一条通路失败/没拿到真页面时的统一记账（冷却、熔断、错误串都在这里） */
  const recordFail = (id, e) => {
    const msg = e ? (((e && e.message) || e) + '').slice(0, 110) : '没拿到真页面（CF 挑战或空页面）';
    errs.push(id + '：' + msg);
    if (id === 'direct') {
      pcDirectDeadUntil = Date.now() + 5 * 60e3;
      log('porn-comic 直连取不到（' + msg + '），改试中继');
    }
    if (id === 'relay') {
      pcRelayDeadUntil = Date.now() + PC_RELAY_COOLDOWN;
      log('porn-comic 中继没取到（' + msg + '），改走本机 Chrome');
    }
    if (id === 'chrome') {
      pcChromeFails++;
      if (pcChromeFails >= PC_CHROME_FAIL_LIMIT && Date.now() >= pcChromeDeadUntil) {
        pcChromeDeadUntil = Date.now() + PC_CHROME_COOLDOWN;
        log('porn-comic Chrome 通道连续 ' + pcChromeFails + ' 次起不来，熔断 ' +
          Math.round(PC_CHROME_COOLDOWN / 60000) + ' 分钟（不再让每次检索白等）');
      }
    }
  };

  /* ★第 16 轮：直连与中继**并发竞速**★
     实测（tools/_p8.js / _p9.js / _p10.js）：本机直连 porn-comic.com 是 fetch failed ≈10.7s
     （被墙，被 PC_DIRECT_TIMEOUT 截成 8s），而私有中继取主页 886ms、/tags/anal.html 2286ms
     就拿到**真内容**（带 a.thumb 与 /h/<id>.html，PC_OK_RE 判为真页面）。
     旧写法按顺序 await ⇒ 直连一条就吃光 8s 预算，PC_HARD_MS=7500 硬闸到点时中继连机会都没有：
     实测 /api/porncomic/search?q=anal 连续两次都是「超过 7500ms 硬闸」。
     并发之后：谁先拿到真页面就用谁；输的那条照常跑完 —— 它的冷却/熔断状态照样会被记上，
     不会白花那一次请求。 */
  /* ★竞速不要求「两条腿都活着」★（第 16 轮实测定案）
     旧条件 raceable = direct 与 relay **都**不在冷却里。可是本机直连 porn-comic.com 必然失败
     （被墙，实测 fetch failed ≈10.7s），第一次失败就把 direct 记 5 分钟冷却 ⇒ 之后每次检索
     raceable 恒为 false，**竞速整条被跳过**，哪怕私有腿是热的、1–2s 就能拿到真内容。
     实测证据：网关日志 `[pc] /q/anal-1.html 预算 7500ms（directDead=279703 …）` 之后
     直接落到 Chrome（6–9s），7500ms 硬闸到点 —— 这就是 8.3% 的机制。
     现在按**可用腿列表**竞速：≥2 条才竞速，只剩 1 条就交给它（下面的循环会试）。 */
  const liveLegs = [];
  if (Date.now() >= pcDirectDeadUntil) liveLegs.push('direct');
  if (PRIVATE_RELAY.length && opts.allowRelay !== false && Date.now() >= pcRelayDeadUntil) liveLegs.push('relay');
  if (liveLegs.length >= 2) {
    let pending = liveLegs.length;
    const raced = await new Promise(resolve => {
      const done = (id, got, err) => {
        if (got) { resolve({ id: id, got: got }); return; }
        recordFail(id, err);
        pending--;
        if (pending <= 0) resolve(null);
      };
      liveLegs.forEach(id => { CH[id]().then(r => done(id, r, null), e => done(id, null, e)); });
    });
    if (raced) {
      pcLastGood = { ch: raced.id, at: Date.now() };
      log('porn-comic 并发竞速：' + raced.id + ' 先拿到真页面（' + raced.got.via + '）');
      return raced.got;
    }
  }

  for (const id of order) {
    if (left() < 1500) { errs.push(id + '：总预算耗尽，跳过'); continue; }
    /* 已被判死的通路在冷却期内直接跳过，别白等（但要把原因写进错误串，否则故障报告里只剩 Chrome 一条） */
    if (id === 'direct' && Date.now() < pcDirectDeadUntil) {
      errs.push('direct：冷却中（还有 ' + Math.ceil((pcDirectDeadUntil - Date.now()) / 1000) + 's）');
      continue;
    }
    if (id === 'relay' && Date.now() < pcRelayDeadUntil) {
      errs.push('relay：冷却中（还有 ' + Math.ceil((pcRelayDeadUntil - Date.now()) / 1000) + 's）');
      continue;
    }
    /* Chrome 熔断期内直接跳过（否则每次检索都要白等 4.5s 的挑战宽限，实测一轮撞 30 次） */
    if (id === 'chrome' && Date.now() < pcChromeDeadUntil) {
      errs.push('chrome：连续 ' + pcChromeFails + ' 次起不来，已熔断 ' +
        Math.ceil((pcChromeDeadUntil - Date.now()) / 60000) + ' 分钟（避免每次检索都空等）');
      continue;
    }
    try {
      const got = await CH[id]();
      if (got) {
        pcLastGood = { ch: id, at: Date.now() };
        if (id === 'chrome') pcChromeFails = 0;
        return got;
      }
      recordFail(id, null);
    } catch (e) {
      recordFail(id, e);
    }
  }
  const err = new Error('三条通路都没取到：' + (errs.join('；') || '预算耗尽'));
  err.pcErrs = errs;
  throw err;
}

/* ★第 11 轮★：函数级硬闸（绅士漫画同款）。
   原来这里只有一个 19s 的 deadline 自管预算，注释写的是「前端只给每个源 22 秒」——
   那句话早就过期了：前端聚合闸第 8 轮就收到 S.RUN_CAP_MS = 9500
   （assets/js/sources.js:2231），到点把没回来的源标成「超时跳过」并**丢弃迟到结果**
   （sources.js:2362 / :2373-2386）。实测这一源 p95 = 20.0s、30 轮里 3 轮撞满 20s 超时、
   5 轮 >10s，全是在做前端已经不要了的空转。现在外套一条 PC_HARD_MS 硬闸，
   保证 8.5s 内一定给出答复（有货给货，没货如实报错，不再拖住整轮墙钟）。 */
/* ★r18 需求②★ porn-comic 的**成功**结果以前一个都不缓存：每按一次回车，
   直连 / 私有中继 / Chrome 过 CF 三条通路都要重新烧一遍（实测 p95 ≈ 8.5s 撞硬闸）。
   5 分钟进程内缓存 + 60 条上限，与 jm / 拷贝漫画 / 紳士漫畫 同一个口径。 */
const PC_SEARCH_CACHE_MS = 5 * 60e3;
const pcSearchCache = new Map();     // 'q|page|extra' -> { at, out }
async function porncomicSearch(query) {
  const ckey = String(query.q || '').trim().toLowerCase() + '|' +
    (parseInt(query.page || '1', 10) || 1) + '|' + String(query.extra || '').trim();
  const chit = pcSearchCache.get(ckey);
  if (chit && Date.now() - chit.at < PC_SEARCH_CACHE_MS) {
    return Object.assign({}, chit.out, { cached: true, cachedAge: Date.now() - chit.at });
  }
  let timer = null;
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('超过 ' + PC_HARD_MS + 'ms 硬闸（porn-comic 三条通路的总耗时超过预算）')), PC_HARD_MS);
  });
  try {
    const out = await Promise.race([porncomicSearchInner(query), guard]);
    if (pcSearchCache.size > 60) pcSearchCache.delete(pcSearchCache.keys().next().value);
    pcSearchCache.set(ckey, { at: Date.now(), out: out });
    return out;
  } catch (e) {
    const err = new Error('porn-comic 取数失败：' + ((e && e.message) || e));
    err.soft = 1;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function porncomicSearchInner(query) {
  const q = String(query.q || '').trim();
  const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
  const extra = String(query.extra || '').trim();
  const tries = [];
  /* ★规范页 `/tags/<slug>.html` 必须排在 `/q/` 前面★（第 16 轮实测，tools/_p12.js + _p14.js）
     站点的 `/q/` 是个**跳板**，不是结果页：
       · 这个词有标签页时：`/q/anal-1.html` 302 → `/tags/anal.html`（同一份 24 条）；
       · 这个词没有标签页时：`/q/teen-1.html` 302 → `https://search.porn-comic.com/q/teen-1-<hash>.html`，
         而那个子域对**任何**请求都回 403「Just a moment...」（CF 挑战，490ms / 2941ms，换编码一样）。
     实测（经私有中继带 cookie）：
       `/tags/anal.html`  200 / 24 条 / title "anal comics Page 1"
       `/tags/milf.html`  200 / 24 条 / 1103ms
       `/tags/teen.html`  200 / **422ms / "teen no result"** ⇒ 被 pcNoResult 认出来，如实回 0 条
       `/tags/big-boobs.html` 200 / 404ms / "big boobs no result"（多词同理）
       `/q/teen-1.html`   403 / search 子域
     ⇒ 无论单词语还是多词，都先走 `/tags/<pcSlug>`：命中就出数，没命中就在 0.4s 内如实回 0 条。
       旧顺序（`/q/` 优先）会把 7500ms 总预算的第一次机会喂给那个必定 403 的子域，
       第 2 个入口只剩 900ms ⇒ q=teen / q=big boobs 整轮报「超过 7500ms 硬闸」。 */
  const slug = q ? pcSlug(q) : '';
  if (slug) tries.push('/tags/' + slug + '.html');
  if (q) tries.push('/q/' + encodeURIComponent(q) + '-' + page + '.html');
  if (extra) tries.push('/tags/' + pcSlug(extra) + '.html');
  if (!tries.length) tries.push(page > 1 ? '/index-' + page + '.html' : '/h/');

  /* 整个请求的总预算：**必须早于前端 9500ms 聚合闸**给出答复（sources.js:2231 的
     S.RUN_CAP_MS，到点前端会丢弃迟到结果），所以这里跟外面 PC_HARD_MS 对齐。 */
  const deadline = Date.now() + PC_HARD_MS;
  const errs = [];
  /* 上一跳被 search 子域的 CF 挑战挡住时置 1：下一跳允许绕过 CF 冷却再试一次。
     依据：挑战只发生在 /q/ 302 过去的 search.porn-comic.com，
     主域的 /tags/ 页面在同一台机器上刚刚渲染成功过。 */
  let forceChromeNext = false;
  for (let i = 0; i < tries.length; i++) {
    const p = tries[i];
    let left = deadline - Date.now();
    if (left < 2500) { errs.push(p + '：总预算耗尽，未尝试'); break; }
    /* ★中继的准入条件（第 16 轮改）★
       旧规则：中继只留给**最后一个入口**（allowRelay = i === tries.length - 1）。
       理由是当年「公共中继每发都超时、Chrome 才是唯一能出数的通路」，所以不许中继夹在中间吃预算。
       现在私有腿实测取 porn-comic 主页 886ms / 列表页 2286ms 就拿到真内容（PC_OK_RE 判定为真页面），
       而 Chrome 每次 6–9s、连不上 5 次还熔断 15 分钟。旧规则于是变成自伤：
       第一个入口独占 7500ms 预算（只准 direct+chrome），把预算吃光，轮到唯一允许中继的那一跳
       只剩 900ms ⇒ 私有腿拿 600ms ⇒ 必然超时 ⇒ 整轮报「超过 7500ms 硬闸」。
       现在：有私有腿时**每个入口都允许中继**（它便宜），没有私有腿时维持旧规则。 */
    const allowRelay = PRIVATE_RELAY.length ? true : (i === tries.length - 1);
    const stepOpts = { forceChrome: forceChromeNext, allowRelay: allowRelay };
    let r = null;
    try {
      r = await pcFetchPage(p, Math.min(left, PC_BUDGET_MS), stepOpts);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      /* ★「冷却中」不算站点给的答复★
         那是**本进程自己**在限速（上一次 CF 失败留下的 15 秒冷却），这一跳根本没真的试。
         不放行的话，一个刚发生的「无结果」查询会把紧接着的下一次检索一起堵死
         —— 实测就是这样白丢了 hiten 的结果（/q/ 连试都没试就被自己的冷却拦下）。
         还有预算就用 force 真试一次：只重试一次，不递归、不循环。 */
      if (/冷却中/.test(msg) && (deadline - Date.now()) > 4000) {
        try {
          r = await pcFetchPage(p, Math.min(deadline - Date.now(), PC_BUDGET_MS),
            { forceChrome: true, allowRelay: PRIVATE_RELAY.length ? true : false });
        } catch (e2) { r = null; errs.push(p + '：' + (((e2 && e2.message) || e2) + '（绕过冷却重试后）')); }
      }
      if (!r) {
        errs.push(p + '：' + msg);
        /* 被 CF 挑战挡住的是 search 子域，不代表主域也拒我们 —— 放行下一跳绕过冷却 */
        if (/Cloudflare 验证没通过/.test(msg)) forceChromeNext = true;
        continue;
      }
    }
    forceChromeNext = false;
    if (r.status >= 400) { errs.push(p + '：HTTP ' + r.status); continue; }
    const items = pcParse(r.html, 'porn-comic.com', 60);
    if (items.length) {
      return {
        source: 'porncomic', host: 'porn-comic.com', total: items.length,
        items: items.slice(0, 60), via: r.via
      };
    }
    /* ★站点自己说「没有结果」⇒ 就答「0 条」★
       实测这个站把空结果直接写进标题（`zzqqxxqqzz no result`），是精确信号。
       以前这里会继续把**剩下的入口**再撞一遍，于是本来 6–8 秒能给出的
       「0 条」被拖成 60 秒的「超时无返回」—— 这正是用户报的那个症状。 */
    if (pcNoResult(r.html)) {
      return {
        source: 'porncomic', host: 'porn-comic.com', total: 0,
        items: [], via: r.via, empty: true,
        note: 'porn-comic 没有匹配「' + (q || extra || '(浏览)') + '」的作品（站点返回 no result）'
      };
    }
    const why = cfUnavailableReason();
    errs.push(p + '：' + (pcIsChallenge(r.html)
      ? ('被 Cloudflare 人机验证挡住（经 ' + r.via + ' 取回' + (why ? '；Chrome 通道不可用：' + why : '') + '）')
      : ('经 ' + r.via + ' 取回了页面，但结构里没有作品链接，站点也没说 no result（改版？页面 ' + r.html.length + 'B）')));
  }
  throw new Error('porn-comic 没有取到结果（已试 ' + tries.length + ' 条入口：' + tries.join(' / ') +
    '）：' + errs.slice(0, 3).join('；') +
    '。可用手段：直连 / 境内中继 / 本机 Chrome 过验证 —— 三者都失败时多为出口 IP 被 CF 记恨，换个节点再试');
}

/* ==========================================================================
   lectormangas（西语站，现役域名 lector-mangas.lat）—— 服务端渲染的 Astro 页面
   --------------------------------------------------------------------------
   ★为什么是 lector-mangas.lat 而不是 lectormanga.com / lectormangas.com★
     · lectormanga.com       → DNS 无解析
     · lectormangas.com      → **域名停放页**（parklogic 广告路由，不是漫画站）
     · lectormangaa/ss.com   → 301 到 lector-mangas.lat（实测）
     · lector-mangas.lat     → 真站：200、云flare、完整列表/详情/标签/排行
   （旧 TMO 系 visortmo.com / zonatmo.com 已随西警方查封下线，DNS 都不解析了。）

   ★检索参数是 ?search= 不是 ?q=★
     站点自己的 JSON-LD 里写的是 /comics?q={search_term_string}，但实测 **?q= 被忽略**
     （q=naruto 返回的是全库第一页，与不带参数完全一致）；真正生效的是 ?search=：
     ?search=fate → 24 条全是 Fate 系；?search=fate&page=2 → 第 2 页；无结果时返回空列表。
     所以这里只认 search=，并且**不做任何客户端过滤**（过滤会掩盖端点变化）。

   列表结构（服务端渲染，原样可解析）：
     <div id="directory-results"><div class="row manga-grid">
       <div class="col-md-6 col-lg-6 col-xl-4 col-12"> … "8 Capítulos" …
         <a href="/comics/<slug>" class="card-cover-link" title="标题">
           <img src="https://api.zerocomics.net/storage/series/portadas/<id>.webp" …>
     · 必须只在 #directory-results 这一段里抓：页面顶部还有整块「Clasificación」排行，
       用的也是 /comics/<slug> 链接，不切范围会把排行当成检索结果。
     · 封面图在 api.zerocomics.net（独立 CDN，不带 CF 挑战）。

   网络：不带 Access-Control-Allow-Origin（实测）→ 浏览器 fetch 直连必被拦，
        只能经网关或公共代理 —— 与 kemono / porn-comic 同一类。
   ========================================================================== */
/* 域名轮换池：这类站在被查封 / 换域名之间反复横跳，三个都实测过（后两个 301 回主域） */
const LM_DOMAINS = ['lector-mangas.lat', 'lectormangass.com', 'lectormangaa.com'];
/* 第 10 轮：一次检索的总死线（三个域名 + 译词重试共用），理由见 lectormangaSearch */
const LM_BUDGET_MS = 6500;
const LM_HEADERS = {
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'es-ES,es;q=0.9,zh-CN;q=0.8,en;q=0.7'
};

/** 站内相对地址 → 绝对地址（封面已经是绝对地址，这里只兜底） */
function lmAbs(base, href) {
  const h = String(href || '').trim();
  if (!h) return '';
  if (/^https?:\/\//i.test(h)) return h;
  return base + (h.charAt(0) === '/' ? h : '/' + h);
}

function lmDecode(s) {
  return String(s == null ? '' : s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/\s+/g, ' ').trim();
}

/**
 * 解析 #directory-results 里的卡片。
 * 按「列容器」切块（class 里带 col-md-6 / col-lg-6 / col-xl-4 这一组是该站卡片的固定特征），
 * 再在块内取封面锚点 —— 比全页扫 a.thumb 稳，因为页首排行块长得一模一样。
 */
function lmParse(html, base, limit) {
  const out = [], seen = {};
  let scope = String(html || '');
  const i = scope.indexOf('id="directory-results"');
  if (i >= 0) scope = scope.slice(i); else return out;   /* 没有结果容器：当作没结果，绝不猜 */

  const blocks = scope.split(/<div class="col-md-6 col-lg-6 col-xl-4 col-12"/);
  blocks.shift();                                        /* 第 0 段是容器开头，不是卡片 */
  for (const b of blocks) {
    const tagM = b.match(/<a\b[^>]*class="[^"]*\bcard-cover-link\b[^"]*"[^>]*>/);
    if (!tagM) continue;
    const tag = tagM[0];
    const href = (tag.match(/href="([^"]+)"/) || [])[1] || '';
    if (!/^\/comics\/[^"?#]+$/.test(href)) continue;
    const slug = href.replace(/^\/comics\//, '');
    if (!slug || seen[slug]) continue;
    seen[slug] = 1;
    let title = lmDecode((tag.match(/title="([^"]*)"/) || [])[1] || '');
    const rest = b.slice(b.indexOf(tag) + tag.length);
    const imgTag = (rest.match(/<img\b[^>]*>/) || [])[0] || '';
    const cover = lmAbs(base, (imgTag.match(/src="([^"]+)"/) || [])[1] || '');
    if (!title) title = lmDecode((imgTag.match(/alt="([^"]*)"/) || [])[1] || '').replace(/^Portada de\s*/i, '');
    /* 移动端统计块里的「N Capítulos」= 章节数（**不是页数**，所以只写进备注，
       不塞进 pages —— 否则「页数多→少」排序会把连载章节数当成页数比较）。 */
    const chM = b.match(/(\d+)\s*Cap[ií]tulos/i);
    const chapters = chM ? parseInt(chM[1], 10) : 0;
    /* 状态铺在封面上的 chip：/comics?statuses=En%20emisi%C3%B3n */
    const stM = b.match(/statuses=([^"&]+)/);
    let status = '';
    try { status = stM ? decodeURIComponent(stM[1]) : ''; } catch (e) { status = ''; }
    const noteBits = ['LectorManga · HTML'];
    if (chapters) noteBits.push(chapters + ' 章');
    if (status) noteBits.push(status);
    out.push({
      id: slug,
      title: title || slug,
      cover: cover,
      url: lmAbs(base, href),
      artist: '',
      tags: status ? [status] : [],
      pages: null,
      note: noteBits.join(' · ')
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * 取一页：域名池逐个试；每个域名的失败原因都收集起来，全败时一次说清。
 * ⚠ 只打 HTML 一次请求 —— 这个站没有 CF 挑战、不需要 cookie，是纯 HTTPS 直取。
 * 第 10 轮：新增可选参数 deadline（绝对时间戳）。给了它就按**剩余时间**给每个域名
 * 分配超时、预算用完就跳过剩下的域名 —— 否则「3 个域名 × 单域 12s」最多 36s，
 * 实测（本机）真的出现过 10282ms 才回来的英文检索，把整轮拖到 cap 边上。
 */
async function lmFetchPage(selector, timeout, deadline) {
  const errs = [];
  for (const host of LM_DOMAINS) {
    const base = 'https://' + host;
    const url = base + selector;
    let per = timeout || 12000;
    if (deadline) {
      const remain = deadline - Date.now();
      if (remain < 900) { errs.push(host + '：预算不足，跳过'); continue; }
      per = Math.max(900, Math.min(per, remain));
    }
    try {
      const r = await outFetch(url, { headers: LM_HEADERS, timeout: per });
      const html = r.text();
      if (r.status >= 400) { errs.push(host + '：HTTP ' + r.status); continue; }
      return { html: html, base: base, host: host, url: url, status: r.status };
    } catch (e) {
      errs.push(host + '：' + ((e && e.message) || e));
    }
  }
  throw new Error('本站不可达（已试 ' + LM_DOMAINS.length + ' 个域名：' + errs.slice(0, 3).join('；') + '）');
}

/* 少数「机器译名的词形 ≠ 站点用词」的修正 —— 只在下面的译词重试路径上生效。
   为什么需要：站点检索是 **LIKE %q%**，命不命中取决于**词形**而不是语义。
   实测（本次取证）：?search=capitalismo → 0 条；?search=capitalista → 1 条（《Harem Capitalista》）；
   ?search=capitalis → 1 条。而 MyMemory 把「资本主义」译成的是名词 capitalismo。
   与前端 assets/js/xlate.js 的 ZH_ES 同口径；两边只在高频词上重复，网关这层是给
   「直接打接口的调用方（压测工具 / 脚本 / 第三方，它们不会先做本地化）」兜底的。 */
const LM_ZH_FIX = {
  '资本主义': 'capitalista', '人妻': 'casada', '巨乳': 'pechos grandes', '学校': 'escuela',
  '学園': 'escuela', '催眠': 'hipnosis', '触手': 'tentáculos', '制服': 'uniforme',
  '女仆': 'sirvienta', '姐妹': 'hermanas', '调教': 'entrenamiento', '无修': 'sin censura',
  '全彩': 'color', '足': 'pies', '口交': 'sexo oral', '肛交': 'sexo anal'
};

/* 词干：与前端 X.stems（assets/js/xlate.js）同一套规则 —— 站点是 LIKE %q%，
   一个词干能一次覆盖它的所有词形（capital → capitalismo / capitalista / capitalism 全中）。
   为什么网关也需要它：直接打 /api/lectormanga/search?q=<中文词> 的调用方不会做本地化，
   只拿「机器译名的原词」去打，实测就是 200 / 3022ms / **0 条**（译名 capitalismo 站上没有）。
   泛化词干排在最前，理由与前端一致：最可能命中的候选必须最先被试。 */
const LM_STEM_PAIRS = [
  ['ismo', 'ista'], ['ismo', 'ist'], ['ismo', 'isme'],
  ['ista', 'ismo'], ['ista', 'ist'], ['iste', 'ista'], ['iste', 'ism'],
  ['istica', 'istico'], ['istico', 'istica'],
  ['ism', 'ist'], ['ism', 'ista'], ['ism', 'isme']
];
const LM_STEM_SUFFIX = [
  'isticamente', 'istico', 'istica', 'mente', 'ciones', 'cione', 'dades', 'dad',
  'ismos', 'istas', 'ismo', 'ista', 'iste', 'ism', 'icos', 'icas', 'ico', 'ica',
  'ales', 'es', 's'
];
function lmStems(word) {
  const s = String(word == null ? '' : word).trim().toLowerCase();
  const out = [];
  const push = v => { if (v && v !== s && v.length >= 5 && out.indexOf(v) < 0) out.push(v); };
  if (!s || s.indexOf(' ') >= 0 || !/^[a-zà-öø-ÿ]+$/.test(s) || s.length < 6) return out;
  for (let i = 0; i < LM_STEM_SUFFIX.length; i++) {
    const suf = LM_STEM_SUFFIX[i];
    if (s.length <= suf.length) continue;
    if (s.slice(-suf.length) !== suf) continue;
    const stem = s.slice(0, -suf.length);
    if (stem.length >= 6) { push(stem); break; }
  }
  LM_STEM_PAIRS.forEach(p => { if (s.length > p[0].length && s.slice(-p[0].length) === p[0]) push(s.slice(0, -p[0].length) + p[1]); });
  return out.slice(0, 3);
}

async function lectormangaSearch(query) {
  const q = String(query.q || '').trim();
  const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
  const extra = String(query.extra || '').trim();
  const limit = Math.max(1, Math.min(parseInt(query.limit || '60', 10) || 60, 60));
  /* 检索词：关键词 + 可选标签/画师（站点只有一个自由文本 search 口，空格连接即可） */
  const term = [q, extra].filter(Boolean).join(' ').trim();

  const tries = [];
  if (term) tries.push('/comics?search=' + encodeURIComponent(term) + (page > 1 ? '&page=' + page : ''));
  /* 纯浏览（无关键词）：给最新上架列表，保证「不输词也能看」的时候有内容 */
  if (!tries.length) tries.push('/comics' + (page > 1 ? '?page=' + page : ''));

  const errs = [];
  /* 第 10 轮：LectorManga 是**西语**站、只按标题匹配，中文关键词打过去必然 0 条
     （实测 ?search=人妻 → 0 条；?search=naruto → 9 条）。前端本来会先做「中文词 →
     西/英/日」候选阶梯再打过来（assets/js/sources.js 的 lectormangaSearch），但**直接打
     网关接口的调用方（压测工具 / 脚本 / 第三方）不会**，于是一次次被记成「0 条」。
     这里补一层兜底：第一次仍用原词打；若「真页面 + 0 条」、调用方又没带 extra（说明它
     没做过本地化）、且原词含 CJK，就取一次机器译文（复用已有的 MyMemory 通道）再打一次。
     ★ 只在「本来就要回 0 条」的情况下多花时间；命中就返回真结果，不命中仍如实报 0 条。 */
  const canLocalize = !!term && !extra && /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(term);
  /* 第 10 轮：整个调用共用一条 6500ms 死线（含下面的译词重试）。
     lmFetchPage 会给 3 个域名各一次机会，per-host timeout 的写法会让「3 × 12s」
     变成 36s；实测有 10282ms 才回来的英文检索，前端 9000ms 早就超时了。 */
  const lmDeadline = Date.now() + LM_BUDGET_MS;
  let empty = null;
  for (const sel of tries) {
    try {
      const r = await lmFetchPage(sel, 12000, lmDeadline);
      const items = lmParse(r.html, r.base, limit);
      /* ★「真页面 + 0 条」是合法的空结果，不是故障★
         （?search= <不存在的词> 服务端返回的就是没有卡片的列表页）。
         如实回 0 条，让前端显示「0 条」，而不是编一个超时/解析失败的错误。 */
      const pack = {
        source: 'lectormanga', host: r.host, total: items.length,
        items: items, via: planOf(r.host) || 'http',
        empty: items.length === 0, query: term
      };
      if (items.length || !canLocalize) return pack;
      empty = pack;                  /* 留作翻译重试后的兜底答案 */
      break;
    } catch (e) {
      errs.push(sel + '：' + ((e && e.message) || e));
    }
  }
  /* 第 10 轮：中文词在西语站 0 条 → 用机器译文再打一次（仅当调用方没做本地化时） */
  if (canLocalize && empty && lmDeadline - Date.now() > 1200) {
    const t0 = Date.now();
    /* 第 10 轮：给「译词重试」一个 4000ms 的**总预算**。它是补救路径，宁可少一条候选，
       也不许把这一源的耗时顶到前端 9000ms 超时 —— 不设预算时实测出现过 9007ms，
       把整轮墙钟顶到 9009ms（cap 才 9500ms）。 */
    const RETRY_BUDGET = 4000;
    /* 取「重试自己的 4000ms」与「整个调用的 6500ms 死线」的较小者 */
    const retryLeft = () => Math.max(0, Math.min(RETRY_BUDGET - (Date.now() - t0), lmDeadline - Date.now()));
    /* 第 10 轮：两个译词接口的超时也要被同一条死线夹住 —— 实测首轮取页用掉 6.5s 后，
       这里再各跑 1800ms 会把整源顶到 8286ms（超过 LM_BUDGET_MS）。
       ★第 16 轮改动★ 上限 1800 → 4000，并且**只等一半预算**、另一条继续在后台跑：
       原值是为了「首轮取页已吃掉 6.5s」的极端情况留的，但实测 MyMemory 冷启动单语
       1.1–1.6s、两语并行可到 4.7s，1800ms 根本打不进去 ⇒ 这条兜底实测就是 0 条
       （/api/lectormanga/search?q=资本主义 = 200 / 3022ms / 0 条）。超时的那条不会白跑：
       xlateOne 内部会把结果写进 30 分钟 xlateCache，下一次检索直接命中。 */
    const xlMs = Math.max(1200, Math.min(4000, Math.floor(retryLeft() * 0.5)));
    const cands = [];
    /* 词干也要一起试：站点是 LIKE %q%，capitalismo 打不到、capitalista 才命中 */
    const addCand = v => {
      const s = String(v == null ? '' : v).trim();
      if (!s || s === term) return;
      if (cands.indexOf(s) < 0) cands.push(s);
      lmStems(s).forEach(st => { if (st !== term && cands.indexOf(st) < 0) cands.push(st); });
    };
    if (LM_ZH_FIX[term]) addCand(LM_ZH_FIX[term]);
    try {
      const texts = await Promise.all(['es', 'en'].map(lang => {
        const p = xlateOne(term, lang, 4500).then(t => t, () => '');
        /* 到点先走，别让一个慢语种拖住整条重试；后台那条回来会进缓存 */
        return Promise.race([p, new Promise(res => setTimeout(() => res(''), xlMs))]);
      }));
      texts.forEach(addCand);
    } catch (e) { /* 译不出来就如实回 0 条 */ }
    for (const cand of cands.slice(0, 6)) {
      if (retryLeft() < 900) break;      /* 预算用完了 → 如实回 0 条，绝不硬撑 */
      try {
        const sel2 = '/comics?search=' + encodeURIComponent(cand) + (page > 1 ? '&page=' + page : '');
        const r2 = await lmFetchPage(sel2, Math.min(3000, retryLeft()), lmDeadline);
        const items2 = lmParse(r2.html, r2.base, limit);
        if (items2.length) {
          return {
            source: 'lectormanga', host: r2.host, total: items2.length, items: items2,
            via: planOf(r2.host) || 'http', empty: false, query: cand,
            note: '中文关键词「' + term + '」在西语站 LectorManga 上 0 条，已用译文/词干候选「' + cand +
              '」重试并命中（前端自己会先做这层候选翻译，这条是给直接调接口的调用方补的兜底）。'
          };
        }
      } catch (e) { /* 这条候选也不行 → 换下一条 */ }
    }
  }
  if (empty) return empty;
  throw new Error('LectorManga 取数失败（已试 ' + tries.length + ' 条入口）：' + errs.slice(0, 3).join('；'));
}

/* ==========================================================================
   词语级翻译（/api/translate）
   --------------------------------------------------------------------------
   为什么需要它：LectorManga 是**西语**站，只按标题做匹配，中文关键词打过去必然 0 条
   （实测：?search=人妻 → 0 条；?search=naruto → 9 条）。前端因此需要一份「中文词 →
   英 / 西 / 日 / 法」的候选串阶梯；高频词走前端内置离线词典（0ms，见 assets/js/xlate.js），
   词典没收录的才来这里要一次机器译文。

   设计取舍（都是为了「不拖慢、不报错」）：
     · MyMemory 免费接口，不需要 key；实测本机直连 1.1s 可回。
     · **硬超时**：整体 timeout（默认 4000ms），各语种并行，超时就放弃 ——
       宁可少一条候选串，也不许把检索拖过 20 秒。
     · **进程内缓存 30 分钟 / 200 条**：随机关键词连续检索时命中率不高，但
       同一批候选串会被反复问（重搜 / 追加页），缓存能把这些重复请求全吃掉。
     · 任何失败都返回 { ok:false }，**不抛**：调用方一律降级到离线词典。
   ========================================================================== */
const XLATE_TTL = 30 * 60e3;
const XLATE_MAX = 200;
const xlateCache = new Map();     // "src|lang" -> { at, text }

/** 一眼就能看出是垃圾的译文：原样返回 / 含维基锚点 / MyMemory 的告警串 */
function xlateBad(text, src) {
  const t = String(text || '').trim();
  if (!t) return true;
  if (t.toLowerCase() === String(src || '').trim().toLowerCase()) return true;
  if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|#|https?:\/\//i.test(t)) return true;
  if (t.length > 90) return true;
  return false;
}

async function xlateOne(text, lang, timeout) {
  const key = lang + '|' + text;
  const hit = xlateCache.get(key);
  if (hit && Date.now() - hit.at < XLATE_TTL) return hit.text;
  const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) +
    '&langpair=' + encodeURIComponent('zh-CN|' + lang);
  /* MyMemory 直连可达（实测 1.1s）；仍然走 outFetch，于是 DoH 钉 IP / 中继
     这两层补偿对它同样生效，出口被墙时不会硬死。 */
  const r = await outFetch(url, {
    timeout: Math.max(1500, timeout || 4000),
    headers: { accept: 'application/json' }, allowEmpty: true, relay: true
  });
  const body = r.text();
  let j = null;
  try { j = JSON.parse(body); } catch (e) { return ''; }
  if (!j || j.quotaFinished) return '';
  const out = String(((j.responseData || {}).translatedText) || '').trim();
  if (xlateBad(out, text)) return '';
  xlateCache.set(key, { at: Date.now(), text: out });
  while (xlateCache.size > XLATE_MAX) {
    const oldest = xlateCache.keys().next().value;
    if (oldest === undefined) break;
    xlateCache.delete(oldest);
  }
  return out;
}

async function translateText(query) {
  const q = String(query.q || '').trim().slice(0, 120);
  const tos = String(query.to || 'en,es,ja,fr').split(',')
    .map(s => s.trim()).filter(s => /^[a-z]{2}(-[A-Za-z]{2})?$/.test(s)).slice(0, 6);
  if (!q) return { ok: false, error: '缺少 q' };
  if (!tos.length) return { ok: false, error: '缺少 to' };
  const budget = Math.max(1500, Math.min(6000, parseInt(query.ms || '4000', 10) || 4000));
  const t0 = Date.now();
  /* ★「冷启动第一次必然拿不到」的新解法（第 16 轮实测）★
     MyMemory 冷启动：单语 1102–1615ms，四语并行 1.2–4.7s；而前端给 2500ms、lectormanga
     兜底只给 1800ms ⇒ 第一次搜某个词经常一条候选都没有（实测 200 / 3022ms / 0 条）。
     但翻译结果本身是有价值的：把「对外等多久」和「请求活多久」拆开 ——
     对外仍然只等调用方的预算，底层请求至少活 5000ms，回来就落 30 分钟进程缓存
     （缓存键 = 语种|词，跨调用方共享）。于是第二次搜同一个词是 1ms 命中，
     而 lectormanga 的「译词重试」也刚好落在这一层上。 */
  const XLATE_KEEP_MS = 5000;
  const pairs = await Promise.all(tos.map(async lang => {
    const wait = Math.max(300, budget - (Date.now() - t0));
    const p = xlateOne(q, lang, Math.max(wait, XLATE_KEEP_MS)).then(t => [lang, t], () => [lang, '']);
    if (XLATE_KEEP_MS <= wait) return p;          /* 预算够 → 正常等它 */
    /* 预算不够 → 到点先交卷；后台那条继续跑，自己进缓存（Node 允许响应发完后 promise 继续） */
    let done = false;
    const raced = await Promise.race([
      p.then(v => { done = true; return v; }),
      new Promise(res => setTimeout(() => res([lang, '']), wait))
    ]);
    if (!done) log('翻译预热：' + lang + '|' + q + ' 超过调用方预算，已转入后台继续（结果会进 30 分钟缓存）');
    return raced;
  }));
  const out = {};
  pairs.forEach(p => { if (p[1]) out[p[0]] = p[1]; });
  return {
    ok: true, q: q, src: 'mymemory', ms: Date.now() - t0,
    results: out, hit: Object.keys(out).length > 0
  };
}

/* ==========================================================================
   在线阅读器（/api/reader）—— 阶段一：mangadex / nhentai / danbooru
                                阶段二：wnacg（紳士漫畫）/ ehentai
   返回统一结构：
     { ok, source, id, title, referer, chapters:[{id,name}], pages:[{url,alt?,w,h}] }
   · chapters 为空数组 = 单章作品（pages 就是全部页）
   · 传了 chapter= 只换 pages，chapters 始终是全量清单（前端要用来做下拉）
   · pages[].url 已经是本网关的相对代理地址，浏览器不会撞防盗链
   · pages[].alt 是同一页的备用地址（另一个域名，目前只有 MangaDex 有）：
     url 加载失败时前端会自动换 alt 重试一次，两条都失败才提示用户手动重试
   · 前端 reader.js 是通用的：只读 chapters/pages 并把 url 塞进 <img src>。
     所以新增的源**只需要在网关侧产出正确的 pages**，前端一行都不用改。
   ========================================================================== */
const READER_HOSTS = {
  mangadex: 'https://mangadex.org/',
  nhentai: 'https://nhentai.net/',
  danbooru: 'https://danbooru.donmai.us/',
  wnacg: 'https://www.wnacg.com/',
  ehentai: 'https://e-hentai.org/',
  hitomi: 'https://hitomi.la/',
  pixiv: 'https://www.pixiv.net/',
  copymanga: 'https://www.copy20.com/',
  jmcomic: 'https://18comic.vip/',
  /* porn-comic.com：条目页 /h/<id>.html、第 n 页 /h/<id>-<n>.html，
     正文图在 file/file2/file3.acgnngca.com（**不经 Cloudflare**，见 readerPorncomic）。 */
  porncomic: 'https://porn-comic.com/',
  /* LectorManga（西语站，Astro SSR）：作品页 /comics/<slug>、章节页
     /comics/<slug>/<capitulo-N|chapter-N>，正文图在 media.ikigaicomics.lat
     （浏览器直连会失败，必须经 /api/proxy）。见 readerLectormanga。 */
  lectormanga: 'https://lector-mangas.lat/'
};

/* 禁漫（jmcomic）的在线阅读：scramble_id 从「章节页模板」里取，还原用站点自己的算法。
   --------------------------------------------------------------------------
   本轮实测取证（出口 = 本地代理 127.0.0.1:7897，APP 接口域名 www.cdnbea.net）：

   1) APP 接口的其它变体**都没有** scramble 字段（逐项实测，全部 HTTP 200）：
        GET /chapter?id=1474541                     → images=23，键只有
          [id,series,tags,name,images,addtime,real_link,series_id,is_favorite,liked]
        + &mode=vertical / &mode=horizontal / &app_img_shunt=1 → 键集合完全一样
        + 换 X-Requested-With: com.jmcomic.app / okhttp UA / 自定义 tokenparam → 一样
        GET /album?id=1474541        → 200，images=[]，无 scramble
        GET /serialization?id=1474541、/serialization?aid=… → 200 {"error":…}
        GET /setting?app_img_shunt=1&express= → 200，36 个键（img_host/…），无 scramble
      —— 上一轮的结论在这一步被复现：**APP 接口就是不给 scramble_id**。

   2) scramble_id 的真实来路（上一轮漏掉的一条，**不需要过 Cloudflare**）：
        GET /chapter_view_template?id=1474541  （同一个 APP 接口域名）
          → 200 text/html 20047B，正文里有
            `var aid = 1474541; var speed = ''; var scramble_id = 220980;`
            以及 `const config = { jmid:'1474541', imghost:'https://tencent.jmdanjonproxy.xyz', cache:'' }`
            和 `const result = { images:['00001.webp',…] }`
      也就是说：**网页版 /album、/photo 在本机出口确实是 403 挑战页（实测 5739B 挑战页），
      但 APP 接口域名上就挂着同一份阅读页模板**，社区「从网页 HTML 里读 var scramble_id」
      的标准做法在这里不用过 CF 就能落地。

   3) 图片 CDN（<imghost>/media/photos/<id>/<file>）：
        tencent.jmdanjonproxy.xyz/media/photos/1474541/00001.webp         → 200 image/webp 162604B
        cdn-msp.jmapinodeudzn.net/media/photos/1474541/00001.webp         → 200 image/webp 162604B（与上面字节一致）
        cdn-msp2.jmapinodeudzn.net/media/photos/1474541/00001.webp        → 200 image/webp 156684B（**不同字节**）
      镜像之间会重编码，所以**不给 alt**：MangaDex 那套「备用地址」在这里会换成另一份字节，
      宁可不给备用，也不给一个可能是另一张图的备用地址。

   4) 还原算法**直接照抄站点自己的脚本**（不是凭记忆写的社区版本）：
        https://<APP域名>/templates/frontend/airav/js/jquery.photo-0.5.js  → 200 application/javascript
        · scramble_image()：aid < scramble_id 的旧作品**不打乱**，原图直接用（连 .gif 也跳过）
        · onImageLoaded()：num 块等分，第 i 块从源图 (num-1-i) 位置搬到输出第 i 位置
          —— 即「按 num 等分后整体上下颠倒」，h % num 的余数并进第一块
        · get_num(aid, page)：md5(aid + page) 的**最后一个十六进制字符的 ASCII 码**，
          aid ∈ [268850, 421925] 时 %10、aid ≥ 421926 时 %8，
          再映射 0→2 1→4 2→6 3→8 4→10 5→12 6→14 7→16 8→18 9→20（不命中就是 10）
      实测 1474541：aid ≥ 421926 → 每页块数 = charCode % 8 → 00001=4 块、00002=16 块、00003=12 块，
      1200×630 与 1280×1780 都能整数等分（余数 0/2/4），与上一轮「尺寸不是 220/440 整数倍所以
      没打乱」的推断相反 —— **这批图确实是打乱的**，只是分块规则跟 220/440 无关。

   5) 像素级验证：在真实浏览器里把同一张图分别交给
      · 站点自己的 scramble_image()（原样搬进来的 DOM 结构 + 原脚本），和
      · reader.js 的 canvas 还原实现
      逐像素比对，两边的输出必须完全一致，且还原后的分块接缝不连续度显著低于原图。
      没通过这条验证就不会启用这个源。
   -------------------------------------------------------------------------- */

/** jm 的 get_num：块数（照抄站点脚本，见上面第 4 条） */
function jmScrambleBands(aid, page) {
  const hex = crypto.createHash('md5').update(String(aid) + String(page)).digest('hex');
  let k = hex.charCodeAt(hex.length - 1);
  const a = parseInt(aid, 10) || 0;
  if (a >= 268850 && a <= 421925) k = k % 10;
  else if (a >= 421926) k = k % 8;
  const map = { 0: 2, 1: 4, 2: 6, 3: 8, 4: 10, 5: 12, 6: 14, 7: 16, 8: 18, 9: 20 };
  return map[k] || 10;
}

/** 拿不到 scramble_id 时的中文原因（不抛栈、不伪造 pages） */
const JM_READER_UNAVAILABLE = '禁漫（jmcomic）这次没能还原图片，原因如下（不是没试）：' +
  '① APP 的 /chapter 能给出图片文件名，但**整个响应里没有 scramble_id**（?mode=、app_img_shunt、' +
  '/album、/serialization、/setting 都试过，键集合完全一样）；' +
  '② 正常情况下 scramble_id 从章节页模板 /chapter_view_template?id=<id> 里读 ' +
  '（里面有 `var scramble_id = …`），这次**这个模板没取到或者里面没有 scramble_id**：' +
  '可能上游域名/接口改版，或当前出口被禁漫的 CF 挑战挡住；' +
  '③ 没有 scramble_id 就无法确定分块规则，而**规则写错不会报错、只会把正常的图上下颠倒**，' +
  '所以这里宁可明确报错，也不给一个会把图弄花的半成品。' +
  '可以过一会儿重试，或用「换一个出口代理」再试一次。';

const READER_SOURCES = Object.keys(READER_HOSTS);
/* 真正实现了的源（/api/reader 能给出 pages）；剩下的在 READER_UNAVAILABLE 里明确报不支持 */
const READER_WORKING = ['mangadex', 'nhentai', 'danbooru', 'wnacg', 'ehentai', 'hitomi', 'pixiv',
  'copymanga', 'jmcomic', 'porncomic', 'lectormanga'];
const READER_UNAVAILABLE = [];
/** 上游 4xx 的统一中文解释（Cloudflare 的人机验证页最容易被误当成「源坏了」） */
function readerUpstreamErr(what, r) {
  const body = r && r.buf ? r.buf.toString('utf8').slice(0, 4000) : '';
  const cf = /just a moment|cf-browser-verification|cf_chl_|cdn-cgi\/challenge/i.test(body);
  if (cf) {
    return what + ' 被 Cloudflare 人机验证挡住（HTTP ' + r.status +
      '）—— 网关不能执行 JS 过验证，请稍后重试或换一个出口代理';
  }
  if (r.status === 401 || r.status === 403) return what + ' 拒绝了这个出口（HTTP ' + r.status + '），可能需要登录或换代理';
  if (r.status === 404) return what + ' 说没这个条目（HTTP 404），id 可能填错了';
  if (r.status === 429) return what + ' 限流了（HTTP 429），等一会儿再读';
  /* 4xx 时上游多半给了原话（MangaDex 是 validation_exception + detail）。
     只写「HTTP 400」根本没法查 —— 实测 zh-hans 不是合法语言码就会整条 400。 */
  let detail = '';
  try {
    const j = JSON.parse(body);
    const e0 = j && ((j.errors && j.errors[0]) || j.error || j.message);
    const txt = e0 && (e0.detail || e0.title || e0.message || (typeof e0 === 'string' ? e0 : ''));
    if (txt) detail = ' —— 上游说：' + String(txt).replace(/\s+/g, ' ').slice(0, 180);
  } catch (x) { /* 不是 JSON 就算了 */ }
  return what + ' 返回 HTTP ' + r.status + detail;
}

/** 带 Referer 取上游 JSON；非 2xx 抛中文错误
 *  extra：透传给 outFetch 的额外选项（r18 起支持 legCap —— 只给公共后备腿加更短上限，
 *  取一小段 JSON 不该让 allorigins 各烧几秒，见 relayFetchOnce 里 legCap 的注释）。 */
async function readerJson(url, referer, what, timeout, extra) {
  let r;
  try {
    r = await outFetch(url, Object.assign({
      timeout: timeout || 15000,
      headers: { accept: 'application/json', referer: referer }
    }, extra || {}));
  } catch (e) {
    throw new Error('连不上 ' + what + '：' + ((e && e.message) || e));
  }
  if (!r.ok) throw new Error(readerUpstreamErr(what, r));
  let j;
  try { j = r.json(); } catch (e) { throw new Error(what + ' 返回的不是 JSON（可能被挡或改版了）'); }
  return j;
}

/** 本网关的相对代理地址（浏览器用同源相对路径最省事，跨源时前端会补网关地址） */
const readerProxyUrl = (url, referer) =>
  '/api/proxy?url=' + encodeURIComponent(url) + '&referer=' + encodeURIComponent(referer);

const readerPage = (url, referer, w, h) => {
  const p = { url: readerProxyUrl(url, referer) };
  if (w > 0 && h > 0) { p.w = Math.round(w); p.h = Math.round(h); }
  return p;
};

/* MangaDex 同一张图有两条互相独立的通路（本机实测，都带 Referer: https://mangadex.org/）：
     · at-home 节点：baseUrl 形如 https://<子域>.mangadex.network/data/{hash}/{file}，
       官方推荐的取图入口。实测最稳：连取 8 次字节完全一致（page0 = 310819B
       image/jpeg sha 804ec7a6cfaf，2160×1520；page4 = 426836B sha bac4c802bb64）。
     · uploads.mangadex.org/data/{hash}/{file}：域名固定的老镜像。实测 100% 回 200，
       但**内容会变** —— 同一 URL 连取 8 次里会出现别的字节/别的图，甚至回 image/png
       （page0：6 次与 at-home 同字节、1 次 508775B、1 次 252027B）。
       所以它能当备用，但不能当唯一来源。
   结论：主地址仍用官方 at-home 节点，uploads 作为 alt；前端在主地址加载失败时
   自动换 alt 再试一次（见 assets/js/reader.js），不需要用户手动点重试。
   反过来把 uploads 顶成默认会不时显示另一张图 —— 这正是「实测为准、别拍脑袋」的地方。 */
const READER_MD_MIRROR = 'https://uploads.mangadex.org';

const readerPageAlt = (url, altUrl, referer) => {
  const p = readerPage(url, referer, 0, 0);
  if (altUrl && altUrl !== url) p.alt = readerProxyUrl(altUrl, referer);
  return p;
};

/** MangaDex 的标题是多语言对象：中文优先，其次英文，再退到第一个非空值 */
function mdReaderTitle(obj) {
  if (!obj || typeof obj !== 'object') return '';
  const order = ['zh-hk', 'zh-hans', 'zh', 'zh-tw', 'en', 'ja-ro', 'ja', 'ko'];
  for (const k of order) if (obj[k]) return String(obj[k]);
  const first = Object.keys(obj).map(k => obj[k]).filter(Boolean)[0];
  return first ? String(first) : '';
}

/* --------------------------------------------------------------------------
   MangaDex 章节接口的两个坑（本机实测，经网关 /api/proxy 走同一出口）
   口径：/manga?limit=12&title=fate&contentRating[]=erotica&contentRating[]=pornographic
        &order[relevance]=desc → 12 条，另加 2 条参考条目（164eff7a 可读 / aff8827b 读不了）

     1. feed 的默认 contentRating 只有 safe/suggestive/erotica：
        pornographic 条目的 feed 直接返回 total=0。实测 14 条里 13 条默认 feed=0
        （唯一例外 164eff7a 是 safe，默认就有 28 话）。在 URL 上显式补
        contentRating[]=safe/suggestive/erotica/pornographic 之后，12 条立刻出章节，
        且 at-home 页数条条对得上（19/30/17/25/27/20/28/23/31/22 页）。
        —— 这才是「nhentai 能看、MangaDex 打不开」的真正原因，跟出口代理、防盗链无关。

     2. feed 是**唯一**带 pages / externalUrl 的章节接口，能一眼看出哪一话真的托管了图；
        aggregate（按卷/话聚合）没有这两个字段、章节数还更少
        （164eff7a：feed 28 话 / aggregate 25 话），而且它必须指定语言
        （aff8827b 只有 pl、c46f5f9f 只有 it、91689e5b 只有 id —— 按 en 过滤一律为 0）。
        所以：feed 为主，aggregate 只在 feed 一个可读章节都拿不到时兜底。
   -------------------------------------------------------------------------- */
const MD_READER_RATINGS = ['safe', 'suggestive', 'erotica', 'pornographic'];
const MD_READER_RATING_QS = MD_READER_RATINGS.map(r => '&contentRating[]=' + r).join('');
/* 语言偏好沿用旧行为（中文优先、英文兜底）。两个实测结论：
   · 只有 pl/it/id 版本的作品（aff8827b / c46f5f9f / 91689e5b）在这一轮会拿到空清单，
     所以下面还留了一轮「放开语言」的兜底；
   · MangaDex 对 translatedLanguage[] 是白名单校验：zh-hans / zh-hant 不是合法码，
     带上它们整条 feed 会被判 400 validation_exception（zh / zh-hk / zh-tw / en 实测合法）。 */
const MD_READER_LANGS = ['zh', 'zh-hk', 'zh-tw', 'en'];
const MD_READER_LANG_QS = MD_READER_LANGS.map(l => '&translatedLanguage[]=' + l).join('');
/* aggregate 兜底时最多向 at-home 求证几次 / 最多保留几话（别把上游打成限流） */
const MD_AGG_PROBE_MAX = 8;
const MD_AGG_KEEP_MAX = 5;
/* feed 的分页与硬上限 —— 实测（api.mangadex.org，本机出口）：
     · /manga/<id>/feed 的 limit 上游封顶 500（写 1000 实测被拒/被夹回 500），
       所以「一次 limit=500」在长连载上**必然**只拿到前 500 条：
       实测 a1c7c817（One Piece）total=932 而 limit=500 只回 500 条；
       801513ba（Berserk）total=4592 更极端。
     · total 是这条 feed 在 contentRating 四档下的**总条数**（不是章节数），
       所以分页要按 offset 翻到 total 为止，再用「同话多样本去重」落到章节数。
     · 每页最多 2 次请求，翻到 MD_FEED_MAX_CHAPTERS 条为止：宁可多要一页，
       也不静默停在 500（用户看到的「只显示几章」就是这个 500 造成的）。 */
const MD_FEED_PAGE = 500;              /* 上游单页上限（实测） */
const MD_FEED_MAX_CHAPTERS = 1000;     /* 硬上限：最多收 1000 条 feed 条目（= 2 页） */
const MD_MAX_CHAPTERS = 1000;          /* 硬上限：返回给前端的章节数，超出时带 note 说明 */

/** 章节显示名：第 N 话 · 标题（语言） */
function mdChapterName(num, title, lang) {
  const n = (num == null || num === '') ? '' : String(num);
  return (n ? '第 ' + n + ' 话' : '无编号章节') +
    (title ? ' · ' + String(title) : '') +
    (lang ? '（' + String(lang) + '）' : '');
}

/** feed 一页 → 原始条目（不过滤）。分页与语言参数由调用方拼。 */
async function mdFeedPage(url, referer, what) {
  const j = await readerJson(url, referer, what, 20000);
  return { rows: asArray(j && j.data), total: Number((j && j.total) || 0) };
}

/** 把整条 feed 翻完（limit=MD_FEED_PAGE / offset 递增，最多 MD_FEED_MAX_CHAPTERS 条）。
    返回 { list, total, cut, raw }：
      · list  = 可读章节清单（过滤 externalUrl / pages=0，顺序 = 上游顺序；
                同一话的多个语言版本按 MD_READER_LANGS 偏好只留最好的那一条）
      · total = 上游给的条目总数（含被过滤掉的），用于判断「后面是不是真的还有」
      · cut   = 撞到硬上限、后面还有条目（此时**必须**在 note 里说出来）
      · raw   = 上游实际返回的可读条目数（去重前的条数，报告里用来对照）
    中途网络/上游失败会照常抛出（调用方决定是「换一轮」还是「如实报错」）。 */
async function mdFeedChapters(feedUrl, referer, what) {
  const byId = new Map();          /* 话 id -> { order, rank, entry }（rank = 语言偏好的名次，越小越优先） */
  let total = 0, cut = false, raw = 0, offset = 0, seq = 0;
  for (;;) {
    if (offset >= MD_FEED_MAX_CHAPTERS) { cut = true; break; }
    const page = await mdFeedPage(feedUrl + '&limit=' + MD_FEED_PAGE + '&offset=' + offset, referer, what);
    total = page.total || total;
    if (!page.rows.length) break;
    mdReadableChapters({ data: page.rows, langRank: true }).forEach(c => {
      raw++;
      const prev = byId.get(c.id);
      if (!prev) { byId.set(c.id, { order: seq++, rank: c.rank, entry: c }); return; }
      /* 同一话的不同语言版本：留下语言偏好更靠前的那一条；同级则保持先出现的那条 */
      if (c.rank < prev.rank) { prev.rank = c.rank; prev.entry = c; }
    });
    offset += MD_FEED_PAGE;
    if (page.rows.length < MD_FEED_PAGE) break;  /* 已经到底 */
    if (total && offset >= total) break;
  }
  const list = Array.from(byId.values()).sort((a, b) => a.order - b.order)
    .map(x => ({ id: x.entry.id, name: x.entry.name }));   /* 只留 id/name；order/rank/language 是内部字段 */
  return { list: list, total: total, cut: cut, raw: raw };
}

/** feed → 可读章节清单。只过滤、不重排（顺序仍是上游返回顺序）：
    · attributes.externalUrl 非空 = 这一话只在原站/外链看，网关托不到图
    · attributes.pages === 0    = 上游自己也没托管页
    langRank=true 时额外带 language/rank（供 mdFeedChapters 做同话去重）。 */
function mdReadableChapters(feed) {
  const wantRank = !!(feed && feed.langRank);
  let seq = 0;
  return asArray(feed && feed.data).filter(c => {
    const a = (c && c.attributes) || {};
    return !a.externalUrl && Number(a.pages || 0) > 0;
  }).map(c => {
    const a = c.attributes || {};
    const out = { id: String(c.id), name: mdChapterName(a.chapter, a.title, a.translatedLanguage) };
    if (wantRank) {
      const lang = String(a.translatedLanguage || '').toLowerCase();
      const at = MD_READER_LANGS.indexOf(lang);
      out.language = lang;
      out.rank = at < 0 ? MD_READER_LANGS.length : at;   /* 不在偏好表里的排最后 */
      out.order = seq++;
    }
    return out;
  });
}

/** aggregate（按卷/话聚合）→ 候选章节；只有 id / 卷 / 话号，没有 pages / externalUrl */
async function mdAggregateCandidates(id, referer) {
  const agg = await readerJson('https://api.mangadex.org/manga/' + encodeURIComponent(id) +
    '/aggregate', referer, 'MangaDex 卷话索引', 20000);
  const rows = [];
  const vols = (agg && agg.volumes) || {};
  Object.keys(vols).forEach(vk => {
    const chs = (vols[vk] && vols[vk].chapters) || {};
    Object.keys(chs).forEach(ck => {
      const c = chs[ck] || {};
      if (!c.id || c.isUnavailable) return;
      rows.push({ id: String(c.id), volume: vk, chapter: c.chapter == null ? ck : c.chapter });
    });
  });
  /* aggregate 自己返回的是倒序（实测 164eff7a 先给 vol 2 / 第 23 话），原站却是升序。
     用户要的是「图片顺序符合原网址次序」，所以兜底这一条路按卷/话升序排一次；
     feed 那条主路绝不重排。 */
  const num = v => { const f = parseFloat(String(v)); return isFinite(f) ? f : Infinity; };
  rows.sort((a, b) => (num(a.volume) - num(b.volume)) || (num(a.chapter) - num(b.chapter)));
  return rows;
}

async function readerMangadex(id, chapter) {
  const referer = READER_HOSTS.mangadex;
  const info = await readerJson('https://api.mangadex.org/manga/' + encodeURIComponent(id), referer,
    'MangaDex', 15000);
  const title = mdReaderTitle(info && info.data && info.data.attributes && info.data.attributes.title) ||
    ('MangaDex ' + id);

  /* 同一话的 at-home 结果只取一次：兜底扫可读性时取过的，后面要页时直接复用 */
  const hostCache = Object.create(null);
  const atHomeHost = chId => {
    const k = String(chId);
    if (!(k in hostCache)) {
      hostCache[k] = readerJson('https://api.mangadex.org/at-home/server/' + encodeURIComponent(k),
        referer, 'MangaDex 图床', 15000);
    }
    return hostCache[k];
  };

  /* feed：**按 offset 翻完**（上游 limit 封顶 500，单页必然截断长连载，见上面的实测记录）。
     contentRating[] 四档一个都不能少 —— 少了 pornographic 的 feed 一律返回 0 话。 */
  const feedUrl = 'https://api.mangadex.org/manga/' + encodeURIComponent(id) +
    '/feed?order[chapter]=asc' + MD_READER_RATING_QS;
  /* 主路 = 带语言偏好（跟旧行为一致）。它**不是**致命的：语言码被上游拒（实测 zh-hans
     会让整条 feed 判 400 validation_exception）或这一轮恰好取空，都继续往下走。 */
  let list = [], mdTotal = 0, mdCut = false, mdRaw = 0, mdLangFallback = false;
  let firstErr = null;
  try {
    const got = await mdFeedChapters(feedUrl + MD_READER_LANG_QS, referer, 'MangaDex');
    list = got.list; mdTotal = got.total; mdCut = got.cut; mdRaw = got.raw;
  } catch (e) { firstErr = e; }
  /* 只有非 zh/en 版本的作品（实测 aff8827b=pl、c46f5f9f=it、91689e5b=id）→ 放开语言再拿一轮 */
  if (!list.length) {
    try {
      const got = await mdFeedChapters(feedUrl, referer, 'MangaDex');
      list = got.list; mdTotal = got.total; mdCut = got.cut; mdRaw = got.raw; mdLangFallback = true;
      firstErr = null;
    } catch (e) {
      /* 两轮都失败 = 上游真连不上 / 被挡（不是「没有章节」）→ 抛第一轮的中文错误，
         绝不能悄悄退成「这本没有可读的图」 */
      throw (firstErr || e);
    }
  }
  /* 硬上限：章节数上限 MD_MAX_CHAPTERS。撞上限时**不静默**，在 note 里写明上游到底有多少话。 */
  if (list.length > MD_MAX_CHAPTERS) {
    list = list.slice(0, MD_MAX_CHAPTERS);
    mdCut = true;
  }
  /* 兜底：feed 一个可读章节都没有 → aggregate 出候选，再用 at-home 逐个求证到底有没有图 */
  if (!list.length) {
    try {
      const cand = await mdAggregateCandidates(id, referer);
      const kept = [];
      for (let i = 0; i < cand.length && i < MD_AGG_PROBE_MAX && kept.length < MD_AGG_KEEP_MAX; i++) {
        let host = null;
        try { host = await atHomeHost(cand[i].id); } catch (e) { continue; }
        if (!asArray(host && host.chapter && host.chapter.data).length) continue;
        kept.push({ id: cand[i].id, name: mdChapterName(cand[i].chapter, '', '') });
      }
      list = kept;
    } catch (e) { /* aggregate 也拿不到：按「没有可读章节」返回，绝不抛栈 */ }
  }

  /* 传了 chapter= 就取那一话；那一话不在可读清单里（外部章节 / 已下架）就退回第一话 */
  const wanted = String(chapter || '');
  const ids = list.map(c => c.id);
  const target = (wanted && ids.indexOf(wanted) >= 0) ? wanted : (ids[0] || '');
  let pages = [];
  if (target) {
    const host = await atHomeHost(target);
    if (!host || !host.baseUrl || !host.chapter) throw new Error('MangaDex 没有给出这个章节的图床信息');
    const files = asArray(host.chapter.data);
    const base = String(host.baseUrl).replace(/\/+$/, '');
    const hash = String(host.chapter.hash || '');
    /* 主地址 = at-home 节点（实测最稳）；alt = uploads.mangadex.org 老镜像
       （同一 hash + 文件名，能取到图但内容偶尔会变，只当兜底）。
       hash 缺失时拼不出镜像地址，readerPageAlt 会自动省略 alt。 */
    pages = files.map(f => readerPageAlt(
      base + '/data/' + hash + '/' + f,
      hash ? (READER_MD_MIRROR + '/data/' + hash + '/' + f) : '',
      referer));
  }
  const out = { title: title, referer: referer, chapters: list, pages: pages };
  /* 整本都没有可读章节：chapters / pages 都是空数组（结构不变），只多带一句中文说明。
     前端 reader.js 见到「chapters 与 pages 都空」会显示「这本在这里没有可读的图」。 */
  if (!list.length && !pages.length) {
    out.note = 'MangaDex 这个条目没有可托管的章节：章节可能只在原站/外链观看（externalUrl），' +
      '或只有未被收录的版本，也可能刚好被限流了。';
  } else if (mdCut) {
    /* 撞了硬上限/上游分页上限时**必须说清楚**，别让用户以为自己看到的就是全部 */
    out.note = 'MangaDex 的章节清单给了 ' + list.length + ' 话（上游这条 feed 共 ' +
      (mdTotal ? (mdTotal + ' 条') : '更多条') + '、去重前 ' + mdRaw + ' 条可读条目），' +
      '已到网关硬上限 ' + MD_FEED_MAX_CHAPTERS + ' 条 feed / ' + MD_MAX_CHAPTERS + ' 话，' +
      '后面还有没取到的（多为同一话的其它语言版本）。要看后面的章节请去原站。';
  } else if (mdLangFallback) {
    out.note = 'MangaDex 这条 feed 没有中文/英文版本，已放开语言（' +
      MD_READER_LANGS.join('/') + ' 之外也收）取回全部 ' + list.length + ' 话。';
  }
  return out;
}

/* nhentai 的 pages[].path 末位字符标了格式：j/p/g/w = jpg/png/gif/webp */
const NH_EXT = { j: 'jpg', p: 'png', g: 'gif', w: 'webp' };

/* ★r18 需求③（nhentai 在线阅读偏慢）★
   真机测量（2026-09-23，tools/_measure-2602.mjs）：健康时这一发只要 455ms，但**图库接口
   被上游按出口 IP 限流/或中继腿挂掉**时会走到「腿阶梯全跑一遍」的最坏路径：
   `readerJson(..., 20000)` ⇒ outFetch 把 20000ms 当总预算 ⇒ 中继 perLeg = 20000/4 = 4750ms，
   实测两条 allorigins 各烧满 4750ms（12137ms 才回来，reader#2 也要 5439ms）。
   这一发只是取一段 ~3KB 的 JSON，完全不需要给公共后备腿 4.75s：
     ① 总预算 20000 → 10000（perLeg 随之减半；私有腿仍按 60% 拿 6000ms，不伤「唯一能通的那条腿」）；
     ② 额外给非私有腿 legCap=2000ms —— 健康路径毫秒级命中，不受影响（实测 455ms）。
   图片（i.nhentai.net）走的是 /api/proxy + /api/prefetch，与本条无关，不动它们的预算。 */
const NH_JSON_MS = 10000;
const NH_JSON_LEGCAP = 2000;
/* ★r19★ 阅读器首屏预热：把前几页的图**在返回 JSON 的同时**先拉进代理缓存。
   第 12 轮实测（nhentai 682396，健康时刻）：/api/reader 本身 455ms，
   但第一张图冷取 1468ms、第 2–4 张 450/904/910ms —— 首屏那 1 秒多全花在第一张图上。
   这几张图无论如何都要取（前端 pumpH/prefetchAhead 一定会要），提前发出去等于
   把这 1 秒藏进「等 JSON + 浏览器建 DOM」的时间里；预热失败绝不影响阅读器本身
   （catch 掉，且失败不进 inflight 合并表、不写缓存）。 */
function warmReaderImages(pages, referer) {
  try {
    asArray(pages).slice(0, 2).forEach(p => {
      const u = String((p && p.url) || '');
      const m = /^\/api\/proxy\?url=([^&]+)/.exec(u);
      if (!m) return;
      let target = '';
      try { target = decodeURIComponent(m[1]); } catch (e) { return; }
      if (!/^https?:\/\//i.test(target)) return;
      Promise.resolve(proxyFetch(target, referer, { timeout: 12000, noCooldown: true })).catch(() => {});
    });
  } catch (e) { /* 预热只是提速手段，任何异常都不许影响阅读器 */ }
}

async function readerNhentai(id) {
  const referer = READER_HOSTS.nhentai;
  const g = await readerJson('https://nhentai.net/api/v2/galleries/' + encodeURIComponent(id),
    referer, 'nhentai', NH_JSON_MS, { legCap: NH_JSON_LEGCAP });
  const t = g && g.title;
  const title = (t && (t.english || t.japanese || t.pretty)) || ('nhentai ' + id);
  const media = String((g && g.media_id) || '');
  const pages = asArray(g && g.pages).map(p => {
    let rel = String((p && p.path) || '').trim();
    if (!rel) {
      const num = String((p && p.number) || '');
      const ext = NH_EXT[String(num).slice(-1).toLowerCase()] || 'jpg';
      rel = 'galleries/' + media + '/' + num + '.' + ext;
    }
    return readerPage('https://i.nhentai.net/' + rel.replace(/^\/+/, ''), referer,
      (p && p.width) || 0, (p && p.height) || 0);
  });
  /* nhentai 是单章作品：chapters 交空数组，前端据此隐藏章节下拉 */
  warmReaderImages(pages, referer);
  return { title: String(title), referer: referer, chapters: [], pages: pages };
}

/* --------------------------------------------------------------------------
   Danbooru（danbooru.donmai.us）—— 单图作品；接口和图床**两层都在 Cloudflare 后面**
   本机实测（2026-09，网关出口 = 本地代理 127.0.0.1:7897；同一台机器上的浏览器做对照）：
     · 网关直接 GET /posts/<id>.json
         → HTTP 403 + 正文 "Just a moment…" + 响应头 cf-mitigated: challenge
       （带着 Referer: https://danbooru.donmai.us/ 也一样 —— 不是 Referer 的事）
     · **同一个 URL 在用户浏览器里** → HTTP 200、正文是合法 JSON，而且带 CORS
       （在 data: 页里 fetch 能读到 body；没有 ACAO 的话 fetch 会直接抛 TypeError）
       —— 浏览器有 CF 通行证，Node 没有，这就是这个源「在线阅读基本必然失败」的原因。
     · 图床同理：网关 /api/proxy 打 cdn.donmai.us/180x180/<md5>.jpg → 403 挑战页；
       用户浏览器直连**同一个 URL** → 200 真出图（127×180 的缩略图渲染出来了）。
   所以这里的做法是：
     ① 接口走 cfFetchWithSolver：先直连，撞 CF 就交给本机 Chrome 渲染 JSON 查看器，
        再把 JSON 从 <pre> 里抠回来（不执行 JS 的 Node 拿不到，浏览器渲染层拿得到）；
     ② **图片也走网关 /api/proxy**：cfRender 成功那一刻，顺手把这次过验证的 cookie
         （cf_clearance 等）与页面 UA 记进进程内存（15 分钟，键按主机/zone），/api/proxy
         打 *.donmai.us 时原样带上 —— 这样用户 IP 不必暴露给图床。没有凭证时**完全保持
         今天的直连透传**（今天的 403 行为不变）。pages[].url 的主/备顺序也跟着有没有
         凭证走（有凭证 = /api/proxy 为主、cdn 直连为备，见 danbooruPage）；
     ③ 结果按 4 分钟进程内缓存（与 E-Hentai 同口径），来回翻同一张图不再惊动 Chrome。
   -------------------------------------------------------------------------- */
const DANBOORU_HOST = 'danbooru.donmai.us';
const DANBOORU_BASE = 'https://' + DANBOORU_HOST;
/* 主机的 CF 兜底名单：接口域 + 图床域（都在 donmai.us 这个 CF zone 下） */
const DANBOORU_CF_HOST_RE = /^([a-z0-9-]+\.)*donmai\.us$/i;
/* 合法条目 JSON 的第一个字符：用它当「这是真内容」的特征，避免把真响应误当成挑战页 */
const DANBOORU_JSON_OK_RE = /^\s*[[{]/;
const DB_READER_CACHE_MS = 4 * 60e3;        /* 与 EH_CACHE_MS 同口径的进程内短缓存 */
const dbReaderCache = new Map();            /* id -> { at, val } */

/* ==========================================================================
   第 10 轮：Danbooru 的「可达镜像」兜底（只拦 /posts.json，图片与别的请求一律不碰）
   --------------------------------------------------------------------------
   本机实测取证（tools/stability-run/r10-dns.json、r10-mirror2.json、r10-tbib-thumb.json）：
     · 主站 danbooru.donmai.us：系统 DNS 被投毒（ENOENT）；doh.pub 给的 210.56.51.192
       带 SNI 握手也超时 ⇒ 三层通路全断（第 8 轮 100 轮里 100 次硬失败）。
     · 同 zone 的 safebooru / betabooru：能解析到真 CF IP，但一律 403 + Just a moment；
       本机没有可用 Chrome（起 headless 要更宽沙箱）⇒ CF 兜底也过不去（实测 11/12 次
       「网关代理：HTTP 403」）。
     · 中继腿：allorigins 对 danbooru 回 520/522 ⇒ 也没救。
   可达的同类图片板（都是 gelbooru 系 dapi，标签口径与 danbooru 基本一致）：
     · tbib.org   —— 直连 0.7~1.1s、系统 DNS 与 TLS 都正常、rating=explicit/questionable；
                     缩略图规律 = /thumbnails/<dir>/thumbnail_<image>（实测 200 image/jpeg 7498B），
                     原图 = /images/<dir>/<image>；封面浏览器可直连（无需 Referer）。
     · xbooru.com —— 系统 DNS 被投毒，只能靠网关 DoH 钉 IP（首打 ~4.5s，之后走钉表）；
                     dapi 直接给 preview_url/file_url，但它自己的图床域名浏览器同样解析不了，
                     所以这一路的图片地址一律改写成**网关相对代理地址**，否则前端拿到死链。
   刻意**不采用** safebooru.org：它确实回 200，但 rating 恒为 safe ⇒ 前端默认「只要成人向」
   （assets/js/results.js 的 `i.adult !== false`）会把它们全部过滤掉 —— 那是「假成功」，
   用户看到 0 条却以为站点连上了。宁可不列它。
   映射方向只是「适配器字段口径」：gelbooru 行的 tags/rating/图片地址 → danbooru
   posts.json 的 tag_string_* 等字段与 rating/preview_file_url/large_file_url/file_url，
   前端 assets/js/sources.js 的 danbooru 适配器（1941-1966）一行都不用改。
   ========================================================================== */
const BOORU_MIRRORS = [
  /* id, 主机, 图片是否需要走网关相对代理（浏览器自己解析不了这个域名时为 true） */
  { id: 'tbib', host: 'tbib.org', proxyImg: false },
  { id: 'xbooru', host: 'xbooru.com', proxyImg: true }
];
const BOORU_MIRROR_CACHE_MS = 3 * 60e3;
const booruMirrorCache = new Map();         /* key -> { at, val, via } */

/** danbooru 的 /posts.json 请求 → 镜像查询参数；不是这种请求就返回 null（别动别的流量） */
function danbooruMirrorQuery(want) {
  let u;
  try { u = new URL(String(want)); } catch (e) { return null; }
  if (!DANBOORU_CF_HOST_RE.test(u.hostname)) return null;
  if (!/\/posts\.json$/i.test(u.pathname)) return null;
  const tags = String(u.searchParams.get('tags') || '').trim();
  const limit = Math.max(1, Math.min(50, parseInt(u.searchParams.get('limit') || '20', 10) || 20));
  const page = Math.max(1, parseInt(u.searchParams.get('page') || '1', 10) || 1);
  return { tags: tags, limit: limit, page: page };
}

/* gelbooru 系的 rating 有两套写法（0.2 用 s/q/e，safebooru/xbooru 的 json 里有写全称的），
   前端只认 danbooru 的 g/s/q/e，所以这里统一归一化。 */
const BOORU_RATING_MAP = {
  e: 'e', explicit: 'e', q: 'q', questionable: 'q',
  s: 's', safe: 's', g: 'g', general: 'g'
};

/** 图片地址：优先用 dapi 直接给的字段；没给就按站点目录约定拼（tbib 属于这一种）
 *  实测（tools/stability-run/r10-tbib-check.json）：tbib 的缩略图**恒为 .jpg**，
 *  与 `image` 字段自己的扩展名无关 —— png 原图用 `thumbnail_<image>` 拼出来是 404，
 *  把扩展名换成 .jpg 才是 200（12 张封面里 3 张 png 全因此裂图）。 */
function booruRowUrls(m, row) {
  const dir = String(row.directory || ''), img = String(row.image || '');
  const stem = img.replace(/\.[a-z0-9]+$/i, '');
  const thumb = (dir && img) ? ('https://' + m.host + '/thumbnails/' + dir + '/thumbnail_' + stem + '.jpg') : '';
  const image = (dir && img) ? ('https://' + m.host + '/images/' + dir + '/' + img) : '';
  const preview = String(row.preview_url || '') || thumb;
  const full = String(row.file_url || '') || image;
  const sample = String(row.sample_url || '') || full;
  return { preview: preview, sample: sample, full: full };
}

/** gelbooru 系一行 → danbooru posts.json 的一项（字段名对齐前端适配器） */
function booruRowToDanbooru(m, row) {
  if (!row || row.id === undefined) return null;
  const urls = booruRowUrls(m, row);
  /* 一张图都拼不出来的行直接丢：留着只会在前端变成裂图卡片 */
  if (!urls.preview && !urls.full) return null;
  const wrap = u => (m.proxyImg && u)
    ? ('/api/proxy?url=' + encodeURIComponent(u) + '&referer=' + encodeURIComponent('https://' + m.host + '/'))
    : u;
  const tags = String(row.tags || row.tag_string || '');
  return {
    id: row.id,
    rating: BOORU_RATING_MAP[String(row.rating || '').toLowerCase()] || '',
    tag_string: tags,
    tag_string_general: tags,
    /* gelbooru 的 dapi 不给标签类别，画师 / 角色 / 作品就**如实留空**，不猜、
       也不把普通标签冒充成角色名（前端会把空的三项拼成 "post <id>" 标题）。 */
    tag_string_artist: '',
    tag_string_character: '',
    tag_string_copyright: '',
    preview_file_url: wrap(urls.preview),
    large_file_url: wrap(urls.sample),
    file_url: wrap(urls.full),
    image_width: row.width || 0,
    image_height: row.height || 0,
    created_at: row.change ? new Date(Number(row.change) * 1000).toISOString() : '',
    source: 'https://' + m.host + '/index.php?page=post&s=view&id=' + row.id,
    /* 前端不读这个字段；留给 /api/diag、探针与报告一眼看出「这条是哪个镜像给的」 */
    mirror: m.host
  };
}

/** 向一个镜像要一页（tags 原样给，pid 由页码换算）→ 映射好的 danbooru 形状数组
 *  budgetMs：这一发允许花掉的时间（整段镜像流程共享 9 秒预算，见 danbooruMirrorFetch）。 */
async function booruMirrorPage(m, tagStr, qy, budgetMs) {
  const url = 'https://' + m.host + '/index.php?page=dapi&s=post&q=index&json=1&limit=' + qy.limit +
    '&pid=' + (qy.page - 1) + '&tags=' + encodeURIComponent(tagStr);
  const r = await proxyFetch(url, 'https://' + m.host + '/', {
    allowEmpty: true,
    timeout: budgetMs || 4500
  });
  if (!r || r.status >= 400) throw new Error('HTTP ' + (r && r.status));
  const body = r.buf.toString('utf8');
  /* ★第 10 轮实测★ tbib 在「这一页没有内容」时回的是 **HTTP 200 + 0 字节**，不是 `[]`。
     旧代码把它交给 outFetch 的空壳守卫当失败处理 ⇒ tbib 被记 60 秒空壳冷却、后续每次都改走
     中继（allorigins 超时×2），单发 30 秒起步、最后仍失败并掉进 90 秒的 CF 追索 —— 这就是
     10 轮压测里 danbooru 0%、且整轮被拖到 9500ms cap 的元凶。这里如实当成「该页 0 条」，
     并留下日志（0 条与「没取到」在报告里是两回事，别混）。 */
  if (!body.trim()) {
    log('danbooru 镜像 ' + m.host + '：pid=' + (qy.page - 1) + '（tags=' + (tagStr || '(空)') +
      '）回的是空正文，当作该页 0 条');
    return [];
  }
  let j = null;
  try { j = JSON.parse(body); } catch (e) { throw new Error('返回体不是 JSON'); }
  const rows = Array.isArray(j) ? j : (j && Array.isArray(j.post) ? j.post : null);
  if (!rows) throw new Error('JSON 里没有 post 数组（多半是拦截页）');
  return rows.map(x => booruRowToDanbooru(m, x)).filter(Boolean);
}

/** 试遍整条镜像梯队，返回第一条「回得出合法 booru JSON」的结果（0 条也算数）；
 *  全挂返回 null，并把每一家的错误原文收进 errs。 */
async function booruMirrorLadder(tags, qy, budget, errs) {
  for (const m of BOORU_MIRRORS) {
    /* eslint-disable no-await-in-loop */
    const t0 = Date.now();
    try {
      let posts = await booruMirrorPage(m, tags, qy, budget());
      /* ★成人向补救★ —— 前端默认就是成人向模式（assets/js/results.js 的
         `out.filter(i => i.adult !== false)`，adult 由 rating 的 q/e 决定）。
         实测：tbib 上 `swimsuit` / `maid` 这类词的自然结果**全是 safe/general**
         （tools/stability-run/r10-tbib-check.json：maid → general 12 + safe 6 + questionable 2），
         这些条目回到前端会被整批丢掉 ⇒ 该词在界面上等于 0 条，「接口通了但看不到东西」。
         所以：**这一页有内容、但一条 q/e 都没有**时，补打一次带 `rating:explicit`
         元标签的同一查询（实测 tbib/xbooru 都认，`maid rating:explicit` → 20 条全 explicit）。
         0 条的那种不补 —— 那个词在镜像上本来就没有，补一次只是白发一趟。 */
      if (posts.length && !posts.some(p => p.rating === 'e' || p.rating === 'q')) {
        try {
          const ex = await booruMirrorPage(m, tags + ' rating:explicit', qy, budget());
          if (ex.length) {
            log('danbooru 镜像' + m.host + '：tags=' + tags + ' 自然结果无成人向（' + posts.length +
              ' 条），已用 rating:explicit 重查拿到 ' + ex.length + ' 条');
            posts = ex;
          }
        } catch (e) { log('danbooru 镜像' + m.host + ' 的 rating:explicit 重查失败：' + ((e && e.message) || e)); }
      }
      return { posts: posts, via: m.id, ms: Date.now() - t0 };
    } catch (e) {
      errs.push(m.id + '：' + ((e && e.message) || e));
    }
  }
  return null;
}

/** 中文词 → 镜像能认的英文标签串。
 *  为什么必须有这一步：本机出口下 danbooru 原站必 403（Cloudflare），唯一活路是
 *  tbib / xbooru 这类 gelbooru 系镜像 —— 而它们的标签体系是**英文**的。压测工具
 *  （tools/stability-check.js 的 SRC.danbooru）与任何直接打网关的调用方送来的都是中文词
 *  （巨乳/人妻/催眠…），镜像回的是 **HTTP 200 + 0 字节**（gelbooru dapi 对「没有这个标签」
 *  的答复形态），于是被记成「有响应但 0 条」——用户界面上就是 0 张卡。
 *  这里复用已有的 MyMemory 通道（xlateOne，30 分钟进程内缓存）把中文词翻成英文再拼成
 *  下划线标签（big breasts → big_breasts）。翻不出来就返回空串，如实回 0 条，不编结果。 */
const BOORU_CJK_RE = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
/* 常见中文检索词 → 镜像（gelbooru 系）**真的存在**的英文标签。
   表里每一条都在 tbib.org 与 xbooru.com 上实测回过 12 条
   （tools/stability-run/r10-tagcheck.json / r10-tagcheck2.json）——**没实测过的一律不收**：
   给镜像塞一个不存在的标签只会多吃一次「200 + 空正文」，还可能把主机打进冷却。
   为什么需要这张表：机器译文不等于 booru 的标签名。实测 12 个压测词里
   `催眠→hypnotic`✓、`泳装→swimsuit`✓，但 `眼镜娘→glasses_female`✗、`人妻→wife_and_husband`✗
   （两张表都在 tbib 上实测过：glasses_female / wife_and_husband 都是 0 条，
   而 megane / wife 都是 12 条）——翻译对了词义、对不上标签。 */
const BOORU_CJK_TAGS = {
  '巨乳': 'big_breasts', '爆乳': 'big_breasts', '大胸': 'big_breasts',
  '人妻': 'wife', '熟女': 'milf', 'ntr': 'netorare', 'NTR': 'netorare',
  '催眠': 'hypnosis', '触手': 'tentacles',
  '女仆': 'maid', '女佣': 'maid', '女傭': 'maid',
  '眼镜娘': 'megane', '眼镜': 'glasses', '眼鏡': 'glasses',
  '泳装': 'swimsuit', '泳裝': 'swimsuit', '水着': 'swimsuit',
  '黑丝': 'black_thighhighs', '黑絲': 'black_thighhighs', '裤袜': 'pantyhose', '絲襪': 'pantyhose',
  '护士': 'nurse', '護士': 'nurse', '教师': 'teacher', '老師': 'teacher', '老师': 'teacher',
  '巫女': 'miko', '姐姐': 'sister', '和服': 'kimono'
};

/** 中文词 → 词典标签串。**每个词都命中**才返回（多词用空格连接 = dapi 的 AND 语法）；
 *  有一个词不认得就返回空串，交给机器翻译那条路 —— 不猜、不硬凑。 */
function booruTagDict(tags) {
  const raw = String(tags || '').trim();
  if (!raw || !BOORU_CJK_RE.test(raw)) return '';
  const parts = raw.split(/[\s,、，+]+/).filter(Boolean);
  if (!parts.length) return '';
  const out = [];
  for (const p of parts) {
    const hit = BOORU_CJK_TAGS[p] || BOORU_CJK_TAGS[p.toLowerCase()];
    if (!hit) return '';
    out.push(hit);
  }
  return out.join(' ');
}

/** 机器翻译兜底：中文词 → 镜像能认的英文标签串。
 *  为什么必须有这一步：本机出口下 danbooru 原站必 403（Cloudflare），唯一活路是
 *  tbib / xbooru 这类 gelbooru 系镜像 —— 而它们的标签体系是**英文**的。压测工具
 *  （tools/stability-check.js 的 SRC.danbooru）与任何直接打网关的调用方送来的都是中文词
 *  （巨乳/人妻/催眠…），镜像回的是 **HTTP 200 + 0 字节**（gelbooru dapi 对「没有这个标签」
 *  的答复形态），于是被记成「有响应但 0 条」——用户界面上就是 0 张卡。
 *  这里复用已有的 MyMemory 通道（xlateOne，30 分钟进程内缓存）把中文词翻成英文再拼成
 *  下划线标签（big breasts → big_breasts）。翻不出来、或译文跟已经试过的候选重复，
 *  就返回空串，如实回 0 条，不编结果。 */
async function booruTagToEnglish(tags, budget, tried) {
  const raw = String(tags || '').trim();
  if (!raw || !BOORU_CJK_RE.test(raw)) return '';
  /* 只翻「纯标签串」：带 rating:、括号、通配符这些 dapi 语法的串一律不动 */
  if (/[:()*~"']/.test(raw)) return '';
  let en = '';
  try {
    en = await xlateOne(raw, 'en', Math.max(1200, Math.min(3500, budget())));
  } catch (e) { return ''; }
  const tag = String(en || '').toLowerCase().replace(/[^a-z0-9_ ]+/g, ' ').trim().replace(/\s+/g, '_');
  if (!tag || tag === raw || !/[a-z]/.test(tag)) return '';
  if ((tried || []).indexOf(tag) >= 0) return '';
  return tag;
}

/** 依次试镜像，第一个「回得出合法 booru JSON」的算数（0 条也算数：那是真的没搜到）。
 *  候选顺序：**词典标签 → 原词 → 机器译文**（见 booruTagDict / booruTagToEnglish）。
 *  英文词（前端本地化后送来的就是英文标签串）在词典那一步就返回空串，
 *  候选表里只有原词 —— 行为与加这层之前逐字节一致。
 *  全挂就抛错，让上层照旧走原来的 CF 兜底与如实报错 —— 不假装成功。 */
async function danbooruMirrorFetch(qy) {
  const key = qy.tags + '\u0000' + qy.limit + '\u0000' + qy.page;
  const hit = booruMirrorCache.get(key);
  if (hit && Date.now() - hit.at < BOORU_MIRROR_CACHE_MS) {
    return { posts: hit.val, via: hit.via, cached: true, ms: 0 };
  }
  const errs = [];
  /* 整段镜像流程的共享死线：单发请求最多被镜像阶段花掉 9 秒（两个镜像 × 各自最多两次取页），
     超了就带着已收集的错误立刻掉回原链 —— 绝不允许再出现「一个 danbooru 请求卡 30~95 秒」。 */
  const tAll = Date.now();
  const budget = () => Math.max(1200, 9000 - (Date.now() - tAll));
  const cands = [];
  const dTag = booruTagDict(qy.tags);
  if (dTag) cands.push(dTag);
  cands.push(qy.tags);
  let got = null, usedTag = qy.tags;
  for (const tg of cands) {
    const r = await booruMirrorLadder(tg, qy, budget, errs);
    if (r && (!got || !got.posts.length)) { got = r; usedTag = tg; }
    if (got && got.posts.length) break;
    /* 已经试过的候选一个都没结果：再往下走要留够 1.2s 死线，否则就带着现状返回 */
    if (Date.now() - tAll > 7000) { log('danbooru 镜像：候选标签试到死线（' + tg + '），先按现状返回'); break; }
  }
  if ((!got || !got.posts.length) && qy.page === 1) {
    const en = await booruTagToEnglish(qy.tags, budget, cands);
    if (en) {
      log('danbooru 镜像：中文词「' + qy.tags + '」在镜像上 0 条（镜像是英文标签库），' +
        '用译文「' + en + '」把整条梯队再走一遍');
      const got2 = await booruMirrorLadder(en, qy, budget, errs);
      if (got2 && (got2.posts.length || !got)) { got = got2; usedTag = en; }
    }
  }
  if (!got) throw new Error('镜像全失败：' + errs.join('；'));
  booruMirrorCache.set(key, { at: Date.now(), val: got.posts, via: got.via });
  while (booruMirrorCache.size > 120) booruMirrorCache.delete(booruMirrorCache.keys().next().value);
  log('danbooru 镜像兜底：' + got.via + ' ← tags=' + (qy.tags || '(空)') +
    (usedTag && usedTag !== qy.tags ? '（镜像实查：' + usedTag + '）' : '') +
    ' pid=' + (qy.page - 1) + ' → ' + got.posts.length + ' 条（' + got.ms + 'ms）');
  return { posts: got.posts, via: got.via, cached: false, ms: got.ms };
}

/** danbooru 给回来的图片地址**可能是相对路径**（上游会给 `/data/xxx.jpg` 这种）。
 *  相对地址原样用会同时废掉主、备两条路（本轮修的就是这里）：
 *   · stripHost('/data/x.jpg') 得到空串 → gwFirst 恒 false，页地址留成**相对 URL**，
 *     浏览器会把它打到网关静态根上（404），而不是图床；
 *   · 备用地址 /api/proxy?url=%2Fdata%2Fx.jpg 会被网关以「url 必须是 http(s)」拒掉。
 *  所以生成页地址前先把相对地址解析成绝对 URL（复用既有常量 DANBOORU_BASE，不新造域名）：
 *   · 已经是绝对地址（带 scheme）→ **原样返回，一个字节都不动**（回归红线）；
 *   · `//cdn.donmai.us/x.jpg` 这类协议相对形式交给 new URL(rel, base)，会补上 https:；
 *   · 解析失败（畸形输入）→ 按原样返回，绝不抛。 */
function danbooruAbsUrl(u) {
  const raw = String(u == null ? '' : u);
  if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;
  try { return new URL(raw, DANBOORU_BASE + '/').href; } catch (e) { return raw; }
}

/** 一页图片地址。主/备顺序**按「有没有刚过完 CF 的凭证」决定**（本轮改的就是这里）：
 *   · 有凭证 → 主 = 网关 /api/proxy（带上 cookie + UA 代取，**用户 IP 不暴露给图床**），
 *             备 = cdn 直连（浏览器自带通行证；主地址被否时 reader.js 的 img.onerror
 *             会自动换 data-url-alt 再试一次，前端一行都不用改）；
 *   · 没凭证（从没撞过 CF / 凭证过了 15 分钟 TTL / 网关刚重启）→ **保持原样**：
 *             主 = cdn 直连，备 = /api/proxy。
 *  为什么不做成「无条件代理为主」：那样在没有凭证时首图必然先白撞一次 403（reader.js 的
 *  alt 兜底能救回来，但每次翻页都要多挨一个失败请求，等于平白变慢）。按凭证有无决定顺序，
 *  既拿到「不暴露 IP」的好处，又不会在没凭证时退化。 */
function danbooruPage(fileUrl, referer, w, h) {
  /* 先解析成绝对 URL：相对地址下 host 为空、gwFirst 恒 false，主地址会留成相对路径、
     备用地址又会被 /api/proxy 以「非 http(s)」拒掉 —— 这类条目两条路都不可用。 */
  const raw = danbooruAbsUrl(fileUrl);
  const viaGw = readerProxyUrl(raw, referer);
  const host = stripHost(raw);
  let pathname = '/';
  try { pathname = new URL(raw).pathname || '/'; } catch (e) { /* 非绝对 URL 就按根路径算 */ }
  const gwFirst = !!(viaGw && cfCredInjectable(host) && cfCredHeaderFor(host, pathname));
  const p = { url: gwFirst ? viaGw : raw };
  const alt = gwFirst ? raw : viaGw;
  if (alt && alt !== p.url) p.alt = alt;
  if (w > 0 && h > 0) { p.w = Math.round(w); p.h = Math.round(h); }
  return p;
}

async function readerDanbooru(id) {
  const referer = READER_HOSTS.danbooru;
  /* 4 分钟缓存：命中就直接回，不再打上游、更不再起 Chrome（翻回上一张/重新打开都受益） */
  const hit = dbReaderCache.get(String(id));
  if (hit && Date.now() - hit.at < DB_READER_CACHE_MS) {
    const val = Object.assign({}, hit.val);
    val.note = '本次命中网关进程内缓存（' + Math.round(DB_READER_CACHE_MS / 60000) +
      ' 分钟内），没有再打上游、也没有再起 Chrome。' + (val.note || '');
    return val;
  }
  const apiUrl = DANBOORU_BASE + '/posts/' + encodeURIComponent(id) + '.json';
  const got = await cfFetchWithSolver(apiUrl, {
    what: 'Danbooru', timeout: 15000,
    headers: { accept: 'application/json', referer: referer },
    okRe: DANBOORU_JSON_OK_RE, minBody: 200
  });
  let p = null;
  if (got.via === 'chrome') {
    /* Chrome 的 JSON 查看器把响应包在 <pre> 里 */
    p = cfJsonFromRenderedHtml(got.text);
    if (!p) {
      throw new Error('Danbooru：Chrome 把地址取回来了，但里面不是条目 JSON（' +
        (cfChallengeHtml(got.text) ? '仍然是 Cloudflare 挑战页' : '页面结构不认识，可能站点改版了') +
        '，共 ' + String(got.text).length + ' 字节）。' + cfSolverHint('Danbooru', null));
    }
  } else {
    try { p = JSON.parse(got.text); } catch (e) { throw new Error('Danbooru 返回的不是 JSON（可能被挡或改版了）'); }
  }
  if (Array.isArray(p)) p = p[0] || null;      /* 正常是对象；万一是数组就取第一条 */
  if (!p || typeof p !== 'object') throw new Error('Danbooru 这个条目的响应是空的（id 可能不对）');
  const file = (p.file_url || p.large_file_url || p.preview_file_url) || '';
  if (!file) {
    throw new Error('Danbooru 这个条目没有图片地址（可能是视频或已删除，也可能被设为私有）');
  }
  const at = String(file).lastIndexOf('.');
  const title = 'Danbooru #' + id + (at > 0 ? ' · ' + String(file).slice(at + 1).toLowerCase() : '');
  /* 单图、单章；多图 pool 本阶段不做 */
  const out = {
    title: title,
    referer: referer,
    chapters: [],
    pages: [danbooruPage(file, referer, p.image_width || 0, p.image_height || 0)],
    note: got.via === 'chrome'
      ? 'Danbooru 的接口被 Cloudflare 挡着，本次由本机 Chrome 过验证后取回（同一地址 5 分钟内走 CF 缓存）；' +
        '过验证时顺手在网关内存里缓存了本次的 cookie + UA（15 分钟），因此图片改由网关 ' +
        '/api/proxy 代取（主地址，用户 IP 不直接暴露给图床），cdn 直连作为备用地址兜底。'
      : 'Danbooru 本次直连成功，没有撞 Cloudflare（图片主地址仍是 cdn 直连，网关 /api/proxy 作备用）。'
  };
  dbReaderCache.set(String(id), { at: Date.now(), val: out });
  return out;
}

/* ==========================================================================
   阶段二新增：紳士漫畫（wnacg）—— 单章图集，主路一次拿全，?p=N 只作兜底
   --------------------------------------------------------------------------
   （以下都是本机实测，出口走网关自动探测到的本地代理）
   · id 就是 sources.js 里那条的图集号 aid（`/photos-index-aid-<aid>.html` 的 aid）。
   · 图集页把阅读器指向 /photos-item-aid-<aid>.html，它的响应体是
       $(document).ready(function(){ mReader.initData({"page_url":[…]}) });
     page_url 数组就是**按原站次序**从 0001 排到最后一张的完整清单。
     实测跨十几年的图集都命中：aid=5000 → 17 张、12345 → 19 张、100000 → 19 张、
     200000 → 83 张、386060 → 76 张、99999 → 517 张。所以主路只要一个请求，
     顺序天然正确，不需要拼页。
   · 坑：这个 JSON 带**尾逗号**（["…","…",]），JSON.parse 会直接抛 —— 先去尾逗号。
   · 图片地址自带 verify= 签名，**去掉签名一律 403**（实测同一地址无签名 → HTTP 403
     1518B；带签名 → 200 image/webp 231534B）。签名跟 Referer 无关（实测不带 Referer
     也 200），但 readerPage 仍照规矩带上图集页 Referer。
   · `?p=N`：新版 /photos-item 对 ?p=2 完全无视（实测 8467B、内容逐字相同）；
     老版 /photos-view-aid-<aid>.html?p=N 才是「一页一张图」。所以主路走 /photos-item
     （一次拿全、天然有序），只有它拿不到时才退回 ?p=N 逐页走。
   · 镜像域名会换：候选池见下，最近成功过的域名排最前（10 分钟内有效）。
   ========================================================================== */
/* ★r17 重排（2026-09-23 逐镜像实测，经网关 /api/proxy，q=人妻 搜索页 p1）★
   能出结果的只有 3 个：www.wnacg.com 4984ms/24 条（抖到 7160ms）、wnacg.com 5241ms/24 条、
   www.wnacg02.cc 1511ms 但是**另一个索引**（同一关键词回真·no-result 页）。
   其余全是坑，实测耗时：www.wnacg01.cc 12655ms 502；www.wn03.ru 12197ms 502；
   www.wn04.ru 11007ms 502；www.wnacg.date 7622ms 502；wnacg.ru 17715ms 502；
   www.wn07.ru 5039ms 502；www.wnacg03.cc / www.wnacg05.cc ~400ms 但只是
   `<title>Redirecting...</title>` 跳板页（当 0 条处理）。
   旧顺序把 www.wnacg01.cc（12.6s 死）排在第二位 ⇒ batch=3 的第一批就被它拖满，
   好镜像即便 5s 就出结果也白等。现在按「实测能通 + 快」重排，死的全部沉到最后。 */
const WN_READER_HOSTS = [
  'www.wnacg.com', 'wnacg.com', 'www.wnacg02.cc',
  'www.wnacg03.cc', 'www.wnacg05.cc', 'www.wnacg01.cc',
  'www.wn03.ru', 'www.wn04.ru', 'wnacg.ru', 'www.wn07.ru', 'www.wnacg.date'
];
const WN_LEGACY_MAX = 300;      // 老版 ?p=N 兜底最多走多少页（防死循环）

/** id → 图集号 aid：'386060' / 'aid-386060' / '/photos-index-aid-386060.html' 都认 */
function wnAid(id) {
  const s = String(id || '').trim();
  const m = s.match(/aid-(\d+)/i) || s.match(/^(\d+)$/);
  return m ? m[1] : '';
}

/** 协议相对（//img5.qy0.ru/…）补成绝对地址；data: / 空值一律丢掉 */
function wnAbsUrl(u) {
  const s = String(u || '').trim().replace(/&amp;/gi, '&');
  if (!s || /^data:/i.test(s)) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.indexOf('//') === 0) return 'https:' + s;
  return '';
}

/** /photos-item-aid-*.html → 按原站次序的图片地址数组（空数组 = 这条路上没有图） */
function wnItemPages(text) {
  const m = String(text || '').match(/"page_url"\s*:\s*(\[[\s\S]*?\])/);
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(m[1].replace(/,\s*([\]}])/g, '$1')); } catch (e) { return []; }
  return asArray(arr).map(wnAbsUrl).filter(Boolean);
}

/** 旧版单页图集页里的那张大图（<img class="photo">，次选 #pic_block 里第一张非缩略图） */
function wnLegacyPageImage(text) {
  const t = String(text || '');
  const tag = (t.match(/<img[^>]*class="[^"]*\bphoto\b[^"]*"[^>]*>/i) || [])[0] ||
    (t.match(/<div id="pic_block"[\s\S]{0,3000}?<img[^>]*>/i) || [])[0] || '';
  return wnAbsUrl((tag.match(/\bsrc="([^"]+)"/i) || [])[1] || '');
}

/** 图集页 <title> 去掉站名后缀（「-紳士漫畫移動版-專注分享漢化本子」） */
function wnTitle(text) {
  const raw = (String(text || '').match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '';
  return String(raw)
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'")
    .replace(/[-–—|]?\s*紳士漫畫[\s\S]*$/, '').trim();
}

function wnGet(host, path, timeout) {
  return outFetch('https://' + host + path, {
    timeout: timeout || 15000,
    headers: {
      accept: 'text/html,application/xhtml+xml,*/*',
      referer: 'https://' + host + '/'
    }
  });
}

/** 候选域名：最近成功过的排最前（10 分钟），省掉每次重试一轮挂掉的镜像 */
function wnHostOrder() {
  const last = String(state.wnHost || '');
  const pool = WN_READER_HOSTS.filter(h => h !== last);
  return (last && Date.now() - state.wnHostAt < 10 * 60e3) ? [last].concat(pool) : pool;
}

/** 老版兜底：/photos-view-aid-<aid>.html?p=N，N 从 1 递增，取到空页为止（p 升序 = 原站次序） */
async function wnLegacyPages(host, aid) {
  const out = [];
  for (let p = 1; p <= WN_LEGACY_MAX; p++) {
    let r;
    try { r = await wnGet(host, '/photos-view-aid-' + aid + '.html?p=' + p, 12000); }
    catch (e) { break; }
    if (!r.ok) break;
    const u = wnLegacyPageImage(r.text());
    if (!u) break;                       // 空页 = 走完了（新版这一路恒为空）
    out.push(u);
  }
  return out;
}

async function readerWnacg(id) {
  const aid = wnAid(id);
  if (!aid) {
    throw new Error('紳士漫畫的 id 需要图集号（形如 386060），收到的是「' + String(id || '') + '」');
  }
  const errs = [];
  let host = '';
  let urls = [];
  for (const h of wnHostOrder()) {
    let r;
    try { r = await wnGet(h, '/photos-item-aid-' + aid + '.html', 15000); }
    catch (e) { errs.push(h + ' 连不上'); continue; }
    if (!r.ok) { errs.push(h + ' HTTP ' + r.status); continue; }
    const got = wnItemPages(r.text());
    if (!got.length) { errs.push(h + ' 图集数据为空'); continue; }
    host = h; urls = got;
    break;
  }
  if (!urls.length) {
    /* 主路落空才走老版逐页兜底（今天线上所有实测图集都命中主路） */
    for (const h of wnHostOrder()) {
      const got = await wnLegacyPages(h, aid);
      if (got.length) { host = h; urls = got; break; }
      errs.push(h + ' 逐页兜底也没图');
    }
  }
  if (!urls.length) {
    throw new Error('紳士漫畫取不到这个图集的图片列表（' + (errs.slice(0, 4).join('；') || '所有镜像域名都失败') +
      '）—— 镜像域名可能已更换，可在「筛选 → 镜像域名」里追加，或稍后重试');
  }
  state.wnHost = host; state.wnHostAt = Date.now();
  const origin = 'https://' + host;
  const albumUrl = origin + '/photos-index-aid-' + aid + '.html';
  let title = '';
  try {
    const ri = await wnGet(host, '/photos-index-aid-' + aid + '.html', 12000);
    if (ri.ok) title = wnTitle(ri.text());
  } catch (e) { /* 标题拿不到不影响阅读 */ }
  return {
    title: title || ('紳士漫畫 #' + aid),
    referer: origin + '/',
    chapters: [],                                   // 单章作品：chapters 交空数组
    pages: urls.map(u => readerPage(u, albumUrl, 0, 0))
  };
}

/* ==========================================================================
   紳士漫畫（wnacg）**检索** —— 网关侧实现
   --------------------------------------------------------------------------
   为什么把检索搬到网关（前端原来的做法是「10 个镜像 × 3 条路径全量竞速」）：
     · 那套做法一次检索最多打 30 个上游请求，其中真被 SNI 阻断的镜像只能靠中继兜底，
       而中继是限流资源 —— 一次就把配额烧光（实测 AllOrigins 被这个竞速打成 429，
       之后**所有**需要中继的源一起失效）。
     · 镜像会持续换域名（实测 www.wn03.ru → 301 → www.wn07.ru，而 wn07.ru 又被 SNI 阻断），
       前端跟在浏览器里发请求时连 301 都不能跟（跨域），只能靠「枚举 + 赌一个能通」。
   网关侧能做到前端做不到的四件事：
     ① **分批竞速**（每批 3 个，先到先得）而不是把 10 个一起甩出去；
     ② **跟随 301/302**（hsRequest 已实现）—— www.wnacg.date 就是靠这个回到 www.wnacg.com；
     ③ **记住最近成功的镜像**（state.wnHost，10 分钟）并给失败主机上冷却（pickProbe/hostDead）；
     ④ **结果缓存 5 分钟**：翻页、重绘、同词重搜都不再打上游。
   返回结构与其它网关源一致：{ source, host, total, items[] }。
   ========================================================================== */
const WN_SEARCH_CACHE_MS = 5 * 60e3;
const wnSearchCache = new Map();        // key → { at, val }
/* 本轮新增的时间预算（根因与取值理由见 wnacgSearch 里的「总预算」注释）：
   旧实现每个镜像 15s、每条路径都独立竞速，实测最慢 28.6s。
   第 16 轮起：单镜像 7s、**整段 7800ms** —— 不能再大于 WN_HARD_MS(8500)，
   否则内层还在跑、外层硬闸已经先把整源判死，多出来的预算全是空转
   （旧值 12000 > 8500，本身就是自相矛盾）。 */
const WN_HOST_MS = 7000;
const WN_BUDGET_MS = 7800;
/* 第 10 轮：镜像**全挂**时不许再白烧预算。实测（本机、11 个镜像全不可达）
   「已试 3 条路径 / 11 个镜像」要烧 14023ms —— 比前端整轮 cap（9500ms）还长，
   表现就是整轮被这一个源拖成超时。现在两件事：
     ① 确认「所有镜像都连不上」后记 30 秒短冷却，之后每一次都是毫秒级如实报错；
     ② 外面再套一个 8500ms 函数级硬闸 —— pickProbe 的多批竞速实测会超过 WN_BUDGET_MS
        （路径循环 + 批内 3 个镜像各 7s），预算归预算、硬闸归硬闸。
   ★ 只有「所有镜像都不可达」才记冷却；被硬闸掐掉的（可能只是慢、但本来能成功）不记，
     免得把用户接下来 30 秒的正常检索也一起挡掉。 */
const WN_NET_COOLDOWN_MS = 30e3;
const WN_HARD_MS = 8500;
/* ★r17 根因（2026-09-23 真机复现「紳士漫畫偶尔不返回结果」）★
   现象：搜「人妻」8560ms 回 ok:false「超过 8500ms 硬闸」，而同一个词稍后又能出结果 —— 随机的。
   机制（两道闸门互相错位）：
     ① 每个镜像的超时写成 `Math.max(2000, Math.min(WN_HOST_MS, left() - 800))` ——
        **地板 2000ms 与 left() 无关**。路径 1 的 per=7000、hard timeout=7400ms 跑完后，
        left() 只剩 400ms，但 pickProbe 的 deadline 判断是「7400 < 7800 ⇒ 还能再开一批」，
        于是第二批照样拿到 2000ms（地板）→ 跑到 ~9800ms；
     ② 外层硬闸 WN_HARD_MS=8500 是**函数级**的，不会中断内层，只会先把整源判死。
   ⇒ 内层还在跑、结果马上就有，外层已经报了「超过硬闸」。这就是「偶尔」。
   修法：per 的地板收到 700ms（永不超过剩余预算）+ pickProbe 的 deadline 提前一个
   「最小批次耗时」（WN_BATCH_MIN_MS）—— 开不出一批就干脆不开，让内层在预算内收口。
   硬闸保持 8500 只当保险丝（正常情况下永远不该响）。 */
const WN_BATCH_MIN_MS = 1000;   // 一个批次（per 地板 700 + hard timeout 余量 400）的最小耗时
let wnNetDownUntil = 0;
let wnNetDownWhy = '';
/* 分类编号 → 前端卡片用的分类名（与 sources.js 的 WN_CATE_LABEL 同口径） */
const WN_CATE_LABEL = {
  1: 'doujinshi', 2: 'artbook', 3: 'cosplay', 5: 'doujinshi', 6: 'comic',
  7: 'oneshot', 9: 'comic', 10: 'oneshot', 12: 'doujinshi', 13: 'comic',
  14: 'oneshot', 16: 'doujinshi', 17: 'comic', 18: 'oneshot', 19: 'hanman',
  20: 'hanman', 21: 'hanman', 22: '3d'
};

/** 紳士的 HTML 实体解码（标题里有 &amp; / &#39; / 搜索高亮的 <em> 等） */
function wnDecode(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, '')                    // 搜索高亮 <em> 之类
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(parseInt(d, 10)))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从一段 HTML 里取缩略图地址。
    ★不能写成 `<img[^>]*src="…"`★：绅士检索结果页会把命中词高亮成 `<em>`，
    而高亮是**写在 alt 属性里**的 —— `alt="…(<em>Fate</em>)…"` 里的 `>` 会让 `[^>]*` 提前收尾，
    整个 img 标签被截断，src 永远匹配不到（实测表现就是「条目有、封面全空」）。
    所以这里直接找资源地址本身，并要求它以 `//` 或 `http` 开头（把站点 logo 的 `data:` 排除掉）。 */
function wnPickCover(html) {
  const m = String(html || '').match(/(?:data-src|data-original|src)="((?:https?:)?\/\/[^"]+)"/i);
  return m ? wnAbsUrl(m[1]) : '';
}

/** 检索结果页 → 条目数组。主路认 .gallary_item 的块，块结构变了就退回「锚点+标题」扫全页。 */
function wnParseItems(html) {
  const t = String(html || '');
  const out = [];
  const seen = {};
  const add = (blk, href, title, cate) => {
    const id = (String(href).match(/aid-(\d+)/) || [])[1] || '';
    if (!id || seen[id]) return;
    const name = wnDecode(title);
    if (!name) return;
    seen[id] = 1;
    out.push({ id: id, title: name, cover: wnPickCover(blk), cate: String(cate || '') });
  };
  const blockRe = /<li[^>]*class="[^"]*\bgallary_item\b[^"]*"[\s\S]*?(?=<li[^>]*class="[^"]*\bgallary_item\b|<\/ul>)/gi;
  let m;
  while ((m = blockRe.exec(t))) {
    const blk = m[0];
    const href = (blk.match(/href="([^"]*photos-index-aid-\d+\.html[^"]*)"/i) || [])[1] || '';
    const title = (blk.match(/<a[^>]*\btitle="([^"]*)"/i) || [])[1] ||
      (blk.match(/<img[^>]*\balt="([^"]*)"/i) || [])[1] || '';
    const cate = (blk.match(/pic_box\s+cate-(\d+)/i) || [])[1] || '';
    add(blk, href, title, cate);
  }
  if (!out.length) {
    /* 兜底：整页扫 photos-index-aid-*，标题取锚点 title，封面取该锚点前后一段里的资源地址 */
    const re = /href="([^"]*photos-index-aid-(\d+)\.html[^"]*)"[^>]*\btitle="([^"]*)"/gi;
    let a;
    while ((a = re.exec(t))) {
      const at = a.index;
      const around = t.slice(Math.max(0, at - 300), at + 600);
      const cate = (around.match(/pic_box\s+cate-(\d+)/i) || [])[1] || '';
      add(around, a[1], a[3], cate);
    }
  }
  return out;
}

/** 检索候选路径（按「命中率从高到低」，与前端原实现同口径，只是多了一条 /search/?q=&m=0 的旧式） */
function wnSearchPaths(q, page, catId) {
  const paths = [];
  if (q) {
    paths.push('/search/?q=' + encodeURIComponent(q) + '&f=_all&s=create_time_DESC&syn=yes' +
      (page > 1 ? '&p=' + page : ''));
    paths.push('/search/?q=' + encodeURIComponent(q) + '&m=0' + (page > 1 ? '&p=' + page : ''));
    if (page === 1) paths.push('/albums-index-tag-' + encodeURIComponent(q) + '.html');
  }
  if (catId) {
    paths.push('/albums-index-cate-' + catId + '.html');
    if (page > 1) paths.push('/albums-index-page-' + page + '-cate-' + catId + '.html');
  }
  if (!paths.length) paths.push('/albums.html');
  return paths;
}

/** 第 10 轮：外面这层只做两件事 ——
    ① 「所有镜像刚确认都连不上」的 30 秒短冷却：之后每次都是毫秒级如实报错，
       不再让整轮检索陪着这个源烧 12～14 秒（实测镜像全挂时 14023ms）；
    ② 8500ms 函数级硬闸：内部 pickProbe 的多批竞速实测会超过 WN_BUDGET_MS。
    内部逻辑一行没动，全在 wnacgSearchInner。 */
async function wnacgSearch(query) {
  if (wnNetDownUntil > Date.now()) {
    const secs = Math.ceil((wnNetDownUntil - Date.now()) / 1000);
    const e = new Error('紳士漫畫镜像当前都连不上（' + secs + ' 秒内不再重试）：' +
      (wnNetDownWhy || '最近一次所有镜像都超时'));
    e.soft = 1;
    throw e;
  }
  let timer = null;
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('超过 ' + WN_HARD_MS + 'ms 硬闸（镜像竞速的总耗时超过预算）')), WN_HARD_MS);
  });
  try {
    return await Promise.race([wnacgSearchInner(query), guard]);
  } catch (e) {
    const err = new Error('紳士漫畫取数失败：' + ((e && e.message) || e));
    err.soft = 1;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function wnacgSearchInner(query) {
  const q = String(query.q || '').trim();
  const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
  const limit = Math.min(60, Math.max(10, parseInt(query.limit || '30', 10) || 30));
  const catId = String(query.cat || '').replace(/[^0-9]/g, '');
  if (!q && !catId) throw new Error('缺少关键词 q');
  const key = [q, page, catId, limit].join('|');
  const hit = wnSearchCache.get(key);
  if (hit && Date.now() - hit.at < WN_SEARCH_CACHE_MS) {
    return Object.assign({}, hit.val, { cached: true });
  }

  const hosts = wnHostOrder().filter(h => (hostDead.get(h) || 0) < Date.now());
  const pool = hosts.length ? hosts : wnHostOrder();
  const paths = wnSearchPaths(q, page, catId);
  const merged = [];
  const seen = {};
  const errs = [];

  /* ★总预算★（本轮新增）：旧实现每条路径都用 pickProbe 竞速 3 个镜像、每个 15s，
     而 paths 有多条 —— 串起来实测能到 28.6s（关键词「巨乳」）。
     现在：整段不超过 WN_BUDGET_MS，每个镜像的超时按**剩余预算**给，
     预算耗尽就带着已有结果返回（有货返回货，没货交给调用方降级），
     绝不允许某一条慢路径把整次检索拖到 20s 以上。 */
  const t0 = Date.now();
  const left = () => WN_BUDGET_MS - (Date.now() - t0);
  /* r17：只要有一个镜像**真的答了页**（哪怕是 no-result 页），就说明站点是通的 ——
     用于把「源挂了」和「这个词确实 0 条」分开，别再一律报「未返回结果」。 */
  let pageOk = false;

  for (const path of paths) {
    /* eslint-disable no-await-in-loop */
    /* r17：1800ms 起不了步就收工（地板 700 + 硬超时余量 400 = 1100ms 一个批次） */
    if (left() < 1800) break;
    let got;
    try {
      got = await pickProbe(pool, h => {
        /* ★r17★ 地板 2000 → 700：per 必须跟着剩余预算走，否则第二批会「预算外」多跑 2.4s，
           把内层拖过 WN_HARD_MS（见 WN_BATCH_MIN_MS 上的根因注释）。 */
        const per = Math.max(700, Math.min(WN_HOST_MS, left() - 700));
        return withHardTimeout(wnGet(h, path, per).then(r => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const text = r.text();
          /* 认出「真页面」的三种形态：列表页有 gallary_item、条目链接有 aid-N、
             空结果页有 no-result（www.wnacg02.cc 实测就是这种）。跳板页
             `<title>Redirecting...</title>` 不算，它什么都说明不了。 */
          if (/gallary_item|aid-\d+|no-result|No\s*Results?/i.test(text)) pageOk = true;
          const items = wnParseItems(text);
          /* 「返回 0 条」是这一条路径的正常空结果，不是主机挂了 —— 不记冷却（pickProbe 里有白名单） */
          if (!items.length) throw new Error(path.split('?')[0] + ' 返回 0 条');
          return { host: h, items: items };
        }), per + 400, '绅士镜像 ' + h);
      }, { batch: 3, deadline: t0 + WN_BUDGET_MS - WN_BATCH_MIN_MS });
    } catch (e) {
      errs.push(String((e && e.message) || e).slice(0, 120));
      continue;
    }
    state.wnHost = got.host; state.wnHostAt = Date.now();
    (got.val.items || []).forEach(it => {
      if (seen[it.id]) return;
      seen[it.id] = 1;
      merged.push(it);
    });
    /* 够了就收手：命中数达到 limit 的一半（至少 4 条）就停，省掉剩下的上游请求 */
    if (merged.length >= Math.max(4, Math.ceil(limit / 2))) break;
  }

  if (!merged.length) {
    /* ★r17★：有镜像**真的答了页**（pageOk）⇒ 这是「这个词 0 条结果」，不是「源挂了」。
       旧实现一律抛「未返回结果」并背 30 秒冷却 —— 用户看到的就是「绅士偶尔不返回结果」。
       0 条不写缓存：万一上游是偶发限流给了空页，别把它钉死 5 分钟。 */
    if (pageOk) {
      return {
        source: 'wnacg', host: state.wnHost || '', total: 0, items: [],
        note: '紳士漫畫：镜像已应答，但这一页确实 0 条结果 —— 换个关键词，' +
          '或在「筛选 → 镜像域名」里换一个镜像（不同镜像的索引并不一致：实测同一个词 ' +
          'www.wnacg.com 有 24 条、www.wnacg02.cc 却是 0 条）'
      };
    }
    const why = '已试 ' + paths.length + ' 条路径 / ' + pool.length + ' 个镜像：' +
      (errs.slice(0, 2).join('；') || '全部失败');
    /* 第 10 轮：到这里就说明「所有镜像都不可达」= 网络层全断，不是「0 条结果」。
       记 30 秒短冷却，让接下来几次检索毫秒级如实报错（见 wnacgSearch 外层）。
       ★r17★：冷却文案**不许带上这一次的查询痕迹** —— 旧实现把整句连关键词一起存下来，
       于是下一次搜别的词，报错里还写着上一次的词。真机实测：搜「巨乳」时，
       报错写着「/search/?q=%E4%BA%BA%E5%A6%BB&f=_all…」（上一次搜的是人妻），
       纯复读机且误导（用户会以为这次搜的是「人妻」）。存之前先把查询串剥掉。 */
    wnNetDownUntil = Date.now() + WN_NET_COOLDOWN_MS;
    wnNetDownWhy = why.replace(/[?&][A-Za-z_]+=[^\s；)]*/g, '').replace(/\s+/g, ' ').slice(0, 160);
    const e = new Error('紳士漫畫未返回结果（' + why +
      '）。镜像域名会换，可在「筛选 → 镜像域名」里追加');
    e.soft = 1;
    throw e;
  }

  const items = merged.slice(0, limit).map(it => ({
    id: it.id,
    title: it.title,
    cover: it.cover,
    url: 'https://' + (state.wnHost || WN_READER_HOSTS[0]) + '/photos-index-aid-' + it.id + '.html',
    artist: '',
    tags: it.cate ? [WN_CATE_LABEL[it.cate] || ''].filter(Boolean) : [],
    pages: null,
    note: '紳士漫畫 · 网关镜像竞速（' + (state.wnHost || '') + (errs.length ? '，已跳过 ' + errs.length + ' 条失败路径' : '') + '）'
  }));
  const val = { source: 'wnacg', host: state.wnHost || '', total: merged.length, items: items };
  wnSearchCache.set(key, { at: Date.now(), val: val });
  if (wnSearchCache.size > 200) {
    const oldest = wnSearchCache.keys().next().value;
    wnSearchCache.delete(oldest);
  }
  return Object.assign({}, val, { cached: false });
}

/* ==========================================================================
   阶段二新增：E-Hentai（gid + 10 位 token）
   --------------------------------------------------------------------------
   （以下都是本机实测，出口走网关自动探测到的本地代理）
   · **只有 gid 不够**：图集 URL 必须是 /g/<gid>/<10位token>/。三条反查路都堵死：
       GET  https://e-hentai.org/g/4200093/                      → HTTP 404
       POST https://e-hentai.org/api.php gdata [[4200093,"0000000000"]]
                                                                 → {"gmetadata":[{"gid":4200093,
                                                                   "error":"Key missing, or incorrect key provided."}]}
       高级搜索表单（/z/0381/ehg_index.c.js）里只有 f_search/f_cats/f_sh/f_spf…，
       **没有 gid 字段**。
     所以这里同时接受 `<gid>-<token>` / `<gid>:<token>` / `<gid>/<token>` / 整条
     `/g/<gid>/<token>/` URL；只给 gid 时如实报错并说明要在 sources.js 里补什么，
     绝不猜 token。
   · 图集页 /g/<gid>/<token>/：标题在 <h1 id="gn">，总页数在 #gdd 的
     「Length: N pages」。缩略图区 <div id="gdt" class="gt200"> 每页 20 个，
     分页是图集页自己的 ?p=N（实测 117 页的图集给出 ?p=1..6），
     每个缩略图 = <a href="https://e-hentai.org/s/<ptoken>/<gid>-<n>">。
   · **真实大图地址只能逐页解析（N+1）**：/s/<ptoken>/<gid>-<n> 里
     <img id="img" src="https://<节点>.hath.network/h/…">，尺寸在 #i4
     「文件名 :: 800 x 1204 :: 92.11 KiB」。实测该图首图 → 200 image/webp 94316B。
   · 因此按任务要求做了三件事：
     ① 串行 + 启动间隔 >= 300ms 的限速（进程内所有 E-Hentai 请求共用一个闸门）；
     ② 单次最多 40 页，超出用 note 说明「已取前 N 页（共 M 页）」；
     ③ 4 分钟进程内缓存（键含 gid+token），翻回上一页直接命中缓存、不再打上游。
   · 顺带记录（与阅读器无关）：本机出口下 E-Hentai 的搜索接口不给结果 ——
     ?f_search=… 一律「No hits found」（首页与 /popular 正常）。
   ========================================================================== */
const EH_HOST = 'https://e-hentai.org';
const EH_REFERER = EH_HOST + '/';
const EH_MAX_PAGES = 40;        // 单次最多解析多少张真实大图（N+1，必须封顶）
const EH_THROTTLE_MS = 300;     // 两次上游请求的启动间隔下限（要求 ~250–400ms）
const EH_CACHE_MS = 4 * 60e3;   // 进程内短缓存 4 分钟
const EH_THUMBS_PER_PAGE = 20;  // 图集页每屏 20 个缩略图（实测）
const ehCache = new Map();      // key(gid|token) -> { at, val }

let ehChain = Promise.resolve();
let ehNextAt = 0;
/** 所有 E-Hentai 上游请求共用一个串行闸门：既保证「相邻两次请求启动间隔 >= EH_THROTTLE_MS」，
    也保证并发的 /api/reader 调用不会把上游打成一片 */
function ehSerial(task) {
  const run = ehChain.then(async () => {
    const gap = ehNextAt - Date.now();
    if (gap > 0) await sleep(gap);
    ehNextAt = Date.now() + EH_THROTTLE_MS;
    return task();
  });
  ehChain = run.then(() => {}, () => {});
  return run;
}

/** E-Hentai 的失败几乎都「有话说」，按原话给中文解释，别压成 HTTP 码 */
function ehBodyErr(status, body) {
  const b = String(body || '');
  if (/Key missing, or incorrect key provided/i.test(b)) {
    return 'E-Hentai 说这条图集链接的 token 不对（原话：Key missing, or incorrect key provided.）' +
      '—— id 必须是 gid-token 两段，例如 4200093-58001d7146';
  }
  /* 实测 /g/99999999/abcdefabcdef/ → HTTP 200 + 这行原话（跟 404 不是一回事） */
  if (/Gallery not found/i.test(b)) {
    return 'E-Hentai 说没有这个图集（原话：Gallery not found. If you just added this gallery, ' +
      'you may have to wait a short while…）—— gid/token 可能填错了，也可能刚上传还没生效或已被回滚';
  }
  if (/temporarily banned|Your IP address has been/i.test(b)) {
    /* ★别写成「封了当前出口 IP」★（2026-09-23 修）：e-hentai 是按**取页那一跳的出口**认的，
       而走中继时那一跳是**中继的出口**（自建 Cloudflare Pages 中继、公共 CORS 中继，
       都是很多人共用的机房 IP），不是用户的 IP，也不是本机直连的 IP。
       ★r17（2026-09-23 真机复现）★：这份封禁页 HTTP 200、242 字节，正文写着
       「The ban expires in 5 minutes and 12 seconds」—— 也就是**上游亲口给了倒计时**。
       旧文案里还写死了「中继（cors.eu.org）」这个具体名字，而实际那一跳早就换成自建私有中继了，
       属于误导（用户会去查一个根本没在用的中继）。现在只讲「取页那一跳的出口」并带上倒计时。 */
    const left = ehBanLeftMs(b);
    const leftTxt = left
      ? ('上游说还要 ' + (left >= 60000 ? Math.ceil(left / 60000) + ' 分钟' : Math.ceil(left / 1000) + ' 秒') + ' 解封')
      : '上游没给倒计时';
    return 'E-Hentai 限流封禁（HTTP ' + status + '）：封的是**取页那一跳的出口** —— ' +
      '走中继取页时那就是中继的共享出口（自建 Cloudflare Pages 中继 / 公共 CORS 中继都一样，' +
      '很多人共用同一批机房 IP），不是你的 IP，也不是本机直连的 IP' +
      '（原话：Your IP address has been temporarily banned due to an excessive request rate；' + leftTxt + '）。' +
      '★r17★：网关现在按上游给的倒计时冷却，**不再每 25 秒去撞一次**同一个被封的出口；' +
      '想立刻恢复：把你的墙外出口交给网关（启动加 --proxy http://127.0.0.1:端口，或先设 HTTPS_PROXY），' +
      '换一张出口 IP 即可';
  }
  if (/This gallery is unavailable|Sad Panda/i.test(b)) {
    return 'E-Hentai 说这个图集对当前出口不可见（原话：This gallery is unavailable）—— ' +
      '这类图集（exhentai / R-18 门槛内容）要在浏览器里带登录 cookie 才能看，网关没有 cookie，这里不伪造结果';
  }
  if (/exceeded the image viewing limits/i.test(b)) {
    return 'E-Hentai 的图片查看额度用完了（原话：You have exceeded the image viewing limits）—— 等一会儿再读';
  }
  if (status === 509) return 'E-Hentai 回了 HTTP 509（额度/带宽限制），等一会儿再读';
  return '';
}

/** 串行 + 限速取一个 E-Hentai 页面，返回 HTML；失败一律抛中文错误（不抛栈）
    cookie：**只有显式传进来才带**。阅读器（逐页看图）一个字都不改 —— 它继续不带
    cookie、继续走同一套限速与缓存（少一个变量，既有行为原样保留）。
    opts.relayOnly：只走中继（= 换一个出口 IP）。中继不转 cookie，调用方别指望它带登录态。 */
async function ehHtml(url, what, timeout, cookie, opts) {
  const h = { accept: 'text/html,application/xhtml+xml,*/*', referer: EH_REFERER };
  const ck = String(cookie == null ? '' : cookie).trim();
  if (ck) h.cookie = ck;
  const relayOnly = !!(opts && opts.relayOnly);
  const r = await ehSerial(async () => {
    try {
      return await outFetch(url, {
        timeout: timeout || 20000, headers: h,
        relayOnly: relayOnly, image: false
      });
    } catch (e) {
      throw new Error('连不上 ' + what + '：' + ((e && e.message) || e));
    }
  });
  const body = r.buf.toString('utf8');
  ehHtml.lastVia = r.via || '';        /* 这一页到底是哪条腿给的（env/doh/relay），给上层写进 note 用 */
  /* ★r17：记下上游亲口说的解封时刻★（封禁页里带「The ban expires in 5 minutes and 12 seconds」）。
     冷却照它走，不再每 25 秒去撞一次同一个已被封的出口。
     反过来，真拿到页面（r.ok 且不是封禁页）就说明封禁确实过去了，清掉记录。 */
  const banLeft = ehBanLeftMs(body);
  if (banLeft) { ehBanUntil = Date.now() + banLeft + 3000; ehBanEgress = egress.live || ''; }
  else if (r.ok) { ehBanUntil = 0; ehBanEgress = ''; }
  const why = ehBodyErr(r.status, body);
  if (why) throw new Error(why);
  if (!r.ok) throw new Error(readerUpstreamErr(what, r));
  return body;
}

/** HTML 实体 + 标签清理（网关没有 DOM，正则足够对付 E-Hentai 的标题/属性） */
function ehPlain(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&#0?39;/gi, "'")
    .replace(/&#(\d+);/g, (m, d) => { const n = parseInt(d, 10); return isFinite(n) ? String.fromCharCode(n) : m; })
    .replace(/\s+/g, ' ').trim();
}

/** id → {gid, token}；token 缺失时为 ''（后面如实报错，不猜） */
function ehIdParts(id) {
  const s = String(id || '').trim();
  const byUrl = s.match(/\/g\/(\d+)\/([0-9a-f]{6,})\/?/i);
  if (byUrl) return { gid: byUrl[1], token: byUrl[2].toLowerCase() };
  const byPair = s.match(/^(\d+)\s*[-:\/]\s*([0-9a-f]{6,})$/i);
  if (byPair) return { gid: byPair[1], token: byPair[2].toLowerCase() };
  if (/^\d+$/.test(s)) return { gid: s, token: '' };
  return null;
}

/** 图集页 → { title, total }：总页数在 #gdd 的「Length: N pages」里 */
function ehGalleryMeta(html) {
  const h = String(html || '');
  const title = ehPlain((h.match(/<h1 id="gn">([\s\S]*?)<\/h1>/i) || [])[1] || '');
  const len = h.match(/Length:<\/td>\s*<td class="gdt2">\s*(\d+)\s*pages?/i);
  return { title: title, total: len ? parseInt(len[1], 10) : 0 };
}

/** 图集页 → 本屏的缩略图链接（每个指向一页的 /s/<ptoken>/<gid>-<n>） */
function ehThumbLinks(html, gid) {
  const out = [];
  const re = /href="(https:\/\/e-hentai\.org\/s\/[0-9a-f]+\/(\d+)-(\d+))"/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    if (m[2] !== String(gid)) continue;
    out.push({ url: m[1], n: parseInt(m[3], 10) });
  }
  return out;
}

/** 阅读页 → 真实大图地址 + 尺寸（#i4 里是「文件名 :: 800 x 1204 :: 92.11 KiB」） */
function ehPageImage(html) {
  const h = String(html || '');
  const tag = (h.match(/<img[^>]*\bid="img"[^>]*>/i) || [])[0] || '';
  const url = ehPlain((tag.match(/\bsrc="([^"]+)"/i) || [])[1] || '');
  let w = 0, ht = 0;
  const info = (h.match(/<div id="i4">\s*<div>([\s\S]{0,200}?)<\/div>/i) || [])[1] || '';
  const m = info.match(/(\d+)\s*x\s*(\d+)/);
  if (m) { w = parseInt(m[1], 10); ht = parseInt(m[2], 10); }
  if (!w) {
    const st = (tag.match(/\bstyle="([^"]*)"/i) || [])[1] || '';
    const wm = st.match(/width:\s*(\d+)px/i);
    const hm = st.match(/height:\s*(\d+)px/i);
    if (wm && hm) { w = parseInt(wm[1], 10); ht = parseInt(hm[1], 10); }
  }
  return { url: url, w: w, h: ht };
}

async function readerEhentai(id) {
  const parts = ehIdParts(id);
  if (!parts) {
    throw new Error('E-Hentai 的 id 需要 gid 或 gid-token（例如 4200093-58001d7146），收到的是「' +
      String(id || '') + '」');
  }
  if (!parts.token) {
    /* 只有 gid：**如实报错**，把实测证据一起给出来，绝不猜 token */
    let why = '';
    try {
      await ehHtml(EH_HOST + '/g/' + parts.gid + '/', 'E-Hentai 图集页', 12000);
      why = '返回了内容但里面没有图集数据';
    } catch (e) { why = (e && e.message) || String(e); }
    throw new Error('E-Hentai 图集链接必须带 10 位 token（形如 ' + parts.gid + '-xxxxxxxxxx），' +
      '当前 id 只有 gid=' + parts.gid + '，网关无法从 gid 反查 token（实测 /g/' + parts.gid + '/ → ' +
      why + '）。请在 sources.js 里把 ehentai 条目的 id 换成整条图集 URL（href）或 gid-token —— ' +
      '搜索结果里的 href 两段都有。');
  }
  const key = parts.gid + '|' + parts.token;
  const hit = ehCache.get(key);
  if (hit && Date.now() - hit.at < EH_CACHE_MS) {
    const val = Object.assign({}, hit.val);
    val.note = '本次命中网关进程内缓存（' + Math.round(EH_CACHE_MS / 60000) + ' 分钟内），没有再打上游。' +
      (val.note || '');
    return val;
  }

  const gUrl = EH_HOST + '/g/' + parts.gid + '/' + parts.token + '/';
  const gHtml = await ehHtml(gUrl, 'E-Hentai 图集页', 20000);
  const meta = ehGalleryMeta(gHtml);
  const total = meta.total || 0;
  const want = total > 0 ? Math.min(total, EH_MAX_PAGES) : EH_MAX_PAGES;

  /* 缩略图按图集页自己的 ?p=N 分屏，每屏 20 个。收集完再按链接里的 -<n> 升序排一次
     —— 「顺序严格按原站页码升序」以链接自带的页号为准，不依赖上游给的先后。 */
  const byN = Object.create(null);
  const maxThumbScreen = Math.ceil(want / EH_THUMBS_PER_PAGE) + 2;
  for (let p = 1; p <= maxThumbScreen; p++) {
    const html = p === 1 ? gHtml : await ehHtml(gUrl + '?p=' + p, 'E-Hentai 图集页第 ' + p + ' 屏', 20000);
    const links = ehThumbLinks(html, parts.gid);
    if (!links.length) break;
    links.forEach(l => { if (!byN[l.n]) byN[l.n] = l.url; });
    const have = Object.keys(byN).length;
    if (have >= want) break;
    if (links.length < EH_THUMBS_PER_PAGE) break;      // 已经翻到最后一屏
  }
  const order = Object.keys(byN).map(Number).sort((a, b) => a - b).slice(0, want);
  if (!order.length) {
    /* /g/<gid>/<token>/ 可能是「已删除 / 已下架」——实测 torrents 兜底给的 id 里就有这种：
         实测 /g/4198767/be3c3c672e/ → HTTP 404 + 「This gallery has been removed or is unavailable.」
         实测 /g/4085483/31ffdbbb4c/ → HTTP 200 但 **0 字节**（服务端没给内容）
       所以这里把「原站状态」如实讲出来，别让用户以为网关坏了。 */
    const gone = /This gallery has been removed or is unavailable|Gallery not found/i.test(gHtml);
    if (gone) {
      throw new Error('E-Hentai 说这个图集已被删除或不可用（原话：This gallery has been removed or is unavailable）' +
        '—— gid/token 本身有效，是图集在原站已经没了');
    }
    if (String(gHtml || '').trim().length < 400) {
      throw new Error('E-Hentai 图集页返回了空内容（' + String(gHtml || '').length + ' 字节）—— ' +
        '这个图集可能刚被删除/隐藏，或当前出口被临时限流；换一个 gid-token 或稍后重试');
    }
    throw new Error('E-Hentai 图集页里没有解析到任何阅读页链接（也没读到总页数）—— 图集可能被隐藏或者站点改版了');
  }

  /* N+1：逐页解析真实大图。顺序严格按页号升序；个别页失败就跳过并如实记数 */
  const referer = EH_REFERER;
  const pages = [];
  let firstErr = null;
  let failed = 0;
  for (let i = 0; i < order.length; i++) {
    const n = order[i];
    try {
      const h = await ehHtml(byN[n], 'E-Hentai 第 ' + n + ' 页', 20000);
      const img = ehPageImage(h);
      if (!img.url) throw new Error('E-Hentai 第 ' + n + ' 页里没有找到大图地址');
      pages.push(readerPage(img.url, referer, img.w, img.h));
    } catch (e) {
      failed++;
      if (!firstErr) firstErr = e;
    }
  }
  if (!pages.length) throw (firstErr || new Error('E-Hentai 一张图都没取到'));

  const out = {
    title: meta.title || ('E-Hentai ' + parts.gid),
    referer: referer,
    chapters: [],
    pages: pages
  };
  const bits = ['E-Hentai 的真实大图地址只能逐页解析（N+1），网关已限速到每 ' + EH_THROTTLE_MS +
    'ms 一次请求，并且单次最多取 ' + EH_MAX_PAGES + ' 页。'];
  if (total > pages.length) bits.push('本次只取了前 ' + pages.length + ' 页（该图集共 ' + total + ' 页）。');
  else if (failed) bits.push('本次取到 ' + pages.length + ' 页（该图集共 ' + (total || pages.length) + ' 页）。');
  if (failed) bits.push('其中 ' + failed + ' 页上游没取到，已按原顺序跳过。');
  out.note = bits.join('');
  /* 只有整本取齐才进缓存，避免把「少了页」的结果缓存 4 分钟 */
  if (!failed) ehCache.set(key, { at: Date.now(), val: out });
  return out;
}

/* ==========================================================================
   阶段三新增：Hitomi（hitomi.la）—— 图集信息 + gg.js 路径映射
   --------------------------------------------------------------------------
   （全部是本机实测，出口走网关自动探测到的本地代理 127.0.0.1:7897）
   · **hitomi.la 的 HTML 页面是纯 JS 壳子**：/galleries/<id>.html 恒为 5636 字节、
     里面一个 <img> 都没有；真正的图集数据在 CDN 上：
       GET https://ltn.gold-usergeneratedcontent.net/galleries/<galleryId>.js
         → var galleryinfo = { id, title, type, files:[{name,hash,width,height,hasavif}], ... }
     实测：/galleries/1234.js → HTTP 200 json（1868B），id=4458、files=2。
     注意 galleryinfo.id 与 URL 上的数字**未必相同**（1234 → 4458），
     图片目录要用 files[].hash，不能用 URL 上的 id。
   · 图片地址 =  {子域}.gold-usergeneratedcontent.net/{gg.b}{目录}/{hash}.{ext}
       · 目录 = gg.s(hash) = parseInt(末2位 + 末1位, 16) 的**十进制字符串**
         （common.js: s: function(h){var m=/(..)(.)$/.exec(h);return parseInt(m[2]+m[1],16).toString(10);}）
         实测三条：hash 尾 "4bb"→2891、尾 "b7f"→4023、尾 "6ca"→2668，
         而 common.js 里另一条 real_full_path_from_hash（尾两位/尾一位的十六进制反序）
         在实测中恒 404 —— 别用那条。
       · gg.b 是 gg.js 里的一个滚动版本前缀（实测 '1789858801/'），**必须每次取最新的**：
         拿旧前缀去请求同一个 hash 会 404（实测 1789855201/ 与 1789858801/ 互换即 404）。
       · 子域只有 a1 / a2 两个（DNS：a1→216.230.225.130、a2→66.187.78.242，
         ltn 同时解析到这两个）。同一个 hash **只挂在其中一个**上：
         实测 a1 上 404 的 hash 在 a2 上 200（二者恰好相反）。gg.m() 在当前版本的
         gg.js 里已被改成恒返回 0（switch 只剩 `o = 0; break;`），浏览器自己也不再用它，
         所以这里不猜规则 —— 先探通一个子域，然后整本沿用。
       · 实测那个 gg.m 恒 0 的开关正是靠不住的地方，所以不缓存跨进程。
   · 缩略图/封面另有 tn.hitomi.la，但实测该域名在**本机出口 DNS 不可达**
     （a1./a2./ltn./btn./atn. .gold-usergeneratedcontent.net 可达）—— 所以不放封面，
     只做阅读器。
   · 免费公开的检索入口（/search.html?query=… 、/index-chinese.html、/alltags.html）
     返回的都是 3–5KB 的空 JS 壳，真正的检索要走 nozomi 二进制索引（浏览器里
     用 Range 请求 + 二分），网关没有执行 JS 的能力 —— 故 hitomi 的**检索**暂不做，
     这里只实现在线阅读。
   ========================================================================== */
const HM_CDN_BASE = 'https://ltn.gold-usergeneratedcontent.net';
const HM_D2 = 'gold-usergeneratedcontent.net';
const HM_GG_TTL = 10 * 60e3;      /* gg.js 的滚动前缀 10 分钟内复用 */
const HM_PAGE_CONC = 4;           /* 取图元信息时的并发（hitomi 没有 E-Hentai 那种严格节流）*/
const hmState = { b: '', at: 0, atHost: '', atHostAt: 0 };

/** gg.s(hash)：common.js 里的官方算法，返回十进制目录名 */
function hmDir(hash) {
  const m = /(..)(.)$/.exec(String(hash || ''));
  if (!m) return '';
  const n = parseInt(m[2] + m[1], 16);
  return isFinite(n) ? String(n) : '';
}

/** 取 gg.js 的滚动前缀 gg.b（必须是最新的，旧前缀一律 404） */
async function hmPathPrefix() {
  if (hmState.b && Date.now() - hmState.at < HM_GG_TTL) return hmState.b;
  let r;
  try {
    r = await outFetch(HM_CDN_BASE + '/gg.js?_=' + Date.now(), {
      timeout: 10000, headers: { referer: READER_HOSTS.hitomi, accept: '*/*' }
    });
  } catch (e) { throw new Error('连不上 Hitomi 的图床清单 gg.js：' + ((e && e.message) || e)); }
  if (!r.ok) throw new Error('Hitomi 的 gg.js 返回 HTTP ' + r.status);
  const b = (r.text().match(/b:\s*'([^']+)'/) || [])[1] || '';
  if (!b) throw new Error('Hitomi 的 gg.js 里没有解析到路径前缀（站点可能改版了）');
  hmState.b = b; hmState.at = Date.now();
  return b;
}

/** 拿一个 hash 的图：先试上次成功过的子域，再试另一个（子域只有 a1/a2） */
async function hmImageProbe(hash, prefix) {
  const dir = hmDir(hash);
  if (!dir) throw new Error('Hitomi 的图片 hash 不合法：' + hash);
  const order = (hmState.atHost && Date.now() - hmState.atHostAt < 30 * 60e3)
    ? [hmState.atHost].concat(['a1', 'a2'].filter(x => x !== hmState.atHost))
    : ['a1', 'a2'];
  let last = '';
  for (const sub of order) {
    const url = 'https://' + sub + '.' + HM_D2 + '/' + prefix + dir + '/' + hash + '.avif';
    let r;
    try {
      r = await outFetch(url, { timeout: 15000, headers: { referer: READER_HOSTS.hitomi, accept: '*/*' } });
    } catch (e) { last = '连不上 ' + sub + '：' + ((e && e.message) || e); continue; }
    if (r.status === 200 && r.buf.length > 200) {
      hmState.atHost = sub; hmState.atHostAt = Date.now();
      return { url: url, bytes: r.buf.length, type: r.headers.get('content-type') || '' };
    }
    last = sub + ' HTTP ' + r.status;
  }
  throw new Error('Hitomi 的图片拿不到（' + last + '）—— 这个子域可能不对，或站点换了图床');
}

/** hitomi 的图集标题/封面：CDN 上的 galleryblock/<id>.html 是服务端渲染的片段 */
async function hmBlock(id) {
  try {
    const r = await outFetch(HM_CDN_BASE + '/galleryblock/' + encodeURIComponent(id) + '.html', {
      timeout: 12000, headers: { referer: READER_HOSTS.hitomi, accept: 'text/html,*/*' }
    });
    if (!r.ok) return '';
    return r.text();
  } catch (e) { return ''; }
}

async function readerHitomi(id) {
  const referer = READER_HOSTS.hitomi;
  const gid = String(id || '').trim().match(/(\d+)/);
  if (!gid) throw new Error('Hitomi 的 id 需要是数字图集号（形如 4458），收到的是「' + String(id || '') + '」');
  const num = gid[1];

  const prefix = await hmPathPrefix();

  /* 图集数据在 CDN 的 galleries/<id>.js（hitomi.la 自己的 HTML 是空的 JS 壳） */
  let r;
  try {
    r = await outFetch(HM_CDN_BASE + '/galleries/' + num + '.js?_=' + Date.now(), {
      timeout: 15000, headers: { referer: referer, accept: '*/*' }
    });
  } catch (e) { throw new Error('连不上 Hitomi 的图集数据：' + ((e && e.message) || e)); }
  if (!r.ok) {
    throw new Error('Hitomi 说没有这个图集（galleries/' + num + '.js 返回 HTTP ' + r.status + '）—— id 可能填错了');
  }
  const text = r.text();
  let info = null;
  try {
    info = JSON.parse(text.replace(/^\s*var\s+galleryinfo\s*=\s*/, '').replace(/;\s*$/, ''));
  } catch (e) {
    throw new Error('Hitomi 的图集数据不是 JSON（站点可能改版了）');
  }
  const files = asArray(info && info.files).filter(f => f && f.hash);
  if (!files.length) {
    throw new Error('Hitomi 这个图集没有可读的页（可能是视频作品 / anime 类型，网关只托管图片）');
  }

  /* 先探通一页（确定 a1/a2 里哪个挂着这本），再并发取其余页的元信息 */
  const first = await hmImageProbe(files[0].hash, prefix);
  const pages = [readerPage(first.url, referer, files[0].width || 0, files[0].height || 0)];
  const rest = files.slice(1);
  for (let i = 0; i < rest.length; i += HM_PAGE_CONC) {
    const batch = rest.slice(i, i + HM_PAGE_CONC);
    /* eslint-disable no-await-in-loop */
    const got = await Promise.all(batch.map(async f => {
      try {
        const g = await hmImageProbe(f.hash, prefix);
        return { p: readerPage(g.url, referer, f.width || 0, f.height || 0), ok: true };
      } catch (e) { return { p: null, ok: false, name: f.name, err: (e && e.message) || String(e) }; }
    }));
    got.forEach(g => { if (g.p) pages.push(g.p); });
  }
  if (!pages.length) throw new Error('Hitomi 一张图都没取到');

  /* 标题优先用 galleryblock 片段里的 <h1>（服务端渲染）；拿不到就退回 galleryinfo.title */
  let title = String((info && info.title) || '').replace(/\s+/g, ' ').trim();
  const block = await hmBlock(num);
  if (block) {
    const h1 = ehPlain((block.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
    if (h1) title = h1;
  }
  if (!title) title = 'Hitomi #' + num;
  /* hitomi 的标题带上作者/语言后缀，原站是「标题 | Hitomi.la」的写法，这里只留标题 */
  title = title.replace(/\s*\|\s*Hitomi\.la\s*$/i, '').trim();

  const out = {
    title: title,
    referer: referer,
    chapters: [],                       /* 单章作品：chapters 交空数组 */
    pages: pages
  };
  const missing = files.length - pages.length;
  out.note = 'Hitomi（hitomi.la 的 HTML 是 JS 壳，图集数据取自 CDN 的 galleries/' + num +
    '.js，图片走 gold-usergeneratedcontent.net 的 a1/a2 图床，本机实测当前可用子域：' +
    (hmState.atHost || '-') + '）。';
  if (missing > 0) out.note += '其中 ' + missing + ' 页没取到，已按原顺序跳过。';
  return out;
}

/* ==========================================================================
   E-Hentai 检索（/api/ehentai/search）—— 网关代搜
   --------------------------------------------------------------------------
   **本机实测取证（出口 = 网关自动探测到的本地代理 127.0.0.1:7897，
     该代理的出口 IP 实测为 54.255.249.22 / AWS ap-southeast-1）：

   ① 搜索侧全部返回「No hits found」，而且**与查询词无关**：
        GET /?f_search=chinese                  → 200, 5443B, /g/ 链接 0 个, No hits found
        GET /?f_search=chinese&f_apply=Apply+Filter → 200, 5443B, 0 个
        GET /?f_search=chinese&f_cats=1019&advsearch=1&f_apply=Apply+Filter → 200, 6680B, 0 个
        GET /?f_search=a（单个字母）             → 200, 5392B, 0 个
        GET /?f_search="big breasts"$            → 200, 5415B, 0 个
        GET /?f_search=language:chinese$         → 200, 5453B, 0 个
        GET /tag/chinese 、/tag/big+breasts       → 200, 5444B, 0 个（也是 No hits）
      页面本身是**结构完整的正常搜索页**（搜索框里回显了关键词、有完整导航/分类条），
      说明请求格式没问题、服务端也认了查询，只是结果集为空。
   ② 非搜索入口同一个出口**完全正常**：
        GET /                                     → 200, 62590B, /g/ 链接 25 个
        GET /popular                              → 200, 156730B, 64 个
        GET /toplist.php                          → 200, 50299B, 40 个
        GET /torrents.php?search=chinese          → 200, 63780B, 97 个（真的按词过滤：
                                                     zzzznotexist → 4967B / 0 个）
        GET /g/4200093/58001d7146/                → 200, 18619B，读得到标题与页数
        POST /api.php gdata [[4200093,"58001d7146"]] → 200，正常返回 gmetadata
   ③ 把「可能是我们这边的问题」逐个排掉，全部否定：
        · UA：Chrome 桌面 UA / Pixel 安卓 UA / iPhone UA / 完全不发 UA → 结果一模一样
        · 请求头：全套浏览器头（Accept-Language、sec-ch-ua、sec-fetch-*、Referer）→ 一样
        · 会话 cookie：先 GET / 拿 set-cookie（实测**一个都不发**）再带 cookie 搜 → 一样
        · 方法：GET 与 POST 表单 → 一样
        · 时效：首次搜索请求耗时 3.2s（服务端真的查了库），之后 260ms（命中上游缓存）→ 一样空
        · **换真正的浏览器**：用本机 Chrome（同一个出口 IP）打开
          https://e-hentai.org/?f_search=chinese&f_apply=Apply+Filter → 页面同样显示
          「No hits found」；/tag/big+breasts 同样空。**这跟 Node/undici 无关**。
        · 封禁字样：整页里没有 temporarily banned / Your IP address has been banned；
          /home.php（1307B）也不带封禁提示 —— 所以不是「被封」，
          更像是这个机房出口 IP 被搜索侧单独限制了。
   ④ 结论（这就是根因）：**在当前出口 IP 下，E-Hentai 的搜索/标签结果接口一律返回空集**，
      请求参数与请求头怎么写都救不回来；用户自己的 cookie 也**不可能**解决它
      （cookie 与出口 IP 是两回事，实测不带 cookie 的浏览器同样 0 条）。
      —— 所以这里**不伪造结果**，而是：
        a) 先照常打搜索；真有结果就直接返回（换一个出口 IP 就立刻恢复，代码不用改）；
        b) 搜索为 0 条时，**如实**在 note/error 里写清原因与可执行动作；
        c) 给一条**真实可用**的兜底：/torrents.php?search=<词>（同一个出口实测能按词过滤，
           每行都给得出 /g/<gid>/<token>/ 与人类可读的种子名），
           标注 via:'torrents' + 中文 note，绝不冒充成搜索结果。
        d) 另有一条也实测可用的非搜索入口 /popular（首页/流行本来就有 25/64 条），
           只有关键词为空时才用它。
   · 可选 cookie：`--ehentai-cookie "ipb_member_id=…; ipb_pass_hash=…; sk=…"` 或环境变量
     HS_EH_COOKIE。带 cookie 会一起送给搜索请求（有些人靠登录态能改善搜索），
     但不带也照常工作；**没有任何情况下会假装 cookie 解决了搜索为空的问题**。
   ========================================================================== */
/* ★E-Hentai 搜索的预算与缓存（本轮为「稳定性 / 速度」重做）★
   ---------------------------------------------------------------------------
   旧实现：搜索 25s → 中继换出口重试 30s（两个中继串行，最坏 60s）→ /torrents.php 25s
   全部 await 串起来，**没有任何总预算**。最坏 ≈ 80~110s，而前端聚合器 22s 就把这个源
   判成「超过 22 秒未返回」—— 于是「E-Hentai 老是要等、老是超时」。
   现在：EH_BUDGET_MS 是**整个函数**的硬预算，每一段开跑前先看还剩多少；
   不够就直接跳过那一段（宁可少试一条路，也不许超出预算把整次检索拖死）。
   缓存也从「单槽位 60 秒」改成「小 Map + 5 分钟」：随机关键词连搜时命中率高得多，
   命中即 0ms 返回，这才是把「五十次随机检索」稳在 15 秒以内的关键。 */
const EH_BUDGET_MS = 6000;         // 整个 ehentaiSearch 的硬上限（第 8 轮 13000 → 6000）
/* 第 8 轮：前端给 ehentai 的预算是 6s、聚合器硬闸 9.5s，网关这边也必须一起收窄。
   本机出口下 E-Hentai 100% 失败（系统 DNS 沉洞 + SNI RST），失败形态是
   「DoH 腿吃 5.4s、中继腿再吃 2.5s」，旧值 13000 让它把整轮拖到 14.2s 才报错；
   收到 6s 后它要么真回结果、要么快速如实失败（错误原文照旧写进 error/note）。
   EH_STEP_* 之和可以大于总预算 —— 每段开跑前都会先看 left()，不够就跳过。 */
const EH_STEP_SEARCH = 4000;       // 第 1 段：正常搜索
const EH_STEP_RELAY = 2500;        // 第 2 段：经中继换出口重试
const EH_STEP_TORRENT = 2500;      // 第 3 段：/torrents.php 兜底
const EH_STEP_POPULAR = 4000;      // 无关键词时取 /popular
const EH_SEARCH_CACHE_MS = 5 * 60e3;
const EH_SEARCH_CACHE_MAX = 60;
const ehSearchCache = new Map();   // key -> { at, val }（插入序即最旧序）

function ehSearchCacheGet(key) {
  const hit = ehSearchCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > EH_SEARCH_CACHE_MS) { ehSearchCache.delete(key); return null; }
  return hit.val;
}
function ehSearchCacheSet(key, val) {
  ehSearchCache.delete(key);                 // 重新插入 → 变成最新
  ehSearchCache.set(key, { at: Date.now(), val: val });
  while (ehSearchCache.size > EH_SEARCH_CACHE_MAX) {
    const oldest = ehSearchCache.keys().next().value;
    if (oldest === undefined) break;
    ehSearchCache.delete(oldest);
  }
}

/* 第 10 轮：把「三层都连不上」和「搜索真的 0 条」分开记。
   实测（本机，2026-09）：搜索页三条腿**全断**时旧实现仍回 ok:true + searchZero:true，
   前端于是显示成「E-Hentai 搜索本身是空的」（把故障讲成了事实），而且每搜一次白烧 5～8 秒
   —— 实测 8221ms，已经突破 EH_BUDGET_MS(6000)，因为每段超时还带 Math.max(2000,…) 下限。
   现在：一旦确认网络层不通，就按 30 秒短冷却如实报错；冷却期内任何词都毫秒级返回同一结论。 */
const EH_NET_COOLDOWN_MS = 180e3;    /* 第 10 轮：确认真·网络层不可达时，冷却 30s → 3 分钟。
                                        理由：e-hentai 在本机出口是死路（原路 fetch failed /
                                        DoH 无验真 IP / 中继 500），30s 冷却等于每搜两三次就白吃
                                        一次 6.6s 硬闸；放宽后同样是「如实报错」，但不再拖慢检索。 */
let ehNetDownUntil = 0;
let ehNetDownWhy = '';
let ehNetDownEgress = '';            /* 失败时的出口：出口一变（用户开了代理）立刻重试，不等冷却 */

/* ★有自建中继时不要再冻 3 分钟（2026-09-23 第四次压测发现）★
   r12d 里 e-hentai 91.7%（私有腿打通后它每次都能通），r12e 里却掉到 16.7%：
   仅仅因为**某一轮**的一次网络层失败就把 ehNetDownUntil 推到 3 分钟后，
   后面 10 轮全是 14ms 的「冷却中」空结果 —— p50 14ms 就是它。
   私有中继通常下一秒就能通（实测 400ms–1.5s 出结果），所以配了私有中继时
   冷却收到 25 秒：既不自残式地每轮硬撞，也不会让一次抖动毁掉整轮压测。
   （没有私有中继时本机出口确实是死路，维持 180 秒。）*/
const EH_NET_COOLDOWN_RELAY_MS = 25e3;
function ehNetCooldownMs() {
  return PRIVATE_RELAY.length ? EH_NET_COOLDOWN_RELAY_MS : EH_NET_COOLDOWN_MS;
}

/* ★封禁倒计时★（r17，2026-09-23 真机取证）：
   上游的限流封禁页写得很清楚 ——「The ban expires in 5 minutes and 12 seconds」（HTTP 200、242 字节）。
   旧逻辑只按 ehNetCooldownMs() 冷却：配了自建中继时那是 **25 秒**，而封禁是 **5 分钟级**
   ⇒ 每 25 秒再撞一次**同一个已被封的出口**，封禁被反复刷新（上游的倒计时从头开始），
   真机表现就是用户报的「ehentai 总是不返回结果」：永远是失败/0 条，永远等不到解封。
   现在：把倒计时解析出来，冷却至少等它（+3s 余量），并把这个时间写进给用户看的文案。 */
let ehBanUntil = 0;                  /* 上游亲口说的解封时刻（0 = 当前没有封禁记录） */
/* ★r18 需求⑤★：上面这个封禁是在**哪条出口**上记下的。换出口（--proxy / 中继换了）就不再拿
   旧出口的封禁去挡新出口 —— 否则用户一开代理反而被自己上一次的封禁记忆挡住。 */
let ehBanEgress = '';
/** 从封禁页正文里抠出剩余毫秒；不是封禁页（或没写倒计时）返回 0 */
function ehBanLeftMs(body) {
  const m = String(body || '').match(/ban expires in\s*([^.<]{1,80})/i);
  if (!m) return 0;
  const s = m[1];
  const h = /(\d+)\s*hour/i.exec(s), mi = /(\d+)\s*minute/i.exec(s), se = /(\d+)\s*second/i.exec(s);
  const ms = (h ? +h[1] * 3600e3 : 0) + (mi ? +mi[1] * 60e3 : 0) + (se ? +se[1] * 1000 : 0);
  return ms > 0 ? ms : 0;
}
/** 这次失败该冷却多久：网络层冷却 与「上游说的解封时间」取大者（封顶 30 分钟，免得被一句怪话锁死） */
function ehDownMs() {
  const base = ehNetCooldownMs();
  const banLeft = ehBanUntil - Date.now();
  if (banLeft <= 0) return base;
  return Math.max(base, Math.min(30 * 60e3, banLeft));
}
/** 冷却文案里的秒数必须用**真实**的 ehNetDownUntil —— 否则会出现「封 5 分钟却写 25 秒内不再重试」 */
function ehDownSecs() {
  return Math.max(1, Math.ceil((ehNetDownUntil - Date.now()) / 1000));
}

/* ★r18 需求⑤（熔断策略）★：把熔断状态**结构化**返回，前端不必再正则匹配中文文案。
   动机：网关与浏览器共用同一个出口。网关已经判出「上游按出口 IP 限流」时，
   前端那条「浏览器直连兜底」面对的是同一面墙 + 同一个出口，实测还要白烧 4–5 秒才失败
   （EH_BUDGET 6000ms 被它吃掉 4500ms）—— 用户体感就是「每次搜索都要等好几秒」。
   有了 cooldown 字段，前端这一轮立刻跳过 E-Hentai，先把别的源的结果给出来。
   layer='ban' 表示上游亲口说的封禁（有解封倒计时）；layer='net' 表示三条腿都没通。 */
function ehCooldownInfo() {
  const banLeft = Math.max(0, ehBanUntil - Date.now());
  const netLeft = Math.max(0, ehNetDownUntil - Date.now());
  const left = Math.max(banLeft, netLeft);
  return {
    secs: Math.ceil(left / 1000), until: Date.now() + left,
    banned: banLeft > 0, layer: banLeft > 0 ? 'ban' : 'net', egress: egress.live || ''
  };
}

/* ★r18 需求⑤（「从弹出网页开始」这条路上的封禁记忆共享）★
   用户原话：「ehentai 在不影响检索稳定性、从弹出网页开始的条件下，优化熔断策略，
   不要我每次搜索都要等多少多少秒」。
   真机链路：点开一个 E-Hentai 作品（弹窗/阅读器）→ readerEhentai → ehHtml 抓到上游封禁页
   → 只写了 ehBanUntil；而搜索路径的短路闸门（见 ehentaiSearchInner 开头）原先只认
   ehNetDownUntil ⇒ 封禁明明已经知道了，接下来**每一次搜索**还是照样把三条腿重烧一遍，
   烧满 EH_BUDGET_MS 才失败 —— 用户体感正是「每次搜索都要等」。
   这里把「上游亲口说的封禁」也当成短路理由，并且和记下它时的出口绑定（ehBanEgress）：
   出口一变就不再拿旧出口的封禁挡新出口。返回 null = 没有可用的封禁记忆。 */
function ehBanGate() {
  const banLeft = Math.max(0, ehBanUntil - Date.now());
  if (banLeft <= 0) return null;
  if (ehBanEgress !== (egress.live || '')) return null;
  return {
    secs: Math.ceil(banLeft / 1000), until: ehBanUntil,
    banned: true, layer: 'ban', egress: ehBanEgress
  };
}

/** 把 E-Hentai 列表页切成「一行一段」。
    坑（本机实测）：列表行并不是 `<tr><td class="itd">…` —— 实测 /popular 187706B 里
    78 个 /g/ 链接散在 78 个 `<tr>` 里，而 `<tr>` 紧跟着 `class="…itd…"` 的行**只有 2 个**；
    行首还常带属性或空白。所以判断一行**认它里面的 /g/ 链接**，而不是认 td 的 class。 */
function ehTableRows(html) {
  return String(html || '').split(/<tr\b[^>]*>/i).slice(1);
}
function ehHref(seg) {
  return (String(seg).match(/href="(https?:\/\/e-hentai\.org\/g\/(\d+)\/([0-9a-f]{6,})\/?)"/i) || null);
}
function ehRowTitle(seg) {
  return ehPlain((seg.match(/<a[^>]*class="glink"[^>]*>([\s\S]*?)<\/a>/i) || [])[1] ||
    (seg.match(/<div class="glink"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] ||
    (seg.match(/<a[^>]*class="[^"]*\blillie\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || '');
}

/** 标准搜索结果表（table.itg）的一行 → 卡片。字段口径与前端 sources.js 的 ehentaiSearch 对齐 */
function ehSearchRows(html, limit) {
  const out = [];
  for (const seg of ehTableRows(html)) {
    const gl = ehHref(seg);
    if (!gl) continue;
    const title = ehRowTitle(seg);
    const imgTag = (seg.match(/<img\b[^>]*>/) || [])[0] || '';
    const cover = ehPlain((imgTag.match(/\bdata-src="([^"]+)"/i) || imgTag.match(/\bsrc="([^"]+)"/i) || [])[1] || '');
    const cat = ehPlain((seg.match(/<div class="cn"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '').toLowerCase();
    const tags = [];
    const tagRe = /<div class="gt[lw]?"[^>]*>([\s\S]*?)<\/div>/gi;
    let tm;
    while ((tm = tagRe.exec(seg))) { const v = ehPlain(tm[1]); if (v) tags.push(v); }
    const pages = (seg.match(/(\d+)\s*pages?/i) || [])[1];
    const rating = (seg.match(/(\d+(?:\.\d+)?)\s*\/\s*5/) || [])[1];
    out.push({
      id: gl[2] + '-' + gl[3],
      title: title,
      url: 'https://e-hentai.org/g/' + gl[2] + '/' + gl[3] + '/',
      cover: cover,
      artist: '',
      tags: tags.concat(cat ? [cat] : []).concat(rating ? ['★' + rating] : []),
      cats: EH_CAT_MAP[cat] ? [EH_CAT_MAP[cat]] : [],
      pages: pages ? parseInt(pages, 10) : null,
      note: 'E-Hentai 搜索 · 经网关'
    });
    if (out.length >= (limit || 60)) break;
  }
  return out;
}
const EH_CAT_MAP = {
  doujinshi: 'doujinshi', manga: 'comic', 'artist cg': 'cg', 'game cg': 'cg',
  western: 'western', 'non-h': 'doujinshi', 'image set': 'artbook',
  cosplay: 'cosplay', 'asian porn': 'hanman'
};

/** 兜底：/torrents.php?search=<词> 的证据式解析（实测真的按词过滤，每行带 /g/<gid>/<token>/）
    行的切分同样用 ehTableRows（认 /g/ 链接，不认 td 的 class）。 */
function ehTorrentRows(html, limit) {
  const out = [];
  const seen = Object.create(null);
  for (const seg of ehTableRows(html)) {
    const gl = ehHref(seg);
    if (!gl) continue;
    if (seen[gl[2]]) continue;
    seen[gl[2]] = 1;
    const title = ehPlain((seg.match(/<div style="height:15px[^>]*><a[^>]*>([\s\S]*?)<\/a>/i) || [])[1] ||
      (seg.match(/<a[^>]*rel="nofollow"[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || '');
    const uploader = ehPlain((seg.match(/torrents\.php\?u=\d+[^"]*"[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || '');
    out.push({
      id: gl[2] + '-' + gl[3],
      title: title || ('E-Hentai #' + gl[2]),
      url: 'https://e-hentai.org/g/' + gl[2] + '/' + gl[3] + '/',
      cover: '',
      artist: uploader,
      tags: uploader ? ['上传者:' + uploader] : [],
      cats: [],
      pages: null,
      note: 'E-Hentai 种子检索兜底（/torrents.php?search=）'
    });
    if (out.length >= (limit || 60)) break;
  }
  return out;
}

/** 把一个「搜索为 0 条」的事实讲成用户能照做的中文。
    2026-09 复核：这里的「搜索侧按出口 IP 限制」是**真的**（机房 IP 常常拿不到搜索页），
    但网关另外还会遇到「上游回 200 + 0 字节空壳」的**限流软封锁** —— 两者表现都是「没结果」，
    处置却不同（前者换出口节点，后者等一两分钟）。所以两种情况都在文里点明。 */
function ehZeroReason(withCookie) {
  return 'E-Hentai 这次没给出搜索结果。两种已知原因：' +
    '① **出口 IP 被搜索侧限制**（机房/数据中心 IP 常见，页面正常、搜索恒空）；' +
    '② **限流软封锁**（上游回「HTTP 200 + 0 字节」的空壳，连续请求就会触发，和请求头、cookie 无关）。' +
    (withCookie ? '本次已带上你配置的 cookie，仍然 0 条；' : '带上登录 cookie 也一样（cookie 与出口 IP 是两回事）；') +
    '网关已自动改经境内中继用**另一个出口 IP** 重试过；要稳定搜索，建议把系统代理切到住宅出口节点。';
}

/** 第 10 轮新增的**函数级硬闸**（外面这层只管掐表，逻辑全在 ehentaiSearchInner）。
   为什么必须有它：EH_BUDGET_MS / EH_STEP_* 只管得住「我们自己给每条腿的超时」，
   而 outFetch 内部还会串行跑 直连 → DoH 钉 IP（多解析器 × 多候选 IP 逐个验真）→ 中继
   （allorigins 与 allorigins-get 各一次），每一段都有自己的超时。实测因此出现过
   **15875ms**（预算 6000ms）—— 整轮检索的墙钟就是被它拖到 10s 以上的。
   现在到点就如实返回「网络层失败」，并记下 30 秒短冷却，后面每一次都是毫秒级。 */
async function ehentaiSearch(query) {
  let timer = null;
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('超过 ' + EH_BUDGET_MS + 'ms 硬闸（三条腿的超时之和超过预算）')),
      EH_BUDGET_MS + 600);
  });
  try {
    return await Promise.race([ehentaiSearchInner(query), guard]);
  } catch (e) {
    const why = (e && e.message) || String(e);
    ehNetDownUntil = Date.now() + ehDownMs();
    ehNetDownWhy = why;
    ehNetDownEgress = egress.live || '';
    /* ★去重★：ehHtml 抛出来的话**已经自带**「连不上 E-Hentai 搜索：…」这种前缀，
       再拼一次就变成「连不上 E-Hentai：连不上 E-Hentai 搜索：…」——
       真机实测（封禁期间）就是这句话，读起来像复读机。
       判据用「有没有说过连不上」而不是判全文，免得把「连不上」当中文词搜错地方。 */
    const whyMsg = /连不上/.test(why) ? why : ('连不上 E-Hentai：' + why);
    return {
      ok: false, source: 'ehentai', via: 'none', page: 1, total: 0, items: [], cached: false,
      /* ★r18★ 文案不再写「N 秒内不再重试」（读起来像让用户干等多少秒），改成「本轮跳过 + 会自动重试」；
         剩余秒数放进 cooldown.secs，需要展示时由前端自己决定怎么讲。 */
      error: whyMsg + '（这是**网络层**失败，不是「0 条结果」；E-Hentai 本轮先跳过，网关会自动重试）。' +
        EH_DEAD_FIX,
      cooldown: ehCooldownInfo()
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function ehentaiSearchInner(query) {
  const t0 = Date.now();
  const left = () => EH_BUDGET_MS - (Date.now() - t0);
  const q = String(query.q || '').trim();
  const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
  const limit = Math.min(80, Math.max(1, parseInt(query.limit || '60', 10) || 60));
  const cookie = String(query.cookie || state.ehCookie || '').trim();
  const withCookie = !!cookie;

  const terms = String(query.terms || '').trim() || q;
  const cKey = terms + '|' + page + '|' + limit + '|' + (withCookie ? 'ck' : '');
  const hit = ehSearchCacheGet(cKey);
  if (hit) return Object.assign({}, hit, { cached: true });

  /* 第 10 轮：刚确认过「三条腿都不通」的 30 秒内，不再白烧预算 —— 直接如实报错。
     没有这一步时，用户连搜十几个词就会连续吃 5～8 秒/次的纯失败。 */
  /* ★r18 需求⑤★：这里原先只认 ehNetDownUntil（搜索路径自己烧出来的网络层失败），
     不认「阅读器/弹窗那条路（ehHtml）学到的上游封禁」（ehBanUntil）—— 于是「先点开一个
     E-Hentai 作品、再搜索」时每一次搜索都要把三条腿重烧一遍。现在两种记忆都算短路理由，
     且都与记下它时的出口绑定（见 ehBanGate）。 */
  const netGate = ehNetDownUntil > Date.now() && ehNetDownEgress === (egress.live || '');
  const banGate = ehBanGate();
  if (netGate || banGate) {
    return {
      ok: false, source: 'ehentai', via: 'none', page: page, total: 0, items: [],
      cached: false, ms: Date.now() - t0,
      /* 文案里**不出现**倒计时（用户明确要求别再让「还要等多久」出现在每次搜索里）；
         结构化剩余时间仍在 cooldown.secs 里，前端要展示时自己决定怎么讲。 */
      error: netGate
        ? ('E-Hentai 本轮跳过（网关仍记着上次的网络层失败，会自动重试）：' + ehNetDownWhy)
        : ('E-Hentai 本轮跳过（这个出口正被上游限流封禁，网关会自动重试，' +
           '不再每次搜索都重烧一遍）：' + EH_DEAD_FIX),
      cooldown: ehCooldownInfo()
    };
  }

  /* 1) 关键词为空：直接给「非搜索入口」的真实结果（/popular 实测 64 条） */
  if (!terms) {
    const html = await ehHtml(EH_HOST + '/popular', 'E-Hentai 流行榜',
      Math.max(2500, Math.min(EH_STEP_POPULAR, left())));
    const items = ehSearchRows(html, limit);
    const out = {
      ok: true, source: 'ehentai', via: 'popular', page: 1, total: items.length, items: items,
      note: '没有给关键词，返回的是 E-Hentai 的 /popular（流行榜）。'
    };
    ehSearchCacheSet(cKey, out);
    return out;
  }

  /* 2) 正常搜索 */
  const params = ['f_search=' + encodeURIComponent(terms)];
  const cats = String(query.cats || '').trim().replace(/[^0-9]/g, '');
  if (cats) params.push('f_cats=' + cats);
  params.push('advsearch=1', 'f_apply=Apply+Filter');
  if (page > 1) params.push('page=' + (page - 1));
  const searchUrl = EH_HOST + '/?' + params.join('&');

  /* 每一段都按「预算里还剩多少」给超时：宁可这一条腿短一点，也不许整段超预算。
     全部失败也**不再抛**：搜索侧取不到就当成 0 条返回（ok:true, items:[]）——
     前端只会显示「这个源 0 条」，而不是一条红色失败把整次检索标脏。 */
  let searchErr = '';
  let html = '';
  let via = '';
  try {
    html = await ehHtml(searchUrl, 'E-Hentai 搜索',
      /* 第 10 轮：下限从 2500 收到 800，并再夹一次 left() —— 旧写法
         Math.max(2500, Math.min(EH_STEP_SEARCH, left())) 会在「只剩 300ms」时照样跑 2500ms，
         这正是 ehentai 实测 8221ms 突破 6000ms 预算、并把整轮拖到 10s 以上的原因。 */
      Math.max(800, Math.min(EH_STEP_SEARCH, left() - 300)), cookie);
    via = ehHtml.lastVia || '';
  } catch (e) {
    searchErr = (e && e.message) || String(e);
  }
  /* 第 10 轮：只有「真的取回过页面」才算搜过；一次页面都没拿到 = 网络层失败（见函数尾部） */
  let gotPage = !!html;
  const zero = /No hits found/i.test(html);
  const items = (html && !zero) ? ehSearchRows(html, limit) : [];
  if (items.length) {
    const out = {
      ok: true, source: 'ehentai', via: 'search', page: page, total: items.length, items: items,
      note: 'E-Hentai 搜索（经网关，带完整请求头' + (withCookie ? ' + 你的 cookie' : '') +
        '；这一页由 ' + (via === 'relay' ? '境内中继（另一个出口 IP）' : '直连') + ' 取回）'
    };
    ehSearchCacheSet(cKey, out);
    return out;
  }

  /* 2b) 空集 → **换一个出口 IP 再搜一次**（走中继，出口在墙外）
     这一条是实测出来的、也是本功能最有效的一步：同一个词，本机出口（机房 IP）返回
     No hits found，经中继却拿到 25 条真结果 —— E-Hentai 的搜索侧限制是**按出口 IP 认的**，
     换个出口等于换一张脸。中继不转 cookie（也不该转），所以这条结果是匿名可见的那份。
     ⚠ 预算不够就跳过：这一段在旧实现里是 30s（两个中继串行最坏 60s），是超时的主因。 */
  if (!withCookie && left() > 1800) {
    try {
      const relayHtml = await ehHtml(searchUrl, 'E-Hentai 搜索（中继出口）',
        Math.max(800, Math.min(EH_STEP_RELAY, left() - 400)), '', { relayOnly: true });
      const rows = ehSearchRows(relayHtml, limit);
      if (relayHtml) gotPage = true;   /* 第 10 轮：中继把页面取回来了 → 站点其实是通的 */
      if (rows.length) {
        const out = {
          ok: true, source: 'ehentai', via: 'relay', page: page, total: rows.length, items: rows,
          note: 'E-Hentai 搜索：当前出口 IP 下上游返回空集（E-Hentai 按出口 IP 限制搜索），' +
            '已自动改经境内中继换一个出口 IP 重试，拿到 ' + rows.length + ' 条。'
        };
        ehSearchCacheSet(cKey, out);
        return out;
      }
    } catch (e) { /* 中继也不行 → 继续走下面的种子兜底 */ }
  }

  /* 3) 搜索为 0 条 → 真实可用的兜底：/torrents.php?search=<词>（实测按词过滤） */
  let torrents = [];
  if (left() > 1200) {
    try {
      const th = await ehHtml(EH_HOST + '/torrents.php?search=' + encodeURIComponent(terms),
        'E-Hentai 种子检索', Math.max(700, Math.min(EH_STEP_TORRENT, left() - 300)));
      if (th) gotPage = true;          /* 第 10 轮：同一条腿取到页面 → 不是网络层全断 */
      torrents = ehTorrentRows(th, limit);
    } catch (e) { /* 兜底也拿不到就只报原事实 */ }
  }

  /* 第 10 轮：**一次页面都没拿到** = 网络层失败，不是「搜索 0 条」。
     旧实现把它包成 ok:true + searchZero:true，前端讲成「E-Hentai 搜索本身是空的」——
     用户会以为站点没货，而事实是三条腿（直连 / DoH 钉 IP / 中继）全断。
     这里改成如实报 ok:false + 原始原因，并记下 30 秒短冷却（冷却期内毫秒级返回同一结论）。 */
  if (!gotPage) {
    const why = searchErr || '直连 / DoH 钉 IP / 中继三条腿都没取到页面';
    ehNetDownUntil = Date.now() + ehDownMs();
    ehNetDownWhy = why;
    ehNetDownEgress = egress.live || '';
    /* 去重同 ehentaiSearch：ehHtml 的话已经自带「连不上 E-Hentai 搜索：…」前缀 */
    const whyMsg = /连不上/.test(why) ? why : ('连不上 E-Hentai：' + why);
    return {
      ok: false, source: 'ehentai', via: 'none', page: page, total: 0, items: [],
      cached: false, ms: Date.now() - t0,
      error: whyMsg +
        '（这是**网络层**失败，不是「0 条结果」；E-Hentai 本轮先跳过，网关会自动重试）。' + EH_DEAD_FIX,
      cooldown: ehCooldownInfo()
    };
  }

  const out = {
    ok: true, source: 'ehentai', via: torrents.length ? 'torrents' : 'search',
    page: page, total: torrents.length, items: torrents,
    /* 前端见到 searchZero 会把它当「搜索本身是空的」讲清楚，而不是「没搜到」 */
    searchZero: true,
    ms: Date.now() - t0,
    note: (searchErr ? '搜索侧本次没取到页面（' + searchErr + '）。' : '') + ehZeroReason(withCookie) +
      (torrents.length
        ? '下面这 ' + torrents.length + ' 条来自可用的兜底入口 /torrents.php?search=' + terms +
          '（每条都带 gid+token），**不是** E-Hentai 的搜索结果本身；' +
          '注意种子表里的图集有可能已被删除/下架，那几条点开会提示读不了 —— 这是原站的状态，不是网关的问题。'
        : '兜底入口 /torrents.php?search=' + terms + ' 这次也没返回条目。')
  };
  ehSearchCacheSet(cKey, out);
  return out;
}

/* ==========================================================================
   阶段三新增：Pixiv（www.pixiv.net）—— 单作品多页插画
   --------------------------------------------------------------------------
   （本机实测，出口走网关自动探测到的本地代理）
   · **不需要登录 cookie**（这一点与 R-18 检索不同）：
       GET /ajax/illust/<id>/pages?lang=zh   → HTTP 200
         {"error":false,"body":[{"urls":{thumb_mini,small,regular,original, …}}]}
       实测 id=149872482 → pages=1，urls 里四个尺寸齐全，original 是
       https://i.pximg.net/img-original/img/2026/09/20/07/46/40/149872482_p0.png
   · 元信息：GET /ajax/illust/<id>?lang=zh → HTTP 200（实测 43659B）
       title = body.illustTitle、作者 = body.userName、分级 = body.xRestrict
       （0=全年龄 1=R-18 2=R-18G；pageCount / width / height 也在）
   · **i.pximg.net 有防盗链**：同一张原图
       不带 Referer → HTTP 403（548B text/html）
       带 Referer: https://www.pixiv.net/ → HTTP 200 image/png 2922238B
     所以所有页地址都必须经 /api/proxy 带 Referer 取（跟搜索结果的封面同一套做法）。
   · R-18 作品：**带不带你自己的 cookie 都能读到**（实测同一 URL 有无 cookie 都是 200、
     返回体逐字节相同），所以这里不需要 --pixiv-cookie。真正需要登录的是
     **R-18 检索**，那是 /api/pixiv/search 的 mode=r18 那条线，与本阅读器无关。
   ========================================================================== */
async function readerPixiv(id) {
  const referer = READER_HOSTS.pixiv;
  const pid = String(id || '').trim().match(/(\d{4,})/);
  if (!pid) throw new Error('Pixiv 的 id 需要是数字作品号（形如 149872482），收到的是「' + String(id || '') + '」');
  const num = pid[1];

  const pagesJson = await readerJson('https://www.pixiv.net/ajax/illust/' + num + '/pages?lang=zh',
    referer, 'Pixiv', 15000);
  if (pagesJson && pagesJson.error === true) {
    throw new Error('Pixiv 拒绝了这个作品：' + (pagesJson.message || '可能是 R-18 且当前出口未登录，或作品已删除'));
  }
  const rows = asArray(pagesJson && pagesJson.body).filter(x => x && x.urls);
  if (!rows.length) throw new Error('Pixiv 这个作品没有可读的页（可能是小说 / 动图，或需要登录才能看）');

  /* 元信息拿不到不影响读图，标题退回 id */
  let meta = null;
  try {
    meta = await readerJson('https://www.pixiv.net/ajax/illust/' + num + '?lang=zh', referer, 'Pixiv', 15000);
  } catch (e) { /* 用 id 当标题 */ }
  const b = (meta && meta.body) || {};
  const title = String(b.illustTitle || '').replace(/\s+/g, ' ').trim() || ('Pixiv #' + num);

  const pages = rows.map(row => {
    const u = row.urls || {};
    /* 单图优先 original；多图（p0/p1/…）每页各自有 original，直接逐个映射 */
    const url = String(u.original || u.regular || u.small || u.thumb_mini || '');
    return url ? readerPage(url, referer, 0, 0) : null;
  }).filter(Boolean);
  if (!pages.length) throw new Error('Pixiv 这个作品没有解析出任何图片地址');

  const out = {
    title: title, referer: referer, chapters: [], pages: pages
  };
  const bits = ['Pixiv 官方接口（/ajax/illust/<id>/pages），不需要登录 cookie；' +
    'i.pximg.net 有防盗链，所有页都由网关带 Referer: https://www.pixiv.net/ 代取。'];
  if (Number(b.xRestrict || 0) >= 1) bits.push('这个作品是 R-18。');
  out.note = bits.join('');
  return out;
}

/* ==========================================================================
   阶段三新增：拷贝漫画（copymanga）—— 章节列表 + 每章图片
   --------------------------------------------------------------------------
   （本机实测，出口走网关自动探测到的本地代理；检索那条线一个字没改）
   · id 用 sources.js 给的 path_word（检索结果里**没有 uuid 字段**，
     实测 results.list[0] 的键就是 name/alias/path_word/cover/ban/author/popular）。
   · 作品详情（拿 uuid 与真实的 group）：
       GET /api/v3/comic2/{path_word}?in_mainland=true&request_id=&platform=3   → 200 / 1478B
       results.comic.uuid = 作品 uuid；results.groups = 各分组（键就是 group path_word）
   · 章节列表（**不要带 platform=3**，要 in_mainland + request_id）：
       GET /api/v3/comic/{path_word}/group/{group}/chapters?limit=100&offset=0&in_mainland=true&request_id=
       → 200（实测 421B / 407B），results.list[0] = {uuid, name, size, index, …}
     group 取详情里的 groups 键；详情拿不到就退回 'default'（实测两个作品都通）。
   · 每章图片（是 chapter2，不是 chapter）：
       GET /api/v3/comic/{path_word}/chapter2/{chapter_uuid}?in_mainland=true&request_id=
       → 200（实测 1133B），页地址在 results.chapter.contents[i].url，**已是绝对 https**
         （results.chapter.path 不存在，不需要拼 CDN 前缀）。
     实测 contents 的顺序是打乱的，**要用 results.chapter.words 还原**：
       实测 words=[0,1,3,2] → 原站顺序 = images[words[i]] = contents[i].url。
   · 头：检索那套头打这几条接口会稳定回 code 210（反破解提示「请到官网更新最新APP」），
     补上 authorization/deviceinfo/device/pseudoid/dt 且 region='0' 之后能连续 200；
     但 210 本身也是**间歇性**的（同一秒里 chapter 210、chapter2 200 的情况实测到过），
     所以 code 210 一律按「退避重试」处理，不当致命错误。
   · 图片没有任何防盗链（实测不带 Referer 也是 200 image/jpeg 465466B），
     但 readerPage 照规矩仍带上章节页 Referer。
   ========================================================================== */
async function copyReaderBases() {
  const bases = [];
  const push = b => { b = stripHost(b); if (b && bases.indexOf(b) < 0) bases.push(b); };
  if (state.copyApi) push(state.copyApi);
  push(await copyApiBase());
  ['api.copy2000.online', 'api.mangacopy.com', 'api.copy-manga.com'].forEach(push);
  return bases;
}

async function readerCopymanga(id, chapter) {
  const referer = 'https://www.copy20.com/';
  const pw = String(id || '').trim().replace(/^https?:\/\/[^/]+\/comic\//i, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (!pw) throw new Error('拷贝漫画的 id 需要是 path_word（形如 faterequestchineseversion），收到的是「' + String(id || '') + '」');

  const bases = await copyReaderBases();
  let detail = null, base = '', detailErr = '';
  for (const b of bases) {
    try {
      detail = await copyReaderJson(b, '/api/v3/comic2/' + encodeURIComponent(pw) +
        '?in_mainland=true&request_id=&platform=3', '拷贝漫画作品详情');
      base = b;
      break;
    } catch (e) { detailErr = (e && e.message) || e; }
  }
  if (!base) {
    /* 上游对「已下架/已合并」也用 code 210 回，别把它说成限流 */
    const gone = /已下架|已合并|不存在|not found/i.test(String(detailErr));
    throw new Error(gone
      ? '拷贝漫画说这个作品已下架或已合并到同系列作品集（上游原话：' + detailErr + '）—— ' +
        '请用作品名重新搜一次，用合并后的那条结果的 path_word 再打开'
      : '拷贝漫画取不到作品详情（' + (detailErr || '所有 API 节点都失败') + '）—— ' +
        '多是上游的反破解限流（code 210），等几分钟再试；id 也可能不是 path_word');
  }
  state.copyApi = base; state.copyApiAt = Date.now();
  const det = (detail && detail.results) || {};
  const comic = det.comic || {};
  const title = String(comic.name || pw).replace(/\s+/g, ' ').trim();
  const author = asArray(comic.author).map(a => (typeof a === 'string' ? a : (a && a.name) || '')).filter(Boolean).join(' / ');

  /* 分组：详情的 groups 键优先，退 'default'。
     实测 huweijurudeqingmeizhuma：groups = { default: {path_word:'default', count:72},
     tankobon: {path_word:'tankobon', count:2} } —— 也就是说「分卷」是**另一个 group**，
     旧代码拿到第一个非空分组就 break，单行本那几卷整个丢了。
     路径优先用 v.path_word（v.name 是展示名，拿它当路径实测回 0 章），退 groups 的键。 */
  const groupList = [];
  const g = det.groups;
  if (g && typeof g === 'object') {
    Object.keys(g).forEach(k => {
      const v = g[k];
      const pathWord = (v && typeof v === 'object' && (v.path_word || k)) || k;
      const name = (v && typeof v === 'object' && (v.name || '')) || '';
      if (pathWord && !groupList.some(x => x.pathWord === String(pathWord))) {
        groupList.push({ pathWord: String(pathWord), name: String(name || k) });
      }
    });
  }
  if (!groupList.length) groupList.push({ pathWord: 'default', name: '默認' });
  groupList.sort((a, b) => (a.pathWord === 'default' ? -1 : b.pathWord === 'default' ? 1 : 0));

  /* 章节列表：**每个分组都翻页取全**（旧代码只看第一个非空分组 + 只取 limit=100 的第一页）。
     实测 haizeiwang：total=398 而旧代码只回 100 章（用户看到的「一百多章只显示几章」就是这个）。
     上游 limit 封顶 100（写 200/500/1000 实测直接 code 210），所以只能 offset 翻页；
     翻页会撞 code 210 反破解闸 → 继续走 copyReaderJson 的「轻/重头 × 退避」重试。 */
  const list = [];
  const seenId = Object.create(null);
  const usedGroups = [];
  let chapErr = '', cut = '', partial = '';
  for (const grp of groupList) {
    if (list.length >= COPY_MAX_CHAPTERS) {
      cut = '已到网关硬上限 ' + COPY_MAX_CHAPTERS + ' 章（上游还有分组没读：' +
        groupList.filter(x => usedGroups.indexOf(x.pathWord) < 0 && x.pathWord !== grp.pathWord)
          .map(x => x.name).join('、') + '）';
      break;
    }
    let offset = 0, got = 0, total = 0;
    for (;;) {
      let j = null;
      try {
        j = await copyReaderJson(base, '/api/v3/comic/' + encodeURIComponent(pw) + '/group/' +
          encodeURIComponent(grp.pathWord) + '/chapters?limit=' + COPY_CHAPTER_PAGE +
          '&offset=' + offset + '&in_mainland=true&request_id=', '拷贝漫画章节列表');
      } catch (e) {
        /* 这个分组翻到一半失败：保留已拿到的，别把整个作品判成「取不到章节」 */
        chapErr = '分组「' + grp.name + '」第 ' + (offset + 1) + ' 章起没取到：' + ((e && e.message) || e);
        if (got) partial = chapErr;
        break;
      }
      const res = (j && j.results) || {};
      const rows = asArray(res.list);
      total = parseInt(res.total, 10) || total;
      rows.forEach(c => {
        const id = String((c && c.uuid) || '');
        if (!id || seenId[id]) return;
        seenId[id] = 1;
        list.push({
          id: id,
          name: String((c && c.name) || '').trim() ||
            ('第 ' + ((parseInt(c && c.index, 10) || 0) + 1) + ' 话')
        });
      });
      got += rows.length;
      if (!rows.length && !offset) { chapErr = '分组「' + grp.name + '」返回 0 章'; }
      if (!rows.length || rows.length < COPY_CHAPTER_PAGE) break;      /* 到底了 */
      if (total && got >= total) break;                               /* 按上游 total 收口 */
      if (list.length >= COPY_MAX_CHAPTERS) {
        cut = '已到网关硬上限 ' + COPY_MAX_CHAPTERS + ' 章（上游分组「' + grp.name + '」共 ' +
          (total || '更多') + ' 章）';
        break;
      }
      offset += COPY_CHAPTER_PAGE;
    }
    if (got) usedGroups.push(grp.pathWord);
    if (cut) break;
  }
  if (!list.length) {
    throw new Error('拷贝漫画取不到章节列表（' + (chapErr || '上游没给章节') + '）—— ' +
      '上游常回 code 210 反破解闸，重试或过几分钟再试');
  }

  /* 要哪一章：不在清单里就退回第一话 */
  const wanted = String(chapter || '');
  const ids = list.map(c => c.id);
  const target = (wanted && ids.indexOf(wanted) >= 0) ? wanted : ids[0];
  const pages = [];
  try {
    const j2 = await copyReaderJson(base, '/api/v3/comic/' + encodeURIComponent(pw) + '/chapter2/' +
      encodeURIComponent(target) + '?in_mainland=true&request_id=', '拷贝漫画章节图片');
    const chapter = (j2 && j2.results && j2.results.chapter) || {};
    copyChapterPages(chapter).forEach(u => pages.push(readerPage(u, referer, 0, 0)));
  } catch (e) {
    throw new Error('拷贝漫画这一章的图片取不到：' + ((e && e.message) || e));
  }
  if (!pages.length) throw new Error('拷贝漫画这一章没有解析到任何图片地址（接口可能改版了）');

  const out = {
    title: title + (author ? ' · ' + author : ''),
    referer: referer,
    chapters: list,
    pages: pages
  };
  out.note = '拷贝漫画官方 APP API（节点 ' + base + '，HMAC 签名，' +
    '章节接口用 in_mainland/request_id 口径、图片接口是 chapter2，页顺序按 words 还原）。' +
    '章节清单已按分组翻页取全（每组每页 ' + COPY_CHAPTER_PAGE + ' 章）';
  if (groupList.length > 1) {
    out.note += '：这本上游有 ' + groupList.length + ' 个分组（' +
      groupList.map(x => x.name + ' ' + (x.pathWord === 'default' ? '' : x.pathWord)).join(' / ') +
      '），已合并成一个章节列表';
  }
  out.note += '。';
  if (partial) out.note += '注意：' + partial;
  if (cut) out.note += '注意：' + cut + '，清单可能不全。';
  return out;
}

/* ------------------------------ 禁漫天堂（jmcomic） ------------------------------
   两条上游请求凑齐整本：/chapter 给页文件名、/chapter_view_template 给 scramble_id 与 imghost。
   图片照样由 /api/proxy 同源代取（浏览器直连 CDN 会撞防盗链 / 跨域）。
   pages[] 里多带两个阅读器专用字段（都是新增的可选项，前端只认 url/alt/w/h）：
     · scramble = 该章节的 scramble_id（数字）；aid < scramble_id 的旧作品**不带**这个字段
       （站点自己的算法就是「aid 小于 scramble_id 就不打乱」，原图直接用）
     · bands    = 这一页的分块数（jmScrambleBands 按站点脚本算好）
   前端 reader.js 拿到 bands 才走 canvas 还原；拿不到就按原图显示 —— 宁可不动，也不乱动。
   还原规则不是凭记忆写的：get_num / onImageLoaded / scramble_image 三个函数逐行照抄
   https://<APP域名>/templates/frontend/airav/js/jquery.photo-0.5.js（实测 200 application/javascript）。 */
const JM_IMG_FALLBACK = 'https://cdn-msp.jmapinodeudzn.net';
const JM_TEMPLATE_MAX = 400000;

/** 取章节页模板（HTML，不是 JSON，所以不能走 jmApi） */
async function jmFetchTemplate(host, id) {
  const ts = nowSec();
  const r = await outFetch('https://' + host + '/chapter_view_template?id=' + encodeURIComponent(id), {
    timeout: 12000,
    headers: Object.assign(jmHeaders(host, ts), { accept: 'text/html,application/xhtml+xml,*/*' })
  });
  const sc = r.headers.get('set-cookie');
  if (sc) state.jmCookie = String(sc).split(';')[0];
  return r;
}

/** 从模板 HTML 里读 scramble_id / imghost / images（社区标准做法） */
function jmTemplateInfo(html) {
  const s = String(html || '');
  const out = { scramble: 0, imghost: '', jmid: '' };
  const a = s.match(/var\s+scramble_id\s*=\s*['"]?(\d+)/i);
  if (a) out.scramble = parseInt(a[1], 10) || 0;
  const b = s.match(/imghost\s*:\s*['"]([^'"]+)['"]/i);
  if (b) out.imghost = b[1].replace(/\/+$/, '');
  const c = s.match(/jmid\s*:\s*['"]?(\d+)/i);
  if (c) out.jmid = c[1];
  return out;
}

/* 禁漫的章节清单硬上限（理论上够用：实测最长的系列是 41 话这个量级；500 是防疯数，
   超了会在 note 里说明，不静默截断）。 */
const JM_MAX_CHAPTERS = 500;

/** 禁漫系列里一条 series 的显示名：name 是「最终话 / 18.2 / 纯数字」这类**后缀**，
    sort 是序号（1 起）。两者拼成「第 N 话」或「第 N 话（最终话）」。
    实测：id=1099115 的 series[0].name='' 、series[3].name='18.2'、最后一条 name='最终话'。 */
function jmChapterLabel(sort, name) {
  const n = parseInt(sort, 10);
  const label = String(name || '').replace(/\s+/g, ' ').trim();
  if (!label) return n > 0 ? ('第 ' + n + ' 话') : '章节';
  if (/^\d+(\.\d+)?$/.test(label)) return '第 ' + label + ' 话';
  return (n > 0 ? ('第 ' + n + ' 话（' + label + '）') : label);
}

async function readerJmcomic(id, chapter) {
  const m = String(id || '').match(/(\d{3,})/);
  const album = m ? m[1] : '';
  if (!album) throw new Error('禁漫的 id 需要是作品数字 id（形如 1474541 或 /album/1474541），收到的是「' + String(id || '') + '」');
  /* 阅读器给 chapter=<章节 id> 时改看那一话；没给就看 id 这一话本身（保持旧行为）。
     章节 id 就是 /chapter 的 id（= 图目录名 = 模板里的 aid），所以单章节作品的
     id 与 chapter 是同一个数。 */
  const cm = String(chapter || '').match(/(\d{2,})/);
  const view = cm ? cm[1] : album;
  /* ★第 18 轮：优先复用 5 分钟内记住的域名（jmPickHost），过期或这次失败才重新探测★
     旧写法每次都 jmResolveHost()（一整轮 pickProbe，实测 0.5–9s），这是「打开阅读器还要等几秒」的大头。
     复用之后就算那个域名坏了，下面的候选回退会换域名并把它换掉，所以不必为了「安全」每次都重探。 */
  const first = await jmPickHost();                         /* 记忆命中就不重探；未命中时 pickProbe 会顺便把 state.jmCdn 设成 /setting 的 img_host */
  /* ★第 18 轮：/chapter 拿不到文件名时**换域名再试**★
     实测（2026-09-24，本机）：阅读器偶发「禁漫这一话没有返回任何图片文件名（接口可能改版了）」，
     而同一时刻手动直测同一本（id=1475643）是 200 + 47 页 —— 说明那一次是**这一跳的瞬时故障**
     （出口/中继那一发回了空壳 JSON，或这个域名当时在抖），不是接口改版。
     既然 jmHostsList() 本来就有十来个互为镜像的 APP 域名，就不该用一次失败给整本判死。
     只有**全部候选都空/都失败**才报错，且报错里列出每个域名各自发生了什么。 */
  const candidates = [first];
  try { (await jmHostsList()).forEach(h => { if (candidates.indexOf(h) < 0) candidates.push(h); }); } catch (e) { /* 用现有列表 */ }
  const tries = [];
  let data = null, host = first;
  for (let i = 0; i < candidates.length && i < 3; i++) {
    const h = candidates[i];
    try {
      const d = await jmApi(h, '/chapter?id=' + encodeURIComponent(view), { timeout: i ? 7000 : 9000 });
      const fl = asArray(d && d.images).map(String).filter(Boolean);
      if (fl.length) {
        data = d; host = h;
        if (h !== first) {
          state.jmHost = h; state.jmHostAt = Date.now();
          log('禁漫换域名重试成功：「' + first + '」没给文件名 → 「' + h + '」给了 ' + fl.length + ' 张');
        }
        break;
      }
      tries.push(h + ' 返回 0 个文件名');
    } catch (e) {
      tries.push(h + ' → ' + ((e && e.message) || e));
    }
  }
  if (!data) {
    throw new Error('禁漫这一话没取到图片文件名（不一定是「接口改版」，更像这一跳的瞬时故障）：已试 ' +
      tries.join('；') + ' —— 稍后重试，或换个出口代理');
  }
  const files = asArray(data.images).map(String).filter(Boolean);
  const title = String((data && (data.name || data.title)) || ('禁漫 #' + view)).replace(/\s+/g, ' ').trim();

  /* 章节清单：**同一份 /chapter 响应里就带着整条 series**（实测 id=1099115：
     series.length=41，每条 {id,name,sort}），不需要额外请求，也不需要网页版（免得撞 CF）。
     单章节作品 series 是空数组、series_id=0 → chapters 仍是空数组（保持阅读器原有行为）。 */
  const seriesRows = asArray(data && data.series).filter(x => x && x.id);
  let chapters = [];
  let jmCut = false;
  if (seriesRows.length > 1) {
    chapters = seriesRows.slice(0, JM_MAX_CHAPTERS).map(x => ({
      id: String(x.id),
      name: jmChapterLabel(x.sort, x.name)
    }));
    jmCut = seriesRows.length > JM_MAX_CHAPTERS;
  }

  /* scramble_id 与图片域名都在章节页模板里；这一步**不需要过 Cloudflare**（APP 接口域名上就有） */
  /* ★第 18 轮：模板也换域名重试★ 模板只依赖 view（与 /chapter 无关），所以某个 APP 域名
     给不出 scramble_id 时直接换下一个候选（实测：域名在抖的时候 /chapter 有文件名、模板却是
     一段没有 scramble_id 的壳页面 —— 旧写法这时会整本判死成「没能还原图片」）。 */
  let tmpl = { scramble: 0, imghost: '', jmid: view }, tmplStatus = 0, tmplErr = '';
  const tmplTries = [];
  const tmplHosts = [host].concat(candidates.filter(h => h !== host));
  for (let i = 0; i < tmplHosts.length && i < 3; i++) {
    const h = tmplHosts[i];
    let st = 0, got = { scramble: 0, imghost: '', jmid: view }, err = '';
    try {
      const r = await jmFetchTemplate(h, view);
      st = r.status;
      got = jmTemplateInfo(r.text().slice(0, JM_TEMPLATE_MAX));
    } catch (e) { err = (e && e.message) || String(e); }
    if (got.scramble > 0) {
      tmpl = got; tmplStatus = st;
      if (h !== host) log('禁漫换域名取模板成功：「' + host + '」没给 scramble_id → 「' + h + '」（' + got.scramble + '）');
      break;
    }
    tmplTries.push(h + ' 模板 HTTP ' + (st || '失败') + (err ? '，' + err : ''));
    tmplStatus = st; tmplErr = err;
  }
  if (!(tmpl.scramble > 0)) {
    throw new Error(JM_READER_UNAVAILABLE + '（模板 HTTP ' + (tmplStatus || '失败') +
      (tmplErr ? '，' + tmplErr : '') + '；域名 ' + host +
      (tmplTries.length > 1 ? '；已试 ' + tmplTries.join('；') : '') + '）');
  }

  /* 图片域名：模板的 imghost 优先，其次 /setting 的 img_host，最后兜底。能取到图才用。 */
  const cands = [];
  const pushHost = h => {
    h = String(h || '').replace(/\/+$/, '');
    if (/^https?:\/\//i.test(h) && cands.indexOf(h) < 0) cands.push(h);
  };
  pushHost(tmpl.imghost); pushHost(state.jmCdn); pushHost(JM_IMG_FALLBACK);
  let base = '', lastErr = '';
  for (const c of cands) {
    try {
      const r = await outFetch(c + '/media/photos/' + view + '/' + encodeURIComponent(files[0]), { timeout: 9000 });
      if (r.status === 200 && /^image\//i.test(r.headers.get('content-type') || '')) { base = c; break; }
      lastErr = c + ' → HTTP ' + r.status + ' ' + (r.headers.get('content-type') || '');
    } catch (e) { lastErr = c + ' → ' + ((e && e.message) || e); }
  }
  if (!base) throw new Error('禁漫的图片 CDN 这次都取不到（' + cands.join(' / ') + '）' +
    (lastErr ? '，最后一次：' + lastErr : '') + ' —— 换个出口代理再试，或上游确实挂了');

  const scrambled = parseInt(view, 10) >= tmpl.scramble;
  const pages = files.map(f => {
    const p = readerPage(base + '/media/photos/' + view + '/' + f, READER_HOSTS.jmcomic, 0, 0);
    if (scrambled) {
      p.scramble = tmpl.scramble;
      p.bands = jmScrambleBands(view, String(f).replace(/\.[a-z0-9]+$/i, ''));
    }
    return p;
  });
  let note = '禁漫官方 APP API（' + host + '）：/chapter 给页文件名 + 整条 series，' +
    '/chapter_view_template 给 scramble_id=' + tmpl.scramble + '（模板里的 imghost=' + (tmpl.imghost || base) + '）。' +
    (scrambled
      ? '这本 aid ' + view + ' ≥ scramble_id，图片是**分块打乱**的：前端按站点自己的算法' +
        '（块数 = md5(aid+page) 末位 ASCII 决定 → 分块上下颠倒）用 canvas 还原后才显示。'
      : '这本 aid ' + view + ' < scramble_id，站点自己的算法判定**不打乱**，原图直接显示。');
  if (chapters.length) {
    note += '这本在禁漫上是**分章节**作品：series 共 ' + seriesRows.length + ' 话，' +
      '当前是「' + (chapters.find(c => c.id === view) || { name: title }).name + '」；' +
      '每话各自一个图目录与各自的 scramble 判定，换话由 chapter=<id> 重新取。';
    if (jmCut) note += '（series 超过网关硬上限 ' + JM_MAX_CHAPTERS + ' 话，只给了前 ' + chapters.length + ' 话）';
  }
  return {
    title: title,
    referer: READER_HOSTS.jmcomic,
    chapters: chapters,
    pages: pages,
    note: note
  };
}

/* ---------------------------- porn-comic.com 在线阅读 ----------------------------
   条目页 /h/<id>.html（第 n 页 = /h/<id>-<n>.html）整站前置 Cloudflare，
   所以走 pcFetchPage：先普通请求，被挡就交给本机 Chrome 过验证（与 porncomicSearch 同一套）。
   正文图在 file/file2/file3.acgnngca.com，**完全不经 Cloudflare**（本机实测）：
       https://file3.acgnngca.com/nh2/2026091617/4185264_1.webp → 200 image/webp 163876B
   关键实测结论：同一本第 n 页的图就是 `<媒体id>_<n>.<ext>`，n 从 1 开始与页号一一对应：
     · 872078（6 页）：_1.._6 全 200（163876/158230/141858/155784/206770/181534 B），_7 → 404
     · 812168（83 页）：_1/_2/_42/_83 抽查全 200（93704/126548/170716/82080 B），_84 → 404
   所以拿到第 1 页的图地址 + 总页数，就能**只花一次 CF 请求**拼出整本；
   拼完再用 CDN 直连探一次最后一页（不经 CF）确认编号规则确实成立 —— 探不通就退回逐页抓。
   三个 file*.acgnngca.com **不互为镜像**（同一个文件换域名一律 404），所以不给 alt。 */
const PC_READ_MAX = 300;     /* 单本最多产出多少页（只防分页条给疯数，不算"截断"：页地址是拼出来的，不额外打上游） */
const PC_WALK_MAX = 16;      /* 编号规则不成立时才逐页抓，每页一次 CF 请求，页数上限就压在这里 */

function pcReaderAlbum(id) {
  const m = String(id || '').match(/(\d{3,})/);
  return m ? m[1] : '';
}

function pcDecode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#x27;/gi, "'").replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

/** 从一页阅读页 HTML 里抠出：标题 / 正文图 / 这一本最后一页的页码 */
function pcParseItemPage(html, album) {
  const s = String(html || '');
  const out = { title: '', img: '', w: 0, h: 0, alt: '', last: 1 };
  const h1 = s.match(/<h1[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) out.title = pcDecode(h1[1]);
  const box = s.match(/<p[^>]*class="[^"]*manga-picture[^"]*"[^>]*>([\s\S]{0,3000}?)<\/p>/i);
  const tag = ((box ? box[1] : s).match(/<img\b[^>]*>/i) || [])[0] || '';
  out.img = (tag.match(/\bsrc="([^"]+)"/i) || [])[1] || '';
  out.w = parseInt((tag.match(/\bwidth="(\d+)"/i) || [])[1], 10) || 0;
  out.h = parseInt((tag.match(/\bheight="(\d+)"/i) || [])[1], 10) || 0;
  out.alt = pcDecode((tag.match(/\balt="([^"]*)"/i) || [])[1] || '');
  /* 分页条里的最大页码 = 最后一页。同一个 id 的链接只会出现在分页条与 next_picture 上，
     「上一本 / 下一本 / 相关作品」都是别的 id，不会误伤。 */
  let last = 0;
  const re = new RegExp('/h/' + album + '-(\\d+)\\.html', 'g');
  let m;
  while ((m = re.exec(s))) last = Math.max(last, parseInt(m[1], 10) || 0);
  /* 分页条是窗口式的（实测 83 页那本第 1 页上是 1 2 3 4 5 83），最大页码就是最后一页。
     只做一个防疯数的上限 —— 页地址是拼出来的，猜错也只是一页 404，不会多打上游。 */
  out.last = Math.max(1, Math.min(last || 1, PC_READ_MAX));
  return out;
}

/** 第 n 页的图地址：把 `_1.<ext>` 换成 `_n.<ext>`（编号规则见上面的实测记录） */
function pcPageImage(first, n) {
  const m = String(first || '').match(/^(.*_)(\d+)(\.[a-z0-9]+)$/i);
  if (!m || parseInt(m[2], 10) !== 1) return '';
  return m[1] + n + m[3];
}

/** 直接打 CDN（不经 CF）确认某个图地址真的在 —— 用来验证编号规则，也用来挡掉「拼出来的地址是 404」 */
async function pcImageExists(url) {
  try {
    const r = await outFetch(url, { timeout: 10000, headers: { accept: 'image/*,*/*' } });
    return r.status === 200 && /^image\//i.test(r.headers.get('content-type') || '');
  } catch (e) { return false; }
}

async function readerPorncomic(id) {
  const album = pcReaderAlbum(id);
  if (!album) throw new Error('porn-comic 的 id 需要是作品数字 id（形如 872078 或 /h/872078.html），收到的是「' + String(id || '') + '」');
  const referer = READER_HOSTS.porncomic;
  let first;
  try {
    first = await pcFetchPage('/h/' + album + '.html');
  } catch (e) {
    /* pcFetchPage 里的 Chrome 通道失败是**抛异常**（不是回一个挑战页），这里补上上下文再抛 */
    const why = cfUnavailableReason();
    throw new Error('porn-comic 的正文页整站前置 Cloudflare，网关这次没能过验证' +
      (why ? '（' + why + '）' : '') + '：' + ((e && e.message) || e) +
      ' —— 页地址只能从条目页 HTML 里读，所以这次给不出 pages（正文图 CDN 本身不需要 CF，实测 200 image/webp 可用）；' +
      '可以稍后重试（CF 失败后有 90 秒冷却），或换一个出口代理。');
  }
  if (first.status >= 400) throw new Error('porn-comic 条目页返回 HTTP ' + first.status + '（通道：' + first.via + '）');
  if (pcIsChallenge(first.html)) {
    const why = cfUnavailableReason();
    throw new Error('porn-comic 的正文页被 Cloudflare 人机验证挡住了' +
      (why ? '，而且这台机器过不了验证：' + why : '，Chrome 通道这次也没过（可能在冷却中，稍后重试）') +
      ' —— 正文页整站前置 CF，页地址只能从它里面读；图片本身不需要 CF，但拿不到页地址就拼不出 pages。');
  }
  const info = pcParseItemPage(first.html, album);
  if (!info.img) throw new Error('porn-comic 条目页里没有解析到正文图（页面结构可能改版了）');

  const pages = [];
  let viaFast = false;
  if (info.last > 1) {
    const lastUrl = pcPageImage(info.img, info.last);
    if (lastUrl && await pcImageExists(lastUrl)) viaFast = true;
  }
  if (viaFast) {
    for (let n = 1; n <= info.last; n++) {
      pages.push(readerPage(n === 1 ? info.img : pcPageImage(info.img, n), referer, info.w, info.h));
    }
  } else {
    /* 编号规则没验证通过（老作品的文件名是哈希、不带 _n）：退回逐页抓，页数多时只取前 PC_WALK_MAX 页 */
    pages.push(readerPage(info.img, referer, info.w, info.h));
    const upto = Math.min(info.last, PC_WALK_MAX);
    for (let n = 2; n <= upto; n++) {
      try {
        const r = await pcFetchPage('/h/' + album + '-' + n + '.html');
        const pi = pcParseItemPage(r.html, album);
        if (!pi.img) break;
        pages.push(readerPage(pi.img, referer, pi.w, pi.h));
      } catch (e) { break; }
    }
  }
  let note = 'porn-comic.com 阅读页：条目页 /h/<id>.html 整站前置 Cloudflare（网关用本机 Chrome 过验证），' +
    '正文图在 file*.acgnngca.com、不经 CF，页地址一律走 /api/proxy 带 Referer 取。';
  note += viaFast
    ? '本次只花 1 次 CF 请求：从第 1 页 HTML 读到图片编号与总页数 ' + info.last +
      '，其余页按 `<媒体id>_<n>` 规则拼出，并用 CDN 直连校验了最后一页确实存在。'
    : '本次逐页抓取（`<媒体id>_<n>` 编号规则没验证通过，多是老作品用哈希文件名）' +
      (info.last > PC_WALK_MAX ? '，这本共 ' + info.last + ' 页，只取了前 ' + PC_WALK_MAX + ' 页' : '') + '。';
  if (info.last >= PC_READ_MAX) note += '（分页条页码到了上限 ' + PC_READ_MAX + '，只取前 ' + PC_READ_MAX + ' 页）';
  return { title: info.title || ('porn-comic #' + album), referer: referer, chapters: [], pages: pages, note: note };
}

/* ==========================================================================
   LectorManga（lector-mangas.lat）**在线阅读** —— 网关侧实现
   --------------------------------------------------------------------------
   实测取证（经 /api/proxy 抓真页面，2026-02）：
     · 作品页 /comics/<slug> 是 Astro SSR，章节卡**全部**服务端渲染在一个容器里：
         <div class="row pa-4" id="chapters-list" data-page-size="24">
           <div class="col-md-6 col-12" data-chapter-num="700">
             <a href="/comics/naruto/capitulo-700" …>…<div>Capítulo <span>700</span></div>
                                              <div class="… text--disabled text-caption">hace 2 sem…</div>
       实测 naruto 的清单一次就是 **700 条**（=站点卡片上写的章数）、tower-of-god 的卡片有 1040 条但
       **405 条是同一话重复渲染**、去重后 636 话 —— 也就是说那个 data-page-size="24" 只是前端的
       展示分页，**HTML 里没有截断**，「抓一次作品页 = 拿全量章节」成立；但必须按话号去重。
     · 同一部作品的章节链接会混用两种写法（/capitulo-N 与 /chapter-N，互为别名：
       实测 fatezero 的清单写 capitulo-1/capitulo-2，而 head 里 prefetch 的是 chapter-1，
       两者都能打开、都是同一话）。解析对两种都收。
     · 必须**只认容器内 + slug 对得上**的链接，否则会收到一堆同形链接：
       页首 `<link rel="prefetch" href="/comics/<slug>/chapter-1">` 与「继续阅读」那条
       /comics/<slug>/chapter-1（都在容器之外）、以及 /comics/genre/xxx、/comics/status/xxx、
       /comics/<slug>（作品自身）。实测按容器切之后 fatezero=2 条、naruto=700 条、clean。
     · 章节页 /comics/<slug>/<capitulo-N|chapter-N> 的正文图固定在
         <img src="https://media.ikigaicomics.lat/capitulos/<作品id>/<媒体id>/page_001.webp"
              alt="Fate/Zero Capítulo 1 — Página 3" loading="eager|lazy" class="… reader-page-img">
       **class 含 reader-page-img** 是唯一稳定特征；src 就是真地址（不是 data-src，
       全页 data-src 出现 0 次）。实测 naruto-sazanka/capitulo-1 = 26 页、
       fatezero/chapter-1 = 38 页，页序号与 alt 里的「Página N」一一对应。
     · 图床 media.ikigaicomics.lat 浏览器直连会失败（本机 TLS/防盗链），经 /api/proxy
       实测 200 image/webp（68078B）。referer 传章节页 / 站点首页 / 空三种都能取到同样字节，
       这里仍按规矩带**章节页自己的 URL** 当 Referer。
     · pages[].alt 在本项目里是「同一页的备用图片地址」的语义（见上面的契约注释），
       所以**绝不**把 <img> 的 alt 文案（那是页号文案）塞进去 —— 那等于给了一个坏备用地址。
     · 章节清单缓存 10 分钟：naruto 的作品页 2.2MB / 700 张卡，而换章时按契约
       「只抓那一章的 HTML」，清单应当复用第一次的结果，不该每翻一话就重下 2MB。
   ========================================================================== */
const LM_READER_MAX_CHAPTERS = 3000;      // 纯防呆（实测最大 tower-of-god 1040 话）
const LM_READER_MS = 20000;               // 单页 HTML 超时；作品页可达 2.2MB，要给够
const LM_READER_CACHE_MS = 10 * 60e3;
const lmReaderCache = new Map();          // slug(小写) → { at, title, chapters:[{id,name}] }

/** slug / 章节段这一层的合法字符（挡掉 ../、/、空白、查询串这类注入） */
function lmSegOk(s) {
  return !!s && /^[A-Za-z0-9._-]+$/.test(s) && s.indexOf('..') < 0;
}

/** <meta property|name="<prop>" content="…"> 的值（属性顺序不敏感，逐 tag 找） */
function lmMetaContent(html, prop) {
  const tags = String(html || '').match(/<meta\b[^>]*>/gi) || [];
  const re = new RegExp('(?:property|name)="' + prop + '"', 'i');
  for (const t of tags) {
    if (!re.test(t)) continue;
    const c = (t.match(/\bcontent="([^"]*)"/i) || [])[1];
    if (c) return lmDecode(c);
  }
  return '';
}

/** 作品标题：og:title（去掉站点的「 - Leer online | Lectormanga」尾巴）→ h1 → slug */
function lmReaderTitle(html, slug) {
  let t = lmMetaContent(html, 'og:title')
    .replace(/\s*[-–—|]\s*Leer online.*$/i, '')
    .replace(/\s*\|\s*Lectormanga\s*$/i, '')
    .trim();
  if (!t) {
    const h1 = (String(html || '').match(/<h1[^>]*>([\s\S]{0,400}?)<\/h1>/i) || [])[1] || '';
    t = lmDecode(h1.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  }
  return t || slug;
}

/**
 * 作品页 → 章节清单（**升序**，chapters[0] 就是第 1 话）。
 * 主路按 `<div class="col-md-6 col-12" data-chapter-num="N">` 切卡片 —— 这是「章节卡」的结构
 * 不变量（实测 5 部作品 1～1040 话全都有），页尾那条「继续阅读 /comics/<slug>/chapter-1」
 * 链接没有卡片外壳，用锚点全扫会把它当成一节，按卡片切就不会。
 * 兜底：某天 data-chapter-num 消失了，退回「容器内 + slug 对得上 + 形如 chapter-N/capitulo-N」的锚点扫描。
 * ⚠ 站点会把同一话**重复渲染**（实测 tower-of-god：1040 个卡片、405 个是同一话同 href 出现两次，
 *   去重后 636 话，而检索卡片上写的「1040 章」正是那个重复计数）→ 必须按话号去重，
 *   否则下拉里同一话会出现两次；另 chapter-1 与 capitulo-1 是同一话的两种写法，也一并去重。
 */
function lmReaderChapters(html, slug) {
  const src = String(html || '');
  const at = src.indexOf('id="chapters-list"');
  if (at < 0) return [];
  const scope = src.slice(at);
  const s = String(slug).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const aRe = new RegExp('<a\\b[^>]*href="/comics/' + s + '/(chapter|capitulo)-([A-Za-z0-9._-]+)"', 'i');
  const out = [];
  const seenSeg = Object.create(null), seenNum = Object.create(null);
  const push = (seg, numRaw, blk) => {
    if (out.length >= LM_READER_MAX_CHAPTERS) return;
    if (seenSeg[seg]) return;
    seenSeg[seg] = 1;
    const numKey = /^\d+(?:\.\d+)?$/.test(numRaw) ? String(parseFloat(numRaw)) : '';
    if (numKey && seenNum[numKey]) return;                    // 同一话的重复卡片 / 两种写法
    if (numKey) seenNum[numKey] = 1;
    /* 章节名 = 卡片里 `<a>` 内部的文字，到日期行（class 含 text--disabled）为止。
       切点必须退到那个 tag 的 `<`，否则会留下半截 `<div class="…` 混进名字里。 */
    let body = String(blk || '');
    const dateAt = body.indexOf('text--disabled');
    if (dateAt > 0) {
      const lt = body.lastIndexOf('<', dateAt);
      body = body.slice(0, lt > 0 ? lt : dateAt);
    }
    let name = lmDecode(body.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (!name || name.length > 60) name = numKey ? ('Capítulo ' + numRaw) : seg;
    out.push({ id: seg, name: name, num: numKey ? parseFloat(numKey) : NaN, ord: out.length });
  };

  const parts = scope.split('data-chapter-num="');
  parts.shift();                                              // 第 0 段是容器开头，不是卡片
  for (const part of parts) {
    const m = part.match(aRe);
    if (!m) continue;
    push(m[1] + '-' + m[2], m[2], part.slice(m.index + m[0].length));
  }
  if (!out.length) {
    const re = new RegExp('<a\\b[^>]*href="/comics/' + s + '/(chapter|capitulo)-([A-Za-z0-9._-]+)"[^>]*>', 'gi');
    const hits = [];
    let m;
    while ((m = re.exec(scope))) {
      hits.push({ start: m.index, end: re.lastIndex, seg: m[1] + '-' + m[2], num: m[2] });
    }
    for (let i = 0; i < hits.length; i++) {
      const stop = hits[i + 1] ? hits[i + 1].start : Math.min(hits[i].end + 1500, scope.length);
      push(hits[i].seg, hits[i].num, scope.slice(hits[i].end, stop));
    }
  }
  /* 站点是从新到旧渲染的（naruto 第一条是 capitulo-700）；统一翻成升序 */
  const numeric = out.filter(c => !isNaN(c.num)).sort((a, b) => (a.num - b.num) || (a.ord - b.ord));
  const rest = out.filter(c => isNaN(c.num)).sort((a, b) => a.ord - b.ord);
  return numeric.concat(rest).map(c => ({ id: c.id, name: c.name }));
}

/** 章节页 → 正文图地址（按文档顺序 = 页顺序；class 含 reader-page-img 的 <img> 的 src 就是真地址） */
function lmReaderPages(html) {
  const out = [], seen = Object.create(null);
  const tags = String(html || '').match(/<img\b[^>]*>/gi) || [];
  for (const t of tags) {
    if (!/\breader-page-img\b/.test(t)) continue;
    const src = (t.match(/\bsrc="([^"]+)"/i) || [])[1] || '';
    if (!/^https?:\/\//i.test(src)) continue;
    if (seen[src]) continue;
    seen[src] = 1;
    out.push(src);
  }
  return out;
}

async function readerLectormanga(id, chapter) {
  const slug = String(id || '').trim();
  if (!lmSegOk(slug)) {
    throw new Error('LectorManga 的 id 需要是作品页 /comics/<slug> 里的 slug' +
      '（只允许字母、数字和 . _ -），收到的是「' + slug + '」');
  }
  const want = String(chapter || '').trim();
  if (want && !lmSegOk(want)) {
    throw new Error('LectorManga 的 chapter 需要是形如 capitulo-12 / chapter-3 的段落' +
      '（只允许字母、数字和 . _ -），收到的是「' + want + '」');
  }

  /* ---- 章：清单缓存（同一 slug 10 分钟内只下 1 次作品页，见文件头的实测理由） ---- */
  const key = slug.toLowerCase();
  let ent = lmReaderCache.get(key) || null;
  if (ent && (Date.now() - ent.at) > LM_READER_CACHE_MS) ent = null;
  if (!ent) {
    let r;
    try {
      r = await lmFetchPage('/comics/' + slug, LM_READER_MS);
    } catch (e) {
      throw new Error('LectorManga 作品页打不开（/comics/' + slug + '）：' + ((e && e.message) || e));
    }
    const chapters = lmReaderChapters(r.html, slug);
    if (!chapters.length) {
      throw new Error('LectorManga 作品页没有解析到章节列表（/comics/' + slug + '，域名 ' + r.host +
        '）：要么这个 slug 不是作品页，要么站点改版了（找的是 #chapters-list 里 /comics/<slug>/(chapter|capitulo)-N）');
    }
    ent = { at: Date.now(), title: lmReaderTitle(r.html, slug), base: r.base, chapters: chapters };
    if (lmReaderCache.size > 60) lmReaderCache.clear();
    lmReaderCache.set(key, ent);
  }

  /* ---- 页：只要一章的 HTML（chapter 不在清单里就退回第一话，和其他源一致） ---- */
  const ids = ent.chapters.map(c => c.id);
  const target = (want && ids.indexOf(want) >= 0) ? want : ids[0];
  if (!target) throw new Error('LectorManga 这个条目没有可读的章节（章节清单是空的）');

  const chapPath = '/comics/' + slug + '/' + target;
  let cr;
  try {
    cr = await lmFetchPage(chapPath, LM_READER_MS);
  } catch (e) {
    throw new Error('LectorManga 章节页「' + target + '」打不开（' + chapPath + '）：' + ((e && e.message) || e));
  }
  const urls = lmReaderPages(cr.html);
  if (!urls.length) {
    throw new Error('LectorManga 章节页「' + target + '」没有解析到正文图（' + chapPath +
      '，域名 ' + cr.host + '）：这一话可能还没放图 / 是付费或外链话 / 站点改版了' +
      '（找的是 class 含 reader-page-img 的 <img> 的 src）');
  }
  const pageRef = cr.base + chapPath;                 // 图床 Referer 用章节页自己的地址
  const referer = cr.base + '/';
  const pages = urls.map(u => readerPage(u, pageRef, 0, 0));
  const out = {
    title: ent.title || slug,
    referer: referer,
    chapters: ent.chapters,
    pages: pages
  };
  out.note = 'LectorManga（lector-mangas.lat）：作品页 Astro SSR 的 #chapters-list 一次给全量章节清单' +
    '（实测 naruto 700 话 / tower-of-god 1040 话，服务端渲染、无分页截断），' +
    '章节页取 class 含 reader-page-img 的 <img src> 当页地址，图床 media.ikigaicomics.lat 必须经 /api/proxy 代取。' +
    '本次这一话读到 ' + urls.length + ' 页。';
  return out;
}

async function readerFetch(query) {
  const source = String(query.source || '').trim().toLowerCase();
  const id = String(query.id || '').trim();
  if (READER_SOURCES.indexOf(source) < 0) {
    throw new Error('在线阅读暂时只支持 ' + READER_SOURCES.join(' / ') + '，收到的是「' + (source || '空') + '」');
  }
  if (!id) throw new Error('缺少作品 id');
  let out;
  if (source === 'mangadex') out = await readerMangadex(id, query.chapter);
  else if (source === 'nhentai') out = await readerNhentai(id);
  else if (source === 'wnacg') out = await readerWnacg(id);
  else if (source === 'ehentai') out = await readerEhentai(id);
  else if (source === 'hitomi') out = await readerHitomi(id);
  else if (source === 'pixiv') out = await readerPixiv(id);
  else if (source === 'copymanga') out = await readerCopymanga(id, query.chapter);
  else if (source === 'jmcomic') out = await readerJmcomic(id, query.chapter);
  else if (source === 'porncomic') out = await readerPorncomic(id);
  else if (source === 'lectormanga') out = await readerLectormanga(id, query.chapter);
  else out = await readerDanbooru(id);
  const res = {
    ok: true,
    source: source,
    id: id,
    title: out.title || '',
    referer: out.referer,
    chapters: out.chapters || [],
    pages: out.pages || []
  };
  /* 上游确实没有可读章节时的中文说明（目前只有 MangaDex 会给）。加在既有字段之后，
     字段名是新增的可选项，前端只认 ok/chapters/pages，结构不受影响。 */
  if (out.note) res.note = String(out.note);
  return res;
}

/* ------------------------------ HTTP 服务 ------------------------------ */const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2'
};

/* ==========================================================================
   /api/tags —— 按作品 id 从原站取回**标签**（卡片 / 放大器展示用）
   --------------------------------------------------------------------------
   为什么要有这条路由：标签的取法分两类。nhentai 与 MangaDex 的详情接口是**公开 JSON**，
   前端直接走 /api/proxy 就能拿到（见 assets/js/cardtags.js）；而禁漫 / 拷贝 / E-Hentai
   这三家不行 —— 实测经 /api/proxy 取：
     · 禁漫 /api/album?id=… 与作品页 HTML 都是 **403**（要 APP API 的 token / 请求头）；
     · 拷贝的题材挂在自己的 APP API 上（com.copymanga.app- 头 + 节点竞速）；
     · E-Hentai 的作品页在通用代理下 **502**，而网关自己的出口能取到。
   这三家的机器（host 解析 / token / 节流 / CF）本来就在网关里 —— 所以取法写在这里，
   前端只认 { ok, tags }，与其它接口同一口径（失败也回 200 + ok:false）。

   只收**能显示**的标签：分类 / 语言 / 上传者这些卡片上已有角标或对读者没意义。
   条数封顶 40（放大器最多显示 30，多取的只是浪费带宽）。
   ========================================================================== */
const TAGS_MAX = 40;

/** 去重 + 去空 + 封顶，保持原站顺序。
   ★整份是字符串时要按空白拆开★：禁漫的 /chapter 把 tags 回成**空格连接的一整串**
   （实测 jm id=480715 → `"C102 蘿莉 泳裝 中文 禁漫書庫 日不落 雌懸浮"`）。
   注意这里必须收到**原始值**：asArray() 对非数组是「包成单元素数组」，
   若调用方先 asArray 再传进来，字符串就被包成数组、下面这条分支永远走不到
   （踩过一次：n 恒为 1、整串变成一个巨型标签）。
   数组里的单个元素**不拆** —— 别家的标签本来就可能含空格（nhentai 的 `big breasts`）。 */
function tagsClean(list) {
  const rows = typeof list === 'string' ? list.split(/\s+/) : asArray(list);
  const out = [], seen = Object.create(null);
  for (const raw of rows) {
    const one = (raw && typeof raw === 'object') ? (raw.name || raw.title || '') : raw;
    const t = String(one == null ? '' : one).replace(/\s+/g, ' ').trim();
    if (!t || t.length > 64) continue;
    const k = t.toLowerCase();
    if (seen[k]) continue;
    seen[k] = 1;
    out.push(t);
    if (out.length >= TAGS_MAX) break;
  }
  return out;
}

/** 禁漫：APP API 的 /chapter 响应里就带着整本作品的 tags（读者那条路用的同一个接口） */
async function tagsJmcomic(id) {
  const m = String(id || '').match(/(\d{3,})/);
  if (!m) throw new Error('禁漫的 id 需要是作品数字 id，收到「' + String(id || '') + '」');
  const host = await jmResolveHost();
  const data = await jmApi(host, '/chapter?id=' + encodeURIComponent(m[1]));
  /* 原样交给 tagsClean：禁漫这里的 tags 是**空格连接的一整串**（不是数组），
     先 asArray 就会把它包成单元素数组、拆不开。 */
  return { tags: tagsClean(data && data.tags), via: host };
}

/** 拷贝漫画：作品详情（theme / genre 等）—— 与阅读器同一条 APP API 通路 */
async function tagsCopymanga(id) {
  const pw = String(id || '').trim()
    .replace(/^https?:\/\/[^/]+\/comic\//i, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (!pw) throw new Error('拷贝漫画的 id 需要是 path_word，收到「' + String(id || '') + '」');
  const bases = await copyReaderBases();
  let j = null, base = '', err = '';
  for (const b of bases) {
    try {
      j = await copyReaderJson(b, '/api/v3/comic2/' + encodeURIComponent(pw) +
        '?in_mainland=true&request_id=&platform=3', '拷贝漫画作品标签');
      base = b;
      break;
    } catch (e) { err = (e && e.message) || e; }
  }
  if (!j) throw new Error('拷贝漫画取不到作品详情（' + (err || '所有 API 节点都失败') + '）');
  const comic = ((j.results || {}).comic) || {};
  const out = [];
  ['theme', 'genre', 'tag', 'tags', 'parody', 'character'].forEach(k => {
    asArray(comic[k]).forEach(t => out.push(typeof t === 'string' ? t : ((t && (t.name || t.title)) || '')));
  });
  return { tags: tagsClean(out), via: base };
}

/** E-Hentai：图集页的 #taglist 里全是 /tag/<ns>:<name> 链接（要 gid + token） */
async function tagsEhentai(id) {
  const parts = ehIdParts(id);
  if (!parts) throw new Error('E-Hentai 的 id 需要 gid 或 gid-token，收到「' + String(id || '') + '」');
  if (!parts.token) throw new Error('E-Hentai 的图集链接必须带 10 位 token（形如 ' + parts.gid + '-xxxxxxxxxx）');
  const html = await ehHtml(EH_HOST + '/g/' + parts.gid + '/' + parts.token + '/', 'E-Hentai 图集页（标签）', 20000);
  const out = [];
  const re = /href="[^"]*\/tag\/([^"'?#]+)"/gi;
  let m;
  while ((m = re.exec(html))) {
    let raw = m[1];
    try { raw = decodeURIComponent(raw.replace(/\+/g, ' ')); } catch (e) { /* 原样 */ }
    const i = raw.indexOf(':');
    const ns = i > 0 ? raw.slice(0, i).toLowerCase() : '';
    const name = (i > 0 ? raw.slice(i + 1) : raw).replace(/-/g, ' ').trim();
    /* 语言 / 上传者 / 重分类这些不显示（卡片上已有语言角标，上传者对读者没意义） */
    if (!name || /^(language|uploader|reclass|temp|other)$/.test(ns)) continue;
    out.push(name);
  }
  if (!out.length) throw new Error('E-Hentai 图集页里没有解析到标签（页面可能改版或需要登录）');
  return { tags: tagsClean(out), via: 'ehentai 图集页' };
}

const TAGS_SRC = { jmcomic: tagsJmcomic, copymanga: tagsCopymanga, ehentai: tagsEhentai };

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'access-control-allow-origin': '*',
    'cache-control': 'no-store'
  });
  res.end(body);
}
const sendErr = (res, e) => sendJson(res, (e && e.status) || 502, { ok: false, error: (e && e.message) || String(e) });

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('404 ' + rel); }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache'
    });
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const pathname = u.pathname;
  const q = Object.fromEntries(u.searchParams.entries());

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS'
    });
    return res.end();
  }

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  try {
    switch (pathname) {
      case '/api/ping':
        return sendJson(res, 200, {
          name: 'hs-gateway', version: GW_VERSION, time: Date.now(),
          sources: ['jm', 'picacg', 'copymanga', 'kemono', 'porncomic', 'lectormanga', 'pixiv', 'nhentai', 'proxy', 'relay'],
          /* 能力位（与 sources 分开：这一位不是「一个可检索的源」，而是网关提供的能力，
             前端拿它决定要不要发 /api/translate 请求，省掉旧网关上的 404 往返） */
          xlate: true,
          /* egress 保持**字符串**（前端 filters.js 直接显示它），另给 egressDetail 供细看 */
          egress: egressText(),
          egressDetail: {
            startup: process.env.HS_GW_PROXIED === '1',
            startupProxy: envProxyUrl(),
            liveProxy: egress.live,
            mode: egress.live ? 'proxy' : 'direct',
            hostPlan: planSummary()
          },
          doh: { servers: DOH_SERVERS.map(s => s.id), cached: dnsCache.size, pinned: pinCache.size },
          relays: RELAYS.map(r => ({
            id: r.id, kind: r.kind, private: !!r.private,
            cooldownSec: Math.max(0, Math.ceil(((relayState.get(r.id) || 0) - Date.now()) / 1000)),
            /* 被这条中继「按出口 IP 挡掉」的目标主机数：私有中继上这个数 >0 是正常的
               （nhentai / danbooru / jmcomic / pixiv 对机房出口一律 403），不是故障。 */
            blockedHosts: relayHostBlockedCount(r.id)
          })),
          proxyCache: {
            entries: proxyCache.size,
            mb: Math.round(proxyCacheBytes / 1048576 * 10) / 10,
            ttlSec: Math.round(PROXY_CACHE_MS / 1000),
            deadHosts: deadHosts.size
          },
          picacgLoggedIn: !!state.picacgToken,
          jmHost: state.jmHost || '', copyApi: state.copyApi || '',
          cfSolver: {
            /* available 只回答「环境上可能可用」（可执行文件在、没被 HS_CF_SOLVER=0 关掉）。
               实测教训：沙箱/受限环境里 Chrome 根本起不来，它照样报 true ——
               所以一定连 verified / failing / lastError 一起看，别只看 available。 */
            available: !cfUnavailableReason() && !cfSolverFailing(),
            reason: cfUnavailableReason(),
            browser: cfChromePath(),
            headful: String(process.env.HS_CF_HEADFUL || '') === '1',
            running: !!(cfState.ws && cfState.proc),
            renders: cfState.renders,
            verified: cfState.renders > 0,          /* 本进程真的成功过一次才为 true */
            failing: cfSolverFailing(),             /* 最近一次真实尝试失败、之后还没成功 */
            lastOkAt: cfState.lastOkAt || 0,
            lastErrorAt: cfState.lastFailAt || 0,
            cacheSize: cfCache.size,
            cooldownSec: Math.ceil(cfCooldownLeft() / 1000),
            lastError: cfLastErr,
            /* 过验证后缓存的 CF 通行证（只报主机/条数/年龄，**绝不含 cookie 值**）：
               问「/api/proxy 代取 *.donmai.us 的图片有没有凭证可用」就看这里 */
            credentials: cfCredSummary()
          }
        });

      case '/api/diag': {
        /* 出口自检的实现搬到了 diagProbe()（与 /api/warm 共用一份目标表）。
           结论进程内缓存 60s：弹窗时 /api/warm 先跑掉的那一份，前端随后点「检测」就直接命中，
           不必再花几十秒重跑。要强制重测就带 force=1。 */
        const fresh = (diagCache.data && (Date.now() - diagCache.at < DIAG_CACHE_MS)) ? diagCache.data : null;
        if (fresh && String(q.force || '') !== '1') {
          return sendJson(res, 200, Object.assign({}, fresh, { cached: true }));
        }
        const d = await diagProbe(12000);
        diagCache = { at: Date.now(), data: d };
        return sendJson(res, 200, Object.assign({}, d, { cached: false }));
      }

      case '/api/warm': {
        /* ★r18 需求②④「弹出网页就把网点连好，而不是等一会」★
           用户的原话：搜索时好时坏要「从弹出网页开始」提高稳定性；进初始页不要弹
           「部分网点没有连接」。这里做两件廉价、可重复的事：
             ① 把 /api/diag 那套出口自检提前跑掉（结论进同一个缓存格子）——
                DoH 钉 IP / 中继选择 / 通路记忆这笔钱，付在弹窗时，而不是用户第一次搜索时；
             ② 顺手把阅读器要用的图片主机钉好 IP（只做 DNS+TLS 验真，不取内容）。
           刻意**不**对 e-hentai 发检索：第 17 轮取证显示它的封禁窗口正是我们的重试刷出来的。 */
        const t0 = Date.now();
        const hit = (diagCache.data && (Date.now() - diagCache.at < WARM_CACHE_MS)) ? diagCache.data : null;
        if (hit) {
          return sendJson(res, 200, Object.assign({}, hit, {
            warm: true, cached: true, full: true, ms: Date.now() - t0, pinned: {}, upstream: null
          }));
        }
        /* 三段并行、各自软超时，整段再套保险丝：**预热绝不能变成新的等待**。
           （第一版把三段串起来写，真机实测 31.2 秒才回 —— 见 WARM_PROBE_MS 的注释。） */
        const soft = (p, ms, fb) => withHardTimeout(p, ms, '网关预热').catch(() => fb);
        const got = await soft(Promise.all([
          soft(diagProbe(WARM_PROBE_MS), WARM_HARD_MS, null),
          soft(Promise.all(WARM_PIN_HOSTS.map(h => pinHost(h, 1800).catch(() => ''))), WARM_PIN_MS, null),
          soft(warmUpstreamCheck(), WARM_UP_MS, null)
        ]), WARM_TOTAL_MS, null);
        const d0 = got && got[0];
        /* 预热失败不该让前端拿不到结论：回一个空壳，前端会退回 /api/diag */
        const d = (d0 && d0.targets && Object.keys(d0.targets).length) ? d0 : {
          egress: egressText(),
          egressDetail: {
            startup: process.env.HS_GW_PROXIED === '1', startupProxy: envProxyUrl(),
            liveProxy: egress.live, hostPlan: planSummary()
          },
          targets: {}
        };
        const pinned = {};
        ((got && got[1]) || []).forEach((ip, i) => { if (ip) pinned[WARM_PIN_HOSTS[i]] = ip; });
        const upstream = (got && got[2]) || null;
        /* 只有「每个目标都真拿到了结论」的这一份才配当自检结论（写进 diagCache，让
           /api/diag 与下一次预热直接命中）。任何一项是硬超时（unknown）就说明这次预热不完整，
           绝不让它冒充最终结论 —— 把一次超时说成「连网关也打不通」正是误报的来源。 */
        const full = !!Object.keys(d.targets).length &&
          !Object.keys(d.targets).some(k => d.targets[k] && d.targets[k].unknown);
        if (full) diagCache = { at: Date.now(), data: d };
        return sendJson(res, 200, Object.assign({}, d, {
          warm: true, cached: false, full: full, ms: Date.now() - t0, pinned, upstream
        }));
      }

      case '/api/ehentai/search': {
        /* E-Hentai 的搜索侧在当前出口 IP 下一律返回空集（实测见函数头的取证记录），
           所以这里永远 200 + {ok:true,…}：真有结果就是真结果，没有就 via:'torrents'
           走实测可用的种子检索兜底，并把原因写在 note 里 —— 绝不伪造搜索结果。 */
        try {
          return sendJson(res, 200, await ehentaiSearch(q));
        } catch (e) {
          return sendJson(res, 200, {
            ok: false, source: 'ehentai', error: (e && e.message) || String(e)
          });
        }
      }

      case '/api/kemono/search':
        try {
          return sendJson(res, 200, await kemonoSearch(q));
        } catch (e) {
          return sendJson(res, 200, { ok: false, source: 'kemono', items: [], error: (e && e.message) || String(e) });
        }

      /* nhentai（本机直连必失败，只有带出口代理的网关能取到）：失败也走 200 + {ok:false,error}，
         跟 /api/reader 一致 —— 前端只认 ok 字段，不读 HTTP 码。
         成功的结果进 TTL 缓存（键 = q|page|sort），命中时直接回缓存并带 cached:true */
      case '/api/nhentai/search': {
        const cKey = String(q.q || '').trim() + '|' +
          Math.max(1, parseInt(q.page || '1', 10) || 1) + '|' + String(q.sort || '').toLowerCase();
        const cHit = nhCacheGet(cKey);
        if (cHit) return sendJson(res, 200, Object.assign({}, cHit, { cached: true }));
        try {
          const out = await nhentaiSearch(q);
          nhCacheSet(cKey, out);
          return sendJson(res, 200, Object.assign({}, out, { cached: false }));
        } catch (e) {
          return sendJson(res, 200, {
            ok: false, source: 'nhentai', page: Math.max(1, parseInt(q.page || '1', 10) || 1),
            cached: false,
            error: 'nhentai 检索失败：' + ((e && e.message) || String(e))
          });
        }
      }

      /* 第 8 轮统一口径：这五条「薄路由」以前把函数里的异常直接抛给顶层，
         结果用户只看到 HTTP 502（而 /api/ehentai/search、/api/wnacg/search、
         /api/nhentai/search、/api/reader 早就是 200 + {ok:false,error}）。
         现在统一成 200 + {ok:false,error}：前端 gwItems() 会把 error 原样抛出来，
         用户看到的是「站点被 Cloudflare 挡」「上游超时」这种可读原因，而不是 502。 */
      case '/api/porncomic/search': {
        /* ★r18 需求②★ 负缓存：porn-comic 要走 CF 渲染 / 中继，一次失败能烧掉 9 秒以上，
           而它以前连**成功**都不缓存（见 swFail 的注释）。 */
        const pf = swFailGet('porncomic', q.q);
        if (pf) return sendJson(res, 200, swFailBody('porncomic', pf));
        try {
          const out = await porncomicSearch(q);
          swFailClear('porncomic', q.q);
          return sendJson(res, 200, out);
        } catch (e) {
          swFailSet('porncomic', q.q, e);
          return sendJson(res, 200, { ok: false, source: 'porncomic', items: [], error: (e && e.message) || String(e) });
        }
      }

      /* LectorManga（西语站 lector-mangas.lat）：服务端渲染 HTML，?search= 检索。
         无 CF 挑战、无 cookie、无签名 —— 但仍不返回 CORS 头，所以只能由网关代取。 */
      case '/api/lectormanga/search':
        try {
          return sendJson(res, 200, await lectormangaSearch(q));
        } catch (e) {
          return sendJson(res, 200, { ok: false, source: 'lectormanga', items: [], error: (e && e.message) || String(e) });
        }

      /* 词语级翻译：中文关键词要打西语站（LectorManga）时用。
         · MyMemory 免费接口，keyless；实测本机直连 1.1s 可回。
         · 硬超时 + 进程内缓存；失败一律 ok:false，前端静默降级到离线词典，
           绝不因为翻译失败让检索本身报错。 */
      case '/api/translate':
        return sendJson(res, 200, await translateText(q));

      case '/api/pixiv/search':
        try {
          return sendJson(res, 200, await pixivSearch(q));
        } catch (e) {
          return sendJson(res, 200, { ok: false, source: 'pixiv', items: [], error: (e && e.message) || String(e) });
        }

      /* 自检：本机 Chrome 到底能不能过 Cloudflare（排查 porn-comic 用）
         ?force=1 可以无视冷却/缓存，强制真闯一次（诊断时才用） */
      case '/api/porncomic/solve': {
        const why = cfUnavailableReason();
        if (why) return sendJson(res, 200, { ok: false, reason: why });
        const url = String(q.url || (PC_BASE + '/tags/' + (pcSlug(q.tag) || 'anal') + '.html'));
        const t0 = Date.now();
        try {
          const html = await cfRender(url, { timeout: 45000, force: String(q.force || '') === '1' });
          const items = pcParse(html, 'porn-comic.com', 60);
          return sendJson(res, 200, {
            ok: true, url: url, ms: Date.now() - t0, bytes: html.length,
            browser: cfChromePath(), ua: cfState.ua, items: items.length,
            sample: items.slice(0, 3).map(i => i.title)
          });
        } catch (e) {
          return sendJson(res, 200, {
            ok: false, url: url, ms: Date.now() - t0,
            reason: (e && e.message) || String(e),
            cooldownSec: Math.ceil(cfCooldownLeft() / 1000)
          });
        }
      }

      case '/api/jm/search':
        try {
          return sendJson(res, 200, await jmSearch(q));
        } catch (e) {
          return sendJson(res, 200, { ok: false, source: 'jmcomic', items: [], error: (e && e.message) || String(e) });
        }

      case '/api/jm/hosts':
        return sendJson(res, 200, { hosts: await jmHostsList(q.extra), current: state.jmHost });

      case '/api/picacg/search':
        return sendJson(res, 200, await picacgSearch(q));

      case '/api/picacg/login': {
        if (req.method !== 'POST') return sendJson(res, 405, { error: '请用 POST' });
        let body = '';
        await new Promise(ok => { req.on('data', c => { body += c; }); req.on('end', ok); });
        const j = JSON.parse(body || '{}');
        const token = await picaLogin(j.email || state.picacgEmail, j.password || state.picacgPassword);
        return sendJson(res, 200, { ok: true, token: token.slice(0, 8) + '…' });
      }

      case '/api/copymanga/search': {
        /* ★r18 需求②★ 负缓存：拷贝漫画是本项目最贵的失败路径（上游三个节点全空、
           竞速要跑到 6–7.5s 硬闸），而失败以前**不被记忆** —— 同一个词再按一次回车，
           这 7 秒要重新付一遍，用户感受就是「时好时坏」。 */
        const cf = swFailGet('copymanga', q.q);
        if (cf) return sendJson(res, 200, swFailBody('copymanga', cf));
        try {
          const out = await copymangaSearch(q);
          swFailClear('copymanga', q.q);
          return sendJson(res, 200, out);
        } catch (e) {
          swFailSet('copymanga', q.q, e);
          return sendJson(res, 200, { ok: false, source: 'copymanga', items: [], error: (e && e.message) || String(e) });
        }
      }

      /* 紳士漫畫检索（网关侧镜像竞速 + 重定向跟随 + 结果缓存，见 wnacgSearch 的注释）。
         失败也回 200 + {ok:false,error}，前端只认 ok/items，不读 HTTP 码。 */
      case '/api/wnacg/search': {
        try {
          return sendJson(res, 200, Object.assign({ ok: true }, await wnacgSearch(q)));
        } catch (e) {
          return sendJson(res, 200, {
            ok: false, source: 'wnacg', items: [],
            error: (e && e.message) || String(e)
          });
        }
      }

      /* 在线阅读器：mangadex / nhentai / danbooru / wnacg / ehentai 的章节清单 + 已代理好的页地址
         失败也走 200 + {ok:false,error}（跟其它接口一致），前端只认 ok 字段，不读 HTTP 码 */
      case '/api/reader': {
        try {
          return sendJson(res, 200, await readerFetch(q));
        } catch (e) {
          return sendJson(res, 200, {
            ok: false, source: String(q.source || ''), id: String(q.id || ''),
            error: (e && e.message) || String(e)
          });
        }
      }

      /* 按作品 id 取标签（禁漫 / 拷贝 / E-Hentai）—— 卡片与放大器展示用。
         失败也回 200 + {ok:false, tags:[]}，前端静默保持原样（与其它接口同口径）。 */
      case '/api/tags': {
        const tSrc = String(q.source || '').toLowerCase();
        try {
          const fn = TAGS_SRC[tSrc];
          if (!fn) throw new Error('这个来源还没有取标签的取法（可用：' + Object.keys(TAGS_SRC).join(' / ') + '）');
          const got = await fn(q.id);
          return sendJson(res, 200, {
            ok: true, source: tSrc, id: String(q.id == null ? '' : q.id),
            tags: got.tags, via: got.via || ''
          });
        } catch (e) {
          return sendJson(res, 200, {
            ok: false, source: tSrc, id: String(q.id == null ? '' : q.id), tags: [],
            error: (e && e.message) || String(e)
          });
        }
      }

      case '/api/prefetch': {
        /* ★r18 需求③「在线阅读取图更快、失败更少」★
           阅读器拿到章节数据后，把「接下来几页」的取图地址一次性交给网关：
           网关按并发上限把它们取回，**填进与 /api/proxy 完全同一份 proxyCache** ——
           用户真滑到那一页时就是缓存命中（毫秒级），中继/上游配额也不必重复烧。
           参数：
             urls    —— \n 分隔的地址表（最多 PRE_MAX 条）。可以直接给页盒上的 data-url
                        （/api/proxy?url=…&referer=…），这里会拆回 (url, referer) 去算缓存键，
                        保证与真正取图用的是**同一把 key**（否则预取全白做）。
             referer —— 可选；给裸图地址时统一的 Referer。
             timeout —— 可选，每张图的预算上限（默认 9000ms）。
           语义：逐条吞错（记进 failed），**绝不**因为预取失败影响任何主流程；
           整批受 PRE_HARD_MS 的总死线约束，不会把连接占住不放。 */
        const raw = String(q.urls || '');
        const ref0 = String(q.referer || '');
        const per = Math.max(2000, Math.min(15000, parseInt(q.timeout || '9000', 10) || 9000));
        const items = raw.split(/\s*[\n|,]\s*/).filter(Boolean).slice(0, PRE_MAX).map(s => {
          let target = s, ref = ref0;
          if (/\/api\/proxy\?/i.test(s)) {
            try {
              const u2 = new URL(s, 'http://127.0.0.1/');
              target = u2.searchParams.get('url') || '';
              ref = u2.searchParams.get('referer') || ref0;
            } catch (e) { /* 解析不了就当裸地址处理 */ }
          }
          return { target: target, ref: ref };
        }).filter(x => /^https?:\/\//i.test(x.target));
        const t0 = Date.now();
        let filled = 0, done = 0;
        const failed = [];
        let idx = 0;
        const worker = async () => {
          while (idx < items.length) {
            if (Date.now() - t0 > PRE_HARD_MS) return;      /* 到点不再开新的，已发的自然跑完 */
            const it = items[idx++];
            const ck = it.target + '\u0000' + (it.ref || '');
            if (proxyCacheGet(ck)) { filled++; done++; continue; }
            const rest = Math.min(per, Math.max(1200, PRE_HARD_MS - (Date.now() - t0)));
            try {
              const got = await proxyFetch(it.target, it.ref, { timeout: rest });
              done++;
              if (got && got.buf && got.buf.length) filled++;
            } catch (e) {
              done++;
              failed.push({ url: stripHost(it.target), error: ((e && e.message) || String(e)).slice(0, 120) });
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(PRE_CONC, items.length) }, worker));
        if (items.length) log('预取 ' + items.length + ' 页：入缓存 ' + filled + '，失败 ' + failed.length +
          '（' + (Date.now() - t0) + 'ms）');
        return sendJson(res, 200, {
          ok: true, asked: items.length, done: done, filled: filled,
          failed: failed.slice(0, 6), ms: Date.now() - t0
        });
      }

      case '/api/proxy': {
        const want = String(q.url || '');
        /* 第 10 轮：danbooru 的 /posts.json 在本机三层全断（DNS 投毒 + CF 挑战 + 中继 5xx），
           所以先试「可达镜像」（tbib / xbooru）：命中就直接把映射好的 danbooru 形状回给前端。
           只拦 DANBOORU_CF_HOST_RE 域下、路径以 /posts.json 结尾的请求 ——
           图床图片、阅读器 /posts/<id>.json、任何别的域名一个字节都不动。 */
        const mirQ = danbooruMirrorQuery(want);
        if (mirQ) {
          try {
            const got = await danbooruMirrorFetch(mirQ);
            return sendJson(res, 200, got.posts);
          } catch (e) {
            /* 镜像也全挂：如实记一笔，继续往下走原来的 CF 兜底与失败链 */
            log('danbooru 镜像兜底失败（转入原链）：' + ((e && e.message) || e));
          }
        }
        /* 第 10 轮：proxyFetch 抛错（最典型的是 deadHosts 的「近期取源失败，已临时跳过」短路）
           以前会一路抛到顶层 → 只回一个 HTTP 502 空壳，**而且让下面 danbooru 的 CF 兜底
           彻底没机会执行**。第 8 轮 100 轮压测里 danbooru 的 ×33 个 502 就是这么来的：
           第一轮失败把主机打进 45s 冷却，之后每一轮都在 4ms 内被短路掉（实测见过 4ms/502）。
           现在把失败收进 netErr，继续走兜底链，最后回一个说明白了的 JSON 失败。 */
        let r = null;
        let netErr = null;
        try {
          r = await proxyFetch(want, q.referer);
        } catch (e) {
          netErr = (e && e.message) || String(e);
        }
        /* 「danbooru 系 + .json 接口」= 唯一值得动用 Chrome 过 CF 的组合 */
        const danJson = DANBOORU_CF_HOST_RE.test(stripHost(want)) && /\.json(\?|$)/i.test(want);
        /* Danbooru 的接口在当前出口**必被 CF 挡**（实测 403 + cf-mitigated: challenge）。
           前端 sources.js 的检索链是「直连 → 本地网关 → 公共代理」：浏览器自己直连
           danbooru 是通的（有 CF 通行证 + CORS），但一旦直连失败退到这里，拿回去的就是
           一张挑战页、JSON.parse 直接失败，整条链就断了。所以这里只对 **.json 接口**
           做一次 Chrome 兜底：渲染 JSON 查看器 → 把 JSON 原文抠回来 → 回合法 JSON。
           图片**不在这里救**：Chrome 渲染一张图只会得到 <img> 外壳、拿不到字节，
           回 HTML 只会让 <img> 变裂图（图片由 /api/reader 直接给 cdn 直连地址）。 */
        if (danJson && (!r || r.status >= 400)) {
          try {
            const got = await cfFetchWithSolver(want, {
              what: 'Danbooru 接口', timeout: 12000, minBody: 200, okRe: DANBOORU_JSON_OK_RE,
              pre: r ? { status: r.status, headers: r.headers, text: () => r.buf.toString('utf8') } : undefined
            });
            let buf;
            if (got.via === 'chrome') {
              const j = cfJsonFromRenderedHtml(got.text);
              if (!j) throw new Error('Chrome 渲染后仍拿不到 JSON（' + String(got.text).length + ' 字节）');
              buf = Buffer.from(JSON.stringify(j), 'utf8');
            } else {
              buf = Buffer.from(got.text, 'utf8');
            }
            log('danbooru 接口 /api/proxy 兜底成功：' + want.replace(/^https:\/\/[^/]+/, '') +
              '（via=' + got.via + '）');
            res.writeHead(200, {
              'content-type': 'application/json; charset=utf-8',
              'content-length': buf.length,
              'access-control-allow-origin': '*',
              'cache-control': 'no-store'
            });
            return res.end(buf);
          } catch (e) {
            /* 兜底也失败：照原样把上游的挑战页回给浏览器，让前端按它自己的失败链继续换通路 */
            log('danbooru 接口 /api/proxy 的 CF 兜底失败：' + ((e && e.message) || e));
          }
        }
        /* 第 10 轮：连兜底都没救回来（proxyFetch 直接抛错、r 为空）→
           不再抛成 502 空响应，回一个把原因写清楚的 JSON；前端 gwItems() 会原样抛出这句话。 */
        if (!r) {
          return sendJson(res, 502, {
            ok: false, via: 'none',
            error: '取不到 ' + stripHost(want) + '：' + netErr +
              (danJson ? '（danbooru 的接口在当前出口被 Cloudflare 挑战、本机又没有可用的 Chrome，' +
                '三层都拿不到；同一批内容的可达镜像见 tools/stability-round10-gateway.md）' : '')
          });
        }
        /* 图片（封面 / 阅读器页）：允许浏览器缓存 10 分钟。
           这一步对「无 VPN 靠中继取图」很关键 —— 中继会限流，能命中浏览器缓存就少打一次上游。
           非图片仍然 no-store（网页/接口的内容随时会变）。 */
        const isImg = /^image\//i.test(r.type || '') && r.status === 200;
        res.writeHead(r.status, {
          'content-type': r.type,
          'content-length': r.buf.length,
          'access-control-allow-origin': '*',
          'cache-control': isImg ? 'private, max-age=600' : 'no-store'
        });
        return res.end(r.buf);
      }

      default:
        return sendJson(res, 404, { error: '未知接口 ' + pathname });
    }
  } catch (e) {
    log('接口失败', pathname, e && e.message);
    return sendErr(res, e);
  }
});

ensureEgress().then(mode => {
  if (mode === 'reexec') return;                 // 子进程接管
  server.listen(PORT, '127.0.0.1', () => {
    log('hentai搜索 本地网关 v' + GW_VERSION + ' 已启动');
    log('  页面：  http://127.0.0.1:' + PORT + '/');
    log('  接口：  /api/jm/search  /api/copymanga/search  /api/wnacg/search  /api/kemono/search  /api/nhentai/search  /api/ehentai/search  /api/lectormanga/search  /api/pixiv/search  /api/porncomic/search  /api/porncomic/solve  /api/reader  /api/proxy  /api/translate  /api/diag');
    log('  阅读器：/api/reader?source=' + READER_SOURCES.join('|') + '&id=…');
    log('    能用的 ' + READER_WORKING.length + ' 个源：' + READER_WORKING.join(' / '));
    log('    · mangadex / nhentai / wnacg：各 1 次上游请求；wnacg 可能退回逐页兜底' +
      '（mangadex 的 feed 会按 limit=' + MD_FEED_PAGE + '/offset 翻页取全，硬上限 ' +
      MD_MAX_CHAPTERS + ' 话，截断时会在 note 里说明）');
    log('    · danbooru：接口在 Cloudflare 后面（直连必 403），撞上就交给上面的 Chrome 渲染 ' +
      'JSON 查看器再抠回来，结果缓存 ' + Math.round(DB_READER_CACHE_MS / 60000) + ' 分钟；' +
      '过验证时顺手把这次的 cookie + UA 缓存 ' + Math.round(CF_CRED_TTL / 60000) + ' 分钟，' +
      '图片就由 /api/proxy 代取（主地址，用户 IP 不暴露给图床），cdn 直连作备用；' +
      '没有凭证时（从没撞过 CF / 凭证过期 / 刚重启）图片主地址照旧是 cdn 直连');
    log('    · ehentai：逐页 N+1，已限速 ' + EH_THROTTLE_MS + 'ms、单次最多 ' + EH_MAX_PAGES +
      ' 页、结果缓存 ' + Math.round(EH_CACHE_MS / 60000) + ' 分钟');
    log('    · hitomi：图集数据取自 CDN，图片要走 a1/a2.gold-usergeneratedcontent.net（先探通一个子域再整本沿用）');
    log('    · pixiv：/ajax/illust/<id>/pages，**不需要登录 cookie**；图片经 /api/proxy 带 Referer 绕防盗链');
    log('    · copymanga：官方 APP API（comic2 详情 + group/…/chapters 按 offset 翻页取全 + chapter2），' +
      'code 210 会退避重试；各分组（默认/单行本）合并成一个章节列表，硬上限 ' + COPY_MAX_CHAPTERS + ' 章');
    log('    · jmcomic：APP API（/chapter 给页文件名与整条 series + /chapter_view_template 给 scramble_id），' +
      '分章节作品会返回完整 chapters（chapter=<id> 换话），图片是分块打乱的，' +
      '前端按站点自己的算法用 canvas 还原（块数 = md5(aid+page) 末位 ASCII 决定）');
    log('    · porncomic：条目页 /h/<id>.html 整站前置 CF（走下面的 Chrome 通道），正文图在 ' +
      'file*.acgnngca.com 不经 CF；从第 1 页 HTML 读出图片编号与总页数后按 `<媒体id>_<n>` 拼出整本');
    if (READER_UNAVAILABLE.length) {
      log('    · ' + READER_UNAVAILABLE.join(' / ') + '：**明确不支持**，/api/reader 会回 ok:false + 中文原因' +
        '（详见 tools/gateway.js 里各自的取证记录）');
    }
    log('    · 下面是「网关代搜」的源（/api/ping 的 sources 字段），与阅读器白名单是两回事');
    log('    · E-Hentai 搜索：当前出口 IP 下上游搜索一律返回空集，网关会如实说明并退到' +
      ' /torrents.php?search= 兜底（详见 tools/gateway.js 里 ehentaiSearch 的取证记录）' +
      (state.ehCookie ? '；已配置 E-Hentai cookie' : '；未配置 E-Hentai cookie（不需要，也救不了空搜索）'));
    log('  出口：  ' + egressText());
    log('    · 出口**不再粘死**：启动时探测到的代理只是「原路」，运行期每 60 秒重判一次；' +
      '代理挂了自动改走直连，代理在网关上之后再开也会被认出来（每次请求失败时都会重判）');
    log('    · 直连强化：DoH 多解析器并取（' + DOH_SERVERS.map(s => s.id).join('/') + '）→ 带 SNI 逐个验真 →' +
      ' 钉住可用 IP。专治纯 DNS 污染（实测：紳士漫畫 / hitomi 的假 IP 与真 IP 并存，' +
      '阿里 DNS 给假的、腾讯 DoH 给真的）');
    log('    · 中继兜底：' + RELAYS.map(r => r.id).join(' / ') +
      '（境内实测直连可达；真被墙的站靠它把 JSON / 图片带回来，限流时冷却 ' +
      Math.round(RELAY_COOLDOWN / 1000) + 's）。' +
      'cors.eu.org 是 2026-09-23 新加的第一条腿：e-hentai 首页 268ms / 图集页 233ms / ' +
      '大图 691ms（sha b313a632ad6f，与历史取证逐字节一致），**不需要代理**；' +
      '但它对 pixiv 一律回 403（Cloudflare WAF block_waf，pixiv 按机房 IP 封的，换中继无解）。' +
      'wsrv.nl 实测屏蔽成人域名、corsproxy.io 要 key，都没采用');
    if (PRIVATE_RELAY.length) {
      log('    · 自建中继（★优先于上面全部公共中继）：' +
        PRIVATE_RELAY.map(r => r.id + ' → ' + r.base).join(' / ') +
        '；带 cookie / 签名头的请求（pixiv R-18）**只走它**，公共中继拿不到你的凭据');
    } else {
      log('    · 自建中继：**未配置**。e-hentai / pixiv 在当前出口上仍无通路 —— ' +
        '公共中继在本机出口实测全灭（15 条候选 × 2 目标 = 0 成功，见 tools/relay-deploy.md）；' +
        '按那份文档部署一个（Cloudflare Pages 最省事），把地址写进 tools/relay.txt 即可。');
    }
    {
      const why = cfUnavailableReason();
      const where = '过 Cloudflare（porn-comic，以及 danbooru 的接口与被代理的图片）';
      if (why) {
        log('  CF 求解：不可用 —— ' + why);
      } else if (cfState.renders > 0) {
        log('  CF 求解：**已真实验证**，用 ' + cfChromePath() +
          (String(process.env.HS_CF_HEADFUL || '') === '1' ? '（有头模式）' : '（headless）') +
          where + '，本进程成功过 ' + cfState.renders + ' 次');
      } else {
        /* 不为了这句日志去起一次 Chrome（用户明确不要拖慢启动）：只如实说「还没验证过」。
           真失败过的话把 lastError 也带出来 —— 只有这一条才反映「实际能不能用」。 */
        log('  CF 求解：可执行文件在（' + cfChromePath() +
          (String(process.env.HS_CF_HEADFUL || '') === '1' ? '，有头模式' : '，headless') +
          '）—— **本进程还没真验证过**，只查了文件在不在' +
          (cfLastErr ? '；最近一次失败：' + cfLastErr : '') +
          '。沙箱/受限环境里 Chrome 常因命名管道被禁而起不来，真要用到才知道行不行：' +
          '结果会如实出现在 /api/ping 的 cfSolver.verified / failing / lastError 里');
      }
    }
    log('  静态根：' + ROOT);
  });
  server.on('error', e => { log('启动失败：' + e.message); process.exit(1); });
});
