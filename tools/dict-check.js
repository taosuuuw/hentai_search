/* ==========================================================================
   dict-check.js — 黑话提示泡泡（第 7 轮 ④）的分层验证，零依赖、不打上游。
   --------------------------------------------------------------------------
   用法（仓库根目录）：
     node tools/dict-check.js
     node tools/check-all.js          ← 也会带上这一套

   为什么要有它：
    用户报「打『图图』这种黑称词典里记载的词，黑话提示泡泡不出现」。查下来是两件事：
       A) 词典侧：`图图` 是 IP 包（assets/dict/ip/arknights.json）里的词条，核心层没有 ——
          必须走「命中锚点 → 懒加载 IP 包 → 重算」这条异步链路才有命中。这条链路以前
          没有任何自动化证据，只能靠人肉在浏览器里试。
       B) 应用侧：`slangLookup` 以前只在 doSearch（提交检索）里被调用一次，
          **打字过程中根本不查词典** —— 所以联想列表都出来了，泡泡一个都不会有。
          病根是那一行 input 监听被写在 `slangBind()` 里，而 slangBind 只有泡泡**首次创建**
          时才跑（slangBox ← slangPaint ← slangRefresh，而 slangRefresh 过去只在提交检索后
          调用）⇒ 冷启动时那段代码从来没执行过，监听从未注册。
          本轮把它挪到 `slangWatchInput()`，在 `bind()` 里**无条件**挂一次
          （防抖 180ms + IME 组字守卫）。
    三层证据，各自防一种「假绿」：
      A 词典层：真 vm + 真 assets/dict/**，fetch 只读仓库文件，一个上游都不打；
      B 静态层：钉住 app.js 的接线与守卫（防止有人把这行挪回去 / 去掉守卫）；
      C 行为层：把**真 app.js 装进极简 DOM 里打字**，端到端证明「打字 → 懒加载 IP 包 →
        泡泡真的被画出来」。为什么非要 C：静态断言只能证明「代码写了」，证明不了「跑起来会
        执行」，而本轮的病根恰恰就是「代码写了但那段永远没被执行」。
        这个沙箱的判别力已用 A/B 实测过：HEAD 版 #q 上只有 1 个 input 监听（清空钮那条）、
        打字 mrfz / 图图 都不出泡泡；改完是 2 个监听，两个词都出。
    ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadSite, makeEnv } = require('./concept-check-shim.js');

const ROOT = path.resolve(__dirname, '..');

const out = [];
const ok = (name, pass, info) => out.push({ name: name, pass: !!pass, info: info == null ? '' : String(info) });
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** 去掉注释后再断言：注释里写过的词不该算「代码里有」 */
function codeOnly(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
/** 取出一个具名函数的函数体（丢配花括号，够本仓库用） */
function fnBody(src, name) {
  const m = new RegExp('function ' + name + '\\s*\\(').exec(src);
  if (!m) return '';
  const i = src.indexOf('{', m.index);
  if (i < 0) return '';
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (!depth) return src.slice(i, j + 1); }
  }
  return '';
}

/* 词典沙箱：与 index.html 相同的脚本顺序，fetch 改成「只读仓库里的文件」 */
const env = loadSite([
  'assets/js/core.js', 'assets/js/dict.js', 'assets/dict/core.js',
  'assets/js/dict-hint.js', 'assets/js/net.js'
]);
env.fetch = function (url) {
  const rel = String(url).replace(/^\.?\//, '').split('?')[0];
  try {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    return Promise.resolve({
      ok: true, status: 200,
      text: () => Promise.resolve(text),
      json: () => Promise.resolve(JSON.parse(text))
    });
  } catch (e) {
    return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve(''), json: () => Promise.reject(e) });
  }
};
const HS = env.HS;

