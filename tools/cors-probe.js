/* E-Hentai「不靠代理」通路探针（零依赖，一次性链路取证；不进 check-all）
   为什么要有它：2026-09-23 发现 `https://cors.eu.org/<完整 URL>` 这条**路径式中继**
   在本机（无代理、无 VPN）能把 e-hentai 全链路带回来，而网关原来的中继表里只有
   AllOrigins（同日实测 /raw 16.2s 回 520、/get 5.4–5.9s 才回 200），根本进不了 12s 预算。
   这个脚本按「用户真正要走的链路」逐段取证，并在最后给出**结论行**：

     [1] 直连（本机出口）        —— 预期失败（SNI 关键字阻断 / DoH 无验真 IP）
     [2] cors.eu.org 中继        —— 预期全部 200，且**大图 sha 与历史记录逐字节一致**
     [3] 稳定性（同一地址连打）  —— 看会不会像 AllOrigins 那样限流
     [4] 假 200 陷阱            —— 上游报错时 cors.eu.org **不转发状态码**，回 200 + 错误文案
     [5] 经网关的等效路径        —— /api/ehentai/search、/api/reader、/api/proxy（要与 [2] 对得上）

   用法（在仓库根目录）：
     node tools/cors-probe.js                        # 用默认图集
     node tools/cors-probe.js <galleryUrl>           # 指定图集页
     node tools/cors-probe.js --gw=8799              # 顺带验网关（默认不验，网关没起也不影响）

   ⚠⚠ 跑之前先读这条（2026-09-23 实测踩到）⚠⚠
     cors.eu.org 跑在 **Cloudflare 免费套餐**上，用量超了会回
     **429 + Cloudflare Error 1027「the owner has reached their plan limits」**，
     此后**所有**请求都 429，跟 e-hentai 是否封禁无关。
     本脚本 [2][3] 两段会打好几个请求，**连续跑几遍就够把额度打干**（本轮就是这么打干的）。
     所以：一天跑一两次足够；要反复调试就地精简成单条请求。
     另外 e-hentai 自己也会因为「automated mirroring」封中继的出口（243B 封禁页，按小时）。
     两道限流都见 tools/fix-2026-09-23-net-and-reader.md 的 2.6 / 2.8。

   历史对照（tools/reader-eh-rootcause.md，2026-09-23）：大图 237188B / sha b313a632ad6f。
   ========================================================================== */
'use strict';
const crypto = require('crypto');

const GAL = process.argv[2] && process.argv[2].startsWith('http')
  ? process.argv[2] : 'https://e-hentai.org/g/4109923/e8a290c9df/';
const GW_PORT = (process.argv.find(a => a.indexOf('--gw=') === 0) || '').slice(5) || '';
const GW = GW_PORT ? ('http://127.0.0.1:' + GW_PORT) : '';
const EH_REF = 'https://e-hentai.org/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
/** 历史取证里那张大图的指纹（tools/reader-eh-rootcause.md）—— 对上了才叫「同一条路」 */
const KNOWN = { bytes: 237188, sha: 'b313a632ad6f' };

const sha12 = b => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);
const cut = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, n);

async function get(url, ms, referer) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      redirect: 'follow', signal: AbortSignal.timeout(ms || 25000),
      headers: Object.assign({ 'user-agent': UA, accept: '*/*' }, referer ? { referer: referer } : {})
    });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, ct: String(r.headers.get('content-type') || ''), buf: buf,
      bytes: buf.length, ms: Date.now() - t0, sha: sha12(buf), err: '' };
  } catch (e) {
    return { status: 0, ct: '', buf: Buffer.alloc(0), bytes: 0, ms: Date.now() - t0, sha: '',
      err: String((e && e.message) || e) };
  }
}

const row = (tag, r, extra) => console.log('    ' + String(tag).padEnd(14) +
  'HTTP ' + String(r.status).padEnd(4) + String(r.bytes).padStart(9) + 'B ' +
  String(r.ms).padStart(7) + 'ms' + (r.sha ? ('  sha=' + r.sha) : '') +
  (r.ct ? ('  ' + cut(r.ct, 24)) : '') + (r.err ? ('  ERR=' + r.err) : '') + (extra || ''));

const okHtml = r => r.status === 200 && /<html|<body|<!doctype/i.test(r.buf.slice(0, 300).toString('utf8'));

