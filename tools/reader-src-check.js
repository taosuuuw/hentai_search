#!/usr/bin/env node
/* ============================================================================
   tools/reader-src-check.js —— 在线阅读「逐源体检」harness（零依赖，只用 http/https）

   为什么存在：
     前端阅读器（assets/js/reader.js）不直接连上游，它拿的是网关 /api/reader 给的
     「已经包好的同源相对地址」/api/proxy?url=…&referer=…；浏览器再向网关要这些地址。
     所以「某来源在线阅读能不能用」是**两段**都要成立：
       ① /api/reader 能不能给出 pages[]（网关能不能抓到上游的图集/章节元数据）
       ② /api/proxy  能不能真的把那张图的字节取回来（防盗链 / 出口 IP / 软封锁 / 中继）
     只看 ① 会得出「阅读器好的」的错误结论 —— 症状恰恰是「打得开、图片全裂」。
     这个 harness 两段都量，并且**对同一张图取两次比 sha256**，
     用来识破「回了一段 HTML 错误页 / CDN 缓存页冒充图片」这种最隐蔽的假成功。

   用法（网关必须已经在跑，默认 http://127.0.0.1:8788）：
     node tools/reader-src-check.js                 # 全部来源
     node tools/reader-src-check.js --only=ehentai
     HS_Q=genshin node tools/reader-src-check.js    # 换检索词
     HS_GW=http://127.0.0.1:8788 node tools/reader-src-check.js
   退出码：只要有任何一个来源「reader 失败」或「首图取不到」就是 1，否则 0。
   原始结果同时写进 tools/reader-report.md（会被整份覆写）。
   ========================================================================== */
'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GW = String(process.env.HS_GW || 'http://127.0.0.1:8788').replace(/\/+$/, '');
const Q = String(process.env.HS_Q || 'fate').trim();
const OUT = path.join(__dirname, 'reader-report.md');
const READER_TIMEOUT = 180000;   /* ehentai 逐页解析最慢，给足 */
const SEARCH_TIMEOUT = 120000;
const IMG_TIMEOUT = 40000;
const ONLY = (() => {
  const a = process.argv.slice(2).find(x => x.indexOf('--only=') === 0);
  return a ? a.slice(7).split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : null;
})();

function enc(s) { return encodeURIComponent(String(s)); }
function abs(u) { return /^https?:\/\//i.test(String(u)) ? String(u) : GW + u; }
function sha12(buf) { return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12); }
function ms(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 's' : n + 'ms'; }
function cut(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; }

/** 裸 GET（网关也是裸 HTTP；不接管道，不回显到 stdout 之外） */
function gwGet(p, timeout) {
  return new Promise(resolve => {
    const url = abs(p);
    const t0 = Date.now();
    let u;
    try { u = new URL(url); } catch (e) {
      return resolve({ status: 0, headers: {}, buf: Buffer.alloc(0), ms: 0, url, error: 'URL 不合法：' + e.message });
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'GET',
      headers: { 'user-agent': 'reader-src-check/1.0' }
    });
    let done = false;
    const fin = v => { if (!done) { done = true; resolve(v); } };
    req.setTimeout(timeout || 30000, () => {
      req.destroy();
      fin({ status: 0, headers: {}, buf: Buffer.alloc(0), ms: Date.now() - t0, url, error: '客户端超时 ' + (timeout || 30000) + 'ms' });
    });
    req.on('error', e => fin({ status: 0, headers: {}, buf: Buffer.alloc(0), ms: Date.now() - t0, url, error: String((e && e.message) || e) }));
    req.on('response', res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => fin({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks), ms: Date.now() - t0, url }));
      res.on('error', e => fin({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(chunks), ms: Date.now() - t0, url, error: String((e && e.message) || e) }));
    });
    req.end();
  });
}

