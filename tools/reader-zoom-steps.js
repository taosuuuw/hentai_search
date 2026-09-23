'use strict';
/* ==========================================================================
   tools/reader-zoom-steps.js —— 阅读器「缩放保位 + 任意倍率拖动」真机取证
   --------------------------------------------------------------------------
   为什么又要一个：tools/ui-truth-steps.js 只测了**横向单页**（dir='h'）。
   用户报的两条症状是在**默认的纵向连续**（dir='v'）下感受最明显：
     · 放大后「图片位置会改变」—— 纵向是流式多页，一放大前面每页都变高，
       正在看的那张会被推走；锚点补偿如果拿错了页（.is-cur 判的是「顶部过线 <140px」，
       不是「视口正中那一页」）就会补错方向。
     · 「任何大小下都要能按住拖」—— 纵向模式下 x 轴与 y 轴落在不同盒子上
       （scrollPair(): x=el.pages/root, y=vRef()），只要解析错一个，拖动就会「没反应」。
   所以本脚本按「用户视角」量：**视口正中命中的那一张图**的屏幕矩形，缩放前后比它自己。

   用法（Chrome 需要不受限沙箱）：
     node tools/live-probe.js --steps=tools/reader-zoom-steps.js --w=1280 --h=900 --wait=1500
   产出：tools/reader-zoom-<tag>.json（HS_RD_TAG 控制，默认 'run'）
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const TAG = process.env.HS_RD_TAG || 'run';

/* ------------------------------- 页面内工具 ------------------------------- */
const SETUP = `(function(){
  var Q = window.__Q = window.__Q || {};
  Q.box = function(el){
    if(!el) return null; var r = el.getBoundingClientRect();
    return {l:+r.left.toFixed(1), t:+r.top.toFixed(1), w:+r.width.toFixed(1), h:+r.height.toFixed(1),
            cx:+(r.left+r.width/2).toFixed(1), cy:+(r.top+r.height/2).toFixed(1)};
  };
  Q.imgOf = function(pg){
    if(!pg) return null;
    return pg.querySelector('.hs-rd-img img') || pg.querySelector('.hs-rd-img canvas') || pg.querySelector('img');
  };
  Q.pages = function(){ return [].slice.call(document.querySelectorAll('.hs-rd-pg')); };
  Q.sc = function(e){
    return e ? {x:e.scrollLeft, y:e.scrollTop, roomX:e.scrollWidth-e.clientWidth, roomY:e.scrollHeight-e.clientHeight,
                sw:e.scrollWidth, sh:e.scrollHeight, w:e.clientWidth, h:e.clientHeight} : null;
  };
  /* 视口正中命中的那一张图（用户真正在看的那张）*/
  Q.hit = function(){
    var cx = innerWidth/2, cy = innerHeight/2, pgs = Q.pages();
    for(var i=0;i<pgs.length;i++){
      var im = Q.imgOf(pgs[i]); if(!im) continue;
      var r = im.getBoundingClientRect();
      if(cx>=r.left && cx<=r.right && cy>=r.top && cy<=r.bottom) return {img:im, idx:i, pg:pgs[i]};
    }
    return null;
  };
  /* 按序号直接取第 i 页那张图的屏幕矩形。拖动判据必须用它，不能用 Q.hit()：
     一拖动视口正中就可能从一页跨到下一页，hitBox 会「串页」，
     于是同一个数字里混进了「正好一页的页距」（实测 1407.2px 量级的假位移）。 */
  Q.at = function(i){ var p = Q.pages()[i]; var im = p ? Q.imgOf(p) : null; return im ? Q.box(im) : null; };
  /* 判据用的「钉子」：缩放前把命中图上的那个分数点记下来，缩放后量它跑到哪 */
  Q.pin = function(){
    var h = Q.hit(); if(!h) return null;
    var im = h.img, r = im.getBoundingClientRect(), b = Q.box(im);
    var cx = innerWidth/2, cy = innerHeight/2;
    im.setAttribute('data-q-pin','1');
    return {idx:h.idx, box:b,
      fx: r.width>1 ? (cx-r.left)/r.width : 0.5,
      fy: r.height>1 ? (cy-r.top)/r.height : 0.5,
      cx:cx, cy:cy, tf: im.style.transform || 'none'};
  };
  Q.track = function(){
    var im = document.querySelector('[data-q-pin]');
    if(!im || !im.isConnected) return null;
    var b = Q.box(im), cx = window.__Q_PIN ? window.__Q_PIN.cx : innerWidth/2, cy = window.__Q_PIN ? window.__Q_PIN.cy : innerHeight/2;
    var p = window.__Q_PIN || {fx:0.5, fy:0.5};
    var tx = b.l + p.fx*b.w, ty = b.t + p.fy*b.h;
    return {box:b, zoom:Q.zoom(), tf: im.style.transform || 'none',
            dx:+(tx-cx).toFixed(2), dy:+(ty-cy).toFixed(2), d:+Math.hypot(tx-cx,ty-cy).toFixed(2)};
  };
  Q.zoom = function(){
    var v = document.querySelector('[data-rd-zoomval]');
    return v ? v.textContent : null;
  };
  Q.snap = function(){
    var h = Q.hit(), pgs = Q.pages();
    var cur = document.querySelector('.hs-rd-pg.is-cur');
    var s = document.querySelector('[data-rd-scroll]'), col = document.querySelector('[data-rd-pages]'), rd = document.querySelector('.hs-rd');
    var out = {
      zoom: Q.zoom(),
      curIdx: pgs.indexOf(cur),
      hitIdx: h ? h.idx : -1,
      hitBox: h ? Q.box(h.img) : null,
      tf: h ? (h.img.style.transform || 'none') : null,
      scroll: Q.sc(s), pages: Q.sc(col), rd: Q.sc(rd),
      nPages: pgs.length,
      vis: pgs.map(function(p,i){ return {i:i, box: Q.box(Q.imgOf(p))}; })
    };
    if (h) { var b = out.hitBox; out.hitCtrOff = {x:+(b.cx-innerWidth/2).toFixed(1), y:+(b.cy-innerHeight/2).toFixed(1)}; }
    return out;
  };
  return 'setup-ok';
})()`;

