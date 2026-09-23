'use strict';
/* 阅读器「禁漫 canvas 页」收敛矩阵（第 12 轮，2026-09-23）：
   用户报的两条都只发生在禁漫（jmcomic）上：
     ① 左右翻页(h)模式下放大，图片向右位移（应该保持原位）；
     ② 任意倍率下按住鼠标都拖不动图片。
   根因：禁漫页在 DOM 里是「display:none 的原 <img> + 还原出来的 <canvas>」两件套，
   而阅读器的锚点计算 / 命中测试全用 `.hs-rd-img img` 选择器 ⇒ 拿到的是那个隐藏元素
   （getBoundingClientRect() 全 0）⇒ 锚点退化 0.5/0.5、补偿算成 0、位移写到看不见的元素上。
   第 11 轮的 tools/reader-anysize-steps.js 全绿的假章节**只有 {url,w,h}**，没有
   scramble/bands ⇒ 根本走不到 canvas 那条路，所以当时没抓到。本脚本补的就是这一形态：
     · 夹具模式（默认）：假章节每页带 scramble + bands>1，让 paintScramble() 真的建 canvas；
     · 真机模式（HS_JM_REAL=1）：直接开真作品 jmcomic/1474911（真走网关 /api/reader + /api/proxy）。
   判据与第 11 轮一致：漂移 <4px（视口中心不变量）；拖拽「跟手」= |图上位移 - 鼠标位移| <= 8px。
   用法：
     node tools/live-probe.js --url=http://127.0.0.1:8788/ --steps=tools/reader-jmcanvas-steps.js --w=1280 --h=900 --wait=1500
     $env:HS_JM_REAL='1'; node tools/live-probe.js --url=... --steps=tools/reader-jmcanvas-steps.js --w=1280 --h=900 --wait=1500
   （Chrome 在 workspace-write 沙箱下会自毁，需要不受限模式。）
   快速模式：$env:HS_QS='1' 只跑竖图×h 一档。 */
