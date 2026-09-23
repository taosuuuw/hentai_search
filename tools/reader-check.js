/* ==========================================================================
   reader-check.js — 在线阅读器「缩放锚点 / 任意大小拖动 / 退出时序」的可复验断言
   --------------------------------------------------------------------------
   用法（在仓库根目录）：
     node tools/reader-check.js
   说明：
     · 这三件事都是**交互时序**（指针事件、滚动量补偿、FLIP 反向动画的排序），
       没有能脱离 DOM 跑的纯函数，所以断言对象就是两份源码文本本身。
     · 它守的是用户第 7 轮报的三件事：
       ① 缩放要钉住中心线（放大后视口正中对着的那块内容不许飘走）；
       ② 任意倍率都能按住鼠标拖动图片（不是只有放大态才行）；
       ③ 退出阅读器时，放大卡片要「原地缩回小卡片」，不许先乱飘再回原位。
     · 逐条 PASS/FAIL 打印，全通过退出码 0，有失败退出码 1（与 scroll-check.js 一致）。
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./concept-check-shim');

const out = [];
const ok = (name, pass, info) => out.push({ name, pass: !!pass, info: info == null ? '' : String(info) });

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/** 从 open（'{' 的下标）开始数花括号，返回规则体（不含最外层花括号） */
function bodyFrom(src, open) {
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (!d) return src.slice(open + 1, i); }
  }
  return null;
}

function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 取 `function name(...) {...}`、`name = function (...) {...}` 或 `name = async function (...) {...}` 的函数体 */
function fnBody(src, name) {
  const n = esc(name);
  const m = new RegExp('(?:function\\s+' + n + '\\s*\\(|' + n + '\\s*=\\s*(?:async\\s+)?function\\s*\\()').exec(src);
  if (!m) return '';
  const open = src.indexOf('{', m.index);
  return open < 0 ? '' : (bodyFrom(src, open) || '');
}

