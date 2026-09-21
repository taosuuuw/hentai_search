/* ==========================================================================
   dev/coverdiag.js — 封面加载诊断（**默认完全不生效**）
   --------------------------------------------------------------------------
   只在网址里带 `?coverdiag=1`（或 `#coverdiag=1`）时才启动，其余情况本文件从第一行
   就 return —— 不建面板、不挂钩子、不产生任何请求，对正常使用零影响。

   为什么需要它：
     用户报「有些作品加载不上封面（大小卡片都有）」，而且要求「随机关键词刷新 20 次以上
     都能正常加载」。光靠肉眼看屏幕数不出这个指标，必须让页面自己记账：
       · 每张卡片的 <img> 在 wireCover 里被打了 __ok / dataset.cover / __cands 标记，
         所以「现在屏幕上到底有几张图真的加载出来了」是可以精确数的；
       · 放大器每次打开的 <img> 是新建的，单独统计，用来区分「小卡有图 / 大卡没图」。

   面板（右下角，等宽字体）每 3 秒刷新一次：
     N=?  cards=…  ok=…  fail=…     ← 当前结果区
     big=? ok=… fail=…              ← 放大卡片（累计）
     最后一行列出失败的 img 当前 src 与 dataset.cover，便于直接判定是哪条腿断了。
   ========================================================================== */
