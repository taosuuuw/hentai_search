#!/usr/bin/env node
'use strict';
/* ============================================================================
 * tools/stability-check.js —— 检索稳定性压测（只读，不改任何站点文件）
 *
 * 目的：复刻前端 assets/js/sources.js 一次「完整检索」的并发与超时，对站点
 *       默认启用的 7 个来源连打 N 轮，统计整轮墙钟耗时与每源失败率/分位耗时。
 *
 * 用法（零依赖，node >= 18）：
 *   node tools/stability-check.js                       # 100 轮，每轮换词
 *   node tools/stability-check.js --rounds=20 --q=巨乳  # 指定轮数与固定词
 *   node tools/stability-check.js --rounds=5 --wnFallback=0
 *
 * 前端事实来源（行号为 read 工具给出的权威行号）：
 *   S.RUN_CAP_MS = 9500               assets/js/sources.js:2212（第 8 轮 22000 → 9500）
 *   S.run(opts) 聚合 + 全局 cap       assets/js/sources.js:2297-2362
 *   net.fetchSource 预算/尝试链       assets/js/net.js:220-254
 *   net.buildAttempts 尝试顺序        assets/js/net.js:158-194
 *   GW.get 默认 20000ms               assets/js/net.js:502-598
 *   EH_BUDGET = 15000（第二车道）     assets/js/sources.js:908-955
 *   gwNh(...,30000)                   assets/js/sources.js:770-784
 *   gwWn(...,16000) + wnRound 镜像回退 assets/js/sources.js:1695-1732 / 1761-1777
 *   jm gateway(...,16000)             assets/js/sources.js:1077-1081
 *   lectormanga gateway(...,9000)     assets/js/sources.js:1360-1362
 *   mangadex / danbooru 直连+网关代理  assets/js/sources.js:237-288 / 1928-1931
 *   默认启用来源                      assets/js/core.js:45
 * ==========================================================================*/

const fs = require('fs');
const path = require('path');

/* ---------------------------------------------------------------- CLI ---- */
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find(a => a === '--' + name || a.startsWith('--' + name + '='));
  if (!hit) return dflt;
  const eq = hit.indexOf('=');
  return eq < 0 ? true : hit.slice(eq + 1);
};
const num = (v, dflt) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : dflt; };

const BASE = String(arg('base', 'http://127.0.0.1:8788')).replace(/\/+$/, '');
const ROUNDS = num(arg('rounds', 100), 100);
const FIXED_Q = arg('q', null);
const CAP_MS = num(arg('capMs', 9500), 9500);            // = S.RUN_CAP_MS（第 8 轮 22000 → 9500）
const WN_FALLBACK = String(arg('wnFallback', '1')) !== '0'; // 绅士镜像直连回退
const OUT_DIR = path.resolve(__dirname, 'stability-run');
const OUT_JSON = path.resolve(String(arg('out', path.join(__dirname, 'stability-report.json'))));
const OUT_MD = OUT_JSON.replace(/\.json$/i, '') + '.md';
const LOG = path.join(OUT_DIR, 'rounds.log');
const DATE = new Date().toISOString();
const T0ALL = Date.now();

