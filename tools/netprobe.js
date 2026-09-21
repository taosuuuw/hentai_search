#!/usr/bin/env node
/* ==========================================================================
   netprobe.js — 出口可达性分层体检（零依赖）

   为什么需要它：
     「打不开」有四种完全不同的死法，修法也完全不同 ——
       ① 系统 DNS 被污染       → 真实 IP 能连，只是解析错了（DoH / IP 直连可救）
       ② 域名整体不可达        → 换镜像域名（可救）
       ③ TCP 通、TLS 被重置    → SNI 阻断（只能换域名 / 换出口，救不了）
       ④ 只是缺 Referer/UA     → HTTP 层 403（请求头可救）
     不把层分开量，就只能看到一句「连不上」，于是永远在猜。

   判据：
     sysdns   = 系统 DNS 解析出的 IP
     doh      = 各 DoH 解析出的 IP（取并集，标注来源）
     tcp      = 对某个 IP 的 :443 能不能握手成功（TCP 层）
     tls/http = 带 SNI 的 TLS 握手 + 一次 HTTP 请求的返回码（应用层）

   用法：
     node tools/netprobe.js                  # 全部站点
     node tools/netprobe.js --group jm       # 只测禁漫
     node tools/netprobe.js --host a,b       # 只测指定主机
     node tools/netprobe.js --json           # 输出机器可读 JSON
     node tools/netprobe.js --timeout 4000
   ========================================================================== */
'use strict';

const dns = require('dns');
const net = require('net');
const tls = require('tls');
const httpMod = require('http');
const httpsMod = require('https');

const argv = process.argv.slice(2);
const argOf = n => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] || '') : ''; };
const has = n => argv.indexOf('--' + n) >= 0;

