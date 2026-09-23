'use strict';
/* 阅读器「任意大小」收敛矩阵（第 11 轮）：
   用户要求的两条——
     ① 左右翻页(h)模式下**图片任意大小**都要能按住鼠标拖动；
     ② 左右翻页(h)模式下**放大/缩小（任意倍率）图片位置都不应该改变**。
   已有 tools/reader-cover-steps.js 只覆盖 3 种形状 × 4 个倍率（120/140/100/80）。
   本脚本把「任意」这件事真的铺开：
     · 形状 5 种：竖图 / 横图 / 方图 / 超宽图 / **比视口还小的图**；
     · 倍率 14 档：50,60,…,300（ZOOM_MIN..ZOOM_MAX，步长 ZOOM_STEP=0.2），**每一档都量漂移**；
     · 拖拽 5 个场景：100% / 50% / 200% / 300% / 图外空白处按下；
     · 交叉场景：**先拖再缩放**、**先翻页再缩放**。
   判据：漂移 < 4px（肉眼不可见量级）；拖拽「跟手」= 图上位移与鼠标位移之差 ≤ 8px。
   用法：
     node tools/live-probe.js --url=http://127.0.0.1:8788/ --steps=tools/reader-anysize-steps.js --w=1280 --h=900 --wait=1500
   （Chrome 在 workspace-write 沙箱下会自毁，需要不受限模式。） */
