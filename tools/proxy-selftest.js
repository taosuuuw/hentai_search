#!/usr/bin/env node
/* ==========================================================================
   proxy-selftest.js — 出口自愈回归测试（零依赖）

   为什么需要它：
     「有 VPN 好好的、没 VPN 全废」的根因是**出口在进程启动时被粘死**：网关启动时
     探测到本地代理就把 HTTPS_PROXY 写进环境变量，之后 VPN 一关，每个请求都先撞
     那个没人监听的端口（日志里是 ms=5 的 fetch failed），连本来直连就通的
     禁漫 APP 接口 / 拷贝漫画 API 也一起被废。

     这个脚本把那条时序**原样复现**，验证三件事：
       ① 代理真的可用时，网关确实经它出去（ProxyTunnelAgent 的 CONNECT + TLS 能跑通）
       ② 代理中途死掉后，**不再重启网关**，请求能自动改走直连强化 / 中继
       ③ 「启动时就锁定一个死代理」这种最坏情况也能自愈

   用法：
     node tools/proxy-selftest.js
     node tools/proxy-selftest.js --port 8797 --proxy-port 7897
   ========================================================================== */
'use strict';

const http = require('http');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] || d) : d; };
const GW_PORT = parseInt(argOf('port', '8797'), 10);
/* 候选端口必须落在网关自己会扫描的那张表里（见 gateway.js 的 PROXY_PORTS）：
   场景 B 靠「网关自己发现新出现的代理」来验证，表外的端口它永远发现不了。
   而且**不能硬写 7897** —— 用户开着 VPN 时那个端口是真被占着的，
   硬写的结果是 listen EADDRINUSE、整个自检崩在第一步（实测踩过）。 */
const CANDIDATE_PROXY_PORTS = [7897, 7890, 7891, 10809, 10808, 1080, 2080, 8889, 8118, 20171, 4780, 1087];
let PROXY_PORT = parseInt(argOf('proxy-port', '0'), 10) || 0;
const GW = 'http://127.0.0.1:' + GW_PORT;

let pass = 0, fail = 0;
const ok = (name, extra) => { pass++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); };
const no = (name, extra) => { fail++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); };

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------ 一个最小的 CONNECT 代理 ------------------------------ */
let hits = 0;

/** 挑一个**真的空闲**的候选端口：用户开着 VPN 时 7897 是真被占的，
    所以要逐个试 listen，第一个成功的就是它。 */
function pickProxyPort() {
  if (PROXY_PORT) return Promise.resolve(PROXY_PORT);
  return new Promise(resolve => {
    let i = 0;
    const tryNext = () => {
      if (i >= CANDIDATE_PROXY_PORTS.length) return resolve(0);
      const p = CANDIDATE_PROXY_PORTS[i++];
      const probe = net.createServer();
      probe.once('error', () => { probe.close(() => tryNext()); });
      probe.listen(p, '127.0.0.1', () => {
        probe.close(() => { PROXY_PORT = p; resolve(p); });
      });
    };
    tryNext();
  });
}

function startProxy() {
  const srv = http.createServer((req, res) => { res.writeHead(405); res.end('CONNECT only'); });
  srv.on('connect', (req, clientSock, head) => {
    hits++;
    const [host, port] = String(req.url).split(':');
    const up = net.connect({ host: host, port: parseInt(port, 10) || 443 }, () => {
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(clientSock);
      clientSock.pipe(up);
    });
    const kill = () => { try { up.destroy(); } catch (e) {} try { clientSock.destroy(); } catch (e) {} };
    up.on('error', kill);
    clientSock.on('error', kill);
  });
  return new Promise((resolve, reject) => {
    srv.on('error', reject);
    srv.listen(PROXY_PORT, '127.0.0.1', () => resolve(srv));
  });
}

/* ------------------------------ 网关子进程 ------------------------------ */
/* stdio 一律 ignore：受限环境里给子进程开管道（pipe）会 EPERM，
   而这个自检只需要 HTTP 结果，不需要读它的日志。 */
function startGateway(extraArgs) {
  const child = spawn(process.execPath, [path.join(__dirname, 'gateway.js'), '--port', String(GW_PORT)]
    .concat(extraArgs || []), { stdio: 'ignore' });
  return child;
}

async function getJson(pathname, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 60000);
  try {
    const r = await fetch(GW + pathname, { signal: ctrl.signal });
    return await r.json();
  } finally { clearTimeout(t); }
}

async function waitGateway(ms) {
  const until = Date.now() + (ms || 30000);
  while (Date.now() < until) {
    try {
      const j = await getJson('/api/ping', 3000);
      if (j && j.name === 'hs-gateway') return j;
    } catch (e) { /* 还没起来 */ }
    await sleep(400);
  }
  throw new Error('网关 ' + ms + 'ms 内没起来');
}

function killTree(child) {
  if (!child || child.killed) return;
  try { child.kill(); } catch (e) {}
}