const TIMEOUT = parseInt(argOf('timeout') || '5000', 10);
const AS_JSON = has('json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ------------------------------ 站点清单 ------------------------------ */
/* group 只是打印时分组用；kind 说明这台主机在经济上扮演什么角色 */
const SITES = [
  /* 拷贝漫画 */
  { group: '拷贝漫画', host: 'www.copy20.com', kind: '网页' },
  { group: '拷贝漫画', host: 'api.copy2000.online', kind: 'API 节点' },
  { group: '拷贝漫画', host: 'api.mangacopy.com', kind: 'API 节点' },
  { group: '拷贝漫画', host: 'api.copy-manga.com', kind: '节点发现' },
  { group: '拷贝漫画', host: 'mirror.ymcdn.org', kind: '图床' },
  { group: '拷贝漫画', host: 'img.copymanga.org', kind: '图床' },
  { group: '拷贝漫画', host: 'sf.mangafunb.fun', kind: '图床（实际在用）' },

  /* 禁漫天堂 */
  { group: '禁漫天堂', host: '18comic.vip', kind: '网页' },
  { group: '禁漫天堂', host: 'www.cdnhjk.net', kind: 'APP 接口/镜像' },
  { group: '禁漫天堂', host: 'www.cdnbea.net', kind: 'APP 接口/镜像' },
  { group: '禁漫天堂', host: 'cdn-msp.jmapinodeudzn.net', kind: '图床' },
  { group: '禁漫天堂', host: 'cdn-msp.jmapiproxy3.cc', kind: '图床（封面）' },
  { group: '禁漫天堂', host: 'cdn-msp2.jmapiproxy3.cc', kind: '图床（正文）' },
  { group: '禁漫天堂', host: 'tencent.jmdanjonproxy.xyz', kind: '图床（模板 imghost）' },
  { group: '禁漫天堂', host: 'rup4a04-c02.tos-cn-hongkong.bytepluses.com', kind: '域名列表' },

  /* 紳士漫畫 */
  { group: '紳士漫畫', host: 'www.wnacg.com', kind: '网页' },
  { group: '紳士漫畫', host: 'www.wnacg01.cc', kind: '镜像' },
  { group: '紳士漫畫', host: 'www.wnacg02.cc', kind: '镜像' },
  { group: '紳士漫畫', host: 'www.wn03.ru', kind: '镜像' },
  { group: '紳士漫畫', host: 'www.wn04.ru', kind: '镜像' },

  /* nhentai */
  { group: 'nhentai', host: 'nhentai.net', kind: '网页/API' },
  { group: 'nhentai', host: 't.nhentai.net', kind: '图床' },
  { group: 'nhentai', host: 'i.nhentai.net', kind: '图床' },

  /* E-Hentai */
  { group: 'E-Hentai', host: 'e-hentai.org', kind: '网页' },
  { group: 'E-Hentai', host: 'forums.e-hentai.org', kind: '论坛' },

  /* Hitomi */
  { group: 'Hitomi', host: 'hitomi.la', kind: '网页' },
  { group: 'Hitomi', host: 'a1.gold-usergeneratedcontent.net', kind: '图床' },

  /* 其它源 */
  { group: '其它源', host: 'kemono.cr', kind: 'Kemono' },
  { group: '其它源', host: 'api.mangadex.org', kind: 'MangaDex' },
  { group: '其它源', host: 'danbooru.donmai.us', kind: 'Danbooru' },
  { group: '其它源', host: 'cdn.donmai.us', kind: 'Danbooru 图床' },
  { group: '其它源', host: 'www.pixiv.net', kind: 'Pixiv' },
  { group: '其它源', host: 'i.pximg.net', kind: 'Pixiv 图床' },
  { group: '其它源', host: 'porn-comic.com', kind: 'porn-comic' },

  /* 无 VPN 兜底中转：这些站若在境内可达，就能当「图片/接口中继」用 */
  { group: '兜底中转', host: 'images.weserv.nl', kind: '图片中继候选' },
  { group: '兜底中转', host: 'wsrv.nl', kind: '图片中继候选' },
  { group: '兜底中转', host: 'i0.wp.com', kind: '图片中继候选' },
  { group: '兜底中转', host: 'api.allorigins.win', kind: 'CORS 中继候选' },
  { group: '兜底中转', host: 'api.codetabs.com', kind: 'CORS 中继候选' },
  { group: '兜底中转', host: 'corsproxy.io', kind: 'CORS 中继候选' },
  { group: '兜底中转', host: 'cdn.jsdelivr.net', kind: '静态中继候选' }
];

/* ------------------------------ DoH ------------------------------ */
const DOH = [
  { id: 'alidns', url: 'https://dns.alidns.com/resolve', label: '阿里 223.5.5.5' },
  { id: 'dnspod', url: 'https://doh.pub/dns-query', label: '腾讯 119.29.29.29' },
  { id: 'cloudflare', url: 'https://cloudflare-dns.com/dns-query', label: 'Cloudflare 1.1.1.1' },
  { id: 'quad9', url: 'https://dns.quad9.net:5053/dns-query', label: 'Quad9' }
];

function withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new Error('timeout')), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

async function dohQuery(server, host) {
  const tk = withTimeout(TIMEOUT);
  try {
    const r = await fetch(server.url + '?name=' + encodeURIComponent(host) + '&type=A', {
      headers: { accept: 'application/dns-json' },
      signal: tk.signal
    });
    if (!r.ok) return { server: server.id, error: 'HTTP ' + r.status };
    const j = await r.json();
    const ips = (j.Answer || [])
      .filter(a => a.type === 1 && a.data)
      .map(a => String(a.data).trim())
      .filter(ip => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
    return { server: server.id, label: server.label, status: j.Status, ips: ips };
  } catch (e) {
    return { server: server.id, label: server.label, error: (e && e.message) || String(e) };
  } finally { tk.done(); }
}

/* ------------------------------ TCP / TLS ------------------------------ */
function tcpConnect(ip, port, ms) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let done = false;
    const fin = ok => { if (!done) { done = true; try { sock.destroy(); } catch (e) {} resolve({ ok, ms: Date.now() - t0 }); } };
    const sock = net.connect({ host: ip, port: port });
    sock.setTimeout(ms);
    sock.on('connect', () => fin(true));
    sock.on('timeout', () => fin(false));
    sock.on('error', () => fin(false));
  });
}