/* ------------------------------------------------------------- words ---- */
/* 真实会被检索的词：中文站内常用词 + 站点词典 HS.TAG_ZH（assets/js/dict.js:11+）真标签 */
const WORDS = [
  '巨乳', '人妻', '催眠', '触手', '女仆', '眼镜娘', '泳装', '黑丝', '护士', '教师',
  '巫女', '姐姐', '母女', '露出', '调教', '拘束', '媚药', '洗脑', '兽耳', '兔女郎',
  '紧身衣', '体操服', '水手服', '和服', '婚纱', '修女', '忍者', '精灵', '魅魔', '吸血鬼',
  '短发', '双马尾', '黑发', '金发', '巨根', '中出', '颜射', '口交', '肛交', '乳交',
  '自慰', '潮吹', '强暴', '轮奸', '姐妹', '孕妇', '熟女', '少女', '学生', '偶像',
  '空姐', '搜查官', '女战士', '魔法少女', '公主', '女骑士', '猫娘', '狐娘', '恶魔', '天使',
  '女警', '白丝', '网袜', '旗袍', '温泉', '按摩', '健身房', '图书馆', '电车', '厕所',
  '教室', '办公室', '医院', '海滩', '青梅竹马', '后宫', '近亲', '义母', '女上司', '秘书',
  'big breasts', 'ahegao', 'milf', 'twintails', 'school uniform', 'swimsuit', 'stockings',
  'maid', 'nurse', 'teacher', 'nun', 'bondage', 'tentacles', 'hypnosis', 'netorare',
  'yuri', 'futanari', 'anal', 'creampie', 'fellatio', 'paizuri', 'masturbation',
  'bukkake', 'gangbang', 'rape', 'pregnant', 'elf', 'demon girl', 'catgirl', 'fox girl',
  'idol', 'cheerleader', 'kimono', 'qipao', 'bunny girl', 'thighhighs', 'glasses',
  'dark skin', 'tanned', 'petite', 'muscular', 'huge breasts', 'ponytail', 'braid',
  'blonde hair', 'white hair', 'heterochromia', 'latex', 'garter belt', 'cunnilingus',
  'handjob', 'footjob', 'deepthroat', 'squirting', 'orgasm', 'kissing', 'yandere',
  'tsundere', 'older sister', 'mother', 'aunt', 'office lady', 'policewoman', 'knight',
  'witch', 'goddess', 'succubus', 'vampire', 'slime girl', 'monster girl', 'robot girl'
];

/* ------------------------------------------------------------ helpers ---- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function timedFetch(url, ms, wantJson) {
  const t = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    const r = await fetch(url, {
      signal: ctl.signal,
      redirect: 'follow',
      headers: {
        'accept': wantJson ? 'application/json, text/plain, */*' : 'text/html,application/json,*/*',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    });
    clearTimeout(timer);
    const text = await r.text();
    let json = null;
    if (wantJson) { try { json = JSON.parse(text); } catch (e) {} }
    return { ms: Date.now() - t, status: r.status, ok: r.ok, text, json, err: '' };
  } catch (e) {
    const msg = (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) ? '超时' : String((e && e.message) || e);
    return { ms: Date.now() - t, status: 0, ok: false, text: '', json: null, err: msg };
  }
}

const gwUrl = (p, params) => {
  const u = new URL(BASE + p);
  Object.keys(params || {}).forEach(k => {
    const v = params[k];
    if (v === undefined || v === null || v === '') return;
    if (Array.isArray(v)) v.forEach(x => u.searchParams.append(k, x));
    else u.searchParams.set(k, String(v));
  });
  return u.toString();
};
const proxyUrl = url => gwUrl('/api/proxy', { url });

/* 复刻 net.fetchSource：尝试链 + 预算 */
async function fetchSource(url, o) {
  o = o || {};
  const per = o.ms || 9000;
  const budget = o.budget || (o.proxyFirst ? 16000 : 13000);
  const attempts = o.proxyFirst
    ? [{ label: '网关代理', url: proxyUrl(url) }, { label: '直连', url }]
    : [{ label: '直连', url }, { label: '网关代理', url: proxyUrl(url) }];
  const t0 = Date.now();
  const tried = [];
  for (const a of attempts) {
    const left = budget - (Date.now() - t0);
    if (left < 1200) { tried.push({ label: a.label, ms: 0, err: '预算耗尽，跳过 ' + a.label }); continue; }
    const r = await timedFetch(a.url, Math.min(per, left), o.json !== false);
    tried.push({ label: a.label, ms: r.ms, status: r.status, err: r.err, len: r.text.length });
    if (!r.err && r.ok) return { ms: Date.now() - t0, path: a.label, price: null, body: r.text, json: r.json, tried };
  }
  const why = tried.length ? (tried[tried.length - 1].err || ('HTTP ' + tried[tried.length - 1].status)) : '无可用尝试';
  return { ms: Date.now() - t0, path: '', error: attempts[attempts.length - 1].label + '：' + why, tried };
}

