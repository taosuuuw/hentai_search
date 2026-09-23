/* ==========================================================================
   check-all.js — 一次跑完本仓库的几套断言套件，只打印「每套 通过 N / 失败 M + 失败行」
   --------------------------------------------------------------------------
   用法（在仓库根目录）：
     node tools/check-all.js
   为什么要它：
     · 各套件都是 console.log 逐条打印（concept-check 一次 400+ 行），全量刷屏没必要；
     · 受限 shell 里不能把 node 的 stdout 重定向/管道出来（命名管道被禁），
       所以这里把各套件的源码在同一进程里编译执行：临时接管 console.log，
       只留「PASS/FAIL 计数 + 失败行」。
     · ⚠ 各套件 main() 末尾会 process.exit()，所以这里也临时接管 process.exit；
       而且各套件都写了 `if (require.main === module) main()`，所以不能用 require 直接跑，
       要用 Module._compile 编译成「不是主模块」的副本，再把 main 取出来自己调。
   退出码：有任何套件失败 → 1，全绿 → 0。
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

const SUITES = [
  ['concept-check.js', '词义 / 源 / 回归红线'],
  ['cardtags-check.js', '卡面标签'],
  ['scroll-check.js', '滚动到底 + 回顶按钮'],
  ['glass-check.js', '液态玻璃材质'],
  ['reader-check.js', '阅读器缩放 / 拖动 / 退出'],
  ['recent-check.js', '最近浏览记账 + 角标'],
  ['dict-check.js', '黑话词典 + 打字提示泡泡'],
  ['gateway-check.js', '网关出口 / 断路器 / 路由 / 注释吞代码'],
  ['relay-check.js', '自建中继（协议 / 转发 / 鉴权 / SSRF / 网关接入）']
];

const realLog = console.log;
const realExit = process.exit;

/** 把套件源码编译成非主模块，返回它的 main()（拿不到返回 null） */
function loadSuite(file) {
  const abs = path.join(__dirname, file);
  const src = fs.readFileSync(abs, 'utf8');
  /* 硬性要求：套件必须有 `if (require.main === module) main()` 守卫。
     没有守卫的套件在 _compile 阶段就会自动跑一次，然后又被我们 main() 调一次 ——
     同一进程里断言翻倍、还互相污染（实测 cardtags-check 就是 19 过 1 败的假象）。
     宁可在这里炸掉，也不要给出错的数字。 */
  if (!/require\.main\s*===\s*module/.test(src)) {
    throw new Error('这套件缺 `if (require.main === module) main()` 守卫，'
      + '同进程汇总跑会重复执行，请先在套件里补守卫（见 cardtags-check.js 末尾）');
  }
  const m = new Module(abs, null);
  m.filename = abs;
  m.paths = Module._nodeModulePaths(__dirname);
  m._compile(src + '\n;module.exports.__suiteMain = (typeof main === "function" ? main : null);\n', abs);
  return typeof m.exports.__suiteMain === 'function' ? m.exports.__suiteMain : null;
}

function oneLine(s) {
  const parts = String(s).split('\n');
  let r = parts[0].trim();
  const rest = parts.slice(1).join(' ').trim();
  if (rest) r += '  |  ' + (rest.length > 160 ? rest.slice(0, 160) + '…' : rest);
  return r;
}

(async function run() {
  const report = [];
  let anyFail = false;

  for (const pair of SUITES) {
    const file = pair[0], title = pair[1];
    const stat = { pass: 0, fail: 0, failLines: [], summary: '' };
    console.log = function () {
      const s = Array.prototype.map.call(arguments, x => (typeof x === 'string' ? x : String(x))).join(' ');
      if (/^\s*(PASS|FAIL)\b/.test(s)) { if (s.indexOf('FAIL') >= 0) stat.fail++; else stat.pass++; }
      if (/^\s*FAIL\b/.test(s)) stat.failLines.push(oneLine(s));
      if (/条断言/.test(s)) stat.summary = s.trim();
    };
    let code = 0;
    process.exit = function (c) { code = (typeof c === 'number' ? c : 0); };
    try {
      const fn = loadSuite(file);
      if (!fn) throw new Error('这套件没有可调用的 main()');
      await fn();
    } catch (e) {
      stat.fail++;
      stat.failLines.push('异常：' + ((e && e.stack) || e).toString().split('\n')[0]);
      code = 1;
    }
    process.exit = realExit;
    console.log = realLog;
    if (code) anyFail = true;
    report.push({ title: title, file: file, stat: stat, code: code });
  }

  realLog('\n================ 套件总览 ================');
  report.forEach(function (r) {
    realLog((r.code ? '  FAIL  ' : '  PASS  ') + r.file.padEnd(20, ' ') +
      '通过 ' + r.stat.pass + ' / 失败 ' + r.stat.fail +
      (r.stat.summary ? '   [' + r.stat.summary + ']' : ''));
    r.stat.failLines.slice(0, 8).forEach(function (l) { realLog('          ' + l); });
  });
  realLog('------------------------------------------');
  realLog(anyFail ? '有套件失败' : '套件全绿（失败 0）');
  realExit(anyFail ? 1 : 0);
})();
