'use strict';
/* ==========================================================================
   tools/ui-truth-steps.js —— 真机「UI 真相」测量脚本（配合 tools/live-probe.js --steps）
   --------------------------------------------------------------------------
   用法（仓库根目录，需要不受限沙箱 —— Chrome 在 workspace-write 下会自毁）：
     node tools/live-probe.js --url=http://127.0.0.1:8799/ --steps=tools/ui-truth-steps.js \
       --w=1280 --h=900 --wait=1500
   产出：tools/ui-truth-<tag>.json（由 HS_UI_TAG 环境变量控制，默认 'run'）

   它测两件事，都用**像素/矩形**而不是源码文本：
   ① 搜索框侧光（用户第 10 轮问题 3）
      · 把动画暂停在 0 / 0.4 / … / 3.6s 十个相位，逐相位截搜索框条带图；
      · 在页面里用 canvas 解出「左侧 15%」和「右侧 15%」的平均亮度；
      · 先量一次「关掉 ::after 全部背景层」的基线 ⇒ dL/dR = 该侧相对基线的亮暗；
      · 判据：光走到右边时左侧要**比基线更暗**（dL < 0）且右侧更亮，反之亦然；
        以及环路接缝处（3.6s ↔ 0s）亮度不能跳变（跳变 = 用户说的「开始和结束不自然」）。
   ② 阅读器横向单页（问题 1 / 2）
      · 用桩 fetch 提供一张已知尺寸的合成图（1000×1400，正中画红准星），
        直接 RD.open 打开，不依赖上游站点；
      · 缩放漂移：记下视口正中对着图上的分数点 → 点按钮放大/缩小 → 量这个点又跑到哪；
        漂移 = 用户说的「放大缩小图片位置会变化」；
      · 拖拽：CDP 真鼠标（Input.dispatchMouseEvent）按住拖 120/80 像素，
        量 <img> 的 transform 与页盒 scrollLeft/Top 变没变；
      · 回归：单击右半屏仍要翻页、拖动之后不许翻页。
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const TAG = process.env.HS_UI_TAG || 'run';

/* ------------------------------- 页面内工具 ------------------------------- */
const SETUP = `(function(){
  var P = window.__P = window.__P || {};
  P.q = function(s, r){ return (r||document).querySelector(s); };
  P.box = function(){ return document.querySelector('.hs-rd-pg.is-cur'); };
  P.curIdx = function(){
    var list = [].slice.call(document.querySelectorAll('.hs-rd-pg'));
    return list.indexOf(document.querySelector('.hs-rd-pg.is-cur'));
  };
  P.curImg = function(){
    var pg = P.box(); if(!pg) return null;
    return pg.querySelector('.hs-rd-img img') || pg.querySelector('.hs-rd-img canvas') || pg.querySelector('img');
  };
  P.rect = function(el){
    if(!el) return null; var r = el.getBoundingClientRect();
    return {l:+r.left.toFixed(1), t:+r.top.toFixed(1), w:+r.width.toFixed(1), h:+r.height.toFixed(1)};
  };
  P.scrolls = function(){
    var b = P.box(), s = document.querySelector('[data-rd-scroll]'), col = document.querySelector('[data-rd-pages]'), rd = document.querySelector('.hs-rd');
    function o(e){ return e ? {x:e.scrollLeft, y:e.scrollTop, sw:e.scrollWidth, sh:e.scrollHeight, w:e.clientWidth, h:e.clientHeight,
                              roomX:e.scrollWidth-e.clientWidth, roomY:e.scrollHeight-e.clientHeight} : null; }
    return {pg:o(b), scroll:o(s), col:o(col), rd:o(rd)};
  };
  P.picOf = function(img){
    /* 与 assets/js/reader.js 的 picBox() 同一套算法：contain 之后的**画面**矩形 */
    var r = img.getBoundingClientRect(), nw = img.naturalWidth||0, nh = img.naturalHeight||0;
    if(!nw || !nh || r.width < 1 || r.height < 1) return {l:r.left, t:r.top, w:r.width, h:r.height};
    var s = Math.min(r.width/nw, r.height/nh), w = nw*s, h = nh*s;
    return {l:r.left+(r.width-w)/2, t:r.top+(r.height-h)/2, w:w, h:h};
  };
  P.anchor = function(){
    var img = P.curImg(); if(!img) return null;
    var p = P.picOf(img), cx = innerWidth/2, cy = innerHeight/2;
    return {fx: p.w>1 ? (cx-p.l)/p.w : 0.5, fy: p.h>1 ? (cy-p.t)/p.h : 0.5,
            pic:{l:+p.l.toFixed(1), t:+p.t.toFixed(1), w:+p.w.toFixed(1), h:+p.h.toFixed(1)},
            rect: P.rect(img), cx:cx, cy:cy, tf: img.style.transform || 'none',
            zoom: getComputedStyle(document.querySelector('.hs-rd')).getPropertyValue('--hs-rd-zoom').trim()};
  };
  P.drift = function(a){
    var img = P.curImg(); if(!a || !img) return null;
    var p = P.picOf(img);
    var tx = p.l + a.fx*p.w, ty = p.t + a.fy*p.h;
    return {dx:+(tx-a.cx).toFixed(2), dy:+(ty-a.cy).toFixed(2), d:+Math.hypot(tx-a.cx, ty-a.cy).toFixed(2),
            pic:{l:+p.l.toFixed(1), t:+p.t.toFixed(1), w:+p.w.toFixed(1), h:+p.h.toFixed(1)},
            tf: img.style.transform || 'none'};
  };
  P.shade = function(){
    var e = document.querySelector('.hs-searchbar > .hs-sb-shade');
    if(!e) return {exists:false};
    var cs = getComputedStyle(e);
    return {exists:true, pos:cs.backgroundPosition, size:cs.backgroundSize, blend:cs.mixBlendMode, z:cs.zIndex,
            pe:cs.pointerEvents, opacity:cs.opacity,
            anim:cs.animationName+' '+cs.animationDuration+' '+cs.animationTimingFunction+' '+cs.animationDirection+' x'+cs.animationIterationCount};
  };
  P.imgTf = function(){
    var im = document.querySelector('.hs-rd-pg.is-cur .hs-rd-img img');
    return im ? {transform: im.style.transform || 'none', transition: im.style.transition || ''} : null;
  };
  P.dir = function(){ var r = document.querySelector('.hs-rd'); return r ? r.getAttribute('data-dir') : null; };
  P.zoomVal = function(){ var b = document.querySelector('[data-rd-zoomval]'); return b ? b.textContent : null; };
  P.pauseAnim = function(t){
    var s = document.getElementById('hs-anim-freeze');
    if(!s){ s = document.createElement('style'); s.id = 'hs-anim-freeze'; (document.head||document.documentElement).appendChild(s); }
    if(t == null){ s.textContent = ''; return 'live'; }
    s.textContent = '.hs-searchbar::after,.hs-searchbar::before,.hs-sheet-grab::before,.hs-searchbar > .hs-sb-shade{' +
      'animation-play-state:paused !important;animation-delay:' + (-t) + 's !important;}';
    return 'paused@' + t;
  };
  P.killAfterBg = function(on){
    /* 第 10 轮：基线要连**新增的测光阴影层**一起关掉，否则「基线」本身带着随相位变化的
       阴影，dL/dR 就成了「活像素 − 某个相位的阴影像素」= 两个变量的差，没有意义。 */
    var s = document.getElementById('hs-after-kill');
    if(!s){ s = document.createElement('style'); s.id = 'hs-after-kill'; (document.head||document.documentElement).appendChild(s); }
    s.textContent = on ? '.hs-searchbar::after{background-image:none !important;}' +
                         '.hs-searchbar > .hs-sb-shade{background-image:none !important;}' : '';
    return !!on;
  };
  P.bgPos = function(sel){
    var e = document.querySelector(sel); if(!e) return null;
    var cs = getComputedStyle(e, '::after');
    return {pos: cs.backgroundPosition, size: cs.backgroundSize,
            anim: cs.animationName + ' ' + cs.animationDuration + ' ' + cs.animationTimingFunction +
                  ' ' + cs.animationDirection + ' x' + cs.animationIterationCount};
  };
  P.analyze = function(b64, w, h, fracL, fracR){
    return new Promise(function(res){
      var img = new Image();
      img.onload = function(){
        try{
          var c = document.createElement('canvas'); c.width = w; c.height = h;
          var g = c.getContext('2d', {willReadFrequently:true});
          g.drawImage(img, 0, 0, w, h);
          function mean(x0, x1){
            x0 = Math.max(0, Math.round(x0)); x1 = Math.min(w, Math.round(x1));
            if(x1 <= x0) return null;
            var d = g.getImageData(x0, 0, x1-x0, h).data, s = 0, n = 0;
            for(var i=0;i<d.length;i+=4){ s += 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2]; n++; }
            return +(s/n).toFixed(3);
          }
          res({left:mean(0, w*fracL), right:mean(w*(1-fracR), w), all:mean(0, w), w:w, h:h});
        }catch(e){ res({err:String(e)}); }
      };
      img.onerror = function(){ res(null); };
      img.src = 'data:image/png;base64,' + b64;
    });
  };
  return 'setup-ok';
})()`;