/** 只保留声明（去掉注释），避免注释里提到的旧写法被当成「还在用」 */
function codeOnly(src) { return String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1'); }

function main() {
  const JS = read('assets/js/reader.js');
  const js = codeOnly(JS);
  const css = read('assets/css/style.css');

  const setZoom = codeOnly(fnBody(JS, 'setZoom'));
  const zoomBy = codeOnly(fnBody(JS, 'zoomBy'));
  const zoomKeys = codeOnly(fnBody(JS, 'zoomKeys'));
  const panStartRaw = fnBody(JS, 'panStart');
  const panStart = codeOnly(panStartRaw);
  const panMove = codeOnly(fnBody(JS, 'panMove'));
  const panEnd = codeOnly(fnBody(JS, 'panEnd'));
  const panApply = codeOnly(fnBody(JS, 'panShiftApply'));
  const panClear = codeOnly(fnBody(JS, 'clearPanShift'));
  const panPrepare = codeOnly(fnBody(JS, 'panPrepareShift'));
  const goToIndex = codeOnly(fnBody(JS, 'goToIndex'));
  const anchor = codeOnly(fnBody(JS, 'zoomAnchor'));
  const pic = codeOnly(fnBody(JS, 'picBox'));
  const anchorApply = codeOnly(fnBody(JS, 'zoomAnchorApply'));
  const residual = codeOnly(fnBody(JS, 'zoomAnchorResidual'));
  const close = codeOnly(fnBody(JS, 'RD.close'));
  const open = codeOnly(fnBody(JS, 'RD.open'));
  const restore = codeOnly(fnBody(JS, 'restorePageScroll'));
  const paintZoom = codeOnly(fnBody(JS, 'paintZoom'));
  const scrollPair = codeOnly(fnBody(JS, 'scrollPair'));
  const onScrollBody = codeOnly(fnBody(JS, 'onScroll'));

  /* -------- A. ① 缩放钉住中心线（锚点） -------- */
  ok('缩放：setZoom 里先量锚点、再改倍率（顺序反了就白补）',
    !!anchor && /const anchor = zoomAnchor\(\)/.test(setZoom) &&
    setZoom.indexOf('zoomAnchor()') < setZoom.indexOf('S.zoom = next'),
    'anchor@' + setZoom.indexOf('zoomAnchor()') + ' set@' + setZoom.indexOf('S.zoom = next'));
  ok('缩放：改完倍率（paintZoom）之后再把锚点补回来',
    setZoom.indexOf('paintZoom()') >= 0 && setZoom.indexOf('zoomAnchorApply(anchor)') > setZoom.indexOf('paintZoom()'),
    'paint@' + setZoom.indexOf('paintZoom()') + ' apply@' + setZoom.indexOf('zoomAnchorApply(anchor)'));
  ok('缩放：锚点用「真正渲染出来的画面」的分数坐标（contain 留白与滚动条都不影响）',
    /const p = picBox\(img\)/.test(anchor) &&
    /fx:\s*p\.w > 1 \? \(window\.innerWidth \/ 2 - p\.left\) \/ p\.w/.test(anchor) &&
    /fy:\s*p\.h > 1 \? \(window\.innerHeight \/ 2 - p\.top\) \/ p\.h/.test(anchor) &&
    /* 第 10 轮重做：老实现用 img 元素盒分数，而 contain 留白 + 放大后滚动条出现会让
       页盒 client 尺寸变（846→831、1265→1235），同一个分数指向的画面内容并不相同
       ⇒ 真机 100%→120% 漂 27.05px。现在用自然尺寸算 contain 后的画面矩形。 */
    /const s = Math\.min\(r\.width \/ nw, r\.height \/ nh\)/.test(pic));
  ok('缩放：补的是视口正中那个点（ty - a.cy / tx - a.cx）',
    /tx = p\.left \+ a\.fx \* p\.w/.test(anchorApply) &&
    /ty = p\.top \+ a\.fy \* p\.h/.test(anchorApply) &&
    /pair\.y\.scrollTop \+= \(ty - a\.cy\)/.test(anchorApply) &&
    /scrollLeft \+= \(tx - a\.cx\)/.test(anchorApply));
  ok('缩放（第 10 轮）：滚动补不动时用残差位移补足，并夹在「不裁画面」的范围内（有序区间 + 两遍）',
    /* 目标是**累加**的：getBoundingClientRect 已含当前 transform，不能重新赋值 */
    /let dx = panOffset\.x \+ \(a\.cx - \(p\.left \+ a\.fx \* p\.w\)\)/.test(residual) &&
    /let dy = panOffset\.y \+ \(a\.cy - \(p\.top \+ a\.fy \* p\.h\)\)/.test(residual) &&
    /const b = pg\.getBoundingClientRect\(\)/.test(residual) &&
    /* 量夹取区间前先去掉位移，且区间必须**有序**：画面比页盒大时两个 gap 都是负的，
       老实现 loY > hiY 当「空区间」归零 ⇒ 120% 的纵向残差 21.49 永远补不掉 */
    /const pl = p\.left - panOffset\.x/.test(residual) &&
    /const gx = b\.left - pl, hx = b\.right - \(pl \+ p\.w\)/.test(residual) &&
    /Math\.max\(Math\.min\(gx, hx\), Math\.min\(Math\.max\(gx, hx\), dx\)\)/.test(residual) &&
    /Math\.max\(Math\.min\(gy, hy\), Math\.min\(Math\.max\(gy, hy\), dy\)\)/.test(residual) &&
    /for \(let pass = 0; pass < 2; pass\+\+\)/.test(residual) &&
    /panOffset = \{ x: dx, y: dy \}/.test(residual) &&
    /shiftApply\(a\.img, panOffset\.x, panOffset\.y\)/.test(residual));
  ok('缩放（第 10 轮）：残差在滚动补偿之后执行（跨 100% 门槛那一步就是靠它）',
    setZoom.indexOf('zoomAnchorApply(anchor)') >= 0 &&
    setZoom.indexOf('zoomAnchorResidual(anchor)') > setZoom.indexOf('zoomAnchorApply(anchor)'),
    'apply@' + setZoom.indexOf('zoomAnchorApply(anchor)') + ' residual@' + setZoom.indexOf('zoomAnchorResidual(anchor)'));

  /* 第 11 轮：纵向连续模式（默认 dir='v'）的缩放锚点。
     症状：放大后整页跳走。真机实测（tools/reader-zoom-v1.json，headless Chrome + CDP 真鼠标）：
     100%→120% 漂 79.14px、120%→140% 漂 105.80px；同一次运行的横向只有 0.12–0.20px。
     根因：.is-cur 此前**只有横向的 paintHPage() 会写**（它开头就是 if (!isH()) return;），
     纵向 currentPageEl() 恒为 null ⇒ zoomAnchor()/zoomAnchorResidual() 一起空转 = 零补偿。
     修法：锚点页改走 anchorPageEl()（纵向按「视口正中命中的那张图」找），
     纵向禁用 transform 残差（.hs-rd-img 是 overflow:hidden，一挪就被裁一条）。 */
  const anchorPg = codeOnly(fnBody(JS, 'anchorPageEl'));
  ok('缩放（第 11 轮）：锚点页 = .is-cur，纵向退到「视口正中命中的那张图」',
    !!anchorPg && /currentPageEl\(\)/.test(anchorPg) && /if \(pg \|\| isH\(\)\) return pg;/.test(anchorPg) &&
    /cx >= r\.left && cx <= r\.right && cy >= r\.top && cy <= r\.bottom/.test(anchorPg),
    'anchorPageEl len=' + (anchorPg ? anchorPg.length : 0));
  ok('缩放（第 11 轮）：zoomAnchor / zoomAnchorResidual 都走 anchorPageEl（直接取 currentPageEl 纵向恒空）',
    /const pg = anchorPageEl\(\)/.test(anchor) && !/currentPageEl\(\)/.test(anchor) &&
    /const pg = anchorPageEl\(\)/.test(residual));
  ok('缩放（第 11 轮）：纵向不跑 transform 残差（纵向 .hs-rd-img 是 overflow:hidden，一挪就被裁）',
    /if \(!isH\(\)\) return;/.test(residual));
  ok('缩放（第 11 轮）：纵向滚动时维护 .is-cur（onScroll → markCurV），currentPageEl() 不再是死路',
    /if \(!isH\(\)\) markCurV\(idx\)/.test(onScrollBody) && /function markCurV\(/.test(js));

  ok('缩放：锚点补偿重新解一次容器（z=1 常没滚动余量，放大后才有）',
    /const pair = scrollPair\(\)/.test(anchorApply));
  ok('缩放：容器解析走 scrollPair()，两个轴一个来源（第 8 轮 item 4：左右翻页模式放缩不再位移）',
    /const pg = currentPageEl\(\)/.test(scrollPair) &&
    /if \(isH\(\)\) return \{ x: pg, y: pg \};/.test(scrollPair) &&
    /* h 模式下 .hs-rd-scroll / .hs-rd-col 都是 overflow:hidden（零余量），
       纵轴若还交给 vBoxFor() 就是写给一个根本不滚的元素 = 空操作 */
    !/vBoxFor\(\)/.test(anchorApply) &&
    /scrollPair\(\)/.test(anchorApply),
    'h 模式两轴都取页盒');
  ok('缩放：全文只有 paintZoom 一处写 --hs-rd-zoom（按钮 / Ctrl 键 / zoomBy 都必经锚点）',
    (js.match(/setProperty\('--hs-rd-zoom'/g) || []).length === 1 &&
    /setProperty\('--hs-rd-zoom'/.test(paintZoom),
    'writes=' + (js.match(/setProperty\('--hs-rd-zoom'/g) || []).length);
  ok('缩放：zoomBy 与 Ctrl 键都经由 setZoom（没有旁路直接改 S.zoom）',
    /setZoom\(/.test(zoomBy) && (zoomKeys.match(/setZoom\(/g) || []).length === 3 &&
    (zoomKeys.match(/S\.zoom\s*=/g) || []).length === 0);
  /* 第 11 轮（2026-09-23 真机取证）口径反转：换倍率**必须保住**拖拽位移。
     老口径「换倍率顺手清掉位移」在 100% 时是错的 —— 那时页盒两轴余量都是 0，拖动只能走
     <img> 的 transform 档；位移一清，画面弹回正中（实测 5 种形状全部漂 47.7~49.6px）。
     复位动作只留给「换页 goToIndex」和「重新打开 RD.open」。 */
  ok('缩放：换倍率**不再**清拖拽位移（清了就把用户拖到的地方弹回正中）',
    !/clearPanShift\(\)/.test(paintZoom));
  ok('拖动（第 9 / 11 轮）：复位只发生在换页 / 重新打开（paintZoom 不再代劳）',
    /clearPanShift\(\)/.test(goToIndex) && /clearPanShift\(\)/.test(open));

  /* -------- B. ① 任意倍率按住拖动 -------- */
  ok('拖动：panStart 不再要求放大态（老实现挂 S.zoom > 1，用户报「100% 拖不动」）',
    !!panStart && !/S\.zoom/.test(panStart) && !/is-zoom/.test(panStart) &&
    /按住拖动不再要求已放大/.test(panStartRaw));
  ok('拖动：panStart 末尾决定这一轮走「滚」还是走「临时位移」',
    /panPrepareShift\(e\)/.test(panStart) && /imgAtPoint/.test(panPrepare));
  ok('拖动：整屏装得下的判据 = 两个轴都没有滚动余量（一个轴装不下仍走老语义，不会斜着一拖整页横飘）',
    /pan\.sx = roomOf\(pan\.xBox, 'x'\) > 2/.test(panPrepare) &&
    /pan\.sy = roomOf\(pan\.yBox, 'y'\) > 2/.test(panPrepare) &&
    /pan\.shift = !pan\.sx && !pan\.sy/.test(panPrepare));
  /* -------- 第 8 轮 item 1：拖拽方向 + 放大后纵向能拖 -------- */
  ok('拖动：两个轴都由 panPrepareShift() 从 scrollPair() 解析（pan.yBox 不再是 undefined）',
    /const pair = scrollPair\(\)/.test(panPrepare) &&
    /pan\.xBox = pair\.x; pan\.yBox = pair\.y;/.test(panPrepare) &&
    /* 老代码 h 分支的 pan 对象里没有 yBox，放大后 pan.sy 为真 ⇒ pan.yBox.scrollTop 抛 TypeError
       = 用户报的「放大后无法上下拖拽」；现在 panStart 只记指针起点，盒子一律由这里给。 */
    !/kind: 'h', box: box/.test(panStart) &&
    !/pan\.kind === 'h'/.test(panMove));
  ok('拖动：起点读数与解析出来的盒子对齐（pan.l / pan.t 取自 xBox / yBox，不是另一个元素上的旧值）',
    /pan\.l = pan\.xBox \? pan\.xBox\.scrollLeft : 0/.test(panPrepare) &&
    /pan\.t = pan\.yBox \? pan\.yBox\.scrollTop : 0/.test(panPrepare));
  ok('拖动：滚动那一档 null 安全（命中盒才写，不再有 el.pages 旁路）',
    /if \(pan\.sx && pan\.xBox\) pan\.xBox\.scrollLeft = pan\.l - dx;/.test(panMove) &&
    /if \(pan\.sy && pan\.yBox\) pan\.yBox\.scrollTop = pan\.t - dy;/.test(panMove));
  /* -------- 第 9 轮 item 2：拖动位移必须**保留**（不再弹回） -------- */
  ok('拖动（第 9 轮）：位移档与滚动手感同号（+dx / +dy），且以累积位移为起点',
    /pan\.px = softPan\(pan\.baseX \+ dx, lim\)/.test(panMove) &&
    /pan\.py = softPan\(pan\.baseY \+ dy, lim\)/.test(panMove) &&
    !/softPan\(-dx/.test(panMove) && !/softPan\(-dy/.test(panMove));
  ok('拖动（第 9 轮）：按下时把已有位移当起点（pan.baseX/baseY = panOffset）',
    /pan\.baseX = panOffset\.x;/.test(panPrepare) && /pan\.baseY = panOffset\.y;/.test(panPrepare) &&
    /* 老代码在这里 clearPanShift()：每次按下都从 0 重来 = 拖一下弹一下 */
    !/clearPanShift\(\);\s*\/\* 顺手清掉/.test(panPrepare));
  ok('拖动（第 9 轮）：抬手**保留**位移（写回 panOffset），且仍发生在 pan = null 之前',
    /panOffset = \{ x: pan\.px \|\| 0, y: pan\.py \|\| 0 \};/.test(panEnd) &&
    panEnd.indexOf('panOffset =') < panEnd.indexOf('pan = null'));
  ok('拖动（第 9 轮）：弹回机制已彻底删除（全文不再有 panShiftSpring / PAN_SHIFT_MS）',
    !/panShiftSpring/.test(js) && !/PAN_SHIFT_MS/.test(js));
  ok('拖动（第 9 轮）：复位动作本身仍在（clearPanShift 归零 panOffset + 清 transform）',
    /panOffset = \{ x: 0, y: 0 \};/.test(panClear) &&
    /clearPanShift\(\)/.test(goToIndex) && /clearPanShift\(\)/.test(open));
  ok('拖动（第 9 轮）：位移目标既可能是 <img> 也可能是禁漫的 <canvas> / 盒子本身，三样都清',
    /\.hs-rd-img img, \.hs-rd-img canvas, \.hs-rd-img/.test(panClear));
  ok('拖动：临时位移只落在图片自己身上（pan.obj = imgAtPoint 命中的那张图 / 盒子）',
    /pan\.obj = imgAtPoint\(e\.clientX, e\.clientY\)/.test(panPrepare) &&
    /if \(!pan\.obj\) \{ pan\.shift = false; return; \}/.test(panPrepare) &&
    /pan\.obj\.style\.transform/.test(panApply));
  ok('拖动：写 translate3d 的只有三处（拖动中 / 抬手定稿 / 第 10 轮缩放残差），都落在图片对象上',
    (js.match(/style\.transform = 'translate3d/g) || []).length === 3 &&
    /function shiftApply\(obj, x, y\)/.test(js) &&
    /obj\.style\.transform = 'translate3d/.test(js),
    'writes=' + (js.match(/style\.transform = 'translate3d/g) || []).length);
  ok('拖动：位移不碰页盒（currentIndex 量的是 .hs-rd-pg 的 rect，动了页盒会破坏翻页判定）',
    /list\[i\]\.getBoundingClientRect\(\)\.top/.test(js) &&
    !/\.hs-rd-pg[^\n]{0,80}style\.transform/.test(js));
  ok('拖动：橡皮筋软限位仍在（超过 limit 后增长收敛到 1.6 倍，拖不飞）',
    /limit \* \(1 \+ 0\.6 \* \(1 - Math\.exp\(-\(a - limit\) \/ Math\.max\(1, limit\)\)\)\)/.test(js) &&
    /* 第 9 轮把范围从 ~154px 放宽到 ~384px：位移是保留的，范围太小等于「只能抖一下」 */
    /Math\.max\(120, Math\.min\(420, \(window\.innerWidth \|\| 800\) \* 0\.30\)\)/.test(js));
  ok('拖动 CSS：cursor: grab / grabbing 与 -webkit-user-drag 不再门控 .is-zoom（任意倍率可拖）',
    /\.hs-rd \.hs-rd-img \{ cursor: grab; \}/.test(css) &&
    /\.hs-rd \.hs-rd-img:active \{ cursor: grabbing; \}/.test(css) &&
    /\.hs-rd \.hs-rd-img img \{ -webkit-user-drag: none; user-select: none; \}/.test(css) &&
    !/\.hs-rd\.is-zoom \.hs-rd-img[^\n]*cursor/.test(css));
  ok('拖动 CSS：touch-action: none 仍然只在 .is-zoom 下（触屏 100% 还要能原生滚动翻页）',
    /\.hs-rd\.is-zoom \.hs-rd-col,\s*\.hs-rd\.is-zoom\[data-dir="h"\] \.hs-rd-pg \{ touch-action: none; \}/.test(css) &&
    !/\.hs-rd \.hs-rd-img \{ touch-action: none/.test(css));
  /* -------- 第 9 轮 item 1：≤100% 时图片盒子必须钉在页盒正中 -------- */
  ok('缩放 CSS（第 9 轮 item 1）：非放大态把图片盒子补到页盒正中（缩小时不再贴着左上角跑）',
    /\.hs-rd\[data-dir="h"\]:not\(\.is-zoom\) \.hs-rd-img \{[\s\S]{0,220}?position: relative;[\s\S]{0,200}?left: calc\(\(100% - 100% \* var\(--hs-rd-zoom, 1\)\) \/ 2\);[\s\S]{0,120}?top: calc\(\(100% - 100% \* var\(--hs-rd-zoom, 1\)\) \/ 2\);/.test(css));
  ok('缩放 CSS（第 9 轮 item 1）：居中规则不会碰到放大态（放大时盒子更大，位移会额外撑出可滚区间）',
    (() => {
      const m = /\.hs-rd\[data-dir="h"\] \.hs-rd-img \{([\s\S]*?)\n\}/.exec(css);
      return !!m && !/left: calc\(\(100%/.test(m[1]) && /position: relative/.test(m[1]) === false;
    })());

  /* -------- C2. 横图放大跳位（2026-09-23 真机取证修掉的那个） --------
     事故原貌：横图 1600×900 在 h 模式 100%→120% 时图片跳 13.51px，
     而竖图只有 0.19px、方图 0.20px —— **只有横图中招**。
     根因不在夹取公式，在**分工**：zoomAnchorApply() 的滚动补偿其实已经落准
     （真机实测锚点离正中 0.29px），紧接着 zoomAnchorResidual() 第一遍量到
     「画面自然位置在页盒上沿之上 13.76px」，而夹取区间 [13.76, 19.10] **不含 0**
     （两端同号），于是把 13.76px 的位移写到 <img> 的 transform 上，
     把已经对齐的画面硬推下去 —— 用户看到的「放大后图片位置会变」。
     修法：残差先问「这一轴滚动还有没有余量」，有余量就整轴不动（交给滚动）。
     断言守三件事：① 余量记回锚点；② residual 逐轴判余量；③ 有余量时整轴跳过。 */
  ok('缩放（2026-09-23）：zoomAnchorApply 把两轴滚动余量记回锚点（roomX / roomY）',
    /a\.roomX = pair\.x \? Math\.max\(0, pair\.x\.scrollWidth - pair\.x\.clientWidth\) : 0;/.test(anchorApply) &&
    /a\.roomY = pair\.y \? Math\.max\(0, pair\.y\.scrollHeight - pair\.y\.clientHeight\) : 0;/.test(anchorApply),
    'zoomAnchorApply 里找 roomX / roomY 的写入');
  ok('缩放（2026-09-23）：残差逐轴判余量 —— 有余量的轴不再插一脚（横图 13.51px 跳位就是这么来的）',
    /const allowX = !\(a\.roomX > 1\);/.test(residual) && /const allowY = !\(a\.roomY > 1\);/.test(residual));
  ok('缩放（2026-09-23）：两轴都有滚动余量时残差整段跳过（不许再动已对齐的画面）',
    /if \(!allowX && !allowY\) return;/.test(residual));
  ok('缩放（2026-09-23）：被禁的那一轴保持 panOffset 原值（不是归零、也不是夹到边界）',
    /if \(!allowX\) dx = panOffset\.x;/.test(residual) &&
    /if \(!allowY\) dy = panOffset\.y;/.test(residual));
  /* ★第 11 轮补修★：夹取只在「画面此刻确实盖住页盒」时才成立。
     画面比页盒小的那一轴（≤100% 的留白轴）本来就没有「盖住」可言，硬夹会把位移拉回 0 ——
     实测 100% 拖 (130,95) → 300% → 缩回 100%，竖图漂 45.18px、横图漂 105.76px。 */
  ok('缩放（第 11 轮）：夹取前先判「这一轴盖住页盒了吗」，盖不住就不夹（拖到哪就留在哪）',
    /const coverX = p\.left <= b\.left \+ 0\.5 && p\.left \+ p\.w >= b\.right - 0\.5;/.test(residual) &&
    /const coverY = p\.top <= b\.top \+ 0\.5 && p\.top \+ p\.h >= b\.bottom - 0\.5;/.test(residual) &&
    /else if \(coverX\) dx = Math\.max\(Math\.min\(gx, hx\), Math\.min\(Math\.max\(gx, hx\), dx\)\);/.test(residual) &&
    /else if \(coverY\) dy = Math\.max\(Math\.min\(gy, hy\), Math\.min\(Math\.max\(gy, hy\), dy\)\);/.test(residual));
  /* ★自证★：把事故里的那组真实数字（缺省残差 dy=0.29，自然位置超出页盒上沿 13.76）
     喂给「逐轴判余量」的判据，横图那一档必须落进「滚动接管、残差不介入」，
     而 ≤100% 那一档（两轴零余量）必须仍然允许残差介入 —— 否则修法就把原本该补的档也一起废了。 */
  ok('缩放（2026-09-23）：判据自证 —— 横图 120%（x 有余量/y 无）只放 y，≤100%（两轴零余量）两轴都放',
    (() => {
      const gate = (roomX, roomY) => ({ allowX: !(roomX > 1), allowY: !(roomY > 1) });
      const landscape120 = gate(253, 166);   /* 真机实测横图 120% 的页盒余量 */
      const fitAt100 = gate(0, 0);           /* ≤100% 两轴都滚不动 */
      const portrait120 = gate(0, 0);        /* 真机实测竖图 120% 页盒两轴余量也是 0 */
      return landscape120.allowX === false && landscape120.allowY === false &&
        fitAt100.allowX === true && fitAt100.allowY === true &&
        portrait120.allowX === true && portrait120.allowY === true;
    })());

  /* -------- C3. 禁漫 canvas 页（2026-09-23 第 12 轮）--------
     用户报的「禁漫左右翻页放大后图片向右位移」和「任意比例都拖不动图」是同一个根因：
     禁漫页在 DOM 里是「display:none 的原 <img> + 还原出来的 <canvas>」两件套，
     而 picBox / zoomAnchor / anchorPageEl / zoomAnchorResidual / imgAtPoint 一律按
     `.hs-rd-img img` 取元素 ⇒ 拿到的是那个隐藏元素（getBoundingClientRect 全 0）
     ⇒ 锚点分数退化成 0.5/0.5、滚动补偿算成 scrollLeft += (0 - 视口中心)（夹回 0）、
     残差又因 p.w < 1 直接 return = **零补偿**（放大后内容向右长出）；同一根因让命中测试
     把 transform 写到 display:none 的元素上 = 100% / 缩小态按住拖不动。
     修法：新增 natSize()（canvas 认位图尺寸 width/height）+ pageVisual()
     （canvas → 可见 img → 页盒，取第一个有真实矩形的），五处调用点全部改用它。 */
  const natSize = codeOnly(fnBody(JS, 'natSize'));
  const pageVisual = codeOnly(fnBody(JS, 'pageVisual'));
  const picBoxFn = codeOnly(fnBody(JS, 'picBox'));
  const zoomAnchorFn = codeOnly(fnBody(JS, 'zoomAnchor'));
  const anchorPageElFn = codeOnly(fnBody(JS, 'anchorPageEl'));
  const imgAtPointFn = codeOnly(fnBody(JS, 'imgAtPoint'));
  ok('禁漫 canvas（第 12 轮）：natSize 认 canvas 的位图尺寸（不再只认 naturalWidth）',
    !!natSize && /== 'canvas'/.test(natSize) && /node\.width \|\| 0/.test(natSize) &&
    /node\.height \|\| 0/.test(natSize) && /naturalWidth/.test(natSize));
  ok('禁漫 canvas（第 12 轮）：pageVisual 按 canvas → img → 页盒 挑第一个有真实矩形(≥1px)的元素',
    !!pageVisual && /\.hs-rd-img canvas/.test(pageVisual) && /\.hs-rd-img img/.test(pageVisual) &&
    /r\.width >= 1 && r\.height >= 1/.test(pageVisual) &&
    pageVisual.indexOf('.hs-rd-img canvas') < pageVisual.indexOf('.hs-rd-img img'));
  ok('禁漫 canvas（第 12 轮）：picBox 改走 natSize（否则 canvas 页算不出 object-fit:contain 后的画面矩形）',
    !!picBoxFn && /const n = natSize\(img\);/.test(picBoxFn) &&
    /const nw = n\.w, nh = n\.h;/.test(picBoxFn) && !/img\.naturalWidth/.test(picBoxFn));
  ok('禁漫 canvas（第 12 轮）：缩放锚点 / 命中测试四处全部改用 pageVisual（不再直接拿隐藏的 img）',
    /const img = pageVisual\(pg\);/.test(zoomAnchorFn) &&
    /const im = pageVisual\(list\[i\]\)/.test(anchorPageElFn) &&
    /const ob = pageVisual\(list\[i\]\)/.test(imgAtPointFn) &&
    /return pageVisual\(currentPageEl\(\)\);/.test(imgAtPointFn));
  ok('禁漫 canvas（第 12 轮）：这四处不再残留旧的 `.hs-rd-img img || u.$(\'img\'…)` 取值链',
    !/\.hs-rd-img img', pg\) \|\|/.test(zoomAnchorFn + anchorPageElFn + imgAtPointFn) &&
    !/\.hs-rd-img img', list\[i\]\) \|\|/.test(anchorPageElFn));

  /* -------- C. ③ 退出阅读器 = 原地缩回小卡片 -------- */
  ok('退出：restorePageScroll 支持 force（那一刻 open 还是 true，必须显式要求复位）',
    !!restore && /function restorePageScroll\(force\)/.test(JS) &&
    /const live = \(\) => \(force === true \|\| !open\)/.test(restore) &&
    (restore.match(/live\(\)/g) || []).length >= 2);
  ok('退出：RD.close 先复位页面滚动、再让 closeCard() 量矩形（时序就是根因）',
    !!close &&
    close.indexOf('restorePageScroll(true)') >= 0 &&
    close.indexOf('restorePageScroll(true)') < close.indexOf('closeCard()'),
    'restore@' + close.indexOf('restorePageScroll(true)') + ' closeCard@' + close.indexOf('closeCard()'));
  ok('退出：两行解锁 class 同样在 closeCard() 之前（否则页面滚动还被夹在 0）',
    close.indexOf("classList.remove('hs-rd-open')") >= 0 &&
    close.indexOf("document.body.classList.remove('hs-rd-open')") < close.indexOf('closeCard()') &&
    close.indexOf("document.documentElement.classList.remove('hs-rd-open')") < close.indexOf('closeCard()'));
  ok('退出：解锁 / 复位三步被 if (wasOpen) 包住（没开阅读器时不该动页面滚动）',
    /const wasOpen = !!open;[\s\S]{0,80}?if \(wasOpen\) \{[\s\S]{0,400}?restorePageScroll\(true\)/.test(close));
  ok('退出：closeCard() 仍然无条件调用（阅读器没开也要把放大卡片收掉）',
    /if \(wasOpen\) \{[\s\S]{0,400}?\}\s*try \{ if \(HS\.results && HS\.results\.closeCard\)/.test(close));
  ok('退出：全文不再有无参 restorePageScroll()（尾部那次已挪到开头）',
    !/restorePageScroll\(\s*\)/.test(js));
  ok('退出：尾部在 clearPages() 之后不再补一次复位（避免把刚稳住的滚动又顶走）',
    !/clearPages\(\);[\s\S]{0,400}?restorePageScroll/.test(close) && /clearPanShift\(\);/.test(close));

  console.log('\n================ 断言结果 ================');
  let fail = 0;
  out.forEach(r => {
    if (!r.pass) fail++;
    console.log((r.pass ? '  PASS  ' : '  FAIL  ') + r.name + (r.info ? '\n          ' + r.info : ''));
  });
  console.log('------------------------------------------');
  console.log(fail ? (fail + ' 条断言失败') : ('全部 ' + out.length + ' 条断言通过'));
  process.exit(fail ? 1 : 0);
}

if (require.main === module) main();
module.exports = { main };