function asJson(r) {
  try { return JSON.parse(r.buf.toString('utf8')); } catch (e) { return null; }
}
/** 浏览器看到的是不是「图片」：内容类型 + 前 64 字节的 HTML 嗅探 */
function looksBroken(r) {
  const ct = String(r.headers['content-type'] || '');
  const head = r.buf.slice(0, 200).toString('latin1').replace(/^\uFEFF/, '').trim();
  const htmlish = /^\s*<(!doctype|html|head|body|\?xml|script)/i.test(head) || /text\/html/i.test(ct);
  return { ct, htmlish, empty: r.buf.length === 0 };
}

/* ---------------------------------------------------------------------------
   每个「支持在线阅读」的来源：先用它自己的检索接口抓一条真实条目拿 id。
   pick 拿不到时用 fixed 兜底（fixed 是实测过的已知可用 id），
   fixed 也没有就如实报「本次取不到 id」——不编。
   --------------------------------------------------------------------------- */
const SRC = [
  {
    id: 'mangadex', name: 'MangaDex', reader: 'mangadex',
    /* 只用 title= 与 limit=（实测带 contentRating[] 多值会被上游回 HTTP 400），
       reader 那边自己会带上完整四档 contentRating 去取 feed */
    search: { kind: 'proxy', url: 'https://api.mangadex.org/manga?limit=2&title=' + enc(Q) },
    pick: j => j && j.data && j.data[0] && j.data[0].id
  },
  {
    id: 'nhentai', name: 'nhentai', reader: 'nhentai',
    search: { kind: 'gw', url: '/api/nhentai/search?q=' + enc(Q) + '&page=1' },
    pick: j => j && j.items && j.items[0] && j.items[0].id
  },
  {
    id: 'ehentai', name: 'E-Hentai', reader: 'ehentai',
    /* 关键词检索在本出口返回空集（按出口 IP 限制），所以先搜词、再退 /popular，再退种子兜底 */
    search: { kind: 'gw', url: '/api/ehentai/search?q=' + enc(Q) + '&page=1' },
    pick: j => j && j.items && j.items[0] && j.items[0].id,
    search2: { kind: 'gw', url: '/api/ehentai/search?q=&page=1' },
    pick2: j => j && j.items && j.items[0] && j.items[0].id,
    fixed: String(process.env.HS_EH_ID || '')
  },
  {
    id: 'danbooru', name: 'Danbooru', reader: 'danbooru',
    search: { kind: 'proxy', url: 'https://danbooru.donmai.us/posts.json?limit=1&tags=' + enc(Q) },
    pick: j => (Array.isArray(j) && j[0] && j[0].id) || (j && j.posts && j.posts[0] && j.posts[0].id),
    /* 检索侧在本出口被 Cloudflare 挑战页挡住（实测 HTTP 403 · 5928B · text/html
       「Just a moment...」），取不到真实 post id。下面这个 id 是**任意**填的：
       /api/reader 会先走 cfFetchWithSolver 过 CF，而 CF 那一关在「条目存不存在」之前就失败了，
       所以这个 id 的值不影响「本来源在线阅读是否可用」的结论。 */
    fixed: '8000000'
  },
  {
    id: 'wnacg', name: '紳士漫畫 wnacg', reader: 'wnacg',
    search: { kind: 'gw', url: '/api/wnacg/search?q=' + enc(Q) + '&page=1' },
    pick: j => j && j.items && j.items[0] && j.items[0].id,
    fixed: '386060'
  },
  {
    id: 'hitomi', name: 'Hitomi', reader: 'hitomi',
    /* hitomi.la/search.html 是**纯 JS 壳**（实测 200 · 3687B，正文里没有任何 gallery id，
       网关自己的注释也说「真正的检索要走 nozomi 二进制索引」）。所以改从 CDN 上的
       nozomi 索引取：每项 4 字节**大端** gallery id，首项就是最新的真实图集 id
       （实测 index-english.nozomi → 200 · 670624B · 首项 0x00402d21 = 4205857）。 */
    search: { kind: 'proxy', url: 'https://ltn.gold-usergeneratedcontent.net/index-english.nozomi' },
    pickBin: b => (b.length >= 4 ? String(b.readUInt32BE(0)) : ''),
    fixed: '4205857'
  },
  {
    id: 'pixiv', name: 'Pixiv', reader: 'pixiv',
    search: { kind: 'gw', url: '/api/pixiv/search?q=' + enc(Q) + '&page=1' },
    pick: j => j && j.items && j.items[0] && j.items[0].id,
    fixed: '149872482'
  },
  {
    id: 'copymanga', name: '拷贝漫画 copymanga', reader: 'copymanga',
    search: { kind: 'gw', url: '/api/copymanga/search?q=' + enc(Q) + '&page=1' },
    pick: j => j && j.items && j.items[0] && j.items[0].id,
    fixed: 'faterequestchineseversion'
  },
  {
    id: 'jmcomic', name: '禁漫 jmcomic', reader: 'jmcomic',
    search: { kind: 'gw', url: '/api/jm/search?q=' + enc(Q) + '&page=1' },
    pick: j => j && j.items && j.items[0] && j.items[0].id,
    fixed: '480715'
  },
  {
    id: 'porncomic', name: 'porn-comic', reader: 'porncomic',
    search: { kind: 'gw', url: '/api/porncomic/search?q=' + enc(Q) + '&page=1' },
    pick: j => j && j.items && j.items[0] && j.items[0].id,
    fixed: '872078'
  },
  {
    id: 'lectormanga', name: 'LectorManga', reader: 'lectormanga',
    search: { kind: 'gw', url: '/api/lectormanga/search?q=' + enc(Q) + '&page=1' },
    pick: j => j && j.items && j.items[0] && j.items[0].id
  }
];

