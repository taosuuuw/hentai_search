'use strict';
/* 阅读器 h 模式·缩放保位验收（第 11 轮·第三发，口径已按「视口中心不变量」重定）
   ── 度量口径（先想清楚，再量）──────────────────────────────────────────────
   缩放必然让画面的**边缘**往外走（那是「变大」，不是「位移」）。所以「位置不变」只能有
   一个可判定的不变量：**缩放开始那一刻落在视口正中的那个内容点，缩放后还在视口正中**。
   这也是第 7 轮用户原话「我希望中心线是保持原位的」以及第 10 轮修复所采用的判据。
   于是本脚本把锚点钉在**屏幕坐标**上（默认视口正中 640,450），记下它此刻落在画面的哪个
   分数位置，缩放后量它跑到哪 ⇒ drift。另外保留一个偏心屏幕点 (1000,700) 作**参考量**：
   在「钉中心」的口径下它本来就会按 (分数-中心) 成比例走掉（那是放大，不是 bug），
   所以它只作观察，不作判据。
   ── 场景 ──────────────────────────────────────────────────────────────────
   A 纯缩放梯（锚=视口正中）：100→300（10 档）→50（12 档），逐档单击 600ms
   B 先拖 (130,95) 再缩放（锚=拖后的视口正中）—— 第 10 轮遗留缺陷：旧代码在这一步
     把拖拽位移清掉，实测 47.7~49.6px 的跳；修复后应回到亚像素
   C 裁切检查：≤100% 时画面必须完整待在页盒里（>1px 就是被切）；>100% 画面本来
     就比页盒大、可以滚，那里的 clip 只当观察量
   D 拖拽跟手：50/100/140/300% 各拖一次 + 图外空白处按下（真鼠标 CDP）
   ── 模式 ──────────────────────────────────────────────────────────────────
   全量（默认）：A+B+C+D，约 6~8 分钟
   快速（$env:HS_QS='1'）：只跑 B（4 档），约 40 秒
   用法：
     node tools/live-probe.js --url=http://127.0.0.1:8788/ --steps=tools/reader-anchor-offcenter-steps.js --w=1280 --h=900 --wait=1500 *> tools/_anchor-out.txt */
