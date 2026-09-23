'use strict';
/* ==========================================================================
   tools/recent-check.js —— 「最近浏览」记账链路 + 顶栏角标的行为层断言
   --------------------------------------------------------------------------
   为什么要有它：用户报「最近浏览的图标就不显示红点数字了」。把 assets/js/recent.js
   逐行读完，静态链路（注入条件 / CSS / [hidden] / paintBadge 的调用点）**全部成立**：
     · index.html:55 的 #recent-btn 是空按钮 ⇒ btn.querySelector('svg') 为 null ⇒ 角标必被注入
     · style.css:1204 的 .hs-recent-badge 与 140 行 [hidden]{display:none!important} 都在
     · paintBadge() 在 init / add / remove / clearAll 四处都会被调用
   静态读代码证明不了「它真的会执行」，所以这里把**真的 recent.js** 装进一个极简 DOM
   里真的调一次，断言整条链：
     init 注入 → 0 条时隐藏 → 包装 openCard / reader.open 记账 → 角标计数 →
     localStorage 落盘 → 冷启动恢复 → 同一个作品再开只加 n 不加条数 → remove / clear →
     无 key 时用 source:id 兜底、两个都没有就不记
   用法：node tools/recent-check.js
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const out = [];
const ok = (name, pass, info) => out.push({ name: String(name), pass: !!pass, info: info == null ? '' : String(info) });
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const KEY = 'hs.recent.v1';

/* ---------------- 极简 DOM（只实现 recent.js 真正碰到的那些 API） ----------------
   关键点：innerHTML 要**真的解析**出子节点，否则 #recent-badge 永远找不到，
   测出来的「角标没出现」就是测具的假象而不是被测代码的行为。 */
function anyStub(name) {
  const fn = function () { return anyStub(name + '()'); };
  const p = new Proxy(fn, {
    get(t, k) {
      if (k === Symbol.toPrimitive || k === 'toString') return () => name;
      if (k === Symbol.toStringTag) return name;
      if (k === Symbol.iterator) return undefined;
      return anyStub(name + '.' + String(k));
    },
    set() { return true; },
    apply() { return anyStub(name + '()'); }
  });
  return p;
}

function matches(n, sel) {
  const s = String(sel || '');
  if (!s) return false;
  if (s[0] === '#') return n.attrs && n.attrs.id === s.slice(1);
  if (s[0] === '.') return n.classList.contains(s.slice(1));
  return n.tagName === s.toUpperCase();
}

function findIn(root, sel) {
  if (matches(root, sel)) return root;
  const stack = root.children.slice();
  while (stack.length) {
    const n = stack.shift();
    if (matches(n, sel)) return n;
    n.children.forEach(c => stack.push(c));
  }
  return null;
}

function parseInto(node, v) {
  node._html = String(v == null ? '' : v);
  node.children = [];
  const re = /<(span|b|svg|i|em)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(node._html))) {
    const c = el(m[1]);
    const at = m[2] || '';
    const cl = /class="([^"]*)"/.exec(at);
    if (cl) c.className = cl[1];
    const id = /id="([^"]*)"/.exec(at);
    if (id) c.attrs.id = id[1];
    if (/(^|\s)hidden(\s|$)/.test(at)) c.hidden = true;
    c.textContent = m[3];
    node.appendChild(c);
  }
}