/* ---------------- ① 取一条真实条目的 id ---------------- */
async function findId(s) {
  const tried = [];
  const lanes = [];
  if (s.search) lanes.push({ lane: 'keywords', search: s.search, pick: s.pick, pickHtml: s.pickHtml, pickBin: s.pickBin });
  if (s.search2) lanes.push({ lane: 'fallback-path', search: s.search2, pick: s.pick2 });
  for (const L of lanes) {
    let r, j = null, id = '';
    const url = L.search.kind === 'gw'
      ? L.search.url
      : '/api/proxy?url=' + enc(L.search.url) + '&referer=' + enc(new URL(L.search.url).origin + '/');
    try {
      r = await gwGet(url, SEARCH_TIMEOUT);
    } catch (e) {
      tried.push({ lane: L.lane, url: L.search.url, error: String((e && e.message) || e) });
      continue;
    }
    const body = r.buf.toString('utf8');
    const rec = {
      lane: L.lane, search: L.search.url, gwUrl: url, status: r.status, ms: r.ms,
      bytes: r.buf.length, ct: String(r.headers['content-type'] || ''),
      error: r.error || ''
    };
    if (L.search.kind === 'gw') {
      j = asJson(r);
      if (j && j.error) rec.upstreamError = String(j.error);
      if (j && j.ok === false) rec.ok = false;
      if (j && j.items) rec.items = j.items.length;
      else if (j && j.data) rec.items = j.data.length;
      try { id = String((L.pick && L.pick(j)) || ''); } catch (e) { rec.pickError = String(e.message || e); }
    } else {
      const t = body;
      if (L.pickBin) { try { id = String(L.pickBin(r.buf) || ''); } catch (e) { rec.pickError = String(e.message || e); } }
      if (L.pickHtml) { try { id = String(L.pickHtml(t) || ''); } catch (e) { rec.pickError = String(e.message || e); } }
      if (!id && L.pick) { try { id = String(L.pick(JSON.parse(t)) || ''); } catch (e) { rec.pickError = String((e && e.message) || e); } }
      if (!id) {
        /* Chrome 渲染过的 JSON 会被包在 <pre> 里（/api/proxy 只对 .json 走 Chrome 兜底） */
        const m = t.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
        if (m) { try { id = String((L.pick || (() => ''))(JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))) || ''); } catch (e) { /* ignore */ } }
      }
    }
    rec.id = id;
    tried.push(rec);
    if (id) return { id, how: L.lane + (L.search.kind === 'gw' ? '（网关检索）' : '（/api/proxy 直取上游检索接口）'), tried };
  }
  if (s.fixed) return { id: s.fixed, how: '内置已知可用 id（检索这次没给出来）', tried, fallback: true };
  return { id: '', how: '本次取不到真实 id', tried };
}