(function () {
  'use strict';
  var on = false;
  try {
    on = /(?:^|[?&#])coverdiag=1(?:[&#]|$)/.test(String(location.search || '') + String(location.hash || ''));
  } catch (e) { on = false; }
  if (!on) return;

  var box = null;
  /* ★累计账本★：每一张封面（按「稳定 id + 原图地址」去重）只记一次成功或失败，
     换关键词、翻页、下拉刷新都不清零（存 sessionStorage）。
     用户要的指标是「20 次以上随机关键词 + 下拉刷新，封面都能加载」——
     只看当前 DOM 数不出来：换关键词会把老卡片回收，必须累计。 */
  var ledger = { total: 0, fail: 0, ok: 0, byHostFail: {}, seq: [], seen: {} };
  /* 跨「下拉刷新」存活：用户要求里明确包含刷新，所以账本存 sessionStorage
     （同一个标签页内刷新不清零；关掉标签页才清）。 */
  try {
    var saved = JSON.parse(sessionStorage.getItem('hs.coverdiag.ledger') || 'null');
    if (saved && typeof saved.total === 'number') ledger = saved;
  } catch (e0) {}
  function saveLedger() { try { sessionStorage.setItem('hs.coverdiag.ledger', JSON.stringify(ledger)); } catch (e1) {} }
  function countIt(img, isFail) {
    /* 用「跨源合并后的稳定身份 + 原图地址」当账本键：卡片 DOM 重建（签名变了）时
       新 img 的 dataset.cdmarked 是空的，只有按内容去重才不会把同一张图数两遍。 */
    var want0 = (img.dataset && img.dataset.cover) || img.getAttribute('src') || '';
    var key = ledgerKey(img, want0);
    if (!ledger.seen) ledger.seen = {};
    if (ledger.seen[key]) return;
    ledger.seen[key] = 1;
    ledger.total++;
    if (!isFail) { ledger.ok++; saveLedger(); return; }
    ledger.fail++;
    var want = want0;
    var h = '(?)';
    try { h = new URL(want, location.href).hostname || '(self)'; } catch (e) { h = '(bad)'; }
    ledger.byHostFail[h] = (ledger.byHostFail[h] || 0) + 1;
    if (ledger.seq.length < 40) {
      var q = document.getElementById('q');
      ledger.seq.push((q ? q.value : '') + ' | ' + h + ' | ' + String(want).slice(0, 110));
    }
    saveLedger();
  }
  /** 账本键：卡片 data-key（跨源合并后的稳定 id）优先，退化到原图地址 */
  function ledgerKey(img, want) {
    var card = img.closest ? img.closest('.hs-card') : null;
    var k = card && card.getAttribute ? (card.getAttribute('data-key') || '') : '';
    return (k || want) + '\u0000' + want;
  }
  window.HS_COVERLEDGER = ledger;
  function mk() {
    if (box) return box;
    box = document.createElement('div');
    box.id = 'coverdiag';
    box.setAttribute('data-role', 'coverdiag');
    box.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:2147483647;' +
      'background:rgba(8,10,24,.92);color:#cfe0ff;border:1px solid #4a5bd0;border-radius:10px;' +
      'padding:8px 10px;font:11px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre;' +
      'max-width:46vw;max-height:38vh;overflow:auto;pointer-events:none';
    document.body.appendChild(box);
    return box;
  }

  function short(s) {
    s = String(s || '');
    if (s.length > 120) s = s.slice(0, 60) + '…' + s.slice(-50);
    return s;
  }

  function scan() {
    try {
      var cards = [].slice.call(document.querySelectorAll('#results-grid .hs-card'));
      var okc = 0, failc = 0, pend = 0, vis = 0, visFail = 0, visPend = 0, visOk = 0;
      var fails = [];
      cards.forEach(function (c) {
        var img = c.querySelector('.hs-card-img img');
        /* 只统计**真正进入布局**的卡片：还没进入布局的那些不算失败也不算成功。
           失败率只在可见集合上算，避免把「还没轮到请求」误判成「加载失败」。 */
        var isVis = !!(c.offsetParent !== null && c.getBoundingClientRect().height > 0);
        if (isVis) vis++;
        if (!img) { pend++; if (isVis) visPend++; return; }
        var src = img.getAttribute('src') || '';
        var want = img.dataset ? (img.dataset.cover || '') : '';
        var isPh = src.indexOf('data:') === 0;
        if (img.__ok || (src && !isPh && img.naturalWidth > 0)) { okc++; if (isVis) visOk++; countIt(img, false); return; }
        if (isPh) {
          failc++;
          if (isVis) visFail++;
          countIt(img, true);
          if (fails.length < 6) fails.push('FAIL ' + short(want) + '\n     now=' + short(src));
          return;
        }
        /* 还没 load 到（正在加载）：单独算一类，别混进失败 */
        pend++;
        if (isVis) visPend++;
      });
      var big = document.querySelector('.hs-cm-img img');
      var bigTxt = 'big=-';
      if (big) {
        var bs = big.getAttribute('src') || '';
        var bok = !!(big.__ok || (bs && bs.indexOf('data:') !== 0 && big.naturalWidth > 0));
        var bfail = bs.indexOf('data:') === 0 && bs.indexOf('svg') >= 0;
        bigTxt = 'big=' + (bok ? 'OK' : (bfail ? 'FAIL' : 'loading')) +
          '  nat=' + (big.naturalWidth || 0) + 'x' + (big.naturalHeight || 0) +
          '\n     src=' + short(bs);
      }
      var q = document.getElementById('q');
      var head = 'q=' + (q ? q.value : '?') +
        '\ncards=' + cards.length + '  visible=' + vis +
        '\nvisible: ok=' + visOk + ' fail=' + visFail + ' loading=' + visPend;
      /* 视觉区里前 3 张图的实况（"9x16" = 真的解码出来了；".." = 还没 load；"PH" = 占位图）。
         这是判断「到底是没请求、请求失败、还是解码失败」最快的一眼。 */
      var probe = [];
      [].slice.call(document.querySelectorAll('#results-grid .hs-card')).forEach(function (c) {
        if (probe.length >= 3) return;
        if (!(c.offsetParent !== null && c.getBoundingClientRect().height > 0)) return;
        var im = c.querySelector('.hs-card-img img');
        if (!im) { probe.push('none'); return; }
        var s = im.getAttribute('src') || '';
        if (s.indexOf('data:') === 0) { probe.push('PH'); return; }
        if (im.complete && im.naturalWidth) { probe.push(im.naturalWidth + 'x' + im.naturalHeight); return; }
        probe.push(im.complete === false ? '..load' : '..idle');
      });
      /* 把关键计数写进 <title>：自动化工具（无障碍树 / observe）能直接读到，
         不必截屏数图。`big=` 是**放大卡片**（大卡片）那一条：
         ok = 真的解码出来了，PH = 落到占位图（= 用户说的「大卡片没封面」）。 */
      try {
        document.title = 'CD vis=' + vis + ' ok=' + visOk + ' fail=' + visFail + ' load=' + visPend +
          ' ' + (bigTxt.split('\n')[0].split('  ')[0] || 'big=-') +
          ' | L=' + ledger.total + '/' + ledger.fail +
          ' | all=' + cards.length + ' | hentai搜索';
        if (document.body) {
          document.body.setAttribute('data-coverdiag',
            JSON.stringify({
              q: q ? q.value : '', cards: cards.length, vis: vis, visOk: visOk, visFail: visFail,
              visPend: visPend, probe: probe, big: (bigTxt.split('\n')[0] || ''),
              ledger: { total: ledger.total, ok: ledger.ok, fail: ledger.fail, byHostFail: ledger.byHostFail }
            }));
        }
      } catch (e2) {}
      mk().textContent = head + '\n' + bigTxt + (fails.length ? '\n' + fails.join('\n') : '');
      /* 也写进一个全局对象，方便用户在控制台里深看 */
      window.HS_COVERDIAG = { q: q ? q.value : '', cards: cards.length, ok: okc, fail: failc, loading: pend, at: Date.now() };
    } catch (e) { /* 诊断本身绝不影响页面 */ }
  }

  var t = null;
  function schedule() { if (t) return; t = setInterval(scan, 3000); scan(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule);
  else schedule();
})();