/* ==========================================================================
   行为层沙箱：真 app.js 装进极简 DOM
   node 里没有真 DOM，这里只造出 app.js 用到的那点形状（元素 / 属性 / 事件监听 /
   几何），词典 JSON 仍从磁盘读 —— 于是「打字 → 懒加载 IP 包 → 重画泡泡」走的全是
   真实代码路径。注意：DOM 必须在装脚本**之前**装好，否则 core.js 会把 stub 的
   document 记进闭包，后面 u.$() 拿到的东西就全是假的。
   ========================================================================== */
/** 任何没实现的接口都返回一个「什么都吃、什么都能当」的桩 */
function anyStub(name) {
  const t = function () { return anyStub(name + '()'); };
  return new Proxy(t, {
    get(_, k) {
      if (k === 'then') return undefined;
      if (k === Symbol.toPrimitive) return () => '';
      if (k === Symbol.toStringTag) return name;
      if (k === Symbol.iterator) return undefined;
      return anyStub(name + '.' + String(k));
    },
    set() { return true; },
    apply() { return anyStub(name + '()'); }
  });
}

function el(tag, cls) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [], attrs: {}, dataset: {}, style: {}, _listeners: {}, _q: new Map(),
    className: cls || '', textContent: '', value: '', isConnected: true, offsetWidth: 220,
    _hidden: false, _html: '',
    classList: {
      add(c) { node.className = (node.className ? node.className + ' ' : '') + c; },
      remove(c) { node.className = node.className.split(/\s+/).filter(x => x && x !== c).join(' '); },
      toggle(c, on) { if (on) node.classList.add(c); else node.classList.remove(c); },
      contains(c) { return node.className.split(/\s+/).indexOf(c) >= 0; }
    },
    set hidden(v) { node._hidden = !!v; if (v) node.attrs.hidden = 'true'; else delete node.attrs.hidden; },
    get hidden() { return !!node._hidden; },
    set innerHTML(v) {
      node._html = String(v == null ? '' : v);
      const re = /class="([^"]+)"/g; let m;
      while ((m = re.exec(node._html))) {
        m[1].split(/\s+/).forEach(c => { if (c && !node._q.has('.' + c)) node._q.set('.' + c, el('span', c)); });
      }
    },
    get innerHTML() { return node._html; },
    setAttribute(k, v) { node.attrs[k] = String(v); if (k === 'hidden') node._hidden = true; if (k === 'class') node.className = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(node.attrs, k) ? node.attrs[k] : null; },
    removeAttribute(k) { delete node.attrs[k]; if (k === 'hidden') node._hidden = false; },
    appendChild(c) { node.children.push(c); c.parentNode = node; c.isConnected = true; return c; },
    insertBefore(c) { node.children.unshift(c); c.parentNode = node; return c; },
    removeChild(c) { node.children = node.children.filter(x => x !== c); return c; },
    querySelector(sel) { if (!node._q.has(sel)) node._q.set(sel, el('div')); return node._q.get(sel); },
    querySelectorAll() { return []; },
    addEventListener(t, f) { (node._listeners[t] = node._listeners[t] || []).push(f); },
    removeEventListener() {},
    contains(n) { return n === node || node.children.indexOf(n) >= 0; },
    closest() { return null; },
    focus() {}, blur() {}, click() { node.dispatch('click'); },
    getContext() { return null; },
    getBoundingClientRect() { return { left: 80, top: 40, width: 620, height: 44, right: 700, bottom: 84 }; },
    dispatch(t, ev) {
      const e = Object.assign({
        type: t, target: node, isComposing: false, inputType: 'insertText', key: '', keyCode: 0,
        preventDefault() { e.defaultPrevented = true; }, stopPropagation() {}, stopImmediatePropagation() {},
        defaultPrevented: false
      }, ev || {});
      (node._listeners[t] || []).slice().forEach(f => {
        try { f.call(node, e); } catch (err) { console.log('  [listener 抛异常]', t, err && err.message); }
      });
      return e;
    }
  };
  return node;
}

