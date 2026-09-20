/* ==========================================================================
   concept-check.js — 概念组（跨语言同义词）体检 + 保守化门槛断言（零依赖，可复跑）
   --------------------------------------------------------------------------
   用法（在仓库根目录）：
     node tools/concept-check.js                 # 跑断言（① 人妻 ② 熟女 ③ 回归 ④ termFor 门槛正反例
                                                 #          ⑤ 黑话提示目标 ⑥ 概念组结构一致性 ⑦ segWord 护栏正反例）
     node tools/concept-check.js snapshot <out>  # 导出快照 JSON（改前 / 改后逐字节对照）
     node tools/concept-check.js audit [out]     # 导出 HS.CONCEPTS 全组结构化体检事实 + 门槛影响面
     node tools/concept-check.js upstream <词>   # 打印该词在各源真正会发出的串（不联网）
   说明：
     · 直接加载站点真实的 core.js / dict.js / net.js / sources.js（node:vm 最小浏览器环境），
       不复制任何逻辑；把网络层换成「记录 URL 后抛错」的探针，所以**不会真的发上游请求**。
     · 断言里把本地网关标记为可用（ok=true），与站点在 8788 上的实际部署一致；
       网关路径记到的就是适配器真正会请求的 URL。
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadSite, installNetworkSpy } = require('./concept-check-shim');

const QUERIES = [
  /* 本次改动的主角 */
  '人妻', '熟女', '已婚女性', 'married woman', 'mature female', 'mature woman', 'milf', '御姐',
  /* 回归红线 */
  '中出', '无修', '巨乳', '寝取', '触手', 'full color', '脚',
  /* 单关键词 / 编号直达 */
  'fate', '明日方舟', '123456',
  /* 多关键词（走 segWord 分段口径） */
  '人妻 中出', '明日方舟 能天使 后入'
];

/* 记录式探针：匹配 responder 的请求返回假数据（只为让适配器继续往下走），其余立刻抛错 */
function spy(HS, responder) {
  const calls = [];
  const snap = {};
  snap.fetchSource = HS.net.fetchSource;
  snap.gwGet = HS.net.gateway && HS.net.gateway.get;
  const fake = url => {
    calls.push({ via: 'fetchSource', url: String(url) });
    if (responder) { const d = responder(String(url)); if (d !== undefined) return Promise.resolve(d); }
    const e = new Error('spy: 已拦截 ' + url); throw e;
  };
  HS.net.fetchSource = fake;
  if (HS.net.gateway) {
    HS.net.gateway.get = function (p, params) {
      const qs = params ? new URLSearchParams(params).toString() : '';
      const url = p + (qs ? '?' + qs : '');
      calls.push({ via: 'gateway', url: url });
      if (responder) { const d = responder(url); if (d !== undefined) return Promise.resolve(d); }
      throw new Error('spy: 已拦截 ' + url);
    };
  }
  return {
    calls,
    restore() {
      HS.net.fetchSource = snap.fetchSource;
      if (HS.net.gateway) HS.net.gateway.get = snap.gwGet;
    }
  };
}

function boot() {
  const env = loadSite();
  const HS = env.HS;
  /* 与部署一致：本地网关在 8788 上可用 */
  HS.net.gateway.ok = true;
  HS.net.gateway.info = {
    name: 'hs-gateway', sources: ['jmcomic', 'copymanga', 'pixiv', 'nhentai', 'ehentai', 'porncomic']
  };
  HS.settings.gateway = 'http://127.0.0.1:8788';
  return HS;
}

/* ---------------- 快照：与「上游串」直接相关的全部可观测值 ----------------
   ⚠ 口径必须与 S.run 一致：适配器拿到的是**改写后**的串（sctx.q = S.termFor(...)），
   所以 nhQueryFor / gwQueryFor 都要按「该源自己的 termFor 结果」去问，不能用用户原词。 */
function snapshotRow(HS, q) {
  const u = HS.u, S = HS.sources;
  const intent = u.classifyQuery(q);
  const c = intent.concept;
  const termFor = {};
  S.list.forEach(src => { termFor[src.id] = S.termFor(src, q, intent); });
  const forSrc = id => (termFor[id] == null ? q : termFor[id]);
  const gw = id => (S.gwQueryFor ? S.gwQueryFor({ q: forSrc(id), f: {}, intent: intent }, id) : null);
  return {
    q: q,
    kind: intent.kind,
    label: intent.label,
    series: intent.series || '',
    exact: !!intent.exact,
    multi: !!intent.multi,
    genreKey: intent.genre ? intent.genre.key : null,
    genreAliases: intent.genre ? intent.genre.aliases.slice() : null,
    concept: c ? { key: c.key, zh: c.zh, en: c.en, ja: c.ja, aliases: (c.aliases || []).slice() } : null,
    segments: (intent.segments || []).map(s => ({ text: s.text, kind: s.kind, via: s.via, label: s.label })),
    termFor: termFor,
    nh: S.nhQueryFor ? S.nhQueryFor({ q: forSrc('nhentai'), f: {}, intent: intent }) : null,
    jm: gw('jmcomic'),
    copymanga: gw('copymanga'),
    wnacg: gw('wnacg'),
    porncomic: gw('porncomic'),
    ehentaiTerm: (intent.kind === 'character' && intent.series) ? intent.series
      : ((intent.kind === 'genre' && intent.genre) ? '"' + intent.genre.key + '"$' : forSrc('ehentai')),
    danbooruTerm: (intent.kind === 'genre' && intent.genre) ? intent.genre.key : forSrc('danbooru'),
    pixivTerm: (intent.kind === 'genre' && intent.genre)
      ? (c ? (c.ja || forSrc('pixiv')) : intent.genre.key)
      : (intent.kind === 'character' ? (intent.series || forSrc('pixiv')) : forSrc('pixiv'))
  };
}

