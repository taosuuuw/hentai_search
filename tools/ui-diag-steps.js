'use strict';
/* ==========================================================================
   tools/ui-diag-steps.js —— 一次性诊断探针（配合 tools/live-probe.js --steps）
   目的只有一个：把「拖不动 / 点不翻页 / 灯看不见」这三件事的**机制**落到可证伪的数据上。
   A. 事件送没送到：真鼠标按下 → 记录 window/document/el.scroll 各级 capture+bubble
      收到的 pointerdown / mousedown，以及 document.elementFromPoint 命中的元素链。
      → 能区分「事件被别的东西吃了」和「handler 逻辑/异常坏了」。
   B. JS 合成 PointerEvent 直接喂给 <img>：若合成事件能翻页/能位移，则接线正常，问题在送达。
   C. 页面异常：window.onerror + console.error 台账（handler 里抛异常会让 panStart 半途死掉）。
   D. 侧光为什么不可见：读 ::after 的真实 backgroundImage / mix-blend-mode，
      再分别用「blend 保持原样」和「强制 normal」各扫几个相位量像素。
   用法：
     node tools/live-probe.js --url=http://127.0.0.1:8799/ --steps=tools/ui-diag-steps.js --w=1280 --h=900 --wait=1200
   产出 tools/ui-diag.json
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const PRE = `(function(){
  var P = window.__P = window.__P || {};
  P.q = function(s,r){ return (r||document).querySelector(s); };
  P.box = function(){ return document.querySelector('.hs-rd-pg.is-cur'); };
  P.curIdx = function(){ var l=[].slice.call(document.querySelectorAll('.hs-rd-pg')); return l.indexOf(document.querySelector('.hs-rd-pg.is-cur')); };
  P.curImg = function(){ var pg=P.box(); return pg ? (pg.querySelector('.hs-rd-img img')||pg.querySelector('img')) : null; };
  P.imgTf = function(){ var im=document.querySelector('.hs-rd-pg.is-cur .hs-rd-img img'); return im ? (im.style.transform||'none') : null; };
  P.scrolls = function(){ var b=P.box(); function o(e){ return e?{x:e.scrollLeft,y:e.scrollTop,sw:e.scrollWidth,sh:e.scrollHeight,w:e.clientWidth,h:e.clientHeight}:null; } return {pg:o(b)}; };
  P.chain = function(x,y){
    var e=document.elementFromPoint(x,y), out=[];
    while(e && out.length<8){ out.push((e.tagName||'?').toLowerCase()+(e.className&&typeof e.className==='string'?('.'+e.className.trim().replace(/\\s+/g,'.')):'')+(e.id?('#'+e.id):'')); e=e.parentElement; }
    return out;
  };
  /* 事件台账：记录各级监听器是否收到 */
  P.installTap = function(){
    window.__EV = [];
    function rec(where){
      return function(e){
        window.__EV.push({w:where, t:e.type, target:(e.target&&e.target.className&&typeof e.target.className==='string')?e.target.className:((e.target&&e.target.tagName)||'?'),
                          button:e.button, id:(e.pointerId===undefined?-1:e.pointerId), x:Math.round(e.clientX||0), y:Math.round(e.clientY||0), dp:!!e.defaultPrevented});
        if(window.__EV.length>80) window.__EV.shift();
      };
    }
    ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){
      window.addEventListener(t, rec('win-cap'), true);
      window.addEventListener(t, rec('win-bub'), false);
      document.addEventListener(t, rec('doc-cap'), true);
    });
    var sc = document.querySelector('[data-rd-scroll]');
    if(sc){ ['pointerdown','pointerup'].forEach(function(t){ sc.addEventListener(t, rec('scroll-cap'), true); }); }
    /* window 上的 pointermove 太多，只记第一次 */
    var n=0;
    window.addEventListener('pointermove', function(){ if(n++<3) window.__EV.push({w:'win-move', t:'pointermove', target:'-', x:0,y:0}); }, false);
    window.__ERR = [];
    window.addEventListener('error', function(e){ window.__ERR.push(String(e.message)+' @'+String(e.filename).split('/').pop()+':'+e.lineno); });
    window.addEventListener('unhandledrejection', function(e){ window.__ERR.push('reject: '+String(e.reason && e.reason.message || e.reason)); });
    var ce = console.error;
    console.error = function(){ window.__ERR.push('console.error: '+[].slice.call(arguments).map(String).join(' ').slice(0,300)); ce.apply(console, arguments); };
    return 'installed';
  };
  P.clearEv = function(){ window.__EV = []; return 'cleared'; };
  /* 用 JS 合成 PointerEvent 直接喂给当前页的图（绕过 CDP/合成器） */
  P.jsDrag = function(dx, dy){
    var img = P.curImg(); if(!img) return 'no-img';
    function ev(type, node, x, y, id){ return node.dispatchEvent(new PointerEvent(type, {pointerId:id, isPrimary:true, pointerType:'mouse', button:0, buttons:type==='pointerup'?0:1, clientX:x, clientY:y, bubbles:true, cancelable:true})); }
    var x = innerWidth/2, y = innerHeight/2;
    var r1 = ev('pointerdown', img, x, y, 7);
    var r2 = ev('pointermove', window, x+dx, y+dy, 7);
    var tf = P.imgTf();
    var r3 = ev('pointerup', window, x+dx, y+dy, 7);
    return {down:r1, move:r2, up:r3, tfAfterMove:tf, tfAfterUp:P.imgTf(), idx:P.curIdx(), scrolls:P.scrolls()};
  };
  P.jsTap = function(which){
    var img = P.curImg(); if(!img) return 'no-img';
    function ev(type, node, x, y){ return node.dispatchEvent(new PointerEvent(type, {pointerId:9, isPrimary:true, pointerType:'mouse', button:0, buttons:type==='pointerup'?0:1, clientX:x, clientY:y, bubbles:true, cancelable:true})); }
    var x = which==='right' ? innerWidth*0.75 : innerWidth*0.25, y = innerHeight/2;
    var r1 = ev('pointerdown', img, x, y), r2 = ev('pointerup', window, x, y);
    return {down:r1, up:r2, idx:P.curIdx()};
  };
  P.analyze = function(b64, w, h, fracL, fracR){
    return new Promise(function(res){
      var img=new Image();
      img.onload=function(){ try{
        var c=document.createElement('canvas'); c.width=w; c.height=h;
        var g=c.getContext('2d',{willReadFrequently:true}); g.drawImage(img,0,0,w,h);
        function mean(x0,x1){ x0=Math.max(0,Math.round(x0)); x1=Math.min(w,Math.round(x1)); if(x1<=x0) return null;
          var d=g.getImageData(x0,0,x1-x0,h).data, s=0, n=0;
          for(var i=0;i<d.length;i+=4){ s+=0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2]; n++; }
          return +(s/n).toFixed(3); }
        res({left:mean(0,w*fracL), right:mean(w*(1-fracR),w), all:mean(0,w)});
      } catch(e){ res({err:String(e)}); } };
      img.onerror=function(){ res(null); };
      img.src='data:image/png;base64,'+b64;
    });
  };
  P.freeze = function(t, extra){
    var s=document.getElementById('hs-freeze');
    if(!s){ s=document.createElement('style'); s.id='hs-freeze'; document.documentElement.appendChild(s); }
    if(t==null){ s.textContent=''; return 'live'; }
    s.textContent = '.hs-searchbar::after,.hs-searchbar::before,.hs-sheet-grab::before{animation-play-state:paused !important;animation-delay:'+(-t)+'s !important;}' + (extra||'');
    return 'frozen@'+t;
  };
  P.afterCss = function(sb){
    var cs = getComputedStyle(sb,'::after');
    return {bgImage:String(cs.backgroundImage).slice(0,300), blend:cs.mixBlendMode, opacity:cs.opacity, pos:cs.backgroundPosition,
            lineGlow:getComputedStyle(sb).getPropertyValue('--glass-line-glow').trim(),
            sheen:getComputedStyle(sb).getPropertyValue('--glass-sheen').trim(),
            seam:getComputedStyle(sb).getPropertyValue('--glass-seam').trim(),
            beforeBg:String(getComputedStyle(sb,'::before').backgroundColor),
            beforeImg:String(getComputedStyle(sb,'::before').backgroundImage).slice(0,200)};
  };
  return 'pre-ok';
})()`;

const SYNTH = `(function(){
  function page(i){
    var w=1000,h=1400,g='';
    for(var x=100;x<w;x+=100) g+='<line x1="'+x+'" y1="0" x2="'+x+'" y2="'+h+'" stroke="#c9c9c9" stroke-width="2"/>';
    for(var y=100;y<h;y+=100) g+='<line x1="0" y1="'+y+'" x2="'+w+'" y2="'+y+'" stroke="#c9c9c9" stroke-width="2"/>';
    var svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><rect width="'+w+'" height="'+h+'" fill="#fff"/>'+g+
      '<circle cx="500" cy="700" r="14" fill="none" stroke="#11c" stroke-width="5"/>'+
      '<text x="30" y="90" font-size="70" fill="#111" font-family="monospace">P'+(i+1)+'</text></svg>';
    return {url:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg), w:w, h:h};
  }
  var pages=[]; for(var i=0;i<6;i++) pages.push(page(i));
  var of=window.fetch;
  window.fetch=function(u,o){ if(String(u).indexOf('/api/reader')>=0){
      return Promise.resolve(new Response(JSON.stringify({ok:true,title:'UI-DIAG',chapters:[{id:'c1',name:'单章'}],pages:pages}),{status:200,headers:{'Content-Type':'application/json'}})); }
    return of.apply(this,arguments); };
  return pages.length;
})()`;

module.exports = async function main(ctx) {
  const { cdp, evaluate, mouse, sleep, log } = ctx;
  const R = { at: new Date().toISOString(), url: ctx.url };

  await evaluate(PRE);

  /* ---------------- D. 侧光：先看 CSS 真实取值 ---------------- */
  try {
    const sbInfo = await evaluate(`(function(){ var e=document.querySelector('.hs-searchbar'); if(!e) return null; var r=e.getBoundingClientRect();
      return {rect:{l:r.left,t:r.top,w:r.width,h:r.height}, theme:document.documentElement.getAttribute('data-theme')||'(none)', css:window.__P.afterCss(e)}; })()`);
    R.glow = { info: sbInfo };
    if (sbInfo) {
      const clip = { x: Math.max(0, Math.round(sbInfo.rect.l) - 4), y: Math.max(0, Math.round(sbInfo.rect.t) - 10),
                     width: Math.round(sbInfo.rect.w) + 8, height: Math.round(sbInfo.rect.h) + 20, scale: 1 };
      const grab = async () => (await cdp.send('Page.captureScreenshot', { format: 'png', clip })).data;
      const sweep = async (label, extraCss, phases) => {
        const rows = [];
        for (const t of phases) {
          await evaluate(`window.__P.freeze(${t}, ${JSON.stringify(extraCss || '')})`);
          await sleep(140);
          const s = await grab();
          const a = await evaluate(`window.__P.analyze(${JSON.stringify(s)}, ${clip.width}, ${clip.height}, 0.15, 0.15)`);
          rows.push({ t: t, left: a && a.left, right: a && a.right, all: a && a.all, diff: a ? +(a.left - a.right).toFixed(3) : null });
        }
        log('glow[' + label + '] ' + rows.map(r => r.t + ':' + r.diff).join(' '));
        return rows;
      };
      /* 基线：把 ::after 背景层关掉，blend 强制 normal */
      await evaluate(`window.__P.freeze(0, '.hs-searchbar::after{background-image:none !important;mix-blend-mode:normal !important;}')`);
      await sleep(160);
      const bs = await grab();
      R.glow.baseNormal = await evaluate(`window.__P.analyze(${JSON.stringify(bs)}, ${clip.width}, ${clip.height}, 0.15, 0.15)`);
      /* 原样（screen） */
      R.glow.screenSweep = await sweep('screen', '', [0, 0.9, 1.8, 2.7]);
      /* 强制 normal */
      R.glow.normalSweep = await sweep('normal', '.hs-searchbar::after{mix-blend-mode:normal !important;}', [0, 0.45, 0.9, 1.35, 1.8, 2.25, 2.7, 3.15, 3.55]);
      await evaluate(`window.__P.freeze(null)`);
      R.glow.clip = clip;
    }
  } catch (e) { R.errGlow = String(e && e.stack || e); }

  /* ---------------- A/B/C. 阅读器指针链路 ---------------- */
  try {
    await evaluate(SYNTH);
    await evaluate(`(function(){ window.HS.settings.readerDir='h'; window.__OPENED=null;
      window.HS.reader.open({source:'jmcomic', id:'ui-diag', title:'UI-DIAG'}).then(function(){window.__OPENED='ok';},function(e){window.__OPENED='err:'+e;});
      return 'go'; })()`);
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      const st = await evaluate(`(function(){ var im=window.__P.curImg(); return {o:window.__OPENED, dir:document.querySelector('.hs-rd')&&document.querySelector('.hs-rd').getAttribute('data-dir'), ok:!!(im&&im.complete&&im.naturalWidth)}; })()`);
      if (st.ok) { R.ready = st; break; }
      if (i === 39) R.ready = st;
    }
    await sleep(400);
    const cx = await evaluate(`Math.round(innerWidth/2)`), cy = await evaluate(`Math.round(innerHeight/2)`);
    R.hit = {
      center: await evaluate(`window.__P.chain(${cx}, ${cy})`),
      left: await evaluate(`window.__P.chain(120, ${cy})`),
      right: await evaluate(`window.__P.chain(${cx + 200}, ${cy})`),
      scrollEl: await evaluate(`(function(){ var s=document.querySelector('[data-rd-scroll]'); if(!s) return null; var cs=getComputedStyle(s); return {tag:s.tagName, cls:s.className, pe:cs.pointerEvents, z:cs.zIndex, pos:cs.position, overflow:cs.overflow, rect:window.__P.chain?undefined:0}; })()`)
    };
    /* 真鼠标：先只测事件是否送达（不关心行为） */
    await evaluate(`window.__P.installTap()`);
    await evaluate(`window.__P.clearEv()`);
    await mouse.move(cx, cy);
    await mouse.down(cx, cy);
    await sleep(80);
    for (let k = 1; k <= 3; k++) { await mouse.move(cx + 40 * k, cy + 27 * k, { buttons: 1 }); await sleep(50); }
    const midTf = await evaluate(`window.__P.imgTf()`);
    await mouse.up(cx + 120, cy + 81);
    await sleep(300);
    R.realMouse = {
      events: await evaluate(`window.__EV`),
      midTf: midTf,
      endTf: await evaluate(`window.__P.imgTf()`),
      idx: await evaluate(`window.__P.curIdx()`),
      scrolls: await evaluate(`window.__P.scrolls()`)
    };
    R.realMouseEventCount = R.realMouse.events ? R.realMouse.events.length : 0;
    /* 合成事件：接线是否正常 */
    R.jsDrag = await evaluate(`window.__P.jsDrag(120, 80)`);
    await sleep(200);
    R.jsDragIdxBefore = await evaluate(`window.__P.curIdx()`);
    R.jsTap = await evaluate(`window.__P.jsTap('right')`);
    await sleep(300);
    R.jsTapIdxAfter = await evaluate(`window.__P.curIdx()`);
    R.jsTapLeft = await evaluate(`window.__P.jsTap('left')`);
    await sleep(300);
    R.jsTapLeftIdx = await evaluate(`window.__P.curIdx()`);
    R.errors = await evaluate(`window.__ERR`);
    R.state = await evaluate(`(function(){ var r=document.querySelector('.hs-rd'); return {cls:r.className, dir:r.getAttribute('data-dir'), zoom:getComputedStyle(r).getPropertyValue('--hs-rd-zoom').trim(), zoomVal:(document.querySelector('[data-rd-zoomval]')||{}).textContent}; })()`);
  } catch (e) { R.errReader = String(e && e.stack || e); }

  const out = path.join(ROOT, 'tools', 'ui-diag.json');
  fs.writeFileSync(out, JSON.stringify(R, null, 2));
  log('→ ' + out);
  return R;
};