module.exports = async function main(ctx) {
  const { evaluate, mouse, sleep, log } = ctx;
  const REAL = !!process.env.HS_JM_REAL;
  const QS = !!process.env.HS_QS;
  const R = { at: new Date().toISOString(), mode: REAL ? 'real:jmcomic/1474911' : 'fixture:bands', viewport: '1280x900', cases: {} };
  const DRIFT_MAX = 4;      /* 漂移判据 */
  const DRAG_TOL = 8;       /* 跟手判据 */
  /* 复刻 reader.js:1645-1657 的橡皮筋软限位：图上位移是**累积保留**的（第 9 轮），
     连拖几次后 base 会超过 panShiftLimit()（1280 宽 = 384px），softPan() 必然把这一下
     削掉一部分 —— 那是「拖不飞」的设计，不是 bug（本轮已用 tf0→tf1 数值验证：
     413.2+90 → 445.5 正好等于 softPan 的值）。所以「跟手」判据必须拿「软限位之后的
     预期位移」比，否则连着拖必然误报不跟手。 */
  const softPan = (v, limit) => { const a = Math.abs(v); if (a <= limit) return v;
    const c = limit * (1 + 0.6 * (1 - Math.exp(-(a - limit) / Math.max(1, limit)))); return v < 0 ? -c : c; };

  await evaluate(`(function(){
    try{ HS.settings.adultOk = true; if(HS.store&&HS.store.save) HS.store.save(HS.settings); }catch(e){}
    var g=document.getElementById('gate'); if(g) g.hidden=true;
    var nb=document.getElementById('net-banner'); if(nb) nb.hidden=true;
    return 1; })()`);

  /* 页面内工具：与 reader-anysize-steps.js 同一套口径，但**画面元素改走 canvas 优先**
     —— 这正是被测代码 pageVisual() 的判据，探针口径必须跟它一致，否则量的是隐藏的 img。 */
  await evaluate(`(function(){
    var Q = window.__Q = {};
    Q.pg = function(){ return document.querySelector('.hs-rd-pg.is-cur'); };
    /* 页里**真正显示出来**的元素：canvas → 可见 img → 页盒 */
    Q.vis = function(pg){ pg = pg||Q.pg(); if(!pg) return null;
      var c = pg.querySelector('.hs-rd-img canvas');
      if(c){ var rc=c.getBoundingClientRect(); if(rc.width>=1&&rc.height>=1) return c; }
      var i = pg.querySelector('.hs-rd-img img')||pg.querySelector('img');
      if(i){ var ri=i.getBoundingClientRect(); if(ri.width>=1&&ri.height>=1) return i; }
      return pg.querySelector('.hs-rd-img'); };
    /* 老的（第 11 轮探针的）选择器，用来当面证明「它拿到的是隐藏元素」 */
    Q.legacy = function(pg){ pg = pg||Q.pg();
      var i = pg && (pg.querySelector('.hs-rd-img img')||pg.querySelector('img'));
      if(!i) return null;
      var r=i.getBoundingClientRect(), cs=window.getComputedStyle(i);
      return { tag:i.tagName, display:cs.display, rect:Math.round(r.width)+'x'+Math.round(r.height),
               nat:(i.naturalWidth||0)+'x'+(i.naturalHeight||0) }; };
    Q.dom = function(pg){ pg = pg||Q.pg(); if(!pg) return null;
      var c=pg.querySelector('.hs-rd-img canvas'), i=pg.querySelector('.hs-rd-img img');
      return { canvas: !!c, canvasSize: c?(c.width+'x'+c.height):null,
               imgHidden: !!(i&&window.getComputedStyle(i).display==='none'),
               legacy: Q.legacy(pg), vis: (Q.vis(pg)||{}).tagName||null }; };
    Q.box = function(el){ if(!el) return null; var r=el.getBoundingClientRect();
      return {l:+r.left.toFixed(1),t:+r.top.toFixed(1),w:+r.width.toFixed(1),h:+r.height.toFixed(1),
              cx:+(r.left+r.width/2).toFixed(1),cy:+(r.top+r.height/2).toFixed(1)}; };
    Q.pic = function(el){
      if(!el) return null; var r=el.getBoundingClientRect();
      var isCv = el.tagName==='CANVAS';
      var nw = isCv ? el.width : el.naturalWidth, nh = isCv ? el.height : el.naturalHeight;
      if(!nw||!nh) return {l:r.left,t:r.top,w:r.width,h:r.height};
      var s=Math.min(r.width/nw,r.height/nh), w=nw*s, h=nh*s;
      return {l:r.left+(r.width-w)/2, t:r.top+(r.height-h)/2, w:w, h:h};
    };
    Q.rootBox = function(){ var r=document.querySelector('.hs-rd').getBoundingClientRect(); return {w:r.width,h:r.height}; };
    /* 与 reader.js scrollPair()/roomOf() 同一口径的「真正会滚的那对盒子」：
       h 模式 = 当前页盒（两个轴都它滚）；v 模式 = 纵轴选有余量的列、横轴选有余量的页盒/root。
       探针要判「该轴本来就不动（没余量且不是位移档）」就必须用真盒子，不能用页盒硬套。 */
    Q.sc = function(){ var h=!!document.querySelector('.hs-rd[data-dir="h"]'), pg=Q.pg();
      function room(el,ax){ if(!el) return 0; return Math.max(0, ax==='x'?(el.scrollWidth-el.clientWidth):(el.scrollHeight-el.clientHeight)); }
      if(h) return pg ? {xr:room(pg,'x'), yr:room(pg,'y'), xs:pg.scrollLeft, ys:pg.scrollTop, cmode:'h'} : null;
      /* v 模式：reader.js 的 vBoxFor() 走 vRef()→el.scroll→el.pages，探针拿不到 RD 内部引用，
         改为「在 .hs-rd 里扫出每轴 room 最大的那个盒子」——等价判据，且能如实算出
         「到顶/到边被夹住 ⇒ 该轴这一下本来就不动」。 */
      var root=document.querySelector('.hs-rd'), all=root?[root].concat([].slice.call(root.querySelectorAll('*'))):[];
      var best={xr:0,xs:0,xe:null,yr:0,ys:0,ye:null};
      for(var i=0;i<all.length;i++){ var el=all[i];
        var xr=room(el,'x'), yr=room(el,'y');
        if(xr>best.xr){best.xr=xr;best.xs=el.scrollLeft;best.xe=el;}
        if(yr>best.yr){best.yr=yr;best.ys=el.scrollTop;best.ye=el;} }
      return {xr:best.xr, yr:best.yr, xs:Math.round(best.xs), ys:Math.round(best.ys), cmode:'v',
              sel:{x:best.xe?String(best.xe.className).slice(0,40):null, y:best.ye?String(best.ye.className).slice(0,40):null}}; };
    Q.pin = function(){
      var el=Q.vis(); if(!el) return null; var p=Q.pic(el), rb=Q.rootBox();
      var cx=rb.w/2, cy=rb.h/2;
      window.__P = {fx:(cx-p.l)/p.w, fy:(cy-p.t)/p.h, cx:cx, cy:cy};
      return {fx:+window.__P.fx.toFixed(4), fy:+window.__P.fy.toFixed(4),
              pic:{l:+p.l.toFixed(1),t:+p.t.toFixed(1),w:+p.w.toFixed(1),h:+p.h.toFixed(1)}};
    };
    Q.drift = function(){
      var el=Q.vis(); if(!el) return null; var p=Q.pic(el), P=window.__P;
      if(!P||!p) return null;
      var tx=p.l+P.fx*p.w, ty=p.t+P.fy*p.h;
      var pg=Q.pg();
      return { d:+Math.hypot(tx-P.cx,ty-P.cy).toFixed(2), dx:+(tx-P.cx).toFixed(2), dy:+(ty-P.cy).toFixed(2),
        vis: el.tagName,
        zoom:(document.querySelector('[data-rd-zoomval]')||{}).textContent,
        room: pg ? ((pg.scrollWidth-pg.clientWidth)+'x'+(pg.scrollHeight-pg.clientHeight)) : null,
        scroll: pg ? (pg.scrollLeft+'/'+pg.scrollTop) : null,
        tf: el.style.transform||'none',
        pic:{l:+p.l.toFixed(1),t:+p.t.toFixed(1),w:+p.w.toFixed(1),h:+p.h.toFixed(1)} };
    };
    Q.state = function(){ return {zoom:(document.querySelector('[data-rd-zoomval]')||{}).textContent,
      dir:(document.querySelector('.hs-rd')||{getAttribute:function(){return null;}}).getAttribute('data-dir'),
      idx:(document.querySelector('.hs-rd-pg.is-cur')?[].indexOf.call(document.querySelectorAll('.hs-rd-pg'),document.querySelector('.hs-rd-pg.is-cur')):-1),
      n:document.querySelectorAll('.hs-rd-pg').length}; };
    return 'ok'; })()`);

  /* 夹具：假章节每页带 scramble + bands ⇒ makePage() 写 data-bands，loadImg() 的 load
     事件里真的跑 paintScramble()，于是 DOM 变成「隐藏 img + 可见 canvas」= 禁漫形态。 */
  const makeChapter = (w, h, bands) => evaluate(`(function(){
    function page(i){
      var w=${w}, h=${h};
      var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'">'+
        '<rect width="'+w+'" height="'+h+'" fill="#fff"/>'+
        '<rect width="'+w+'" height="'+(h/4)+'" fill="#cfe"/>'+
        '<line x1="'+(w/2)+'" y1="0" x2="'+(w/2)+'" y2="'+h+'" stroke="#e11" stroke-width="4"/>'+
        '<line x1="0" y1="'+(h/2)+'" x2="'+w+'" y2="'+(h/2)+'" stroke="#e11" stroke-width="4"/>'+
        '<text x="20" y="70" font-size="60" fill="#111" font-family="monospace">P'+(i+1)+'</text></svg>';
      return {url:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg), w:w, h:h,
              scramble:220980, bands:${bands}};
    }
    var pages=[]; for(var i=0;i<12;i++) pages.push(page(i));
    var of=window.fetch;
    window.fetch=function(u,o){
      if(String(u).indexOf('/api/reader')>=0){
        return Promise.resolve(new Response(JSON.stringify({ok:true,title:'JMCANVAS',chapters:[{id:'c1',name:'d'}],pages:pages}),
          {status:200,headers:{'Content-Type':'application/json'}}));
      }
      return of.apply(this,arguments);
    };
    window.__FIX = {pages:pages.length,w:${w},h:${h},bands:${bands}};
    return window.__FIX; })()`);

  const open = async (dir) => {
    await evaluate(`(function(){ try{ window.HS.reader.close(); }catch(e){} return 1; })()`);
    await sleep(250);
    await evaluate(`(function(){ window.HS.settings.readerDir='${dir}'; return 1; })()`);
    const target = REAL
      ? `{source:'jmcomic',id:'1474911',title:'JM 1474911'}`
      : `{source:'jmcomic',id:'jmcanvas-${dir}-'+Date.now(),title:'JMCANVAS'}`;
    await evaluate(`(function(){ window.__O=null;
      window.HS.reader.open(${target})
        .then(function(){window.__O='ok';},function(e){window.__O='err:'+e;});
      return 1; })()`);
    let dom = null;
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      dom = await evaluate(`(function(){ var d=window.__Q.dom()||{}; d.n=document.querySelectorAll('.hs-rd-pg').length;
        var c=document.querySelector('.hs-rd-pg.is-cur .hs-rd-img canvas, .hs-rd-pg .hs-rd-img canvas');
        d.cvReady = !!(c && c.width>1); return d; })()`);
      /* ★必须等「当前页」自己的 canvas★
         真机踩坑（第 12 轮）：只要**任何**页盒里有 canvas，cvReady 就是 true，
         于是 45 页的真作品会在「当前页还在解码、别的页已经画好」时提前跳出轮询 ——
         Q.dom() 只看 .is-cur，于是 open() 返回 canvas:false，真机矩阵整段作废。
         夹具模式每页都立刻有 canvas，所以一直没暴露。 */
      if (dom && dom.canvas && dom.n >= 2) break;
    }
    if (dom && !dom.canvas) {
      const census = await evaluate(`(function(){
        var ps=document.querySelectorAll('.hs-rd-pg'); var a=[];
        for(var i=0;i<ps.length && i<4;i++){ a.push(i+':'+(ps[i].querySelector('.hs-rd-img canvas')?'cv':'no')); }
        var im=document.querySelector('.hs-rd-pg.is-cur .hs-rd-img img');
        return 'pages='+ps.length+' cur='+(document.querySelector('.hs-rd-pg.is-cur')?'y':'n')+' ['+a.join(' ')+'] img='+
          (im?((im.complete?'complete':'loading')+' nat='+im.naturalWidth+'x'+im.naturalHeight+' disp='+getComputedStyle(im).display):'none'); })()`);
      log('    ⚠ 当前页仍无 canvas → ' + census);
    }
    await sleep(500);
    return dom;
  };

  const click = async (sel) => { await evaluate(`(function(){ var b=document.querySelector('${sel}'); if(!b||b.disabled) return 0; b.click(); return 1; })()`); };

  const zoomStep = async (sel, label, rec) => {
    await evaluate(`(function(){ window.__Q.pin(); return 1; })()`);
    await click(sel);
    await sleep(420);
    const a = await evaluate(`window.__Q.drift()`);
    const row = { label, zoom: a.zoom, vis: a.vis, drift: a.d, dx: a.dx, dy: a.dy, room: a.room, tf: String(a.tf).slice(0, 30) };
    rec.zoomSteps.push(row);
    if (a.vis !== 'CANVAS') rec.nonCanvas++;
    if (a.d > rec.maxDrift) { rec.maxDrift = a.d; rec.maxDriftAt = label + '@' + a.zoom; }
    log('    ' + label.padEnd(12) + String(a.zoom).padStart(5) + ' [' + a.vis + '] 漂移=' + String(a.d).padStart(7) + 'px  room=' + a.room);
    return row;
  };

  /* 读出「画面元素」当前 transform 的平移量（px），用来对照 rect 位移判断是否饱和/写错元素 */
  const TF_NUM = `(function(){ var el=window.__Q.vis(); if(!el) return null; var t=el.style.transform||'none';
    if(t==='none'||t==='') return [0,0];
    try{ var m=new DOMMatrix(t); return [+m.m41.toFixed(1),+m.m42.toFixed(1)]; }catch(e){ return null; } })()`;

  /* 真鼠标 down→4 段 move→up，量「画面元素」rect 的位移。
     第 12 轮加料：同时记录拖前/拖后的 transform 与当前页号 —— 用来区分
       (a) 「弹性软限位饱和」：图上位移 < 鼠标位移，但 tf 已到 panShiftLimit 弹性区；
       (b) 「拖动被当成点击」：页号变了（翻页）或 tf 完全没动。 */
  const drag = async (rec, dx, dy, label, cx, cy) => {
    cx = cx || 0; cy = cy || 0;
    const b = await evaluate(`window.__Q.drift()`);
    const st0 = await evaluate(`window.__Q.state()`);
    const t0 = await evaluate(TF_NUM);
    /* ★必须在按下鼠标**之前**取 sc（滚动位置是「拖前值」，拖后取会把 pos 当成拖后位置，
       预期位移算反/算错 —— 第 12 轮这里错过一次）。 */
    const sc = await evaluate(`window.__Q.sc()`);
    const lim = await evaluate(`Math.max(120, Math.min(420, (window.innerWidth||800)*0.30))`);
    const px = Math.round(640 + cx), py = Math.round(450 + cy);
    await mouse.move(px, py);
    await mouse.down(px, py);
    await sleep(70);
    for (let k = 1; k <= 4; k++) { await mouse.move(px + dx * k / 4, py + dy * k / 4, { buttons: 1 }); await sleep(45); }
    await mouse.up(px + dx, py + dy);
    await sleep(300);
    const e = await evaluate(`window.__Q.drift()`);
    const st1 = await evaluate(`window.__Q.state()`);
    const dl = (e && b) ? +(e.pic.l - b.pic.l).toFixed(1) : null;
    const dt = (e && b) ? +(e.pic.t - b.pic.t).toFixed(1) : null;
    /* 预期位移 —— 按产品自己的两条档位算（reader.js:1680-1767）：
       · 两轴都没有滚动余量 ⇒ pan.shift 临时位移档：图上位移 = softPan(base+d) - base；
       · 某轴有余量 ⇒ 滚动档：该轴图上位移 = pos - clamp(pos - d, 0, room)（到顶/到底/到边被夹住）；
       · 该轴既没余量又不走位移档 ⇒ 这一轴本来就不动（h 模式不会出现；v 模式 100% 横向即如此）。 */
    const shiftPath = !!(sc && sc.xr <= 2 && sc.yr <= 2);
    const base = t0 || [0, 0];
    const expAxis = (d, room, pos, baseV) => {
      if (shiftPath) return softPan(baseV + d, lim) - baseV;
      if (room > 2) return pos - Math.max(0, Math.min(room, pos - d));
      return 0;
    };
    const expDx = +(sc ? expAxis(dx, sc.xr, sc.xs, base[0]) : dx).toFixed(1);
    const expDy = +(sc ? expAxis(dy, sc.yr, sc.ys, base[1]) : dy).toFixed(1);
    const rawFollow = (dl === null) ? false : (Math.abs(dl - dx) <= DRAG_TOL && Math.abs(dt - dy) <= DRAG_TOL);
    const follow = (dl === null) ? false : (Math.abs(dl - expDx) <= DRAG_TOL && Math.abs(dt - expDy) <= DRAG_TOL);
    const t1 = await evaluate(TF_NUM);
    const tdx = (t0 && t1) ? +(t1[0] - t0[0]).toFixed(1) : null;
    const tdy = (t0 && t1) ? +(t1[1] - t0[1]).toFixed(1) : null;
    const turned = !!(st0 && st1 && st0.idx !== st1.idx);
    const row = { label, zoom: e.zoom, vis: e.vis, want: [dx, dy], got: [dl, dt], follow, rawFollow,
                  expect: [expDx, expDy], softLimit: lim, shiftPath,
                  sc: sc ? { xr: sc.xr, yr: sc.yr, xs: sc.xs, ys: sc.ys, cmode: sc.cmode, sel: sc.sel } : null,
                  base,
                  tf0: t0, tf1: t1, tfDelta: [tdx, tdy], idx0: st0 && st0.idx, idx1: st1 && st1.idx, turned,
                  room: e.room, scroll: e.scroll, tf: String(e.tf).slice(0, 30) };
    rec.drags.push(row);
    if (dl === null) rec.blind++;
    if (!follow && rawFollow) rec.saturated = (rec.saturated || 0) + 1;
    log('    ' + label.padEnd(18) + 'drag(' + dx + ',' + dy + ') 图上=' + JSON.stringify([dl, dt]) +
      ' 预期=' + JSON.stringify([expDx, expDy]) + (follow ? '  跟手✓' : '  ✗') +
      (follow && !rawFollow ? '（软限位饱和）' : '') + '  room=' + e.room +
      '  base=' + JSON.stringify(t0) + '→' + JSON.stringify(t1) +
      (turned ? '  ★翻页了 ' + (st0 && st0.idx) + '→' + (st1 && st1.idx) : ''));
    return row;
  };

  /* 用**产品自己的复位路径**把累积位移归零：h 模式点右侧热区翻一页 ⇒ goToIndex()
     ⇒ clearPanShift()。为什么必须复位：位移是累积保留的（第 9 轮），连拖几次后
     baseX 就越过软限位，量出来的「跟手」会被 softPan() 削掉 —— 复位后从 base=0 起量，
     日志里就是干净的「鼠标走多少图走多少」，也顺带验证了「换页复位」这条产品行为。 */
  const resetPan = async (label, rec) => {
    const st0 = await evaluate(`window.__Q.state()`);
    let st1 = st0;
    for (let k = 0; k < 3 && st1.idx === st0.idx; k++) {
      const x = 1150, y = 450 + k * 150;
      await mouse.move(x, y); await mouse.down(x, y); await sleep(60); await mouse.up(x, y);
      await sleep(700);
      st1 = await evaluate(`window.__Q.state()`);
    }
    const t = await evaluate(TF_NUM);
    const clean = !!(t && Math.abs(t[0]) <= 8 && Math.abs(t[1]) <= 8);
    if (rec) { rec.resets = rec.resets || []; rec.resets.push({ label, from: st0.idx, to: st1.idx, tf: t, clean }); }
    log('    ' + ('⟲复位/' + label).padEnd(18) + '页 ' + st0.idx + '→' + st1.idx + ' 位移=' + JSON.stringify(t) + (clean ? ' ✓归零' : ' ✗未归零'));
    return { from: st0.idx, to: st1.idx, tf: t, clean };
  };

  const SHAPES = QS
    ? [{ key: 'portrait', w: 1000, h: 1400, bands: 2 }]
    : [{ key: 'portrait', w: 1000, h: 1400, bands: 2 },
       { key: 'landscape', w: 1600, h: 900, bands: 2 },
       { key: 'multiband', w: 1200, h: 1200, bands: 4 },
       { key: 'tiny', w: 420, h: 300, bands: 2 }];
  if (REAL) {
    R.cases['real-jm1474911'] = { shape: 'real' };
    const rec = { open: await open('h'), zoomSteps: [], drags: [], maxDrift: 0, maxDriftAt: null, blind: 0, nonCanvas: 0 };
    log('  ── real jmcomic/1474911 / h  ' + JSON.stringify(rec.open));
    if (rec.open && rec.open.canvas) {
      for (let z = 120; z <= 300; z += 20) await zoomStep('[data-rd-zoomin]', 'h-in', rec);
      for (let z = 300; z > 50; z -= 20) await zoomStep('[data-rd-zoomout]', 'h-out', rec);
      await drag(rec, 120, 80, 'h-50', 0, 0);
      await click('[data-rd-zoomval]'); await sleep(300);
      await drag(rec, 130, 95, 'h-100', 0, 0);
      await drag(rec, -170, -130, 'h-100b', 0, 0);
      await click('[data-rd-zoomin]'); await click('[data-rd-zoomin]'); await sleep(450);
      await drag(rec, 150, 105, 'h-200', 0, 0);
    }
    R.cases['real-jm1474911'].h = rec;
  } else {
    for (const sh of SHAPES) {
      R.cases[sh.key] = { shape: sh.w + 'x' + sh.h + ' bands=' + sh.bands };
      await makeChapter(sh.w, sh.h, sh.bands);
      const dirs = QS ? ['h'] : (sh.key === 'portrait' ? ['h', 'v'] : ['h']);
      for (const dir of dirs) {
        const rec = { open: await open(dir), zoomSteps: [], drags: [], maxDrift: 0, maxDriftAt: null, blind: 0, nonCanvas: 0 };
        log('  ── ' + sh.key + ' ' + sh.w + 'x' + sh.h + ' bands=' + sh.bands + ' / ' + dir + '  ' + JSON.stringify(rec.open));
        if (!rec.open || !rec.open.canvas) { log('    ✗ 这一档没有生成 canvas（paintScramble 没跑起来），本档作废'); }
        /* ① 上升梯 100 → 300，逐档量漂移 */
        for (let z = 120; z <= 300; z += 20) await zoomStep('[data-rd-zoomin]', dir + '-in', rec);
        rec.topRoom = await evaluate(`(function(){ var pg=window.__Q.pg(); return pg?(pg.scrollWidth-pg.clientWidth)+'x'+(pg.scrollHeight-pg.clientHeight):null; })()`);
        /* ② 下降梯 300 → 50（跨 100% 门槛最容易出事） */
        for (let z = 300; z > 50; z -= 20) await zoomStep('[data-rd-zoomout]', dir + '-out', rec);
        rec.bottomRoom = await evaluate(`(function(){ var pg=window.__Q.pg(); return pg?(pg.scrollWidth-pg.clientWidth)+'x'+(pg.scrollHeight-pg.clientHeight):null; })()`);
        /* ③ 拖拽：50% / 100%（正是用户说拖不动的那两档） */
        await drag(rec, 120, 80, dir + '-50', 0, 0);
        await click('[data-rd-zoomval]'); await sleep(300);
        await drag(rec, 130, 95, dir + '-100', 0, 0);
        await drag(rec, -170, -130, dir + '-100b', 0, 0);
        /* ④ 先拖再缩放：锚点仍应钉在视口正中 */
        await evaluate(`(function(){ window.__Q.pin(); return 1; })()`);
        await click('[data-rd-zoomin]'); await click('[data-rd-zoomin]');
        await sleep(420);
        const adz = await evaluate(`window.__Q.drift()`);
        rec.dragThenZoom = { zoom: adz.zoom, vis: adz.vis, drift: adz.d };
        if (adz.d > rec.maxDrift) { rec.maxDrift = adz.d; rec.maxDriftAt = dir + '-dragThenZoom@' + adz.zoom; }
        log('    ' + (dir + '-dragThenZoom').padEnd(12) + String(adz.zoom).padStart(5) + '  漂移=' + adz.d + 'px');
        /* ⑤ 200% / ⑥ 300% */
        await drag(rec, 150, 105, dir + '-200', 0, 0);
        for (let k = 0; k < 4; k++) await click('[data-rd-zoomin]');
        await sleep(500);
        await drag(rec, 200, 140, dir + '-300', 0, 0);
        /* ⑦ 图外空白处按下也要能拖（先翻页复位 ⇒ 从 base=0 量，才算真「跟手」） */
        await click('[data-rd-zoomval]'); await sleep(300);
        await resetPan(dir + '-offimg', rec);
        await drag(rec, 90, 70, dir + '-100-offimg', -520, -350);
        /* ⑧ 翻页前拖一下（同样先复位）+ 翻页后缩放 */
        if (dir === 'h') {
          await click('[data-rd-zoomval]'); await sleep(250);
          await resetPan(dir + '-p1', rec);
          await drag(rec, 140, 100, dir + '-p1-drag', 0, 0);
          await mouse.move(1150, 450); await mouse.down(1150, 450); await sleep(60); await mouse.up(1150, 450);
          await sleep(700);
          const st2 = await evaluate(`window.__Q.state()`);
          await evaluate(`(function(){ window.__Q.pin(); return 1; })()`);
          await click('[data-rd-zoomin]'); await click('[data-rd-zoomin]');
          await sleep(450);
          const a2 = await evaluate(`window.__Q.drift()`);
          rec.pageTurn = { state: st2, zoom: a2.zoom, drift: a2.d };
          if (a2.d > rec.maxDrift) { rec.maxDrift = a2.d; rec.maxDriftAt = dir + '-page2zoom@' + a2.zoom; }
          log('    ' + (dir + '-page2zoom').padEnd(12) + String(a2.zoom).padStart(5) + '  漂移=' + a2.d + 'px  页=' + JSON.stringify(st2));
        }
        R.cases[sh.key][dir] = rec;
      }
    }
  }

  await evaluate(`(function(){ try{ window.HS.reader.close(); }catch(e){} return 1; })()`);

  /* ---------------- 汇总 ---------------- */
  const driftRows = [], dragRows = [];
  let casesWithCanvas = 0, casesTotal = 0, nonCanvasSteps = 0;
  Object.keys(R.cases).forEach(k => ['h', 'v'].forEach(d => {
    const c = R.cases[k][d]; if (!c) return;
    casesTotal++;
    if (c.open && c.open.canvas) casesWithCanvas++;
    nonCanvasSteps += (c.nonCanvas || 0);
    (c.zoomSteps || []).forEach(z => driftRows.push({ shape: k, dir: d, step: z.label, zoom: z.zoom, vis: z.vis, drift: z.drift }));
    (c.drags || []).forEach(g => dragRows.push({ shape: k, dir: d, step: g.label, zoom: g.zoom, vis: g.vis, want: g.want, got: g.got, expect: g.expect, follow: g.follow, rawFollow: g.rawFollow }));
  }));
  const worst = driftRows.slice().sort((a, b) => b.drift - a.drift)[0] || null;
  /* 用户报的两条都发生在**左右翻页（h）**模式 ⇒ PASS 判 h；v（纵向连续）单列信息，不混进判据：
     v 的纵向漂移是预存在问题（zoomAnchorResidual 里 `if(!isH()) return`，纵向只靠 scrollTop 补偿，
     章节顶部 scrollTop 已被夹在 0 ⇒ 缩小页面时最多漂几十 px），第 11 轮探针只判横向所以没抓到。 */
  const hDrift = driftRows.filter(r => r.dir === 'h');
  const worstH = hDrift.slice().sort((a, b) => b.drift - a.drift)[0] || null;
  const worstV = driftRows.filter(r => r.dir === 'v').sort((a, b) => b.drift - a.drift)[0] || null;
  const notFollow = dragRows.filter(r => !r.follow);
  const notFollowH = notFollow.filter(r => r.dir === 'h');
  const saturated = dragRows.filter(r => r.follow && !r.rawFollow);
  R.summary = {
    模式: R.mode,
    用例数: casesTotal, 有canvas的用例数: casesWithCanvas, 量到的非canvas步数: nonCanvasSteps,
    漂移测量点数: driftRows.length,
    最大漂移px: worst ? worst.drift : null, 最大漂移出处: worst,
    拖拽场景数: dragRows.length, 不跟手数: notFollow.length, 不跟手清单: notFollow,
    软限位饱和修正数: saturated.length,
    h模式: { 最大漂移px: worstH ? worstH.drift : null, 出处: worstH, 不跟手数: notFollowH.length, 不跟手清单: notFollowH },
    v模式信息: { 最大漂移px: worstV ? worstV.drift : null, 出处: worstV,
      说明: '纵向连续模式：拖动语义=滚动该轴（到顶/到边即不动，属设计）；在章节顶部把页面缩小(100%→50%)时负向滚动被 scrollTop=0 夹住，纵向最多漂 ~99px（预存在，第 11 轮只判横向未覆盖）' },
    每用例最大漂移: Object.keys(R.cases).reduce((o, k) => {
      ['h', 'v'].forEach(d => { const c = R.cases[k][d]; if (c) o[k + '/' + d] = { max: c.maxDrift, at: c.maxDriftAt, canvas: !!(c.open && c.open.canvas) }; });
      return o;
    }, {}),
    判据: { 漂移: '<' + DRIFT_MAX + 'px', 跟手: '|图上位移-预期位移|<=' + DRAG_TOL + 'px（预期=软限位/滚动夹取之后）' },
    PASS: !!(worstH && worstH.drift < DRIFT_MAX && notFollowH.length === 0 && casesWithCanvas === casesTotal && casesTotal > 0)
  };
  log('\n=== 汇总 ===');
  log('模式=' + R.mode + '  用例=' + casesTotal + '（有 canvas 的 ' + casesWithCanvas + '）');
  log('漂移：' + driftRows.length + ' 个测量点，最大 ' + (worst ? worst.drift + 'px @ ' + worst.shape + '/' + worst.dir + '/' + worst.step + '@' + worst.zoom : 'n/a'));
  log('  h（用户场景）：最大 ' + (worstH ? worstH.drift + 'px @ ' + worstH.shape + '/' + worstH.step + '@' + worstH.zoom : 'n/a') + '  不跟手 ' + notFollowH.length);
  log('  v（纵向连续，信息）：最大 ' + (worstV ? worstV.drift + 'px @ ' + worstV.shape + '/' + worstV.step + '@' + worstV.zoom : 'n/a'));
  log('拖拽：' + dragRows.length + ' 个场景，不跟手 ' + notFollow.length + '（软限位/滚动夹取修正 ' + saturated.length + '）');
  if (notFollow.length) log('  不跟手清单：' + JSON.stringify(notFollow.slice(0, 12)));
  log('PASS(h 模式判据)=' + R.summary.PASS);
  /* 顺手把完整报告落盘（避免靠管道抓 stdout，管道在沙箱下会被拒） */
  try { require('fs').writeFileSync('tools/_jmcanvas-report.json', JSON.stringify(R, null, 1)); } catch (e) {}
  return R;
};