/* ------------------------------ 合成章节数据 ------------------------------ */
const SYNTH = `(function(){
  function page(i){
    var w = 1000, h = 1400;
    var g = '';
    for(var x=100;x<w;x+=100) g += '<line x1="'+x+'" y1="0" x2="'+x+'" y2="'+h+'" stroke="#c9c9c9" stroke-width="2"/>';
    for(var y=100;y<h;y+=100) g += '<line x1="0" y1="'+y+'" x2="'+w+'" y2="'+y+'" stroke="#c9c9c9" stroke-width="2"/>';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'">' +
      '<rect width="'+w+'" height="'+h+'" fill="#ffffff"/>' + g +
      '<line x1="'+(w/2)+'" y1="'+(h/2-90)+'" x2="'+(w/2)+'" y2="'+(h/2+90)+'" stroke="#e11" stroke-width="6"/>' +
      '<line x1="'+(w/2-90)+'" y1="'+(h/2)+'" x2="'+(w/2+90)+'" y2="'+(h/2)+'" stroke="#e11" stroke-width="6"/>' +
      '<circle cx="'+(w/2)+'" cy="'+(h/2)+'" r="14" fill="none" stroke="#11c" stroke-width="5"/>' +
      '<text x="30" y="90" font-size="70" fill="#111" font-family="monospace">P'+(i+1)+'</text>' +
      '<text x="30" y="'+(h-30)+'" font-size="70" fill="#111" font-family="monospace">P'+(i+1)+'</text></svg>';
    return {url:'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), w:w, h:h};
  }
  var pages = []; for(var i=0;i<6;i++) pages.push(page(i));
  window.__SYNTH = pages;
  var of = window.fetch;
  window.fetch = function(u, o){
    if(String(u).indexOf('/api/reader') >= 0){
      return Promise.resolve(new Response(JSON.stringify({ok:true, title:'UI-TRUTH', chapters:[{id:'c1', name:'单章'}], pages:pages}),
        {status:200, headers:{'Content-Type':'application/json'}}));
    }
    return of.apply(this, arguments);
  };
  return {pages: pages.length, w: pages[0].w, h: pages[0].h};
})()`;

