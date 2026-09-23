'use strict';
/* 阅读器收敛测试：横向(h)/纵向(v) × 竖图/横图/方图 × 缩放保位 + 任意倍率拖拽。
   为什么还要一个：tools/reader-zoom-steps.js 只用 1000×1400 的竖图。
   用户报的场景是「左右翻页」，而横向单页里**横图**的可滚余量为 0（甚至为负），
   走的是「图片 transform」那一档，与竖图（走滚动档）是两条完全不同的代码路径，
   只测竖图会漏掉一半。
   用法：node tools/live-probe.js --url=http://127.0.0.1:8788/ --steps=tools/reader-cover-steps.js */
module.exports = async function main(ctx) {
  const { evaluate, mouse, sleep, log } = ctx;
  const R = { at: new Date().toISOString(), cases: {} };

  await evaluate(`(function(){
    try{ HS.settings.adultOk = true; if(HS.store&&HS.store.save) HS.store.save(HS.settings); }catch(e){}
    var g=document.getElementById('gate'); if(g) g.hidden=true;
    var nb=document.getElementById('net-banner'); if(nb) nb.hidden=true;
    return 1; })()`);

  /* 页面内工具：按「视口正中那个物理点」量漂移（与用户看到的一致），
     并把「同一张图 rect 的位移」作为拖拽判据。 */
  await evaluate(`(function(){
    var Q = window.__Q = {};
    Q.pg = function(){ return document.querySelector('.hs-rd-pg.is-cur'); };
    Q.img = function(pg){ pg = pg||Q.pg(); return pg && (pg.querySelector('.hs-rd-img img')||pg.querySelector('img')); };
    Q.box = function(el){ if(!el) return null; var r=el.getBoundingClientRect();
      return {l:+r.left.toFixed(1),t:+r.top.toFixed(1),w:+r.width.toFixed(1),h:+r.height.toFixed(1),
              cx:+(r.left+r.width/2).toFixed(1),cy:+(r.top+r.height/2).toFixed(1)}; };
    /* object-fit:contain 之后「真正渲染的画面」矩形（与 reader.js 的 picBox 同口径） */
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
      return {fx:+window.__P.fx.toFixed(4), fy:+window.__P.fy.toFixed(4), pic:{l:+p.l.toFixed(1),t:+p.t.toFixed(1),w:+p.w.toFixed(1),h:+p.h.toFixed(1)}};
    };
    Q.drift = function(){
      var im=Q.img(); if(!im||!window.__P) return null; var p=Q.pic(im), P=window.__P;
      var tx=p.l+P.fx*p.w, ty=p.t+P.fy*p.h;
      var pg=Q.pg();
      return { d:+Math.hypot(tx-P.cx,ty-P.cy).toFixed(2), dx:+(tx-P.cx).toFixed(2), dy:+(ty-P.cy).toFixed(2),
        zoom:(document.querySelector('[data-rd-zoomval]')||{}).textContent,
        room: pg ? ((pg.scrollWidth-pg.clientWidth)+'x'+(pg.scrollHeight-pg.clientHeight)) : null,
        scroll: pg ? (pg.scrollLeft+'/'+pg.scrollTop) : null,
        tf: im.style.transform||'none', tfW:(im.closest('.hs-rd-img')||im).style.transform||'none',
        pic:{l:+p.l.toFixed(1),t:+p.t.toFixed(1),w:+p.w.toFixed(1),h:+p.h.toFixed(1)} };
    };
    return 'ok'; })()`);

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
        return Promise.resolve(new Response(JSON.stringify({ok:true,title:'COVER',chapters:[{id:'c1',name:'d'}],pages:pages}),
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
      window.HS.reader.open({source:'jmcomic',id:'cover-${dir}-'+Date.now(),title:'COVER'})
        .then(function(){window.__O='ok';},function(e){window.__O='err:'+e;});
      return 1; })()`);
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const st = await evaluate(`(function(){ var p=document.querySelectorAll('.hs-rd-pg');
        var im=document.querySelector('.hs-rd-pg .hs-rd-img img');
        return {n:p.length, ok:!!(im&&im.complete&&im.naturalWidth)}; })()`);
      if (st.ok && st.n >= 2) break;
    }
    await sleep(500);
    return evaluate(`(function(){ var im=window.__Q.img(); return im?{nat:im.naturalWidth+'x'+im.naturalHeight}:null; })()`);
  };

  const zoomStep = async (sel, label) => {
    await evaluate(`(function(){ window.__Q.pin(); return 1; })()`);
    const before = await evaluate(`window.__Q.drift()`);
    await evaluate(`document.querySelector('${sel}').click()`);
    await sleep(450);
    const after = await evaluate(`window.__Q.drift()`);
    const rec = { label, zoom: after.zoom, drift: after.d, dx: after.dx, dy: after.dy,
      room: after.room, scroll: after.scroll, tf: after.tf,
      picBefore: before.pic, picAfter: after.pic };
    log('  ' + label.padEnd(12) + String(after.zoom).padStart(6) + '  漂移=' + String(after.d).padStart(8) +
      'px  room=' + after.room + '  tf=' + after.tf.slice(0, 26));
    return rec;
  };

  const drag = async (dx, dy, label, cx, cy) => {
    cx = cx || 0; cy = cy || 0;
    const b = await evaluate(`window.__Q.drift()`);
    const px = Math.round(640 + cx), py = Math.round(450 + cy);
    await mouse.move(px, py);
    await mouse.down(px, py);
    await sleep(70);
    for (let k = 1; k <= 4; k++) { await mouse.move(px + dx * k / 4, py + dy * k / 4, { buttons: 1 }); await sleep(45); }
    const mid = await evaluate(`window.__Q.drift()`);
    await mouse.up(px + dx, py + dy);
    await sleep(320);
    const end = await evaluate(`window.__Q.drift()`);
    const dPic = (a) => a && b ? { dl: +(a.pic.l - b.pic.l).toFixed(1), dt: +(a.pic.t - b.pic.t).toFixed(1) } : null;
    const rec = { label, dx, dy, zoom: end.zoom, picMid: dPic(mid), picEnd: dPic(end),
      room: end.room, scroll: end.scroll, tf: end.tf };
    log('  ' + label.padEnd(12) + 'drag(' + dx + ',' + dy + ')  图上位移=' + JSON.stringify(rec.picEnd) +
      '  room=' + end.room + '  scroll=' + end.scroll + '  tf=' + end.tf.slice(0, 24));
    return rec;
  };

  const SHAPES = [
    { key: 'portrait', w: 1000, h: 1400 },
    { key: 'landscape', w: 1600, h: 900 },
    { key: 'square', w: 1200, h: 1200 }
  ];

  for (const sh of SHAPES) {
    R.cases[sh.key] = { shape: sh.w + 'x' + sh.h };
    await evaluate(`(function(){ window.__Q.pin = window.__Q.pin; return 1; })()`);
    await makeChapter(sh.w, sh.h);
    for (const dir of ['h', 'v']) {
      const c = { open: await open(dir) };
      c.zoom = [];
      c.zoom.push(await zoomStep('[data-rd-zoomin]', dir + '-in 120'));
      c.zoom.push(await zoomStep('[data-rd-zoomin]', dir + '-in 140'));
      c.zoom.push(await zoomStep('[data-rd-zoomout]', dir + '-out120'));
      c.zoom.push(await zoomStep('[data-rd-zoomout]', dir + '-out100'));
      c.zoom.push(await zoomStep('[data-rd-zoomval]', dir + '-reset'));
      c.drag100 = await drag(130, 95, dir + '-100');
      c.drag100b = await drag(-170, -130, dir + '-100b');
      await evaluate(`document.querySelector('[data-rd-zoomin]').click()`);
      await evaluate(`document.querySelector('[data-rd-zoomin]').click()`);
      await sleep(450);
      c.at140 = await evaluate(`window.__Q.drift()`);
      c.drag140 = await drag(150, 105, dir + '-140');
      c.drag140b = await drag(-180, -140, dir + '-140b');
      /* 缩到 80%/60% 再回 100%：用户报的「缩小也不该改变位置」 */
      await evaluate(`document.querySelector('[data-rd-zoomval]').click()`);
      await sleep(300);
      await evaluate(`(function(){ window.__Q.pin(); return 1; })()`);
      await evaluate(`document.querySelector('[data-rd-zoomout]').click()`);
      await sleep(350);
      c.out80 = await evaluate(`window.__Q.drift()`);
      log('  ' + (dir + '-out80').padEnd(12) + '  漂移=' + c.out80.d + 'px  zoom=' + c.out80.zoom);
      R.cases[sh.key][dir] = c;
    }
  }

  await evaluate(`(function(){ try{ window.HS.reader.close(); }catch(e){} return 1; })()`);

  /* 汇总：漂移阈值取 4px（肉眼不可见量级；旧代码这里是 147.8px） */
  const rows = [];
  Object.keys(R.cases).forEach(k => {
    ['h', 'v'].forEach(d => {
      const c = R.cases[k][d]; if (!c) return;
      (c.zoom || []).forEach(z => rows.push({ 形状: k, 方向: d, 步骤: z.label, 倍率: z.zoom, 漂移px: z.drift }));
      const o = c.out80; if (o) rows.push({ 形状: k, 方向: d, 步骤: d + '-out80', 倍率: o.zoom, 漂移px: o.d });
    });
  });
  const worst = rows.slice().sort((a, b) => (b.漂移px || 0) - (a.漂移px || 0))[0];
  const drags = [];
  Object.keys(R.cases).forEach(k => ['h', 'v'].forEach(d => {
    const c = R.cases[k][d]; if (!c) return;
    ['drag100', 'drag100b', 'drag140', 'drag140b'].forEach(n => {
      if (!c[n]) return;
      drags.push({ 形状: k, 方向: d, 步骤: c[n].label, 期望dx: c[n].dx, 期望dy: c[n].dy,
        实测: c[n].picEnd, 余量: c[n].room, tf: c[n].tf.slice(0, 20) });
    });
  }));
  R.summary = { 最大缩放漂移px: worst ? worst.漂移px : null, 最大漂移出处: worst, 拖拽: drags };
  log('\n=== 汇总 ===');
  log('最大缩放漂移：' + (worst ? (worst.漂移px + 'px @ ' + worst.形状 + '/' + worst.方向 + '/' + worst.步骤) : 'n/a') +
    '（判据 <4px；旧代码 147.8px）');
  return R;
};
