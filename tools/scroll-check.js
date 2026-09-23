/* ==========================================================================
   scroll-check.js — 滚动加载到底判定 + 回顶按钮 的可复验断言（零依赖，可复跑）
   --------------------------------------------------------------------------
   用法（在仓库根目录）：
     node tools/scroll-check.js
   说明：
     · 直接加载站点真实的 core.js / dict.js / net.js / sources.js / results.js
       （复用 concept-check-shim 的 node:vm 最小浏览器环境），不复制任何逻辑。
     · 「到底」判定被抽成了纯函数 HS.results.pageStateNext(prev, results, grew)，
       所以这里能把「多源交错分页」这类真实场景一页一页喂进去断言，完全不需要 DOM / 网络。
     · 回顶按钮的阈值判定同理，抽成了纯函数 HS.totop.shouldShow(y, vh)。
     · 另有一组**静态接线**断言（index.html / app.js / style.css 里该有的钩子在不在），
       防止以后有人删了按钮或忘了初始化 —— 这类漏接是纯函数断言照不到的。
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { ROOT, loadSite } = require('./concept-check-shim');

const out = [];
const ok = (name, pass, info) => out.push({ name, pass: !!pass, info: info == null ? '' : String(info) });

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/** 去掉注释后的代码（静态回归断言只看代码，注释里提到旧写法不算「还留着」） */
function codeOnly(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')          // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');      // 行注释（避开 http:// 这类）
}

/** 造 n 个「没见过的」条目 */
function fresh(prefix, n, from) {
  const a = [];
  for (let i = 0; i < n; i++) a.push({ key: prefix + (from + i), id: prefix + (from + i) });
  return a;
}
/** 造一条源返回：ok 且 rawCount 条 */
function src(id, items) { return { src: { id }, ok: true, rawCount: items.length, items }; }
/** 造一条失败的源返回 */
function bad(id, err) { return { src: { id }, ok: false, rawCount: 0, error: err || 'timeout' }; }

/** 按轮次跑 pageStateNext，返回每轮的判定 */
function run(R, rounds) {
  let st = R.pageStateNew();
  return rounds.map(r => {
    const j = R.pageStateNext(st, r.results, !!r.grew);
    st = j.state;
    return j;
  });
}