function installDom(target) {
  const bySel = new Map();
  const docListeners = {};
  const doc = {
    readyState: 'loading',
    documentElement: el('html'), head: el('head'), body: el('body'),
    title: '', visibilityState: 'visible', hidden: false, activeElement: null,
    createElement: t => el(t), createTextNode: t => ({ textContent: String(t) }),
    createDocumentFragment: () => el('#fragment'),
    querySelector(sel) {
      /* 真实页面里 <form id="search-form" class="hs-searchbar"> 是**同一个**节点：
         泡泡挂在 .hs-searchbar 上，提交监听挂在 #search-form 上，这里必须别名共享。 */
      const alias = (sel === '#search-form') ? '.hs-searchbar' : (sel === '.hs-searchbar' ? '#search-form' : null);
      if (alias && bySel.has(alias)) return bySel.get(alias);
      if (!bySel.has(sel)) bySel.set(sel, el(sel === '#q' ? 'input' : 'div'));
      if (alias && !bySel.has(alias)) bySel.set(alias, bySel.get(sel));
      return bySel.get(sel);
    },
    querySelectorAll() { return []; },
    getElementById(id) { return doc.querySelector('#' + id); },
    addEventListener(t, f) { (docListeners[t] = docListeners[t] || []).push(f); },
    removeEventListener() {},
    dispatch(t, ev) {
      const e = Object.assign({ type: t, target: doc, preventDefault() {}, stopPropagation() {} }, ev || {});
      (docListeners[t] || []).slice().forEach(f => { try { f(e); } catch (err) { console.log('  [doc listener 抛异常]', t, err && err.message); } });
      return e;
    }
  };
  target.document = new Proxy(doc, { get(t, k) { if (k in t) return t[k]; return anyStub('document.' + String(k)); } });
  target.getComputedStyle = () => ({ font: '12.5px sans', fontFamily: 'sans', fontSize: '12.5px', fontStyle: 'normal', fontWeight: '400', letterSpacing: 'normal' });
  target.innerWidth = 1280; target.innerHeight = 800; target.devicePixelRatio = 1;
  target.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  target.addEventListener = () => {}; target.removeEventListener = () => {};
  target.MutationObserver = function () { return { observe() {}, disconnect() {} }; };
  target.ResizeObserver = function () { return { observe() {}, disconnect() {} }; };
  target.IntersectionObserver = function () { return { observe() {}, disconnect() {}, unobserve() {} }; };
  target.HTMLCanvasElement = function () {};
  return { doc: doc, bySel: bySel };
}

const env2 = makeEnv();
const dom2 = installDom(env2);
env2.fetch = env.fetch;                 /* 同一套「只读仓库文件」的 fetch */
['assets/js/core.js', 'assets/js/dict.js', 'assets/dict/core.js', 'assets/js/dict-hint.js', 'assets/js/app.js']
  .forEach(rel => vm.runInContext(read(rel), env2, { filename: rel }));
const HS2 = env2.HS;
['chain', 'filtersUI', 'results', 'panic', 'fav', 'recent', 'settingsUI', 'totop', 'sources', 'net',
  'reader', 'cardtags', 'suggest', 'xlate', 'filters', 'gateway'].forEach(k => {
  if (HS2 && !HS2[k]) HS2[k] = anyStub('HS.' + k);      /* 只跑黑话这条链，别的模块给桩 */
});
if (HS2) {
  if (!HS2.bus) HS2.bus = anyStub('HS.bus');
  if (!HS2.store) HS2.store = anyStub('HS.store');
  HS2.settings = HS2.settings || {};
  HS2.settings.adultOk = true;                          /* 跳过成年确认闸门 */
}