/** 带 SNI 的 TLS 握手 + 一次 HTTP GET，返回 { ok, status, bytes, err, ms }
    ★bytes 很重要★：实测有些站会回「HTTP 200 + content-length: 0」的空壳
    （E-Hentai 的 Varnish 限流就是这样），只看状态码会把"空壳"当成"通"。
    本函数用 Connection: close 每次开新连接，正好用来排除"连接复用导致的假失败"。 */
function tlsHttp(ip, host, ms, path) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let done = false;
    let out = '';
    const fin = res => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (e) {}
      resolve(Object.assign({ ms: Date.now() - t0 }, res));
    };
    const bodyBytes = () => {
      const i = out.indexOf('\r\n\r\n');
      if (i < 0) return 0;
      const head = out.slice(0, i);
      const m = /content-length:\s*(\d+)/i.exec(head);
      if (m) return Math.min(parseInt(m[1], 10), out.length - i - 4);
      return Math.max(0, out.length - i - 4);
    };
    let sock;
    try {
      sock = tls.connect({
        host: ip, port: 443, servername: host,
        rejectUnauthorized: false,        /* 只看「能不能通」，证书链不是这次的判据 */
        ALPNProtocols: ['http/1.1']
      });
    } catch (e) { return fin({ ok: false, err: 'tls connect throw: ' + e.message }); }
    sock.setTimeout(ms);
    sock.on('secureConnect', () => {
      sock.write('GET ' + (path || '/') + ' HTTP/1.1\r\nHost: ' + host +
        '\r\nUser-Agent: ' + UA + '\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n');
    });
    sock.on('data', d => {
      out += d.toString('latin1');
      /* 拿到足够多就已经能判定「通了」；顺便把 body 字节数带出来（空壳一眼可见） */
      if (out.length > 4096) {
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(out);
        fin({ ok: true, status: m ? parseInt(m[1], 10) : 0, bytes: bodyBytes(), partial: true });
      }
    });
    sock.on('end', () => {
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(out);
      if (m) fin({ ok: true, status: parseInt(m[1], 10), bytes: bodyBytes() });
      else fin({ ok: false, err: out ? '无 HTTP 响应（' + out.slice(0, 40).replace(/\s+/g, ' ') + '）' : '空响应' });
    });
    sock.on('timeout', () => fin({ ok: false, err: 'TLS/HTTP 超时' }));
    sock.on('error', e => fin({ ok: false, err: 'TLS 层失败：' + (e.code || e.message) }));
    sock.on('close', () => { if (!done) fin({ ok: false, err: '连接被关闭（无响应）' }); });
  });
}

