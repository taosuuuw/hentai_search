#!/usr/bin/env node
/*
 * 检索词召回 / 命中质量探针
 * ---------------------------------------------------------------------------
 * 固化 LESSONS §4 的那条配方：「换说法 ≠ 涨召回」——改词表、排别名顺序之前，
 * 先拿同一个词打到多个上游，把**真实条数 + 前几条标题 / 标签**量出来，用数据挑词。
 *
 * 只读网关（默认 http://127.0.0.1:8788），零依赖，不发任何写请求。
 *
 * 用法：
 *   node tools/alias-probe.js --terms "suspended|standing sex|雌悬浮|日不落"
 *   node tools/alias-probe.js --preset suspended            # 内置相关词全集
 *   node tools/alias-probe.js --preset suspended --sources nhentai,jm,wnacg
 *   node tools/alias-probe.js --preset suspended --top 6 --json
 *   node tools/alias-probe.js --gw http://127.0.0.1:8789 --preset suspended
 *
 * 输出：每个（源 × 词）一行摘要 + 前 N 条标题（标签站带上标签，便于判断「是不是真的
 * 命中这个概念」），最后一张「源 × 词 → 条数」的总表。
 */
'use strict';

const GW_DEFAULT = 'http://127.0.0.1:8788';

/* 源 → 网关路由 + 该源的语种口径（与前端 TAG_LANG 同口径） */
const SOURCES = {
  nhentai: { path: '/api/nhentai/search', lang: 'en' },
  ehentai: { path: '/api/ehentai/search', lang: 'en' },
  kemono: { path: '/api/kemono/search', lang: 'en' },
  pixiv: { path: '/api/pixiv/search', lang: 'ja' },
  jm: { path: '/api/jm/search', lang: 'zh' },
  wnacg: { path: '/api/wnacg/search', lang: 'zh' },
  copymanga: { path: '/api/copymanga/search', lang: 'zh' },
  lectormanga: { path: '/api/lectormanga/search', lang: 'es' }
};

/* 内置预设：一个概念的候选说法（中 / 英 / 日） */
const PRESETS = {
  suspended: [
    'suspended', 'standing sex', 'suspended congress', 'carrying', 'carried',
    'held up', 'airborne', 'midair', 'off the ground', 'feet off ground',
    '抱え上げ', '宙吊り', '立ちバック', '中出し',
    '雌悬浮', '日不落', '悬空', '抱起', '脚离地'
  ]
};

function parseArgs(argv) {
  const out = { terms: null, preset: null, sources: null, top: 8, json: false, gw: GW_DEFAULT, timeout: 25000 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--terms') out.terms = String(val() || '').split('|').map(s => s.trim()).filter(Boolean);
    else if (a === '--preset') out.preset = val();
    else if (a === '--sources') out.sources = String(val() || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--top') out.top = Math.max(0, parseInt(val(), 10) || 0);
    else if (a === '--timeout') out.timeout = parseInt(val(), 10) || out.timeout;
    else if (a === '--gw') out.gw = String(val() || GW_DEFAULT).replace(/\/+$/, '');
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function clip(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

async function callGw(gw, path, params, timeout) {
  const u = gw + path + '?' + new URLSearchParams(params).toString();
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(u, { signal: ctl.signal, headers: { accept: 'application/json' } });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* 非 JSON：当成错误文本 */ }
    return { ms: Date.now() - t0, status: res.status, data: data, text: text };
  } catch (e) {
    return { ms: Date.now() - t0, status: 0, data: null, text: '', error: (e && e.message) || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/* 从各源形态里取出条目数组 + 官方条数（能取到就用官方的，取不到用数组长度） */
function normalize(data) {
  if (!data || typeof data !== 'object') return { items: [], total: null, error: '' };
  const list = Array.isArray(data.items) ? data.items
    : Array.isArray(data.results) ? data.results
      : Array.isArray(data.data) ? data.data : [];
  const total = Number.isFinite(data.count) ? data.count
    : Number.isFinite(data.total) ? data.total
      : Number.isFinite(data.true_count) ? data.true_count : null;
  return { items: list, total: total, error: String(data.error || '') };
}

async function main() {
  const opt = parseArgs(process.argv);
  if (opt.help) {
    console.log('usage: node tools/alias-probe.js [--terms "a|b"] [--preset suspended] [--sources nhentai,jm] [--top N] [--json] [--gw URL]');
    return 0;
  }
  const terms = opt.terms || (opt.preset ? PRESETS[opt.preset] : null);
  if (!terms || !terms.length) {
    console.error('没有词：给 --terms "a|b" 或 --preset ' + Object.keys(PRESETS).join('/'));
    return 2;
  }
  const names = opt.sources && opt.sources.length ? opt.sources : Object.keys(SOURCES);
  const bad = names.filter(n => !SOURCES[n]);
  if (bad.length) { console.error('未知源：' + bad.join(',') + '（可用：' + Object.keys(SOURCES).join(',') + '）'); return 2; }

  const report = [];
  for (const name of names) {
    const src = SOURCES[name];
    for (const term of terms) {
      const params = { q: term, page: '1' };
      if (name === 'jm') params.o = 'mr';
      const r = await callGw(opt.gw, src.path, params, opt.timeout);
      const nz = normalize(r.data);
      const row = {
        source: name, lang: src.lang, term: term, ms: r.ms, status: r.status,
        ok: !!(r.data && r.data.ok !== false) && !r.error && !nz.error,
        n: nz.items.length, total: nz.total,
        error: r.error || nz.error || (r.data && r.data.ok === false ? 'ok:false' : ''),
        items: nz.items.slice(0, opt.top).map(it => ({
          title: clip(it.title, 90),
          tags: Array.isArray(it.tags) ? it.tags.filter(t => t && !/^\d+$/.test(String(t))).slice(0, 8) : [],
          artist: clip(it.artist, 40), year: it.year || '', source: it.source || name
        }))
      };
      report.push(row);
      if (!opt.json) {
        console.log('[' + name + '/' + src.lang + '] "' + term + '" ok=' + (row.ok ? 1 : 0) +
          ' n=' + row.n + (row.total != null ? '/' + row.total : '') + ' ms=' + row.ms +
          (row.error ? '  ERR=' + clip(row.error, 60) : ''));
        row.items.forEach(it => {
          console.log('    - ' + it.title +
            (it.tags.length ? '  [tags: ' + it.tags.join(', ') + ']' : '') +
            (it.artist ? '  @' + it.artist : ''));
        });
      }
    }
  }

  if (opt.json) {
    console.log(JSON.stringify({ gw: opt.gw, terms: terms, sources: names, rows: report }, null, 2));
    return 0;
  }

  /* 总表：源 × 词 → 条数 */
  console.log('\n== 条数总表 ==');
  const head = ['term'.padEnd(20)].concat(names.map(n => n.slice(0, 9).padStart(9))).join('');
  console.log(head);
  terms.forEach(t => {
    const cells = names.map(n => {
      const row = report.find(r => r.source === n && r.term === t);
      if (!row) return '-'.padStart(9);
      return String(row.ok ? row.n : 'x').padStart(9);
    });
    console.log(t.padEnd(20) + cells.join(''));
  });
  return 0;
}

main().then(code => process.exit(code)).catch(e => { console.error('probe failed: ' + ((e && e.stack) || e)); process.exit(1); });
