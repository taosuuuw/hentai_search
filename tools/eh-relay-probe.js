/* E-Hentai 取图通路取证探针（零依赖，一次性链路验证；不进 check-all）
   目的：把「e-hentai.org 图集页 / <ptoken> 页 / <节点>.hath.network 大图」分开取证 ——
     ① 直连（本机出口）     ② AllOrigins raw / get      ③ i0.wp.com（图片专用中继）
   口径与网关一致：/api/proxy 的 relay 表就是这三个（见 tools/gateway.js:544-551）；
   Referer 用 https://e-hentai.org/（与 EH_REFERER 一致，gateway.js:4062）。
   用法：node tools/eh-relay-probe.js [galleryUrl]
*/
'use strict';
const crypto = require('crypto');

const GAL = process.argv[2] || 'https://e-hentai.org/g/4109923/e8a290c9df/';
const EH_REF = 'https://e-hentai.org/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sha12 = b => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);
const cut = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').slice(0, n);

async function tryFetch(url, ms) {
  const t0 = Date.now();
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    const r = await fetch(url, {
      redirect: 'follow', signal: ctl.signal,
      headers: { 'user-agent': UA, accept: '*/*', referer: EH_REF }
    });
    const buf = Buffer.from(await r.arrayBuffer());
    clearTimeout(timer);
    return { status: r.status, ct: String(r.headers.get('content-type') || ''),
      buf: buf, bytes: buf.length, ms: Date.now() - t0, sha: sha12(buf), err: '', head: '' };
  } catch (e) {
    return { status: 0, ct: '', buf: Buffer.alloc(0), bytes: 0, ms: Date.now() - t0, sha: '',
      err: String((e && e.message) || e), head: '' };
  }
}

/* 经本机网关的 /api/proxy 取一张图 —— 与浏览器 <img src="/api/proxy?…"> 完全同一条路 */
const GW = 'http://127.0.0.1:8788';
async function throughGateway(imgUrl, times) {
  const path = '/api/proxy?url=' + encodeURIComponent(imgUrl) + '&referer=' + encodeURIComponent(EH_REF);
  const out = [];
  for (let i = 1; i <= times; i++) {
    const t0 = Date.now();
    try {
      const r = await fetch(GW + path);
      const buf = Buffer.from(await r.arrayBuffer());
      out.push({ via: 'gateway#' + i, status: r.status, ct: String(r.headers.get('content-type') || ''),
        bytes: buf.length, ms: Date.now() - t0, sha: sha12(buf), err: '',
        note: buf.length < 400 ? '  body=' + cut(buf.toString('utf8'), 300) : '' });
    } catch (e) {
      out.push({ via: 'gateway#' + i, status: 0, ct: '', bytes: 0, ms: Date.now() - t0, sha: '',
        err: String((e && e.message) || e), note: '' });
    }
  }
  return out;
}