/* ------------------------------ 单站判定 ------------------------------ */
async function probeHost(site) {
  const host = site.host;
  const rec = { group: site.group, host: host, kind: site.kind };

  /* ① 系统 DNS */
  let sysIps = [];
  try {
    const r = await dns.promises.lookup(host, { all: true, verbatim: true });
    sysIps = r.filter(x => x.family === 4).map(x => x.address);
  } catch (e) { rec.sysDnsErr = (e && e.code) || (e && e.message) || 'lookup failed'; }
  rec.sysIps = sysIps;

  /* ② DoH（并行问所有解析器） */
  const dohRes = await Promise.all(DOH.map(s => dohQuery(s, host)));
  rec.doh = dohRes;
  const dohIps = [];
  dohRes.forEach(r => (r.ips || []).forEach(ip => { if (dohIps.indexOf(ip) < 0) dohIps.push(ip); }));
  rec.dohIps = dohIps;

  /* ③ 先看系统 DNS 那个 IP（也就是浏览器/旧网关会走的真路） */
  const tryIps = [];
  sysIps.forEach(ip => { if (tryIps.indexOf(ip) < 0) tryIps.push(ip); });
  dohIps.forEach(ip => { if (tryIps.indexOf(ip) < 0) tryIps.push(ip); });

  if (!tryIps.length) {
    rec.verdict = 'nxdomain';
    rec.verdictZh = '解析不到任何 IP';
    return rec;
  }

  rec.perIp = [];
  for (const ip of tryIps.slice(0, 6)) {
    /* eslint-disable no-await-in-loop */
    const tcp = await tcpConnect(ip, 443, TIMEOUT);
    const via = sysIps.indexOf(ip) >= 0 ? 'sysdns' : 'doh';
    /* 哪个 DoH 解析器给了这个 IP —— 这决定了「哪些解析器在说真话」 */
    const src = dohRes.filter(r => (r.ips || []).indexOf(ip) >= 0).map(r => r.server);
    const row = { ip: ip, via: via, src: src, tcp: tcp.ok, tcpMs: tcp.ms };
    if (tcp.ok) {
      const h = await tlsHttp(ip, host, TIMEOUT, '/');
      row.tls = h.ok; row.status = h.status || 0; row.err = h.err || '';
      row.httpMs = h.ms;
      /* 200 也可能是**空壳**（content-length: 0）—— 记下来，判定与展示都要用 */
      row.bytes = h.bytes || 0;
      row.empty = !!(h.ok && h.status === 200 && !h.bytes);
    } else {
      row.tls = false; row.err = 'TCP 握手失败';
    }
    rec.perIp.push(row);
  }

  /* ④ 分层判定 —— 这四类死法的修法完全不同 */
  const sysRows = rec.perIp.filter(r => r.via === 'sysdns');
  const dohRows = rec.perIp.filter(r => r.via === 'doh');
  const anyTls = rec.perIp.some(r => r.tls);
  const anyTcp = rec.perIp.some(r => r.tcp);
  const sysTls = sysRows.some(r => r.tls);
  const dohTls = dohRows.some(r => r.tls);
  const sysTcp = sysRows.some(r => r.tcp);
  const dohTcp = dohRows.some(r => r.tcp);

  if (anyTls) {
    if (sysTls) { rec.verdict = 'ok'; rec.verdictZh = '直连可用'; }
    else if (dohTls) { rec.verdict = 'dns-poisoned'; rec.verdictZh = 'DNS 污染：真 IP 可直连（DoH 可救）'; }
    else { rec.verdict = 'ok'; rec.verdictZh = '直连可用'; }
  } else if (anyTcp) {
    if (!sysTcp && dohTcp) { rec.verdict = 'dns-poisoned-tls'; rec.verdictZh = 'DNS 污染 + TLS 层也被拦'; }
    else { rec.verdict = 'sni-blocked'; rec.verdictZh = 'TCP 通、TLS 被重置（SNI 阻断，本机救不了）'; }
  } else if (sysTcp || dohTcp) {
    rec.verdict = 'http-blocked'; rec.verdictZh = 'TCP 通但应用层无响应';
  } else {
    rec.verdict = 'unreachable'; rec.verdictZh = '全部 IP 不可达（换镜像域名 / 只能走代理）';
  }
  return rec;
}

/* ------------------------------ 中继通道实测 ------------------------------
   「站点直连不通」不等于「没救」：境内能直连的中继（Cloudflare 上的图片中继 /
   CORS 中继）自己是在墙外取内容的。这一段就实测它们到底能不能把被墙站的内容带回来 ——
   这是「无 VPN 也能读图」的最后一条腿。 */
async function fetchVia(url, ms) {
  const tk = withTimeout(ms || 20000);
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA, accept: '*/*' },
      signal: tk.signal, redirect: 'follow'
    });
    const buf = Buffer.from(await r.arrayBuffer());
    return { ok: r.ok, status: r.status, ms: Date.now() - t0,
      type: r.headers.get('content-type') || '', bytes: buf.length, buf: buf };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: (e && e.message) || String(e) };
  } finally { tk.done(); }
}

const RELAYS = [
  { id: 'allorigins', label: 'AllOrigins raw', tpl: 'https://api.allorigins.win/raw?url={url}' },
  { id: 'allorigins-get', label: 'AllOrigins get', tpl: 'https://api.allorigins.win/get?url={url}' },
  { id: 'isomorphic', label: 'isomorphic-git', tpl: 'https://cors.isomorphic-git.org/{rawurl}' },
  { id: 'cors-workers', label: 'cors.workers.dev', tpl: 'https://test.cors.workers.dev/?{url}' },
  { id: 'cors-lol', label: 'api.cors.lol', tpl: 'https://api.cors.lol/?url={url}' },
  { id: 'corsproxy-org', label: 'corsproxy.org', tpl: 'https://corsproxy.org/?{url}' },
  { id: 'thingproxy', label: 'thingproxy', tpl: 'https://thingproxy.freeboard.io/fetch/{rawurl}' },
  { id: 'jina', label: 'r.jina.ai（仅文本）', tpl: 'https://r.jina.ai/{rawurl}' },
  { id: 'corsproxy', label: 'corsproxy.io（要 key）', tpl: 'https://corsproxy.io/?url={url}' },
  { id: 'whateverorigin', label: 'whateverorigin', tpl: 'http://www.whateverorigin.org/get?url={url}' }
];