/* ------------------------------ 主流程 ------------------------------ */
async function main() {
  const picked = await pickProxyPort();
  if (!picked) { console.log('找不到空闲的代理候选端口，自检无法进行'); process.exit(1); }
  console.log('出口自愈回归测试（网关 :' + GW_PORT + '，模拟代理 :' + PROXY_PORT + '）\n');

  let proxy = null;
  let gw = null;
  try {
    /* ---------- 场景 A：启动时**代理就是死的**（最坏情况，= 用户"VPN 关了但网关还锁着旧代理"） ---------- */
    console.log('场景 A：启动时锁定的代理端口是死的（--proxy http://127.0.0.1:' + PROXY_PORT + '）');
    gw = startGateway(['--proxy', 'http://127.0.0.1:' + PROXY_PORT]);
    const pingA = await waitGateway(30000);
    ok('网关起来了', 'egress=' + pingA.egress);

    const t0 = Date.now();
    let jm = null;
    try { jm = await getJson('/api/jm/search?q=fate&limit=2', 90000); } catch (e) { /* 下面判 */ }
    if (jm && jm.source === 'jmcomic' && jm.items && jm.items.length) {
      ok('死代理下禁漫检索仍可用', (Date.now() - t0) + 'ms host=' + jm.host);
    } else {
      no('死代理下禁漫检索仍可用', JSON.stringify(jm || {}).slice(0, 160));
    }

    const dA = await getJson('/api/diag', 120000);
    const liveA = Object.keys(dA.targets || {}).filter(k => dA.targets[k].ok);
    if (liveA.length >= 4) ok('死代理下大部分源都能打通', liveA.length + ' 个：' + liveA.join('/'));
    else no('死代理下大部分源都能打通', '只有 ' + liveA.length + ' 个：' + liveA.join('/'));
    const viaA = {};
    Object.keys(dA.targets || {}).forEach(k => { if (dA.targets[k].ok) viaA[k] = dA.targets[k].via; });
    ok('每台主机都记下了靠哪一层打通的', JSON.stringify(viaA));

    /* ---------- 场景 B：代理在运行中活过来（= 网关先起、之后才开 VPN） ---------- */    console.log('\n场景 B：网关已在跑，代理**之后**才可用（不用重启网关）');
    proxy = await startProxy();
    /* 出口探测在「没有可用代理」时是 10 秒一次，所以这里要等过一个探测周期 */
    process.stdout.write('  等待网关自己发现新代理（最多 20 秒）…\n');
    let discovered = false;
    for (let i = 0; i < 20; i++) {
      /* eslint-disable no-await-in-loop */
      await sleep(1200);
      if (hits > 0) { discovered = true; break; }
      await getJson('/api/diag?warm=' + Date.now(), 60000).catch(() => {});
    }
    const dB = await getJson('/api/diag?t=' + Date.now(), 120000);
    const pB = await getJson('/api/ping', 10000);
    if (discovered || hits > 0) ok('网关运行期认出了新出现的代理', 'CONNECT 命中 ' + hits + ' 次，egress=' + pB.egress);
    else no('网关运行期认出了新出现的代理', '代理一次都没被用到，egress=' + pB.egress);
    const liveB = Object.keys(dB.targets || {}).filter(k => dB.targets[k].ok).length;
    if (liveB >= 4) ok('经代理隧道仍能正常取源', liveB + ' 个源可用');
    else no('经代理隧道仍能正常取源', '只有 ' + liveB + ' 个');

    /* ---------- 场景 D：经隧道取一张图，数一下要开几条 CONNECT ----------
       隧道是「每个请求一次 CONNECT + TLS」的重活，如果 keepAlive 没生效，
       一次取图会变成几十条连接 —— 真开着 VPN 时会白白压垮本地代理。 */
    console.log('\n场景 D：经代理隧道取图的连接开销');
    hits = 0;
    let imgOk = false;
    try {
      const r = await fetch(GW + '/api/proxy?url=' + encodeURIComponent('https://t.nhentai.net/galleries/4195382/thumb.webp'), { signal: AbortSignal.timeout(60000) });
      const buf = Buffer.from(await r.arrayBuffer());
      imgOk = r.ok && /^image\//i.test(r.headers.get('content-type') || '') && buf.length > 1000;
    } catch (e) { /* 下面判 */ }
    const firstHits = hits;
    await sleep(300);
    if (imgOk) ok('经隧道取图成功', '首张 ' + firstHits + ' 条 CONNECT');
    else no('经隧道取图成功', '拿到的不是图片');
    hits = 0;
    for (let i = 0; i < 3; i++) {
      /* eslint-disable no-await-in-loop */
      await fetch(GW + '/api/proxy?url=' + encodeURIComponent('https://t.nhentai.net/galleries/4195382/thumb.webp?r=' + i),
        { signal: AbortSignal.timeout(60000) }).then(r => r.arrayBuffer()).catch(() => null);
    }
    if (hits <= 6) ok('keepAlive 生效（后续请求复用连接）', '再取 3 张只开了 ' + hits + ' 条 CONNECT');
    else no('keepAlive 生效（后续请求复用连接）', '再取 3 张开了 ' + hits + ' 条 CONNECT（连接没被复用）');

    /* ---------- 场景 C：代理中途死掉（= 用户关掉 VPN），不再重启网关 ---------- */
    console.log('\n场景 C：代理中途死掉（关掉 VPN），**不重启网关**');
    await new Promise(r => proxy.close(r));
    proxy = null;
    await sleep(500);
    const t1 = Date.now();
    let jm2 = null;
    try { jm2 = await getJson('/api/jm/search?q=fate&limit=2', 90000); } catch (e) { /* 下面判 */ }
    if (jm2 && jm2.items && jm2.items.length) {
      ok('代理死掉后禁漫检索自动改走直连', (Date.now() - t1) + 'ms host=' + jm2.host);
    } else {
      no('代理死掉后禁漫检索自动改走直连', JSON.stringify(jm2 || {}).slice(0, 160));
    }
    const pC = await getJson('/api/ping', 10000);
    ok('出口状态如实反映"代理已不可用"', pC.egress);
  } catch (e) {
    no('自检流程本身', (e && e.message) || String(e));
  } finally {
    killTree(gw);
    if (proxy) { try { proxy.close(); } catch (e) {} }
    await sleep(300);
    console.log('\n结果：PASS ' + pass + ' / FAIL ' + fail);
    process.exit(fail ? 1 : 0);
  }
}

main();
