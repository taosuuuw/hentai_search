'use strict';
/* 阅读器「左右翻页(h)」专项取证（第 11 轮·第二发）
   上一发 tools/reader-anysize-steps.js 的矩阵在 h 模式给出：
     portrait  max 152.61px @ h-dragThenZoom@140%
     square    max 147.00px @ h-dragThenZoom@140%
     ultrawide max  94.70px @ h-dragThenZoom@140%
     landscape max   0.64px / tiny max 0.80px  ← 同样流程却是干净的
   三个形状坏、两个好 ⇒ 必须先排除「测量假象」，再定位机制。本脚本把 h 模式
   拆成 5 个互相独立的场景，每个场景都**单击 + 等 600ms**（上一发是两次
   click 同一 tick，可能自己制造问题），并同时记录：
     drift     视口正中那个物理点在缩放前后的位移（需求 2 的判据）
     tf        <img> 的行内 transform（能看出拖拽位移有没有被清掉）
     room/scroll  页盒 .hs-rd-pg 的滚动余量与当前位置
   场景：
     A 纯缩放梯（无拖拽）120→300 再 300→50，逐档
     B 跨 100% 门槛单步（120/100/80/60）
     C 先拖再缩放（需求 2 与需求 1 的交叉点）
     D 放大到 300% 后拖拽跟手
     E 双连击（同一 tick 两次 zoom，上一发的做法）—— 用来判「假象 vs 真 bug」
   用法：
     node tools/live-probe.js --url=http://127.0.0.1:8788/ --steps=tools/reader-h-forensic-steps.js --w=1280 --h=900 --wait=1500
   建议把 stdout 重定向到文件，脚本结论形如 收尾一行 JSON。 */