/* 网关 JSON 端点（复刻 GW.get：非 2xx 视为错误，200 + {ok:false} 属于「软失败」，带上原文） */
async function gwGet(p, params, ms) {
  const url = gwUrl(p, params);
  const r = await timedFetch(url, ms, true);
  const out = { ms: r.ms, url, status: r.status, tried: [{ label: '网关', url, ms: r.ms, status: r.status, err: r.err }] };
  if (r.err) { out.error = r.err; return out; }
  if (!r.ok) { out.error = 'HTTP ' + r.status; out.text = r.text.slice(0, 300); return out; }
  out.json = r.json;
  if (!r.json) { out.error = 'JSON 解析失败'; out.text = r.text.slice(0, 300); return out; }
  return out;
}

/* ------------------------------------------------------------- sources --- */
/* 每源返回 { ok, items, ms, error, path, note } —— ok=false 表示这一源没拿到结果 */
const SRC = {};

SRC.mangadex = async q => {
  const u = new URL('https://api.mangadex.org/manga');
  u.searchParams.set('limit', '12');
  ['cover_art', 'author', 'artist'].forEach(v => u.searchParams.append('includes[]', v));
  ['suggestive', 'erotica', 'pornographic'].forEach(v => u.searchParams.append('contentRating[]', v));
  u.searchParams.set('title', q);
  u.searchParams.set('order[relevance]', 'desc');
  const r = await fetchSource(u.toString(), { ms: 9000, budget: 13000, json: true });
  if (r.error) return { ok: false, items: 0, ms: r.ms, error: r.error, path: '', tried: r.tried };
  let data = null; try { data = JSON.parse(r.body); } catch (e) {}
  const items = (data && Array.isArray(data.data)) ? data.data.length : 0;
  return { ok: items > 0, items, ms: r.ms, path: r.path, tried: r.tried, note: items ? '' : 'HTTP 200 但 0 条' };
};

SRC.nhentai = async q => {
  const t0 = Date.now();
  const g = await gwGet('/api/nhentai/search', { q, page: 1 }, 21000);
  if (g.json && g.json.ok !== false) {
    const items = Array.isArray(g.json.items) ? g.json.items.length : 0;
    return { ok: true, items, ms: g.ms, path: '网关', json: null, tried: g.tried, note: g.json.cached ? 'cache' : '' };
  }
  const gerr = (g.json && g.json.error) || g.error || '未知';
  const d = await fetchSource('https://nhentai.net/api/v2/search?query=' + encodeURIComponent(q) + '&page=1',
    { ms: 9000, budget: 16000, proxyFirst: true, json: true });
  const ms = Date.now() - t0;
  if (d.error) return { ok: false, items: 0, ms, error: '网关:' + String(gerr).slice(0, 120) + ' / 直连:' + d.error, path: '', tried: g.tried.concat(d.tried) };
  let items = 0; try { const j = JSON.parse(d.body); items = (j.result || []).length; } catch (e) {}
  return { ok: items > 0, items, ms, path: d.path, tried: g.tried.concat(d.tried), note: '网关失败后走' + d.path };
};

SRC.ehentai = async q => {
  const T = Date.now();
  const left = () => 15000 - (Date.now() - T);           // EH_BUDGET = 15000
  const g = await gwGet('/api/ehentai/search', { q, terms: q, page: 1, limit: 12 }, 16000);
  const rec = { ok: false, items: 0, ms: g.ms, path: '网关', tried: g.tried, note: '' };
  if (g.error) { rec.error = g.error; rec.ms = Date.now() - T; return rec; }
  const j = g.json || {};
  if (j.ok === false) { rec.error = String(j.error || 'ok:false').slice(0, 200); rec.ms = Date.now() - T; return rec; }
  let items = Array.isArray(j.items) ? j.items.length : 0;
  rec.note = [j.via ? 'via=' + j.via : '', j.searchZero ? 'searchZero' : '', j.cached ? 'cache' : ''].filter(Boolean).join(',');
  /* 第二车道：items < limit 且余量 > 2500 才发（sources.js:927-933） */
  if (items < 12 && q && left() > 2500) {
    const ms2 = Math.max(2000, Math.min(16000, left() - 500));
    const g2 = await gwGet('/api/ehentai/search', { q, terms: q, page: 1, limit: 12, lane: 'title' }, ms2);
    rec.tried = rec.tried.concat(g2.tried);
    if (g2.json && g2.json.ok !== false) {
      const n2 = Array.isArray(g2.json.items) ? g2.json.items.length : 0;
      items = Math.max(items, n2);
      rec.note += (rec.note ? ';' : '') + 'lane2=' + n2 + '条/' + g2.ms + 'ms';
    } else {
      rec.note += (rec.note ? ';' : '') + 'lane2失败=' + String(g2.error || (g2.json && g2.json.error) || '').slice(0, 80);
    }
  }
  rec.items = items; rec.ok = items > 0; rec.ms = Date.now() - T;
  if (!items) rec.note += (rec.note ? ';' : '') + '0 条';
  return rec;
};

