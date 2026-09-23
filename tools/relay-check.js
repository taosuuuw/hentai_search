/* ==========================================================================
   tools/relay-check.js —— 自建中继套件的断言（离线，真起进程真转发，不碰外网）
   --------------------------------------------------------------------------
   用法：
     node tools/relay-check.js                # 静态协议检查 + 本机端到端（默认）
     node tools/relay-check.js --live=1       # 额外用配置好的中继打一次真目标
   为什么这么写：
     · 中继是本轮的「基础设施」，部署在墙外、用户点一下就好；但**协议必须先在本地验证**，
       否则用户部署完发现网关用不了，排查成本全落在用户身上（他看不到我们的日志）。
     · 所以这里起一个**假上游** http 服务 + 真起两个 tools/relay-server.js 进程：
         A 带 --allow-private（否则中继的 SSRF 防护会连假上游 127.0.0.1 一起拒掉）
           → 验「转发、透传、跟随重定向、key 鉴权、大正文完整性」
         B 用默认配置 → 验「SSRF 拒绝内网/环回/元数据/非 http 协议」，顺便钉住默认是安全的
     · 同时静态检查三个实现（Worker / Node / Deno）都带同一套协议标记，
       防止以后只改一处、三份实现悄悄漂移。
   退出码：失败 0 条 → 0，否则 1。与其它套件一样带 `if (require.main === module)` 守卫，
   可以被 tools/check-all.js 收编（它要求这个守卫）。
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

let PASS = 0, FAIL = 0;
function ok(name, cond, extra) {
  if (cond) { PASS++; console.log('PASS  ' + name); }
  else { FAIL++; console.log('FAIL  ' + name + (extra ? '  |  ' + String(extra).slice(0, 300) : '')); }
}
function readF(f) { try { return fs.readFileSync(path.join(__dirname, f), 'utf8'); } catch (e) { return ''; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, (res) => {
      const ch = [];
      res.on('data', (c) => ch.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(ch) }));
    });
    r.on('error', reject);
    r.setTimeout(15000, () => r.destroy(new Error('本地请求超时')));
    r.end(body);
  });
}
function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function waitPing(port, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await req({ host: '127.0.0.1', port, path: '/__hs/ping', method: 'GET' });
      if (r.status === 200) return JSON.parse(r.buf.toString('utf8'));
    } catch (e) { /* 还没起来 */ }
    await sleep(120);
  }
  return null;
}
/* 64KB 确定性正文（上游发什么、断言就算什么） */
function bigBody() {
  const b = Buffer.alloc(64 * 1024);
  for (let i = 0; i < b.length; i++) b[i] = (i * 31 + 7) & 0xff;
  return b;
}