/** 各源适配器**真正会发出的 URL**（探针记录；mangadex 先喂一份空标签表让它走到标题检索） */
async function upstreamUrls(HS, q, opts) {
  const u = HS.u, S = HS.sources;
  const intent = u.classifyQuery(q);
  const out = {};
  for (const src of S.list) {
    if (opts && opts.only && opts.only.indexOf(src.id) < 0) continue;
    const term = S.termFor(src, q, intent);
    const respond = url => (/api\.mangadex\.org\/manga\/tag$/.test(url) ? { data: [] } : undefined);
    const sp = spy(HS, respond);
    const ctx = { q: term, f: {}, limit: 12, page: 1, plan: S.plan(1), intent: intent, capMs: 0 };
    try { await src.search(ctx); } catch (e) { /* 探针抛错即预期路径 */ }
    out[src.id] = { term: term, urls: sp.calls.map(x => x.url) };
    sp.restore();
  }
  return out;
}

/* ---------------- 体检事实 ---------------- */
function auditFacts(HS) {
  const dict = HS.TAG_ZH || {};
  const rev = {};
  Object.keys(dict).forEach(k => {
    const v = String(dict[k] == null ? '' : dict[k]).toLowerCase().trim();
    if (v) (rev[v] = rev[v] || []).push(String(k).toLowerCase());
  });
  const groups = HS.CONCEPTS || [];
  const win = {};                                    /* alias → 真正生效的组（先到先得） */
  groups.forEach(g => (g.aliases || []).forEach(a => {
    const k = String(a).toLowerCase().trim();
    if (k && !win[k]) win[k] = g.key;
  }));
  const slotOwner = {};                              /* zh/en/ja 槽位词 → 组 key */
  groups.forEach(g => ['zh', 'en', 'ja'].forEach(s => {
    const v = String(g[s] == null ? '' : g[s]).toLowerCase().trim();
    if (v) (slotOwner[v] = slotOwner[v] || []).push(g.key + ':' + s);
  }));
  const aliasOwner = {};
  groups.forEach(g => (g.aliases || []).forEach(a => {
    const k = String(a).toLowerCase().trim();
    if (k) (aliasOwner[k] = aliasOwner[k] || []).push(g.key);
  }));
  const rows = groups.map(g => {
    const aliases = (g.aliases || []).map(a => String(a));
    const flags = [];
    const detail = aliases.map(a => {
      const low = a.toLowerCase().trim();
      const zh = dict[low] ? String(dict[low]) : '';                 /* 它自己的中文翻译（TAG_ZH 键） */
      const ens = rev[low] || [];                                    /* 作为中文值时反查到的英文键 */
      const bits = [];
      if (zh && zh !== g.zh) bits.push('ownZh=' + zh);
      if (ens.length) bits.push('zhVal←' + ens.join('/'));
      if (win[low] && win[low] !== g.key) bits.push('被' + win[low] + '组抢先');
      if (aliasOwner[low] && aliasOwner[low].length > 1) bits.push('跨组:' + aliasOwner[low].join('+'));
      if (slotOwner[low] && slotOwner[low].some(x => x.split(':')[0] !== g.key)) {
        bits.push('他组槽位:' + slotOwner[low].filter(x => x.split(':')[0] !== g.key).join('+'));
      }
      return bits.length ? a + '(' + bits.join(',') + ')' : a;
    });
    if (!g.zh) flags.push('缺zh');
    if (!g.en) flags.push('缺en');
    if (!g.ja) flags.push('缺ja');
    if (!aliases.length) flags.push('空aliases');
    if (aliases.indexOf(g.zh) < 0) flags.push('zh不在aliases');
    if (aliases.indexOf(g.en) < 0) flags.push('en不在aliases');
    if (aliases.indexOf(g.ja) < 0) flags.push('ja不在aliases');
    const own = aliases.filter(a => {
      const low = a.toLowerCase().trim();
      return dict[low] && String(dict[low]) !== g.zh;
    });
    if (own.length) flags.push('别名的自有中文≠组zh:' + own.join(','));
    return { key: g.key, zh: g.zh, en: g.en, ja: g.ja, n: aliases.length, aliases: aliases, detail: detail, flags: flags };
  });
  return { rows: rows, rev: rev, dict: dict };
}

/** 保守化门槛的影响面：只统计**真正会走概念分支**的词（体裁表 / 系列表抢先的词不算），
    列出 (词, 组, 组原本要发的 zh 词, 门槛改成什么)。 */
