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
const GW_VERSION = '1.1.0';

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

/** 统一的出站请求（Node 18+ 自带 fetch / undici） */
async function outFetch(url, opts) {
  opts = opts || {};
  const ms = opts.timeout || 15000;
  const tk = withTimeout(ms);
  try {
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: Object.assign({ 'user-agent': opts.ua || UA_CHROME, accept: '*/*' }, opts.headers || {}),
      body: opts.body,
      redirect: 'follow',
      signal: tk.signal
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      ok: res.ok,
      headers: res.headers,
      buf,
      text: () => buf.toString('utf8'),
      json: () => JSON.parse(buf.toString('utf8'))
    };
  } finally { tk.done(); }
}

const stripHost = u => String(u || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();

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
  if (state.jmHost && Date.now() - state.jmHostAt < 10 * 6000e3) push(state.jmHost);
  String(extra || '').split(/[\s,;，、]+/).forEach(push);
  try { (await jmRemoteHosts()).forEach(push); } catch (e) { /* 用兜底 */ }
  JM_FALLBACK_HOSTS.forEach(push);
  return list;
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

/** 找一个能用的禁漫 APP 域名 */
async function jmResolveHost(extra) {
  const hosts = await jmHostsList(extra);
  const errs = [];
  for (const host of hosts.slice(0, 6)) {
    try {
      const data = await jmApi(host, '/setting?app_img_shunt=1&express=', { timeout: 6000 });
      const img = data && (data.img_host || (data.setting && data.setting.img_host));
      if (img) { state.jmCdn = String(img).replace(/\/+$/, ''); state.jmCdnAt = Date.now(); }
      state.jmHost = host; state.jmHostAt = Date.now();
      return host;
    } catch (e) { errs.push(host + '：' + e.message); }
  }
  const err = new Error('禁漫全部候选域名都不可用：' + errs.slice(0, 4).join('；'));
  err.all = errs;
  throw err;
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
  const host = await jmResolveHost(query.hosts);
  const apiPath = '/search?search_query=' + encodeURIComponent(q).replace(/%20/g, '+') +
    '&page=' + page + '&o=' + o;
  const data = await jmApi(host, apiPath);
  if (query.raw) return data;
  const rows = asArray(data && (data.search || data.list || data.content || data));
  const items = rows.filter(x => x && typeof x === 'object')
    .map(x => jmNormalizeItem(x, host, query.web))
    .filter(x => x.id && x.title);
  return { source: 'jmcomic', host: host, total: (data && data.total) || items.length, items: items };
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

async function copyApiBase() {
  if (state.copyApi && Date.now() - state.copyApiAt < 3600e3) return state.copyApi;
  try {
    const r = await outFetch('https://api.copy-manga.com/api/v3/system/network2?platform=3', { timeout: 7000 });
    const j = r.json();
    const api = j && j.results && j.results.api;
    if (Array.isArray(api) && api[0] && api[0][0]) {
      state.copyApi = stripHost(api[0][0]); state.copyApiAt = Date.now();
      return state.copyApi;
    }
  } catch (e) { /* 用默认 */ }
  state.copyApi = 'api.copy2000.online'; state.copyApiAt = Date.now();
  return state.copyApi;
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

async function copymangaSearch(query) {
  const q = String(query.q || '').trim();
  const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
  const limit = Math.min(60, Math.max(10, parseInt(query.limit || '30', 10) || 30));
  if (!q) throw new Error('缺少关键词 q');

  /* 节点会换：把已知节点、动态发现到的节点、以及内置兜底全部依次试一遍 */
  const bases = [];
  const pushBase = b => { b = stripHost(b); if (b && bases.indexOf(b) < 0) bases.push(b); };
  if (state.copyApi) pushBase(state.copyApi);
  pushBase(await copyApiBase());
  ['api.copy2000.online', 'api.mangacopy.com', 'api.copy-manga.com'].forEach(pushBase);

  const apiPath = '/api/v3/search/comic?limit=' + limit + '&offset=' + ((page - 1) * limit) +
    '&q=' + encodeURIComponent(q) + '&q_type=&platform=3';
  const errs = [];
  for (const base of bases) {
    try {
      const r = await outFetch('https://' + base + apiPath, { headers: copyHeaders(), timeout: 12000 });
      const j = r.json();
      if (query.raw) return j;
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
      if (!items.length) throw new Error('返回 0 条');
      state.copyApi = base; state.copyApiAt = Date.now();
      log('拷贝漫画节点可用：' + base + '（' + items.length + ' 条）');
      return { source: 'copymanga', host: base, total: res.total || items.length, items: items };
    } catch (e) {
      errs.push(base + '：' + ((e && e.message) || e));
    }
  }
  state.copyApi = '';
  throw new Error('拷贝漫画所有 API 节点都失败：' + errs.slice(0, 3).join('；'));
}

/* ==========================================================================
   通用代理：让浏览器能取到「不返回跨域头」的网页（wnacg / hitomi / 漫画柜 …）
   取不到的域名进冷却，避免一次检索里被反复重试
   ========================================================================== */
const deadHosts = new Map();          // host -> 冷却截止时间戳
const DEAD_MS = 45000;

async function proxyFetch(url, referer) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('url 必须是 http(s)');
  const u = new URL(url);
  const until = deadHosts.get(u.host) || 0;
  if (until > Date.now()) {
    throw new Error(u.host + ' 近期取源失败，已临时跳过（' + Math.ceil((until - Date.now()) / 1000) + 's 后可重试）');
  }
  const headers = { 'user-agent': UA_CHROME, accept: 'text/html,application/xhtml+xml,*/*' };
  headers.referer = referer || (u.origin + '/');
  try {
    const r = await outFetch(url, { headers: headers, timeout: 12000 });
    deadHosts.delete(u.host);
    return { status: r.status, buf: r.buf, type: r.headers.get('content-type') || 'text/html; charset=utf-8' };
  } catch (e) {
    deadHosts.set(u.host, Date.now() + DEAD_MS);
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

async function nhentaiSearch(query) {
  const q = String(query.q || '').trim();
  if (!q) throw new Error('缺少关键词 q');
  const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
  const sort = String(query.sort || '').toLowerCase();
  let url = NH_HOST + '/api/v2/search?query=' + encodeURIComponent(q) + '&page=' + page;
  if (sort === 'date' || sort === 'popular') url += '&sort=' + sort;

  let r;
  try {
    r = await outFetch(url, {
      timeout: 20000,
      headers: { accept: 'application/json', referer: NH_HOST + '/' }
    });
  } catch (e) {
    throw new Error('连不上 nhentai：' + ((e && e.message) || e) +
      '（本机直连会被重置，需要出口代理；网关启动时会自动探测本地代理端口）');
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
async function pixivSearch(query) {
  const q = String(query.q || '').trim();
  if (!q) throw new Error('缺少关键词 q');
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
    const r = await outFetch(api, { headers: headers, timeout: 15000 });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    body = r.json();
  } catch (e) {
    throw new Error('Pixiv 请求失败：' + ((e && e.message) || e));
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
const cfCache = new Map();           /* url -> { html, at } */
let cfCooldownUntil = 0;
let cfLastErr = '';
const CF_CHALLENGE_RE = /just a moment|请稍候|attention required|checking your (browser|connection)|verifying you are human|正在验证|人机验证|cf-chl|_cf_chl_/i;

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
  return { title: t, href: location.href, dom: !!el, body: document.body ? document.body.innerHTML.length : 0 };
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
  timer: null, solvedAt: 0, renders: 0
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

/** 一次性闯关：起一个全新的 Chrome（全新 profile）→ 过验证 → 取 HTML → 关掉。
 *  为什么要「一次性」：实测这个站只在浏览器刚起来的那一次验证上放行，
 *  同一个 Chrome 里连着闯第二次就会被 CF 卡死在「Just a moment…」；
 *  换新浏览器（含新 profile）则次次都过。所以这里不省这点启动开销。
 *  失败不重试，直接进冷却 —— 连着重试只会把出口 IP 的名声烧得更差。 */
async function cfRender(url, opt) {
  opt = opt || {};
  const timeout = opt.timeout || 40000;
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
    await cfLaunch();                       /* 每次都用「刚起来的」浏览器 */
    const page = await cfOpenPage();
    let last = null;
    try {
      await cdpSend('Page.navigate', { url: url }, page.sid);
      const deadline = Date.now() + timeout;
      let seenTitle = '';
      while (Date.now() < deadline) {
        await sleep(600);
        const st = await cfEval(CF_PROBE_JS, page.sid);
        if (!st || typeof st !== 'object') continue;
        last = st;
        if (st.title !== seenTitle) {
          seenTitle = st.title;
          log('  CF[' + url.replace(/^https:\/\/[^/]+/, '') + '] ' + Math.round((Date.now() - (deadline - timeout)) / 1000) + 's 标题="' + String(st.title).slice(0, 60) + '" len=' + st.body + ' dom=' + st.dom);
        }
        if (/^chrome-error:/i.test(String(st.href))) throw new Error('Chrome 打不开这个地址（' + st.href + '）');
        if (!st.dom && !CF_CHALLENGE_RE.test(String(st.title)) && st.body > 500) {
          await sleep(900);                       /* 等首屏列表补完 */
          const html = await cfEval('document.documentElement.outerHTML', page.sid);
          if (html) {
            cfState.renders++; cfState.solvedAt = Date.now();
            cfCacheSet(url, String(html));
            return String(html);
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
  return p.then(html => html, e => {
    cfCooldownUntil = Date.now() + CF_FAIL_COOLDOWN;
    cfLastErr = (e && e.message) || String(e);
    log('CF 验证失败，' + Math.round(CF_FAIL_COOLDOWN / 1000) + ' 秒内不再硬闯：' + cfLastErr);
    throw e;
  });
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

/* 一旦被 CF 挡过，后续请求直接走 Chrome，不再白等一次普通请求 */
let pcNeedsRender = false;

/* 判断是不是 CF 的验证中间页。
   注意：正常页面里也会引用 cdn-cgi/challenge-platform 的脚本，所以绝不能只看这个字符串 ——
   先认列表特征（a.thumb / 作品链接），有列表就一定是真页面。 */
function pcIsChallenge(html) {
  const s = String(html || '');
  if (/class="[^"]*\bthumb\b/.test(s)) return false;
  if (/href="\/(h|hentai|gif)\/\d+\.html"/.test(s)) return false;
  if (/<title>\s*(just a moment|请稍候|attention required)/i.test(s)) return true;
  if (/id="(challenge-running|challenge-stage|cf-chl)/i.test(s)) return true;
  if (/cf-mitigated/i.test(s)) return true;
  return false;
}

/** 取一页：先普通请求，被 CF 挡住就交给本机 Chrome 过验证 */
async function pcFetchPage(pathname) {
  if (!pcNeedsRender) {
    try {
      const r = await outFetch(PC_BASE + pathname, { headers: PC_HEADERS, timeout: 15000 });
      const html = r.text();
      if (!pcIsChallenge(html)) return { html: html, status: r.status, via: 'http' };
      pcNeedsRender = true;
      log('porn-comic 被 Cloudflare 挡住，切换到本机 Chrome 过验证');
    } catch (e) {
      if (cfUnavailableReason()) throw e;      /* 没浏览器可用就别切了，直接报原错 */
      pcNeedsRender = true;
    }
  }
  /* Chrome 通道已经确认过标题和正文，这里直接信它 */
  const html = await cfRender(PC_BASE + pathname);
  return { html: html, status: 200, via: 'chrome' };
}

async function porncomicSearch(query) {
  const q = String(query.q || '').trim();
  const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
  const extra = String(query.extra || '').trim();
  const tries = [];
  if (q) tries.push('/q/' + encodeURIComponent(q) + '-' + page + '.html');
  if (q && pcSlug(q)) tries.push('/tags/' + pcSlug(q) + '.html');
  if (extra) tries.push('/tags/' + pcSlug(extra) + '.html');
  if (!tries.length) tries.push(page > 1 ? '/index-' + page + '.html' : '/h/');

  const errs = [];
  for (const p of tries) {
    try {
      const r = await pcFetchPage(p);
      if (r.status >= 400) { errs.push(p + '：HTTP ' + r.status); continue; }
      const items = pcParse(r.html, 'porn-comic.com', 60);
      if (!items.length) {
        const why = cfUnavailableReason();
        errs.push(p + '：' + (pcIsChallenge(r.html)
          ? ('被 Cloudflare 人机验证挡住' + (why ? '（' + why + '）' : '，Chrome 通道也没过'))
          : '页面结构没有匹配到作品'));
        continue;
      }
      return {
        source: 'porncomic', host: 'porn-comic.com', total: items.length,
        items: items.slice(0, 60), via: r.via
      };
    } catch (e) { errs.push(p + '：' + ((e && e.message) || e)); }
  }
  throw new Error('porn-comic 没有取到结果：' + errs.slice(0, 3).join('；'));
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
  porncomic: 'https://porn-comic.com/'
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
  'copymanga', 'jmcomic', 'porncomic'];
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

/** 带 Referer 取上游 JSON；非 2xx 抛中文错误 */
async function readerJson(url, referer, what, timeout) {
  let r;
  try {
    r = await outFetch(url, {
      timeout: timeout || 15000,
      headers: { accept: 'application/json', referer: referer }
    });
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

/** 章节显示名：第 N 话 · 标题（语言） */
function mdChapterName(num, title, lang) {
  const n = (num == null || num === '') ? '' : String(num);
  return (n ? '第 ' + n + ' 话' : '无编号章节') +
    (title ? ' · ' + String(title) : '') +
    (lang ? '（' + String(lang) + '）' : '');
}

/** feed → 可读章节清单。只过滤、不重排（顺序仍是上游返回顺序）：
    · attributes.externalUrl 非空 = 这一话只在原站/外链看，网关托不到图
    · attributes.pages === 0    = 上游自己也没托管页 */
function mdReadableChapters(feed) {
  return asArray(feed && feed.data).filter(c => {
    const a = (c && c.attributes) || {};
    return !a.externalUrl && Number(a.pages || 0) > 0;
  }).map(c => {
    const a = c.attributes || {};
    return { id: String(c.id), name: mdChapterName(a.chapter, a.title, a.translatedLanguage) };
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

  /* limit 用 500（上游允许的上限）：164eff7a 这种就有 28 话，旧代码的 100 迟早会截断。
     关键补的是 contentRating[] 四档 —— 少了 pornographic 的 feed 一律返回 0 话。 */
  const feedUrl = 'https://api.mangadex.org/manga/' + encodeURIComponent(id) +
    '/feed?limit=500&order[chapter]=asc' + MD_READER_RATING_QS;
  /* 主路 = 带语言偏好（跟旧行为一致）。它**不是**致命的：语言码被上游拒（实测 zh-hans
     会让整条 feed 判 400 validation_exception）或这一轮恰好取空，都继续往下走。 */
  let list = [];
  let firstErr = null;
  try {
    list = mdReadableChapters(await readerJson(feedUrl + MD_READER_LANG_QS, referer, 'MangaDex', 20000));
  } catch (e) { firstErr = e; }
  /* 只有非 zh/en 版本的作品（实测 aff8827b=pl、c46f5f9f=it、91689e5b=id）→ 放开语言再拿一轮 */
  if (!list.length) {
    try {
      list = mdReadableChapters(await readerJson(feedUrl, referer, 'MangaDex', 20000));
      firstErr = null;
    } catch (e) {
      /* 两轮都失败 = 上游真连不上 / 被挡（不是「没有章节」）→ 抛第一轮的中文错误，
         绝不能悄悄退成「这本没有可读的图」 */
      throw (firstErr || e);
    }
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
  }
  return out;
}

/* nhentai 的 pages[].path 末位字符标了格式：j/p/g/w = jpg/png/gif/webp */
const NH_EXT = { j: 'jpg', p: 'png', g: 'gif', w: 'webp' };

async function readerNhentai(id) {
  const referer = READER_HOSTS.nhentai;
  const g = await readerJson('https://nhentai.net/api/v2/galleries/' + encodeURIComponent(id),
    referer, 'nhentai', 20000);
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
  return { title: String(title), referer: referer, chapters: [], pages: pages };
}

async function readerDanbooru(id) {
  const referer = READER_HOSTS.danbooru;
  const p = await readerJson('https://danbooru.donmai.us/posts/' + encodeURIComponent(id) + '.json',
    referer, 'Danbooru', 15000);
  const file = (p && (p.file_url || p.large_file_url || p.preview_file_url)) || '';
  if (!file) {
    throw new Error('Danbooru 这个条目没有图片地址（可能是视频或已删除，也可能被设为私有）');
  }
  const at = file.lastIndexOf('.');
  const title = 'Danbooru #' + id + (at > 0 ? ' · ' + file.slice(at + 1).toLowerCase() : '');
  /* 单图、单章；多图 pool 本阶段不做 */
  return {
    title: title,
    referer: referer,
    chapters: [],
    pages: [readerPage(file, referer, (p && p.image_width) || 0, (p && p.image_height) || 0)]
  };
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
const WN_READER_HOSTS = [
  'www.wnacg.com', 'www.wnacg01.cc', 'www.wnacg02.cc', 'www.wnacg03.cc', 'www.wnacg05.cc',
  'www.wn03.ru', 'www.wn04.ru', 'wnacg.com', 'wnacg.ru'
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
    return 'E-Hentai 封了当前出口 IP（原话：Your IP address has been temporarily banned）—— 换一个出口代理再试';
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
    cookie、继续走同一套限速与缓存（少一个变量，既有行为原样保留）。 */
async function ehHtml(url, what, timeout, cookie) {
  const h = { accept: 'text/html,application/xhtml+xml,*/*', referer: EH_REFERER };
  const ck = String(cookie == null ? '' : cookie).trim();
  if (ck) h.cookie = ck;
  const r = await ehSerial(async () => {
    try {
      return await outFetch(url, { timeout: timeout || 20000, headers: h });
    } catch (e) {
      throw new Error('连不上 ' + what + '：' + ((e && e.message) || e));
    }
  });
  const body = r.buf.toString('utf8');
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
const EH_SEARCH_CACHE_MS = 60e3;   /* 同一关键词 60 秒内不重复打上游 */
function ehSearchCacheGet(key) {
  if (state.ehLastSearch && state.ehLastSearch.key === key &&
    Date.now() - state.ehLastSearchAt < EH_SEARCH_CACHE_MS) return state.ehLastSearch.val;
  return null;
}
function ehSearchCacheSet(key, val) { state.ehLastSearch = { key: key, val: val }; state.ehLastSearchAt = Date.now(); }

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

/** 把一个「搜索为 0 条」的事实讲成用户能照做的中文 */
function ehZeroReason(withCookie) {
  return 'E-Hentai 的搜索接口在**当前出口 IP** 下返回空集（实测：本机出口 54.255.249.22 / AWS 新加坡，' +
    '用本机 Chrome 打开同一个搜索 URL 也显示 No hits found；首页 /popular /toplist /torrents.php 与 api.php 全部正常）。' +
    '原因在 E-Hentai 服务端的搜索侧限制，不在请求参数或请求头——' +
    (withCookie ? '本次已带上你配置的 cookie，仍然 0 条；' : '带上登录 cookie 也一样（cookie 与出口 IP 是两回事）；') +
    '要恢复真正的搜索，需要换一个住宅/非机房的出口 IP（例如把系统代理切到另一个节点后重启网关）。';
}

async function ehentaiSearch(query) {
  const q = String(query.q || '').trim();
  const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
  const limit = Math.min(80, Math.max(1, parseInt(query.limit || '60', 10) || 60));
  const cookie = String(query.cookie || state.ehCookie || '').trim();
  const withCookie = !!cookie;

  const terms = String(query.terms || '').trim() || q;
  const cKey = terms + '|' + page + '|' + limit + '|' + (withCookie ? 'ck' : '');
  const hit = ehSearchCacheGet(cKey);
  if (hit) return Object.assign({}, hit, { cached: true });

  /* 1) 关键词为空：直接给「非搜索入口」的真实结果（/popular 实测 64 条） */
  if (!terms) {
    const html = await ehHtml(EH_HOST + '/popular', 'E-Hentai 流行榜', 20000);
    const items = ehSearchRows(html, limit);
    const out = {
      ok: true, source: 'ehentai', via: 'popular', page: 1, total: items.length, items: items,
      note: '没有给关键词，返回的是 E-Hentai 的 /popular（流行榜）。E-Hentai 的搜索侧在当前出口 IP 下' +
        '一律 0 条（取证记录见 tools/gateway.js 里 ehentaiSearch 的注释）。'
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

  let searchErr = '';
  let html = '';
  try {
    html = await ehHtml(searchUrl, 'E-Hentai 搜索', 25000, cookie);
  } catch (e) {
    searchErr = (e && e.message) || String(e);
    throw new Error('E-Hentai 搜索失败：' + searchErr);
  }
  const zero = /No hits found/i.test(html);
  const items = zero ? [] : ehSearchRows(html, limit);
  if (items.length) {
    const out = {
      ok: true, source: 'ehentai', via: 'search', page: page, total: items.length, items: items,
      note: 'E-Hentai 搜索（经网关，带完整请求头' + (withCookie ? ' + 你的 cookie' : '') + '）'
    };
    ehSearchCacheSet(cKey, out);
    return out;
  }

  /* 3) 搜索为 0 条 → 真实可用的兜底：/torrents.php?search=<词>（实测按词过滤） */
  let torrents = [];
  try {
    const th = await ehHtml(EH_HOST + '/torrents.php?search=' + encodeURIComponent(terms), 'E-Hentai 种子检索', 25000);
    torrents = ehTorrentRows(th, limit);
  } catch (e) { /* 兜底也拿不到就只报原事实 */ }

  const out = {
    ok: true, source: 'ehentai', via: torrents.length ? 'torrents' : 'search',
    page: page, total: torrents.length, items: torrents,
    /* 前端见到 searchZero 会把它当「搜索本身是空的」讲清楚，而不是「没搜到」 */
    searchZero: true,
    note: ehZeroReason(withCookie) +
      (torrents.length
        ? '下面这 ' + torrents.length + ' 条来自可用的兜底入口 /torrents.php?search=' + terms +
          '（同一个出口实测能按词过滤，每条都带 gid+token），**不是** E-Hentai 的搜索结果本身；' +
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

  /* 分组：详情的 groups 键优先，退 'default' */
  const groups = [];
  const g = det.groups;
  if (g && typeof g === 'object') {
    Object.keys(g).forEach(k => {
      const v = g[k];
      const key = (v && typeof v === 'object' && (v.path_word || v.name)) ? (v.path_word || v.name) : k;
      if (key && groups.indexOf(key) < 0) groups.push(String(key));
    });
  }
  if (groups.indexOf('default') < 0) groups.push('default');

  /* 章节列表：逐个分组试，拿到就用 */
  let list = [], chapErr = '';
  for (const grp of groups) {
    try {
      const j = await copyReaderJson(base, '/api/v3/comic/' + encodeURIComponent(pw) + '/group/' +
        encodeURIComponent(grp) + '/chapters?limit=100&offset=0&in_mainland=true&request_id=',
        '拷贝漫画章节列表');
      const rows = asArray(j && j.results && j.results.list);
      if (rows.length) {
        list = rows.map(c => ({
          id: String(c.uuid || ''),
          name: String(c.name || '').trim() || ('第 ' + ((parseInt(c.index, 10) || 0) + 1) + ' 话')
        })).filter(c => c.id);
        if (list.length) break;
      }
      chapErr = '分组 ' + grp + ' 返回 0 章';
    } catch (e) { chapErr = (e && e.message) || e; }
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
    '章节接口用 in_mainland/request_id 口径、图片接口是 chapter2，页顺序按 words 还原）。';
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

async function readerJmcomic(id) {
  const m = String(id || '').match(/(\d{3,})/);
  const album = m ? m[1] : '';
  if (!album) throw new Error('禁漫的 id 需要是作品数字 id（形如 1474541 或 /album/1474541），收到的是「' + String(id || '') + '」');
  const host = await jmResolveHost();                       /* 顺便把 state.jmCdn 设成 /setting 的 img_host */
  const data = await jmApi(host, '/chapter?id=' + encodeURIComponent(album));
  const files = asArray(data && data.images).map(String).filter(Boolean);
  if (!files.length) throw new Error('禁漫这一话没有返回任何图片文件名（接口可能改版了）');
  const title = String((data && (data.name || data.title)) || ('禁漫 #' + album)).replace(/\s+/g, ' ').trim();

  /* scramble_id 与图片域名都在章节页模板里；这一步**不需要过 Cloudflare**（APP 接口域名上就有） */
  let tmpl = { scramble: 0, imghost: '', jmid: album }, tmplStatus = 0, tmplErr = '';
  try {
    const r = await jmFetchTemplate(host, album);
    tmplStatus = r.status;
    tmpl = jmTemplateInfo(r.text().slice(0, JM_TEMPLATE_MAX));
  } catch (e) { tmplErr = (e && e.message) || String(e); }
  if (!(tmpl.scramble > 0)) {
    throw new Error(JM_READER_UNAVAILABLE + '（模板 HTTP ' + (tmplStatus || '失败') +
      (tmplErr ? '，' + tmplErr : '') + '；域名 ' + host + '）');
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
      const r = await outFetch(c + '/media/photos/' + album + '/' + encodeURIComponent(files[0]), { timeout: 9000 });
      if (r.status === 200 && /^image\//i.test(r.headers.get('content-type') || '')) { base = c; break; }
      lastErr = c + ' → HTTP ' + r.status + ' ' + (r.headers.get('content-type') || '');
    } catch (e) { lastErr = c + ' → ' + ((e && e.message) || e); }
  }
  if (!base) throw new Error('禁漫的图片 CDN 这次都取不到（' + cands.join(' / ') + '）' +
    (lastErr ? '，最后一次：' + lastErr : '') + ' —— 换个出口代理再试，或上游确实挂了');

  const scrambled = parseInt(album, 10) >= tmpl.scramble;
  const pages = files.map(f => {
    const p = readerPage(base + '/media/photos/' + album + '/' + f, READER_HOSTS.jmcomic, 0, 0);
    if (scrambled) {
      p.scramble = tmpl.scramble;
      p.bands = jmScrambleBands(album, String(f).replace(/\.[a-z0-9]+$/i, ''));
    }
    return p;
  });
  return {
    title: title,
    referer: READER_HOSTS.jmcomic,
    chapters: [],
    pages: pages,
    note: '禁漫官方 APP API（' + host + '）：/chapter 给页文件名，/chapter_view_template 给 ' +
      'scramble_id=' + tmpl.scramble + '（模板里的 imghost=' + (tmpl.imghost || base) + '）。' +
      (scrambled
        ? '这本 aid ' + album + ' ≥ scramble_id，图片是**分块打乱**的：前端按站点自己的算法' +
          '（块数 = md5(aid+page) 末位 ASCII 决定 → 分块上下颠倒）用 canvas 还原后才显示。'
        : '这本 aid ' + album + ' < scramble_id，站点自己的算法判定**不打乱**，原图直接显示。')
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
  else if (source === 'jmcomic') out = await readerJmcomic(id);
  else if (source === 'porncomic') out = await readerPorncomic(id);
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
          sources: ['jm', 'picacg', 'copymanga', 'kemono', 'porncomic', 'pixiv', 'nhentai', 'proxy'],
          egress: process.env.HS_GW_PROXIED === '1'
            ? ('经本地代理 ' + (process.env.HTTPS_PROXY || ''))
            : '直连（未检测到可用本地代理）',
          picacgLoggedIn: !!state.picacgToken,
          jmHost: state.jmHost || '', copyApi: state.copyApi || '',
          cfSolver: {
            available: !cfUnavailableReason(),
            reason: cfUnavailableReason(),
            browser: cfChromePath(),
            headful: String(process.env.HS_CF_HEADFUL || '') === '1',
            running: !!(cfState.ws && cfState.proc),
            renders: cfState.renders,
            cacheSize: cfCache.size,
            cooldownSec: Math.ceil(cfCooldownLeft() / 1000),
            lastError: cfLastErr
          }
        });

      case '/api/diag': {
        /* 出口自检：网关现在到底能打到哪些站（决定哪些源能用）
           键名与前端的信息源 id 对齐，页面可以直接拿它修正「站点不可达」的误判 */
        const jmHost = state.jmHost || JM_FALLBACK_HOSTS[0];
        const urls = {
          nhentai: 'https://nhentai.net/api/v2/search?query=test',
          ehentai: 'https://e-hentai.org/',
          wnacg: 'https://www.wnacg.com/',
          hitomi: 'https://hitomi.la/',
          kemono: 'https://kemono.cr/',
          mangadex: 'https://api.mangadex.org/ping',
          jmcomic: 'https://' + jmHost + '/'
        };
        const out = {};
        await Promise.all(Object.keys(urls).map(async k => {
          const t0 = Date.now();
          try {
            const r = await outFetch(urls[k], { timeout: 9000 });
            out[k] = { ok: r.status < 500, status: r.status, ms: Date.now() - t0 };
          } catch (e) { out[k] = { ok: false, error: (e && e.message) || String(e), ms: Date.now() - t0 }; }
        }));
        return sendJson(res, 200, { egress: process.env.HS_GW_PROXIED === '1' ? (process.env.HTTPS_PROXY || '') : '', targets: out });
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
        return sendJson(res, 200, await kemonoSearch(q));

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

      case '/api/porncomic/search':
        return sendJson(res, 200, await porncomicSearch(q));

      case '/api/pixiv/search':
        return sendJson(res, 200, await pixivSearch(q));

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
        return sendJson(res, 200, await jmSearch(q));

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

      case '/api/copymanga/search':
        return sendJson(res, 200, await copymangaSearch(q));

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

      case '/api/proxy': {
        const r = await proxyFetch(q.url, q.referer);
        res.writeHead(r.status, {
          'content-type': r.type,
          'content-length': r.buf.length,
          'access-control-allow-origin': '*',
          'cache-control': 'no-store'
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
    log('  接口：  /api/jm/search  /api/copymanga/search  /api/kemono/search  /api/nhentai/search  /api/ehentai/search  /api/pixiv/search  /api/porncomic/search  /api/porncomic/solve  /api/reader  /api/proxy  /api/diag');
    log('  阅读器：/api/reader?source=' + READER_SOURCES.join('|') + '&id=…');
    log('    能用的 ' + READER_WORKING.length + ' 个源：' + READER_WORKING.join(' / '));
    log('    · mangadex / nhentai / danbooru / wnacg：各 1 次上游请求；wnacg 可能退回逐页兜底');
    log('    · ehentai：逐页 N+1，已限速 ' + EH_THROTTLE_MS + 'ms、单次最多 ' + EH_MAX_PAGES +
      ' 页、结果缓存 ' + Math.round(EH_CACHE_MS / 60000) + ' 分钟');
    log('    · hitomi：图集数据取自 CDN，图片要走 a1/a2.gold-usergeneratedcontent.net（先探通一个子域再整本沿用）');
    log('    · pixiv：/ajax/illust/<id>/pages，**不需要登录 cookie**；图片经 /api/proxy 带 Referer 绕防盗链');
    log('    · copymanga：官方 APP API（comic2 详情 + group/…/chapters + chapter2），code 210 会退避重试');
    log('    · jmcomic：APP API（/chapter 给页文件名 + /chapter_view_template 给 scramble_id），' +
      '图片是分块打乱的，前端按站点自己的算法用 canvas 还原（块数 = md5(aid+page) 末位 ASCII 决定）');
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
    log('  出口：  ' + (process.env.HS_GW_PROXIED === '1'
      ? ('经本地代理 ' + (process.env.HTTPS_PROXY || '') + '（被墙的站点因此可用）')
      : '直连（可用 --proxy http://127.0.0.1:7897 指定，或先设 HTTPS_PROXY）'));
    {
      const why = cfUnavailableReason();
      log('  CF 求解：' + (why ? ('不可用 —— ' + why) : ('可用，用 ' + cfChromePath() +
        (String(process.env.HS_CF_HEADFUL || '') === '1' ? '（有头模式）' : '（headless）') + ' 过 Cloudflare（porn-comic）')));
    }
    log('  静态根：' + ROOT);
  });
  server.on('error', e => { log('启动失败：' + e.message); process.exit(1); });
});