async function main() {
  /* ─────────── ① 静态：三份实现都得带同一套协议标记 ─────────── */
  const worker = readF('relay-worker.mjs');
  const serverSrc = readF('relay-server.js');
  const deno = readF('relay-deno.ts');

  ok('中继实现：Worker 版存在且是 ES module 默认导出的 fetch', worker.indexOf('export default') >= 0 && /async fetch\(request, env\)/.test(worker));
  ok('中继实现：Worker 版支持 ?url= 与路径式两种目标写法', worker.indexOf("searchParams.get('url')") >= 0 && worker.indexOf('url.pathname.replace') >= 0);
  ok('中继实现：Worker 版带 SSRF 防护（内网 IP / 内网主机名单）', worker.indexOf('PRIVATE_V4') >= 0 && worker.indexOf('BAD_HOST') >= 0);
  ok('中继实现：Worker 版支持 key 鉴权（x-hs-key / ?k=）', worker.indexOf('x-hs-key') >= 0 && worker.indexOf('HS_RELAY_KEY') >= 0);
  ok('中继实现：Worker 版能转发 cookie（x-hs-h-cookie 白名单）', worker.indexOf("'cookie'") >= 0 && worker.indexOf('x-hs-h-') >= 0);
  ok('中继实现：Worker 版有 /__hs/ping（含出口 IP 自检）', worker.indexOf('/__hs/ping') >= 0 && worker.indexOf('api.ipify.org') >= 0);
  ok('中继实现：Worker 版响应带 x-hs-relay 身份头', worker.indexOf("out.set('x-hs-relay'") >= 0);

  ok('中继实现：Node 版存在且是零依赖内置模块', /require\('http'\)/.test(serverSrc) && serverSrc.indexOf('express') < 0 && serverSrc.indexOf('node-fetch') < 0);
  ok('中继实现：Node 版带 SSRF 防护 + DNS 解析后校验', serverSrc.indexOf('PRIVATE_V4') >= 0 && serverSrc.indexOf('dns.lookup') >= 0 && serverSrc.indexOf('isPrivateIp') >= 0);
  ok('中继实现：Node 版的内网转发后门默认关闭（--allow-private 只在自测里开）',
    serverSrc.indexOf("has('allow-private')") >= 0 && /const ALLOW_PRIVATE = has\('allow-private'\);/.test(serverSrc));
  ok('中继实现：Node 版支持 key 鉴权与 403', serverSrc.indexOf('x-hs-key') >= 0 && serverSrc.indexOf('403') >= 0);
  ok('中继实现：Node 版跟进重定向并带最大跳数', serverSrc.indexOf('MAX_REDIRECT') >= 0 && serverSrc.indexOf('up.headers.location') >= 0);
  ok('中继实现：Node 版流式转发（pipe 而不是全量缓冲）', serverSrc.indexOf('up.pipe(res)') >= 0);
  ok('中继实现：Node 版显式给 SNI（servername）', serverSrc.indexOf('servername') >= 0);

  ok('中继实现：Deno 版存在且用 Deno.serve', deno.indexOf('Deno.serve') >= 0);
  ok('中继实现：Deno 版协议与另两份一致（key/转发头/身份头/SSRF）',
    deno.indexOf('x-hs-key') >= 0 && deno.indexOf('x-hs-h-') >= 0 && deno.indexOf('x-hs-relay') >= 0 && deno.indexOf('PRIVATE_V4') >= 0);

  /* ─────────── ② 端到端：假上游 + 两台中继 ─────────── */
  const seen = [];
  const big = bigBody();
  const up = http.createServer((rq, rs) => {
    seen.push({ url: rq.url, headers: rq.headers });
    if (rq.url.startsWith('/ok')) {
      rs.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'max-age=60' });
      return rs.end(JSON.stringify({ ok: true, who: 'fake-upstream' }));
    }
    if (rq.url.startsWith('/redir')) { rs.writeHead(302, { location: '/ok' }); return rs.end(); }
    if (rq.url.startsWith('/e404')) { rs.writeHead(404, { 'content-type': 'text/plain' }); return rs.end('nope'); }
    if (rq.url.startsWith('/big')) { rs.writeHead(200, { 'content-type': 'application/octet-stream' }); return rs.end(big); }
    rs.writeHead(500); rs.end('unexpected');
  });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const upPort = up.address().port;

  const KEY = 'test-key-' + crypto.randomBytes(4).toString('hex');
  const children = [];
  async function startRelay(extraArgs) {
    const port = await freePort();
    const c = spawn(process.execPath, [path.join(__dirname, 'relay-server.js'),
      '--port=' + port, '--host=127.0.0.1', '--key=' + KEY].concat(extraArgs || []), { stdio: 'ignore' });
    children.push(c);
    return { port: port, child: c };
  }
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return; cleaned = true;
    children.forEach((c) => { try { c.kill(); } catch (e) { /* noop */ } });
    try { up.close(); } catch (e) { /* noop */ }
  };

  try {
    const A = await startRelay(['--allow-private']);   /* 转发用（假上游在 127.0.0.1） */
    const B = await startRelay([]);                    /* SSRF 用（默认配置） */
    const pa = await waitPing(A.port, 9000);
    const pb = await waitPing(B.port, 9000);
    ok('端到端：中继进程能起来并自报身份', !!(pa && pa.ok && pa.relay === 'hs-relay' && pb && pb.ok), JSON.stringify(pa || pb));
    if (!pa || !pb) throw new Error('中继没起来，后续端到端断言跳过');
    ok('端到端：/__hs/ping 不需要 key（方便部署后直接在浏览器确认）', pa.keyRequired === true);

    const enc = encodeURIComponent;
    const A_url = (t) => '/?url=' + enc(t) + '&k=' + KEY;
    const tgt = (p) => 'http://127.0.0.1:' + upPort + p;
    const rq = (port, p, headers) => req({ host: '127.0.0.1', port: port, path: p, method: 'GET', headers: headers });

    /* 正常转发 */
    const r1 = await rq(A.port, A_url(tgt('/ok')));
    ok('端到端：?url= 形式转发成功（key 正确）', r1.status === 200, 'status=' + r1.status + ' body=' + r1.buf.toString('utf8').slice(0, 120));
    ok('端到端：响应带 x-hs-relay 身份头', String(r1.headers['x-hs-relay'] || '').indexOf('hs-relay') === 0, r1.headers['x-hs-relay']);
    ok('端到端：上游正文逐字节透传', r1.buf.toString('utf8') === JSON.stringify({ ok: true, who: 'fake-upstream' }));
    ok('端到端：content-type / cache-control 原样透传',
      String(r1.headers['content-type']).indexOf('application/json') === 0 && String(r1.headers['cache-control']) === 'max-age=60',
      r1.headers['content-type'] + ' / ' + r1.headers['cache-control']);

    /* 头转发：cookie / referer（pixiv R-18 与 e-hentai 都靠这个） */
    seen.length = 0;
    await rq(A.port, A_url(tgt('/ok')), { 'x-hs-h-cookie': 'PHPSESSID=abc123', 'x-hs-h-referer': 'https://www.pixiv.net/' });
    const last = seen[seen.length - 1] || { headers: {} };
    ok('端到端：转发 cookie（x-hs-h-cookie → 上游 cookie）', last.headers.cookie === 'PHPSESSID=abc123', JSON.stringify(last.headers.cookie));
    ok('端到端：转发 referer（x-hs-h-referer → 上游 referer）', last.headers.referer === 'https://www.pixiv.net/', JSON.stringify(last.headers.referer));
    ok('端到端：中继自己的头不外发（x-hs-* / x-hs-key 不泄漏给上游）', last.headers['x-hs-h-cookie'] === undefined && last.headers['x-hs-key'] === undefined);

    /* 鉴权 */
    const r2 = await rq(A.port, '/?url=' + enc(tgt('/ok')) + '&k=wrong');
    ok('端到端：key 错误 → 403（不转发）', r2.status === 403, 'status=' + r2.status);
    const r3 = await rq(A.port, '/?url=' + enc(tgt('/ok')));
    ok('端到端：没带 key → 403', r3.status === 403, 'status=' + r3.status);

    /* 路径式 + 请求头带 key */
    const r4 = await rq(A.port, '/http://127.0.0.1:' + upPort + '/ok', { 'x-hs-key': KEY });
    ok('端到端：路径式目标 + x-hs-key 头 → 200', r4.status === 200, 'status=' + r4.status);

    /* 重定向 / 404 / 大正文 / 方法 */
    const r5 = await rq(A.port, A_url(tgt('/redir')));
    ok('端到端：跟随 302 到最终地址并成功', r5.status === 200 && String(r5.headers['x-hs-final'] || '').endsWith('/ok'), 'status=' + r5.status + ' final=' + r5.headers['x-hs-final']);
    const r6 = await rq(A.port, A_url(tgt('/e404')));
    ok('端到端：上游 404 原样透传（不吞成 502）', r6.status === 404, 'status=' + r6.status);
    const r7 = await rq(A.port, A_url(tgt('/big')));
    ok('端到端：64KB 正文完整性（流式转发的核心风险点）',
      r7.status === 200 && crypto.createHash('sha256').update(r7.buf).digest('hex') === crypto.createHash('sha256').update(big).digest('hex'),
      'got=' + r7.buf.length + ' expect=' + big.length);
    const r8 = await req({ host: '127.0.0.1', port: A.port, path: A_url(tgt('/ok')), method: 'POST' });
    ok('端到端：非 GET/HEAD → 405', r8.status === 405, 'status=' + r8.status);

    /* SSRF：一律打默认配置的 B 中继 */
    const r9 = await rq(B.port, A_url(tgt('/ok')));
    ok('端到端：默认配置拒绝转发到内网 IP（SSRF）', r9.status === 400, 'status=' + r9.status + ' body=' + r9.buf.toString('utf8').slice(0, 80));
    const r10 = await rq(B.port, A_url('http://localhost/x'));
    ok('端到端：默认配置拒绝 localhost 主机名（SSRF）', r10.status === 400, 'status=' + r10.status);
    const r11 = await rq(B.port, A_url('http://169.254.169.254/latest/meta-data/'));
    ok('端到端：默认配置拒绝云元数据地址 169.254.169.254', r11.status === 400, 'status=' + r11.status);
    const r12 = await rq(B.port, A_url('http://[::1]/x'));
    ok('端到端：默认配置拒绝 IPv6 环回 ::1', r12.status === 400, 'status=' + r12.status);
    const r13 = await rq(B.port, A_url('file:///C:/Windows/win.ini'));
    ok('端到端：拒绝非 http(s) 协议', r13.status === 400, 'status=' + r13.status);

    ok('端到端：上游确实收到了请求（不是中继自己造的假响应）', seen.length >= 1, 'seen=' + seen.length);
  } catch (e) {
    FAIL++;
    console.log('FAIL  端到端中断  |  ' + ((e && e.message) || e));
  } finally {
    cleanup();
  }

  /* ─────────── ③ 网关侧接入点（改完 gateway.js 后这几条才绿） ─────────── */
  const gw = readF('gateway.js');
  ok('网关接入：tools/gateway.js 会读 tools/relay.txt 里的私有中继', gw.indexOf('relay.txt') >= 0 && gw.indexOf('PRIVATE_RELAY') >= 0);
  ok('网关接入：支持 HS_GW_RELAY 环境变量（含 |key 语法）', gw.indexOf('HS_GW_RELAY') >= 0 && gw.indexOf('{url}') >= 0);
  ok('网关接入：私有中继排在公共中继前面被优先尝试', /id:\s*'private/.test(gw) && /unshift\(/.test(gw));
  ok('网关接入：带 cookie / 签名头的请求会跳过公共中继（只有自建中继能拿到凭据）',
    /needSecret\s*&&\s*!rel\.private/.test(gw) && /hasSecretHeaders\(o\)\s*&&\s*!PRIVATE_RELAY\.length/.test(gw));
  ok('网关接入：只有私有中继会把请求头以 x-hs-h-* 转发（cookie / referer 走这里）',
    /PRIVATE_FORWARD_HDR/.test(gw) && /'x-hs-h-'\s*\+\s*lk/.test(gw));
  ok('网关接入：私有中继请求带 x-hs-key', /reqHeaders\['x-hs-key'\]\s*=\s*rel\.key/.test(gw));
  ok('网关接入：/api/ping 会标出哪一条是私有中继', /private:\s*!!r\.private/.test(gw));
  ok('网关接入：没配自建中继时，启动日志如实说「无通路」而不是含糊过去', /自建中继：\*\*未配置\*\*/.test(gw));
  /* ★按 (中继 × 目标主机) 记忆（2026-09-23 第 12 轮）★
     自建中继的机房出口会被 nhentai / danbooru / jmcomic / pixiv 用 403 拒掉。
     旧逻辑让整条中继吃全局冷却 ⇒ 把 e-hentai / nhentai 一起拖死
     （实测：私有腿排进 relays[0] 后 nhentai 58.3% → 16.7%、e-hentai 8.3%）。
     下面几条钉住「4xx/私有 5xx 只惩罚 (中继,主机) 这一对，不冷却整条中继」。 */
  ok('网关接入：按 (中继 × 主机) 记住「被目标按出口 IP 挡掉」，腿循环会查这张表',
    /relayHostDead/.test(gw) && /RELAY_HOST_DEAD_MS/.test(gw) && /relayHostUsable\(rel\.id,\s*tHost\)/.test(gw));
  ok('网关接入：上游 4xx 只写 (中继,主机) 记忆，绝不写 relayState 全局冷却',
    /r\.status >= 400 && r\.status < 500/.test(gw) &&
    /relayHostDead\.set\(relayHostKey\(rel\.id, tHost\)/.test(gw) &&
    !/!r\.ok\)\s*\{\s*relayState\.set/.test(gw));
  ok('网关接入：私有中继 5xx 只对**那个主机**退避 90s（公共中继仍是全局 15s 软冷却，两档都在）',
    /rel\.private\)\s*\{[\s\S]{0,260}?RELAY_HOST_SOFT_MS/.test(gw) && /RELAY_SOFT_COOLDOWN\s*=\s*15e3/.test(gw));
  ok('网关接入：/api/ping 报出每条中继被挡掉的目标主机数（免得把「被挡」误判成「中继坏了」）',
    /blockedHosts:\s*relayHostBlockedCount\(r\.id\)/.test(gw));
  /* ★第二次事故（同日）：只修 4xx/5xx 不够 —— 私有腿**超时**那一支还在写全局冷却，
     nhentai/pixiv 的一次超时就把 private 冻 15s，而 e-hentai 只有它能走 ⇒ ehentai 8.3%。 */
  ok('网关接入：私有中继**超时/连不上**也只写 (中继,主机) 退避，不冻整条腿（公共中继仍全局）',
    /if \(rel\.private\) \{\s*relayHostDead\.set\(relayHostKey\(rel\.id, tHost\), Date\.now\(\) \+ RELAY_HOST_SOFT_MS\)/.test(gw) &&
    /else \{\s*relayState\.set\(rel\.id, Date\.now\(\) \+ RELAY_SOFT_COOLDOWN\);\s*errs\.push\(rel\.id \+ ' 连不上：'/.test(gw));
  /* ★第三次修正（同日）：光靠「撞了才知道」不够 —— 必败请求本身会把 Cloudflare 打到 429，
     private 整条腿吃 45s 全局冷却。所以把实测真值表预置成 (中继,主机) 退避。 */
  /* nhentai.net **不在**表里（2026-09-23 更正：它的 /api/v2/search 走私有腿是 200，
     只有 HTML 搜索页被 Cloudflare 挡；探针要打代码里那一行 URL）。 */
  ok('网关接入：预置「私有腿打不通的主机」真值表（danbooru/wnacg/jmcomic/pixiv/lectormanga，不含 nhentai）',
    /const PRIVATE_BLOCKED_HOSTS = \[/.test(gw) &&
    /'danbooru\.donmai\.us', 'www\.wnacg\.com', 'jmcomic\.me'/.test(gw) &&
    /'www\.pixiv\.net', 'lectormanga\.com'/.test(gw) &&
    !/PRIVATE_BLOCKED_HOSTS = \[[\s\S]{0,200}?'nhentai\.net'/.test(gw) &&
    /PRIVATE_RELAY\.forEach\(rel => PRIVATE_BLOCKED_HOSTS\.forEach\(h =>\s*relayHostDead\.set\(relayHostKey\(rel\.id, h\), Date\.now\(\) \+ RELAY_HOST_DEAD_MS\)\)\)/.test(gw));
  /* ★第五次修正（同日）：有自建中继时，e-hentai 的网络层冷却不能还是 3 分钟。
     r12d e-hentai 91.7%、r12e 16.7% —— 差别只是「第一轮抖了一下」，
     一次失败就把后面 10 轮全变成 14ms 的「冷却中」空结果。 */
  ok('网关接入：配了自建中继时 e-hentai 网络层冷却收到 25s（不再被一次抖动冻 3 分钟）',
    /const EH_NET_COOLDOWN_RELAY_MS = 25e3;/.test(gw) &&
    /function ehNetCooldownMs\(\) \{\s*return PRIVATE_RELAY\.length \? EH_NET_COOLDOWN_RELAY_MS : EH_NET_COOLDOWN_MS;/.test(gw) &&
    !/ehNetDownUntil = Date\.now\(\) \+ EH_NET_COOLDOWN_MS;/.test(gw) &&
    /* ★第 17 轮修正：拉闸时长取「网络冷却」与「上游封禁倒计时」的较大者（ehDownMs）——
       只按固定 25s 会让重试每 25s 再撞一次被封出口，把上游 5 分钟封禁刷成常驻
       （真机实测：静默 390s 后 478ms 就拿到 26 条，证明封禁是自己刷出来的）。 */
    /ehNetDownUntil = Date\.now\(\) \+ ehDownMs\(\);/.test(gw) &&
    /return Math\.max\(base, Math\.min\(30 \* 60e3, banLeft\)\);/.test(gw));
  /* ★第六次修正（同日）：私有腿上的 429 是**上游在限流**，不是中继坏了。
     r12f：e-hentai 连着 6 轮成功之后被一次 429 写了 45s 全局冷却，
     后面 5 轮全灭、nhentai 也被连坐 ⇒ 私有腿的 429 必须只退避 (中继 × 主机)。 */
  ok('网关接入：私有腿的 429 只退避「那一条腿 × 那一个站」，不冷却整条中继（公共中继维持 45s 全局）',
    /const RELAY_HOST_LIMIT_MS = 60e3;/.test(gw) &&
    /if \(rel\.private\) \{\s*relayHostDead\.set\(relayHostKey\(rel\.id, tHost\), Date\.now\(\) \+ RELAY_HOST_LIMIT_MS\);/.test(gw) &&
    /relayState\.set\(rel\.id, Date\.now\(\) \+ RELAY_COOLDOWN\);\s*\/\* ★429 要把正文说出来★/.test(gw));
  ok('网关接入：私有腿单独分预算（60%，上限 18s），不再被「平均分」饿死',
    /const perLegPrivate = Math\.max\(perLeg, Math\.min\(LEG_MAX, Math\.floor\(total \* 0\.6\)\)\)/.test(gw) &&
    /timeout: rel\.private \? legMs : \(legCap \? Math\.min\(perLeg, legCap\) : perLeg\)/.test(gw) &&
    /const legMs = Math\.max\(legPrivateMs, legFloor\);/.test(gw));
  /* ★第 16 轮新增★：porncomic 的私有腿预算与「偶发慢响应不锁死通路」三件套 ——
     ① relayLegMs 5000 → 7000（实测中继取 /tags/anal.html 1.6–2.9s、偶发 5.4s）；
     ② PC_RELAY_COOLDOWN 3 分钟 → 30 秒；
     ③ PC_HARD_MS 7500 → 9000（前端整源预算同步 8000 → 9500）。 */
  ok('网关接入：porn-comic 私有腿给 7s，失败只锁 30s，硬闸 9000 与前端 9500 对齐',
    /relayLegMs: 7000/.test(gw) &&
    /const PC_RELAY_COOLDOWN = 30e3;/.test(gw) &&
    /const PC_HARD_MS = 9000;/.test(gw) &&
    /relayLegMs: 7000/.test(gw));
  /* ★第 16 轮新增★：porn-comic 的入口顺序 —— `/tags/<slug>.html` 必须拍在 `/q/` 前面。
     实测：`/q/` 是跳板，词没有标签页时 302 到 `search.porn-comic.com`（CF 403「Just a moment...」），
     把 9000ms 总预算的第一次机会喂给它 ⇒ 第 2 个入口只剩 900ms ⇒ q=teen / q=big boobs 整轮硬闸。
     `/tags/teen.html` 实测 422ms / "teen no result"，`/tags/anal.html` 200 / 24 条。 */
  ok('网关接入：porn-comic 先走 /tags/<slug>（跳板 /q/ 排后面，诚实空结果不再超时）',
    /const slug = q \? pcSlug\(q\) : '';/.test(gw) &&
    /if \(slug\) tries\.push\('\/tags\/' \+ slug \+ '\.html'\);/.test(gw) &&
    gw.indexOf("if (slug) tries.push('/tags/' + slug + '.html');") <
      gw.indexOf("if (q) tries.push('/q/' + encodeURIComponent(q) + '-' + page + '.html');") &&
    /assets\/js\/sources\.js:1302 的 BUDGET/.test(gw));

  /* ─────────── ④ 一次性设置（relay-setup.js 状态机 + start-gateway.ps1 接线） ───────────
     为什么单独验它：用户只会在**第一次启动**看到这个向导，之后永远跳过。
     所以「判据错了」的代价极高 —— 要么每次启动都烦人，要么该问的时候不问。
     这一段的临时文件全放在系统临时目录，绝不碰仓库里的真实 tools/relay.txt。 */
  const os = require('os');
  const { spawnSync } = require('child_process');
  const rs = require(path.join(__dirname, 'relay-setup.js'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-relay-setup-'));
  const tmpState = path.join(tmpDir, '.relay-setup.json');
  const tmpRelay = path.join(tmpDir, 'relay.txt');

  ok('设置向导：地址校验（https / 本机 http 都收，ftp 与空串、带空格的不收）',
    rs.isValidRelayUrl('https://x.pages.dev') === true &&
    rs.isValidRelayUrl('http://127.0.0.1:8790') === true &&
    rs.isValidRelayUrl('ftp://x.pages.dev') === false &&
    rs.isValidRelayUrl('javascript:alert(1)') === false &&
    rs.isValidRelayUrl('https://x y.pages.dev') === false &&
    rs.isValidRelayUrl('') === false && rs.isValidRelayUrl('not-a-url') === false);
  ok('设置向导：能认出「本机中继」（本机中继救不了被墙的站，向导要能单独提醒）',
    rs.isLocalRelayUrl('http://127.0.0.1:8790') === true && rs.isLocalRelayUrl('http://localhost:8790') === true &&
    rs.isLocalRelayUrl('https://x.pages.dev') === false);
  ok('设置向导：解析 relay.txt 的行（# 注释与空行忽略；空格与 | 两种分隔都认）',
    rs.parseRelayLine('# 注释') === null && rs.parseRelayLine('   ') === null &&
    rs.parseRelayLine('https://a.pages.dev k1').key === 'k1' &&
    rs.parseRelayLine('https://a.pages.dev|k2').key === 'k2' &&
    rs.parseRelayLine('https://a.pages.dev').key === '');
  ok('设置向导：写 relay.txt 会覆盖而不是追加（重跑向导不留旧地址）',
    (function () {
      rs.writeRelayFile(tmpRelay, 'https://one.pages.dev', 'k1');
      rs.writeRelayFile(tmpRelay, 'https://two.pages.dev', 'k2');
      const r = rs.readRelayFile(tmpRelay);
      return r.entries.length === 1 && r.url === 'https://two.pages.dev' && r.key === 'k2';
    })());
  ok('设置向导：拒绝把非法地址写进 relay.txt',
    (function () { try { rs.writeRelayFile(tmpRelay, 'ftp://bad', ''); return false; } catch (e) { return true; } })());

  ok('设置向导：状态文件绝不保存 key（只记 status / method / url / 时间）',
    (function () {
      rs.writeState(tmpState, { status: 'configured', method: 'manual', url: 'https://one.pages.dev' });
      const raw = fs.readFileSync(tmpState, 'utf8');
      const keys = Object.keys(JSON.parse(raw)).sort().join(',');
      return keys === 'at,method,note,status,url,version' && raw.indexOf('SECRETKEY') < 0;
    })());
  ok('设置向导：状态机 —— 已配置 / 已选不再提醒 ⇒ 静默跳过（这就是「一次性」的判据）',
    rs.decide({ relayConfigured: true, state: { status: 'unset' } }).action === 'silent' &&
    rs.decide({ relayConfigured: false, state: { status: 'skipped' } }).action === 'silent' &&
    rs.decide({ relayConfigured: false, state: { status: 'skipped' }, interactive: true }).action === 'silent');
  ok('设置向导：状态机 —— 只在交互式窗口里问；非交互式绝不阻塞启动',
    rs.decide({ relayConfigured: false, state: { status: 'unset' }, interactive: false }).action === 'silent' &&
    rs.decide({ relayConfigured: false, state: { status: 'unset' }, interactive: true }).action === 'prompt' &&
    rs.decide({ relayConfigured: false, state: { status: 'deferred' }, interactive: false }).action === 'silent' &&
    rs.decide({ relayConfigured: false, state: { status: 'deferred' }, interactive: true }).action === 'prompt');
  ok('设置向导：配置文件丢了会重新问（状态说 configured 但 relay.txt 不在 ⇒ drift）',
    rs.decide({ relayConfigured: false, state: { status: 'configured' } }).action === 'prompt' &&
    rs.decide({ relayConfigured: false, state: { status: 'configured' } }).reason === 'drift-config-missing');
  ok('设置向导：坏掉的状态文件当「没设置过」处理，不炸',
    (function () {
      const bad = path.join(tmpDir, 'bad.json');
      fs.writeFileSync(bad, '{ 这不是 JSON');
      const st = rs.readState(bad);
      return st.status === 'unset' && st.corrupt === true;
    })());
  ok('设置向导：生成的 key 够长、字符集安全、每次都不一样',
    (function () {
      const a = rs.genKey(), b = rs.genKey();
      return a.length === 32 && /^[A-Za-z0-9]+$/.test(a) && a !== b;
    })());

  ok('启动脚本：start-gateway.ps1 真的会调向导，并且给了三个开关（跳过 / 强制 / 重置）',
    /relay-setup\.ps1/.test(readF('start-gateway.ps1')) &&
    /\$NoRelaySetup/.test(readF('start-gateway.ps1')) &&
    /\$RelaySetup/.test(readF('start-gateway.ps1')) &&
    /\$ResetRelaySetup/.test(readF('start-gateway.ps1')));
  ok('启动脚本：向导在**起引擎之前**跑（网关只在启动时读 relay.txt）',
    (function () {
      const s = readF('start-gateway.ps1');
      const iSetup = s.indexOf('relay-setup.ps1');
      const iStart = s.indexOf("Start-Process -FilePath $nodeCmd.Source");
      return iSetup > 0 && iStart > 0 && iSetup < iStart;
    })());
  ok('启动脚本：就绪后会读 /api/ping 的 relays，确认自建中继真的生效（而不是只看文件存在）',
    /\.relays/.test(readF('start-gateway.ps1')) && /Where-Object \{ \$_\.private \}/.test(readF('start-gateway.ps1')));
  ok('启动脚本：非交互式（输入被重定向）时向导不阻塞，直接记一笔跳过',
    /IsInputRedirected/.test(readF('relay-setup.ps1')) &&
    /Mark-State -Status 'deferred'/.test(readF('relay-setup.ps1')) &&
    /--mark=/.test(readF('relay-setup.ps1')) &&
    /* 自动化测试要能绕过那条保护（否则菜单在重定向输入下永远进不去） */
    /-AssumeInteractive/.test(readF('relay-setup.ps1')) && /if \(\$AssumeInteractive\) \{ return \$true \}/.test(readF('relay-setup.ps1')));
  const ps1Files = fs.readdirSync(__dirname).filter(function (f) { return /\.ps1$/i.test(f); });
  ok('启动脚本：所有 .ps1 都必须带 UTF-8 BOM',
    /* 本机实测：Windows PowerShell 5.1 对「无 BOM」的文件按 GBK 解码。中文全角字符的 UTF-8
       字节被两两当成 GBK 后，可能吃掉字符串的结束引号 ⇒ 整份脚本 ParserError 直接不执行
       （relay-setup.ps1 就这么炸过一次：Unexpected token 'Red' / Missing closing ')'）。
       带 BOM 才能让 PS 5.1 正确按 UTF-8 读；本仓库的写文件工具默认不写 BOM，所以这条要钉住。 */
    ps1Files.length > 0 && ps1Files.every(function (f) {
      const b = fs.readFileSync(path.join(__dirname, f));
      return b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF;
    }), ps1Files.join(', '));
  ok('启动脚本：调向导用「哈希表 splat」（数组 splat 会被 PS 5.1 当位置参数，实测把 -Auto 塞给 -Port）',
    /\$rsArgs = @\{ Auto = \$true; Port = \$Port \}/.test(readF('start-gateway.ps1')) &&
    /\$rsArgs\['Force'\] = \$true/.test(readF('start-gateway.ps1')) &&
    !/\$rsArgs = @\(/.test(readF('start-gateway.ps1')));
  ok('启动脚本：会自愈 —— 启动前发现 relay-setup.ps1 掉了 BOM 就就地补上（只加 3 字节，内容不变）',
    /\[IO\.File\]::ReadAllBytes\(\$RelaySetupScript\)/.test(readF('start-gateway.ps1')) &&
    /\[byte\[\]\]\(0xEF, 0xBB, 0xBF\) \+ \$rb/.test(readF('start-gateway.ps1')) &&
    /\[IO\.File\]::WriteAllBytes\(\$RelaySetupScript/.test(readF('start-gateway.ps1')));
  ok('向导：参数数组不能叫 $Args（PowerShell 自动变量会把 splat 顶成空 ⇒ node 收不到参数的静默故障）',
    !/param\(\[string\[\]\]\$Args\)/.test(readF('relay-setup.ps1')) &&
    /param\(\[string\[\]\]\$HelperArgs\)/.test(readF('relay-setup.ps1')) &&
    /@HelperArgs/.test(readF('relay-setup.ps1')));
  ok('向导：所有外部连通性判断都走 node，绝不用 PowerShell 的 Invoke-WebRequest',
    /* 本机实测：PS 5.1 的 Invoke-WebRequest 连不上任何外网 HTTPS（pages.dev / npm 源 / Cloudflare
       全部报「基础连接已经关闭」），而同一时刻 Node 全部 200 ⇒ 用它判断可达性会得出错误结论。
       文件里允许在注释里提到它，但不允许真的调用（调用长这样：Invoke-WebRequest -Uri / $x）。 */
    !/Invoke-WebRequest\s+(-|\(|\$)/.test(readF('relay-setup.ps1')) &&
    /--probe-hosting/.test(readF('relay-setup.ps1')) && /--verify/.test(readF('relay-setup.ps1')));
  ok('向导：菜单里有「自动部署 / 粘贴地址 / 自建 VPS / 本机自测 / 稍后再说」五种出路',
    /Invoke-Option1/.test(readF('relay-setup.ps1')) && /Invoke-Option2/.test(readF('relay-setup.ps1')) &&
    /Invoke-Option3/.test(readF('relay-setup.ps1')) && /LocalOnly/.test(readF('relay-setup.ps1')) &&
    /Invoke-Option5/.test(readF('relay-setup.ps1')) && /_worker\.js/.test(readF('relay-setup.ps1')));
  ok('向导：双击启动器会把参数透传进来（否则 -NoRelaySetup 这类开关到不了）',
    /%\\*/.test(readF('..\\start-engine.cmd')) || readF('..\\start-engine.cmd').indexOf('%*') >= 0);
  ok('向导：自动部署前先查登录状态，未登录就自己跑 wrangler login（wrangler 不会替你登录）',
    /wrangler@latest whoami/.test(readF('relay-setup.ps1')) &&
    /wrangler@latest login/.test(readF('relay-setup.ps1')) &&
    /not authenticated/.test(readF('relay-setup.ps1')));
  ok('向导：把「账号邮箱没验证」（CF 错误码 8000077）翻译成人话并给出解决步骤',
    /8000077/.test(readF('relay-setup.ps1')) &&
    /must been verified/.test(readF('relay-setup.ps1')) &&
    /Resend verification email/.test(readF('relay-setup.ps1')) &&
    /pages project create/.test(readF('relay-setup.ps1')));
  ok('向导：写完 Secret 会**再部署一次**（Pages 的 Secret 只对之后的新部署生效，否则 key 形同虚设）',
    /pages secret put HS_RELAY_KEY[\s\S]{0,1200}?pages deploy/.test(readF('relay-setup.ps1')) &&
    /Secret 只对\*\*之后的新部署\*\*生效/.test(readF('relay-setup.ps1')));
  ok('向导：--verify 认得出「给了 key 但中继说 keyRequired:false」（keyIgnored + warn 中文提示）',
    /keyIgnored:/.test(readF('relay-setup.js')) &&
    /keyRequired:false/.test(readF('relay-setup.js')) && /页面|重新部署/.test(readF('relay-setup.js')));
  /* 2026-09-23 实测：旧写法是「先 Save-Relay 再 Confirm-Relay」⇒ 地址/key 打错时 relay.txt 已经被
     改写、状态已变 configured，用户原来跑通的中继就此丢失，而且以后启动都自动跳过、再也不会问。
     现在必须**先验证、后落盘**：验证不过就一个字节都不动。 */
  ok('向导（第 13 处修正）：[1]/[2]/[3]/[4] 都是「先验证、后落盘」—— 验证不过绝不覆盖已经跑通的配置',
    /if \(-not \(Confirm-Relay -Url \$url -Key \$key\)\)[\s\S]{0,600}?if \(-not \(Save-Relay -Url \$url -Key \$key -Method 'manual'\)\)/.test(readF('relay-setup.ps1')) &&
    /if \(-not \(Confirm-Relay -Url \$host_ -Key \$key\)\)[\s\S]{0,600}?if \(-not \(Save-Relay -Url \$host_ -Key \$key -Method/.test(readF('relay-setup.ps1')) &&
    /Save-Relay -Url \$urlUse -Key \$key -Method 'cf-pages'/.test(readF('relay-setup.ps1')) &&
    /foreach \(\$c in \$cands\) \{ if \(Confirm-Relay -Url \$c -Key \$key\) \{ \$urlUse = \$c; break \} \}/.test(readF('relay-setup.ps1')) &&
    /\*\*不改动\*\*现有配置/.test(readF('relay-setup.ps1')) &&
    !/\$ok = Confirm-Relay -Url \$url -Key \$key\s*\n\s*if \(\$ok/.test(readF('relay-setup.ps1')));
  ok('向导：[1] 重跑时「项目已存在」（CF 8000002）当正常情况复用，不当作失败',
    /already exists\|8000002/.test(readF('relay-setup.ps1')) &&
    /已经存在 ⇒ 直接复用它/.test(readF('relay-setup.ps1')));
  /* 2026-09-23 实测：`@('…', '--project-name=' + $proj, '…')` 里逗号比 `+` 结合得紧，
     会被拆成两个参数 ⇒ wrangler 报 `Unknown argument: hs-relay-a7f3`（[1] 从来没跑通过的原因）。
     同一个坑在 Save-Relay 的 $hArgs 里踩过一次（:115 有注释），这是第二次。 */
  ok('向导（第 14 处修正）：wrangler 的 --project-name 必须在括号里拼好（逗号比 + 结合得紧，否则被拆成两个参数）',
    /\('--project-name=' \+ \$proj\)/.test(readF('relay-setup.ps1')) &&
    !/\$DeployDir, '--project-name=' \+ \$proj/.test(readF('relay-setup.ps1')));
  ok('向导：[1] 的项目创建输出临时切回 Continue 再 2>&1（Stop 偏好下 stderr 变终止错误、只留第一行，读不到 8000002）',
    /\$ErrorActionPreference = 'Continue'[\s\S]{0,400}?pages project create \$proj --production-branch=main 2>&1 \| Out-String/.test(readF('relay-setup.ps1')) &&
    /\$ErrorActionPreference = \$eap/.test(readF('relay-setup.ps1')));
  ok('向导：[1] 优先保存**生产别名** https://<项目名>.pages.dev（wrangler 输出里只有哈希 URL），别名验不过才退回本次部署 URL',
    /\$alias = 'https:\/\/' \+ \$proj \+ '\.pages\.dev'/.test(readF('relay-setup.ps1')) &&
    /if \(\$alias -ne \$url\) \{ \$cands \+= \$alias \}/.test(readF('relay-setup.ps1')) &&
    /\$cands \+= \$url/.test(readF('relay-setup.ps1')));
  /* 2026-09-23 实测的坑（本会话最贵的一个）：向导写 Secret 用的是
     `$key | & $npx --yes wrangler@latest pages secret put HS_RELAY_KEY --project-name=$proj`，
     **存进去的值不是 $key** —— secret put 照样报 `Success! Uploaded secret HS_RELAY_KEY`、
     /__hs/ping 也报 keyRequired:true，但用这个 key 打中继一律 403；key 的 10 种变形
     （+\r / +\n / +\r\n / ×2 / ×5 / 前后空格 / 双引号 / 前置 CRLF）也全部 403。
     worker 侧不做 trim（tools/relay-worker.mjs:106），所以存的就是另一个值。
     确定性的写法：key 写进**无换行**的临时文件，再用 cmd 的 `<` 交给 wrangler（实测立刻 200/pong）。 */
  ok('向导（第 15 处修正）：写 Secret 绝不用 `$key | & npx` 管道（实测存进去的不是 $key），改成无换行临时文件 + cmd 的 <',
    /\[IO\.File\]::WriteAllText\(\$keyFile, \$key/.test(readF('relay-setup.ps1')) &&
    /ComSpec \/c \$secCmd/.test(readF('relay-setup.ps1')) &&
    /pages secret put HS_RELAY_KEY --project-name=' \+ \$proj \+ ' < /.test(readF('relay-setup.ps1')) &&
    !/\$key \| & \$npx/.test(readF('relay-setup.ps1')));
  ok('向导：Secret 临时文件（含 key）用完立刻删，不留痕',
    /finally \{ Remove-Item \$keyFile -Force -ErrorAction SilentlyContinue \}/.test(readF('relay-setup.ps1')));
  /* 2026-09-23 实测：/__hs/ping 按设计**不需要 key**，所以只 ping 的验证永远证明不了 key 对不对
     —— 向导就这样把一份**用不了的 key** 写进了 relay.txt（relay-check --live=1 两条真目标全 FAIL，
     status=403 len=59 = 我们自己 Worker 的「需要正确的 key」JSON）。现在验真必须**带 key 再打一次
     代理请求**，key 不对就把 ok 置 false（于是「先验证、后落盘」这道闸门真的会拦住它）。 */
  ok('验真（第 15 处修正）：--verify 必须带 key 再打一次代理请求（/__hs/ping 不需要 key，证明不了 key 对不对）',
    /const KEY_PROBE_URL = 'https:\/\/api\.mangadex\.org\/ping'/.test(readF('relay-setup.js')) &&
    /if \(key && out\.keyRequired\) \{/.test(readF('relay-setup.js')) &&
    /'\/\?url=' \+ encodeURIComponent\(KEY_PROBE_URL\) \+ '&k=' \+ encodeURIComponent\(key\)/.test(readF('relay-setup.js')) &&
    /out\.keyOk = rk\.status === 200/.test(readF('relay-setup.js')) &&
    /out\.ok = false;[\s\S]{0,200}?key 不对/.test(readF('relay-setup.js')));
  ok('验证失败文案：优先显示 warn（key 不对时 status 是 200，只显示「HTTP 200」会把人带偏）',
    /if \(\$v\.warn\) \{ \$v\.warn \} elseif \(\$v\.err\)/.test(readF('relay-setup.ps1')) &&
    /key 已验真：带 key 的代理请求 HTTP 200/.test(readF('relay-setup.ps1')));
  ok('仓库卫生：relay.txt 与设置状态都在 .gitignore 里（含 key / 本机状态，绝不入库）',
    /tools\/relay\.txt/.test(readF('..\\.gitignore')) && /tools\/\.relay-setup\.json/.test(readF('..\\.gitignore')));

  /* 真起 CLI 跑一遍：证明 node tools/relay-setup.js 这条命令行真的能用（不只是函数对） */
  const cliArgs = ['--state=' + tmpState, '--relay-file=' + tmpRelay];
  const rCli1 = spawnSync(process.execPath, [path.join(__dirname, 'relay-setup.js'), '--set-relay=https://cli.pages.dev', '--key=cliKey123', '--method=manual'].concat(cliArgs), { encoding: 'utf8' });
  /* ★沙箱/受限环境★：spawnSync 默认用管道捕获子进程输出，Windows 沙箱会拒（EPERM），
     子进程根本没起来 —— 这是环境限制、不是代码回归，必须如实报 SKIP 而不是伪装成 FAIL
     （否则这一套永远「5 条失败」，真回归就被淹没了）。普通机器上照常执行这四条。 */
  const cliBlocked = !!(rCli1 && rCli1.error && /^(EPERM|EACCES)$/.test(rCli1.error.code || ''));
  let cliSkipPrinted = false;
  const okCli = (name, pass, info) => {
    if (cliBlocked) {
      if (!cliSkipPrinted) {
        cliSkipPrinted = true;
        console.log('SKIP  设置向导 CLI：--set-relay / --status / --reset / --reset --remove-relay 四条' +
          '（本环境禁止捕获子进程输出：spawnSync ' + rCli1.error.code + '，CLI 未真跑）');
      }
      return;
    }
    ok(name, pass, info);
  };
  let cliJson1 = null; try { cliJson1 = JSON.parse(rCli1.stdout); } catch (e) { }
  okCli('设置向导 CLI：--set-relay 写文件 + 标记 configured（一次成功，退出码 0）',
    rCli1.status === 0 && !!cliJson1 && cliJson1.ok === true && cliJson1.state.status === 'configured',
    (rCli1.stdout || '') + (rCli1.stderr || ''));
  const rCli2 = spawnSync(process.execPath, [path.join(__dirname, 'relay-setup.js'), '--status', '--interactive=1'].concat(cliArgs), { encoding: 'utf8' });
  let cliJson2 = null; try { cliJson2 = JSON.parse(rCli2.stdout); } catch (e) { }
  okCli('设置向导 CLI：--status 判定「已配置 ⇒ 静默跳过」（第二次启动就不会再问）',
    rCli2.status === 0 && !!cliJson2 && cliJson2.relayConfigured === true &&
    cliJson2.decision.action === 'silent' && cliJson2.decision.reason === 'relay-configured' &&
    cliJson2.relayKeyPresent === true,
    (rCli2.stdout || '') + (rCli2.stderr || ''));
  const rCli3 = spawnSync(process.execPath, [path.join(__dirname, 'relay-setup.js'), '--reset'].concat(cliArgs), { encoding: 'utf8' });
  const rCli4 = spawnSync(process.execPath, [path.join(__dirname, 'relay-setup.js'), '--status', '--interactive=1'].concat(cliArgs), { encoding: 'utf8' });
  let cliJson4 = null; try { cliJson4 = JSON.parse(rCli4.stdout); } catch (e) { }
  okCli('设置向导 CLI：--reset 只清设置状态；relay.txt 还在 ⇒ 仍然静默跳过（配好了就不该再问）',
    rCli3.status === 0 && !!cliJson4 && cliJson4.state.status === 'unset' &&
    cliJson4.relayConfigured === true && cliJson4.decision.action === 'silent',
    (rCli4.stdout || ''));
  const rCli5 = spawnSync(process.execPath, [path.join(__dirname, 'relay-setup.js'), '--reset', '--remove-relay'].concat(cliArgs), { encoding: 'utf8' });
  const rCli6 = spawnSync(process.execPath, [path.join(__dirname, 'relay-setup.js'), '--status', '--interactive=1'].concat(cliArgs), { encoding: 'utf8' });
  let cliJson6 = null; try { cliJson6 = JSON.parse(rCli6.stdout); } catch (e) { }
  okCli('设置向导 CLI：--reset --remove-relay 之后真的回到「第一次运行」（能完整重走一遍向导）',
    rCli5.status === 0 && !!cliJson6 && cliJson6.state.status === 'unset' &&
    cliJson6.relayConfigured === false && cliJson6.decision.reason === 'first-run',
    (rCli6.stdout || ''));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { }

  /* ─────────── ⑤ 可选：打真目标 ─────────── */
  if (process.argv.indexOf('--live=1') >= 0) {
    const cfg = readPrivateRelay();
    if (!cfg) {
      console.log('SKIP  真目标：没配置私有中继（tools/relay.txt 或 HS_GW_RELAY），跳过');
    } else {
      /* 两个目标的验收口径不同（都是实测事实，不是「放宽判据」）：
         · https://e-hentai.org/ —— 本机出口是死路，自建中继是**唯一通路** ⇒ 必须 200 且正文够大，
           否则等于中继白建（2026-09-23 实测：HTTP 200 / 66348B / 1516ms）；
         · https://www.pixiv.net/ —— 对**数据中心出口**固定 403（正文是 Cloudflare WAF 的
           block_waf 页，见 tools/gateway.js:254 与 :599）。Cloudflare Pages 的中继出口同样是机房
           IP，所以这里 403 是**预期结果**，不是中继故障；只要「确实打到了 pixiv 并拿回那一页」
           就算这条通路如实打通。真变成 200 时打印 NOTE（那就该给 pixiv 也加中继腿）。 */
      const liveTargets = [
        { url: 'https://e-hentai.org/', must200: true },
        { url: 'https://www.pixiv.net/', must200: false, why: '机房出口固定 403（Cloudflare WAF）' },
      ];
      for (const t of liveTargets) {
        try {
          const r = await fetch(cfg.tpl(t.url), { redirect: 'follow' });
          const body = await r.text();
          const waf403 = r.status === 403 && body.length > 1000; // pixiv 的 WAF 页有 372KB
          const pass = t.must200 ? (r.status === 200 && body.length > 500) : (r.status === 200 || waf403);
          ok('真目标：' + t.url + ' 经私有中继' + (t.must200 ? '' : '（' + t.why + '）'),
            pass,
            'status=' + r.status + ' len=' + body.length +
            (!t.must200 && r.status === 200 ? ' ← NOTE：居然通了，可以考虑给 pixiv 也加中继腿' : ''));
        } catch (e) {
          ok('真目标：' + t.url + ' 经私有中继', false, (e && e.message) || e);
        }
      }
    }
  }

  console.log('\n中继套件：共 ' + (PASS + FAIL) + ' 条断言，失败 ' + FAIL);
  /* 与其它套件一致：把退出码交给 main() 自己设 —— tools/check-all.js 是在**同一进程**里
     编译执行各套件的 main()，并且靠接管 process.exit 来判断这一套有没有失败；
     如果这里只 return 不 exit，失败会被 check-all 报成「全绿」。 */
  process.exit(FAIL === 0 ? 0 : 1);
}

/* 与 gateway.js 完全相同的解析规则：tools/relay.txt 每行 `地址[ 空格或| key]`，或 HS_GW_RELAY */
function readPrivateRelay() {
  const items = [];
  try {
    const p = path.join(__dirname, 'relay.txt');
    if (fs.existsSync(p)) {
      fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line) => {
        const s = line.replace(/#.*$/, '').trim();
        if (s) items.push(s);
      });
    }
  } catch (e) { /* noop */ }
  String(process.env.HS_GW_RELAY || '').split(',').forEach((s) => { if (s.trim()) items.push(s.trim()); });
  if (!items.length) return null;
  const first = items[0];
  const parts = first.split('|').length > 1 ? first.split('|') : first.split(/\s+/);
  const url = parts[0].trim();
  const key = (parts[1] || '').trim();
  if (!/^https?:\/\//.test(url)) return null;
  return {
    url: url, key: key,
    tpl: (target) => (url.indexOf('{url}') >= 0
      ? url.replace('{url}', encodeURIComponent(target))
      : url + (url.indexOf('?') >= 0 ? '&' : '?') + 'url=' + encodeURIComponent(target) + (key ? '&k=' + encodeURIComponent(key) : '')),
  };
}

if (require.main === module) {
  main().then((c) => process.exit(c)).catch((e) => { console.log('FAIL  套件异常  |  ' + ((e && e.stack) || e)); process.exit(1); });
}
module.exports = { readPrivateRelay };