module.exports = async function main(ctx) {
  const { evaluate, mouse, sleep, log } = ctx;
  const R = { at: new Date().toISOString(), viewport: '1280x900', cases: {} };
  const DRIFT_MAX = 4;      /* 漂移判据 */
  const DRAG_TOL = 8;       /* 跟手判据 */

  await evaluate(`(function(){
    try{ HS.settings.adultOk = true; if(HS.store&&HS.store.save) HS.store.save(HS.settings); }catch(e){}
    var g=document.getElementById('gate'); if(g) g.hidden=true;
    var nb=document.getElementById('net-banner'); if(nb) nb.hidden=true;
    return 1; })()`);

  /* 页面内工具：与 reader-cover-steps.js 同一套口径
     （给「视口正中那个物理点」打 pin，缩放后量它跑到哪；
       拖拽判据是同一张图 rect 的位移） */
  await evaluate(`(function(){
    var Q = window.__Q = {};
    Q.pg = function(){ return document.querySelector('.hs-rd-pg.is-cur'); };
    Q.img = function(pg){ pg = pg||Q.pg(); return pg && (pg.querySelector('.hs-rd-img img')||pg.querySelector('img')); };
    Q.box = function(el){ if(!el) return null; var r=el.getBoundingClientRect();
      return {l:+r.left.toFixed(1),t:+r.top.toFixed(1),w:+r.width.toFixed(1),h:+r.height.toFixed(1),
              cx:+(r.left+r.width/2).toFixed(1),cy:+(r.top+r.height/2).toFixed(1)}; };
    Q.pic = function(im){
      if(!im) return null; var r=im.getBoundingClientRect(), nw=im.naturalWidth, nh=im.naturalHeight;
      if(!nw||!nh) return {l:r.left,t:r.top,w:r.width,h:r.height};
      var s=Math.min(r.width/nw,r.height/nh), w=nw*s, h=nh*s;
      return {l:r.left+(r.width-w)/2, t:r.top+(r.height-h)/2, w:w, h:h};
    };
    Q.rootBox = function(){ var r=document.querySelector('.hs-rd').getBoundingClientRect(); return {w:r.width,h:r.height}; };
    Q.pin = function(){
      var im=Q.img(); if(!im) return null; var p=Q.pic(im), rb=Q.rootBox();
      var cx=rb.w/2, cy=rb.h/2;
      window.__P = {fx:(cx-p.l)/p.w, fy:(cy-p.t)/p.h, cx:cx, cy:cy};
      return {fx:+window.__P.fx.toFixed(4), fy:+window.__P.fy.toFixed(4),
              pic:{l:+p.l.toFixed(1),t:+p.t.toFixed(1),w:+p.w.toFixed(1),h:+p.h.toFixed(1)}};
    };
    Q.drift = function(){
      var im=Q.img(); if(!im) return null; var p=Q.pic(im), P=window.__P;
      if(!P||!p) return null;
      var tx=p.l+P.fx*p.w, ty=p.t+P.fy*p.h;
      var pg=Q.pg();
      return { d:+Math.hypot(tx-P.cx,ty-P.cy).toFixed(2), dx:+(tx-P.cx).toFixed(2), dy:+(ty-P.cy).toFixed(2),
        zoom:(document.querySelector('[data-rd-zoomval]')||{}).textContent,
        room: pg ? ((pg.scrollWidth-pg.clientWidth)+'x'+(pg.scrollHeight-pg.clientHeight)) : null,
        scroll: pg ? (pg.scrollLeft+'/'+pg.scrollTop) : null,
        tf: im.style.transform||'none',
        pic:{l:+p.l.toFixed(1),t:+p.t.toFixed(1),w:+p.w.toFixed(1),h:+p.h.toFixed(1)} };
    };
    Q.state = function(){ return {zoom:(document.querySelector('[data-rd-zoomval]')||{}).textContent,
      dir:(document.querySelector('.hs-rd')||{getAttribute:function(){return null;}}).getAttribute('data-dir'),
      idx:(document.querySelector('.hs-rd-pg.is-cur')?[].indexOf.call(document.querySelectorAll('.hs-rd-pg'),document.querySelector('.hs-rd-pg.is-cur')):-1),
      n:document.querySelectorAll('.hs-rd-pg').length}; };
    return 'ok'; })()`);

  /* 造一个用 data: SVG 当页面的假章节（不打真网络，形状可控） */
  const makeChapter = (w, h) => evaluate(`(function(){
    function page(i){
      var w=${w}, h=${h};
      var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'">'+
        '<rect width="'+w+'" height="'+h+'" fill="#fff"/>'+
        '<line x1="'+(w/2)+'" y1="0" x2="'+(w/2)+'" y2="'+h+'" stroke="#e11" stroke-width="4"/>'+
        '<line x1="0" y1="'+(h/2)+'" x2="'+w+'" y2="'+(h/2)+'" stroke="#e11" stroke-width="4"/>'+
        '<text x="20" y="70" font-size="60" fill="#111" font-family="monospace">P'+(i+1)+'</text></svg>';
      return {url:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg), w:w, h:h};
    }
    var pages=[]; for(var i=0;i<5;i++) pages.push(page(i));
    var of=window.fetch;
    window.fetch=function(u,o){
      if(String(u).indexOf('/api/reader')>=0){
        return Promise.resolve(new Response(JSON.stringify({ok:true,title:'ANYSIZE',chapters:[{id:'c1',name:'d'}],pages:pages}),
          {status:200,headers:{'Content-Type':'application/json'}}));
      }
      return of.apply(this,arguments);
    };
    return {pages:pages.length,w:${w},h:${h}}; })()`);

  const open = async (dir) => {
    await evaluate(`(function(){ try{ window.HS.reader.close(); }catch(e){} return 1; })()`);
    await sleep(250);
    await evaluate(`(function(){ window.HS.settings.readerDir='${dir}'; return 1; })()`);
    await evaluate(`(function(){ window.__O=null;
      window.HS.reader.open({source:'jmcomic',id:'anysize-${dir}-'+Date.now(),title:'ANYSIZE'})
        .then(function(){window.__O='ok';},function(e){window.__O='err:'+e;});
      return 1; })()`);
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const st = await evaluate(`(function(){ var p=document.querySelectorAll('.hs-rd-pg');
        var im=document.querySelector('.hs-rd-pg.is-cur .hs-rd-img img')||document.querySelector('.hs-rd-pg .hs-rd-img img');
        return {n:p.length, ok:!!(im&&im.complete&&im.naturalWidth)}; })()`);
      if (st.ok && st.n >= 2) break;
    }
    await sleep(500);
    return evaluate(`(function(){ var im=window.__Q.img(); return im?{nat:im.naturalWidth+'x'+im.naturalHeight}:null; })()`);
  };

  const click = async (sel) => { await evaluate(`(function(){ var b=document.querySelector('${sel}'); if(!b||b.disabled) return 0; b.click(); return 1; })()`); };

  /* 一次缩放 + 漂移测量 */
  const zoomStep = async (sel, label, rec) => {
    await evaluate(`(function(){ window.__Q.pin(); return 1; })()`);
    await click(sel);
    await sleep(420);
    const a = await evaluate(`window.__Q.drift()`);
    const row = { label, zoom: a.zoom, drift: a.d, dx: a.dx, dy: a.dy, room: a.room, tf: String(a.tf).slice(0, 30) };
    rec.zoomSteps.push(row);
    if (a.d > rec.maxDrift) { rec.maxDrift = a.d; rec.maxDriftAt = label + '@' + a.zoom; }
    log('    ' + label.padEnd(10) + String(a.zoom).padStart(5) + '  漂移=' + String(a.d).padStart(7) + 'px  room=' + a.room);
    return row;
  };

  /* 一次拖拽：真鼠标 down→4 段 move→up，判据 = 图上 rect 位移 */
  const drag = async (rec, dx, dy, label, cx, cy) => {
    cx = cx || 0; cy = cy || 0;
    const b = await evaluate(`window.__Q.drift()`);
    const px = Math.round(640 + cx), py = Math.round(450 + cy);
    await mouse.move(px, py);
    await mouse.down(px, py);
    await sleep(70);
    for (let k = 1; k <= 4; k++) { await mouse.move(px + dx * k / 4, py + dy * k / 4, { buttons: 1 }); await sleep(45); }
    await mouse.up(px + dx, py + dy);
    await sleep(300);
    const e = await evaluate(`window.__Q.drift()`);
    const dl = (e && b) ? +(e.pic.l - b.pic.l).toFixed(1) : null;
    const dt = (e && b) ? +(e.pic.t - b.pic.t).toFixed(1) : null;
    const follow = (dl === null) ? false : (Math.abs(dl - dx) <= DRAG_TOL && Math.abs(dt - dy) <= DRAG_TOL);
    const row = { label, zoom: e.zoom, want: [dx, dy], got: [dl, dt], follow, room: e.room, scroll: e.scroll, tf: String(e.tf).slice(0, 30) };
    rec.drags.push(row);
    if (dl === null || dl === 0 && dt === 0) rec.blind++;
    log('    ' + label.padEnd(16) + 'drag(' + dx + ',' + dy + ') 图上=' + JSON.stringify([dl, dt]) +
      (follow ? '  跟手✓' : '  ✗') + '  room=' + e.room + '  tf=' + row.tf);
    return row;
  };

  const SHAPES = [
    { key: 'portrait', w: 1000, h: 1400 },
    { key: 'landscape', w: 1600, h: 900 },
    { key: 'square', w: 1200, h: 1200 },
    { key: 'ultrawide', w: 2400, h: 700 },
    { key: 'tiny', w: 420, h: 300 }
  ];

  for (const sh of SHAPES) {
    R.cases[sh.key] = { shape: sh.w + 'x' + sh.h };
    await makeChapter(sh.w, sh.h);
    for (const dir of ['h', 'v']) {
      const rec = { open: await open(dir), zoomSteps: [], drags: [], maxDrift: 0, maxDriftAt: null, blind: 0 };
      log('  ── ' + sh.key + ' ' + sh.w + 'x' + sh.h + ' / ' + dir + '  ' + JSON.stringify(rec.open));
      /* ① 上升梯：100 → 300，逐档量漂移 */
      for (let z = 120; z <= 300; z += 20) await zoomStep('[data-rd-zoomin]', dir + '-in', rec);
      rec.topRoom = await evaluate(`(function(){ var pg=window.__Q.pg(); return pg?(pg.scrollWidth-pg.clientWidth)+'x'+(pg.scrollHeight-pg.clientHeight):null; })()`);
      /* ② 下降梯：300 → 50，逐档量漂移（跨 100% 门槛是最容易出事的一步） */
      for (let z = 300; z > 50; z -= 20) await zoomStep('[data-rd-zoomout]', dir + '-out', rec);
      rec.bottomRoom = await evaluate(`(function(){ var pg=window.__Q.pg(); return pg?(pg.scrollWidth-pg.clientWidth)+'x'+(pg.scrollHeight-pg.clientHeight):null; })()`);
      rec.at50 = await evaluate(`window.__Q.drift()`);
      /* ③ 拖拽：50% / 100% / 200% / 300% */
      await drag(rec, 120, 80, dir + '-50', 0, 0);
      await click('[data-rd-zoomval]');                       /* 回 100% */
      await sleep(300);
      await drag(rec, 130, 95, dir + '-100', 0, 0);
      await drag(rec, -170, -130, dir + '-100b', 0, 0);
      /* ④ 先拖再缩放：拖完之后缩放，锚点仍应钉在视口正中 */
      await evaluate(`(function(){ window.__Q.pin(); return 1; })()`);
      await click('[data-rd-zoomin]');
      await click('[data-rd-zoomin]');
      await sleep(420);
      const afterDragZoom = await evaluate(`window.__Q.drift()`);
      rec.dragThenZoom = { zoom: afterDragZoom.zoom, drift: afterDragZoom.d };
      if (afterDragZoom.d > rec.maxDrift) { rec.maxDrift = afterDragZoom.d; rec.maxDriftAt = dir + '-dragThenZoom@' + afterDragZoom.zoom; }
      log('    ' + (dir + '-dragThenZoom').padEnd(10) + String(afterDragZoom.zoom).padStart(5) + '  漂移=' + afterDragZoom.d + 'px');
      /* ⑤ 200%（此时已有拖动位移，正好检验放大态拖拽仍走滚动档） */
      await drag(rec, 150, 105, dir + '-200', 0, 0);
      /* ⑥ 拖到 300% */
      await click('[data-rd-zoomin]');
      await click('[data-rd-zoomin]');
      await click('[data-rd-zoomin]');
      await click('[data-rd-zoomin]');
      await sleep(500);
      await drag(rec, 200, 140, dir + '-300', 0, 0);
      /* ⑦ 图外空白处按下也要能拖（小图 / 缩到 50% 时图外大片是空的） */
      await click('[data-rd-zoomval]');
      await sleep(300);
      await drag(rec, 90, 70, dir + '-100-offimg', -520, -350);
      /* ⑧ 翻页后缩放：换页必须清掉上一页的位移，否则下一页缩放会跳 */
      if (dir === 'h') {
        await click('[data-rd-zoomval]');
        await sleep(250);
        await drag(rec, 140, 100, dir + '-p1-drag', 0, 0);
        await evaluate(`(function(){ var el=document.querySelector('.hs-rd-hot-r'); return 1; })()`);
        await mouse.move(1150, 450); await mouse.down(1150, 450); await sleep(60); await mouse.up(1150, 450);
        await sleep(700);
        const st2 = await evaluate(`window.__Q.state()`);
        await evaluate(`(function(){ window.__Q.pin(); return 1; })()`);
        await click('[data-rd-zoomin]');
        await click('[data-rd-zoomin]');
        await sleep(450);
        const a2 = await evaluate(`window.__Q.drift()`);
        rec.pageTurn = { state: st2, zoom: a2.zoom, drift: a2.d };
        if (a2.d > rec.maxDrift) { rec.maxDrift = a2.d; rec.maxDriftAt = dir + '-page2zoom@' + a2.zoom; }
        log('    ' + (dir + '-page2zoom').padEnd(10) + String(a2.zoom).padStart(5) + '  漂移=' + a2.d + 'px  页=' + JSON.stringify(st2));
      }
      R.cases[sh.key][dir] = rec;
    }
  }

  await evaluate(`(function(){ try{ window.HS.reader.close(); }catch(e){} return 1; })()`);

  /* ---------------- 汇总 ---------------- */
  const driftRows = [], dragRows = [];
  Object.keys(R.cases).forEach(k => ['h', 'v'].forEach(d => {
    const c = R.cases[k][d]; if (!c) return;
    (c.zoomSteps || []).forEach(z => driftRows.push({ shape: k, dir: d, step: z.label, zoom: z.zoom, drift: z.drift }));
    (c.drags || []).forEach(g => dragRows.push({ shape: k, dir: d, step: g.label, zoom: g.zoom, want: g.want, got: g.got, follow: g.follow }));
  }));
  const worst = driftRows.slice().sort((a, b) => b.drift - a.drift)[0] || null;
  const worstH = driftRows.filter(r => r.dir === 'h').sort((a, b) => b.drift - a.drift)[0] || null;
  const notFollow = dragRows.filter(r => !r.follow);
  const notFollowH = notFollow.filter(r => r.dir === 'h');
  R.summary = {
    漂移测量点数: driftRows.length,
    最大漂移px: worst ? worst.drift : null, 最大漂移出处: worst,
    横向最大漂移px: worstH ? worstH.drift : null, 横向最大漂移出处: worstH,
    拖拽场景数: dragRows.length, 不跟手数: notFollow.length, 横向不跟手数: notFollowH.length,
    不跟手清单: notFollow, 每组合最大漂移: Object.keys(R.cases).reduce((o, k) => {
      o[k] = { h: R.cases[k].h && R.cases[k].h.maxDrift, v: R.cases[k].v && R.cases[k].v.maxDrift,
               hAt: R.cases[k].h && R.cases[k].h.maxDriftAt, vAt: R.cases[k].v && R.cases[k].v.maxDriftAt };
      return o;
    }, {}),
    判据: { 漂移: '<' + DRIFT_MAX + 'px', 跟手: '|图上位移-鼠标位移|<=' + DRAG_TOL + 'px' },
    PASS: !!(worstH && worstH.drift < DRIFT_MAX && notFollowH.length === 0)
  };
  log('\n=== 汇总 ===');
  log('漂移：全 ' + driftRows.length + ' 个测量点，最大 ' + (worst ? worst.drift + 'px @ ' + worst.shape + '/' + worst.dir + '/' + worst.step + '@' + worst.zoom : 'n/a') +
    '；横向最大 ' + (worstH ? worstH.drift + 'px @ ' + worstH.shape + '/' + worstH.step + '@' + worstH.zoom : 'n/a'));
  log('拖拽：' + dragRows.length + ' 个场景，不跟手 ' + notFollow.length + '（横向 ' + notFollowH.length + '）');
  if (notFollow.length) log('  不跟手清单：' + JSON.stringify(notFollow.slice(0, 12)));
  log('PASS=' + R.summary.PASS);
  return R;
};