async function main() {
  /* ------------------------- A. 词典侧（真文件） ------------------------- */
  const DICT = HS && HS.dict;
  ok('词典层可用：HS.dict.lookup / load / pick / tier 都挂上了（沙箱里装的是真脚本）',
    !!(DICT && typeof DICT.lookup === 'function' && typeof DICT.load === 'function'
      && typeof DICT.pick === 'function' && typeof DICT.tier === 'function'));

  if (DICT) {
    /* A1 图图 首轮：词条在 IP 包里，没拉包 → hits 空 + pending 点名 arknights */
    const first = DICT.lookup('图图');
    ok('图图 · 首轮：hits 为空但 pending 里有 arknights（黑话在 IP 包里，必须走懒加载）',
      first.hits.length === 0 && Array.isArray(first.pending) && first.pending.indexOf('arknights') >= 0,
      'hits=' + JSON.stringify(first.hits) + ' pending=' + JSON.stringify(first.pending));

    /* A2 补包后：必须命中「阿尔图罗」这个角色（hintQuery=virtuosa） */
    try {
      await Promise.all(first.pending.map(id => DICT.load(id)));
    } catch (e) {
      ok('图图 · 补包：DICT.load(arknights) 不抛错', false, String((e && e.message) || e));
    }
    const r2 = DICT.lookup('图图');
    const h2 = r2.hits || [];
    const hit = h2.filter(h => h && h.hintQuery === 'virtuosa')[0];
    ok('图图 · 补包后命中阿尔图罗（hintQuery=virtuosa）—— 泡泡有东西可画',
      !!hit, 'hits=' + JSON.stringify(h2).slice(0, 400));
    ok('图图 · 主动档：pick(hits,"active",2) 至少 1 条（对应泡泡的「理解为」分支）',
      DICT.pick(h2, 'active', 2).length >= 1,
      'tiers=' + JSON.stringify(DICT.pick(h2, 'active', 2).map(h => DICT.tier(h))));
    ok('图图 · 角色字段：命中项带 to.character（results.js 的角色优先排序也读它）',
      !!(hit && hit.to && hit.to.character), hit ? 'to=' + JSON.stringify(hit.to).slice(0, 240) : 'no hit');

    /* A3 后缀不遮蔽整串 */
    const jie = DICT.lookup('图图姐');
    ok('图图姐 · 同样命中 virtuosa（后缀「姐」不遮蔽整串判定）',
      (jie.hits || []).some(h => h && h.hintQuery === 'virtuosa'),
      JSON.stringify(jie.hits || []).slice(0, 300));

    /* A4 噪声：共享「图」字不等于黑话 */
    const noise = ['图片', '图表', '图书', '图书馆', '图'];
    const bad = noise.filter(w => (DICT.lookup(w).hits || []).length > 0);
    ok('噪声：图片 / 图表 / 图书 / 图书馆 / 图 零命中（不能因为共享「图」字就弹泡泡）',
      bad.length === 0, '误命中=' + JSON.stringify(bad));

    /* A5 对照组：核心层词条不需要补包，首轮就该命中 ——
       用来区分「词典层坏」与「IP 包懒加载路径坏」 */
    const coreWords = ['mrfz', '牛头人', 'ntr', '雌悬浮'];
    const coreHit = coreWords.filter(w => (DICT.lookup(w).hits || []).length > 0);
    ok('对照组：核心层黑话（无需补包）首轮直接命中',
      coreHit.length > 0, '命中=' + JSON.stringify(coreHit) + ' 候选=' + JSON.stringify(coreWords));
  }

  /* ---------------- B. 应用侧接线（打字就出泡泡，静态钉死） ---------------- */
  const appJsRaw = read('assets/js/app.js');
  const appJs = codeOnly(appJsRaw);
  const typeSoon = fnBody(appJs, 'slangTypeSoon');

  const watch = fnBody(appJs, 'slangWatchInput');
  const bindBody = fnBody(appJs, 'bind');
  ok('打字链路：监听写在 slangWatchInput() 里，且它在 bind() 内被**无条件**调用一次（冷启动也绑得上）',
    !!watch && /addEventListener\('input', e => \{[\s\S]{0,240}?slangTypeSoon\(\)/.test(watch) &&
    /slangWatchInput\(\);/.test(bindBody));
  ok('打字链路（本轮病根）：input 监听不再写在 slangBind() 里 —— 那个函数只有泡泡首次创建时才跑',
    !!fnBody(appJs, 'slangBind') && !/addEventListener\('input'/.test(fnBody(appJs, 'slangBind')) &&
    !/addEventListener\('input', \(\) => slangDismiss\(\)\)/.test(appJs));
  ok('打字链路：重复调用只绑一次（slangWatchBound 守卫）',
    /if \(slangWatchBound\) return;/.test(watch) && /slangWatchBound = true;/.test(watch));
  ok('打字链路：IME 组字中不查（isComposing / insertCompositionText），组字结束再查一次',
    /e\.isComposing \|\| e\.inputType === 'insertCompositionText'/.test(watch) &&
    /addEventListener\('compositionend', \(\) => slangTypeSoon\(\)\)/.test(watch));
  ok('打字链路：180ms 防抖 + clearTimeout（连打只查最后一次）',
    /const SLANG_TYPE_MS = 180;/.test(appJs) &&
    /if \(slangTypeTimer\) clearTimeout\(slangTypeTimer\);/.test(appJs) &&
    /\}, SLANG_TYPE_MS\);/.test(appJs));
  ok('打字链路：复用提交检索的同一批函数（lookup / refresh / 懒补包），不另起一套判定',
    !!typeSoon && /slangLookup\(/.test(typeSoon) && /slangRefresh\(false\)/.test(typeSoon) &&
    /slangLoadPending\(/.test(typeSoon), 'body=' + typeSoon.length);
  ok('打字链路：token 每次 +1、dismissed 复位（在途补包回来认不出亲就作废；打字重新武装）',
    /token: slangCtx\.token \+ 1/.test(typeSoon) && /dismissed: false/.test(typeSoon));
  ok('打字链路：低置信档仍只在「无结果」时出（打字路径只调 slangRefresh(false)）',
    !!typeSoon && !/slangRefresh\(true\)/.test(typeSoon));
  ok('打字链路：空串/未命中会主动收起（slangRefresh → slangPaint([]) → slangClose）',
    /if \(!show \|\| !show\.length \|\| !input \|\| !input\.value\.trim\(\)\) \{ slangClose\(\); return; \}/.test(appJs));
  ok('顺手清掉的死分支：不再有 `inline ? want : want`，left 夹在盒内',
    !/inline \? want : want/.test(appJs) && /Math\.min\(want, maxLeft\)/.test(appJs));
  ok('旁路契约：打字判定不动 #q 的值（slangTypeSoon 里没有 input.value = / setRangeText）',
    !!typeSoon && !/\.value\s*=/.test(typeSoon) && !/setRangeText/.test(typeSoon));
  ok('旁路契约：词典缺失时整体静默关闭（slangTypeSoon 第一行就是 if (!DICT) return;）',
    /function slangTypeSoon\(\) \{\s*if \(!DICT\) return;/.test(appJs));

  /* ------------------------- C. 套件自洽 / 接线 ------------------------- */
  const all = read('tools/check-all.js');
  ok('接线：check-all.js 的 SUITES 里登记了 dict-check.js',
    /\[['"]dict-check\.js['"]/.test(all));
  const self = read('tools/dict-check.js');
  ok('套件自洽：本文件带 `if (require.main === module) main()` 守卫 + module.exports = { main }',
    /require\.main\s*===\s*module/.test(self) && /module\.exports\s*=\s*\{\s*main\s*\}/.test(self));

  /* ======================================================================
     D. 行为层：真 app.js + 极简 DOM，真的「打字」一次
     这一层才是用户看到的那条路：DOMContentLoaded → boot() → bind() →
     slangWatchInput() 注册监听 → 给 #q 派发 input → slangTypeSoon() 防抖后
     slangLookup() → 命中/懒加载 → slangRefresh() → 泡泡 hidden=false。
     HEAD 版就死在第 4 步（监听压根没注册），所以这里必须真的派发事件。
     ====================================================================== */
  const DICT2 = HS2 && HS2.dict;
  ok('行为层：真 app.js 装进极简 DOM 后 HS.dict 也挂上了（沙箱自洽）',
    !!(DICT2 && typeof DICT2.lookup === 'function'));
  if (DICT2) {
    const q = dom2.doc.querySelector('#q');
    const form = dom2.doc.querySelector('.hs-searchbar');       /* = #search-form（别名同一个节点） */
    const bubble = () => form.children.filter(c => String(c.className || (c.attrs && c.attrs.class) || '')
      .indexOf('hs-slang-bubble') >= 0)[0] || null;
    const chipAttr = name => {
      const b = bubble();
      const chips = b ? b.querySelector('.hs-slang-chips') : null;
      const m = new RegExp(name + '="([^"]*)"').exec((chips && chips.innerHTML) || '');
      return m ? m[1] : '';
    };
    const chipDesc = b => b
      ? ('泡泡' + (b.hidden ? '仍隐藏' : '可见') + ' ' + chipAttr('data-q-from') + ' → ' + chipAttr('data-q'))
      : '没有泡泡';
    const type = t => { q.value = t; q.dispatch('input', { isComposing: false, inputType: 'insertText' }); };
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    env2.document.dispatch('DOMContentLoaded');
    await sleep(60);
    const listeners = (q._listeners.input || []).length;
    ok('行为层：boot() 之后 #q 上挂着打字监听（HEAD 版这里只有 1 个 = 清空钮那条 ⇒ 打字必定没泡泡）',
      listeners >= 2, 'input 监听数=' + listeners);

    type('mrfz');                       /* 核心层词条：不需要任何 IP 包 */
    await sleep(420);
    let b = bubble();
    ok('行为层：打字「mrfz」泡泡真的被画出来，且指向 arknights',
      !!b && b.hidden === false && chipAttr('data-q-from') === 'mrfz' && chipAttr('data-q') === 'arknights',
      chipDesc(b));

    type('图图');                       /* 必须等 arknights 包懒加载回来再重画一次 */
    await sleep(900);
    b = bubble();
    ok('行为层：打字「图图」泡泡出现并指向 virtuosa（跨懒加载重画）',
      !!b && b.hidden === false && chipAttr('data-q-from') === '图图' && chipAttr('data-q') === 'virtuosa',
      chipDesc(b));

    type('图片');                       /* 反面：零命中必须收起，不留上一个词的泡泡 */
    await sleep(420);
    b = bubble();
    ok('行为层：打字「图片」泡泡收起（零命中不留上一个词的泡泡）',
      !!b && b.hidden === true, b ? '泡泡' + (b.hidden ? '已隐藏' : '仍可见') : '没有泡泡');

    type('');                           /* 用户原话是「输入然后检索」：提交这条路也要有 */
    await sleep(250);
    q.value = '图图';
    form.dispatch('submit');
    await sleep(700);
    b = bubble();
    ok('行为层：提交检索「图图」之后泡泡也在（doSearch 里那次同步重画真的跑到了）',
      !!b && b.hidden === false, b ? '泡泡' + (b.hidden ? '仍隐藏' : '可见') : '没有泡泡');
  }

  /* ------------------------------ 汇总 ------------------------------ */
  let fail = 0;
  out.forEach(r => {
    if (!r.pass) fail++;
    console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.info ? '   [' + r.info + ']' : ''));
  });
  console.log(fail
    ? ('★ ' + fail + ' 条断言失败（共 ' + out.length + ' 条）')
    : ('全部 ' + out.length + ' 条断言通过'));
  process.exit(fail ? 1 : 0);
}

if (require.main === module) main().catch(function (e) { console.error(e); process.exit(1); });
module.exports = { main };