/* ------------------------------ 合成章节数据 ------------------------------ */
const SYNTH = `(function(){
  function page(i){
    var w = 1000, h = 1400, g = '';
    for(var x=100;x<w;x+=100) g += '<line x1="'+x+'" y1="0" x2="'+x+'" y2="'+h+'" stroke="#c9c9c9" stroke-width="2"/>';
    for(var y=100;y<h;y+=100) g += '<line x1="0" y1="'+y+'" x2="'+w+'" y2="'+y+'" stroke="#c9c9c9" stroke-width="2"/>';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'">' +
      '<rect width="'+w+'" height="'+h+'" fill="#ffffff"/>' + g +
      '<line x1="'+(w/2)+'" y1="'+(h/2-90)+'" x2="'+(w/2)+'" y2="'+(h/2+90)+'" stroke="#e11" stroke-width="6"/>' +
      '<line x1="'+(w/2-90)+'" y1="'+(h/2)+'" x2="'+(w/2+90)+'" y2="'+(h/2)+'" stroke="#e11" stroke-width="6"/>' +
      '<text x="30" y="90" font-size="70" fill="#111" font-family="monospace">P'+(i+1)+'</text>' +
      '<text x="30" y="'+(h-30)+'" font-size="70" fill="#111" font-family="monospace">P'+(i+1)+'</text></svg>';
    return {url:'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), w:w, h:h};
  }
  var pages = []; for(var i=0;i<6;i++) pages.push(page(i));
  var of = window.fetch;
  window.fetch = function(u, o){
    if(String(u).indexOf('/api/reader') >= 0){
      return Promise.resolve(new Response(JSON.stringify({ok:true, title:'RD-ZOOM', chapters:[{id:'c1', name:'dan'}], pages:pages}),
        {status:200, headers:{'Content-Type':'application/json'}}));
    }
    return of.apply(this, arguments);
  };
  return {pages: pages.length, w: pages[0].w, h: pages[0].h};
})()`;