(async () => {
  console.log('=== E-Hentai「不靠代理」通路取证 ===');
  console.log('图集页：' + GAL);
  console.log('（本机无代理、无 VPN；中继腿 = https://cors.eu.org/<完整 URL>）\n');

  console.log('[1] 直连（本机出口）—— 预期：失败');
  row('直连', await get(GAL, 12000));

  console.log('\n[2] cors.eu.org 中继 —— 逐段');
  const gal = await get('https://cors.eu.org/' + GAL, 25000, EH_REF);
  row('图集页', gal);
  if (!okHtml(gal)) {
    console.log('\n!! 图集页都没取到，后面的 /s/ 页与大图取证做不下去（这本身就是结论）。');
    process.exitCode = 1;
    return;
  }
  const galHtml = gal.buf.toString('utf8');
  const links = [];
  const re = /href="(https:\/\/e-hentai\.org\/s\/[0-9a-f]+\/\d+-\d+)"/g;
  let m; while ((m = re.exec(galHtml))) if (links.indexOf(m[1]) < 0) links.push(m[1]);
  console.log('    图集页 title=' + cut((galHtml.match(/<title>([^<]*)<\/title>/i) || [])[1], 46) +
    '；/s/ 链接 ' + links.length + ' 条');
  if (!links.length) {
    console.log('!! 图集页里解析不出 /s/ 链接 —— 可能命中了「假 200」（见 [4]）。');
    process.exitCode = 1;
    return;
  }

  const sp = await get('https://cors.eu.org/' + links[0], 25000, EH_REF);
  row('/s/ 页', sp);
  const src = (sp.buf.toString('utf8').match(/<img[^>]*\bid="img"[^>]*src="([^"]+)"/i) || [])[1];
  console.log('    <img id="img"> src=' + cut(src, 90));
  if (!src) { console.log('!! /s/ 页里没有 <img id="img"> —— 大图 URL 无从解析。'); process.exitCode = 1; return; }

  const im1 = await get('https://cors.eu.org/' + src, 30000, EH_REF);
  row('大图 #1', im1);
  const im2 = await get('https://cors.eu.org/' + src, 30000, EH_REF);
  row('大图 #2', im2);
  const isImg = /^image\//i.test(im1.ct) && im1.bytes > 1000;
  const sameSha = im1.sha && im1.sha === im2.sha;
  const matchKnown = im1.bytes === KNOWN.bytes && im1.sha === KNOWN.sha;

  console.log('\n[3] 稳定性：首页连打 6 次（AllOrigins 就是死在这一步 —— 会限流）');
  console.log('    ⚠ 只打首页/新闻页，**不要**把图集页 + /s/ 页串起来猛刷 ——');
  console.log('      cors.eu.org 的出口是共享的，e-hentai 会因为「automated mirroring」封它，');
  console.log('      回 200 + 243B 的封禁页（见 [4] 与 tools/fix-2026-09-23-net-and-reader.md 2.6）');
  let okN = 0;
  for (let i = 1; i <= 6; i++) {
    const r = await get('https://cors.eu.org/' + EH_REF, 15000);
    const hit = /E-Hentai/.test(r.buf.toString('utf8'));
    if (hit) okN++;
    console.log('    #' + i + '  HTTP ' + r.status + '  ' + r.bytes + 'B  ' + r.ms + 'ms  hit=' + hit);
  }

  console.log('\n[4] 假 200 陷阱（cors.eu.org 上游报错时不转发状态码）');
  const fake = await get('https://cors.eu.org/https://e-hentai.org/g/9999999999/xxxxxxxxxx/', 15000);
  const fakeLow = fake.buf.slice(0, 1200).toString('utf8');
  const fakeFlagged = fake.bytes < 2000 &&
    /(gallery not found|not found|forbidden|error\s*\d{3,4}|unable to load|bad gateway)/i.test(fakeLow) &&
    !/<img|<a\s+href/i.test(fakeLow.slice(0, 600));
  row('不存在的图集', fake, '  假200=' + fakeFlagged);
  console.log('    正文：' + cut(fakeLow, 110));

  let gwOk = null;
  if (GW) {
    console.log('\n[5] 经网关的等效路径（' + GW + '）');
    const q = await get(GW + '/api/ehentai/search?q=fate&limit=5', 60000);
    let j = null; try { j = JSON.parse(q.buf.toString('utf8')); } catch (e) {}
    console.log('    /api/ehentai/search  HTTP ' + q.status + ' ' + q.ms + 'ms  ok=' + (j && j.ok) +
      ' via=' + (j && j.via) + ' items=' + ((j && j.items || []).length));
    const cov = j && j.items && j.items[0] && j.items[0].cover;
    if (cov) {
      const c = await get(cov.startsWith('/api/proxy') ? GW + cov : cov, 30000);
      row('封面', c);
    }
    const rd = await get(GW + '/api/reader?source=ehentai&id=' + encodeURIComponent(GAL), 90000);
    let rj = null; try { rj = JSON.parse(rd.buf.toString('utf8')); } catch (e) {}
    console.log('    /api/reader         HTTP ' + rd.status + ' ' + rd.ms + 'ms  ok=' + (rj && rj.ok) +
      ' pages=' + ((rj && rj.pages || []).length));
    gwOk = !!(j && j.ok) && !!(rj && rj.ok);
  }

  console.log('\n================ 结论 ================');
  console.log('  cors.eu.org 取图集页      : ' + (okHtml(gal) ? 'OK' : 'FAIL'));
  console.log('  cors.eu.org 取大图        : ' + (isImg ? ('OK（' + im1.bytes + 'B ' + im1.ct + '）') : 'FAIL'));
  console.log('  大图两次 sha 一致         : ' + (sameSha ? 'YES' : 'NO'));
  console.log('  与历史取证逐字节一致      : ' + (matchKnown
    ? ('YES（' + KNOWN.bytes + 'B / ' + KNOWN.sha + '）')
    : ('NO（本次 ' + im1.bytes + 'B / ' + im1.sha + '，历史 ' + KNOWN.bytes + 'B / ' + KNOWN.sha + '）')));
  console.log('  连打 6 次成功             : ' + okN + '/6');
  console.log('  假 200 被识别             : ' + (fakeFlagged ? 'YES' : 'NO'));
  if (GW) console.log('  网关 search + reader      : ' + (gwOk ? 'OK' : 'FAIL'));
  console.log('  ⇒ e-hentai ' + (okHtml(gal) && isImg && okN >= 5 ? '**不需要代理即可用**（走 cors.eu.org 中继）'
    : '本次取证未全绿，见上面各行'));
  console.log('  ⇒ pixiv 不适用这条通路：cors.eu.org 对 www.pixiv.net 一律 403，');
  console.log('     正文是 Cloudflare WAF 的 block_waf 页（「あなたの環境からはpixivにアクセスできません」），');
  console.log('     属于 pixiv 按**机房 IP** 封，与「本机被墙」是两回事，换中继解决不了。');

  if (!(okHtml(gal) && isImg && okN >= 5)) process.exitCode = 1;
})();