async function relayTest() {
  const out = { text: [], image: null };
  const targets = [
    { id: 'nhentai-json', url: 'https://nhentai.net/api/v2/search?query=fate', what: 'nhentai API' },
    { id: 'wnacg-html', url: 'https://www.wnacg.com/', what: '紳士漫畫首页' }
  ];

  process.stdout.write('中继通道实测（文字/JSON）\n');
  for (const t of targets) {
    process.stdout.write('  ── ' + t.what + '\n');
    for (const rel of RELAYS) {
      /* eslint-disable no-await-in-loop */
      const pure = t.url.replace(/^https?:\/\//i, '');
      const via = rel.tpl.indexOf('{rawurl}') >= 0
        ? rel.tpl.replace('{rawurl}', pure)
        : rel.tpl.replace('{url}', encodeURIComponent(t.url));
      const r = await fetchVia(via, 25000);
      let note = '';
      if (r.ok && r.buf) {
        const body = r.buf.toString('utf8');
        if (/^\s*[{[]/.test(body)) {
          try { const j = JSON.parse(body); note = 'JSON keys=' + Object.keys(j).slice(0, 4).join(','); }
          catch (e) { note = '声称 JSON 但解析失败'; }
        } else if (/<html/i.test(body)) {
          note = 'HTML ' + body.length + 'B';
        } else { note = '正文：' + body.slice(0, 40).replace(/\s+/g, ' '); }
      }
      const okMark = r.ok && r.bytes > 0 ? C.ok + 'OK ' + C.off : C.bad + 'FAIL' + C.off;
      process.stdout.write('    ' + okMark + ' ' + rel.id.padEnd(14) +
        'http=' + (r.status || '-') + ' ' + String(r.bytes || 0) + 'B ' + String(r.ms) + 'ms ' +
        (r.error || '') + (note ? '  ' + note : '') + '\n');
    }
  }

  /* 图片中继：真图地址都从 upstream 现取，不用编的地址（编的地址 404 会被误判成中继不通） */
  process.stdout.write('\n中继通道实测（图片）\n');
  const imgUrls = [];
  const jr = await fetchVia(RELAYS[0].tpl.replace('{url}',
    encodeURIComponent('https://nhentai.net/api/v2/search?query=fate')), 25000);
  if (jr.ok) {
    try {
      const j = JSON.parse(jr.buf.toString('utf8'));
      const row = (j.result || [])[0] || {};
      const media = String(row.media_id || '');
      const thumb = String(row.thumbnail || '');
      if (thumb) imgUrls.push({ id: 'nhentai 缩略图', url: /^https?:/i.test(thumb) ? thumb : ('https://t.nhentai.net/' + thumb.replace(/^\/+/, '')) });
      if (media) imgUrls.push({ id: 'nhentai 正文页', url: 'https://i.nhentai.net/galleries/' + media + '/1.jpg' });
    } catch (e) { /* 解析失败就用下面的固定目标 */ }
  }
  imgUrls.push({ id: 'E-Hentai 图标', url: 'https://e-hentai.org/favicon.ico' });
  imgUrls.push({ id: 'Danbooru 图床(对照)', url: 'https://cdn.donmai.us/original/8a/2f/8a2f0f0f0f0f0f0f0f0f0f0f0f0f0f0f.jpg' });

  const variants = [
    { id: 'i0.wp.com', tpl: 'https://i0.wp.com/{rawurl}' },
    { id: 'allorigins', tpl: 'https://api.allorigins.win/raw?url={url}' },
    { id: 'wsrv.nl', tpl: 'https://wsrv.nl/?url={url}&n=-1' }
  ];
  out.image = [];
  for (const target of imgUrls) {
    process.stdout.write('  ' + target.id + '：' + target.url + '\n');
    for (const v of variants) {
      /* eslint-disable no-await-in-loop */
      const pure = target.url.replace(/^https?:\/\//i, '');
      const via = v.tpl.indexOf('{rawurl}') >= 0
        ? v.tpl.replace('{rawurl}', pure)
        : v.tpl.replace('{url}', encodeURIComponent(target.url));
      const r = await fetchVia(via, 30000);
      const isImg = /^image\//i.test(r.type || '');
      const okMark = (r.ok && isImg) ? C.ok + 'OK ' + C.off : C.bad + 'FAIL' + C.off;
      const body = (!isImg && r.buf) ? r.buf.toString('utf8').slice(0, 120).replace(/\s+/g, ' ') : '';
      process.stdout.write('    ' + okMark + ' ' + v.id.padEnd(11) + 'http=' + (r.status || '-') + ' ' +
        String(r.bytes || 0) + 'B ' + String(r.ms) + 'ms type=' + (r.type || '-') +
        (r.error ? ' ' + r.error : '') + (body ? '  ← ' + body : '') + '\n');
      out.image.push({ target: target.id, relay: v.id, ok: !!(r.ok && isImg), status: r.status, bytes: r.bytes, type: r.type, err: r.error });
    }
  }
  return out;
}

/* ------------------------------ 单 URL 直取 ------------------------------
   「这张图到底能不能取到」——分层体检回答不了（它只打 /）。
   这里按 Node 自己的 http/https 栈真发一次请求，把状态码 / 类型 / 字节数 / 错误原样报出来，
   并顺手把协议换成另一个再试一次（实测绅士漫画的图床就是「http 被重置、https 正常」）。 */
function fetchOne(rawUrl) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(rawUrl); } catch (e) { return resolve({ error: 'URL 不合法' }); }
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? httpsMod : httpMod;
    const t0 = Date.now();
    const req = mod.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search, method: 'GET', timeout: TIMEOUT * 2,
      headers: { 'user-agent': UA, accept: '*/*', referer: u.origin + '/', 'accept-encoding': 'identity' }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, type: res.headers['content-type'] || '',
        bytes: Buffer.concat(chunks).length, ms: Date.now() - t0,
        location: res.headers.location || ''
      }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ error: (e && (e.code || e.message)) || String(e), ms: Date.now() - t0 }));
    req.end();
  });
}