function main() {
  const env = loadSite([
    'assets/js/core.js', 'assets/js/dict.js', 'assets/js/net.js',
    'assets/js/sources.js', 'assets/js/results.js'
  ]);
  const R = env.HS.results;
  ok('装载：results.js 在最小浏览器环境里跑起来并暴露 pageStateNext', typeof R.pageStateNext === 'function');

  /* ---------------- 场景 A：多源交错分页（旧口径误判的主场景） ----------------
     甲源这一页是空的，乙源还有货 —— 全局「这批没多」的代理会判到底，逐源证据不会。
     注意「这个源到头了」本身也要连续两页空（EMPTY×2），所以第 3 轮只有甲到头。 */
  {
    const j = run(R, [
      { results: [src('a', []), src('b', fresh('b', 8, 0))], grew: true },
      { results: [src('a', []), src('b', fresh('b', 8, 8))], grew: true },
      { results: [src('a', []), src('b', [])], grew: false },
      { results: [src('a', []), src('b', [])], grew: false }
    ]);
    ok('A1 甲源空、乙源有货 → 不判到底', j[0].exhausted === false,
      'exhausted=' + j[0].exhausted + ' pending=' + j[0].pending.join(','));
    ok('A2 甲源第 2 次空（甲已到尽头）、乙源仍有货 → 仍不判到底', j[1].exhausted === false,
      'exhausted=' + j[1].exhausted + ' pending=' + j[1].pending.join(','));
    ok('A3 乙源才空 1 次 → 还不能判到底（单次空页可能是抖动的末页）', j[2].exhausted === false,
      'exhausted=' + j[2].exhausted + ' pending=' + j[2].pending.join(','));
    ok('A4 甲乙各自连续两页都空 → 判到底', j[3].exhausted === true && j[3].pending.length === 0,
      'exhausted=' + j[3].exhausted + ' pending=' + j[3].pending.join(','));
  }

  /* ---------------- 场景 B：每页只回 6 条（原始 bug 的复现口径） ----------------
     旧判据 `fresh.length < Math.max(4, pageSize()*0.15)`：pageSize 默认 60 → 阈值 9，
     6 < 9 → 第 2 页一到就判「已经到底」，滚动加载从此不再发请求。这里把两件事都钉住。 */
  {
    const old = Math.max(4, 60 * 0.15);
    ok('B1 旧阈值：pageSize=60 时门槛 = 9（6 条/页必被判到底 —— 这就是原始 bug）',
      old === 9 && 6 < old, 'max(4, 60*0.15)=' + old);
    const j = run(R, [
      { results: [src('b', fresh('b', 6, 0))], grew: true },
      { results: [src('b', fresh('b', 6, 6))], grew: true },
      { results: [src('b', fresh('b', 6, 12))], grew: true },
      { results: [src('b', fresh('b', 6, 18))], grew: true }
    ]);
    ok('B2 6 条/页连续 4 轮都必须继续要（一轮都不许判到底）',
      j.every(x => x.exhausted === false),
      j.map((x, i) => 'r' + (i + 1) + '=' + x.exhausted).join(' '));
  }

  /* ---------------- 场景 C：源没有真分页（每轮都是同一批） ----------------
     DUP×3 才收手 —— 比旧的「连续 2 轮没多就到底」多要一轮，避免抖动误杀。 */
  {
    const same = fresh('b', 8, 0);
    const j = run(R, [
      { results: [src('b', same)], grew: true },
      { results: [src('b', same)], grew: false },
      { results: [src('b', same)], grew: false },
      { results: [src('b', same)], grew: false }
    ]);
    ok('C1 第 2 轮（同批第 1 次重复）不判到底', j[1].exhausted === false, 'exhausted=' + j[1].exhausted);
    ok('C2 第 3 轮（同批第 2 次重复）仍不判到底 —— 旧口径在这一轮就收手了', j[2].exhausted === false,
      'exhausted=' + j[2].exhausted + ' by=' + (j[2].state.src.b || {}).by);
    ok('C3 第 4 轮（同批第 3 次重复）判到底，且理由记为 dup',
      j[3].exhausted === true && j[3].state.src.b.by === 'dup',
      'exhausted=' + j[3].exhausted + ' by=' + j[3].state.src.b.by);
  }

  /* ---------------- 场景 D：源全挂 → FAIL×3 ---------------- */
  {
    const j = run(R, [
      { results: [bad('x')], grew: false },
      { results: [bad('x')], grew: false },
      { results: [bad('x')], grew: false }
    ]);
    ok('D1 单源连续失败 3 轮 → 判到底，理由记为 fail',
      j[2].exhausted === true && j[2].state.src.x.by === 'fail',
      'by=' + j[2].state.src.x.by + ' stopped=' + j[2].stopped.join(','));
    ok('D2 失败 2 轮还不够', j[1].exhausted === false, 'exhausted=' + j[1].exhausted);
  }

  /* ---------------- 场景 E：源「复活」 → 到底状态必须能撤回 ----------------
     这是 `R.exhausted = !!j.exhausted`（可升可降）而不是单向置 true 的原因。 */
  {
    const same = fresh('b', 8, 0);
    let st = R.pageStateNew();
    st = R.pageStateNext(st, [src('b', same)], true).state;
    st = R.pageStateNext(st, [src('b', same)], false).state;
    st = R.pageStateNext(st, [src('b', same)], false).state;
    const done = R.pageStateNext(st, [src('b', same)], false);
    const back = R.pageStateNext(done.state, [src('b', fresh('b', 3, 100))], true);
    ok('E1 判定到底后，该源又吐出没见过的条目 → 撤回到底',
      done.exhausted === true && back.exhausted === false,
      'done=' + done.exhausted + ' → back=' + back.exhausted);
    ok('E2 复活后该源重新进入 pending', back.pending.indexOf('b') >= 0, 'pending=' + back.pending.join(','));
  }

  /* ---------------- 场景 F：没有任何源回报时不许判到底 ----------------
     否则首屏（或一次全军覆没的空结果）会把滚动加载永久锁死。 */
  {
    const j = R.pageStateNext(R.pageStateNew(), [], false);
    ok('F1 没有任何源回报 → 不判到底', j.exhausted === false, 'exhausted=' + j.exhausted);
  }

  /* ---------------- 场景 G：全局兜底（连续 6 轮跨源去重后一条新的都没多） ----------------
     逐源证据都还在说「我有货」时，唯一能保证循环会停下来的就是这条 dry 上限。 */
  {
    const rounds = [];
    for (let i = 0; i < 7; i++) {
      /* 每轮都给这个源一个新的 key（它自己觉得有进展），但 grew=false（跨源看是重复） */
      rounds.push({ results: [src('a', [fresh('a', 1, i)[0]])], grew: false });
    }
    const j = run(R, rounds);
    ok('G1 前 5 轮不判到底（dry < 6）', j.slice(0, 5).every(x => x.exhausted === false),
      j.slice(0, 5).map((x, i) => 'r' + (i + 1) + '=' + x.exhausted).join(' '));
    ok('G2 第 6 轮 dry 到顶 → 判到底，且标记 dryStop',
      j[5].exhausted === true && j[5].dryStop === true && j[5].state.dry === 6,
      'dry=' + j[5].state.dry + ' dryStop=' + j[5].dryStop);
  }

  /* ---------------- 场景 H：同一源混着来（空 → 失败 → 有新货） ----------------
     证据按源累计，不许互相抵消：空 1 次 + 失败 1 次 ≠ 到尽头。 */
  {
    const j = run(R, [
      { results: [src('m', [])], grew: false },
      { results: [bad('m', 'timeout')], grew: false },
      { results: [src('m', fresh('m', 4, 0))], grew: true }
    ]);
    ok('H1 空 1 次 + 失败 1 次之后又来新货 → 仍在 pending',
      j[2].exhausted === false && j[2].state.src.m.done === false,
      'exhausted=' + j[2].exhausted + ' by=' + j[2].state.src.m.by);
  }

  /* ---------------- 回顶按钮：阈值判定（纯函数） ---------------- */
  {
    const env2 = loadSite(['assets/js/core.js', 'assets/js/totop.js']);
    const T = env2.HS.totop;
    ok('装载：totop.js 跑起来并暴露 shouldShow / jump / init',
      typeof T.shouldShow === 'function' && typeof T.jump === 'function' && typeof T.init === 'function');
    ok('图标：HS.icon.up 已加入图标表且是 svg',
      typeof env2.HS.icon.up === 'string' && env2.HS.icon.up.indexOf('<svg') === 0,
      String(env2.HS.icon.up).slice(0, 40));
    /* 阈值 = max(480, 视口高 × 0.6) */
    const cases = [
      ['视口 900：540px 不出现', 540, 900, false],
      ['视口 900：541px 出现', 541, 900, true],
      ['视口 900：顶部不出现', 0, 900, false],
      ['视口 600：480px 不出现（下限 480 生效）', 480, 600, false],
      ['视口 600：481px 出现', 481, 600, true],
      ['小视口 400：479px 不出现（不被 0.6 倍拉低）', 479, 400, false],
      ['大视口 2000：1200px 不出现（阈值随视口放大到 0.6 倍）', 1200, 2000, false],
      ['大视口 2000：1201px 出现', 1201, 2000, true]
    ];
    cases.forEach(c => {
      const got = T.shouldShow(c[1], c[2]);
      ok('阈值：' + c[0], got === c[3], 'shouldShow(' + c[1] + ',' + c[2] + ')=' + got + ' 期望 ' + c[3]);
    });
    /* 兜底：rAF 被挂起（隐藏 / 被遮挡的文档）时补间一帧都不跑，
       没有这条兜底就会出现「点了没反应」——必须同时能被 disarm() 取消。 */
    const totopJs = codeOnly(read('assets/js/totop.js'));
    ok('兜底：totop.js 有 setTimeout 兜底，且 disarm() 里 clearTimeout 取消它',
      /guard\s*=\s*setTimeout\(/.test(totopJs) && /clearTimeout\(guard\)/.test(totopJs));
    ok('兜底：兜底回调先 scrollTo(0,0) 再 disarm()/paint()，且带 armed 守卫',
      /if \(!armed\) return;[\s\S]{0,200}window\.scrollTo\(0, 0\);/.test(totopJs));
  }

  /* ---------------- 场景 G：全新检索必须把结果页的三个筛选位一起归零 ----------------
     用户需求④：「勾选了一部分筛选标签后再输入新关键词检索，应该自动取消勾选、默认全部」。
     结果页顶部有三个筛选位：源（R.sourceFilter）、系列（R.seriesOnly）、汉化/中文（R.zhOnly）。
     旧代码在 streamStart 的 page===1 分支里只清了前两个，R.zhOnly 只在 R.reset() 里清 ——
     真机复现（第 12 轮，walk 步骤脚本）：点「汉化/中文」→ 换新关键词回车 →
     新结果仍然只剩汉化（cards 8 / items 35），而「全部」chip 同时是亮的（sourceFilter 已归零），
     用户看到的就是「标签没被自动取消勾选」。 */
  {
    R.sourceFilter = 'nhentai'; R.seriesOnly = { label: 'X' }; R.zhOnly = true; R.page = 3;
    R.streamStart('火影', {}, 1);
    ok('G1 全新检索（page=1）→ sourceFilter / seriesOnly / zhOnly 三个筛选位全部归零（等于「全部」）',
      R.sourceFilter === null && R.seriesOnly === null && R.zhOnly === false,
      'sourceFilter=' + R.sourceFilter + ' seriesOnly=' + JSON.stringify(R.seriesOnly) + ' zhOnly=' + R.zhOnly);
    R.zhOnly = true; R.sourceFilter = 'nhentai'; R.seriesOnly = { label: 'Y' };
    R.streamStart('火影', {}, 2);
    ok('G2 追加检索（page=2，下滑继续加载）→ 三个筛选位保持不动（拦的是滚动刷新，不能误伤）',
      R.zhOnly === true && R.sourceFilter === 'nhentai' && !!R.seriesOnly,
      'sourceFilter=' + R.sourceFilter + ' zhOnly=' + R.zhOnly);
    R.sourceFilter = null; R.seriesOnly = null; R.zhOnly = false;
  }

  /* ---------------- 静态接线：按钮真的挂上去了吗 ---------------- */
  const html = read('index.html');
  const appJs = read('assets/js/app.js');
  const css = read('assets/css/style.css');
  const resJs = read('assets/js/results.js');
  ok('接线：index.html 有 #to-top 按钮，且在 #hs-app 之内',
    /<button id="to-top"[^>]*class="hs-totop"/.test(html) &&
    html.indexOf('id="to-top"') < html.indexOf('<div id="panic-overlay"'),
    '按钮行=' + (html.match(/.*id="to-top".*/) || [''])[0].trim().slice(0, 80));
  ok('接线：index.html 引入了 assets/js/totop.js',
    /<script src="assets\/js\/totop\.js"><\/script>/.test(html));
  ok('接线：app.js 的 boot() 里初始化了 HS.totop',
    /if \(HS\.totop && HS\.totop\.init\) HS\.totop\.init\(\);/.test(appJs));
  ok('接线：style.css 有 .hs-totop 的显示/隐藏两态',
    /\.hs-totop\s*\{/.test(css) && /\.hs-totop\[data-show="1"\]\s*\{/.test(css) &&
    /pointer-events: none/.test(css));
  ok('接线：结果页脚会说清「还有几个源可能有更多」',
    /个源可能有更多/.test(resJs));

  /* ---------------- 静态回归：旧的两条误判口径必须消失（只看代码，注释里提到不算） ---------------- */
  const resCode = codeOnly(resJs);
  ok('回归：旧阈值 `fresh.length < Math.max(4, pageSize()*0.15)` 已彻底移除',
    !/Math\.max\(4,\s*pageSize\(\)\s*\*\s*0\.15\)/.test(resCode));
  ok('回归：旧的「连续 2 轮没进展就到底」已移除',
    !/R\._dryRounds = \(R\._dryRounds \|\| 0\) \+ 1\) >= 2/.test(resCode));
  ok('回归：旧的 `if (!fresh.length) R.exhausted = true;` 已移除',
    !/if \(!fresh\.length\) R\.exhausted = true;/.test(resCode));
  ok('回归：到底状态改为「可升可降」地整体赋值',
    /R\.exhausted = !!j\.exhausted;/.test(resCode) &&
    /R\._pageState = R\.pageStateNew\(\)/.test(resCode));

  console.log('\n================ 断言结果 ================');
  let fail = 0;
  out.forEach(r => {
    if (!r.pass) fail++;
    console.log((r.pass ? '  PASS  ' : '  FAIL  ') + r.name + (r.info ? '\n          ' + r.info : ''));
  });
  console.log('-----------------------------------------');
  console.log(fail ? (fail + ' 条断言失败') : '全部 ' + out.length + ' 条断言通过');
  process.exit(fail ? 1 : 0);
}

if (require.main === module) main();
module.exports = { main };
