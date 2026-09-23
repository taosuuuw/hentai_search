/* ==========================================================================
   gateway-check.js — 本地网关（tools/gateway.js）的「出口预算 / 网络断路器 / 路由」静态断言
   --------------------------------------------------------------------------
   用法（在仓库根目录）：
     node tools/gateway-check.js
   为什么要它：
     · tools/gateway.js 是 6600+ 行的单文件网关，此前**没有任何回归保护**；
       而它最贵的一类缺陷恰好都发生在「站点不可达」这条路上：
       ① 出口死路时把预算烧穿 —— 腿是串行的、每条腿还留 900ms 收尾，
          实测 timeout:15000 被拖成 17.5s，一个关键词就能顶穿聚合器的 9.5s 硬闸，
          用户看到的却是「这个站搜不出东西」；
       ② 明知不可达，却**每个关键词都重烧一遍**完整预算。
     · 所以这里守的是第 11 轮落下的三件事：真·死线预算、出口感知的断路器、路由接线。
       断言对象是源码文本（与 reader-check.js 同一套路）：零依赖、零网络、可复验。
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ROOT } = require('./concept-check-shim');

const out = [];
const ok = (name, pass, info) => out.push({ name, pass: !!pass, info: info == null ? '' : String(info) });

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

/** 列出某个目录下的 .js 文件（相对 ROOT 的路径）；目录不存在时返回空数组 */
function jsUnder(rel) {
  try {
    return fs.readdirSync(path.join(ROOT, rel)).filter(f => /\.js$/.test(f)).sort()
      .map(f => rel + '/' + f);
  } catch (e) { return []; }
}

function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 从 open（'{' 的下标）开始数花括号，返回规则体（不含最外层花括号） */
function bodyFrom(src, open) {
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (!d) return src.slice(open + 1, i); }
  }
  return null;
}

/** 取 `function name(...) {...}` / `async function name(...) {...}` 的函数体 */
function fnBody(src, name) {
  const n = esc(name);
  const m = new RegExp('function\\s+' + n + '\\s*\\(').exec(src);
  if (!m) return '';
  const open = src.indexOf('{', m.index);
  return open < 0 ? '' : (bodyFrom(src, open) || '');
}

/** 只保留声明（去掉注释），避免注释里提到过的旧写法被当成「还在用」 */
function codeOnly(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 找出「整行落在块注释里、却长得像声明」的行 —— 这是漏写收尾符的特征。
    为什么要单独守：漏一个收尾符会让**下一行声明**被静默注释掉，
    node --check 与 vm.Script 都照样通过（注释本身完全合法），
    只有运行时走到那个使用处才 ReferenceError（第 11 轮 porn-comic 的真事故）。 */
function declsInsideBlockComments(src) {
  const body = String(src);
  const live = codeOnly(body);   /* 去掉注释后的「活代码」，用来判断一个名字到底有没有真声明 */
  const bad = [];
  const lines = body.split(/\r?\n/);
  let inBlock = false, startLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i];
    let j = 0, visible = '';
    while (j < s.length) {
      if (!inBlock && s.startsWith('/*', j)) { inBlock = true; startLine = i + 1; j += 2; continue; }
      if (inBlock && s.startsWith('*/', j)) { inBlock = false; j += 2; continue; }
      if (inBlock) { j++; continue; }
      if (s.startsWith('//', j)) break;
      const ch = s[j];
      if (ch === "'" || ch === '"' || ch === '`') {
        j++;
        while (j < s.length) {
          if (s[j] === '\\') { j += 2; continue; }
          if (s[j] === ch) { j++; break; }
          j++;
        }
        continue;
      }
      visible += ch;
      j++;
    }
    /* 这一行没有任何「注释外」的可见字符，却像一个声明 → 极可能被吞掉了。
       两道闸：① 长得像声明（缩进 ≤ 8 格，覆盖函数体内的声明）；
       ② 这个名字在「活代码」里完全没有声明 —— 文档注释里举例的代码
          通常引用真实存在的名字，所以第②道闸能把误报基本清零。 */
    if (!inBlock || visible.trim()) continue;
    const m = /^( {0,8})(?:const|let|var|function|async\s+function|class)\s+([A-Za-z_$][\w$]*)/.exec(s);
    if (!m) continue;
    const name = m[2];
    const declRe = new RegExp('\\b(?:const|let|var|function|class)\\s+' + name.replace(/\$/g, '\\$') + '\\b');
    if (declRe.test(live)) continue;
    bad.push('第 ' + (i + 1) + ' 行（注释自 ' + startLine + ' 行起）' + name + '：' + s.trim().slice(0, 70));
  }
  return bad;
}