module.exports = async function main(ctx) {
  const { evaluate, shot, mouse, sleep, log } = ctx;
  const R = { tag: TAG, at: new Date().toISOString(), modes: {}, notes: [] };

  await evaluate(SETUP);
  await evaluate(`(function(){
    try{ HS.settings.adultOk = true; if(HS.store && HS.store.save) HS.store.save(HS.settings); }catch(e){}
    var g = document.getElementById('gate'); if(g) g.hidden = true;
    var nb = document.getElementById('net-banner'); if(nb) nb.hidden = true;
    return 'gated';
  })()`);
  R.synth = await evaluate(SYNTH);

  const waitOpen = async () => {
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const st = await evaluate(`(function(){
        var pgs = document.querySelectorAll('.hs-rd-pg');
        var im = window.__Q.imgOf(document.querySelector('.hs-rd-pg'));
        return {opened: window.__OPENED, n: pgs.length, complete: !!(im && im.complete && im.naturalWidth)};
      })()`);
      if (st.complete && st.n >= 2) return st;
    }
    return null;
  };

  const openIn = async (dir, id) => {
    await evaluate(`(function(){ try{ window.HS.reader.close(); }catch(e){} return 'closed'; })()`);
    await sleep(250);
    await evaluate(`(function(){ window.HS.settings.readerDir = '${dir}'; return 'dir'; })()`);
    await evaluate(`(function(){
      window.__OPENED = null;
      window.HS.reader.open({source:'jmcomic', id:'${id}', title:'RD-ZOOM'}).then(function(){ window.__OPENED='ok'; },
        function(e){ window.__OPENED='err:' + String(e && e.message || e); });
      return 'opening';
    })()`);
    const st = await waitOpen();
    await sleep(400);
    return st;
  };

  /* 一次缩放：先钉住视口正中那张图上的分数点，点按钮，再量它跑到哪 */
  const zoomStep = async (sel, label) => {
    await evaluate(`(function(){ window.__Q_PIN = window.__Q.pin(); return window.__Q_PIN; })()`);
    const before = await evaluate(`window.__Q.snap()`);
    await evaluate(`document.querySelector('${sel}').click()`);
    await sleep(420);
    const after = await evaluate(`window.__Q.snap()`);
    const tr = await evaluate(`window.__Q.track()`);
    await evaluate(`(function(){ var e=document.querySelector('[data-q-pin]'); if(e) e.removeAttribute('data-q-pin'); return 1; })()`);
    const rec = { label, sel, zoom: after.zoom, before, after, track: tr,
      /* 命中图自己的屏幕矩形位移（用户感知的「位置变了」） */
      hitMoved: (before.hitBox && after.hitBox) ? {
        dl: +(after.hitBox.l - before.hitBox.l).toFixed(1),
        dt: +(after.hitBox.t - before.hitBox.t).toFixed(1),
        dcx: +(after.hitBox.cx - before.hitBox.cx).toFixed(1),
        dcy: +(after.hitBox.cy - before.hitBox.cy).toFixed(1),
        dw: +(after.hitBox.w - before.hitBox.w).toFixed(1),
        dh: +(after.hitBox.h - before.hitBox.h).toFixed(1)
      } : null,
      idxChanged: (before.hitIdx !== after.hitIdx) ? (before.hitIdx + '→' + after.hitIdx) : null };
    log('[' + label + '] ' + rec.zoom + ' pinDrift=' + (tr ? tr.d : 'null') +
        ' hitMoved=' + JSON.stringify(rec.hitMoved));
    return rec;
  };

  const drag = async (dx, dy, label) => {
    const cx = 640, cy = 450;
    const b0 = await evaluate(`window.__Q.snap()`);
    const i0 = b0.hitIdx;                                  /* 盯住这一页，拖动中不换目标 */
    const at0 = await evaluate(`window.__Q.at(${i0})`);
    const rel = (b) => (b && at0) ? { dl: +(b.l - at0.l).toFixed(1), dt: +(b.t - at0.t).toFixed(1) } : null;
    await mouse.move(cx, cy);
    await mouse.down(cx, cy);
    await sleep(60);
    for (let k = 1; k <= 4; k++) { await mouse.move(cx + dx * k / 4, cy + dy * k / 4, { buttons: 1 }); await sleep(40); }
    await sleep(60);
    const mid = await evaluate(`window.__Q.snap()`);
    const atMid = await evaluate(`window.__Q.at(${i0})`);
    await mouse.up(cx + dx, cy + dy);
    await sleep(300);
    const end = await evaluate(`window.__Q.snap()`);
    const atEnd = await evaluate(`window.__Q.at(${i0})`);
    const rec = { label, dx, dy, idx: i0,
      /* ★判据★ 同一张图（第 i0 页）的屏幕位移：拖动时应与指针位移同向同量（到边界为止） */
      movedMid: rel(atMid), movedEnd: rel(atEnd),
      /* 真实滚动量：真正在滚的是 .hs-rd（root）。上一版 rec 只记了不滚的 [data-rd-scroll]，
         那个容器 clientHeight === scrollHeight，永远是 0，什么也证明不了。 */
      rdMid: mid.rd, rdEnd: end.rd,
      hitIdx: b0.hitIdx + '→' + end.hitIdx,
      tfMid: mid.tf, tfEnd: end.tf };
    log('drag[' + label + '] idx=' + i0 + ' endΔ=' + JSON.stringify(rec.movedEnd) +
        ' rootScrollY=' + (end.rd ? end.rd.y : '?') + ' hit=' + rec.hitIdx + ' tf=' + rec.tfEnd);
    return rec;
  };

  /* 滚动到某一页的中间（模拟「正在看第 N 页」）
     ⚠ 纵向真正在滚的是 .hs-rd（root）本身：实测 root clientHeight=900 / 余量 7757px，
     而 [data-rd-scroll] 与 [data-rd-pages] 的 clientHeight === scrollHeight（余量 0）。
     所以这里按「谁有余量谁说了算」挑容器，别再写死 [data-rd-scroll]（写死等于没滚）。 */
  const scrollToPage = async (i, frac) => {
    await evaluate(`(function(){
      var pgs = window.__Q.pages();
      if(!pgs[${i}]) return null;
      var cands = [document.querySelector('.hs-rd'),
                   document.querySelector('[data-rd-scroll]'),
                   document.querySelector('[data-rd-pages]')].filter(Boolean);
      var s = null, bestRoom = -1;
      for (var k=0;k<cands.length;k++){
        var r = cands[k].scrollHeight - cands[k].clientHeight;
        if (r > bestRoom) { bestRoom = r; s = cands[k]; }
      }
      if(!s || bestRoom <= 0) return null;
      var t = s.scrollTop + (pgs[${i}].getBoundingClientRect().top - s.getBoundingClientRect().top)
              + pgs[${i}].offsetHeight * ${frac} - innerHeight/2;
      s.scrollTop = Math.max(0, t);
      return s.scrollTop;
    })()`);
    await sleep(400);
  };

  /* ===================== 纵向连续（默认模式） ===================== */
  try {
    R.modes.v = { open: await openIn('v', 'rdzoom-v') };
    R.modes.v.base = await evaluate(`window.__Q.snap()`);
    await shot('.tmp/rd-v-' + TAG + '-100.png');

    /* 场景 1：视口正中就是某页中心（最干净） */
    R.modes.v.zoom = [];
    R.modes.v.zoom.push(await zoomStep('[data-rd-zoomin]', 'v-in1'));
    R.modes.v.zoom.push(await zoomStep('[data-rd-zoomin]', 'v-in2'));
    await shot('.tmp/rd-v-' + TAG + '-zoom.png');
    R.modes.v.zoom.push(await zoomStep('[data-rd-zoomout]', 'v-out1'));
    R.modes.v.zoom.push(await zoomStep('[data-rd-zoomout]', 'v-out2'));
    R.modes.v.zoom.push(await zoomStep('[data-rd-zoomval]', 'v-reset'));

    /* 场景 2：先滚到「两页交界」处（视口正中不在任何一页的中心）再放大 —— 
       锚点取错页的场景 */
    await scrollToPage(2, 1.02);
    R.modes.v.straddle = await evaluate(`window.__Q.snap()`);
    R.modes.v.straddleZoom = await zoomStep('[data-rd-zoomin]', 'v-straddle-in');
    await evaluate(`document.querySelector('[data-rd-zoomval]').click()`);
    await sleep(350);

    /* 场景 3：拖动（100% / 120% / 200%）—— 100% 纵向必然有滚动余量 */
    R.modes.v.drag100 = await drag(120, 90, 'v-100');
    R.modes.v.drag100b = await drag(-160, -120, 'v-100b');
    await evaluate(`(function(){ try{ HS.reader.close(); }catch(e){} return 1; })()`);
    await sleep(300);
    R.modes.v.reopen = await openIn('v', 'rdzoom-v2');
    await evaluate(`document.querySelector('[data-rd-zoomin]').click()`);
    await sleep(300);
    await evaluate(`document.querySelector('[data-rd-zoomin]').click()`);
    await sleep(450);
    R.modes.v.at140 = await evaluate(`window.__Q.snap()`);
    R.modes.v.drag140 = await drag(150, 100, 'v-140');
    await evaluate(`(function(){ var c=[document.querySelector('.hs-rd'),document.querySelector('[data-rd-scroll]'),document.querySelector('[data-rd-pages]')]; for(var i=0;i<c.length;i++){ if(c[i]) c[i].scrollTop=0; } return 1; })()`);
    await sleep(300);
    R.modes.v.drag140b = await drag(-180, -140, 'v-140b');
    await shot('.tmp/rd-v-' + TAG + '-drag.png');
  } catch (e) { R.errors = (R.errors || []).concat('v: ' + String((e && e.stack) || e)); }

  /* ===================== 横向单页（对照） ===================== */
  try {
    R.modes.h = { open: await openIn('h', 'rdzoom-h') };
    R.modes.h.base = await evaluate(`window.__Q.snap()`);
    R.modes.h.zoom = [];
    R.modes.h.zoom.push(await zoomStep('[data-rd-zoomin]', 'h-in1'));
    R.modes.h.zoom.push(await zoomStep('[data-rd-zoomin]', 'h-in2'));
    R.modes.h.zoom.push(await zoomStep('[data-rd-zoomout]', 'h-out1'));
    R.modes.h.zoom.push(await zoomStep('[data-rd-zoomout]', 'h-out2'));
    R.modes.h.zoom.push(await zoomStep('[data-rd-zoomval]', 'h-reset'));
    R.modes.h.drag100 = await drag(120, 90, 'h-100');
    await evaluate(`document.querySelector('[data-rd-zoomin]').click()`);
    await evaluate(`document.querySelector('[data-rd-zoomin]').click()`);
    await sleep(450);
    R.modes.h.at140 = await evaluate(`window.__Q.snap()`);
    R.modes.h.drag140 = await drag(150, 100, 'h-140');
    R.modes.h.drag140b = await drag(-180, -140, 'h-140b');
    await evaluate(`(function(){ try{ HS.reader.close(); }catch(e){} return 1; })()`);
  } catch (e) { R.errors = (R.errors || []).concat('h: ' + String((e && e.stack) || e)); }

  const outFile = path.join(ROOT, 'tools', 'reader-zoom-' + TAG + '.json');
  fs.writeFileSync(outFile, JSON.stringify(R, null, 2));
  log('结果 → ' + outFile);
  /* stdout 只回摘要：全量快照（每步 before/after 的整页矩形）留在 JSON 文件里，
     不然一次运行往控制台喷几十 KB，反而看不见规律。 */
  const zoomRow = (z) => ({ label: z.label, d: z.track ? z.track.d : null, hitMoved: z.hitMoved, idx: z.idxChanged });
  const dragRow = (d) => ({ label: d.label, dx: d.dx, dy: d.dy, idx: d.idx, movedMid: d.movedMid, movedEnd: d.movedEnd,
                            rootY: d.rdEnd ? d.rdEnd.y : null, rootRoomY: d.rdEnd ? d.rdEnd.roomY : null,
                            rootX: d.rdEnd ? d.rdEnd.x : null, rootRoomX: d.rdEnd ? d.rdEnd.roomX : null,
                            hit: d.hitIdx, tf: d.tfEnd });
  return { file: outFile,
    vZoom: R.modes.v ? (R.modes.v.zoom || []).map(zoomRow) : null,
    hZoom: R.modes.h ? (R.modes.h.zoom || []).map(zoomRow) : null,
    vStraddle: R.modes.v && R.modes.v.straddleZoom ? zoomRow(R.modes.v.straddleZoom) : null,
    vDrag: R.modes.v ? [R.modes.v.drag100, R.modes.v.drag100b, R.modes.v.drag140, R.modes.v.drag140b].filter(Boolean).map(dragRow) : null,
    hDrag: R.modes.h ? [R.modes.h.drag100, R.modes.h.drag140, R.modes.h.drag140b].filter(Boolean).map(dragRow) : null,
    errors: R.errors || null };
};
