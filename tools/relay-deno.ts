/* ==========================================================================
   tools/relay-deno.ts —— 自建中继（Deno Deploy / 任意 Deno 运行时）
   --------------------------------------------------------------------------
   协议与 tools/relay-worker.mjs / tools/relay-server.js 一致，三者可互换。
   什么时候用它：Cloudflare 不想用、也没有 VPS，但愿意点两下 Deno Deploy
   （deno.com/deploy，GitHub 登录即可，免费额度足够个人用）。

   部署：
     ① 打开 https://dash.deno.com/ → New Playground（或 New Project 连一个仓库）
     ② 把本文件内容粘进去 → Save & Deploy
     ③ 得到 https://<名字>.deno.dev —— 本机能否访问要实测（被墙的话换 Cloudflare Pages）
     ④ 建议在项目 Settings → Environment Variables 里设 HS_RELAY_KEY=<随机串>

   本地跑（调试用）：
     HS_RELAY_KEY=xxx deno run --allow-net --allow-env tools/relay-deno.ts
   自检：
     curl "https://<名字>.deno.dev/__hs/ping?ip=1"
   ========================================================================== */

const RELAY_NAME = 'hs-relay';
const RELAY_VERSION = '1.0.0';
const UPSTREAM_TIMEOUT_MS = 25000;
const FORWARD_HDR = ['cookie', 'referer', 'accept-language', 'user-agent', 'x-requested-with', 'accept'];
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const KEEP_RES_HDR = ['content-type', 'cache-control', 'etag', 'last-modified', 'expires',
  'content-disposition', 'content-range', 'accept-ranges'];
const MAX_REDIRECT = 8;

const PRIVATE_V4 =
  /^(0\.|10\.|127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|198\.18\.|198\.19\.|100\.(6[4-9]|[7-9][0-9]|1[0-2][0-7])\.|22[4-9]\.|23[0-9]\.|24[0-9]\.|25[0-5]\.)/;
const BAD_HOST =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.home\.arpa|metadata\.google\.internal|instance-data)$/i;

function isPrivateIp(ip: string): boolean {
  const s = ip.toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(s)) return PRIVATE_V4.test(s);
  return s === '::1' || s === '::' || /^fe80:/.test(s) || /^f[cd]/.test(s) ||
    /^::ffff:(127\.|10\.|192\.168\.|169\.254\.)/.test(s);
}

async function assertPublicTarget(u: string): Promise<string> {
  if (!/^https?:\/\//i.test(u)) throw new Error('只允许 http/https');
  const host = new URL(u).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (BAD_HOST.test(host)) throw new Error('拒绝内网主机：' + host);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    if (isPrivateIp(host)) throw new Error('拒绝内网 IP：' + host);
    return u;
  }
  /* 域名再解析一次（Deno Deploy 上 resolveDns 需要 --allow-net，控制台默认给） */
  try {
    const a = await Deno.resolveDns(host, 'A');
    if (a.some(isPrivateIp)) throw new Error('域名解析到内网地址，已拒绝：' + host);
  } catch (e) {
    if (String(e && (e as Error).message).indexOf('内网') >= 0) throw e;
    /* 解析不了就交给上游 fetch 去报错 */
  }
  return u;
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj, null, 1), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-hs-relay': RELAY_NAME + '/' + RELAY_VERSION,
    },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  const cfgKey = Deno.env.get('HS_RELAY_KEY') || Deno.env.get('RELAY_KEY') || '';
  const keyIn = req.headers.get('x-hs-key') || url.searchParams.get('k') || '';

  if (url.pathname === '/__hs/ping' || url.pathname === '/_hs/ping') {
    const out: Record<string, unknown> = {
      ok: true, relay: RELAY_NAME, version: RELAY_VERSION,
      keyRequired: !!cfgKey, time: new Date().toISOString(),
    };
    if (url.searchParams.get('ip')) {
      try {
        const r = await fetch('https://api.ipify.org?format=json');
        out.egressIp = (await r.json()).ip;
      } catch (e) { out.egressIpError = String(e && (e as Error).message || e); }
    }
    return json(out);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return json({ ok: false, error: '只支持 GET/HEAD' }, 405);
  if (cfgKey && keyIn !== cfgKey) return json({ ok: false, error: '需要正确的 key' }, 403);

  let target = '';
  try {
    target = url.searchParams.get('url') ? decodeURIComponent(url.searchParams.get('url')!) : '';
    if (!target) {
      const raw = url.pathname.replace(/^\/+/, '');
      if (raw) target = decodeURIComponent(raw) + (url.search || '');
    }
    target = await assertPublicTarget(target);
  } catch (e) {
    return json({ ok: false, error: String(e && (e as Error).message || e) }, 400);
  }

  const hdr: Record<string, string> = {
    accept: '*/*', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8', 'user-agent': BROWSER_UA,
  };
  for (const n of FORWARD_HDR) {
    const v = req.headers.get('x-hs-h-' + n);
    if (v) hdr[n] = v;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const up = await fetch(target, {
      method: req.method, headers: hdr, redirect: 'follow', signal: ac.signal,
    });
    const out = new Headers();
    for (const h of KEEP_RES_HDR) {
      const v = up.headers.get(h);
      if (v) out.set(h, v);
    }
    out.set('access-control-allow-origin', '*');
    out.set('access-control-expose-headers', '*');
    out.set('x-hs-relay', RELAY_NAME + '/' + RELAY_VERSION);
    out.set('x-hs-final', up.url || target);
    return new Response(req.method === 'HEAD' ? null : up.body, { status: up.status, headers: out });
  } catch (e) {
    return json({ ok: false, error: '上游取数失败：' + String(e && (e as Error).message || e), target }, 502);
  } finally {
    clearTimeout(timer);
  }
});