/* 三条中继各试 retries 次（AllOrigins 实测经常回自己 edge 的 500/522 —— 是**中继**打不到上游） */
async function viaRelays(url, wantImg, retries) {
  const legs = [
    { id: 'allorigins', tpl: u => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u) },
    { id: 'allorigins-get', tpl: u => 'https://api.allorigins.win/get?url=' + encodeURIComponent(u) }
  ];
  if (wantImg) legs.push({ id: 'i0.wp', tpl: u => 'https://i0.wp.com/' + String(u).replace(/^https?:\/\//i, '') });
  const out = [];
  for (const leg of legs) {
    for (let i = 1; i <= (retries || 2); i++) {
      const r = await tryFetch(leg.tpl(url), 60000);
      let note = '';
      if (leg.id === 'allorigins-get' && r.buf.length) {
        try {
          r.buf = Buffer.from(JSON.parse(r.buf.toString('utf8')).contents || '', 'binary');
          r.sha = sha12(r.buf); note = ' (从 {"contents":…} 解出)';
        } catch (e) { note = ' (不是 JSON)'; }
      }
      out.push({ via: leg.id + '#' + i, status: r.status, ct: r.ct, bytes: r.buf.length,
        ms: r.ms, sha: r.sha, err: r.err, note: note, buf: r.buf });
      if (r.status === 200 && r.buf.length > 1000) break;
    }
  }
  return out;
}

function show(tag, list) {
  console.log('--- ' + tag);
  list.forEach(r => console.log('    ' + String(r.via).padEnd(16) + ' HTTP ' + String(r.status).padEnd(4) +
    String(r.bytes).padStart(9) + 'B ' + String(r.ms).padStart(7) + 'ms  sha=' + (r.sha || '—') +
    (r.ct ? '  ct=' + r.ct : '') + (r.err ? '  ERR=' + r.err : '') + (r.note || '')));
}
const okHtml = r => r.status === 200 && r.buf.length > 2000 && /<html|<body|<!doctype/i.test(r.buf.toString('utf8').slice(0, 400));

(async () => {
  if (process.argv[2] === '--gw') {
    const imgUrl = process.argv[3] || '';
    console.log('=== 经网关 /api/proxy 取图（与浏览器 <img> 同一条路）===');
    console.log('图：' + imgUrl + '\n');
    show('网关 /api/proxy（同一张取 2 次比 sha）', await throughGateway(imgUrl, 2));
    return;
  }
  console.log('=== E-Hentai 取图通路取证 ===');
  console.log('图集页：' + GAL + '\n');

  console.log('[1] 图集页 HTML (e-hentai.org/g/…)');
  show('直连（本机出口）', [await tryFetch(GAL, 25000)]);
  const g1 = await viaRelays(GAL, false, 3);
  show('中继', g1);
  const gal = g1.find(okHtml);
  if (!gal) {
    console.log('\n!! 三条中继都没能取到图集页 HTML —— 后面的 /s/ 页与大图取证做不下去（这本身就是根因）。');
    return;
  }
  const gHtml = gal.buf.toString('utf8');
  console.log('    ✔ 图集页到手：' + gHtml.length + 'B（via ' + gal.via + '）');

  const links = [];
  const re = /href="(https:\/\/e-hentai\.org\/s\/[0-9a-f]+\/\d+-\d+)"/g;
  let m; while ((m = re.exec(gHtml))) if (links.indexOf(m[1]) < 0) links.push(m[1]);
  console.log('[2] /s/ 页候选：' + links.length + ' 条，取第 1 条：' + (links[0] || '（无）'));
  if (!links.length) return;

  console.log('\n[3] /s/ 页 HTML（真实大图地址只能从这一页解析）');
  show('直连（本机出口）', [await tryFetch(links[0], 25000)]);
  const s1 = await viaRelays(links[0], false, 3);
  show('中继', s1);
  const sp = s1.find(okHtml);
  if (!sp) { console.log('\n!! /s/ 页也取不到，大图 URL 无从解析。'); return; }
  const sHtml = sp.buf.toString('utf8');
  const tag = sHtml.match(/<img[^>]*\bid="img"[^>]*>/i);
  const src = tag && tag[0].match(/src="([^"]+)"/i);
  console.log('    <img id="img"> 命中：' + (tag ? '是' : '否') + '；src=' + (src ? src[1] : '（无）'));
  if (!src) {
    console.log('    该 /s/ 页里没有 <img id="img" src="…"> —— 原始片段：' +
      cut(sHtml.replace(/\s+/g, ' ').slice(0, 0) + sHtml.slice(Math.max(0, sHtml.indexOf('id="img"') - 200), sHtml.indexOf('id="img"') + 400), 500));
    return;
  }
  const imgUrl = src[1];
  const imgHost = (imgUrl.match(/^https?:\/\/([^/]+)/i) || [])[1] || '';

  console.log('\n[4] 大图直取：' + imgUrl);
  console.log('    （图床主机 ' + imgHost + '；与 reader 包出来的 /api/proxy?url=…&referer=' + EH_REF + ' 同口径）');
  show('直连（本机出口）', [await tryFetch(imgUrl, 25000)]);
  const i1 = await viaRelays(imgUrl, true, 2);
  show('中继', i1);
  console.log('\n[5] 同一张图再取一次比 sha（稳定性）');
  const i2 = await viaRelays(imgUrl, true, 2);
  show('中继（第二遍）', i2);
  const best = i1.concat(i2).filter(r => r.status === 200 && /^image\//i.test(r.ct) && r.bytes > 1000);
  console.log('\n结果：' + (best.length
    ? '大图可经中继取到 —— ' + best[0].via + ' HTTP 200 · ' + best[0].bytes + 'B · ' + best[0].ct + ' · sha=' + best[0].sha +
      '；两遍 sha 一致=' + (best.length > 1 && best[0].sha === best[best.length - 1].sha ? '是' : '仅一条成功')
    : '大图三条通路都取不到（直连被墙 + 中继打不到图床）'));
})();
