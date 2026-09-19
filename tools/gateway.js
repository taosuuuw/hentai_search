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
const path = require('path');
const crypto = require('crypto');

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
const GW_VERSION = '1.0.0';

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

/* ------------------------------ HTTP 服务 ------------------------------ */
const MIME = {
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
          sources: ['jm', 'picacg', 'copymanga', 'proxy'],
          picacgLoggedIn: !!state.picacgToken,
          jmHost: state.jmHost || '', copyApi: state.copyApi || ''
        });

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

server.listen(PORT, '127.0.0.1', () => {
  log('EroMeta 本地网关 v' + GW_VERSION + ' 已启动');
  log('  页面：  http://127.0.0.1:' + PORT + '/');
  log('  接口：  /api/jm/search  /api/picacg/search  /api/copymanga/search  /api/proxy');
  log('  静态根：' + ROOT);
  if (ROOT.indexOf('tools') === 0) log('  ⚠ 没找到项目根目录，用 --root <路径> 指定');
});
server.on('error', e => { log('启动失败：' + e.message); process.exit(1); });
