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
  copyApiAt: 0
};

const log = (...a) => console.log('[gateway]', ...a);

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
          sources: ['jm', 'picacg', 'copymanga', 'kemono', 'porncomic', 'pixiv', 'proxy'],
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

      case '/api/kemono/search':
        return sendJson(res, 200, await kemonoSearch(q));

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
    log('  接口：  /api/jm/search  /api/copymanga/search  /api/kemono/search  /api/pixiv/search  /api/porncomic/search  /api/porncomic/solve  /api/proxy  /api/diag');
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