async function urlTest() {
  const raw = argOf('url');
  if (!raw) { process.stdout.write('--url 后面要给一个地址\n'); return; }
  const variants = [raw];
  if (/^http:\/\//i.test(raw)) variants.push(raw.replace(/^http:/i, 'https:'));
  else if (/^https:\/\//i.test(raw)) variants.push(raw.replace(/^https:/i, 'http:'));
  for (const v of variants) {
    /* eslint-disable no-await-in-loop */
    const r = await fetchOne(v);
    const good = !r.error && r.status >= 200 && r.status < 300;
    process.stdout.write((good ? C.ok + 'OK  ' + C.off : C.bad + 'FAIL' + C.off) + ' ' + v + '\n' +
      '        → ' + (r.error ? ('错误：' + r.error) : ('HTTP ' + r.status + '  ' + r.type + '  ' + r.bytes + 'B' +
        (r.location ? ('  Location: ' + r.location) : ''))) +
      '  ' + (r.ms || 0) + 'ms\n');
  }
}

/* ------------------------------ 输出 ------------------------------ */
const C = process.stdout.isTTY
  ? { ok: '\x1b[32m', warn: '\x1b[33m', bad: '\x1b[31m', dim: '\x1b[2m', off: '\x1b[0m' }
  : { ok: '', warn: '', bad: '', dim: '', off: '' };
const colorOf = v => (v === 'ok' ? C.ok : (v === 'unreachable' || v === 'sni-blocked' ? C.bad : C.warn));

function fmtDoh(rec) {
  return rec.doh.map(r => {
    if (r.error) return r.server + '✗';
    const n = (r.ips || []).length;
    return r.server + (n ? ':' + n : ':0');
  }).join(' ');
}

function line(rec) {
  const cc = colorOf(rec.verdict);
  const ips = (rec.perIp || []).map(r =>
    r.ip + (r.via === 'sysdns' ? '[sys]' : '[D:' + ((r.src || []).join(',') || '?') + ']') +
    (r.tls ? ('✓' + (r.status || '') + (r.empty ? '(空壳)' : (r.bytes ? '(' + r.bytes + 'B)' : '')))
      : (r.tcp ? '×TLS' : '×TCP'))).join(' ');
  return '  ' + cc + rec.verdict.padEnd(18) + C.off + rec.host.padEnd(46) +
    C.dim + (rec.kind || '').padEnd(14) + C.off + ips;
}

async function main() {
  if (argOf('url')) { await urlTest(); return; }
  if (has('relay')) {
    const r = await relayTest();
    if (AS_JSON) process.stdout.write(JSON.stringify({ ts: Date.now(), relay: r }, null, 2) + '\n');
    return;
  }
  let sites = SITES;
  const g = argOf('group');
  if (g) sites = sites.filter(s => s.group.indexOf(g) >= 0 || s.group === g);
  const h = argOf('host');
  if (h) {
    const want = h.split(',').map(x => x.trim()).filter(Boolean);
    sites = want.map(x => SITES.find(s => s.host === x) || { group: '自定义', host: x, kind: '' });
  }

  if (!AS_JSON) {
    process.stdout.write('出口可达性体检（超时 ' + TIMEOUT + 'ms/次）\n');
    process.stdout.write('判据：[sys]=系统 DNS 解析出的 IP，[D:解析器]=只有 DoH 能解析出（并注明是谁给的），' +
      '✓ 后面是 HTTP 状态码\n\n');
  }

  const results = [];
  const groups = [];
  sites.forEach(s => { if (groups.indexOf(s.group) < 0) groups.push(s.group); });

  for (const grp of groups) {
    const list = sites.filter(s => s.group === grp);
    if (!AS_JSON) process.stdout.write(C.dim + '── ' + grp + ' ' + '─'.repeat(Math.max(0, 40 - grp.length)) + C.off + '\n');
    for (const s of list) {
      /* eslint-disable no-await-in-loop */
      const rec = await probeHost(s);
      results.push(rec);
      if (!AS_JSON) process.stdout.write(line(rec) + '\n');
    }
    if (!AS_JSON) process.stdout.write('\n');
  }

  const tally = {};
  results.forEach(r => { tally[r.verdict] = (tally[r.verdict] || 0) + 1; });
  if (AS_JSON) {
    process.stdout.write(JSON.stringify({ ts: Date.now(), timeoutMs: TIMEOUT, doh: DOH, tally: tally, results: results }, null, 2) + '\n');
    return;
  }

  process.stdout.write('汇总：' + Object.keys(tally).map(k => k + '=' + tally[k]).join('  ') + '\n');
  const needHelp = results.filter(r => r.verdict !== 'ok');
  if (needHelp.length) {
    process.stdout.write('\n需要处理的站点：\n');
    needHelp.forEach(r => {
      const hint = {
        'dns-poisoned': '系统 DNS 被污染，但 DoH 解析出的真 IP 能带 SNI 直连 —— 网关加 DoH 解析即可救',
        'dns-poisoned-tls': 'DNS 被污染，且真 IP 上 TLS 也过不去 —— 换镜像域名或走代理',
        'sni-blocked': 'TCP 能通但 TLS 被重置（SNI 阻断）—— 只能换镜像域名或走代理',
        'http-blocked': 'TCP 通但应用层没响应 —— 多为站点风控 / 需要特定请求头',
        'unreachable': '所有 IP 都不通 —— 换镜像域名或走代理',
        'nxdomain': '解析不到 IP —— 域名已失效或解析被拦，换镜像'
      }[r.verdict] || '';
      process.stdout.write('  · ' + r.host + '（' + r.verdictZh + '）' + (hint ? '：' + hint : '') + '\n');
    });
  }
}

main().catch(e => { console.error('体检失败：', e); process.exit(1); });