/* ---------------- ② ③ 读一页 & 下载图 ---------------- */
async function checkOne(s) {
  const rec = { id: s.id, name: s.name, source: s.reader, q: Q, steps: [], pageProbe: [], verdict: '', note: '' };
  const f = await findId(s);
  rec.how = f.how;
  rec.probeId = f.id;
  rec.searchSteps = f.tried;
  if (!f.id) { rec.verdict = '取不到 id —— 本来源本次没能体检'; return rec; }

  const readerQ = '/api/reader?source=' + enc(s.reader) + '&id=' + enc(f.id);
  const r = await gwGet(readerQ, READER_TIMEOUT);
  const j = asJson(r);
  rec.reader = {
    url: readerQ, status: r.status, ms: r.ms, bytes: r.buf.length, error: r.error || '',
    httpError: r.status !== 200, ok: !!(j && j.ok),
    jsonError: j ? String(j.error || '') : '（响应不是 JSON：' + cut(r.buf.toString('utf8').replace(/\s+/g, ' '), 160) + '）',
    title: j ? String(j.title || '') : '',
    pages: j && Array.isArray(j.pages) ? j.pages.length : 0,
    chapters: j && Array.isArray(j.chapters) ? j.chapters.length : 0,
    note: j ? String(j.note || '') : ''
  };
  if (!rec.reader.ok || !rec.reader.pages) {
    rec.verdict = '在线阅读不可用（/api/reader 没给出页地址）';
    rec.note = rec.reader.jsonError || rec.reader.error;
    return rec;
  }

  const pages = j.pages.slice(0, 3);
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i] || {};
    const u = String(p.url || '');
    const a = String(p.alt || '');
    const one = {
      idx: i, src: u, alt: a, w: p.w || 0, h: p.h || 0,
      target: u ? cut(decodeURIComponent((u.match(/[?&]url=([^&]*)/) || [])[1] || u), 140) : ''
    };
    if (!u) { one.error = '页地址为空'; rec.pageProbe.push(one); continue; }
    if (!/^\/api\//.test(u)) one.nonSameOrigin = true;
    const r1 = await gwGet(u, IMG_TIMEOUT);
    const r2 = await gwGet(u, IMG_TIMEOUT);
    const b1 = looksBroken(r1), b2 = looksBroken(r2);
    one.fetch = {
      status: r1.status, ms: r1.ms, bytes: r1.buf.length, ct: b1.ct,
      sha: sha12(r1.buf), htmlish: b1.htmlish, empty: b1.empty, error: r1.error || '',
      body: b1.htmlish || b1.empty ? cut(r1.buf.toString('utf8').replace(/\s+/g, ' '), 200) : ''
    };
    one.fetch2 = { status: r2.status, ms: r2.ms, bytes: r2.buf.length, ct: b2.ct, sha: sha12(r2.buf), error: r2.error || '' };
    one.stable = one.fetch.sha === one.fetch2.sha && one.fetch.status === one.fetch2.status;
    one.good = r1.status === 200 && !b1.htmlish && !b1.empty;
    rec.pageProbe.push(one);
  }
  const first = rec.pageProbe[0] || null;
  rec.verdict = first && first.good
    ? (rec.pageProbe.some(x => !x.good) ? '在线阅读可用，但 2/3 号页有问题' : '在线阅读可用')
    : '页面地址取不到图 —— 在线阅读不可用';
  if (first && !first.good) {
    rec.note = first.fetch.error || (first.fetch.body ? 'HTTP ' + first.fetch.status + '：' + first.fetch.body : 'HTTP ' + first.fetch.status + '，' + first.fetch.bytes + ' 字节');
  }
  return rec;
}