SRC.jmcomic = async q => {
  const g = await gwGet('/api/jm/search', { q, page: 1, o: 'mr', hosts: '', web: '18comic.vip' }, 16000);
  if (g.error) return { ok: false, items: 0, ms: g.ms, error: g.error, path: '网关', tried: g.tried };
  const j = g.json || {};
  if (j.ok === false) return { ok: false, items: 0, ms: g.ms, error: String(j.error || 'ok:false').slice(0, 200), path: '网关', tried: g.tried };
  const items = Array.isArray(j.items) ? j.items.length : (Array.isArray(j.list) ? j.list.length : 0);
  return { ok: items > 0, items, ms: g.ms, path: '网关', tried: g.tried, note: [j.via ? 'via=' + j.via : '', j.cached ? 'cache' : ''].filter(Boolean).join(',') + (items ? '' : ' (0 条)') };
};

SRC.wnacg = async q => {
  const T = Date.now();
  const g = await gwGet('/api/wnacg/search', { q, page: 1, limit: 12, cat: '' }, 16000);
  const rec = { ok: false, items: 0, ms: g.ms, path: '网关', tried: g.tried, note: '' };
  let items = 0;
  if (g.json && Array.isArray(g.json.items)) items = g.json.items.length;
  rec.items = items; rec.ms = Date.now() - T;
  if (items > 0) { rec.ok = true; rec.note = [g.json.via ? 'via=' + g.json.via : '', g.json.cached ? 'cache' : ''].filter(Boolean).join(','); return rec; }
  rec.error = g.error || String((g.json && g.json.error) || 'ok 但 0 条').slice(0, 200);
  /* 浏览器镜像回退：仅当 leftMs() > 3000（sources.js:1772-1777） */
  const leftMs = 13000 - (Date.now() - T);
  if (WN_FALLBACK && q && leftMs > 3000) {
    const domains = ['www.wn03.ru', 'www.wn04.ru', 'www.wnacg01.cc', 'www.wnacg02.cc', 'www.wnacg03.cc',
      'www.wnacg04.cc', 'www.wnacg05.cc', 'wnacg.com', 'wnacg.ru', 'www.wnacg.com', 'www.wnacg.date'];
    const paths = ['/search/?q=' + encodeURIComponent(q) + '&f=_all&s=create_time_DESC&syn=yes',
      '/search/?q=' + encodeURIComponent(q) + '&m=0',
      '/albums-index-tag-' + encodeURIComponent(q) + '.html'];
    const urls = [];
    for (const p of paths) for (const d of domains) urls.push({ url: 'https://' + d + p, label: d + p.split('?')[0] });
    const t1 = Date.now();
    const got = await new Promise(resolve => {
      let done = 0, settled = false;
      urls.forEach(it => {
        fetchSource(it.url, { ms: 7000, budget: 10000, proxyFirst: true, json: false }).then(r => {
          done++;
          if (!settled && !r.error && r.body && r.body.length >= 300) { settled = true; resolve({ label: it.label, ms: Date.now() - t1, len: r.body.length }); }
          else if (done === urls.length && !settled) resolve(null);
        });
      });
    });
    rec.note += (rec.note ? ';' : '') + (got ? '镜像回退命中 ' + got.label + ' ' + got.len + 'B/' + got.ms + 'ms（未解析卡片）' : '镜像回退全部失败 ' + (Date.now() - t1) + 'ms');
    if (got) { rec.ok = true; rec.items = -1; rec.note += ' [items 未解析]'; }
    rec.ms = Date.now() - T;
  }
  return rec;
};

