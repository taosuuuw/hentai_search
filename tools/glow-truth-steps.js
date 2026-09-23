'use strict';
/* ==========================================================================
   tools/glow-truth-steps.js —— 搜索框侧光的**确定性**真机测量（第 10 轮问题 3 验收）
   --------------------------------------------------------------------------
   用法（需不受限沙箱：Chrome 在 workspace-write 下自毁）：
     node tools/live-probe.js --url=http://127.0.0.1:8799/ --steps=tools/glow-truth-steps.js \
       --w=1280 --h=900 --wait=1500
   产出：tools/glow-truth-<tag>.json（HS_GLOW_TAG 控制，默认 run）

   为什么另起一个探针：上一版用 `animation-play-state:paused` + 负 delay 冻相位，
   真机发现**渲染帧并不跟着 computed style 走**：t=1.8 以后的 7 个采样点截到的像素
   逐位相同（left 恒 40.92x / right 恒 26.43x），而 computed background-position 明明
   从 4.65% 一路走到 74.75% ⇒ 那一段测的是同一帧、不是同一相位。
   所以这里改成**把 animation 关掉、直接写死 background-position**：
   动画关键帧本身就是「位置从 100% 线性/缓动走到 0%」(含 alternate 往返)，
   空间上采样 P∈[0,100] 就等于把那趟行程逐点走一遍，而且每一帧都必然重绘。

   四种配置分别测（同一批 P），才能把「灯」和「阴影」分开看：
     none  两层背景都关掉 = 材质基线（位置无关，只测一次）
     lamp  只有 ::after 的灯（screen 混合，只会加亮）
     shade 只有 .hs-sb-shade（multiply 混合，只会压暗）
     both  两层都在 = 用户真正看到的
   判据（用户原话：微光到右边时左边要**暗下去**、而不是发光；到左边同理）：
     · shade 单独：P=0 时左暗右不暗；P=100 时右暗左不暗；P=50 两侧都暗。
     · both：P=0 时 dL < −1.5（左暗右亮）；P=100 时 dR < −1.5。
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const TAG = process.env.HS_GLOW_TAG || 'run';

const SETUP = `(function(){
  var P = window.__P = window.__P || {};
  P.q = function(s, r){ return (r||document).querySelector(s); };
  /* 四种配置：直接写死 ::after 的三层位置 / shade 的位置，并关掉动画 */
  P.setCfg = function(cfg, p){
    var s = document.getElementById('glow-cfg');
    if(!s){ s = document.createElement('style'); s.id='glow-cfg'; (document.head||document.documentElement).appendChild(s); }
    var pos = 'background-position:' + p + '% 0, 0 0, 0 0 !important;';
    var out = '';
    if(cfg === 'none'){
      out = '.hs-searchbar::after{animation:none !important;background-image:none !important;}' +
            '.hs-searchbar > .hs-sb-shade{animation:none !important;background-image:none !important;}' +
            '.hs-searchbar::before{animation:none !important;background-image:none !important;}';
    } else {
      var lamp  = (cfg === 'lamp' || cfg === 'both');
      var shade = (cfg === 'shade' || cfg === 'both');
      out += '.hs-searchbar::after{animation:none !important;' + pos + '}';
      out += '.hs-searchbar > .hs-sb-shade{animation:none !important;background-position:' + p + '% 0 !important;' +
             (shade ? '' : 'background-image:none !important;') + '}';
      out += '.hs-searchbar::before{animation:none !important;background-image:none !important;}';
      if(!lamp) out = '.hs-searchbar::after{animation:none !important;background-image:none !important;}' + out;
    }
    s.textContent = out;
    /* 每次取样前把已知浮层重新收掉：本次运行中出现过搜索框整体下移 206px（浮层插进来顶动布局） */
    var g = document.getElementById('gate'); if(g) g.hidden = true;
    var nb = document.getElementById('net-banner'); if(nb) nb.hidden = true;
    return cfg + '@' + p;
  };
  P.analyze = function(b64, w, h, x0, x1){
    return new Promise(function(res){
      var img = new Image();
      img.onload = function(){
        try{
          var c = document.createElement('canvas'); c.width = w; c.height = h;
          var g = c.getContext('2d', {willReadFrequently:true});
          g.drawImage(img, 0, 0, w, h);
          function mean(a, b){
            a = Math.max(0, Math.round(a)); b = Math.min(w, Math.round(b));
            if(b <= a) return null;
            var d = g.getImageData(a, 0, b-a, h).data, s = 0, n = 0;
            for(var i=0;i<d.length;i+=4){ s += 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2]; n++; }
            return +(s/n).toFixed(3);
          }
          res({left:mean(x0,x1), all:mean(0,w), w:w, h:h});
        }catch(e){ res({err:String(e)}); }
      };
      img.onerror = function(){ res(null); };
      img.src = 'data:image/png;base64,' + b64;
    });
  };
  P.shadeGeom = function(){
    var e = document.querySelector('.hs-searchbar > .hs-sb-shade');
    var f = document.querySelector('.hs-searchbar');
    if(!e || !f) return null;
    var cs = getComputedStyle(e), rs = e.getBoundingClientRect(), rf = f.getBoundingClientRect();
    return {
      span: {l:+rs.left.toFixed(1), t:+rs.top.toFixed(1), w:+rs.width.toFixed(1), h:+rs.height.toFixed(1)},
      form: {l:+rf.left.toFixed(1), t:+rf.top.toFixed(1), w:+rf.width.toFixed(1), h:+rf.height.toFixed(1)},
      pos: cs.backgroundPosition, size: cs.backgroundSize, blend: cs.mixBlendMode,
      z: cs.zIndex, anim: cs.animationName, op: cs.opacity, inset: cs.inset, pos_: cs.position,
      imgHead: (cs.backgroundImage||'').slice(0, 80), formPos: getComputedStyle(f).position
    };
  };
  /* 列剖面：把裁剪图按 cols 段求每段平均亮度，用来看「暗的一侧到底在哪、形状如何」 */
  P.profile = function(b64, w, h, cols){
    return new Promise(function(res){
      var img = new Image();
      img.onload = function(){
        try{
          var c = document.createElement('canvas'); c.width = w; c.height = h;
          var g = c.getContext('2d', {willReadFrequently:true});
          g.drawImage(img, 0, 0, w, h);
          var d = g.getImageData(0, 0, w, h).data, out = [], step = w / cols;
          for(var k=0;k<cols;k++){
            var x0 = Math.round(k*step), x1 = Math.max(x0+1, Math.round((k+1)*step)), s=0, n=0;
            for(var y=0;y<h;y++) for(var x=x0;x<x1;x++){
              var i = (y*w + x)*4; s += 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2]; n++;
            }
            out.push(+(s/n).toFixed(2));
          }
          res(out);
        }catch(e){ res({err:String(e)}); }
      };
      img.onerror = function(){ res(null); };
      img.src = 'data:image/png;base64,' + b64;
    });
  };
  return 'setup-ok';
})()`;

module.exports = async function main(ctx) {
  const { cdp, evaluate, shot, sleep, log } = ctx;
  const R = { tag: TAG, url: ctx.url, at: new Date().toISOString(), notes: [] };
  await evaluate(SETUP);

  /* 前置：收掉成年门（全新 profile 下 adultOk=false，门会盖住整页） */
  const pre = await evaluate(`(function(){
    var out = {};
    function info(id){ var e=document.getElementById(id); if(!e) return null; var cs=getComputedStyle(e);
      return {hidden:!!e.hidden, display:cs.display, z:cs.zIndex}; }
    out.before = {gate: info('gate')};
    try{ HS.settings.adultOk = true; if(HS.store && HS.store.save) HS.store.save(HS.settings); }catch(e){ out.err=String(e); }
    var g=document.getElementById('gate'); if(g) g.hidden = true;
    var nb=document.getElementById('net-banner'); if(nb) nb.hidden = true;
    out.after = {gate: info('gate')};
    var sb=document.querySelector('.hs-searchbar');
    if(sb){ var r=sb.getBoundingClientRect(); var el=document.elementFromPoint(r.left+r.width/2, r.top+r.height/2);
      out.sbHit = el ? (typeof el.className==='string' && el.className ? el.className : el.tagName) : null;
      out.sbHitOk = !!(el && sb.contains(el)); }
    /* 确认三层都在（是第 10 轮的代码）*/
    var sh = document.querySelector('.hs-searchbar > .hs-sb-shade');
    out.hasShade = !!sh;
    out.theme = document.documentElement.getAttribute('data-theme') || '(default)';
    out.shadeZ = sh ? getComputedStyle(sh).zIndex : null;
    out.afterZ = getComputedStyle(document.querySelector('.hs-searchbar'), '::after').zIndex;
    out.afterAnim = getComputedStyle(document.querySelector('.hs-searchbar'), '::after').animationDirection;
    out.shadeAnim = sh ? getComputedStyle(sh).animationDirection : null;
    return out;
  })()`);
  R.pre = pre;
  if (!pre || !pre.sbHitOk) R.notes.push('★前置失败：搜索框被浮层挡住（' + (pre && pre.sbHit) + '）');
  if (!pre || !pre.hasShade) R.notes.push('★没有 .hs-sb-shade 元素：第 10 轮的阴影层没加载');
  await sleep(250);

  /* ★裁剪区必须**每次取样时重算**：本次运行中搜索框在采样中途整体下移了 206px
     （form.t 212.5 → 418.5，疑似 #net-banner/建议层之类的浮层插进来把内容顶下去），
     固定 clip 会让后半段测到页面上另一块区域（第一版 shade/both 数据就是这么废掉的）。 */
  const curClip = async () => {
    const r = await evaluate(`(function(){ var e=document.querySelector('.hs-searchbar'); if(!e) return null;
      var b=e.getBoundingClientRect(); return {l:b.left, t:b.top, w:b.width, h:b.height}; })()`);
    if (!r) return null;
    /* 只截盒子内部（上/下各留 3px，避开 ::before 的上沿光带与圆角外的页面底） */
    return { x: Math.round(r.l), y: Math.round(r.t) + 3, width: Math.round(r.w), height: Math.round(r.h) - 6, scale: 1, t: r.t };
  };
  const grab = async (clip) => (await cdp.send('Page.captureScreenshot', { format: 'png', clip })).data;
  const sample = async () => {
    const clip = await curClip();
    if (!clip) return null;
    const X0 = 30, X1 = 30 + Math.round((clip.width - 60) * 0.22);   /* 避开两端圆帽 */
    const s = await grab(clip);
    const a = await evaluate(`window.__P.analyze(${JSON.stringify(s)}, ${clip.width}, ${clip.height}, ${X0}, ${X1})`);
    const b = await evaluate(`window.__P.analyze(${JSON.stringify(s)}, ${clip.width}, ${clip.height}, ${clip.width - X1}, ${clip.width - X0})`);
    return { clip: { x: clip.x, y: clip.y, w: clip.width, h: clip.height, t: +clip.t.toFixed(1) },
             bands: { left: [X0, X1], right: [clip.width - X1, clip.width - X0] },
             left: a && a.left, all: a && a.all, right: b ? b.left : null };
  };
  const profile = async () => {
    const clip = await curClip();
    if (!clip) return null;
    const s = await grab(clip);
    return evaluate(`window.__P.profile(${JSON.stringify(s)}, ${clip.width}, ${clip.height}, 20)`);
  };
  R.geo = { base: await evaluate('window.__P.shadeGeom()') };
  R.rect = R.geo.base && R.geo.base.form;
  log('shadeGeom: ' + JSON.stringify(R.geo.base));

  /* ---------- 基线：两层都关 ---------- */
  await evaluate(`window.__P.setCfg('none', 0)`);
  await sleep(200);
  const b0 = await sample();
  const base = b0;
  R.baseline = base;
  log('baseline left=' + (base && base.left) + ' right=' + (base && base.right) + ' at t=' + (base && base.clip.t));

  const POS = [0, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100];
  const CFG = ['lamp', 'shade', 'both'];
  R.rows = [];
  for (const cfg of CFG) {
    for (const p of POS) {
      await evaluate(`window.__P.setCfg('${cfg}', ${p})`);
      await sleep(120);
      const m = await sample();
      const row = {
        cfg: cfg, p: p, t: m && m.clip.t,
        left: m && m.left, right: m && m.right, all: m && m.all,
        dL: m && base ? +(m.left - base.left).toFixed(3) : null,
        dR: m && base ? +(m.right - base.right).toFixed(3) : null,
        dAll: m && base ? +(m.all - base.all).toFixed(3) : null
      };
      if (m && base && Math.abs(m.clip.t - base.clip.t) > 1) {
        row.layoutShift = +(m.clip.t - base.clip.t).toFixed(1);
        R.layoutShifted = true;
      }
      R.rows.push(row);
      log(cfg + ' P=' + p + '% dL=' + row.dL + ' dR=' + row.dR + ' dAll=' + row.dAll);
      if (p === 0 || p === 50 || p === 100) {
        const pr = await profile();
        row.profile = pr;
        row.geo = await evaluate('window.__P.shadeGeom()');
        log('   profile20 ' + JSON.stringify(pr));
        log('   geo ' + JSON.stringify(row.geo));
      }
      if (cfg === 'both' && (p === 0 || p === 50 || p === 100)) {
        await shot('.tmp/glow-' + TAG + '-' + cfg + '-' + p + '.png');
      }
    }
  }
  /* 收尾：恢复原样（★live-probe 的 evaluate 按表达式求值，多语句必须包 IIFE） */
  await evaluate(`(function(){ window.__P.setCfg('none', 0); var s=document.getElementById('glow-cfg'); if(s) s.textContent=''; return 'restored'; })()`);

  const pick = (cfg, p) => R.rows.find(r => r.cfg === cfg && r.p === p) || {};
  const shade0 = pick('shade', 0), shade100 = pick('shade', 100), shade50 = pick('shade', 50);
  const both0 = pick('both', 0), both100 = pick('both', 100);
  const lamp0 = pick('lamp', 0), lamp100 = pick('lamp', 100);
  R.verdict = {
    /* 阴影层本身：P=0（底片左深）左暗右不暗；P=100 反过来 */
    shadeDarkensLeftAtP0: shade0.dL != null && shade0.dL < -4,
    shadeIgnoresRightAtP0: shade0.dR != null && shade0.dR > -2,
    shadeDarkensRightAtP100: shade100.dR != null && shade100.dR < -4,
    shadeIgnoresLeftAtP100: shade100.dL != null && shade100.dL > -2,
    shadeDarkensBothAtP50: shade50.dL != null && shade50.dL < -4 && shade50.dR != null && shade50.dR < -4,
    /* 灯本身（screen，只会加亮）：P=0 灯在右、P=100 灯在左 */
    lampBrightensRightAtP0: lamp0.dR != null && lamp0.dR > 2,
    lampBrightensLeftAtP100: lamp100.dL != null && lamp100.dL > 2,
    /* 用户诉求：两层叠起来之后，灯的对侧仍要**净变暗** */
    userLampRightDarkensLeft: both0.dL != null && both0.dL < -1.5,
    userLampLeftDarkensRight: both100.dR != null && both100.dR < -1.5,
    bothAtP0: { dL: both0.dL, dR: both0.dR },
    bothAtP100: { dL: both100.dL, dR: both100.dR }
  };
  R.pass = !!(R.verdict.shadeDarkensLeftAtP0 && R.verdict.shadeDarkensRightAtP100 &&
              R.verdict.userLampRightDarkensLeft && R.verdict.userLampLeftDarkensRight);

  const outFile = path.join(ROOT, 'tools', 'glow-truth-' + TAG + '.json');
  fs.writeFileSync(outFile, JSON.stringify(R, null, 2));
  log('结果 → ' + outFile + '  pass=' + R.pass);
  return R;
};