/* ---------------- 报告 ---------------- */
function tableRow(rec) {
  if (!rec.reader) {
    return [rec.name, rec.probeId || '—', '—', '—', '—', '—', rec.verdict].join(' | ');
  }
  const f = rec.pageProbe[0] || {};
  const rd = rec.reader.ok ? ('ok · ' + rec.reader.pages + '页 · ' + ms(rec.reader.ms)) : ('✗ ' + cut(rec.reader.jsonError || rec.reader.error, 70));
  const img = !f.src ? '（没有页地址）'
    : (f.good ? ('200 · ' + f.fetch.bytes + 'B · ' + f.fetch.sha + ' · ' + f.fetch.ct + ' · ' + ms(f.fetch.ms))
      : ('✗ ' + (f.fetch ? (f.fetch.status + ' · ' + f.fetch.bytes + 'B · ' + f.fetch.ct) : '—') + ' · ' + cut(f.error || f.fetch.error || f.fetch.body, 60)));
  const st = f.stable === undefined ? '—' : (f.stable ? '稳定（两取同 sha）' : '不稳定 ✗');
  return [rec.name, rec.probeId || '—', rd, String(rec.reader.pages || 0), img, st, rec.note ? cut(rec.note, 110) : rec.verdict].join(' | ');
}

function renderMarkdown(recs, meta) {
  const L = [];
  L.push('# 在线阅读逐源体检报告（tools/reader-src-check.js 生成）');
  L.push('');
  L.push('- 生成时间：' + meta.at);
  L.push('- 网关：' + GW + '（`/api/ping` => ' + meta.ping + '）');
  L.push('- 检索词：`' + Q + '`；每个来源的 id 都**先用它自己的检索接口真取一条**，取不到才用内置已知 id');
  L.push('- 每张图各取 **2 次**并比 sha256 前 12 位：两次不一致说明地址不稳定；`text/html` 或正文以 `<` 开头说明「回了错误页冒充图片」');
  L.push('');
  L.push('## 汇总表');
  L.push('');
  L.push('| 来源 | 检索取到的 id | /api/reader | 页数 | 首图（状态/字节/sha12/类型/耗时） | sha 稳定性 | 结论 / 失败原文 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const rec of recs) L.push('| ' + tableRow(rec) + ' |');
  L.push('');
  L.push('## 逐源细节');
  for (const rec of recs) {
    L.push('');
    L.push('### ' + rec.name + '（source=' + rec.source + '）');
    L.push('- 判定：**' + rec.verdict + '**');
    L.push('- id：`' + (rec.probeId || '（无）') + '` —— 来源：' + rec.how);
    L.push('- 检索取证：');
    for (const s of rec.searchSteps || []) {
      L.push('  - ' + s.lane + ' · `' + cut(s.search, 120) + '` → HTTP ' + s.status + ' · ' + s.bytes + 'B · ' + ms(s.ms) +
        (s.id ? ' · id=`' + s.id + '`' : '') + (s.error ? ' · 客户端错误=' + s.error : '') + (s.upstreamError ? ' · 上游错误=' + cut(s.upstreamError, 200) : ''));
    }
    if (rec.reader) {
      L.push('- /api/reader `' + rec.reader.url + '` → HTTP ' + rec.reader.status + ' · ' + ms(rec.reader.ms) + ' · ' + rec.reader.bytes + 'B');
      L.push('  - ok=' + rec.reader.ok + ' · pages=' + rec.reader.pages + ' · chapters=' + rec.reader.chapters + ' · title=`' + rec.reader.title + '`');
      if (rec.reader.jsonError) L.push('  - error 原文：' + rec.reader.jsonError);
      if (rec.reader.note) L.push('  - note：' + cut(rec.reader.note, 600));
    }
    for (const p of rec.pageProbe) {
      L.push('- 页 ' + (p.idx + 1) + '：上游目标 `' + p.target + '`');
      L.push('  - 相对地址' + (p.nonSameOrigin ? '（⚠ 不是同源 /api/ 相对路径）' : '') + '：`' + cut(p.src, 300) + '`');
      if (p.alt) L.push('  - 备用地址：`' + cut(p.alt, 300) + '`');
      if (!p.fetch) { L.push('  - ' + (p.error || '未取')); continue; }
      L.push('  - 第 1 次：HTTP ' + p.fetch.status + ' · ' + p.fetch.bytes + 'B · sha256前12=' + p.fetch.sha + ' · ' + p.fetch.ct + ' · ' + ms(p.fetch.ms) +
        (p.fetch.error ? ' · 错误=' + p.fetch.error : '') + (p.fetch.empty ? ' · ⚠ 0 字节' : '') + (p.fetch.htmlish ? ' · ⚠ 正文是 HTML' : ''));
      L.push('  - 第 2 次：HTTP ' + p.fetch2.status + ' · ' + p.fetch2.bytes + 'B · sha256前12=' + p.fetch2.sha + ' · ' + p.fetch2.ct + ' · ' + ms(p.fetch2.ms));
      L.push('  - 稳定性：' + (p.stable ? '两次一致 ✅' : '两次不一致 ❌'));
      if (p.fetch.body) L.push('  - 正文开头：`' + p.fetch.body + '`');
    }
    L.push('');
    L.push('```json');
    L.push(JSON.stringify(rec, null, 2));
    L.push('```');
  }
  return L.join('\n');
}

async function main() {
  const ping = await gwGet('/api/ping', 10000);
  const meta = { at: new Date().toISOString(), ping: ping.status === 200 ? cut(ping.buf.toString('utf8').replace(/\s+/g, ' '), 400) : ('HTTP ' + ping.status + ' ' + (ping.error || '')) };
  if (ping.status !== 200) {
    console.log('网关 ' + GW + ' 不可用：HTTP ' + ping.status + ' ' + (ping.error || ''));
    console.log('（本 harness 只测量「用户侧已在运行的网关」，不自己启停它）');
    return 2;
  }
  const list = SRC.filter(s => !ONLY || ONLY.indexOf(s.id) >= 0);
  const recs = [];
  console.log('=== 在线阅读逐源体检 ===  网关 ' + GW + '  检索词 "' + Q + '"  来源 ' + list.length + ' 个');
  for (const s of list) {
    const t0 = Date.now();
    let rec;
    try { rec = await checkOne(s); }
    catch (e) { rec = { id: s.id, name: s.name, source: s.reader, verdict: 'harness 内部异常：' + ((e && e.message) || e), searchSteps: [], pageProbe: [] }; }
    rec.wallMs = Date.now() - t0;
    recs.push(rec);
    console.log('  [' + (recs.length) + '/' + list.length + '] ' + rec.name + ' → ' + rec.verdict +
      (rec.reader ? ('  (reader ok=' + rec.reader.ok + ' pages=' + rec.reader.pages + ' ' + ms(rec.reader.ms) + ')') : '') +
      '  总耗时 ' + ms(rec.wallMs));
    if (rec.note) console.log('        ' + cut(rec.note, 220));
    try { fs.writeFileSync(OUT, renderMarkdown(recs, meta), 'utf8'); } catch (e) { /* 磁盘问题不该让测量中断 */ }
  }
  console.log('');
  console.log('| 来源 | id | /api/reader | 页数 | 首图 | sha | 结论/原因 |');
  console.log('|---|---|---|---|---|---|---|');
  for (const rec of recs) console.log('| ' + tableRow(rec) + ' |');
  fs.writeFileSync(OUT, renderMarkdown(recs, meta), 'utf8');
  console.log('');
  console.log('原始结果已写入 ' + OUT);
  const bad = recs.filter(r => !r.reader || !r.reader.ok || !(r.pageProbe[0] && r.pageProbe[0].good));
  console.log('不可用的来源：' + (bad.length ? bad.map(r => r.name).join('、') : '（无）'));
  return bad.length ? 1 : 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }, e => { console.error('harness 崩了：' + ((e && e.stack) || e)); process.exitCode = 2; });
}
module.exports = { main, checkOne, SRC };