SRC.danbooru = async q => {
  const url = 'https://danbooru.donmai.us/posts.json?limit=12&tags=' + encodeURIComponent(q);
  /* 第 10 轮：danbooru 的接口在 Cloudflare 后面、域名又被 DNS 污染（直连必 403/超时）。
     浏览器里直连是**立刻**失败然后落到网关，Node 里直连却会一直挂到 9s 超时、把预算吃光，
     于是「网关代理」那一腿只剩 4s，冷启动过 CF（≈6-9s）根本来不及 —— 那是工具假象，
     不是网关的问题。所以和 nhentai 一样改成 proxyFirst，并把网关那一腿的预算放宽到
     15s（冷启动要起本机 Chrome 过验证）。 */
  const r = await fetchSource(url, { ms: 12000, budget: 15000, proxyFirst: true, json: true });
  if (r.error) return { ok: false, items: 0, ms: r.ms, error: r.error, path: '', tried: r.tried };
  let arr = null; try { arr = JSON.parse(r.body); } catch (e) {}
  const items = Array.isArray(arr) ? arr.length : 0;
  return { ok: items > 0, items, ms: r.ms, path: r.path, tried: r.tried, note: items ? '' : 'HTTP 200 但 0 条' };
};

SRC.lectormanga = async q => {
  const g = await gwGet('/api/lectormanga/search', { q, page: 1, limit: 12 }, 9000);
  if (g.error) return { ok: false, items: 0, ms: g.ms, error: g.error, path: '网关', tried: g.tried };
  const j = g.json || {};
  if (j.ok === false) return { ok: false, items: 0, ms: g.ms, error: String(j.error || 'ok:false').slice(0, 200), path: '网关', tried: g.tried };
  const items = Array.isArray(j.items) ? j.items.length : 0;
  return { ok: items > 0, items, ms: g.ms, path: '网关', tried: g.tried, note: items ? '' : '0 条' };
};

/* --- 非默认启用的源（--extra=1 时一起测，用来回答「绝不止这两个」） --- */
SRC.copymanga = async q => {
  const g = await gwGet('/api/copymanga/search', { q, page: 1, limit: 12 }, 21000);
  if (g.error) return { ok: false, items: 0, ms: g.ms, error: g.error, path: '网关', tried: g.tried };
  const j = g.json || {};
  const items = Array.isArray(j.items) ? j.items.length : 0;
  if (j.ok === false) return { ok: false, items: 0, ms: g.ms, error: String(j.error || 'ok:false').slice(0, 200), path: '网关', tried: g.tried };
  return { ok: items > 0, items, ms: g.ms, path: '网关', tried: g.tried, note: items ? (j.cached ? 'cache' : '') : '0 条' };
};

SRC.pixiv = async q => {
  const g = await gwGet('/api/pixiv/search', { q, page: 1, mode: 'all' }, 21000);
  if (g.error) return { ok: false, items: 0, ms: g.ms, error: g.error, path: '网关', tried: g.tried };
  const j = g.json || {};
  const items = Array.isArray(j.items) ? j.items.length : 0;
  if (j.ok === false) return { ok: false, items: 0, ms: g.ms, error: String(j.error || 'ok:false').slice(0, 200), path: '网关', tried: g.tried };
  return { ok: items > 0, items, ms: g.ms, path: '网关', tried: g.tried, note: items ? (j.cached ? 'cache' : '') : '0 条（R-18 需登录 cookie）' };
};

SRC.porncomic = async q => {
  const g = await gwGet('/api/porncomic/search', { q, page: 1, extra: '' }, 20000);
  if (g.error) return { ok: false, items: 0, ms: g.ms, error: g.error, path: '网关', tried: g.tried };
  const j = g.json || {};
  const items = Array.isArray(j.items) ? j.items.length : 0;
  if (j.ok === false) return { ok: false, items: 0, ms: g.ms, error: String(j.error || 'ok:false').slice(0, 200), path: '网关', tried: g.tried };
  return { ok: items > 0, items, ms: g.ms, path: '网关', tried: g.tried, note: items ? (j.cached ? 'cache' : '') : '0 条' };
};

