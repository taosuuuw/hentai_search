#!/usr/bin/env node
/*
 * 「这一次检索到底给每个源发了什么词」检查器
 * ---------------------------------------------------------------------------
 * 固化两条踩过的坑：
 *   ① 改完词表 / 别名顺序 / 补路逻辑，「代码变了但发出去的串没变」是常态
 *      （LESSONS §3-13：srcId 放错层 ⇒ lane 一条都不生效）；
 *   ② 直连路径与网关路径的选择词口径**不是同一段代码**，只测一条会得出错误结论。
 *
 * 做法：用 tools/concept-check-shim.js 把真实脚本装进 vm，把网关调用换成假实现
 * （每次返回 1 条 ⇒ 主路永远凑不够条数 ⇒ 补路一定会发），记录每个源实际发出的 q 序列。
 * 纯本地、不联网、不改任何站点文件。
 *
 * 用法：
 *   node tools/query-send-check.js               # 默认测 日不落 / 雌悬浮 / 露出 / 人妻
 *   node tools/query-send-check.js 雌悬浮 明日方舟
 *   node tools/query-send-check.js --items 7 日不落    # 假实现每次返回几条
 */
'use strict';
const { loadSite } = require('./concept-check-shim.js');

const args = process.argv.slice(2).filter(a => !/^--/.test(a));
let N = 1;
const iItems = process.argv.indexOf('--items');
if (iItems >= 0) N = Math.max(1, parseInt(process.argv[iItems + 1], 10) || 1);
const QUERIES = args.length ? args : ['日不落', '雌悬浮', '露出', '人妻'];

async function run(q) {
  const env = loadSite(['assets/js/core.js', 'assets/js/dict.js', 'assets/js/net.js', 'assets/js/sources.js']);
  const HS = env.HS;
  const calls = [];
  /* 让 jm / wnacg / 拷贝 走**网关**这条路：直连在 harness 里必然失败，
     失败就没有「主路结果」，补路也就不会发 —— 只看直连会误判成「补路没生效」。 */
  HS.net.gateway.ok = true;
  HS.net.gateway.base = 'http://127.0.0.1:8788';
  HS.net.gateway.get = async function (path, params) {
    calls.push({ via: 'gateway', path: path, q: String((params || {}).q == null ? '' : params.q) });
    if (path === '/api/jm/hosts') return { hosts: [] };
    const items = [];
    for (let i = 0; i < N; i++) {
      items.push({
        id: 'fake-' + calls.length + '-' + i, title: 'fake ' + calls.length + '-' + i,
        url: 'https://example.invalid/x', cover: '', tags: []
      });
    }
    return { ok: true, source: 'fake', items: items };
  };
  HS.net.fetchSource = async function (url) {
    calls.push({ via: 'direct', path: 'fetchSource', q: String(url) });
    throw new Error('harness: 直连已禁用');   /* 只验证网关路径的串 */
  };

  const intent = HS.u.classifyQuery(q);
  await HS.sources.run({
    q: q, filters: {}, limit: 7, page: 1, capMs: 0, intent: intent
  });

  const bySrc = {};
  calls.forEach(c => { (bySrc[c.path] = bySrc[c.path] || []).push(c.q); });
  console.log('=== q="' + q + '"  kind=' + intent.kind
    + '  concept=' + ((intent.concept && intent.concept.zh) || '-')
    + '  第二中文标签=' + ('"' + HS.sources.zhAliasLane(intent) + '"'));
  Object.keys(bySrc).forEach(p => {
    if (p === 'fetchSource') return;
    const list = bySrc[p];
    console.log('    ' + p.padEnd(24) + ' ← ' + JSON.stringify(list)
      + (list.length > 1 ? '   （第 1 个是主路，后面是补路）' : ''));
  });
}

(async () => {
  for (const q of QUERIES) await run(q);
  process.exit(0);
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