function el(tag, cls) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [], attrs: {}, dataset: {}, style: {}, _listeners: {},
    className: cls || '', textContent: '', _hidden: false, _html: '',
    parentNode: null, isConnected: true, offsetWidth: 120, scrollTop: 0, scrollLeft: 0,
    get hidden() { return !!node._hidden; },
    set hidden(v) { node._hidden = !!v; if (v) node.attrs.hidden = ''; else delete node.attrs.hidden; },
    get id() { return node.attrs.id || ''; },
    set id(v) { node.attrs.id = String(v); },
    classList: {
      add(c) {
        String(c).split(/\s+/).forEach(x => { if (x && !node.classList.contains(x)) node.className = (node.className ? node.className + ' ' : '') + x; });
      },
      remove(c) { node.className = node.className.split(/\s+/).filter(x => x && x !== c).join(' '); },
      toggle(c, on) { if (on === undefined) on = !node.classList.contains(c); if (on) node.classList.add(c); else node.classList.remove(c); },
      contains(c) { return node.className.split(/\s+/).indexOf(c) >= 0; }
    },
    set innerHTML(v) { parseInto(node, v); },
    get innerHTML() { return node._html; },
    setAttribute(k, v) { node.attrs[k] = String(v); if (k === 'hidden') node._hidden = true; if (k === 'class') node.className = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(node.attrs, k) ? node.attrs[k] : null; },
    removeAttribute(k) { delete node.attrs[k]; if (k === 'hidden') node._hidden = false; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(node.attrs, k); },
    appendChild(c) { node.children.push(c); c.parentNode = node; c.isConnected = true; return c; },
    insertBefore(c) { node.children.unshift(c); c.parentNode = node; return c; },
    removeChild(c) { node.children = node.children.filter(x => x !== c); return c; },
    querySelector(sel) { return findIn(node, sel); },
    querySelectorAll() { return []; },
    addEventListener(t, f) { (node._listeners[t] = node._listeners[t] || []).push(f); },
    removeEventListener() {},
    dispatch(t, ev) {
      const e = Object.assign({
        type: t, target: node, currentTarget: node, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}
      }, ev || {});
      (node._listeners[t] || []).slice().forEach(f => f.call(node, e));
      return e;
    },
    contains(n) { return n === node || node.children.indexOf(n) >= 0; },
    closest() { return null; },
    focus() {}, blur() {}, click() { node.dispatch('click'); },
    getBoundingClientRect() { return { left: 900, top: 20, width: 120, height: 36, right: 1020, bottom: 56 }; },
    getContext() { return null; }
  };
  return node;
}

/* ---------------- 存储 / 环境 ---------------- */
function makeStore(seed) {
  const map = new Map(seed ? Object.keys(seed).map(k => [k, seed[k]]) : []);
  return {
    getItem: k => (map.has(String(k)) ? map.get(String(k)) : null),
    setItem: (k, v) => { map.set(String(k), String(v)); },
    removeItem: k => { map.delete(String(k)); },
    clear: () => map.clear(),
    _map: map,
    _dump() { const o = {}; map.forEach((v, k) => { o[k] = v; }); return o; }
  };
}