module.exports = async function main(ctx) {
  const { evaluate, mouse, sleep, log } = ctx;
  const QUICK = String(process.env.HS_QS || '') === '1';
  const R = { at: new Date().toISOString(), mode: QUICK ? 'quick' : 'full', viewport: '1280x900', shapes: {} };
  const DRIFT_MAX = 4;
  const CX = 640, CY = 450;                 /* 视口正中：验收锚点 */
  const OFF = [1000, 700];                  /* 偏心屏幕点：只作观察 */

  await evaluate(`(function(){
    try{ HS.settings.adultOk = true; }catch(e){}
    var g=document.getElementById('gate'); if(g) g.hidden=true;
    var nb=document.getElementById('net-banner'); if(nb) nb.hidden=true; return 1; })()`);

  await evaluate(`(function(){
    var Q = window.__Q = {};
    Q.pg = function(){ return document.querySelector('.hs-rd-pg.is-cur'); };
    Q.img = function(pg){ pg=pg||Q.pg(); return pg && (pg.querySelector('.hs-rd-img img')||pg.querySelector('img')); };
    Q.pic = function(im){
      if(!im) return null; var r=im.getBoundingClientRect(), nw=im.naturalWidth, nh=im.naturalHeight;
      if(!nw||!nh) return {l:r.left,t:r.top,w:r.width,h:r.height};
      var s=Math.min(r.width/nw,r.height/nh), w=nw*s, h=nh*s;
      return {l:r.left+(r.width-w)/2, t:r.top+(r.height-h)/2, w:w, h:h};
    };
    /* ★钉屏幕坐标★：记这个屏幕点此刻落在画面的分数位置，缩放后同一个分数点的屏幕位置
       与 (ax,ay) 的距离就是 drift。分数可能 <0 或 >1（屏幕点落在画面外的留白上）——
       那代表用户钉的是一块空白，仍按同一分数外推，量出来的仍是「画面整体有没有乱跑」。 */
    Q.pinScreen = function(ax,ay){
      var im=Q.img(); if(!im) return null; var p=Q.pic(im); if(!p) return null;
      window.__A = {ax:ax, ay:ay, fx:(ax-p.l)/p.w, fy:(ay-p.t)/p.h};
      return {fx:+window.__A.fx.toFixed(3), fy:+window.__A.fy.toFixed(3), inside:(ax>=p.l&&ax<=p.l+p.w&&ay>=p.t&&ay<=p.t+p.h)};
    };
    Q.zoom = function(){ var e=document.querySelector('[data-rd-zoomval]'); return e?e.textContent.trim():null; };
    Q.tf = function(){ var im=Q.img(); return im?(im.style.transform||'none'):null; };
    Q.clip = function(){
      var im=Q.img(), p=Q.pic(im), pg=Q.pg(); if(!p||!pg) return null;
      var b=pg.getBoundingClientRect();
      return +Math.max(0, b.left-p.l, p.l+p.w-b.right, b.top-p.t, p.t+p.h-b.bottom).toFixed(1);
    };
    Q.snap = function(tag){
      var im=Q.img(), p=Q.pic(im), pg=Q.pg(), A=window.__A;
      var o={tag:tag, zoom:Q.zoom(), tf:Q.tf(), clip:Q.clip(), inView:!!im,
        room:pg?((pg.scrollWidth-pg.clientWidth)+'x'+(pg.scrollHeight-pg.clientHeight)):null,
        scroll:pg?(pg.scrollLeft+'/'+pg.scrollTop):null};
      if(A&&p){ var px=p.l+A.fx*p.w, py=p.t+A.fy*p.h;
        o.drift=+Math.hypot(px-A.ax, py-A.ay).toFixed(2);
        o.pos={x:+px.toFixed(2), y:+py.toFixed(2)};
        o.anchor=[A.ax,A.ay].join(','); }
      return o;
    };
    return 'ok'; })()`);

  const makeChapter = (w, h) => evaluate(`(function(){
    function page(i){ var w=${w}, h=${h};
      var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'">'+
        '<rect width="'+w+'" height="'+h+'" fill="#fff"/>'+
        '<rect x="0" y="0" width="'+w+'" height="'+h+'" fill="none" stroke="#06c" stroke-width="8"/>'+
        '<line x1="'+(w/2)+'" y1="0" x2="'+(w/2)+'" y2="'+h+'" stroke="#e11" stroke-width="3"/>'+
        '<line x1="0" y1="'+(h/2)+'" x2="'+w+'" y2="'+(h/2)+'" stroke="#e11" stroke-width="3"/>'+
        '<circle cx="'+(w/8)+'" cy="'+(h/8)+'" r="24" fill="#0a0"/>'+
        '<circle cx="'+(w*7/8)+'" cy="'+(h*7/8)+'" r="24" fill="#a0a"/>'+
        '<text x="20" y="80" font-size="64" fill="#111" font-family="monospace">P'+(i+1)+'</text></svg>';
      return {url:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg), w:w, h:h}; }
    var pages=[]; for(var i=0;i<5;i++) pages.push(page(i));
    var of=window.fetch;
    window.fetch=function(u,o){ if(String(u).indexOf('/api/reader')>=0){
      return Promise.resolve(new Response(JSON.stringify({ok:true,title:'ANCHOR',chapters:[{id:'c1',name:'d'}],pages:pages}),
        {status:200,headers:{'Content-Type':'application/json'}})); }
      return of.apply(this,arguments); };
    return 1; })()`);

  const open = async () => {
    await evaluate(`(function(){ try{ window.HS.reader.close(); }catch(e){} return 1; })()`);
    await sleep(250);
    await evaluate(`(function(){ window.HS.settings.readerDir='h'; return 1; })()`);
    await evaluate(`(function(){ window.HS.reader.open({source:'jmcomic',id:'anchor-'+Date.now(),title:'ANCHOR'})
      .then(function(){window.__O='ok';},function(e){window.__O='err:'+e;}); return 1; })()`);
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const st = await evaluate(`(function(){ var p=document.querySelectorAll('.hs-rd-pg');
        var im=document.querySelector('.hs-rd-pg.is-cur .hs-rd-img img');
        return {n:p.length, ok:!!(im&&im.complete&&im.naturalWidth)}; })()`);
      if (st.ok && st.n >= 2) break;
    }
    await sleep(500);
    return evaluate(`(function(){ var im=window.__Q.img(), p=im?window.__Q.pic(im):null;
      return {nat:im?im.naturalWidth+'x'+im.naturalHeight:null, zoom:window.__Q.zoom(),
        pic:p?[p.l,p.t,p.w,p.h].map(function(v){return +v.toFixed(1);}):null}; })()`);
  };
  const click = async s => evaluate(`(function(){ var b=document.querySelector('${s}'); if(!b||b.disabled) return 0; b.click(); return 1; })()`);

  const ladder = async (collect, anchor, sel, times) => {
    const pin = await evaluate(`window.__Q.pinScreen(${anchor[0]},${anchor[1]})`);
    log('      [锚点屏幕 ' + anchor.join(',') + ' → 画面分数 ' + pin.fx + '/' + pin.fy + (pin.inside ? ' 画面内' : ' 画面外留白') + ']');
    for (let i = 0; i < times; i++) {
      await click(sel);
      await sleep(600);
      const a = await evaluate(`window.__Q.snap('${sel === '[data-rd-zoomin]' ? 'in' : 'out'}')`);
      const row = { anchor: anchor.join(','), zoom: a.zoom, drift: a.drift, clip: a.clip,
        room: a.room, scroll: a.scroll, tf: String(a.tf).slice(0, 26) };
      collect.push(row);
      log('      ' + ('锚' + row.anchor).padEnd(16) + String(a.zoom).padStart(5) +
        '  drift=' + String(a.drift).padStart(8) + 'px  clip=' + String(a.clip).padStart(6) +
        '  room=' + a.room + '  scroll=' + a.scroll + '  tf=' + row.tf);
    }
    return collect;
  };

  const drag = async (dx, dy) => {
    await evaluate(`window.__Q.pinScreen(${CX},${CY})`);   /* 先钉住视口正中，才能量位移矢量 */
    const b = await evaluate(`window.__Q.snap('pre')`);
    const px = 640, py = 450;
    await mouse.move(px, py); await mouse.down(px, py); await sleep(70);
    for (let k = 1; k <= 4; k++) { await mouse.move(px + dx * k / 4, py + dy * k / 4, { buttons: 1 }); await sleep(45); }
    await mouse.up(px + dx, py + dy); await sleep(320);
    const e = await evaluate(`window.__Q.snap('post')`);
    const got = [+(e.pos.x - b.pos.x).toFixed(1), +(e.pos.y - b.pos.y).toFixed(1)];
    const follow = Math.abs(got[0] - dx) <= 8 && Math.abs(got[1] - dy) <= 8;
    log('    drag(' + dx + ',' + dy + ')  锚点位移=' + JSON.stringify(got) + '（期望 [' + dx + ',' + dy + ']）' +
      (follow ? ' 跟手✓' : ' ✗') + '  zoom=' + e.zoom + ' tf=' + String(e.tf).slice(0, 24) + ' clip=' + e.clip);
    return { want: [dx, dy], got, follow, zoom: e.zoom, tf: e.tf, clip: e.clip };
  };

  const SHAPES = [
    { key: 'portrait', w: 1000, h: 1400 },
    { key: 'landscape', w: 1600, h: 900 },
    { key: 'square', w: 1200, h: 1200 },
    { key: 'ultrawide', w: 2400, h: 700 },
    { key: 'tiny', w: 420, h: 300 }
  ];
  const IN_STEPS = QUICK ? 4 : 10;
  const OUT_STEPS = QUICK ? 0 : 12;

  for (const sh of SHAPES) {
    await makeChapter(sh.w, sh.h);
    const S = R.shapes[sh.key] = { shape: sh.w + 'x' + sh.h, open: await open(), pure: [], offDiag: [], dragThenZoom: [], drags: [], clipsUnder100: [] };
    log('\n══ ' + sh.key + ' ' + sh.w + 'x' + sh.h + '  画面=' + JSON.stringify(S.open.pic) + '  zoom=' + S.open.zoom);
    if (!QUICK) {
      await click('[data-rd-zoomval]'); await sleep(400);
      log('  A 纯缩放 100→300（锚=视口正中）');
      await ladder(S.pure, [CX, CY], '[data-rd-zoomin]', IN_STEPS);
      log('  A 纯缩放 300→50');
      await ladder(S.pure, [CX, CY], '[data-rd-zoomout]', OUT_STEPS);
      log('  A′ 偏心屏幕点 ' + OFF.join(',') + ' 观察量：100→140→100');
      await click('[data-rd-zoomval]'); await sleep(350);
      await ladder(S.offDiag, OFF, '[data-rd-zoomin]', 2);
      await ladder(S.offDiag, OFF, '[data-rd-zoomout]', 2);
      S.offDiag.forEach(r => { if (r.zoom === '100%' && r.clip > 1) S.clipsUnder100.push('offDiag@100% clip=' + r.clip); });
    }
    /* B 先拖再缩放：拖后重钉视口正中（这一档是第 10 轮遗留缺陷的正身） */
    await click('[data-rd-zoomval]'); await sleep(400);
    S.drags.push(await drag(130, 95));
    log('  B 拖动后 100→' + (100 + IN_STEPS * 20) + '（锚=拖后的视口正中）');
    await ladder(S.dragThenZoom, [CX, CY], '[data-rd-zoomin]', IN_STEPS);
    S.dragThenZoom.forEach(r => { if (parseInt(r.zoom, 10) <= 100 && r.clip > 1) S.clipsUnder100.push('dragZoom@' + r.zoom + ' clip=' + r.clip); });
    /* 2 次缩回 → 跨 100% 门槛（CSS 居中规则切换点）再看一眼 */
    if (!QUICK) {
      log('  B′ 缩回 100% 再看一次');
      await ladder(S.dragThenZoom, [CX, CY], '[data-rd-zoomout]', (100 + IN_STEPS * 20 - 100) / 20);
      S.dragThenZoom.forEach(r => { if (parseInt(r.zoom, 10) <= 100 && r.clip > 1) S.clipsUnder100.push('dragBack@' + r.zoom + ' clip=' + r.clip); });
    }
    S.drags.push(await drag(120, 90));
  }

  await evaluate(`(function(){ try{ window.HS.reader.close(); }catch(e){} return 1; })()`);

  /* ---------------- 汇总 ---------------- */
  const pure = [], dz = [], offd = [], clips = [], drags = [];
  Object.keys(R.shapes).forEach(k => {
    const s = R.shapes[k];
    s.pure.forEach(r => pure.push(Object.assign({ shape: k }, r)));
    s.dragThenZoom.forEach(r => dz.push(Object.assign({ shape: k }, r)));
    s.offDiag.forEach(r => offd.push(Object.assign({ shape: k }, r)));
    (s.drags || []).forEach(d => drags.push(Object.assign({ shape: k }, d)));
    (s.clipsUnder100 || []).forEach(c => clips.push(k + '/' + c));
  });
  const worst = a => a.slice().sort((x, y) => y.drift - x.drift)[0] || null;
  const wPure = worst(pure), wDz = worst(dz), wOff = worst(offd);
  R.summary = {
    模式: R.mode,
    口径: '锚点钉在屏幕坐标(视口正中 640,450)；量「缩放前落在该点的内容点」缩放后漂了多远',
    A_纯缩放点数: pure.length,
    A_纯缩放最大漂移: wPure && { px: wPure.drift, at: wPure.shape + '@' + wPure.zoom },
    A_超4px清单: pure.filter(r => r.drift > DRIFT_MAX).map(r => r.shape + '@' + r.zoom + '=' + r.drift + 'px'),
    B_拖后缩放最大漂移: wDz && { px: wDz.drift, at: wDz.shape + '@' + wDz.zoom },
    B_拖后缩放全档: dz.map(r => r.shape + '@' + r.zoom + '=' + r.drift),
    B_超4px清单: dz.filter(r => r.drift > DRIFT_MAX).map(r => r.shape + '@' + r.zoom + '=' + r.drift + 'px tf' + r.tf),
    A2_偏心点观察量: wOff && { px: wOff.drift, at: wOff.shape + '@' + wOff.zoom, 说明: '钉中心口径下按比例走掉=放大，不作判据' },
    'C_不超100%时被裁清单': clips,
    D_拖拽次数: drags.length,
    D_拖拽不跟手清单: drags.filter(d => !d.follow).map(d => d.shape + '/zoom' + d.zoom + ' want' + JSON.stringify(d.want) + ' got' + JSON.stringify(d.got)),
    D_拖拽全档: drags.map(d => d.shape + '@' + d.zoom + '=' + JSON.stringify(d.got)),
    判据: { 漂移: '<' + DRIFT_MAX + 'px（视口中心不变量）', 跟手: '<=8px（真鼠标 CDP）' }
  };
  log('\n═══ 汇总 ═══');
  log('A 纯缩放最大漂移：' + JSON.stringify(R.summary.A_纯缩放最大漂移));
  log('B 拖后缩放最大漂移：' + JSON.stringify(R.summary.B_拖后缩放最大漂移));
  log('B 全档：' + JSON.stringify(R.summary.B_拖后缩放全档));
  log('A′ 偏心观察量：' + JSON.stringify(R.summary.A2_偏心点观察量));
  log('C 裁切：' + JSON.stringify(clips));
  log('D 拖拽：' + R.summary.D_拖拽次数 + ' 次，不跟手 ' + JSON.stringify(R.summary.D_拖拽不跟手清单));
  log('JSON_SUMMARY=' + JSON.stringify(R.summary));
  return R;
};