module.exports = async function main(ctx) {
  const { evaluate, mouse, sleep, log } = ctx;
  const R = { at: new Date().toISOString(), viewport: '1280x900', shapes: {} };
  const DRIFT_MAX = 4, DRAG_TOL = 8;

  await evaluate(`(function(){
    try{ HS.settings.adultOk = true; }catch(e){}
    var g=document.getElementById('gate'); if(g) g.hidden=true;
    var nb=document.getElementById('net-banner'); if(nb) nb.hidden=true;
    return 1; })()`);

  await evaluate(`(function(){
    var Q = window.__Q = {};
    Q.pg = function(){ return document.querySelector('.hs-rd-pg.is-cur'); };
    Q.img = function(pg){ pg = pg||Q.pg(); return pg && (pg.querySelector('.hs-rd-img img')||pg.querySelector('img')); };
    Q.pic = function(im){
      if(!im) return null; var r=im.getBoundingClientRect(), nw=im.naturalWidth, nh=im.naturalHeight;
      if(!nw||!nh) return {l:r.left,t:r.top,w:r.width,h:r.height};
      var s=Math.min(r.width/nw,r.height/nh), w=nw*s, h=nh*s;
      return {l:r.left+(r.width-w)/2, t:r.top+(r.height-h)/2, w:w, h:h};
    };
    Q.pin = function(){
      var im=Q.img(); if(!im) return null; var p=Q.pic(im);
      var cx=innerWidth/2, cy=innerHeight/2;
      window.__P = {fx:(cx-p.l)/p.w, fy:(cy-p.t)/p.h, cx:cx, cy:cy};
      return {fx:+window.__P.fx.toFixed(3), fy:+window.__P.fy.toFixed(3)};
    };
    Q.zoom = function(){ var e=document.querySelector('[data-rd-zoomval]'); return e?e.textContent.trim():null; };
    Q.tf = function(){ var im=Q.img(); return im?(im.style.transform||'none'):null; };
    Q.snap = function(tag){
      var im=Q.img(), p=Q.pic(im), pg=Q.pg(), P=window.__P;
      var o = { tag:tag, zoom:Q.zoom(), tf:Q.tf(), inView:!!im,
        pic:p?{l:+p.l.toFixed(1),t:+p.t.toFixed(1),w:+p.w.toFixed(1),h:+p.h.toFixed(1)}:null,
        room: pg?((pg.scrollWidth-pg.clientWidth)+'x'+(pg.scrollHeight-pg.clientHeight)):null,
        scroll: pg?(pg.scrollLeft+'/'+pg.scrollTop):null };
      if(P&&p){ var tx=p.l+P.fx*p.w, ty=p.t+P.fy*p.h;
        o.drift=+Math.hypot(tx-P.cx,ty-P.cy).toFixed(2);
        o.dx=+(tx-P.cx).toFixed(2); o.dy=+(ty-P.cy).toFixed(2);
        o.anchorInPic = (P.fx>=0&&P.fx<=1&&P.fy>=0&&P.fy<=1);
      }
      return o;
    };
    return 'ok'; })()`);

  const makeChapter = (w, h) => evaluate(`(function(){
    function page(i){ var w=${w}, h=${h};
      var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'">'+
        '<rect width="'+w+'" height="'+h+'" fill="#fff"/>'+
        '<rect x="0" y="0" width="'+w+'" height="'+h+'" fill="none" stroke="#06c" stroke-width="6"/>'+
        '<line x1="'+(w/2)+'" y1="0" x2="'+(w/2)+'" y2="'+h+'" stroke="#e11" stroke-width="4"/>'+
        '<line x1="0" y1="'+(h/2)+'" x2="'+w+'" y2="'+(h/2)+'" stroke="#e11" stroke-width="4"/>'+
        '<circle cx="'+(w/2)+'" cy="'+(h/2)+'" r="14" fill="#0a0"/>'+
        '<text x="20" y="70" font-size="60" fill="#111" font-family="monospace">P'+(i+1)+'</text></svg>';
      return {url:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg), w:w, h:h}; }
    var pages=[]; for(var i=0;i<5;i++) pages.push(page(i));
    var of=window.fetch;
    window.fetch=function(u,o){ if(String(u).indexOf('/api/reader')>=0){
      return Promise.resolve(new Response(JSON.stringify({ok:true,title:'FORENSIC',chapters:[{id:'c1',name:'d'}],pages:pages}),
        {status:200,headers:{'Content-Type':'application/json'}})); }
      return of.apply(this,arguments); };
    return 1; })()`);

  const open = async () => {
    await evaluate(`(function(){ try{ window.HS.reader.close(); }catch(e){} return 1; })()`);
    await sleep(250);
    await evaluate(`(function(){ window.HS.settings.readerDir='h'; return 1; })()`);
    await evaluate(`(function(){ window.HS.reader.open({source:'jmcomic',id:'forensic-'+Date.now(),title:'FORENSIC'})
      .then(function(){window.__O='ok';},function(e){window.__O='err:'+e;}); return 1; })()`);
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const st = await evaluate(`(function(){ var p=document.querySelectorAll('.hs-rd-pg');
        var im=document.querySelector('.hs-rd-pg.is-cur .hs-rd-img img');
        return {n:p.length, ok:!!(im&&im.complete&&im.naturalWidth)}; })()`);
      if (st.ok && st.n >= 2) break;
    }
    await sleep(500);
    return evaluate(`(function(){ var d=document.querySelector('.hs-rd'); var im=window.__Q.img();
      return {dir:d?d.getAttribute('data-dir'):null, nat:im?im.naturalWidth+'x'+im.naturalHeight:null,
              zoom:window.__Q.zoom()}; })()`);
  };
  const click = async s => evaluate(`(function(){ var b=document.querySelector('${s}'); if(!b||b.disabled) return 0; b.click(); return 1; })()`);

  /* 量一档：pin →（一次或多次）点击 → 等 → 出快照 */
  const step = async (rec, kind, sel, tag, opts) => {
    opts = opts || {};
    await evaluate(`(function(){ window.__Q.pin(); return 1; })()`);
    const before = await evaluate(`window.__Q.snap('before')`);
    const n = opts.times || 1;
    for (let i = 0; i < n; i++) { await click(sel); if (opts.gap) await sleep(opts.gap); }
    await sleep(opts.wait || 600);
    const after = await evaluate(`window.__Q.snap('${tag}')`);
    const row = { kind, tag, zoom: after.zoom, drift: after.drift, dx: after.dx, dy: after.dy,
      roomBefore: before.room, roomAfter: after.room, scrollBefore: before.scroll, scrollAfter: after.scroll,
      tfBefore: before.tf, tfAfter: after.tf, anchorInPic: after.anchorInPic };
    rec.push(row);
    log('    ' + (kind + '/' + tag).padEnd(22) + String(after.zoom).padStart(5) +
      '  drift=' + String(after.drift).padStart(8) + 'px  (dx=' + row.dx + ',dy=' + row.dy + ')' +
      '  room=' + before.room + '→' + after.room + '  tf=' + String(before.tf).slice(0, 22) + '→' + String(after.tf).slice(0, 22));
    return row;
  };

  const drag = async (dx, dy, cx, cy) => {
    cx = cx || 0; cy = cy || 0;
    const before = await evaluate(`window.__Q.snap('pre-drag')`);
    const px = Math.round(640 + cx), py = Math.round(450 + cy);
    await mouse.move(px, py); await mouse.down(px, py); await sleep(70);
    for (let k = 1; k <= 4; k++) { await mouse.move(px + dx * k / 4, py + dy * k / 4, { buttons: 1 }); await sleep(45); }
    await mouse.up(px + dx, py + dy); await sleep(320);
    const after = await evaluate(`window.__Q.snap('post-drag')`);
    const got = [after.pic && before.pic ? +(after.pic.l - before.pic.l).toFixed(1) : null,
                 after.pic && before.pic ? +(after.pic.t - before.pic.t).toFixed(1) : null];
    const follow = got[0] !== null && Math.abs(got[0] - dx) <= DRAG_TOL && Math.abs(got[1] - dy) <= DRAG_TOL;
    log('    drag(' + dx + ',' + dy + ')  图上=' + JSON.stringify(got) + (follow ? ' 跟手✓' : ' ✗') +
      '  zoom=' + after.zoom + '  tf=' + String(after.tf).slice(0, 30) + '  room=' + after.room);
    return { want: [dx, dy], got, follow, zoom: after.zoom, tf: after.tf, room: after.room, scroll: after.scroll };
  };

  const SHAPES = [
    { key: 'portrait', w: 1000, h: 1400 },
    { key: 'landscape', w: 1600, h: 900 },
    { key: 'square', w: 1200, h: 1200 },
    { key: 'ultrawide', w: 2400, h: 700 },
    { key: 'tiny', w: 420, h: 300 }
  ];

  for (const sh of SHAPES) {
    await makeChapter(sh.w, sh.h);
    const S = R.shapes[sh.key] = { shape: sh.w + 'x' + sh.h, open: await open(), A: [], B: [], C: [], C2: [], D: [], E: [], drags: [] };
    log('\n══ ' + sh.key + ' ' + sh.w + 'x' + sh.h + '  ' + JSON.stringify(S.open));

    /* A 纯缩放梯：100 → 300（单步带等待），再 300 → 50 */
    log('  A 纯缩放梯（无拖拽，每档单击 600ms）');
    for (let i = 0; i < 10; i++) S.A.push(await step(S.A, 'A-in', '[data-rd-zoomin]', 'in' + (i + 1)));
    for (let i = 0; i < 12; i++) S.A.push(await step(S.A, 'A-out', '[data-rd-zoomout]', 'out' + (i + 1)));
    await click('[data-rd-zoomval]'); await sleep(400);

    /* B 跨 100% 门槛单步 */
    log('  B 跨 100% 门槛单步');
    S.B.push(await step(S.B, 'B', '[data-rd-zoomin]', '100→120'));
    S.B.push(await step(S.B, 'B', '[data-rd-zoomout]', '120→100'));
    S.B.push(await step(S.B, 'B', '[data-rd-zoomout]', '100→80'));
    S.B.push(await step(S.B, 'B', '[data-rd-zoomout]', '80→60'));
    S.B.push(await step(S.B, 'B', '[data-rd-zoomin]', '60→80'));
    S.B.push(await step(S.B, 'B', '[data-rd-zoomin]', '80→100'));
    await click('[data-rd-zoomval]'); await sleep(400);

    /* C 先拖再缩放（单击 + 等待）—— 需求 1 与 2 的交叉点 */
    log('  C 先拖再缩放');
    S.drags.push(await drag(130, 95));
    S.C.push(await step(S.C, 'C', '[data-rd-zoomin]', 'drag→120'));
    S.C.push(await step(S.C, 'C', '[data-rd-zoomin]', 'drag→140'));
    S.C.push(await step(S.C, 'C', '[data-rd-zoomin]', 'drag→160'));
    /* C2：再拖一次（此时已放大、走滚动档），然后缩回去 */
    S.drags.push(await drag(-160, -120));
    S.C2.push(await step(S.C2, 'C2', '[data-rd-zoomout]', 'drag→140'));
    S.C2.push(await step(S.C2, 'C2', '[data-rd-zoomout]', 'drag→120'));
    S.C2.push(await step(S.C2, 'C2', '[data-rd-zoomout]', 'drag→100'));
    await click('[data-rd-zoomval]'); await sleep(400);
    S.drags.push(await drag(120, 80));

    /* D 300% 拖拽跟手 */
    log('  D 放大态拖拽跟手');
    await click('[data-rd-zoomin]'); await click('[data-rd-zoomin]'); await click('[data-rd-zoomin]');
    await click('[data-rd-zoomin]'); await click('[data-rd-zoomin]'); await click('[data-rd-zoomin]');
    await click('[data-rd-zoomin]'); await click('[data-rd-zoomin]'); await click('[data-rd-zoomin]');
    await click('[data-rd-zoomin]'); await sleep(700);
    S.D.push(await drag(150, 105));
    S.D.push(await drag(-200, -150));
    S.D.push(await drag(60, 40, -520, -340));   /* 图外空白处按下 */
    await click('[data-rd-zoomval]'); await sleep(400);
    S.drags.push(await drag(110, 70, -520, -340));  /* 100% 图外按下 */

    /* E 双连击对照（上一发的做法：同一 tick 两次 click） */
    log('  E 双连击对照（同 tick 两次 click）');
    await click('[data-rd-zoomval]'); await sleep(400);
    S.E.push(await step(S.E, 'E', '[data-rd-zoomin]', 'dbl→140', { times: 2, wait: 900 }));
    S.E.push(await step(S.E, 'E', '[data-rd-zoomout]', 'dbl→100', { times: 2, wait: 900 }));
  }

  await evaluate(`(function(){ try{ window.HS.reader.close(); }catch(e){} return 1; })()`);

  /* ---------------- 汇总 ---------------- */
  const all = [];
  Object.keys(R.shapes).forEach(k => {
    const S = R.shapes[k];
    ['A', 'B', 'C', 'C2', 'E'].forEach(sc => (S[sc] || []).forEach(r => all.push(Object.assign({ shape: k, scene: sc }, r))));
  });
  const pure = all.filter(r => r.scene === 'A' || r.scene === 'B');
  const worstPure = pure.slice().sort((a, b) => b.drift - a.drift)[0] || null;
  const dragged = all.filter(r => r.scene === 'C' || r.scene === 'C2');
  const worstDragged = dragged.slice().sort((a, b) => b.drift - a.drift)[0] || null;
  const dbl = all.filter(r => r.scene === 'E');
  const worstDbl = dbl.slice().sort((a, b) => b.drift - a.drift)[0] || null;
  const drags = [];
  Object.keys(R.shapes).forEach(k => (R.shapes[k].drags || []).forEach(d => drags.push(Object.assign({ shape: k }, d))));
  R.summary = {
    点数: { 纯缩放: pure.length, 拖后缩放: dragged.length, 双连击: dbl.length, 拖拽: drags.length },
    纯缩放最大漂移: worstPure && { px: worstPure.drift, at: worstPure.shape + '/' + worstPure.tag + '@' + worstPure.zoom },
    拖后缩放最大漂移: worstDragged && { px: worstDragged.drift, at: worstDragged.shape + '/' + worstDragged.tag + '@' + worstDragged.zoom },
    双连击最大漂移: worstDbl && { px: worstDbl.drift, at: worstDbl.shape + '/' + worstDbl.tag + '@' + worstDbl.zoom },
    纯缩放超4px清单: pure.filter(r => r.drift > 4).map(r => r.shape + '/' + r.tag + '@' + r.zoom + '=' + r.drift + 'px(dx' + r.dx + ',dy' + r.dy + ')'),
    拖后缩放超4px清单: dragged.filter(r => r.drift > 4).map(r => r.shape + '/' + r.tag + '@' + r.zoom + '=' + r.drift + 'px tf' + String(r.tfBefore).slice(0, 26)),
    拖拽不跟手清单: drags.filter(d => !d.follow).map(d => d.shape + '/zoom' + d.zoom + ' want' + JSON.stringify(d.want) + ' got' + JSON.stringify(d.got)),
    每形状最大: Object.keys(R.shapes).reduce((o, k) => {
      const S = R.shapes[k];
      const m = arr => arr && arr.length ? Math.max.apply(null, arr.map(r => r.drift)) : null;
      const md = (S.drags || []).map(d => d.follow);
      o[k] = { A: m(S.A), B: m(S.B), C: m(S.C), C2: m(S.C2), E: m(S.E), 拖拽: md.length + '次/' + md.filter(x => !x).length + '不跟手' };
      return o;
    }, {}),
    判据: { 漂移: '<4px', 跟手: '|图上位移-鼠标位移|<=8px' }
  };
  log('\n═══ 汇总 ═══');
  log('纯缩放（无拖拽）最大漂移：' + JSON.stringify(R.summary.纯缩放最大漂移));
  log('先拖再缩放最大漂移：' + JSON.stringify(R.summary.拖后缩放最大漂移));
  log('双连击最大漂移：' + JSON.stringify(R.summary.双连击最大漂移));
  log('拖拽不跟手：' + JSON.stringify(R.summary.拖拽不跟手清单));
  log('JSON_SUMMARY=' + JSON.stringify(R.summary));
  return R;
};