/* 第 11 轮补上 hitomi —— 前端 S.REG 一共 11 个内建适配器
   （assets/js/sources.js:2131-2198：mangadex / jmcomic / copymanga / porncomic /
   lectormanga / pixiv / wnacg / nhentai / ehentai / danbooru / hitomi），
   --extra=1 现在能把 11 个全部覆盖。kemono 不是本应用的检索源
   （assets/js/cardtags.js:24 明说），只是网关保留的老接口，故不测。 */
SRC.hitomi = async q => {
  /* 复刻 assets/js/sources.js:1855 hitomiRound：HTML 搜索页（proxyFirst，无 JSON API）。
     ★第 11 轮补★ 判据修正：以前拿 `class="gallery-content"` 当「有结果」，但空壳页里
     这个类名**也在** —— 实测 hitomi.la/search.html 无论问什么都返回同一个 3687B 骨架
     （gallery-content×1、/g/ 链接 0 个）⇒ 每一轮都误报成功。现在只认真的作品链接。 */
  const term = String(q || '').replace(/\s+/g, '-');
  const url = 'https://hitomi.la/search.html?query=' + encodeURIComponent(term);
  const r = await fetchSource(url, { ms: 9000, budget: 15000, proxyFirst: true, json: false });
  if (r.error) return { ok: false, items: 0, ms: r.ms, error: r.error, path: '', tried: r.tried };
  const html = r.body || '';
  let n = (html.match(/\/g\/\d+/g) || []).length;
  if (!n) n = (html.match(/galleryThumb/g) || []).length;
  if (!n) n = (html.match(/\/(galleries|doujinshi|manga|cg|imageset)\/[^"']+?\.html/g) || []).length;
  return { ok: n > 0, items: n, ms: r.ms, path: r.path, tried: r.tried,
    note: n ? '' : 'HTTP 200 但 0 条结果（' + html.length + 'B；hitomi 搜索页是 JS 渲染的空壳，HTML 里没有作品链接）' };
};

const SOURCES = String(arg('extra', '0')) !== '0'
  ? ['mangadex', 'nhentai', 'ehentai', 'jmcomic', 'wnacg', 'danbooru', 'lectormanga', 'copymanga', 'pixiv', 'porncomic', 'hitomi']
  : ['mangadex', 'nhentai', 'ehentai', 'jmcomic', 'wnacg', 'danbooru', 'lectormanga'];

/* -------------------------------------------------------------- round ---- */
async function runRound(q) {
  const t0 = Date.now();
  const res = {};
  let capHit = false;
  const tasks = SOURCES.map(async s => {
    try {
      const r = await SRC[s](q);
      r.src = s;
      res[s] = Object.assign({ ok: false, items: 0, ms: Date.now() - t0, error: '', path: '', note: '' }, r);
    } catch (e) {
      res[s] = { src: s, ok: false, items: 0, ms: Date.now() - t0, error: String((e && e.stack) || e).slice(0, 300), path: '', note: '' };
    }
  });
  const all = Promise.all(tasks);
  const capTimer = sleep(CAP_MS).then(() => { capHit = true; });
  await Promise.race([all, capTimer]);
  const ms = Date.now() - t0;
  if (capHit) {
    /* 复刻 sources.js:2362 的跳过语义 */
    SOURCES.forEach(s => {
      if (!res[s]) res[s] = { src: s, ok: false, items: 0, ms, path: '', note: 'cap',
        error: '超过 ' + (CAP_MS / 1000) + 's 未返回，已跳过（该源当前不可达或过慢）' };
    });
    await Promise.race([all.catch(() => {}), sleep(20000)]); /* 排空在途请求再进下一轮，避免自我叠加负载 */
  }
  return { q, ms, capHit, over10s: ms > 10000, sources: res };
}

/* --------------------------------------------------------- aggregation --- */
const quant = (arr, p) => {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1));
  return a[i];
};
function summarize(rounds) {
  const perSrc = {};
  SOURCES.forEach(s => {
    const recs = rounds.map(r => r.sources[s]).filter(Boolean);
    const msArr = recs.map(r => r.ms);
    const hardFail = recs.filter(r => !r.ok && !r.path && !/镜像回退命中/.test(r.note || ''));
    const empty = recs.filter(r => !r.ok && (r.path || /镜像回退命中/.test(r.note || '')));
    const errCount = {};
    recs.forEach(r => { if (!r.ok && r.error) errCount[r.error.slice(0, 120)] = (errCount[r.error.slice(0, 120)] || 0) + 1; });
    perSrc[s] = {
      n: recs.length,
      okRate: recs.length ? +(recs.filter(r => r.ok).length / recs.length * 100).toFixed(1) : null,
      hardFail: hardFail.length,
      emptyOk: empty.length,
      p50: quant(msArr, .5), p95: quant(msArr, .95), max: msArr.length ? Math.max(...msArr) : null,
      avg: msArr.length ? +(msArr.reduce((a, b) => a + b, 0) / msArr.length).toFixed(0) : null,
      over10s: recs.filter(r => r.ms > 10000).length,
      paths: recs.reduce((m, r) => { const k = r.path || '(失败)'; m[k] = (m[k] || 0) + 1; return m; }, {}),
      topErrors: Object.entries(errCount).sort((a, b) => b[1] - a[1]).slice(0, 3)
    };
  });
  const roundMs = rounds.map(r => r.ms);
  return {
    rounds: rounds.length,
    roundP50: quant(roundMs, .5), roundP95: quant(roundMs, .95),
    roundMax: roundMs.length ? Math.max(...roundMs) : null,
    roundMin: roundMs.length ? Math.min(...roundMs) : null,
    roundAvg: roundMs.length ? +(roundMs.reduce((a, b) => a + b, 0) / roundMs.length).toFixed(0) : null,
    within10s: rounds.filter(r => !r.over10s).length,
    over10s: rounds.filter(r => r.over10s).map(r => ({ round: r.round, q: r.q, ms: r.ms, capHit: r.capHit })),
    capHitRounds: rounds.filter(r => r.capHit).map(r => r.round),
    perSource: perSrc
  };
}

/* -------------------------------------------------------------- report --- */
function mdReport(meta, S, rounds) {
  const L = [];
  L.push('# 检索稳定性压测报告（tools/stability-check.js 自动生成）');
  L.push('');
  L.push('- 生成时间：' + meta.date);
  L.push('- 网关：' + meta.base + '（' + meta.gwName + ' v' + meta.gwVersion + '）');
  L.push('- 网关出口 egress：' + meta.egress);
  L.push('- 轮数：' + S.rounds + '；轮内全局 cap：' + meta.capMs + 'ms（= 前端 S.RUN_CAP_MS）；单轮并发源数：' + SOURCES.length);
  L.push('- 每轮用词：' + (meta.fixedQ ? '固定「' + meta.fixedQ + '」' : '轮转（' + WORDS.length + ' 个真实检索词）'));
  L.push('- 说明：网关出口是「直连/DoH 钉 IP/中继」的多层实现，绝对延迟受当时网络影响；本表主要看失败模式与分位差。');
  L.push('');
  L.push('## 1. 整轮墙钟耗时');
  L.push('');
  L.push('| 指标 | 值 |');
  L.push('| --- | --- |');
  L.push('| ≤10s 轮数 | **' + S.within10s + ' / ' + S.rounds + '** |');
  L.push('| >10s 轮数 | ' + S.over10s.length + (S.over10s.length ? '（轮次 ' + S.over10s.map(o => '#' + o.round).join(', ') + '）' : '') + ' |');
  L.push('| 触及全局 cap 的轮数 | ' + (S.capHitRounds.length ? '是（轮次 ' + S.capHitRounds.join(', ') + '）' : '否') + '（cap = ' + meta.capMs + 'ms，= 前端 S.RUN_CAP_MS） |');
  L.push('| min / p50 / p95 / max / avg | ' + S.roundMin + ' / ' + S.roundP50 + ' / ' + S.roundP95 + ' / ' + S.roundMax + ' / ' + S.roundAvg + ' ms |');
  L.push('');
  if (S.over10s.length) {
    L.push('| 超 10s 轮 | 词 | 整轮 ms | 触 cap |');
    L.push('| --- | --- | --- | --- |');
    S.over10s.forEach(o => L.push('| #' + o.round + ' | ' + o.q + ' | ' + o.ms + ' | ' + (o.capHit ? '是' : '否') + ' |'));
    L.push('');
  }
  L.push('## 2. 每源统计');
  L.push('');
  L.push('| 源 | 成功率 | 硬失败 | 有响应但0条 | p50 | p95 | max | avg | >10s | 主要路径 |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  SOURCES.forEach(s => {
    const d = S.perSource[s];
    const paths = Object.entries(d.paths).map(([k, v]) => k + '×' + v).join('<br>');
    L.push('| ' + s + ' | ' + d.okRate + '% | ' + d.hardFail + ' | ' + d.emptyOk + ' | ' + d.p50 + ' | ' + d.p95 + ' | ' + d.max + ' | ' + d.avg + ' | ' + d.over10s + ' | ' + paths + ' |');
  });
  L.push('');
  L.push('## 3. 每源常见错误原文（截断 120 字）');
  L.push('');
  SOURCES.forEach(s => {
    const d = S.perSource[s];
    if (!d.topErrors.length) { L.push('- **' + s + '**：无硬失败'); return; }
    L.push('- **' + s + '**');
    d.topErrors.forEach(([msg, n]) => L.push('  - ×' + n + ' ' + msg));
  });
  L.push('');
  L.push('## 4. 逐轮明细');
  L.push('');
  L.push('| 轮 | 词 | 整轮 ms | ' + SOURCES.join(' | ') + ' |');
  L.push('| --- | --- | --- | ' + SOURCES.map(() => '---').join(' | ') + ' |');
  rounds.forEach(r => {
    const cells = SOURCES.map(s => {
      const d = r.sources[s] || {};
      return (d.ok ? '✅' : '❌') + (d.items >= 0 ? d.items : '?') + '/' + d.ms;
    });
    L.push('| ' + r.round + ' | ' + r.q + ' | ' + r.ms + (r.over10s ? ' ⚠' : '') + ' | ' + cells.join(' | ') + ' |');
  });
  L.push('');
  L.push('> 单元格含义：✅/❌ + 条数 + 该源耗时 ms。原始逐尝试明细见同目录同名 .json。');
  return L.join('\n');
}

