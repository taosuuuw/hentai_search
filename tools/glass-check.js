/* ==========================================================================
   glass-check.js — 「iOS 液态玻璃」材质改版的可复验断言（零依赖，纯静态）
   --------------------------------------------------------------------------
   用法（在仓库根目录）：
     node tools/glass-check.js
   说明：
     · 这次改的是纯 CSS（材质令牌 + 一条共用材质规则 + 黑话泡泡换材质），没有可跑的
       纯函数，所以断言对象就是 assets/css/style.css 的源码文本本身。
     · 它守的是这几件事：
       ① 「材质只定义一次」——搜索框与黑话泡泡必须在同一条规则里共用材质，任何一边
          再自己抄一份 background/box-shadow/backdrop-filter 都会被抓住；
       ② 令牌齐全 —— 深色 :root 与 html[data-theme="light"] 两套都必须有全套材质令牌
          （少一个，var() 解析失败会让整条 background-image 变 none，玻璃直接消失）；
       ③ 几何与既有契约没被顺手改掉 —— 搜索框仍然不设 height、padding/border-radius
          原值、键盘焦点描边契约还在；
       ④ 级联顺序 —— 共用材质规则必须在泡泡/焦点这些「覆盖规则」之前，否则覆盖失效；
       ⑤ 第 6 轮三件事 —— 鼠标点进不再提亮整条框（放大镜与光标也不再用品牌粉）、
          搜索按钮是同材质染色玻璃（盒模型零变化、高/暗光逻辑原样）、搜索框上沿跟着
          上面那条细线一起微光（同令牌、同时长、落点在搜索框上沿，减动效两处都停）。
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

/** 找出所有「选择器正好是 sel、后面紧跟 {」的规则，返回 [{at, body}]（按出现顺序） */
function rules(src, sel) {
  const res = [];
  let i = 0;
  for (;;) {
    const at = src.indexOf(sel, i);
    if (at < 0) break;
    const m = /^\s*\{/.exec(src.slice(at + sel.length));
    if (m) res.push({ at, body: bodyFrom(src, at + sel.length + m[0].length - 1) });
    i = at + sel.length;
  }
  return res;
}

/** 只保留声明（去掉注释），避免注释里提到的旧写法被当成「还在用」 */
function codeOnly(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function main() {
  const css = read('assets/css/style.css');
  const code = codeOnly(css);

  /* ------------------------------ A. 装载 ------------------------------ */
  ok('装载：读到 assets/css/style.css（>100K 字符）', css.length > 100000, 'len=' + css.length);

  /* --------------------- B. 一条共用材质规则（核心） --------------------- */
  const sharedRe = /\.hs-searchbar,\s*\.hs-searchbar > \.hs-slang-bubble\s*\{/;
  const sm = sharedRe.exec(css);
  const sharedAt = sm ? sm.index : -1;
  const shared = sm ? bodyFrom(css, sm.index + sm[0].length - 1) : null;
  ok('共用：搜索框与黑话泡泡写在【同一条】材质规则的选择器列表里',
    !!shared, sm ? '' : '没找到 `.hs-searchbar, .hs-searchbar > .hs-slang-bubble {`');
  const S = shared || '';

  ok('共用：透光底 background-color: var(--glass-fill)',
    /background-color:\s*var\(--glass-fill\)/.test(S));
  ok('共用：background-image 三层（tint 层 + 环境折射 + 顶面渐变）',
    /background-image:/.test(S) &&
    /linear-gradient\(var\(--glass-tint\),\s*var\(--glass-tint\)\)/.test(S) &&
    /var\(--glass-refract\)/.test(S) &&
    /linear-gradient\(180deg,\s*var\(--glass-top\)/.test(S));
  ok('共用：光学边缘 border: 1px solid var(--glass-rim)',
    /border:\s*1px solid var\(--glass-rim\)/.test(S));
  ok('共用：inset 镜面边光 + 底部反光 + 内部雾气 + 厚投影',
    /inset 0 1px 0 var\(--glass-inner\)/.test(S) &&
    /inset 0 -1px 0 var\(--glass-edge-bot\)/.test(S) &&
    /inset 0 0 22px var\(--glass-bloom\)/.test(S) &&
    /var\(--glass-drop\)/.test(S));
  ok('共用：背景磨砂 backdrop-filter（含 -webkit- 前缀）都用 var(--glass-blur)',
    /-webkit-backdrop-filter:\s*var\(--glass-blur\)/.test(S) &&
    /[^-]backdrop-filter:\s*var\(--glass-blur\)/.test(S));
  ok('共用：规则里给了 --glass-tint 兜底值（否则整条 background-image 会失效）',
    /--glass-tint:\s*transparent\s*;/.test(S));
  ok('共用：材质规则不碰几何与动效（无 height / padding / transition / animation）',
    !/(^|[\s;{])height\s*:/.test(S) && !/(^|[\s;{])padding\s*:/.test(S) &&
    !/transition\s*:/.test(S) && !/animation\s*:/.test(S));

  /* ------------------------------ C. 令牌 ------------------------------ */
  const rootBlocks = rules(css, ':root');
  const lightBlocks = rules(css, 'html[data-theme="light"]');
  const dark = rootBlocks[0] ? rootBlocks[0].body : '';
  const light = lightBlocks[0] ? lightBlocks[0].body : '';
  ok('令牌：找到 :root（深色）与 html[data-theme="light"]（浅色）两个令牌块',
    !!dark && !!light, 'dark=' + blkLen(dark) + ' light=' + blkLen(light));

  const NEED = ['--glass-fill', '--glass-fill-hi', '--glass-float', '--glass-rim', '--glass-inner',
    '--glass-edge-bot', '--glass-bloom', '--glass-top', '--glass-blur', '--glass-tint', '--glass-refract',
    '--glass-shade'];
  const missD = NEED.filter(k => !new RegExp(esc(k) + '\\s*:').test(dark));
  const missL = NEED.filter(k => !new RegExp(esc(k) + '\\s*:').test(light));
  ok('令牌：深色与浅色两套都定义了全套材质令牌（' + NEED.length + ' 个）',
    !missD.length && !missL.length,
    (missD.length ? '深色缺 ' + missD.join(',') + ' ' : '') + (missL.length ? '浅色缺 ' + missL.join(',') : ''));

  ok('令牌：--glass-refract 确实接了主题色（accent 粉 + accent-2 紫）',
    /color-mix\(in srgb, var\(--accent\)/.test(dark) && /var\(--accent-2\)/.test(dark) &&
    /var\(--accent-2\)/.test(light));

  ok('令牌：--glass-blur 同时带 blur 与 saturate（磨砂 + 提饱和）',
    /blur\(\d+px\)/.test(dark) && /saturate\(/.test(dark) &&
    /blur\(\d+px\)/.test(light) && /saturate\(/.test(light));

  /* ------------------ D. 几何 / 既有契约（不许顺手改） ------------------ */
  ok('回归：第 2 轮「压到看不见」的深色 --glass-fill(.028) 已不再使用',
    !/--glass-fill:\s*rgba\(255,255,255,\.028\)/.test(code));
  ok('回归：浅色 --glass-fill 已从 .40 抬高（更实的白面）',
    !/--glass-fill:\s*rgba\(255,255,255,\.40\)/.test(code));

  const bar = rules(css, '.hs-searchbar');
  ok('几何：`.hs-searchbar` 本体规则正好一条（材质已挪进共用规则）',
    bar.length === 1, 'got ' + bar.length);
  const B = bar[0] ? codeOnly(bar[0].body) : '';
  ok('几何：搜索框不设 height（高度归内容 + filters.js 算的 padding）',
    !/(^|[\s;{])height\s*:/.test(B));
  ok('几何：搜索框 padding 仍是 8px 8px 8px 14px',
    /padding:\s*8px 8px 8px 14px\s*;/.test(B));
  ok('几何：搜索框 border-radius 仍是 999px',
    /border-radius:\s*999px\s*;/.test(B));
  ok('几何：搜索框本体不再自己写材质（background/border/box-shadow/backdrop-filter）',
    !/background(-color|-image)?\s*:/.test(B) && !/(^|[\s;{])border\s*:/.test(B) &&
    !/box-shadow\s*:/.test(B) && !/backdrop-filter\s*:/.test(B));

  const bubbleRules = rules(css, '.hs-searchbar > .hs-slang-bubble');
  ok('级联：泡泡有两条同名规则（共用材质在前、表现覆盖在后）',
    bubbleRules.length === 2, 'got ' + bubbleRules.length);
  const swapAt = bubbleRules[1] ? bubbleRules[1].at : -1;
  const kb = rules(css, 'html.hs-kb .hs-searchbar:focus-within');
  const kbAt = kb[0] ? kb[0].at : -1;
  ok('级联：共用材质规则排在泡泡覆盖规则与键盘焦点规则【之前】',
    sharedAt >= 0 && swapAt > sharedAt && kbAt > sharedAt,
    'shared@' + sharedAt + ' bubble@' + swapAt + ' kb@' + kbAt);
  ok('契约：键盘焦点仍画 accent 描边（鼠标点击不高光，见 style.css 里那段注释）',
    kb[0] ? /border-color:\s*color-mix\(in srgb, var\(--accent\)/.test(kb[0].body) : false);

  /* ------------------------------ E. 泡泡 ------------------------------ */
  const bub = bubbleRules[1] ? codeOnly(bubbleRules[1].body) : '';
  ok('泡泡：底色换成更实的 --glass-float（浮在搜索条之上的小玻璃）',
    /--glass-fill:\s*var\(--glass-float\)/.test(bub));
  ok('泡泡：自带一层 accent 取色（--glass-tint），且磨砂半径单独调小',
    /--glass-tint:\s*color-mix\(in srgb, var\(--accent\)/.test(bub) &&
    /--glass-blur:\s*blur\(\d+px\)/.test(bub));
  ok('泡泡：不再自己写材质（background-color / box-shadow / backdrop-filter）',
    !/background-color\s*:/.test(bub) && !/box-shadow\s*:/.test(bub) && !/backdrop-filter\s*:/.test(bub));
  ok('泡泡：accent 描边直接写 border-color（不去改 --glass-rim，避免自定义属性成环）',
    /border-color:\s*color-mix\(in srgb, var\(--accent\)/.test(bub));

  const tail = rules(css, '.hs-slang-bubble[data-flip="0"]::before');
  const T = tail[0] ? codeOnly(tail[0].body) : '';
  ok('尾巴：不再 background: inherit（会把渐变/折射层一起继承而对不齐）',
    !!tail.length && !/background:\s*inherit/.test(T));
  ok('尾巴：改用「同一层 tint + 同一个底色」，跟着泡泡的令牌自动同步',
    /background-color:\s*var\(--glass-fill\)/.test(T) &&
    /background-image:\s*linear-gradient\(var\(--glass-tint\),\s*var\(--glass-tint\)\)/.test(T));
  ok('回归：泡泡旧配方 color-mix(panel-2 88%, accent) 已彻底消失',
    !/color-mix\(in srgb, var\(--panel-2\) 88%, var\(--accent\)\)/.test(code));

  /* -------- G. 第 6 轮 ①：鼠标点进搜索框不再提亮整条框 -------- */
  ok('去高光：`.hs-searchbar:focus-within` 本体规则已删（只剩 html.hs-kb 那条键盘规则）',
    !/(^|\n)\s*\.hs-searchbar:focus-within\s*[,{]/.test(code));
  ok('去高光：`.hs-searchbar:focus-within::after`（把斜向高光推到 opacity:1）已删',
    !/\.hs-searchbar:focus-within::after/.test(code));
  ok('去高光：放大镜图标不再随焦点转 accent（`:focus-within .hs-sb-ico` 已删，保持 --fg-3）',
    !/\.hs-searchbar:focus-within \.hs-sb-ico/.test(code) &&
    /\.hs-sb-ico\s*\{[\s\S]{0,160}?background:\s*var\(--fg-3\)/.test(code));
  ok('去高光：光标不再用品牌粉，改为跟随系统（AccentColor + 系统默认双写回落）',
    !/caret-color:\s*var\(--accent\)/.test(code) &&
    /caret-color:\s*auto\s*;/.test(code) && /caret-color:\s*AccentColor\s*;/.test(code));
  ok('去高光：`#q:focus-visible` 仍是 box-shadow:none（点击输入框外圈不会再亮）',
    /#q:focus-visible\s*\{\s*box-shadow:\s*none\s*;\s*\}/.test(code));

  /* -------- H. 第 6 轮 ②：搜索按钮换同材质玻璃 -------- */
  const goRules = rules(css, '.hs-sb-go');
  const GO = goRules[0] ? codeOnly(goRules[0].body) : '';
  ok('按钮：`.hs-sb-go` 本体规则正好一条', goRules.length === 1, 'got ' + goRules.length);
  ok('按钮：不再用不透明的 background: var(--grad)（改染色玻璃）',
    !!GO && !/background\s*:\s*var\(--grad\)/.test(GO));
  ok('按钮：品牌配色与方向保留（accent 底 + accent 0% → accent-2 100% 的 135deg 渐变）',
    /background-color:\s*color-mix\(in srgb, var\(--accent\) \d+%, transparent\)/.test(GO) &&
    /color-mix\(in srgb, var\(--accent\) \d+%, transparent\) 0%/.test(GO) &&
    /color-mix\(in srgb, var\(--accent-2\) \d+%, transparent\) 100%/.test(GO));
  ok('按钮：磨砂改用共用令牌 var(--glass-blur)（与搜索框同材质）',
    /[^-]backdrop-filter:\s*var\(--glass-blur\)/.test(GO));
  ok('按钮：光学边缘走 inset 0 0 0 1px，不加真 border（盒模型不长 2px）',
    /inset 0 0 0 1px/.test(GO) && !/(^|[\s;{])border\s*:/.test(GO));
  ok('按钮：高/暗光逻辑原样保留（顶部内高光 + 底部内暗边 + 主题色外发光）',
    /inset 0 1px 0 rgba\(255,255,255,\.52\)/.test(GO) &&
    /inset 0 -1px 0 rgba\(0,0,0,\.22\)/.test(GO) &&
    /0 10px 24px -12px rgba\(255,77,141,\.85\)/.test(GO));
  ok('按钮：几何与交互一字未改（padding / radius / hover / active / disabled / busy 扫光 / 斜向折射）',
    /padding:\s*10px 24px\s*;/.test(GO) && /border-radius:\s*999px\s*;/.test(GO) &&
    /\.hs-sb-go:hover\s*\{\s*transform:\s*translateY\(-1px\);\s*filter:\s*brightness\(1\.07\)/.test(code) &&
    /\.hs-sb-go:active\s*\{\s*transform:\s*translateY\(0\)/.test(code) &&
    /\.hs-sb-go\[disabled\]\s*\{\s*opacity:\s*\.6;\s*cursor:\s*progress/.test(code) &&
    /\.hs-sb-go\[data-busy="1"\] \.hs-sb-ring\s*\{\s*display:\s*block/.test(code) &&
    /\.hs-sb-go::after\s*\{[\s\S]{0,160}?linear-gradient\(102deg/.test(code));

  /* -------- I. 第 6 轮 ③：搜索框上沿跟着上面细线一起微光 -------- */
  const seamRules = rules(css, '.hs-searchbar::before');
  const SE = seamRules[0] ? codeOnly(seamRules[0].body) : '';
  ok('微光：补面规则改成 background-color（background 简写会整条抹掉微光层）',
    !!seamRules.length && /background-color:\s*var\(--glass-seam\)/.test(SE) &&
    !/(^|[\s;{])background\s*:/.test(SE));
  ok('微光：上沿多了一层 96px 宽的 --glass-line-glow 光带',
    /var\(--glass-line-glow\)/.test(SE) && /background-size:\s*96px 100%\s*;/.test(SE) &&
    /background-repeat:\s*no-repeat\s*;/.test(SE));
  ok('微光：与细线同相位（同令牌 + 同 3.6s ease-in-out infinite）',
    /animation:\s*hs-seam-glow 3\.6s ease-in-out infinite/.test(SE) &&
    /animation:\s*hs-line-glow 3\.6s ease-in-out infinite/.test(code));
  ok('微光：光带落点在补面底边（100% = 搜索框上沿）',
    /background-position:\s*-96px 100%\s*;/.test(SE));
  ok('微光：hs-seam-glow 只动 background-position、不动 opacity（否则补面会把 8px 缝闪出来）',
    (() => {
      const k = /@keyframes hs-seam-glow\s*\{([\s\S]*?)\n\}/.exec(code);
      return !!k && /background-position/.test(k[1]) && !/opacity/.test(k[1]);
    })());
  ok('微光：拖拽 / 拉出提亮改用 background-color（不再用简写抹掉微光层）',
    /\.hs-searchwrap\[data-dragging="1"\] \.hs-searchbar::before\s*\{\s*background-color:/.test(code) &&
    /\.hs-searchwrap:has\(\.hs-sheet\[data-open="1"\]\) \.hs-searchbar::before\s*\{\s*background-color:/.test(code));
  const seamStopped = seamRules.filter(r => /animation:\s*none/.test(r.body));
  const mrBlocks = [];
  for (let mp = -1; (mp = css.indexOf('@media (prefers-reduced-motion: reduce)', mp + 1)) >= 0;) {
    mrBlocks.push(bodyFrom(css, css.indexOf('{', mp)) || '');
  }
  ok('微光：减动效两处都把它停住（html.hs-nomotion + prefers-reduced-motion 各一条）',
    seamStopped.length === 2 &&
    /html\.hs-nomotion \.hs-searchbar::before\s*\{\s*animation:\s*none/.test(code) &&
    mrBlocks.some(b => /\.hs-searchbar::before\s*\{\s*animation:\s*none/.test(b)),
    'stopped=' + seamStopped.length + ' mediaBlocks=' + mrBlocks.length);

  /* -------- J. 第 7/8/9 轮 ②：搜索框上那盏「会走的灯」 --------
     第 7 轮用户原话：「我希望是整个搜索框而不是顶部紧跟着细框微光的一小部分」。
     第 8 轮用户原话：「现在搜索框随着细框的微光变动的光照效果是一个光扇，这不是我想要的，
     我想要的类似于一个斜光打在搜索框上，整个搜索框从收光边到背光边的渐变」。
     第 9 轮用户原话（当前口径）：「搜索框的侧光效果不是整个框高光从高到暗，而是相当于有一个
     随着细框的微光位置而变化的测光光源打在整个搜索框上」。
     判据（每轮按新口径改判据，不是删断言）：
       · 主光层是**又宽又高的 radial 光斑**（56% × 200%，覆盖整条框），
         而不是第 8 轮那种「整框从亮到暗的 100deg 单向渐变」——后者已被用户否掉；
       · 亮心位置随关键帧横向平移（200% 底片），方向与细框微光一致（左 → 右）；
       · 第三层是**处处不为 0 的基础照明**：末段色标不是 0 alpha，
         所以不存在「背光边一片死黑」= 不是从高到暗的渐变；
       · 斜向折射（104deg + --glass-sheen）仍在；
       · 仍旧只动 background-position、三层位移都写全，同 3.6s ease-in-out infinite。 */
  const afRules = rules(css, '.hs-searchbar::after');
  const AF = afRules[0] ? codeOnly(afRules[0].body) : '';
  const afStopped = afRules.filter(r => /animation:\s*none/.test(r.body)).length;
  ok('整框微光：折射层从 background 简写改成 background-image（简写会把多层一起抹掉）',
    !!afRules.length && /background-image/.test(AF) && !/(^|[\s;{])background\s*:/.test(AF));
  ok('测光灯光（第 9 轮）：主光层是又宽又高的 radial 光斑，用的是细线同款 --glass-line-glow',
    /radial-gradient\(56% 200% at 50% 46%,/.test(AF) &&
    /color-mix\(in srgb, var\(--glass-line-glow\) 96%, transparent\) 0%/.test(AF) &&
    /color-mix\(in srgb, var\(--glass-line-glow\) 52%, transparent\) 34%/.test(AF) &&
    /color-mix\(in srgb, var\(--glass-line-glow\) 7%, transparent\) 88%/.test(AF));
  ok('测光灯光（第 9 轮）：不再是「整框从高到暗的 100deg 单向渐变」（用户明确否掉的那一版）',
    !/linear-gradient\(100deg/.test(AF));
  ok('测光灯光（第 9 轮）：第三层是处处不为 0 的基础照明（末段 alpha>0 ⇒ 没有死黑背光边）',
    /linear-gradient\(180deg,\s*rgba\(255,255,255,\.06\) 0%,\s*rgba\(255,255,255,\.028\) 46%,\s*rgba\(255,255,255,\.034\) 100%\)/.test(AF));
  ok('测光灯光（第 9 轮）：底片两倍宽（200% 100%）—— 灯才走得动',
    /background-size:\s*200% 100%\s*,\s*100% 100%\s*,\s*100% 100%/.test(AF) &&
    /background-repeat:\s*no-repeat, no-repeat, no-repeat/.test(AF));
  ok('整框微光：与上面细线 / 上沿补面同相位（同令牌 + 同 3.6s ease-in-out infinite）',
    /animation:\s*hs-box-glow 3\.6s ease-in-out infinite/.test(AF) &&
    /animation:\s*hs-line-glow 3\.6s ease-in-out infinite/.test(code) &&
    /animation:\s*hs-seam-glow 3\.6s ease-in-out infinite/.test(code));
  ok('整框微光：hs-box-glow 只动 background-position、不动 opacity，且三层位移都写全（写一个值会把折射层挪走）',
    (() => {
      const k = /@keyframes hs-box-glow\s*\{([\s\S]*?)\n\}/.exec(code);
      if (!k) return false;
      if (/opacity/.test(k[1])) return false;
      const shots = k[1].match(/background-position:[^;]*;/g) || [];
      return shots.length >= 2 && shots.every(s => (s.match(/,/g) || []).length >= 2);
    })());
  ok('测光灯光（第 9 轮）：灯从左边扫到右边（100% → 0%），与细框微光同向；另两层钉在原位',
    /@keyframes hs-box-glow\s*\{\s*from\s*\{\s*background-position:\s*100% 0, 0 0, 0 0;\s*\}\s*to\s*\{\s*background-position:\s*0% 0, 0 0, 0 0;\s*\}\s*\}/.test(code));
  ok('整框微光：原来的斜向折射高光仍在（104deg 与 --glass-sheen 没被顺手删掉）',
    /linear-gradient\(104deg/.test(AF) && /var\(--glass-sheen\)/.test(AF));
  ok('测光灯光：减动效两处都停住，落到 50% 的静态灯位（少动效 ≠ 少一层光）',
    afStopped >= 2 &&
    /html\.hs-nomotion \.hs-searchbar::after\s*\{\s*animation:\s*none;\s*background-position:\s*50% 0, 0 0, 0 0;/.test(code) &&
    mrBlocks.some(b => /\.hs-searchbar::after\s*\{\s*animation:\s*none;[\s\S]{0,160}?background-position:\s*50% 0, 0 0, 0 0/.test(b)),
    'stopped=' + afStopped + ' mediaBlocks=' + mrBlocks.length);

  /* -------- K. 第 10 轮 ③：侧光的「开始/结束自然」+「灯的对侧变暗」 --------
     用户原话：「搜索框的侧光效果开始和结束不够自然；我需要微光到右边时搜索框左边会暗下去
     而不是发光，微光到左边也是一样。」
     真机实测依据（tools/ui-truth-before.json，Chrome headless 逐相位截图像素分析）：
       · 灯的位置在 0.9s→1.2s 之间从 0.77% 跳到 99.92%（Δ99.15 个百分点）—— 单向 infinite
         环路走到头的瞬跳，就是「开始和结束不够自然」；
       · 左半区亮度相对基线的变化最小只有 +0.42（从未变暗），右半区最小 −35.1
         ⇒ 「对侧暗下去」当时完全没做到。
     判据：① 四盏灯全部改往返（alternate），时间线仍同一条；
           ② 对侧变暗由独立的 multiply 阴影层承担（screen 的 ::after 原理上不可能压暗）；
           ③ 阴影底片是「深色 → 中缝透明 → 深色」的 200% 宽底片，与灯同向同相位；
           ④ 定位与 ::after 对齐、不吃指针、**排在灯之上**（z-index 1：压在灯下面时对侧又被
              灯的基础照明 screen 回 +0.16，等于没暗）；
           ⑤ --glass-shade 深浅两套令牌齐全；⑥ 减动效两处都停住。 */
  const shadeRules = rules(css, '.hs-searchbar > .hs-sb-shade');
  const SH = shadeRules[0] ? codeOnly(shadeRules[0].body) : '';
  ok('测光（第 10 轮）：四盏灯（细线 / 上沿补面 / 整框测光 / 阴影）全部改成往返，不再有环路瞬跳',
    /animation:\s*hs-line-glow 3\.6s ease-in-out infinite alternate/.test(code) &&
    /animation:\s*hs-seam-glow 3\.6s ease-in-out infinite alternate/.test(code) &&
    /animation:\s*hs-box-glow 3\.6s ease-in-out infinite alternate/.test(code) &&
    /animation:\s*hs-sb-shade 3\.6s ease-in-out infinite alternate/.test(code));
  ok('测光阴影（第 10 轮）：::after 仍是 screen（只加亮）⇒ 对侧变暗必须另起一层 multiply，不能改 ::after 的混合模式',
    /mix-blend-mode:\s*screen/.test(AF) && shadeRules.length >= 1 && /mix-blend-mode:\s*multiply/.test(SH));
  ok('测光阴影（第 10 轮）：底片是「深色 → 中缝透明 → 深色」的 200% 宽（灯在最左压暗最右，反之亦然）',
    /linear-gradient\(90deg,\s*var\(--glass-shade\) 0%,\s*transparent 50%,\s*var\(--glass-shade\) 100%\)/.test(SH) &&
    /background-size:\s*200% 100%/.test(SH) &&
    /background-repeat:\s*no-repeat/.test(SH));
  ok('测光阴影（第 10 轮）：与灯同一条时间线（hs-sb-shade 3.6s ease-in-out infinite alternate，100% → 0%）',
    /animation:\s*hs-sb-shade 3\.6s ease-in-out infinite alternate/.test(SH) &&
    /@keyframes hs-sb-shade\s*\{\s*from\s*\{\s*background-position:\s*100% 0;\s*\}\s*to\s*\{\s*background-position:\s*0% 0;\s*\}\s*\}/.test(code));
  ok('测光阴影（第 10 轮）：定位与 ::after 对齐（inset 1px / inherit 圆角 / 不吃指针 / z-index 1 压在灯之上）',
    /inset:\s*1px/.test(SH) && /border-radius:\s*inherit/.test(SH) &&
    /pointer-events:\s*none/.test(SH) && /z-index:\s*1/.test(SH) &&
    /* ::after 自己是 z-index 0 ⇒ z-index 1 的子元素必然画在它上面（阴影乘的是「被灯照亮的玻璃」） */
    /z-index:\s*0/.test(AF));
  ok('测光阴影（第 10 轮）：--glass-shade 深浅两套都在（浅色主题压暗更轻，避免白玻璃发脏）',
    /--glass-shade:\s*rgba\(0,0,0,\.\d+\)\s*;/.test(dark) && /--glass-shade:\s*rgba\(16,16,32,\.\d+\)\s*;/.test(light));
  ok('测光阴影（第 10 轮）：减动效两处都停住，落到 50% 静态灯位（两侧同暗）',
    /html\.hs-nomotion \.hs-searchbar > \.hs-sb-shade\s*\{\s*animation:\s*none;\s*background-position:\s*50% 0;/.test(code) &&
    mrBlocks.some(b => /\.hs-searchbar > \.hs-sb-shade\s*\{\s*animation:\s*none;\s*background-position:\s*50% 0;/.test(b)));

  /* ------------------------------ F. 卫生 ------------------------------ */
  const edited = [S, B, bub].join('\n');
  ok('卫生：改动的三块规则里 0 个 !important',
    !/!important/.test(codeOnly(edited)));
  const impCount = (css.match(/!important/g) || []).length;
  ok('卫生：全文 !important 计数仍是改动前的 11（没靠 !important 压过谁）',
    impCount === 11, 'got ' + impCount);
  ok('卫生：全文花括号平衡',
    (css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length,
    (css.match(/\{/g) || []).length + '/' + (css.match(/\}/g) || []).length);
  ok('回归：减动效支持仍在（html.hs-nomotion 与 prefers-reduced-motion 两条都还有）',
    /html\.hs-nomotion \.hs-searchbar::after/.test(css) &&
    /@media \(prefers-reduced-motion: reduce\)/.test(css));

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

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function blkLen(s) { return s ? s.length : 0; }

if (require.main === module) main();
module.exports = { main };