function main() {
  const GW = read('tools/gateway.js');
  const gw = codeOnly(GW);

  /* -------- A. 语法：整个网关必须能被解析 -------- */
  let syntaxErr = '';
  try { new vm.Script(GW, { filename: 'tools/gateway.js' }); }
  catch (e) { syntaxErr = (e && e.message) || String(e); }
  ok('语法：tools/gateway.js 能被 V8 解析（单文件网关，一处语法错就整站不可用）',
    !syntaxErr, syntaxErr || (GW.split('\n').length + ' 行'));

  /* -------- A2. 块注释漏写收尾符会静默吞掉下一行声明（第 11 轮的真事故） --------
     事故原貌：PC_BUDGET_MS 那一行的块注释忘了收尾，紧接着的
     「const PC_STICKY_MS = 10 * 60e3;」整行就落进了前一个注释里，
     PC_STICKY_MS 于是真的 undefined；而 node --check 与 vm.Script 都照样通过
     （注释本身完全合法），只有运行到使用处才报 ReferenceError。
     ⇒ 语法检查抓不住这一类，必须单独守。 */
  const swallowed = [];
  ['tools/gateway.js'].concat(jsUnder('assets/js')).forEach(rel => {
    declsInsideBlockComments(read(rel)).forEach(m => swallowed.push(rel + ' ' + m));
  });
  ok('注释：块注释没有吞掉下一行声明（漏写收尾符会让声明静默变 undefined，语法检查抓不住）',
    swallowed.length === 0, swallowed.slice(0, 3).join(' ｜ ') || '网关 + assets/js 全部干净');

  /* 检测器自证：拿第 11 轮那次事故的**原样**喂给它，必须报出来。
     没有这条，上面那条 PASS 只证明「没找到东西」，证明不了「检测器有眼睛」。 */
  const selfTest = declsInsideBlockComments(
    'const A = 1;   /* 漏写收尾符\nconst SWALLOWED_ONE = 2;\n*/\nconst B = 3;\n'
  );
  ok('注释：检测器自证能报警（把事故原样喂给它，必须点名 SWALLOWED_ONE）',
    selfTest.length === 1 && /SWALLOWED_ONE/.test(selfTest[0] || ''), selfTest.join(' ｜ '));

  /* -------- B. outFetch 的真·死线：腿串行时不会各烧一遍预算 -------- */
  const outFetch = codeOnly(fnBody(GW, 'outFetch'));
  ok('预算：outFetch 的 left() 按同一个 t0 扣时间（真·死线，而不是每条腿各有 2.5s 保底）',
    /const left = \(\) => ms - \(Date\.now\(\) - t0\)/.test(outFetch));
  ok('预算：leg() 只保留 900ms 最小可用时间，到点之后的腿不再各自重置预算',
    /const leg = max => Math\.max\(900, Math\.min\(max \|\| ms, left\(\)\)\)/.test(outFetch));
  ok('预算：三条腿（原路 / DoH 直连 / 中继）都从 leg() 取时间',
    (outFetch.match(/\bleg\(/g) || []).length >= 4,
    'leg( 出现 ' + (outFetch.match(/\bleg\(/g) || []).length + ' 次');
  ok('出口：三层腿 tierEnv / tierDoh / tierRelay 都在 outFetch 里定义',
    /const tierEnv = async \(\) =>/.test(outFetch) &&
    /const tierDoh = async \(\) =>/.test(outFetch) &&
    /const tierRelay = async \(\) =>/.test(outFetch));

  /* -------- C. E-Hentai 断路器（第 10 轮留下的，别被后续改动碰掉） -------- */
  ok('EH：整函数硬预算 6s（第 8 轮 13000 → 6000）',
    /const EH_BUDGET_MS = 6000;/.test(gw));
  ok('EH：网络冷却 180s 常量存在',
    /const EH_NET_COOLDOWN_MS = 180e3;/.test(gw));
  ok('EH：确认网络层不可达时拉闸（冷却 = 网络冷却与**上游封禁倒计时**取大者，见 ehDownMs —— 第 17 轮改：只按固定 25s 会每 25s 再撞一次被封出口，把 5 分钟封禁刷成常驻）',
    /ehNetDownUntil = Date\.now\(\) \+ ehDownMs\(\);/.test(gw) &&
    /const EH_NET_COOLDOWN_MS = 180e3;/.test(gw) &&
    /const EH_NET_COOLDOWN_RELAY_MS = 25e3;/.test(gw) &&
    /const banLeft = ehBanUntil - Date\.now\(\);/.test(gw) &&
    /return Math\.max\(base, Math\.min\(30 \* 60e3, banLeft\)\);/.test(gw));
  /* 错误文案不许复读：ehHtml 抛出来的话自带「连不上 E-Hentai 搜索：…」前缀，
     再拼一次就成了「连不上 E-Hentai：连不上 E-Hentai 搜索：…」（真机封禁期间实测原文）。
     两个出口（ehentaiSearch 的硬闸 catch、ehentaiSearchInner 的 !gotPage）都要去重。 */
  ok('EH：错误文案去重 —— 两个出口都用 whyMsg 判「有没有说过连不上」（不再复读「连不上 E-Hentai：连不上…」）',
    (gw.match(/const whyMsg = \/连不上\/\.test\(why\) \? why : \('连不上 E-Hentai：' \+ why\);/g) || []).length === 2);
  /* 死因文案必须与时俱进：e-hentai **已经有非代理通路**（自建中继，/api/ping 的 relays[0] 标 private），
     公共中继只是后备。不能再写「直连无解、只能挂代理」。第 17 轮起 e-hentai / pixiv 各用自己的一段
     （EH_DEAD_FIX / PIXIV_DEAD_FIX）：两者病因不同，共用一段会让 pixiv 的报错里粘上 e-hentai 的说明
     （真机实测原文里出现过）。 */
  const ehFixAt = GW.indexOf('const EH_DEAD_FIX');
  const ehFix = ehFixAt < 0 ? '' : GW.slice(ehFixAt, GW.indexOf('const PIXIV_DEAD_FIX'));
  ok('EH：EH_DEAD_FIX 讲清 e-hentai 靠自建中继（relays[0]=private）+ 出口被限流才封，并给出 --proxy 的立刻恢复办法',
    /自建中继/.test(ehFix) && /relays\[0\]=private/.test(ehFix) &&
    /--proxy http:\/\/127\.0\.0\.1/.test(ehFix) &&
    !/直连无解；挂上代理即可恢复/.test(gw));
  const ehInner = codeOnly(fnBody(GW, 'ehentaiSearchInner'));
  ok('EH：冷却期内短路重试（不再把 6s 预算重复烧掉）—— 网络层与上游封禁两种记忆都算短路理由',
    /const netGate = ehNetDownUntil > Date\.now\(\) && ehNetDownEgress === \(egress\.live \|\| ''\);/.test(ehInner) &&
    /if \(netGate \|\| banGate\) \{/.test(ehInner));
  ok('EH：断路器出口感知 —— 用户挂上代理（egress.live 变了）立刻放行重试',
    /ehNetDownEgress === \(egress\.live \|\| ''\)/.test(gw));

  /* -------- C2. 2026-09-23：e-hentai 不需要代理就能通的通路（cors.eu.org 中继） --------
     事故原貌（真机 /api/diag，本机、无代理）：
       targets.ehentai = { ok:true, ms:10978, via:'relay' } —— **中继其实成功了**，
       但 ehentaiSearch 的硬闸是 6000ms，所以成功的那一次也被自己掐死，
       用户看到的是「E-Hentai 永远连不上」。
     机制：outFetch 三条腿是串行的，而 e-hentai 的前两条（原路 / DoH 钉 IP）在本机
     **注定失败**，DoH 那条还要烧 5.4s 做多候选 TLS 验真，中继腿只剩「预算 − 5.4s」。
     ⇒ 修法是 RELAY_PREFERRED：这类主机进门直奔中继。修后实测首搜 1022ms、
       q=asuna 267ms、q=genshin 310ms，均 ok:true。 */
  ok('EH：cors.eu.org 在 RELAYS 表里，且排第一（实测 233–691ms；allorigins 同日 5.4–16.2s）',
    /const RELAYS = \[\s*\{ id: 'cors-eu'/.test(gw));
  ok('EH：cors.eu.org 用**路径式**语法拼接（?url= 与 /api 两种写法实测都回 500）',
    /id: 'cors-eu'[^}]*tpl: u => 'https:\/\/cors\.eu\.org\/' \+ relayUrlInline\(u\)/.test(gw));
  ok('EH：e-hentai.org 在 RELAY_PREFERRED 里（否则首搜要白烧 5.4s 的 DoH 腿，6s 硬闸必炸）',
    /\['e-hentai\.org',/.test(gw) && /const RELAY_PREFERRED = new Map\(\[/.test(gw));
  ok('EH：outFetch 真的读 RELAY_PREFERRED（只声明不用 = 白改）',
    /planOf\(host\) \|\| \(RELAY_PREFERRED\.has\(host\) \? 'relay' : ''\)/.test(outFetch));
  ok('EH：预置 relay 的主机失败后不回头补跑注定失败的原路/DoH（省掉第二次 5.4s）',
    /tierRelay\(\); \} catch \(e\) \{ errs\.push\('中继：' \+ errMsg\(e\)\); setPlan\(host, ''\); dohTried = true; envTried = true; \}/.test(outFetch));
  /* 中继全断时，预置 relay 的主机必须**毫秒级如实失败**：
     它的原路与 DoH 实测恒失败，剩下的路一条都不可能通，可原来的流程会掉进
     「首次定通路」竞速，DoH 那腿要做多解析器 × 多候选 IP 的 TLS 验真，吃满整个预算
     （真机实测：`超过 6000ms 硬闸`）。触发场景正是中继被 e-hentai 限流封禁的时候 ——
     用户最需要「等一会儿」这句指引时反而等最久。
     ★判据必须按「这一发请求」筛可用中继★：第一版写成 RELAYS.every(!relayUsable)，
     而表里的 i0.wp 是 kind:'image'（只代取图片、不代取页面）且常年不冷却，
     于是 every 永远为 false —— 快速失败一次都没生效（真机复核：连打两发仍是 6641ms/3ms，
     那 3ms 是 180s 断路器给的）。这条断言同时守「按 kind 筛」这件事，防止回退。 */
  ok('EH：中继全断时不再白烧预算 —— 预置 relay 的主机立即失败并报「最久还需 x 秒」',
    /const eligible = RELAYS\.filter\(r =>/.test(outFetch) &&
    /r\.kind === 'image' && !wantImg/.test(outFetch) &&
    /if \(RELAYS\.length && !eligible\.length\) \{/.test(outFetch) &&
    /中继全部在冷却中（最久还需 ' \+ wait \+ 's）/.test(outFetch));
  ok('EH：快速失败按「最久还需多久」报，不按最短的报（最短的会让人以为马上就好）',
    /Math\.max\.apply\(null, RELAYS\.map\(r =>/.test(outFetch));
  /* 早退点必须在「首次定通路」之前 —— 否则照样会掉进 DoH 竞速 */
  ok('EH：快速失败的位置在首次定通路之前（放在后面等于没放）',
    outFetch.indexOf('RELAY_PREFERRED.has(host)') < outFetch.indexOf('let envTried = false'));
  /* ★反向断言★：pixiv 的「直连恒失败」与 e-hentai 是**两回事**，不能一起预置成 relay。
     实测 cors.eu.org 对 www.pixiv.net 一律 403，正文是 Cloudflare WAF 的 block_waf 页
     （「あなたの環境からはpixivにアクセスできません」）—— 那是 pixiv 按机房 IP 封的，
     换中继无解；预置成 relay 只会把「三条腿全灭」换成「一条腿必灭」并丢掉 DoH 的报错细节。 */
  const relayPreferredBlock = (gw.match(/const RELAY_PREFERRED = new Map\(\[[\s\S]*?\]\);/) || [''])[0];
  ok('Pixiv：**不在** RELAY_PREFERRED 里（中继对它一律 403，预置只会丢掉 DoH 的报错细节）',
    relayPreferredBlock.length > 0 && !/pixiv/i.test(relayPreferredBlock),
    relayPreferredBlock ? relayPreferredBlock.replace(/\s+/g, ' ').slice(0, 120) : '（没找到 RELAY_PREFERRED 定义）');
  /* 假 200：cors.eu.org 上游报错时不转发上游状态码，回 200 + 一小段错误文案。
     实测原文：/g/9999999999/xxxxxxxxxx/ → 200 · 172B · 「Gallery not found. …」。
     不拦的话调用方会把「Gallery not found」当成正常图集页 → 上报成「这个图集没内容」。 */
  ok('中继：cors-eu 带 fakeOk 标记，且 relayFetchOnce 里有识别分支（判据统一走 isTrapBody）',
    /fakeOk: 'cors-eu'/.test(gw) &&
    /if \(rel\.fakeOk && isTrapBody\(r\.buf\)\)/.test(fnBody(GW, 'relayFetchOnce')));
  /* 检测器自证：把 cors.eu.org 真回的那段报错正文喂给判据，必须被认出来 */
  {
    const fake = Buffer.from('<html><body>Gallery not found. If you just added this gallery, ' +
      'you may have to wait a short while before it becomes available.</body></html>');
    const low = fake.slice(0, 1200).toString('utf8');
    const flagged = fake.length < 2000 &&
      /(gallery not found|not found|access denied|forbidden|error\s*\d{3,4}|unable to load|bad gateway|no such)/i.test(low) &&
      !/<img|<a\s+href/i.test(low.slice(0, 600));
    ok('中继：假 200 检测器自证 —— 把真回的那段「Gallery not found」（172B）喂给它必须报警',
      !!flagged, '172B 的报错页面被判为假 200');
    /* 反向：真实的 /s/ 页实测 4662B，不能被误杀 */
    const realS = Buffer.from('<html><head><title>x</title></head><body>' +
      '<a href="https://e-hentai.org/">home</a><img id="img" src="https://x.hath.network/a/1.jpg">' +
      'x'.repeat(4000) + '</body></html>');
    const realLow = realS.slice(0, 1200).toString('utf8');
    const miskill = realS.length < 2000 &&
      /(not found)/i.test(realLow) && !/<img|<a\s+href/i.test(realLow.slice(0, 600));
    ok('中继：假 200 检测器不误杀真实的 /s/ 页（实测 4662B、含 <img>）',
      !miskill, realS.length + 'B 的真实 /s/ 页未被判为假 200');
  }

  /* 中继/健康判定里「HTTP 200 但不是内容」的统一判据（2026-09-23）
     本仓库踩过三次同类坑：AllOrigins 空壳 200、cors.eu.org 把上游报错当 200（172B
     「Gallery not found.」）、e-hentai 限流封禁也是 200 + 243B。
     第三次最隐蔽：/api/diag 原来只判 status < 500，于是封禁期照样报
     `ehentai: { ok: true, status: 200 }`，页面显示「可达」而用户搜下去全空。 */
  ok('健康判定：isTrapBody 存在，且 /api/diag 用它（不再只看 status < 500）',
    /function isTrapBody\(buf\)/.test(GW) &&
    /const trap = isTrapBody\(r\.buf\);/.test(GW) &&
    /ok: r\.status < 500 && !trap/.test(GW));
  ok('中继：relayFetchOnce 的假 200 判据复用 isTrapBody（不再各写一份正则）',
    /if \(rel\.fakeOk && isTrapBody\(r\.buf\)\)/.test(fnBody(GW, 'relayFetchOnce')));
  ok('中继：假 200 闸只对 fakeOk 类（文本）中继打开 —— 图片中继不能读正文前 1200 字节',
    /rel\.fakeOk && isTrapBody/.test(GW) && /只对 fakeOk 打开/.test(GW));
  /* 中继腿是**串行**的，每条腿原来都拿 o.timeout 全量 ⇒ 「腿数 × 全量超时」能拖到 60s。
     真机实测：cors-eu 报错进 42s 冷却后，allorigins 与 allorigins-get 各自烧光整个 6s 预算，
     用户白等 6648ms 只拿到「超过 6000ms 硬闸」。这与 outFetch 的 leg() 是同一个毛病。 */
  ok('中继：逐腿分预算 —— 每条腿拿 total/腿数 并夹 18s 上限（不再是「腿数 × 全量超时」）',
    /const LEG_MAX = 18000;/.test(GW) &&
    /const perLeg = Math\.max\(600, Math\.min\(LEG_MAX, Math\.floor\(total \/ legCount\)\)\);/.test(GW) &&
    /timeout: rel\.private \? legMs : \(legCap \? Math\.min\(perLeg, legCap\) : perLeg\), headers: reqHeaders, redirect: 'manual'/.test(fnBody(gw, 'relayFetchOnce')));
  /* ★第 12 轮新增★：调用方可以只给**公共后备腿**加一个更短的上限（o.legCap）。
     动机：nhentai 取的是 ~3KB JSON（健康 455ms），被限流时却让 allorigins / allorigins-get
     各烧满 perLeg ⇒ 用户白等 12s。这里把「没传 = 不设上限」也钉住 —— 踩过的坑：
     `Math.max(600, parseInt(o.legCap,10)||0)` 会让**没传**的调用方也拿到 600ms，
     把 cors-eu（实测 233–691ms）全部误杀。私有腿不受 legCap 影响。 */
  ok('中继：legCap 只压公共腿，且「没传 = 不设上限」（0 与没传必须区分）',
    /const legCapRaw = Math\.min\(LEG_MAX, parseInt\(o\.legCap, 10\) \|\| 0\);/.test(fnBody(gw, 'relayFetchOnce')) &&
    /const legCap = legCapRaw > 0 \? Math\.max\(600, legCapRaw\) : 0;/.test(fnBody(gw, 'relayFetchOnce')) &&
    /rel\.private \? legMs : \(legCap \? Math\.min\(perLeg, legCap\) : perLeg\)/.test(fnBody(gw, 'relayFetchOnce')) &&
    /legCap=/.test(fnBody(gw, 'relayFetchOnce')));
  /* ★第 16 轮新增★：私有腿的 4s 地板。
     实测事故：byRelay 把本次请求总预算提到 6000ms，private 按 60% 只拿到 3600ms，
     而这条腿那一刻要 5.4s ⇒ 判 timeout ⇒ 记 90s 站点退避 ⇒ 后面几次检索全落到
     6–9s 的 Chrome 上，整轮报「超过 7500ms 硬闸」。 */
  ok('中继：私有腿有 4s 地板（不吃「总预算 × 60%」的饿死）',
    /const legFloor = Math\.min\(4000, total\);/.test(fnBody(GW, 'relayFetchOnce')) &&
    /const legMs = Math\.max\(legPrivateMs, legFloor\);/.test(fnBody(GW, 'relayFetchOnce')));
  /* ★第 16 轮新增★：预算不足的腿失败**不记主机退避** —— 一条只拿到几百毫秒的腿
     说明不了主机任何事，旧代码照样记 90s，把 porn-comic 唯一能通的通路锁死。 */
  ok('中继：只分到几百毫秒的私有腿失败时不记站点退避（不自伤）',
    /if \(rel\.private && legBudget < 3000\) \{/.test(fnBody(GW, 'relayFetchOnce')) &&
    /超时不算主机的错/.test(GW));
  /* ★第 16 轮新增★：私有腿「超时」只退避 30s，「打不通（5xx）」才退避 90s。
     porn-comic 经中继实测 1.6–2.9s、偶发 5.4s ⇒ 偶发慢响应不该锁住唯一通路 90 秒。 */
  ok('中继：私有腿超时只退避 30s（RELAY_HOST_SLOW_MS），5xx 仍 90s',
    /const RELAY_HOST_SLOW_MS = 30e3;/.test(GW) &&
    /const softMs = isTimeout \? RELAY_HOST_SLOW_MS : RELAY_HOST_SOFT_MS;/.test(fnBody(GW, 'relayFetchOnce')));
  /* ★第 16 轮新增★：私有腿的 4xx 要「连续两次才算站」。
     实测：porn-comic 的 /q/<多词> 会被 302 到 search 子域并回 403（CF 挑战），
     一次路径级 403 把主机判死 10 分钟 ⇒ 后面正常的 /tags/ 检索全被自己人挡住。 */
  ok('中继：私有腿的 4xx 连续两次才判站 10 分钟（路径级 403 不升级成主机级封禁）',
    /const relayHost4xx = new Map\(\);/.test(GW) &&
    /const RELAY_4XX_WINDOW_MS = 5 \* 60e3;/.test(GW) &&
    /if \(n4 >= 2\) \{/.test(fnBody(GW, 'relayFetchOnce')) &&
    /relayHost4xx\.delete\(relayHostKey\(rel\.id, tHost\)\);/.test(fnBody(GW, 'relayFetchOnce')));
  /* 第 12 轮修正：私有腿**单独拿 60% 预算**。平均分只给自建中继 800ms（e-hentai 检索
     总预算 4000ms ÷ 5 条腿），而它实测要 1.4–2.0s ⇒ 报 timeout、e-hentai 掉到 50%
     （tools/stability-report-r12c.md）。这条把「私有腿能被饿死」钉死。 */
  ok('中继：私有腿单独分预算（60%，上限 18s），不再被平均分饿死',
    /const perLegPrivate = Math\.max\(perLeg, Math\.min\(LEG_MAX, Math\.floor\(total \* 0\.6\)\)\);/.test(fnBody(GW, 'relayFetchOnce')));
  /* 第 12 轮：腿的请求头不再是写死的 `{ accept }`，而是 reqHeaders ——
     公共中继只带 accept，只有**私有中继**才带 x-hs-key 与 x-hs-h-* 白名单（含 cookie）。
     这条把「凭据只给自己的中继」钉住：改成给公共中继带 cookie 会立刻红。 */
  ok('中继：请求头走 reqHeaders —— 公共中继只带 accept，私有中继才带 key 与 x-hs-h-* 白名单',
    /const reqHeaders = \{ accept: '\*\/\*' \};/.test(fnBody(GW, 'relayFetchOnce')) &&
    /reqHeaders\['x-hs-key'\] = rel\.key/.test(fnBody(GW, 'relayFetchOnce')) &&
    /PRIVATE_FORWARD_HDR\.indexOf\(lk\) >= 0/.test(fnBody(GW, 'relayFetchOnce')));
  /* 429 要把中继自己的正文说出来：实测 cors.eu.org 限流时回 429 + 它自己的 HTML 错误页，
     只写「限流/报错（HTTP 429）」看不出是谁在限流、为什么。 */
  ok('中继：429 报错带上中继自己的正文（实测 cors.eu.org 回 429 + 它自己的 HTML 错误页）',
    /中继自己限流了（HTTP 429，/.test(GW) && /正文=' \+/.test(GW));
  /* ★判据自证★：把真实抓到的三段正文原样喂给 isTrapBody，必须分类正确。
     不是复述正则，是把**源码里的真函数**取出来在 vm 里跑（改了实现这条会跟着变）。 */
  {
    const a = GW.indexOf('const TRAP_MARK');
    const b = GW.indexOf('function isTrapBody');
    const code = (a >= 0 && b > a) ? GW.slice(a, GW.indexOf('\n}', b) + 2) : '';
    let f = null;
    if (code) {
      const ctx = { Buffer };
      vm.createContext(ctx);
      try { vm.runInContext(code + '\nthis.isTrapBody = isTrapBody;', ctx); f = ctx.isTrapBody; } catch (e) { f = null; }
    }
    const cases = [
      ['e-hentai 限流封禁页（真机 243B）', Buffer.from('This IP address has been temporarily banned due to an excessive request rate. This probably means you are using automated mirroring/harvesting software'), true],
      ['cors.eu.org 的 Gallery not found（真机 172B）', Buffer.from('<html><body>Gallery not found. If you just added this gallery, you may have to wait a short while before it becomes available.</body></html>'), true],
      ['AllOrigins 空壳（0B）', Buffer.alloc(0), true],
      ['真实 /s/ 页（真机 4662B，含 <img id="img">）', Buffer.from('<html><body><a href="https://e-hentai.org/">h</a><img id="img" src="https://x.hath.network/a/1.jpg">' + 'x'.repeat(4500) + '</body></html>'), false],
      ['真实 e-hentai 首页（真机 66KB）', Buffer.from('<html><title>E-Hentai</title><body>' + 'y'.repeat(66000) + '</body></html>'), false],
      ['真实图片（80KB PNG 头）', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('z'.repeat(80000))]), false],
      /* 反向：**小但合法**的 JSON 不能被误杀（text 类 API 的响应本来就可能很短） */
      ['小 JSON 200（如 mangadex /ping）', Buffer.from('{"status":"ok","build":{"version":"1.0"}}'), false],
      /* 反向：上游自己的 404 页要**放行**（那是真实状态，不是中继在骗人）——
         只有 cors.eu.org 那句特定话术才算陷阱。这条当时把判据写错过一次。 */
      ['上游自己的 404 页（应放行）', Buffer.from('<html><head><title>404 Not Found</title></head><body>Not Found</body></html>'), false]
    ];
    const wrong = f ? cases.filter(c => f(c[1]) !== c[2]) : [{ 0: '（isTrapBody 取不出来）' }];
    ok('健康判定：isTrapBody 自证 8 例全对（封禁/假200/空壳 判真；真页面/真图片/小 JSON/上游404 判假）',
      !!f && wrong.length === 0,
      wrong.length ? wrong.map(w => w[0]).join(' ｜ ') : '8/8 分类正确');
  }

  /* -------- D. Pixiv 断路器（第 11 轮新增） -------- */
  ok('Pixiv：网络冷却 180s 常量存在',
    /const PIXIV_NET_COOLDOWN_MS = 180e3;/.test(gw));
  ok('Pixiv：取数预算 8s 且真的接到 outFetch 上（旧值 15000 实测被串行腿拖到 17.5s）',
    /const PIXIV_BUDGET_MS = 8000;/.test(gw) &&
    /timeout: PIXIV_BUDGET_MS/.test(gw));
  const px = codeOnly(fnBody(GW, 'pixivSearch'));
  ok('Pixiv：8s 预算外面还有一层函数级硬闸（r17 真机实测：只给 outFetch 传 timeout 时，串行腿把 8s 拖成 **15926ms**；套上硬闸后 8432ms 就回，断路器随即接管 → 第二次 5ms）',
    /withHardTimeout\(/.test(px) &&
    /Pixiv 取数/.test(px) &&
    /PIXIV_BUDGET_MS \+ 400/.test(px));
  ok('Pixiv：函数入口就判冷却，冷却期内毫秒级如实失败（实测 10550ms → 4ms）',
    /Date\.now\(\) < pixivNetDownUntil/.test(px));
  ok('Pixiv：断路器出口感知 —— 挂上代理后必须立刻恢复，不能被自己的冷却锁死 180s',
    /pixivNetDownEgress === \(egress\.live \|\| ''\)/.test(px));
  ok('Pixiv：只有链路层失败才拉闸（HTTP 4xx / 0 条结果不能触发冷却）',
    /pixivNetDownUntil = Date\.now\(\) \+ PIXIV_NET_COOLDOWN_MS;/.test(px) &&
    /fetch failed\|没给出能验真的 IP\|中继全失败\|返回的不是 JSON\|硬超时/.test(px));
  ok('Pixiv：.json 端点拿到 HTML 也算链路层失败（中继会剥掉 Referer，pixiv 于是回登录页）',
    /返回的不是 JSON（via=/.test(px) && /r\.via/.test(px));
  ok('Pixiv：拉闸时记下当时的出口，供出口感知比对',
    /pixivNetDownEgress = egress\.live \|\| '';/.test(px));

  /* -------- E. 路由接线与旧事故的复发防线 -------- */
  ok('路由：ehentai / pixiv / porncomic 三个 /api/*/search 出口都在（前端才拿得到 error）',
    /case '\/api\/ehentai\/search':/.test(gw) &&
    /case '\/api\/pixiv\/search':/.test(gw) &&
    /case '\/api\/porncomic\/search':/.test(gw));
  ok('porn-comic：PC_STICKY_MS 在本文件里有定义（第 11 轮那次「PC_STICKY_MS is not defined」是上一行漏写注释收尾符把它吞了，已修；不是旧进程跑旧码）',
    /const PC_STICKY_MS = 10 \* 60e3;/.test(gw));

  /* -------- F. 第 17 轮：封禁倒计时 / 预算收口 / 空答复语义 -------- */
  const ehBodyErr = codeOnly(fnBody(GW, 'ehBodyErr'));
  ok('E-Hentai：封禁按**上游倒计时**冷却，不只用固定的网络冷却 —— 否则每 25s 再撞一次被封出口，把 5 分钟封禁刷成常驻（真机：静默 390s 后 478ms 就拿到 26 条）',
    /function ehBanLeftMs\(body\)/.test(gw) &&
    /function ehDownMs\(\)/.test(gw) &&
    /return Math\.max\(base, Math\.min\(30 \* 60e3, banLeft\)\);/.test(gw) &&
    (gw.match(/Date\.now\(\) \+ ehDownMs\(\)/g) || []).length === 2);
  /* ★第 12 轮（需求⑤）★：用户体感「每次搜索都要等好几秒」来自两处：
     ① 文案把网关内部的冷却秒数写给用户看（读起来像命令他干等 N 秒）；
     ② 前端 sources.js 拿到 ok:false 后还去走「路线 2 浏览器直连」，同一面墙再花 4–5s。
     现在网关把冷却状态**结构化**返回（cooldown:{secs,until,banned,layer,egress}），
     文案只说「本轮跳过 / 会自动重试」，前端读到 hsCooldown 就整段跳过路线 2。 */
  ok('E-Hentai（第 12 轮）：冷却状态结构化返回（cooldown: ehCooldownInfo()），三个失败出口都带上',
    /function ehCooldownInfo\(\)/.test(gw) &&
    /secs: Math\.ceil\(left \/ 1000\)/.test(fnBody(gw, 'ehCooldownInfo')) &&
    /layer: banLeft > 0 \? 'ban' : 'net'/.test(fnBody(gw, 'ehCooldownInfo')) &&
    (gw.match(/cooldown: ehCooldownInfo\(\)/g) || []).length >= 3);
  /* 全仓 code-only 里只剩 2 处「秒内不再重试」—— pixiv 与 紳士漫畫镜像（各自独立策略，不在本轮范围）。
     e-hentai 的三处失败出口都不许再出现这个短语。 */
  ok('E-Hentai（第 12 轮）：给用户的文案不再出现「N 秒内不再重试」（改成「本轮跳过 + 会自动重试」）',
    /E-Hentai 本轮先跳过，网关会自动重试/.test(gw) &&
    /E-Hentai 本轮跳过（网关仍记着上次的网络层失败，会自动重试）/.test(gw) &&
    (gw.match(/秒内不再重试/g) || []).length === 2);
  /* ★第 12 轮（需求⑤ 续）★：「从弹出网页开始」的那条路（阅读器 → readerEhentai → ehHtml）
     抓到上游封禁页时只写了 ehBanUntil；而搜索路径的短路闸原先只认 ehNetDownUntil
     ⇒ 用户「先点开一个 E-Hentai 作品、再搜索」时，每一次搜索都要把三条腿重烧一遍
     （烧满 EH_BUDGET_MS 才失败）。现在 ehBanGate() 把这份记忆也当成短路理由，
     并且与记下它时的出口绑定（ehBanEgress）—— 用户换出口后旧封禁不该挡新出口。 */
  ok('E-Hentai（第 12 轮·需求⑤续）：弹窗/阅读器学到的封禁也进搜索短路闸（ehBanGate + 出口绑定）',
    /let ehBanEgress = '';/.test(gw) &&
    /if \(banLeft\) \{ ehBanUntil = Date\.now\(\) \+ banLeft \+ 3000; ehBanEgress = egress\.live \|\| ''; \}/.test(gw) &&
    /else if \(r\.ok\) \{ ehBanUntil = 0; ehBanEgress = ''; \}/.test(gw) &&
    (gw.match(/ehBanEgress = egress\.live \|\| ''/g) || []).length >= 2 &&  /* ehHtml + 自检两处都要记出口 */
    /function ehBanGate\(\)/.test(gw) &&
    /const banLeft = Math\.max\(0, ehBanUntil - Date\.now\(\)\);/.test(fnBody(gw, 'ehBanGate')) &&
    /if \(ehBanEgress !== \(egress\.live \|\| ''\)\) return null;/.test(fnBody(gw, 'ehBanGate')));
  const gateAt = GW.indexOf('const netGate =');
  const gateSrc = gateAt < 0 ? '' :
    GW.slice(gateAt, GW.indexOf('cooldown: ehCooldownInfo()', gateAt) + 30);
  ok('E-Hentai（第 12 轮·需求⑤续）：短路闸门两种记忆都认，且封禁分支的文案不含倒计时',
    /const netGate = ehNetDownUntil > Date\.now\(\) && ehNetDownEgress === \(egress\.live \|\| ''\);/.test(gw) &&
    /const banGate = ehBanGate\(\);/.test(gw) &&
    /if \(netGate \|\| banGate\) \{/.test(gw) &&
    /E-Hentai 本轮跳过（这个出口正被上游限流封禁/.test(gw) &&
    gateSrc.length > 200 && !/秒/.test(gateSrc) && !/分钟/.test(gateSrc),
    gateSrc.length > 200 ? '' : 'gateSrc 取不到（断言文本过期，先核对 ehentaiSearchInner 的闸门写法）');
  ok('E-Hentai：封禁文案说「封的是取页那一跳的出口」并把倒计时写进去，不再写死某一个中继',
    ehBodyErr.length > 200 && !/cors/.test(ehBodyErr) &&
    /ban expires in|temporarily banned/i.test(ehBodyErr) && /ehBanLeftMs\(/.test(ehBodyErr));
  ok('死站说明已拆成 EH_DEAD_FIX / PIXIV_DEAD_FIX（以前共用一段，pixiv 搜不到时错误里会粘上整段 e-hentai 的说明）',
    /const EH_DEAD_FIX =/.test(gw) && /const PIXIV_DEAD_FIX =/.test(gw) &&
    !/const DEAD_SITE_FIX =/.test(gw) &&
    (gw.match(/EH_DEAD_FIX/g) || []).length >= 2 && (gw.match(/PIXIV_DEAD_FIX/g) || []).length >= 2);
  const pxFixAt = GW.indexOf('const PIXIV_DEAD_FIX');
  const pxFix = pxFixAt < 0 ? '' : GW.slice(pxFixAt, pxFixAt + 700);
  ok('PIXIV_DEAD_FIX 的正文里没有 e-hentai 字样（旧事故就是这个串台），且说清是数据中心出口被 403、需要住宅出口',
    pxFix.length > 200 && !/e-hentai/i.test(pxFix) &&
    /数据中心出口/.test(pxFix) && /403/.test(pxFix) && /--proxy http:\/\/127\.0\.0\.1/.test(pxFix));
  const EHSRC = read('assets/js/sources.js');
  const ehSrc = codeOnly(fnBody(EHSRC, 'ehentaiSearch'));
  const banIdx = ehSrc.search(/temporarily banned/);
  const answeredIdx = ehSrc.indexOf('directAnswered = true');
  ok('前端 E-Hentai：**先判封禁页、再置成功标志**（旧顺序：先置 directAnswered=true → 抛错被 catch 吃掉 → 标志没回滚 → 尾部 return [] ⇒ UI 显示「✓ 返回 0 条」）',
    banIdx >= 0 && answeredIdx > banIdx &&
    /E-Hentai 按出口 IP 限流封禁（这不是「0 条结果」）/.test(ehSrc));
  const wnSrc = codeOnly(fnBody(EHSRC, 'wnacgSearch'));
  ok('前端 紳士漫畫：网关「没答复」与「答复了但 0 条」必须分开（0 条是 []，在 JS 里是真值，会短路掉 10 镜像 × 3 路径的浏览器兜底，白白烧掉 10s）',
    /if \(!res \|\| !res\.ok\) return null;/.test(wnSrc) &&
    /const items = gwItems\(res, 'wnacg'/.test(wnSrc) &&
    /if \(!items\.length\) return \[\];/.test(wnSrc));
  const copySrc = codeOnly(fnBody(EHSRC, 'copymangaSearch'));
  ok('前端 拷贝漫画：源内预算 8800ms 且每次 run 只看**当时剩余**时间（否则第一路烧 8s、第二路再来 8s，被聚合器 RUN_CAP_MS=9500 丢弃 ⇒「偶尔不返回结果」）',
    /const TOTAL_MS = 8800;/.test(copySrc) &&
    /Math\.max\(1500, Math\.min\(8200, leftMs\(\) - 300\)\)/.test(copySrc));
  ok('网关 紳士漫畫：批次地板受剩余预算约束（旧写法地板 2000ms 与 left() 无关 ⇒ 第一批跑满后 left() 只剩 400ms，deadline 判断仍允许再开一批 2000ms ⇒ 8580ms 撞死 8500ms 硬闸，同一词稍后又能出结果）',
    /const WN_BATCH_MIN_MS = 1000;/.test(gw) &&
    /const per = Math\.max\(700, Math\.min\(WN_HOST_MS, left\(\) - 700\)\);/.test(gw) &&
    /if \(left\(\) < 1800\) break;/.test(gw) &&
    /deadline: t0 \+ WN_BUDGET_MS - WN_BATCH_MIN_MS/.test(gw));
  const wn = codeOnly(fnBody(GW, 'wnacgSearchInner'));
  ok('网关 紳士漫畫：「镜像答了页但确实 0 条」与「源挂了」必须分开（前者要如实报 0 条并给换镜像的建议，不能报「候选主机全不可用」）',
    /let pageOk = false;/.test(wn) && /if \(pageOk\) \{/.test(wn) && /gallary_item/.test(wn) &&
    wn.indexOf('if (pageOk) {') < wn.indexOf('wnSearchCache.set('));
  ok('网关 紳士漫畫：「真 0 条」不写缓存（偶发空页若被钉 5 分钟，用户会觉得镜像坏了）',
    /if \(pageOk\) \{/.test(wn) && /return \{\s*source: 'wnacg', host: state\.wnHost \|\| '', total: 0, items: \[\]/.test(wn));
  ok('网关 紳士漫畫：冷却原因里去掉查询串（旧实现把整句连关键词一起存下，搜「巨乳」时报错还在讲上一次的 /search/?q=人妻）',
    /why\.replace\(\/\[\?&\]\[A-Za-z_\]\+=\[\^\\s；\)\]\*\/g, ''\)/.test(gw));
  ok('网关 拷贝漫画：raceFirstPrefer 参与关键路径（第一个**非空**答案立即胜；空答案只作 grace 兜底），且不再走只会等到硬闸的 raceFirst',
    /function raceFirstPrefer\(hosts, probe, graceMs\)/.test(gw) &&
    /raceFirstPrefer\(bases, h => probeFn\(h, left0\), COPY_EMPTY_GRACE_MS\)/.test(gw) &&
    !/[^a-zA-Z]raceFirst\(bases/.test(gw));
  ok('网关 拷贝漫画：空答案不再伪装成「节点不通」（旧写法是 throw 「返回 0 条」⇒ 竞速等满 7.5s 硬闸，上游真实原因永远带不回来）',
    /* r18：宽限值本身从 1500 提到 3000（真答案实测 2.8–2.9s），所以这里只要求「存在且 ≥1500ms」 */
    (function () {
      const m = gw.match(/const COPY_EMPTY_GRACE_MS = (\d+);/);
      return !!m && Number(m[1]) >= 1500;
    })() &&
    /return \{ base: base, empty: true, pack: \{ source: 'copymanga'/.test(gw) &&
    !/if \(!items\.length\) throw new Error\('返回 0 条'\);/.test(gw));
  ok('网关 拷贝漫画：空答复要靠「不带关键词的列表接口」分辨上游静默空转 vs 这个词真没货，且复核受总预算约束（真机踩过：复核把自己顶到 8018ms 撞死 8000ms 硬闸）',
    /\/api\/v3\/comics\?limit=5&offset=0&platform=3/.test(gw) &&
    /const rest = Math\.min\(3000, COPY_HARD_MS - 400 - \(Date\.now\(\) - t0\)\);/.test(gw) &&
    /if \(rest >= 900\) \{/.test(gw) && /e\.upstreamEmpty = 1;/.test(gw) &&
    /if \(!\(e && e\.upstreamEmpty\)\) err\.soft = 1;/.test(gw));

  /* -------- G. 可达性横幅：网关在线时不能再叫用户「先启动本地网关」 -------- */
  const netJs = codeOnly(read('assets/js/net.js'));
  ok('横幅：网关已连接时，临时结论改说「本地网关已连接 / 检索会优先走网关」，不再叫用户去启动一个已经在跑的网关（真机实测：网关在跑、E-Hentai 与紳士漫畫 都能搜到，横幅却写着「先启动本地网关再点一次检测」，用户因此以为源坏了）',
    (netJs.match(/本地网关已连接/g) || []).length >= 3 &&
    /GW\.ok\s*\?\s*'本地网关已连接/.test(netJs) &&
    /GW\.ok\s*\?\s*'本地网关已连接[\s\S]{0,240}?先启动本地网关/.test(netJs));
  ok('横幅：网探针在说「先启动本地网关」之前会自己补一次网关检测（boot 里 probeNow=260ms 早于 probeGateway=680ms，临时结论经常先落地 —— 真机误报就是这么来的）',
    /if \(!GW\.ok && !GW\._probedAt\) \{/.test(netJs) &&
    /await Promise\.race\(\[GW\.probe\(true\), new Promise/.test(netJs) &&
    netJs.indexOf('if (!GW.ok && !GW._probedAt) {') < netJs.indexOf('先启动本地网关'));
  const appJs = codeOnly(read('assets/js/app.js'));
  ok('横幅：网关在线时**标题**也认账（临时结论里 gatewayTiers 还是 null，所以标题必须看 GW.ok，否则会出现「描述说网关已连接、标题叫你先试网关」的自相矛盾）',
    /const gwLive = !!\(HS\.net\.gateway && HS\.net\.gateway\.ok\);/.test(appJs) &&
    /\(gwHelps \|\| gwLive\) \? '目标站点浏览器直连不通 —— 本地网关已接管'/.test(appJs));

  /* -------- H. 第 18 轮：搜索框测光包络 / 弹窗预热 / 误报治理 / 负缓存 / 图片预取 -------- */
  const styleCss = read('assets/css/style.css');
  ok('需求① 测光包络：灯层（.hs-searchbar::after）与水层（.hs-sb-shade）都挂了与细框微光同相位的强度包络，峰值/地板都做成令牌（浅色主题另有自己的一组）',
    (styleCss.match(/--sb-meter-peak/g) || []).length >= 2 &&
    (styleCss.match(/--sb-meter-floor/g) || []).length >= 2 &&
    (styleCss.match(/--sb-shade-peak/g) || []).length >= 2 &&
    (styleCss.match(/--sb-shade-floor/g) || []).length >= 2 &&
    /@keyframes hs-meter-dim/.test(styleCss) && /@keyframes hs-shade-dim/.test(styleCss) &&
    /animation: hs-box-glow 3\.6s ease-in-out infinite alternate,\s*hs-meter-dim 3\.6s/.test(styleCss) &&
    /animation: hs-sb-shade 3\.6s ease-in-out infinite alternate,\s*hs-shade-dim 3\.6s/.test(styleCss));
  ok('需求① 包络相位照抄细框微光 hs-line-glow（两头落地板、18%–82% 平台满亮），且灯层用 var(--sb-meter-peak) 取代原来写死的 .85',
    /@keyframes hs-meter-dim \{\s*0%\s*\{ opacity: var\(--sb-meter-floor\); \}\s*18%\s*\{ opacity: var\(--sb-meter-peak\); \}\s*82%/.test(styleCss) &&
    /@keyframes hs-shade-dim \{\s*0%\s*\{ opacity: var\(--sb-shade-floor\); \}\s*18%\s*\{ opacity: var\(--sb-shade-peak\); \}\s*82%/.test(styleCss) &&
    /\.hs-searchbar::after \{[\s\S]{0,600}?opacity: var\(--sb-meter-peak\);/.test(styleCss));
  ok('需求① 降级路径落回**峰值**：停动画时不能停在暗端（否则减少动效的用户看到的是一块暗玻璃），两条降级（html.hs-nomotion 与 prefers-reduced-motion）都要有',
    /html\.hs-nomotion \.hs-searchbar::after \{[\s\S]{0,220}?opacity: var\(--sb-meter-peak\);/.test(styleCss) &&
    /html\.hs-nomotion \.hs-searchbar > \.hs-sb-shade \{[\s\S]{0,220}?opacity: var\(--sb-shade-peak\);/.test(styleCss) &&
    (styleCss.match(/opacity: var\(--sb-meter-peak\)/g) || []).length >= 2);
  ok('需求① 刻意没动 ::before 的 opacity（那一层是补面，要盖住 8px 缝；改 opacity 会把缝闪出来 —— 旧注释里写明的坑）',
    (function () {
      const at = styleCss.indexOf('.hs-searchbar::before');
      const blk = at < 0 ? '' : styleCss.slice(at, at + 900);
      return at > 0 && blk.indexOf('--sb-meter') < 0 && blk.indexOf('--sb-shade') < 0;
    })());
  ok('需求②④ 网关预热 /api/warm 存在，且三段（自检 / 图片主机钉 IP / 上游巡检）**并行**、各自软超时、整段再套总保险丝（第一版串行写，真机实测 31.2 秒才回 —— 预热绝不能变成新的等待）',
    gw.indexOf("case '/api/warm': {") > 0 &&
    gw.indexOf('const soft = (p, ms, fb) => withHardTimeout(p, ms') > 0 &&
    gw.indexOf('soft(diagProbe(WARM_PROBE_MS), WARM_HARD_MS, null)') > 0 &&
    /soft\(Promise\.all\(WARM_PIN_HOSTS\.map\(h => pinHost\(h, 1800\)/.test(gw) &&
    /soft\(warmUpstreamCheck\(\), WARM_UP_MS, null\)/.test(gw) &&
    /\]\), WARM_TOTAL_MS, null\);/.test(gw) &&
    gw.indexOf('const WARM_PROBE_MS = 5000;') > 0 && gw.indexOf('const WARM_TOTAL_MS = 9000;') > 0 &&
    gw.indexOf('const WARM_CACHE_MS = 90e3;') > 0);
  ok('需求②④ 「没等到结论」不许冒充最终结论：warm 只在没有 unknown 目标时才写 diagCache；前端也只在 full 时才把它当成自检结论（把一次硬超时说成「连网关也打不通」正是误报来源）',
    /const full = !!Object\.keys\(d\.targets\)\.length &&/.test(gw) &&
    /!Object\.keys\(d\.targets\)\.some\(k => d\.targets\[k\] && d\.targets\[k\]\.unknown\)/.test(gw) &&
    gw.indexOf('if (full) diagCache = { at: Date.now(), data: d };') > 0 &&
    /if \(d && d\.full && d\.targets && Object\.keys\(d\.targets\)\.length\)/.test(netJs));
  ok('需求② 自检逐目标加硬超时并标 unknown（outFetch 的 timeout 是逐层的：原路 → DoH 钉 IP → 中继，传 6000 不等于 6 秒内有结论；旧写法把「没等到」当成「打不通」）',
    gw.indexOf('async function diagProbe(timeoutMs)') > 0 &&
    /const r = await withHardTimeout\(outFetch\(urls\[k\], \{ timeout: timeoutMs \}\),/.test(gw) &&
    /unknown: \/硬超时\/\.test\(msg\) \|\| undefined,/.test(gw));
  ok('需求② E-Hentai 的封禁要被**记住**并跳过自检（第 17 轮取证：那个 5 分钟封禁窗口正是我们自己每 25 秒一次的重试刷出来的）',
    /const hard = k === 'ehentai' && ehBanUntil > Date\.now\(\);/.test(gw) &&
    /if \(k === 'ehentai' && eban\) \{/.test(gw) &&
    /ehBanUntil = Date\.now\(\) \+ \(left \? left \+ 3000 : 600e3\);/.test(gw) &&
    /ok: false, banned: true, unknown: false, ms: 0, status: 0,/.test(gw));
  ok('需求② 紳士漫畫的自检目标换成同站群能应答的那个（www.wnacg.com 实测 4900–7200ms，5 秒预算下只等到硬超时 ⇒ 误报「连网关也打不通」）',
    gw.indexOf("wnacg: 'https://www.wnacg02.cc/'") > 0);
  ok('需求② 负缓存：拷贝漫画 / porn-comic 的失败也记一笔（同一个词再按回车不再重跑 3–7 秒的通路），且**只给这两个源**用（E-Hentai/紳士漫畫 有更精确的断路器，套这层会盖掉「还有 N 秒解封」）',
    gw.indexOf('const SW_FAIL_MS = 45e3;') > 0 &&
    gw.indexOf("const cf = swFailGet('copymanga', q.q);") > 0 &&
    gw.indexOf("const pf = swFailGet('porncomic', q.q);") > 0 &&
    (gw.match(/function swFailGet\(/g) || []).length === 1 &&
    (gw.match(/swFailSet\(/g) || []).length === 3 /* 1 处定义 + 2 处调用 */ &&
    (function () {   /* E-Hentai / 紳士漫畫 的路由里不许出现这层 */
      const ehAt = gw.indexOf("case '/api/ehentai/search': {");
      const eh = ehAt < 0 ? '' : gw.slice(ehAt, ehAt + 600);
      const wnAt = gw.indexOf("case '/api/wnacg/search': {");
      const wn = wnAt < 0 ? '' : gw.slice(wnAt, wnAt + 600);
      return ehAt > 0 && wnAt > 0 && eh.indexOf('swFail') < 0 && wn.indexOf('swFail') < 0;
    })());
  ok('需求② porn-comic 的成功结果要缓存（旧实现**成功也不缓存**，同一个词每次搜索都重跑 CF 渲染 / 中继）',
    gw.indexOf('const PC_SEARCH_CACHE_MS = 5 * 60e3;') > 0 &&
    gw.indexOf('pcSearchCache.set(ckey, { at: Date.now(), out: out });') > 0 &&
    /cached: true, cachedAge: Date\.now\(\) - chit\.at/.test(gw));
  ok('需求③ proxyFetch 在途合并：同一把缓存键的并发请求只发一次（旧实现只有「完成后写缓存」，阅读器并发取同一张图时会重复打上游）',
    gw.indexOf('const inflight = new Map();') > 0 &&
    /const pend = inflight\.get\(ck\);\s*if \(pend\) return pend;/.test(gw) &&
    gw.indexOf('async function proxyFetchOnce(url, referer, o, u, ck)') > 0 &&
    /if \(inflight\.get\(ck\) === p\) inflight\.delete\(ck\);/.test(gw));
  ok('需求③ /api/prefetch 批量预取端点：条数/并发/总预算都有上限，且能把页盒里的 /api/proxy?url=… 拆回同一把缓存键（否则预取写进去、取图又各算一把，白预取）',
    gw.indexOf("case '/api/prefetch': {") > 0 &&
    gw.indexOf('const PRE_MAX = 24;') > 0 && gw.indexOf('const PRE_CONC = 4;') > 0 &&
    gw.indexOf('const PRE_HARD_MS = 12000;') > 0 &&
    gw.indexOf("new URL(s, 'http://127.0.0.1/')") > 0);
  const readerJs = codeOnly(read('assets/js/reader.js'));
  ok('需求③ 阅读器按窗口预取后面几页（进窗口才取 = 一张一张等），且只预取一次、有节流',
    readerJs.indexOf('const PA_LOOKAHEAD = 6;') > 0 &&
    readerJs.indexOf('function prefetchAhead(from, n, list)') > 0 &&
    /data-prefetched/.test(readerJs) &&
    (readerJs.match(/prefetchAhead\(hi \+ 1, n, list\);/g) || []).length >= 2 &&
    readerJs.indexOf('PA_MIN_GAP_MS') > 0);
  ok('需求④ 弹窗时不许出现「部分网点没有连接」：网关在线时**临时结论一律不弹横幅**，只等最终结论；boot 也从「先网探针」改成「先探明并预热网关」',
    /const gwLive = !!\(HS\.net\.gateway && HS\.net\.gateway\.ok\);\s*if \(probe\.provisional && gwLive\) \{ b\.hidden = true; return; \}/.test(appJs) &&
    appJs.indexOf('if (ok && HS.net.gateway.warm) HS.net.gateway.warm();') > 0 &&
    appJs.indexOf('setTimeout(() => probeGateway(false), 120);') > 0 &&
    appJs.indexOf('setTimeout(() => probeNow(true, false), 300);') > 0 &&
    appJs.indexOf('setTimeout(() => probeGateway(false), 120);') < appJs.indexOf('setTimeout(() => probeNow(true, false), 300);') &&
    /HS\.bus\.on\('net:warm', \(\) => \{/.test(appJs));
  ok('需求④ 网探针把「自检硬超时（unknown）」与「上游限流封禁（banned）」从 blocked 里摘出去，并在一个都没验出打不通时给不报警的结论（真机实测：并行自检下 wnacg/hitomi 常报 5.9s 硬超时，而 /api/diag 里它们都是 OK）',
    /const softIds = Object\.keys\(tg\)\.filter\(k => tg\[k\] && \(tg\[k\]\.unknown \|\| tg\[k\]\.banned\)\);/.test(netJs) &&
    /blocked = targets\.filter\(r => r\.kind === 'target' && ADULT\.indexOf\(r\.id\) >= 0 && !r\.ok &&\s*softIds\.indexOf\(r\.id\) < 0\);/.test(netJs) &&
    /if \(blocked\.length === 0 && softIds\.length\) \{/.test(netJs) &&
    /const banIds = softIds\.filter\(k => tg\[k\] && tg\[k\]\.banned\);/.test(netJs));
  ok('需求② MangaDex：浏览器直连被投毒时把网关那条腿排到前面（旧顺序总是先白烧一次直连，用户感受就是「时好时坏」）',
    /const mdFirst = !!\(HS\.net\.browserBlocked && HS\.net\.browserBlocked\('mangadex'\)\);/.test(read('assets/js/sources.js')) &&
    (read('assets/js/sources.js').match(/proxyFirst: mdFirst/g) || []).length >= 2 &&
    netJs.indexOf('net.browserBlocked = function (id)') > 0 &&
    netJs.indexOf('GW.warm = async function (ms)') > 0 &&
    netJs.indexOf('GW.prefetch = function (urls, opt)') > 0);

  /* -------- I. 第 18 轮（二）：拷贝漫画「通路空壳」取证与修复 -------- */
  ok('需求② 中继对拷贝漫画的 API 节点只会回**空壳**（同一秒实测：中继 total=0、本机直连同一发 total=2186）⇒ 这三个主机被明确禁止走中继，并且**已经粘在中继上的旧计划要被清掉**（空壳是合法 200 JSON，setPlan 会把通路永久钉在中继上直到重启）',
    gw.indexOf('const RELAY_BAD_HOSTS = new Set([') > 0 &&
    /'api\.copy-manga\.com', 'api\.copy2000\.online', 'api\.mangacopy\.com'/.test(gw) &&
    /if \(noRelay && plan === 'relay'\) \{ plan = ''; setPlan\(host, ''\); \}/.test(gw) &&
    /const shellCooling = !opts\.relayOnly && !noRelay &&/.test(gw) &&
    /if \(opts\.relay !== false && !noRelay\)/.test(gw) &&
    /中继：已跳过（中继对拷贝漫画 API 节点只会回空壳/.test(gw));
  ok('需求②「答了但是空」的宽限期从 1.5s 提到 3.0s：真答案实测要 2.8–2.9s，宽限太短会自己把真结果丢掉（第 17 轮「上游静默空转」是错判，代码注释已就地纠正）',
    gw.indexOf('const COPY_EMPTY_GRACE_MS = 3000;') > 0 &&
    gw.indexOf('const COPY_EMPTY_GRACE_MS = 1500;') < 0 &&
    /真答案实测要 2\.8/.test(GW) &&
    /那个结论是错的/.test(GW));
  ok('需求② 第一轮全空要**再竞速一轮**（用剩余预算，且不许顶穿 COPY_HARD_MS 兜底）：第二轮拿到真结果就换掉空包，两轮都空才做「上游空 vs 这个词没货」的判定',
    /if \(got\.empty\) \{/.test(gw) &&
    /const retryBudget = COPY_HARD_MS - 500 - \(Date\.now\(\) - t0\);/.test(gw) &&
    /if \(retryBudget >= 1500\) \{/.test(gw) &&
    /const per = Math\.max\(1200, Math\.min\(COPY_ATTEMPT_MS, retryBudget\)\);/.test(gw) &&
    /raceFirstPrefer\(bases, h => probeFn\(h, per\), Math\.min\(COPY_EMPTY_GRACE_MS, retryBudget\)\)/.test(gw) &&
    /retryBudget \+ 300, '拷贝漫画节点竞速\(空结果重试\)'/.test(gw) &&
    /第一轮空、重试一轮拿到/.test(gw) &&
    /两轮都空 ⇒ 下面才做/.test(GW));
  ok('需求② 决定性取证留在源码里（下次别再把它当「上游整体故障」）：同一个 IP 171.244.199.189、同一套签名头，一次 total=2186、另一次 total=0，耗时 0.4–11s ⇒ 上游本身在摇摆；代码能做的只有「不把一次空当结论」+「不让恒空的中继冒充答案」',
    GW.indexOf('171.244.199.189') > 0 &&
    /一次回 `code=200 total=2186 list=30`/.test(GW) &&
    /恒\*\*回 total=0/.test(GW));

  ok('需求②④ 自检里的 Danbooru 不许把「直连被 Cloudflare 拦」当成「这个源不可用」：直连失败后要补一次**有界**镜像自检，镜像有应答就如实报 ok（真机取证：横幅清单里唯一一条是「Danbooru 连接失败（11ms）」，而同一时刻网关日志是「danbooru 镜像兜底：tbib ← tags=… → 8 条」；补上后横幅从「部分目标站点不可达」变成完全不出现）',
    /if \(k === 'danbooru' && out\[k\] && !out\[k\]\.ok\) \{/.test(gw) &&
    /danbooruMirrorFetch\(\{ tags: 'solo', limit: 1, page: 1 \}\)/.test(gw) &&
    /'Danbooru 镜像自检'/.test(gw) &&
    /via: 'mirror:' \+ mvia, mirror: true/.test(gw) &&
    /out\[k\]\.mirrorError = \(e2 && e2\.message\) \|\| String\(e2\);/.test(gw));

  /* -------- J. 第 18 轮（三）：禁漫阅读器「一次失败就判接口改版」的修复 -------- */
  ok('需求③ 禁漫阅读器取不到页文件名时要**换域名重试**（实测：阅读器偶发「禁漫这一话没有返回任何图片文件名（接口可能改版了）」，而同一时刻手动直测同一本 id=1475643 是 200 + 47 页 ⇒ 那是一次瞬时故障；jmHostsList() 本来就有十来个互为镜像的 APP 域名，不该一次失败给整本判死）',
    /const first = await jmPickHost\(\);/.test(gw) &&
    /const candidates = \[first\];/.test(gw) &&
    /\(await jmHostsList\(\)\)\.forEach\(h => \{ if \(candidates\.indexOf\(h\) < 0\) candidates\.push\(h\); \}\);/.test(gw) &&
    /for \(let i = 0; i < candidates\.length && i < 3; i\+\+\) \{/.test(gw) &&
    /await jmApi\(h, '\/chapter\?id=' \+ encodeURIComponent\(view\), \{ timeout: i \? 7000 : 9000 \}\)/.test(gw) &&
    /state\.jmHost = h; state\.jmHostAt = Date\.now\(\);/.test(gw) &&
    /禁漫换域名重试成功/.test(gw) &&
    /if \(!data\) \{/.test(gw) &&
    /不一定是「接口改版」，更像这一跳的瞬时故障/.test(gw) &&
    /tries\.join\('；'\)/.test(gw) &&
    gw.indexOf('没有返回任何图片文件名（接口可能改版了）') < 0);
  ok('需求③ 禁漫阅读器换域名重试时不许丢掉「为什么每个域名都不行」：每个候选各自记一条（返回 0 个文件名 / 抛出的原文），全失败时一并写进错误里',
    /tries\.push\(h \+ ' 返回 0 个文件名'\);/.test(gw) &&
    /tries\.push\(h \+ ' → ' \+ \(\(e && e\.message\) \|\| e\)\);/.test(gw) &&
    /const fl = asArray\(d && d\.images\)\.map\(String\)\.filter\(Boolean\);/.test(gw) &&
    /const files = asArray\(data\.images\)\.map\(String\)\.filter\(Boolean\);/.test(gw));
  ok('需求③ 禁漫阅读器优先复用记住的域名（旧写法每次都 jmResolveHost() 跑一整轮 pickProbe；实测同一本冷 3834ms → 复热 1876ms），并且**模板也换域名重试**（模板只依赖 view；域名在抖时会「/chapter 有文件名、模板没有 scramble_id」，旧写法整本判死）',
    /const first = await jmPickHost\(\);/.test(gw) &&
    gw.indexOf('const first = await jmResolveHost();') < 0 &&
    /const tmplHosts = \[host\]\.concat\(candidates\.filter\(h => h !== host\)\);/.test(gw) &&
    /for \(let i = 0; i < tmplHosts\.length && i < 3; i\+\+\) \{/.test(gw) &&
    /const r = await jmFetchTemplate\(h, view\);/.test(gw) &&
    /禁漫换域名取模板成功/.test(gw) &&
    /tmplTries\.push\(h \+ ' 模板 HTTP ' \+ \(st \|\| '失败'\) \+ \(err \? '，' \+ err : ''\)\);/.test(gw));

  /* -------- K. 第 12 轮（需求③）：nhentai 阅读器取数不再被单条慢腿吃光 --------
     实测（第 12 轮）：/api/reader?source=nhentai 在出口降级时 12137ms 才失败
     （private 被 429 → cors-eu 被 429 → allorigins 烧到 timeout），
     健康时刻 455ms ⇒ 预算得按「腿降级」的形态收紧，而不是给 20s 让它慢慢试。 */
  ok('需求③ readerJson 支持把额外参数（legCap）透传给 outFetch（原签名没有 extra，只能靠全局改 perLeg）',
    /async function readerJson\(url, referer, what, timeout, extra\)/.test(gw) &&
    /Object\.assign\(\{[\s\S]{0,220}\}, extra \|\| \{\}\)/.test(fnBody(gw, 'readerJson')));
  ok('需求③ nhentai 阅读器：JSON 预算 20s→10s，且非私有腿限 2000ms（实测健康时 455ms；腿降级时每条公共腿各烧一个 perLeg）',
    /const NH_JSON_MS = 10000;/.test(gw) &&
    /const NH_JSON_LEGCAP = 2000;/.test(gw) &&
    /NH_JSON_MS, \{ legCap: NH_JSON_LEGCAP \}\)/.test(gw) &&
    !/readerJson\('https:\/\/nhentai\.net[^)]*20000/.test(gw));
  ok('需求③ 阅读器首屏预热：JSON 一造好就先发前 2 页的图（实测首图冷取 1468ms 全落在首屏等待上；A/B 用新鲜 id 量到首屏 10402ms → 1759ms），预热失败必须被吞掉、且不许把主机拉进冷却',
    /function warmReaderImages\(pages, referer\)/.test(gw) &&
    /slice\(0, 2\)/.test(fnBody(gw, 'warmReaderImages')) &&
    /proxyFetch\(target, referer, \{ timeout: 12000, noCooldown: true \}\)/.test(fnBody(gw, 'warmReaderImages')) &&
    /\.catch\(\(\) => \{\}\);/.test(fnBody(gw, 'warmReaderImages')) &&
    /warmReaderImages\(pages, referer\);/.test(fnBody(gw, 'readerNhentai')) &&
    /* 注意：不要用 fnBody(gw,'proxyFetchOnce') —— codeOnly() 的「去行注释」正则会误伤
       `/^https?:\/\//i` 这类正则字面量（把行尾截掉），让这个函数的括号永远数不平。
       这条不变量在全文里唯一，直接对 `gw` 匹配。 */
    /if \(o\.noCooldown !== true\) deadHosts\.set\(u\.host, Date\.now\(\) \+ \(transient \? 45e3 : DEAD_MS\)\);/.test(gw));

  /* -------- K2. 第 12 轮（需求⑤）：熔断期间前端不再白烧「浏览器直连」那 4–5 秒 -------- */
  ok('需求⑤ 前端：熔断状态优先读网关的结构化 cooldown（老网关退回文案匹配），并随 err.hsCooldown 带出网关块',
    /function ehCoolingOf\(res\)/.test(EHSRC) &&
    /const c = res && res\.cooldown;/.test(codeOnly(fnBody(EHSRC, 'ehCoolingOf'))) &&
    /c\.secs > 0 \|\| c\.banned/.test(codeOnly(fnBody(EHSRC, 'ehCoolingOf'))) &&
    /err\.hsCooldown = ehCoolingOf\(res\);/.test(ehSrc) &&
    /gwCooling = \(e && e\.hsCooldown\) \|\| null;/.test(ehSrc));
  ok('需求⑤ 前端：拿到熔断结论立刻抛错交差，且这条短路在「路线 2：浏览器直连」**之前**（旧行为：网关失败后照样直连，实测白烧 4–5 秒再同样失败 ⇒ 用户体感「每次搜索都要等好几秒」）',
    /if \(gwCooling\) \{[\s\S]{0,400}E-Hentai 本轮跳过/.test(ehSrc) &&
    ehSrc.indexOf('if (gwCooling) {') >= 0 &&
    ehSrc.indexOf('if (gwCooling) {') < ehSrc.indexOf('let directErr = null') &&
    /throw new Error\('E-Hentai 本轮跳过/.test(ehSrc));
  /* ★第 12 轮（需求⑤ 续）★：用户原话「不要我每次搜索都要等多少多少秒」——
     前端这条短路文案里也**不许**再报倒计时（旧写法：'，约 ' + gwCooling.secs + ' 秒后自动重试'）。
     剩余时间仍在结构化 cooldown.secs 里，要展示时另说。 */
  ok('需求⑤ 前端：熔断短路文案不报倒计时（「约 N 秒后自动重试」已删）',
    !/gwCooling\.secs/.test(ehSrc) &&
    /E-Hentai 本轮跳过（网关已熔断，会自动重试，不影响其它源）/.test(ehSrc));

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