/* ---------------------------------------------------------------- main --- */
(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let meta = { date: DATE, base: BASE, capMs: CAP_MS, fixedQ: FIXED_Q || null, gwName: '', gwVersion: '', egress: '', gw: null };
  try {
    const r = await timedFetch(BASE + '/api/ping', 6000, true);
    meta.gw = r.json;
    if (r.json) { meta.gwName = r.json.name || ''; meta.gwVersion = r.json.version || ''; meta.egress = r.json.egress || ''; }
  } catch (e) {}
  fs.writeFileSync(LOG, '');
  console.error('[stability] start rounds=' + ROUNDS + ' base=' + BASE + ' gw=' + meta.gwName + ' egress=' + meta.egress);

  const rounds = [];
  for (let i = 1; i <= ROUNDS; i++) {
    const q = FIXED_Q || WORDS[(i - 1) % WORDS.length];
    const r = await runRound(q);
    r.round = i;
    rounds.push(r);
    fs.appendFileSync(LOG, '#' + i + ' q=' + q + ' round=' + r.ms + 'ms' + (r.over10s ? ' OVER10s' : '') + (r.capHit ? ' CAP' : '') + '\n');
    if (i % 10 === 0 || i === ROUNDS) {
      const S = summarize(rounds);
      fs.writeFileSync(OUT_JSON, JSON.stringify({ meta, summary: S, rounds }, null, 1));
      fs.writeFileSync(OUT_MD, mdReport(meta, S, rounds));
      console.error('[stability] ' + i + '/' + ROUNDS + '  elapsed=' + Math.round((Date.now() - T0ALL) / 1000) + 's  within10s=' + S.within10s);
    }
  }
  const S = summarize(rounds);
  fs.writeFileSync(OUT_JSON, JSON.stringify({ meta, summary: S, rounds }, null, 1));
  fs.writeFileSync(OUT_MD, mdReport(meta, S, rounds));
  console.error('[stability] done. json=' + OUT_JSON + ' md=' + OUT_MD + ' total=' + Math.round((Date.now() - T0ALL) / 1000) + 's');
  process.exit(0);
})();