function gateScope(HS) {
  const S = HS.sources, u = HS.u;
  if (typeof S.ownZh !== 'function') return { available: false, hits: [] };
  const src = S.list.find(s => s.id === 'copymanga');   /* zh 槽位代表 */
  const hits = [];
  (HS.CONCEPTS || []).forEach(g => (g.aliases || []).forEach(a => {
    const word = String(a);
    const intent = u.classifyQuery(word);
    if (!intent.concept || intent.concept.key !== g.key) return;   /* 没走概念分支 → 门槛管不着 */
    const was = g.zh || g.en;
    const now = S.termFor(src, word, intent);
    if (String(was || '') !== String(now || '')) hits.push({ q: word, group: g.key, was: was, now: now });
  }));
  return { available: true, hits: hits };
}

/* ---------------- 断言 ---------------- */
async function main() {
  /* 顺带把输出落到 tools/_tmp_check_out.txt（本机 shell 的重定向捕获不到子进程 stdout） */
  const _log = console.log.bind(console);
  const buf = [];
  console.log = function () {
    const a = Array.prototype.slice.call(arguments);
    buf.push(a.map(x => (typeof x === 'string' ? x : require('util').inspect(x, { depth: 6 }))).join(' '));
    _log.apply(null, a);
  };
  process.on('exit', function () {
    try { fs.writeFileSync(path.join(__dirname, '_tmp_check_out.txt'), buf.join('\n') + '\n', 'utf8'); } catch (e) {}
  });

  const mode = process.argv[2] || 'check';
  const HS = boot();
  const u = HS.u, S = HS.sources;

  if (mode === 'snapshot') {
    const out = process.argv[3] || 'tools/_tmp_snapshot.json';
    const queries = (process.argv[4] ? process.argv[4].split(',') : null) || QUERIES;
    const data = { version: HS.VERSION, rows: queries.map(q => snapshotRow(HS, q)) };
    fs.writeFileSync(out, JSON.stringify(data, null, 1), 'utf8');
    console.log('snapshot → ' + out + '（' + queries.length + ' 个查询）');
    return;
  }

  if (mode === 'audit') {
    const out = process.argv[3] || 'tools/_tmp_audit.txt';
    const f = auditFacts(HS);
    const lines = [];
    lines.push('# HS.CONCEPTS 体检事实（自动生成，' + f.rows.length + ' 组）');
    lines.push('# 组数\tkey\tzh\ten\tja\taliases数\taliases（括号内为自动发现的事实）\t结构flag');
    f.rows.forEach(r => lines.push([r.n >= 0 ? '' : '', r.key, r.zh, r.en, r.ja, r.n, r.detail.join(' | '), r.flags.join(';')].join('\t')));
    const scope = gateScope(HS);
    lines.push('');
    lines.push('# 保守化门槛影响面（zh 槽位）：ownZh 可用=' + scope.available + '，命中 ' + scope.hits.length + ' 条');
    scope.hits.forEach(h => lines.push('门槛\t' + h.q + '\t组=' + h.group + '\t原本发=' + h.was + '\t改发=' + h.now));
    fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
    console.log('audit → ' + out + '（' + f.rows.length + ' 组，门槛命中 ' + scope.hits.length + ' 条）');
    return;
  }

  if (mode === 'contrast') {
    /* 改前 / 改后逐槽对照（回归红线与本次改动的主角，一屏看完） */
    const bf = [path.join(__dirname, 'concept-snapshot-before.json'),
      path.join(__dirname, '_tmp_snapshot_before.json')].find(f => fs.existsSync(f));
    if (!bf) { console.log('缺改前快照 ' + bf); return; }
    const before = JSON.parse(fs.readFileSync(bf, 'utf8')).rows;
    const lines = [];
    lines.push('# 改前 → 改后 逐槽对照（' + bf + '）');
    lines.push('查询\t槽位\t改前\t改后\t是否相同');
    before.forEach(b => {
      const a = snapshotRow(HS, b.q);
      const sl = ['kind', 'label', 'genreKey', 'pixivTerm', 'danbooruTerm', 'ehentaiTerm'];
      sl.forEach(k => lines.push([b.q, k, JSON.stringify(b[k]), JSON.stringify(a[k]), String(JSON.stringify(b[k]) === JSON.stringify(a[k]))].join('\t')));
      const ids = Object.keys(b.termFor || {});
      ids.forEach(id => lines.push([b.q, 'termFor.' + id, JSON.stringify(b.termFor[id]), JSON.stringify(a.termFor[id]), String(b.termFor[id] === a.termFor[id])].join('\t')));
      [['nh', 'q'], ['jm', 'q'], ['copymanga', 'q'], ['wnacg', 'q']].forEach(p => {
        const x = b[p[0]] ? b[p[0]][p[1]] : null, y = a[p[0]] ? a[p[0]][p[1]] : null;
        lines.push([b.q, p[0] + '.' + p[1], JSON.stringify(x), JSON.stringify(y), String(x === y)].join('\t'));
      });
    });
    const out = process.argv[3] || path.join(__dirname, 'concept-contrast.txt');
    fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
    console.log('contrast → ' + out);
    return;
  }

  if (mode === 'upstream') {
    const q = process.argv[3];
    if (!q) { console.error('用法：node tools/concept-check.js upstream <词>'); process.exit(2); }
    upstreamUrls(HS, q).then(res => {
      Object.keys(res).forEach(id => {
        console.log('[' + id + '] term=' + JSON.stringify(res[id].term));
        res[id].urls.forEach(x => console.log('    ' + x));
      });
    });
    return;
  }

  if (mode === 'gatepreview') {
    /* 在不改 sources.js 的前提下，预演两种「保守化门槛」口径各自的影响面 */
    const dict = HS.TAG_ZH || {};
    const rev = {};
    Object.keys(dict).forEach(k => {
      const v = String(dict[k] == null ? '' : dict[k]).toLowerCase().trim();
      if (v) (rev[v] = rev[v] || []).push(String(k).toLowerCase());
    });
    const g2 = [], g4 = [], same = [];
    (HS.CONCEPTS || []).forEach(g => (g.aliases || []).forEach(a => {
      const word = String(a);
      const intent = u.classifyQuery(word);
      if (!intent.concept || intent.concept.key !== g.key) return;      /* 没走概念分支的不管 */
      const pick = String(g.zh || g.en || '');
      const own = String(dict[word.toLowerCase().trim()] || '');
      const revPick = rev[pick.toLowerCase()] || [];
      if (own && own !== pick) g2.push({ q: word, group: g.key, was: pick, now: own });
      if (own && own !== pick && revPick.length) g4.push({ q: word, group: g.key, was: pick, now: own });
      if (own && own === pick) same.push(word);
    }));
    const lines = [];
    const show = (title, list) => {
      lines.push('\n== ' + title + '（' + list.length + ' 条）==');
      list.forEach(h => lines.push('  ' + h.q + '（组 ' + h.group + '）：' + h.was + ' → ' + h.now));
    };
    show('口径 A：TAG_ZH 键命中且 ≠ 组 zh（照字面实现用户口径）', g2);
    show('口径 B：再加「组 zh 自己是某个英文标签的翻译」这一条', g4);
    const only = g2.filter(x => !g4.some(y => y.q === x.q && y.group === x.group));
    lines.push('\n两者差集（A 有、B 无）= ' + only.length + ' 条');
    only.forEach(h => lines.push('  ' + h.q + '（组 ' + h.group + '）：' + h.was + ' → ' + h.now));
    const out = process.argv[3] || 'tools/_tmp_gatepreview.txt';
    fs.writeFileSync(out, lines.join('\n') + '\n', 'utf8');
    console.log('gatepreview → ' + out + '（A=' + g2.length + ' B=' + g4.length + ' 差集=' + only.length + '）');
    return;
  }

  /* ---- check：断言 ---- */
  const results = [];
  const ok = (name, pass, info) => results.push({ name: name, pass: !!pass, info: info == null ? '' : String(info) });

  /* 结构完整性 */
  const groups = HS.CONCEPTS || [];
  const bad = groups.filter(g => !g || !g.key || !g.zh || !g.en || !g.ja || !Array.isArray(g.aliases) || !g.aliases.length);
  ok('结构：每组 key/zh/en/ja 齐全且 aliases 非空', bad.length === 0,
    groups.length + ' 组，异常 ' + bad.length + ' 组' + (bad.length ? '：' + bad.map(g => g && g.key).join(',') : ''));
  ok('结构：组数 = 128（122 + 本轮拆出的 gangbang / femdom / maledom / femsub / malesub / giantess 6 组）',
    groups.length === 128, '实际 ' + groups.length);

  /* ① 人妻 */
  const cH = u.conceptOf('人妻');
  ok('① 人妻 命中独立组（key=hitozuma, zh=人妻）', cH && cH.key === 'hitozuma' && cH.zh === '人妻',
    cH ? cH.key + '/' + cH.zh : 'null');
  const banned = /熟女|milf|mature/i;
  const rowH = snapshotRow(HS, '人妻');
  const badTerms = Object.keys(rowH.termFor).filter(id => banned.test(rowH.termFor[id]));
  ok('① 人妻 在 termFor 的各源串里不含 熟女/milf/mature', badTerms.length === 0,
    badTerms.length ? badTerms.map(id => id + '=' + rowH.termFor[id]).join(' ') : JSON.stringify(rowH.termFor));
  ok('① 人妻 概念组内不含 熟女/milf/mature 别名', rowH.concept && !rowH.concept.aliases.some(a => banned.test(a)),
    rowH.concept ? rowH.concept.aliases.join(',') : '');
  ok('① 人妻 的 nhentai 串 / 网关串 / pixiv 串都不含禁词',
    !banned.test(rowH.nh.q) && !banned.test(rowH.jm.q) && !banned.test(rowH.copymanga.q) && !banned.test(rowH.pixivTerm),
    JSON.stringify({ nh: rowH.nh.q, jm: rowH.jm.q, copy: rowH.copymanga.q, pixiv: rowH.pixivTerm }));
  ok('① 人妻 genre.key（ehentai/danbooru/mangadex 直接读它）不含禁词',
    !banned.test(String(rowH.genreKey || '')), String(rowH.genreKey));

  /* ② 熟女 */
  const cM = u.conceptOf('熟女');
  ok('② 熟女 仍命中 milf 组（en=milf）', cM && cM.key === 'milf' && cM.en === 'milf', cM ? cM.key + '/' + cM.en : 'null');
  const rowM = snapshotRow(HS, '熟女');
  ok('② 熟女 → 英文源 = milf（nhentai 串 / danbooru 串）',
    rowM.nh.q === 'milf' && rowM.termFor.nhentai === 'milf' && rowM.termFor.danbooru === 'milf' && rowM.genreKey === 'milf',
    JSON.stringify({ nh: rowM.nh.q, nhentai: rowM.termFor.nhentai, danbooru: rowM.termFor.danbooru, key: rowM.genreKey }));
  ok('② 熟女 → 中文源 = 熟女；日文源 = 熟女（不再落到 人妻）',
    rowM.termFor.jmcomic === '熟女' && rowM.jm.q === '熟女' && rowM.pixivTerm === '熟女',
    JSON.stringify({ jm: rowM.termFor.jmcomic, gwjm: rowM.jm.q, pixiv: rowM.pixivTerm }));

  /* ③ 回归：与本文件记录改前快照逐字节比对（tools/concept-snapshot-before.json） */
  const beforeFile = [path.join(__dirname, 'concept-snapshot-before.json'),
    path.join(__dirname, '_tmp_snapshot_before.json')].find(f => fs.existsSync(f));
  if (fs.existsSync(beforeFile)) {
    const before = JSON.parse(fs.readFileSync(beforeFile, 'utf8')).rows;
    const after = before.map(r => snapshotRow(HS, r.q));
    const diffs = [];
    before.forEach((b, i) => {
      const a = after[i];
      const bs = JSON.stringify(b), as = JSON.stringify(a);
      if (bs === as) return;
      const keys = Array.from(new Set(Object.keys(b).concat(Object.keys(a))));
      keys.forEach(k => {
        if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) {
          diffs.push(b.q + ' · ' + k + '\n    改前: ' + JSON.stringify(b[k]) + '\n    改后: ' + JSON.stringify(a[k]));
        }
      });
    });
    const frozen = ['中出', '无修', '巨乳', '寝取', '触手', 'full color', '脚'];
    const frozenDiff = diffs.filter(d => frozen.some(f => d.indexOf(f + ' · ') === 0));
    ok('③ 回归红线（' + frozen.join('/') + '）逐字节不变', frozenDiff.length === 0,
      frozenDiff.length ? '\n    ' + frozenDiff.join('\n    ') : before.length + ' 个查询全部比对');
    ok('③ 单关键词 fate / 明日方舟 / 编号直达 串与顺序不变',
      !diffs.some(d => /^(fate|明日方舟|123456) · /.test(d)),
      diffs.filter(d => /^(fate|明日方舟|123456) · /.test(d)).join(' | '));
    const other = diffs.filter(d => !/^(fate|明日方舟|123456) · /.test(d));
    if (!process.env.HS_CHECK_QUIET) {
      console.log('\n—— 全部差异（改前 → 改后，' + other.length + ' 条）——');
      other.forEach(d => console.log('  · ' + d));
    }
  } else {
    ok('③ 回归对比（缺改前快照）', false, '未找到 ' + beforeFile + '（先跑 snapshot 再改）');
  }

  /* ④ 保守化门槛（zh 槽位：copymanga / wnacg；jmcomic 见下面「已知不一致」） */
  const scope = gateScope(HS);
  ok('④ 门槛已生效（sources.js 暴露 S.ownZh）', scope.available, 'S.ownZh=' + typeof S.ownZh);
  const zhSrc = S.list.find(s => s.id === 'copymanga');
  const zhSrc2 = S.list.find(s => s.id === 'wnacg');
  const pos = S.termFor(zhSrc, 'mature female', { concept: u.conceptOf('mature female') });
  ok('④ 正例：有独立翻译的词不被别的别名覆盖（mature female 在中文站 = 成熟女性，不是 熟女）',
    pos === '成熟女性', 'termFor(copymanga, "mature female") = ' + JSON.stringify(pos));
  const neg = S.termFor(zhSrc, 'mature woman', { concept: u.conceptOf('mature woman') });
  ok('④ 反例：纯别名仍被正确替换（mature woman 在中文站 = 熟女）', neg === '熟女',
    'termFor(copymanga, "mature woman") = ' + JSON.stringify(neg));
  const neg2 = S.termFor(zhSrc, '已婚女性', { concept: u.conceptOf('已婚女性') });
  const neg2b = S.termFor(zhSrc2, '已婚女性', { concept: u.conceptOf('已婚女性') });
  ok('④ 反例2：拆出来的组里纯别名照常替换（已婚女性 → 人妻）', neg2 === '人妻' && neg2b === '人妻',
    'copymanga=' + JSON.stringify(neg2) + ' wnacg=' + JSON.stringify(neg2b));
  const posEn = S.termFor(S.list.find(s => s.id === 'nhentai'), 'mature female', { concept: u.conceptOf('mature female') });
  ok('④ 门槛不动 en 槽位（mature female 在英文站仍是 milf）', posEn === 'milf', JSON.stringify(posEn));
  const posJa = S.termFor(S.list.find(s => s.id === 'pixiv'), 'full color', { concept: u.conceptOf('full color') });
  ok('④ 门槛不动 ja 槽位（full color 在 Pixiv 仍是 フルカラー）', posJa === 'フルカラー', JSON.stringify(posJa));
  const noFire = ['中出', '无修', '巨乳', '寝取', '触手', '脚', 'full color'].map(w => {
    const cc = u.conceptOf(w);
    const src = S.list.find(s => s.id === 'copymanga');
    const was = cc ? (cc.zh || cc.en) : w;              /* 组原本要发的 zh 词 */
    const now = S.termFor(src, w, { concept: cc });
    return { 词: w, 原本: was, 现在: now, 门槛触发: !!(cc && was !== now) };
  });
  ok('④ 门槛不误伤回归红线的中文词（一条都不该触发）',
    noFire.filter(x => x.门槛触发).length === 0, JSON.stringify(noFire));
  /* 门槛影响面：全部会改写的词都列出来（改前 → 改后），供人工复核 */
  if (!process.env.HS_CHECK_QUIET) {
    console.log('\n—— 保守化门槛影响面（zh 槽位，共 ' + scope.hits.length + ' 条）——');
    scope.hits.forEach(h => console.log('  · ' + h.q + '（组 ' + h.group + '）：' + h.was + ' → ' + h.now));
  }

  /* ⑤ 黑话提示目标：assets/dict/core.js 的词条只产提示，但提示的目标词必须指向
     修好之后的概念组。这里按 index.html 的脚本顺序（含 assets/dict/core.js 与
     dict-hint.js）再起一个真实环境，问 HS.dict.lookup —— 就是用户 0 结果时看到的
     那个 chip 的 data-q。 */
  const env2 = loadSite([
    'assets/js/core.js', 'assets/js/dict.js', 'assets/dict/core.js', 'assets/js/dict-hint.js',
    'assets/js/net.js', 'assets/js/sources.js'
  ]);
  const HS2 = env2.HS;
  const lkH = (HS2.dict && typeof HS2.dict.lookup === 'function') ? HS2.dict.lookup('人妻') : null;
  const hitsH = (lkH && lkH.hits) || [];
  const hitH = hitsH.filter(h => h.from === '人妻');
  ok('⑤ 黑话 lookup：dict-hint 真跑起来能命中「人妻」词条', hitH.length >= 1,
    JSON.stringify({ hits: hitsH.map(h => ({ from: h.from, to: h.to, label: h.label, hintQuery: h.hintQuery })) }));
  ok('⑤ 人妻 的提示目标 = hitozuma（不再是 milf）',
    hitH.length >= 1 && hitH.every(h => h.to && h.to.concept === 'hitozuma'),
    hitH.map(h => 'to=' + JSON.stringify(h.to)).join(' | '));
  ok('⑤ 人妻 的提示词（chip 的 data-q）不再含 熟女/milf/mature',
    hitH.length >= 1 && hitH.every(h => !banned.test(String(h.hintQuery || '')) &&
      !banned.test(String(h.label || '')) && h.hintQuery === '人妻'),
    hitH.map(h => 'label=' + h.label + ' hintQuery=' + h.hintQuery).join(' | '));
  ok('⑤ 人妻 词条仍是兜底档（ambiguous=true，不主动弹）',
    hitH.length >= 1 && hitH.every(h => h.ambiguous === true),
    hitH.map(h => 'ambiguous=' + h.ambiguous).join(' | '));

  /* ⑥ 概念组结构一致性：zha/en/ja 三个槽位值都必须能在自己的 aliases 里够着。
     上一轮审计发现两处「够不着的槽」——cuckold.ja=寝取られ男、skin.en=skin ——
     本轮补进各自 aliases；判据取最强的一种：**三个槽位逐个都要在 aliases 里**
     （改前只有这两组不满足，全表 0 例外，所以这条不变量成立且能长期看门）。 */
  const slotIssues = [];
  groups.forEach(g => {
    const al = (g.aliases || []).map(a => String(a).toLowerCase().trim());
    ['zh', 'en', 'ja'].forEach(sl => {
      const v = String(g[sl] == null ? '' : g[sl]).toLowerCase().trim();
      if (!v) slotIssues.push(g.key + ':缺' + sl);
      else if (al.indexOf(v) < 0) slotIssues.push(g.key + ':' + sl + '不在aliases(' + g[sl] + ')');
    });
  });
  ok('⑥ 结构：每组 zh/en/ja 三个槽位值都在自己的 aliases 里够得着', slotIssues.length === 0,
    slotIssues.length ? slotIssues.join('; ') : groups.length + ' 组全部通过（cuckold.ja / skin.en 已补进 aliases）');

  /* ⑦ segWord 护栏：多关键词查询里「按 concept 挑词」与 S.termFor 是同一类改写，
     护栏口径必须一致（zh 槽位：段自己有独立中文写法就用它自己的；纯别名照旧替换）。 */
  const intentOf = q => u.classifyQuery(q);
  const gwQ = (q, id) => S.gwQueryFor({ q: q, f: {}, intent: intentOf(q) }, id);
  const nhQ = q => S.nhQueryFor({ q: q, f: {}, intent: intentOf(q) });
  const copyPos = gwQ('mature female 中出', 'copymanga');
  ok('⑦ 正例（segWord / zh 槽）：自己有独立翻译的段不被组的规范词覆盖（mature female 中出 → 成熟女性 中出）',
    copyPos.q === '成熟女性 中出', 'copymanga=' + JSON.stringify(copyPos.q) + ' variants=' + JSON.stringify(copyPos.variants));
  ok('⑦ 护栏对全部 zh 槽位生效（jmcomic / wnacg 同为 成熟女性 中出）',
    gwQ('mature female 中出', 'jmcomic').q === '成熟女性 中出' &&
    gwQ('mature female 中出', 'wnacg').q === '成熟女性 中出',
    JSON.stringify({ jm: gwQ('mature female 中出', 'jmcomic').q, wnacg: gwQ('mature female 中出', 'wnacg').q }));
  const copyNeg = gwQ('mature woman 中出', 'copymanga');
  ok('⑦ 反例（segWord / zh 槽）：纯别名仍被正常替换（mature woman 中出 → 熟女 中出）',
    copyNeg.q === '熟女 中出', 'copymanga=' + JSON.stringify(copyNeg.q));
  const copyNeg2 = gwQ('已婚女性 中出', 'copymanga');
  ok('⑦ 反例2（segWord / zh 槽）：拆出的组里纯别名照常替换（已婚女性 中出 → 人妻 中出）',
    copyNeg2.q === '人妻 中出', 'copymanga=' + JSON.stringify(copyNeg2.q));
  ok('⑦ 护栏没把多关键词功能关掉（候选串阶梯仍有全段串 + 旧串末级）',
    copyPos.variants.length >= 2 && copyPos.variants[1] === 'mature female 中出',
    JSON.stringify(copyPos.variants));
  ok('⑦ 护栏不动 en 槽（mature female 中出 在 nhentai 仍是 milf creampie）',
    nhQ('mature female 中出').q === 'milf creampie', JSON.stringify(nhQ('mature female 中出').q));
  ok('⑦ 拆出的组在多关键词里逐字节不变（人妻 中出 在各 zh 槽仍是 人妻 中出）',
    gwQ('人妻 中出', 'copymanga').q === '人妻 中出' && gwQ('人妻 中出', 'jmcomic').q === '人妻 中出' &&
    gwQ('人妻 中出', 'wnacg').q === '人妻 中出',
    JSON.stringify({ copy: gwQ('人妻 中出', 'copymanga').q, jm: gwQ('人妻 中出', 'jmcomic').q, wnacg: gwQ('人妻 中出', 'wnacg').q }));

  /* ⑧ 2026-09 本轮拆出的 6 组：每组都要真的各用各的独立键（en 槽不再被相反 / 上位概念顶掉），
        并看住两条结构性不变量（改前全表成立、改后必须仍成立）：
          · 跨组重复别名 = 0 —— 同一个写法不能被两个组都声明（conceptIndex 先到先得，
            重复会让后一组的槽位彻底够不着）；
          · 三槽值必须都能被 conceptOf 找回本组（槽值不可达 = 0）。 */
  const srcOf = id => S.list.find(s => s.id === id);
  const tFor = (id, q) => S.termFor(srcOf(id), q, { concept: u.conceptOf(q) });
  const keyOf = q => { const c = u.conceptOf(q); return c ? c.key : null; };

  ok('⑧ femdom / maledom 各自成组：女攻 → en=femdom、男攻 → en=maledom（不再都是 domination）',
    keyOf('女攻') === 'femdom' && tFor('nhentai', '女攻') === 'femdom' && tFor('copymanga', '女攻') === '女攻' &&
    keyOf('男攻') === 'maledom' && tFor('nhentai', '男攻') === 'maledom' && tFor('copymanga', '男攻') === '男攻',
    JSON.stringify({ 女攻: [keyOf('女攻'), tFor('nhentai', '女攻'), tFor('copymanga', '女攻')], 男攻: [keyOf('男攻'), tFor('nhentai', '男攻'), tFor('copymanga', '男攻')] }));
  ok('⑧ femdom 的 ja 槽有仓库依据（女攻め，来自 core.js GENRES）；maledom 没有 ⇒ 填原词不改写',
    tFor('pixiv', '女攻') === '女攻め' && tFor('pixiv', '男攻') === '男攻',
    JSON.stringify({ 女攻: tFor('pixiv', '女攻'), 男攻: tFor('pixiv', '男攻') }));
  ok('⑧ femsub / malesub 各自成组：女受 → femsub、男受 → malesub（不再都是 submission）',
    keyOf('女受') === 'femsub' && tFor('nhentai', '女受') === 'femsub' && tFor('copymanga', '女受') === '女受' &&
    keyOf('男受') === 'malesub' && tFor('nhentai', '男受') === 'malesub' && tFor('copymanga', '男受') === '男受',
    JSON.stringify({ 女受: [keyOf('女受'), tFor('nhentai', '女受'), tFor('copymanga', '女受')], 男受: [keyOf('男受'), tFor('nhentai', '男受'), tFor('copymanga', '男受')] }));
  ok('⑧ 轮奸 走自己的英文键（en=gang rape，不再发 gangbang）；gangbang 仍发 gangbang（中文源发轮奸）',
    keyOf('轮奸') === 'gangrape' && tFor('nhentai', '轮奸') === 'gang rape' && tFor('copymanga', '轮奸') === '轮奸' &&
    keyOf('gangbang') === 'gangbang' && tFor('nhentai', 'gangbang') === 'gangbang' && tFor('copymanga', 'gangbang') === '轮奸',
    JSON.stringify({ 轮奸: [keyOf('轮奸'), tFor('nhentai', '轮奸'), tFor('copymanga', '轮奸')], gangbang: [keyOf('gangbang'), tFor('nhentai', 'gangbang'), tFor('copymanga', 'gangbang')] }));
  ok('⑧ giantess 拆出来后英文 / 日文站各用自己的写法（giantess / 女巨人），size difference 语义不受影响',
    keyOf('giantess') === 'giantess' && tFor('nhentai', 'giantess') === 'giantess' &&
    tFor('pixiv', 'giantess') === '女巨人' && tFor('copymanga', '女巨人') === '女巨人' &&
    keyOf('size difference') === 'sizedifference' && tFor('nhentai', 'size difference') === 'size difference',
    JSON.stringify({ giantess: [keyOf('giantess'), tFor('nhentai', 'giantess'), tFor('pixiv', 'giantess')], size: [keyOf('size difference'), tFor('nhentai', 'size difference')] }));
  ok('⑧ married woman 挂进 hitozuma（英文站不再发 married woman 原词，改发人妻）',
    keyOf('married woman') === 'hitozuma' && tFor('nhentai', 'married woman') === '人妻' &&
    tFor('mangadex', 'married woman') === '人妻' && tFor('copymanga', 'married woman') === '人妻',
    JSON.stringify([keyOf('married woman'), tFor('nhentai', 'married woman'), tFor('copymanga', 'married woman')]));

  const aliasOwner = {};
  groups.forEach(g => (g.aliases || []).forEach(a => {
    const k = String(a).toLowerCase().trim();
    if (k) (aliasOwner[k] = aliasOwner[k] || []).push(g.key);
  }));
  const collide = Object.keys(aliasOwner).filter(k => aliasOwner[k].length > 1);
  ok('⑧ 结构：没有跨组重复别名（同一写法只属于一个组）', collide.length === 0,
    collide.length ? collide.map(k => k + '→' + aliasOwner[k].join('+')).join('; ') : Object.keys(aliasOwner).length + ' 个写法全部唯一');
  const deadSlot = [];
  groups.forEach(g => ['zh', 'en', 'ja'].forEach(sl => {
    const v = String(g[sl] == null ? '' : g[sl]).toLowerCase().trim();
    const back = u.conceptOf(v);
    if (!back || back.key !== g.key) deadSlot.push(g.key + '.' + sl + '=' + g[sl] + '→' + (back ? back.key : 'null'));
  }));
  ok('⑧ 结构：三槽值都能被 conceptOf 找回本组（没有够不着的死槽）', deadSlot.length === 0,
    deadSlot.length ? deadSlot.join('; ') : groups.length + ' 组 3×' + groups.length + ' 个槽值全部可达');

  /* ① 加强证据：真实适配器发出的 URL（探针，不联网）里也不得出现禁词 */
  const urlsH = await upstreamUrls(HS, '人妻');
  const urlBlob = JSON.stringify(urlsH);
  ok('① 人妻：各源适配器真正发出的 URL 里不含 熟女/milf/mature', !banned.test(urlBlob),
    Object.keys(urlsH).map(id => id + '=' + urlsH[id].urls[0]).join('\n          '));
  const urlsM = await upstreamUrls(HS, '熟女');
  const dec = x => { try { return decodeURIComponent(String(x)); } catch (e) { return String(x); } };
  const mCopy = dec(urlsM.copymanga.urls[0] || ''), mNh = dec(urlsM.nhentai.urls[0] || ''), mPx = dec(urlsM.pixiv.urls[0] || '');
  ok('② 熟女：中文源 URL 带 熟女、英文源带 milf、Pixiv 带 熟女（不再带 人妻）',
    /熟女/.test(mCopy) && /milf/.test(mNh) && /熟女/.test(mPx) && !/人妻/.test(mPx),
    [mNh, mCopy, mPx].join('\n          '));

  console.log('\n================ 断言结果 ================');
  let fail = 0;
  results.forEach(r => {
    if (!r.pass) fail++;
    console.log((r.pass ? '  PASS  ' : '  FAIL  ') + r.name + (r.info ? '\n          ' + r.info : ''));
  });
  console.log('-----------------------------------------');
  console.log(fail ? (fail + ' 条断言失败') : '全部 ' + results.length + ' 条断言通过');
  process.exit(fail ? 1 : 0);
}

const QUERIES_TAIL_MARK = null;   /* 查询清单已提到文件顶部（main() 里引用） */

if (require.main === module) main();
module.exports = { boot, snapshotRow, upstreamUrls, auditFacts, gateScope, QUERIES };