/** 造一个环境：DOM 里只有一个空的 #recent-btn（与 index.html:55 一致） */
function bootEnv(store) {
  const btn = el('button');
  btn.attrs.id = 'recent-btn';
  btn.className = 'hs-icon-btn';
  const roots = [btn];
  const doc = {
    readyState: 'complete', visibilityState: 'visible', hidden: false, title: '',
    documentElement: el('html'), head: el('head'), body: el('body'),
    createElement: t => el(t),
    createTextNode: t => ({ textContent: String(t) }),
    createDocumentFragment: () => el('#fragment'),
    getElementById: id => (btn.attrs.id === id ? btn : findIn(btn, '#' + id)),
    querySelector(sel) { return findIn(btn, sel); },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
    _roots: roots
  };

  const ctx = {
    document: doc,
    localStorage: store,
    console: { log() {}, warn() {}, error() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    navigator: { userAgent: 'recent-check/1.0' },
    location: { href: 'http://127.0.0.1:8788/', origin: 'http://127.0.0.1:8788', search: '', hash: '' },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: (f) => { try { f(0); } catch (e) {} return 1; },
    cancelAnimationFrame() {},
    innerWidth: 1280, innerHeight: 900, scrollY: 0, scrollTo() {}, devicePixelRatio: 1
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx; ctx.top = ctx;
  vm.createContext(ctx);

  vm.runInContext(read('assets/js/core.js'), ctx, { filename: 'assets/js/core.js' });
  const HS = ctx.HS;

  /* 真 recent.js 要包装的两个入口：用真签名的替身（返回值原样透传，才能断言包装没改语义） */
  const calls = { card: [], reader: [] };
  HS.results = { openCard: function (it) { calls.card.push(it && it.id); return 'card:' + (it && it.id); } };
  HS.reader = { open: function (it) { calls.reader.push(it && it.id); return 'rd:' + (it && it.id); } };
  vm.runInContext(read('assets/js/recent.js'), ctx, { filename: 'assets/js/recent.js' });

  return { ctx, HS, btn, calls, doc, store, badge: () => findIn(btn, '#recent-badge') };
}

const ITEM_A = { source: 'nhentai', id: '123456', key: 'nhentai:123456', title: '作品 A', url: 'https://nhentai.net/g/123456/', cover: 'https://t.nhentai.net/x.jpg', tags: ['a', 'b'] };
const ITEM_B = { source: 'wnacg', id: '777', title: '绅士作品 B', url: 'https://www.wnacg.com/photos-index-aid-777.html' };

function main() {
  /* ---------- 1. init 之前：空按钮里什么都没有 ---------- */
  {
    const e0 = bootEnv(makeStore());
    ok('真按钮是空的：init 前既没有 svg 也没有角标（与 index.html:55 一致）',
      e0.badge() === null && e0.btn.querySelector('svg') === null);
    ok('HS.recent 已注册，且 init 是函数', !!(e0.HS.recent && typeof e0.HS.recent.init === 'function'));
  }

  /* ---------- 2. init 之后：只注入图标（第 9 轮：用户要求去掉文字与条数角标） ---------- */
  const e = bootEnv(makeStore());
  const { HS, btn, calls } = e;
  HS.recent.init();

  ok('第 9 轮：按钮里只注入图标 svg（HS.icon.clock）',
    !!(btn.querySelector('svg') && btn.querySelector('svg').tagName === 'SVG'));
  ok('第 9 轮：**不再**注入条数角标 #recent-badge', e.badge() === null);
  ok('第 9 轮：**不再**注入「最近浏览」文字（按钮里没有 span）', btn.querySelector('span') === null);
  ok('第 9 轮：按钮不带 .hs-icon-btn-label（那是带文字/紫色底的按钮类，用户嫌「紫点」）',
    !btn.classList.contains('hs-icon-btn-label') && btn.classList.contains('hs-icon-btn'));

  /* ---------- 3. 包装：两个入口都记账，且不影响原返回值 ---------- */
  ok('openCard 被 recent.js 包装（__recentWrapped）', HS.results.openCard.__recentWrapped === 1);
  ok('reader.open 被 recent.js 包装（__recentWrapped）', HS.reader.open.__recentWrapped === 1);

  const rA = HS.results.openCard(ITEM_A);
  ok('包装后 openCard 的原返回值原样透传', rA === 'card:123456', rA);
  ok('开一张卡 ⇒ 记 1 条（面板数据源）', HS.recent.count() === 1, 'count=' + HS.recent.count());
  ok('原函数确实被调用了（包装没有吃掉调用）', calls.card.length === 1);

  const rB = HS.reader.open(ITEM_B);
  ok('包装后 reader.open 的原返回值原样透传', rB === 'rd:777', rB);
  ok('再在线阅读一篇（无 key，走 source:id 兜底）⇒ 2 条', HS.recent.count() === 2, 'count=' + HS.recent.count());

  /* ---------- 4. 同一个作品再开：只加计数 n，不加条数 ---------- */
  HS.results.openCard(ITEM_A);
  const dump = JSON.parse(e.store.getItem(KEY));
  ok('重复打开同一作品：条数仍是 2（按 key 去重）', HS.recent.count() === 2);
  ok('重复打开同一作品：该条的 n 增到 2', dump.items.filter(r => r.k === 'nhentai:123456')[0].n === 2);
  ok('落盘结构是 {v:1, items:[…]} 且每项有 k/ts/item', dump.v === 1 && dump.items.length === 2 &&
    dump.items.every(r => r.k && r.ts && r.item && r.item.title), JSON.stringify(dump).slice(0, 120));
  ok('落盘的条目保留了封面/标签等回头再看要用的字段',
    !!(dump.items.filter(r => r.k === 'nhentai:123456')[0].item.cover) &&
    dump.items.filter(r => r.k === 'nhentai:123456')[0].item.tags.length === 2);

  /* ---------- 5. 冷启动恢复：同一个 localStorage 重新装一遍 ---------- */
  {
    const e2 = bootEnv(makeStore(e.store._dump()));
    e2.HS.recent.init();
    ok('冷启动（同一 localStorage）后立刻恢复 2 条 —— 不需要先点一次',
      e2.HS.recent.count() === 2, 'count=' + e2.HS.recent.count());
    ok('冷启动后按钮同样只有图标、没有角标（第 9 轮口径）',
      !!e2.btn.querySelector('svg') && e2.badge() === null);
  }

  /* ---------- 6. remove / clear ---------- */
  ok('remove(存在的 key) 返回 true，条数减到 1',
    HS.recent.remove('nhentai:123456') === true && HS.recent.count() === 1);
  HS.recent.clear();
  ok('clear 之后条数归零（按钮上也没有任何数字要藏）', HS.recent.count() === 0);
  ok('clear 之后落盘里也空了',
    JSON.parse(e.store.getItem(KEY)).items.length === 0);

  /* ---------- 7. 兜底规则（recOf 的 key 推导：key → source:id/url/title） ---------- */
  /* 7a. source/id/url/title 一个都没有 ⇒ 拼出来就是「冒号空 key」⇒ 明确不记 */
  HS.results.openCard({ cover: 'https://x/y.jpg' });
  ok('没有 key、也没有 source/id/url/title 的条目**不**记账（key 退化成「:」）',
    HS.recent.count() === 0);

  /* 7b. 只有标题也能记（title 也参与兜底）—— 这是既有契约，写下来免得日后被当成 bug */
  HS.results.openCard({ title: '只有标题' });
  ok('只有 title 的条目会记成 ":只有标题"（title 参与兜底，属既有契约）',
    HS.recent.count() === 1 &&
    !!JSON.parse(e.store.getItem(KEY)).items.filter(r => r.k === ':只有标题')[0],
    'count=' + HS.recent.count());

  /* 7c. 脏输入不许抛 */
  HS.recent.clear();
  let threw = '';
  try { HS.results.openCard(null); HS.results.openCard(undefined); HS.results.openCard('字符串'); } catch (err) { threw = err && err.message; }
  ok('null / undefined / 非对象直接调用不抛异常也不记账', !threw && HS.recent.count() === 0, threw);

  /* ---------- 8. 第 9 轮口径：按钮被别的代码重写过也只会是纯图标 ---------- */
  {
    const e3 = bootEnv(makeStore());
    e3.btn.innerHTML = '<svg viewBox="0 0 24 24"></svg><span>最近浏览</span>';
    e3.HS.recent.init();
    ok('按钮里已有 svg 时：不再往里塞角标，也不会把文字/紫色底类补回来',
      e3.badge() === null && !e3.btn.classList.contains('hs-icon-btn-label'));
    e3.HS.recent.add(ITEM_A);
    ok('记账本身不依赖按钮 DOM（加了角标逻辑已删，条数照样落盘）',
      e3.HS.recent.count() === 1 && !!JSON.parse(e3.store.getItem(KEY)).items.length);
    ok('全程没有任何节点被追加成 #recent-badge（旧实现会自愈出角标）', e3.badge() === null);
  }

  /* ---------- 汇总 ---------- */
  const fail = out.filter(x => !x.pass);
  out.forEach(x => {
    console.log((x.pass ? 'PASS  ' : 'FAIL  ') + x.name + (x.pass || !x.info ? '' : '   ← ' + x.info));
  });
  console.log('');
  if (fail.length) {
    console.log(fail.length + ' 条断言失败（共 ' + out.length + ' 条）');
    process.exit(1);
  }
  console.log('全部 ' + out.length + ' 条断言通过');
}

if (require.main === module) main();
module.exports = { main };