module.exports = async function main(ctx) {
  const { cdp, evaluate, shot, reload, mouse, sleep, log } = ctx;
  const R = { tag: TAG, url: ctx.url, at: new Date().toISOString(), glow: {}, reader: {}, notes: [] };

  await evaluate(SETUP);
  log('页面内工具就绪');

  /* ================= 前置：先把挡在前面的浮层收掉 =================
     ★血泪教训（第 10 轮）★：全新 Chrome profile 里 HS.settings.adultOk 是 false，
     index.html 的成年门 #gate 会被显出来（position:fixed; inset:0; z-index:500），
     于是**页面被整块盖住**：搜索框截到的其实是门的深色底（亮度恒等）、
     真鼠标事件也全部落在门的 <li> 上 —— 阅读器永远收不到 pointerdown。
     结果是「灯不可见」「拖不动」「点不翻页」三条全是假象。
     所以下面这段必须在所有测量之前跑，并且把命中测试的结果记进报告： */
  const pre = await evaluate(`(function(){
    var out = {theme: document.documentElement.getAttribute('data-theme'), before:{}};
    function info(id){ var e=document.getElementById(id); if(!e) return null;
      var cs=getComputedStyle(e); return {hidden:!!e.hidden, display:cs.display, pe:cs.pointerEvents, z:cs.zIndex}; }
    out.before.gate = info('gate'); out.before.net = info('net-banner');
    try{ HS.settings.adultOk = true; if(HS.store && HS.store.save) HS.store.save(HS.settings); }catch(e){ out.err=String(e); }
    var g=document.getElementById('gate'); if(g) g.hidden = true;
    var nb=document.getElementById('net-banner'); if(nb) nb.hidden = true;
    out.after = {gate: info('gate'), net: info('net-banner')};
    var sb=document.querySelector('.hs-searchbar');
    if(sb){ var r=sb.getBoundingClientRect(); var el=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
      out.sbHit = el ? ((el.className&&typeof el.className==='string')?el.className:el.tagName) : null;
      out.sbHitOk = !!(el && sb.contains(el)); }
    out.overlayAtCenter = window.__P.chain ? null : null;
    return out;
  })()`);
  R.pre = pre;
  if (!pre || !pre.sbHitOk) R.notes.push('★前置检查失败：搜索框上方仍有东西挡着（' + (pre && pre.sbHit) + '），后续测得的都是浮层像素');
  await sleep(200);

  /* ========================= ① 搜索框侧光 ========================= */
  try {
    const sb = await evaluate(`(function(){
      var e = document.querySelector('.hs-searchbar'); if(!e) return null;
      var r = e.getBoundingClientRect();
      return {l:r.left, t:r.top, w:r.width, h:r.height, css:getComputedStyle(e).cssText.length};
    })()`);
    R.glow.rect = sb;
    if (sb && sb.w > 50) {
      /* 截一条比搜索框略大的带（含上下各 10px 邻域，便于看它压在什么底上） */
      const clip = {
        x: Math.max(0, Math.round(sb.l) - 4), y: Math.max(0, Math.round(sb.t) - 10),
        width: Math.round(sb.w) + 8, height: Math.round(sb.h) + 20, scale: 1
      };
      const grab = async () => {
        const cap = await cdp.send('Page.captureScreenshot', { format: 'png', clip });
        return cap.data;
      };
      /* 基线：关掉 ::after 的两层背景（灯光 + 折射 + 基础照明全没了）*/
      await evaluate(`window.__P.killAfterBg(true)`);
      await sleep(250);
      const baseShot = await grab();
      const base = await evaluate(`window.__P.analyze(${JSON.stringify(baseShot)}, ${clip.width}, ${clip.height}, 0.15, 0.15)`);
      R.glow.baseline = base;
      await evaluate(`window.__P.killAfterBg(false)`);
      await sleep(250);

      /* 相位步长 0.3s（一个 3.6s 周期采 13 个点）：相邻两点的差就是「这一瞬间灯跳了多少」。
         ★第 10 轮修正★：上一版比的是 t=3.59 与 t=0（一个周期的首尾），
         而 -delay 冻相位的实际当前时间 = t + 常数，首尾两点恰好落在同一相位上，
         于是「接缝 = 0」是自欺欺人；真正的瞬跳在参数序列的中间（见 t=1.2 → 1.6）。 */
      const phases = [];
      for (let k = 0; k <= 12; k++) phases.push(+(k * 0.3).toFixed(2));
      R.glow.shade = await evaluate(`window.__P.shade()`);
      const rows = [];
      for (const t of phases) {
        await evaluate(`window.__P.pauseAnim(${t})`);
        await sleep(120);
        const s = await grab();
        const a = await evaluate(`window.__P.analyze(${JSON.stringify(s)}, ${clip.width}, ${clip.height}, 0.15, 0.15)`);
        const bp = await evaluate(`window.__P.bgPos('.hs-searchbar')`);
        const sh = await evaluate(`window.__P.shade()`);
        rows.push({
          t: t,
          pos: bp && bp.pos,
          posFirst: bp && bp.pos ? bp.pos.split(',')[0].trim() : null,
          shadePos: sh && sh.pos ? sh.pos.split(',')[0].trim() : null,
          afterAnim: bp && bp.anim,
          left: a && a.left, right: a && a.right, all: a && a.all,
          dL: a && base && base.left != null ? +(a.left - base.left).toFixed(3) : null,
          dR: a && base && base.right != null ? +(a.right - base.right).toFixed(3) : null,
          d: a && base && a.all != null && base.all != null ? +(a.all - base.all).toFixed(3) : null,
          diff: a && a.left != null ? +(a.left - a.right).toFixed(3) : null
        });
        log('glow t=' + t + 's pos=' + (rows[rows.length - 1].posFirst) + ' shade=' + (rows[rows.length - 1].shadePos) +
            ' dL=' + rows[rows.length - 1].dL + ' dR=' + rows[rows.length - 1].dR + ' diff=' + rows[rows.length - 1].diff);
      }
      await evaluate(`window.__P.pauseAnim(null)`);
      R.glow.clip = clip;
      R.glow.rows = rows;
      /* ---- 平滑性：相邻相位的「灯位移」跳变（百分点）与像素跳变 ----
         background-position 的 p% 对应灯心在盒上的位置 = (1 − p) × 盒宽，
         所以相邻两个采样点的 Δp（百分点）几乎等于「灯横跳了盒宽的百分之几」。 */
      let maxPosStep = 0, maxPosStepAt = null, maxPixelStep = 0, maxPixelStepAt = null;
      const num = v => { const m = String(v || '').match(/(-?[\d.]+)%/); return m ? parseFloat(m[1]) : null; };
      for (let i = 1; i < rows.length; i++) {
        const a = num(rows[i - 1].posFirst), b = num(rows[i].posFirst);
        if (a != null && b != null) {
          const d = Math.abs(b - a);
          if (d > maxPosStep) { maxPosStep = d; maxPosStepAt = rows[i - 1].t + '→' + rows[i].t; }
        }
        const dl = Math.abs((rows[i].dL || 0) - (rows[i - 1].dL || 0));
        const dr = Math.abs((rows[i].dR || 0) - (rows[i - 1].dR || 0));
        const d = Math.max(dl, dr);
        if (d > maxPixelStep) { maxPixelStep = d; maxPixelStepAt = rows[i - 1].t + '→' + rows[i].t; }
      }
      const dLs = rows.map(r => r.dL).filter(v => v != null);
      const dRs = rows.map(r => r.dR).filter(v => v != null);
      const minL = dLs.length ? Math.min.apply(null, dLs) : null;
      const minR = dRs.length ? Math.min.apply(null, dRs) : null;
      const maxL = dLs.length ? Math.max.apply(null, dLs) : null;
      const maxR = dRs.length ? Math.max.apply(null, dRs) : null;
      R.glow.smooth = { maxPosStepPP: +maxPosStep.toFixed(2), maxPosStepAt: maxPosStepAt,
                        maxPixelStep: +maxPixelStep.toFixed(3), maxPixelStepAt: maxPixelStepAt };
      /* ---- 用户的原始诉求：灯走到哪一侧，**另一侧要暗下去**（而不是发亮）----
         位置读数语义（真机实测标定）：pos≈100% = 灯在左、pos≈0% = 灯在右。 */
      let lampRightMinL = null, lampLeftMinR = null, lampRightMinR = null, lampLeftMinL = null;
      rows.forEach(r => {
        const p = num(r.posFirst); if (p == null) return;
        if (p < 30) {                                     /* 灯在右：左半区应当变暗 */
          if (r.dL != null && (lampRightMinL == null || r.dL < lampRightMinL)) lampRightMinL = r.dL;
          if (r.dR != null && (lampRightMinR == null || r.dR > lampRightMinR)) lampRightMinR = r.dR;
        }
        if (p > 70) {                                     /* 灯在左：右半区应当变暗 */
          if (r.dR != null && (lampLeftMinR == null || r.dR < lampLeftMinR)) lampLeftMinR = r.dR;
          if (r.dL != null && (lampLeftMinL == null || r.dL > lampLeftMinL)) lampLeftMinL = r.dL;
        }
      });
      R.glow.verdict = {
        leftEverDarker: minL != null && minL < -1.5, minDLeft: minL,
        rightEverDarker: minR != null && minR < -1.5, minDRight: minR,
        maxDLeft: maxL, maxDRight: maxR,
        lampVisible: maxL != null && maxR != null && (maxL > 1.5 || maxR > 1.5),
        /* 灯在右时左半区的最大变暗量 / 灯在左时右半区的最大变暗量（用户诉求的正解） */
        lampRightMinDLeft: lampRightMinL, lampLeftMinDRight: lampLeftMinR,
        lampRightMaxDRight: lampRightMinR, lampLeftMaxDLeft: lampLeftMinL,
        satisfyUserLampRightDarkensLeft: lampRightMinL != null && lampRightMinL < -1.5,
        satisfyUserLampLeftDarkensRight: lampLeftMinR != null && lampLeftMinR < -1.5,
        /* 平滑：相邻相位的灯位移不能瞬跳（第 10 轮加了 alternate 之后 ≤30pp） */
        smooth: maxPosStep < 30,
        pixelStepRatio: (maxR != null && minR != null && maxR - minR > 0)
          ? +(maxPixelStep / Math.max(1, maxR - minR)).toFixed(3) : null
      };
      await shot('.tmp/ui-glow-' + TAG + '.png');
    } else {
      R.notes.push('没找到 .hs-searchbar 或宽度异常');
    }
  } catch (e) { R.errors = (R.errors || []).concat('glow: ' + String(e && e.message || e)); }

  /* ========================= ② 阅读器横向单页 ========================= */
  try {
    const sy = await evaluate(SYNTH);
    R.reader.synth = sy;
    await evaluate(`(function(){
      window.HS.settings.readerDir = 'h';
      window.__OPENED = null;
      window.HS.reader.open({source:'jmcomic', id:'ui-truth', title:'UI-TRUTH'}).then(function(){ window.__OPENED = 'ok'; },
        function(e){ window.__OPENED = 'err:' + String(e && e.message || e); });
      return 'opening';
    })()`);
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const st = await evaluate(`(function(){
        var pg = document.querySelector('.hs-rd-pg.is-cur');
        var img = window.__P.curImg();
        return {opened: window.__OPENED, dir: window.__P.dir(), hasPg: !!pg, idx: window.__P.curIdx(),
                img: !!img, complete: !!(img && img.complete && img.naturalWidth), nw: img?img.naturalWidth:0, nh: img?img.naturalHeight:0};
      })()`);
      if (st.complete) { R.reader.ready = st; break; }
      if (i === 39) R.reader.ready = st;
    }
    await sleep(400);
    R.reader.viewport = await evaluate(`({w:innerWidth, h:innerHeight})`);
    R.reader.geom100 = await evaluate(`({rect:window.__P.rect(window.__P.box()), img:window.__P.rect(window.__P.curImg()), scrolls:window.__P.scrolls(), idx:window.__P.curIdx(), zoom:window.__P.zoomVal()})`);
    await shot('.tmp/ui-reader-' + TAG + '-100.png');

    /* ---- ① 缩放漂移（干净态：刚 open、没有任何拖拽残留）----
       必须放在拖拽之前：残留的 translate3d 会让 zoomAnchor() 量到「含位移的 rect」，
       锚点 fraction 就指向另一个内容点（上一轮 in1 的 31.49px 漂移就是这么来的）。 */
    const zoomStep = async (sel, label) => {
      const before = await evaluate(`window.__P.anchor()`);
      await evaluate(`document.querySelector('${sel}').click()`);
      await sleep(420);
      const after = await evaluate(`window.__P.drift(${JSON.stringify(before)})`);
      const rec = { label: label, zoom: await evaluate(`window.__P.zoomVal()`), drift: after,
                    fx: before ? +before.fx.toFixed(4) : null, fy: before ? +before.fy.toFixed(4) : null,
                    imgRect: before ? before.rect : null, scrolls: await evaluate(`window.__P.scrolls()`) };
      log('zoomClean ' + label + ' → ' + rec.zoom + ' drift=' + JSON.stringify(after));
      return rec;
    };
    R.reader.zoomClean = [];
    R.reader.zoomClean.push(await zoomStep('[data-rd-zoomin]', 'in1'));
    R.reader.zoomClean.push(await zoomStep('[data-rd-zoomin]', 'in2'));
    await shot('.tmp/ui-reader-' + TAG + '-zoom-clean.png');
    R.reader.zoomClean.push(await zoomStep('[data-rd-zoomout]', 'out1'));
    R.reader.zoomClean.push(await zoomStep('[data-rd-zoomout]', 'out2'));
    R.reader.zoomClean.push(await zoomStep('[data-rd-zoomval]', 'reset'));
    /* 关掉重开：把缩放留下的残差位移清干净，后面拖拽的基线才是 0 */
    await evaluate(`window.HS.reader.close()`);
    await sleep(300);
    await evaluate(`(function(){
      window.__OPENED = null;
      window.HS.reader.open({source:'jmcomic', id:'ui-truth', title:'UI-TRUTH'}).then(function(){ window.__OPENED='ok'; },
        function(e){ window.__OPENED='err:' + String(e && e.message || e); });
      return 'reopening';
    })()`);
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const st = await evaluate(`(function(){ var img=window.__P.curImg(); return {opened:window.__OPENED, complete:!!(img&&img.complete&&img.naturalWidth), idx:window.__P.curIdx(), tf:window.__P.imgTf()}; })()`);
      if (st.complete) { R.reader.reopen = st; break; }
      if (i === 39) R.reader.reopen = st;
    }
    await sleep(400);
    R.reader.geom100b = await evaluate(`({rect:window.__P.rect(window.__P.box()), img:window.__P.rect(window.__P.curImg()), scrolls:window.__P.scrolls(), idx:window.__P.curIdx(), zoom:window.__P.zoomVal()})`);

    /* ---- 回归：单击右半屏要翻页 ---- */
    const cx = Math.round(R.reader.viewport.w / 2), cy = Math.round(R.reader.viewport.h / 2);
    /* 前置：视口正中必须真的命中阅读器内部，否则后面所有指针结论都是浮层的锅 */
    R.reader.hitOk = await evaluate(`(function(){
      var rd=document.querySelector('.hs-rd'); var el=document.elementFromPoint(${cx}, ${cy});
      return {ok: !!(el && rd && rd.contains(el)),
              el: el ? ((el.className&&typeof el.className==='string') ? (el.tagName.toLowerCase()+'.'+el.className.trim().replace(/\\s+/g,'.')) : el.tagName) : null,
              elInScroll: !!(el && el.closest && el.closest('[data-rd-scroll]'))};
    })()`);
    if (!R.reader.hitOk.ok) R.notes.push('★阅读器中心被浮层挡住：' + R.reader.hitOk.el);
    const idxBefore = await evaluate(`window.__P.curIdx()`);
    await mouse.move(cx + 200, cy);
    await mouse.down(cx + 200, cy);
    await sleep(60);
    await mouse.up(cx + 200, cy);
    await sleep(400);
    const idxAfterTap = await evaluate(`window.__P.curIdx()`);
    R.reader.tapFlip = { before: idxBefore, after: idxAfterTap, flipped: idxAfterTap === idxBefore + 1 };
    /* 翻回第 1 页 */
    await evaluate(`(function(){ var b=document.querySelector('[data-rd-hot-prev]'); return 'x'; })()`);
    await mouse.move(120, cy); await mouse.down(120, cy); await sleep(60); await mouse.up(120, cy);
    await sleep(400);
    R.reader.backTo = await evaluate(`window.__P.curIdx()`);

    /* ---- 拖拽 @100%（两轴都装得下 → transform 分支）---- */
    const drag = async (dx, dy) => {
      await mouse.move(cx, cy);
      await mouse.down(cx, cy);
      await sleep(60);
      for (let k = 1; k <= 4; k++) {
        await mouse.move(cx + dx * k / 4, cy + dy * k / 4, { buttons: 1 });
        await sleep(40);
      }
      await sleep(60);
      const mid = await evaluate(`({tf:window.__P.imgTf(), scrolls:window.__P.scrolls(), idx:window.__P.curIdx()})`);
      await mouse.up(cx + dx, cy + dy);
      await sleep(300);
      const end = await evaluate(`({tf:window.__P.imgTf(), scrolls:window.__P.scrolls(), idx:window.__P.curIdx()})`);
      return { mid: mid, end: end };
    };
    R.reader.drag100 = await drag(120, 80);
    await shot('.tmp/ui-reader-' + TAG + '-drag100.png');

    /* ---- 缩放漂移已在拖拽之前测过（见上面的 R.reader.zoomClean）---- */

    /* ---- 拖拽 @200%（有滚动余量 → 滚分支）---- */
    await evaluate(`document.querySelector('[data-rd-zoomin]').click()`);
    await evaluate(`document.querySelector('[data-rd-zoomin]').click()`);
    await sleep(500);
    R.reader.geom200 = await evaluate(`({rect:window.__P.rect(window.__P.box()), img:window.__P.rect(window.__P.curImg()), scrolls:window.__P.scrolls(), zoom:window.__P.zoomVal()})`);
    R.reader.drag200 = await drag(140, 90);
    R.reader.drag200again = await drag(-160, -110);
    await shot('.tmp/ui-reader-' + TAG + '-drag200.png');
    /* 缩小回 100% 再量一次漂移（用户报的「缩小」方向） */
    await evaluate(`document.querySelector('[data-rd-zoomval]').click()`);
    await sleep(400);
    const b4 = await evaluate(`window.__P.anchor()`);
    await evaluate(`document.querySelector('[data-rd-zoomout]').click()`);
    await sleep(400);
    R.reader.zoomOutFrom100 = { zoom: await evaluate(`window.__P.zoomVal()`), drift: await evaluate(`window.__P.drift(${JSON.stringify(b4)})`) };

    /* ---- 第 10 轮追加：非居中基线（先滚到偏角再放大），锚点同样必须钉住 ---- */
    await evaluate(`document.querySelector('[data-rd-zoomval]').click()`);
    await sleep(300);
    await evaluate(`document.querySelector('[data-rd-zoomin]').click()`);
    await sleep(400);
    await evaluate(`(function(){ var pg=window.__P.box(); if(pg){ pg.scrollLeft = 180; pg.scrollTop = 90; } return 'x'; })()`);
    await sleep(250);
    R.reader.cornerAt120 = await evaluate(`({scrolls:window.__P.scrolls(), anchor:window.__P.anchor()})`);
    R.reader.zoomFromCorner = await zoomStep('[data-rd-zoomin]', 'corner120to140');

    R.reader.finalDir = await evaluate(`window.__P.dir()`);
    await evaluate(`window.HS.reader.close()`);
  } catch (e) { R.errors = (R.errors || []).concat('reader: ' + String((e && e.stack) || e)); }

  const outFile = path.join(ROOT, 'tools', 'ui-truth-' + TAG + '.json');
  fs.writeFileSync(outFile, JSON.stringify(R, null, 2));
  log('结果 → ' + outFile);
  return R;
};
