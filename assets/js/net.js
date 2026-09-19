/* ==========================================================================
   net.js — 网络层
   1) 统一超时 fetch（AbortController）
   2) 多代理链：直连 / 用户代理 / 公共代理（自动竞速挑选可用者 + 会话内记忆）
   3) 失败诊断：区分「站点不可达」与「站点可达但被跨域拦截」
   4) VPN / 网络环境探测与分级判定
   ========================================================================== */
(function (HS) {
  'use strict';
  const u = HS.u;
  const net = HS.net = {};

  /* ---------------- 基础请求 ---------------- */
  net.withTimeout = function (ms, fn) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), ms);
    return fn(ctrl.signal).finally(() => clearTimeout(timer));
  };

  net.fetch = function (url, opts, ms) {
    const o = Object.assign({
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      redirect: 'follow'
    }, opts || {});
    return net.withTimeout(ms || HS.settings.timeoutMs || 9000, signal => {
      o.signal = signal;
      return fetch(url, o);
    });
  };

  net.fetchText = function (url, opts, ms) {
    return net.fetch(url, opts, ms).then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    });
  };

  net.fetchJson = function (url, opts, ms) {
    return net.fetch(url, opts, ms).then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  };

  /* ---------------- CORS 代理链 ---------------- */
  /* 顺序即优先级；json:true 表示该代理把内容包进 JSON（需要解包） */
  net.PROXIES = [
    { id: 'allorigins-raw', name: 'AllOrigins', tpl: 'https://api.allorigins.win/raw?url={url}' },
    { id: 'codetabs', name: 'codetabs', tpl: 'https://api.codetabs.com/v1/proxy?quest={url}' },
    { id: 'allorigins-json', name: 'AllOrigins(JSON)', tpl: 'https://api.allorigins.win/get?url={url}', json: true },
    { id: 'corsproxy', name: 'corsproxy.io', tpl: 'https://corsproxy.io/?url={url}' },
    { id: 'isomorphic', name: 'isomorphic-git', tpl: 'https://cors.isomorphic-git.org/{rawurl}' },
    { id: 'thingproxy', name: 'thingproxy', tpl: 'https://thingproxy.freeboard.io/fetch/{rawurl}' },
    { id: 'local8080', name: '本地 :8080', tpl: 'http://127.0.0.1:8080/?url={url}' }
  ];
  net.PROXY_MAP = {};
  net.PROXIES.forEach(p => { net.PROXY_MAP[p.tpl] = p.name; });

  net.PRESETS = [
    { v: '', label: '不使用代理（仅直连）' },
    { v: 'auto', label: '自动挑选可用公共代理' },
    { v: 'https://api.allorigins.win/raw?url={url}', label: 'AllOrigins' },
    { v: 'https://api.codetabs.com/v1/proxy?quest={url}', label: 'codetabs' },
    { v: 'https://corsproxy.io/?url={url}', label: 'corsproxy.io' },
    { v: 'https://cors.isomorphic-git.org/{rawurl}', label: 'isomorphic-git' },
    { v: 'http://127.0.0.1:8080/?url={url}', label: '本地自建 :8080' },
    { v: '__custom__', label: '自定义…' }
  ];

  net.proxyName = function (tpl) {
    if (!tpl) return '';
    if (tpl === 'auto') return '自动挑选';
    return net.PROXY_MAP[tpl] || '自定义代理';
  };

  /** 把目标 URL 套上代理。支持 {url}（已编码）与 {rawurl}（原样） */
  net.via = function (url, tpl) {
    if (!tpl || tpl === 'auto') return url;
    if (tpl.indexOf('{url}') >= 0) return tpl.replace('{url}', encodeURIComponent(url));
    if (tpl.indexOf('{rawurl}') >= 0) return tpl.replace('{rawurl}', url);
    return tpl + encodeURIComponent(url);
  };

  net.userProxy = () => String(HS.settings.proxy || '').trim();
  net.hasProxy = () => !!net.userProxy();
  net._goodProxy = null;         // 会话内记住第一个可用的公共代理
  net._proxyDeadUntil = 0;       // 公共代理整条链都失败后的冷却截止时间
  net.lastRoute = '';            // 最近一次成功的取源通路（用于日志）

  net.proxiesDead = () => Date.now() < net._proxyDeadUntil;
  net.resetProxyHealth = function () { net._proxyDeadUntil = 0; net._goodProxy = null; };

  net.proxyMeta = function (tpl) {
    return net.PROXIES.find(p => p.tpl === tpl) || { name: net.proxyName(tpl), tpl, json: false };
  };

  /* 解包某些代理包在外层的 JSON（AllOrigins /get 接口） */
  function unwrap(text, meta) {
    if (!meta || !meta.json) return text;
    try {
      const j = JSON.parse(text);
      if (j && typeof j.contents === 'string') return j.contents;
    } catch (e) { /* 保持原样 */ }
    return text;
  }

  /**
   * 构造尝试序列。
   * proxyFirst=true 时先走代理（这些站点不返回 CORS 头，直连注定失败），直连放最后兜底。
   */
  net.buildAttempts = function (url, o) {
    const list = [];
    const push = (label, u2, meta) => { if (u2) list.push({ label, url: u2, meta: meta || null }); };
    const user = net.userProxy();
    const dead = net.proxiesDead();
    const auto = HS.settings.autoProxy !== false && !dead;
    const cacheTpl = net._goodProxy;
    const publicRest = net.PROXIES.filter(p => p.tpl !== user && p.tpl !== cacheTpl);
    /* 本地网关在线时它是第一优先：同源、带正确 Referer/UA，比公共代理可靠得多 */
    const gw = net.gateway && net.gateway.ok ? { gw: true } : null;
    const pushGw = () => { if (gw) push('本地网关', net.gateway.proxyUrl(url, url), gw); };

    if (o.proxyFirst) {
      pushGw();
      if (cacheTpl) push(net.proxyName(cacheTpl), net.via(url, cacheTpl), net.proxyMeta(cacheTpl));
      if (auto) publicRest.forEach(p => push(p.name, net.via(url, p.tpl), p));
      if (user && user !== 'auto') push(net.proxyName(user), net.via(url, user), net.proxyMeta(user));
      push('直连', url, null);
    } else {
      push('直连', url, null);
      pushGw();
      if (cacheTpl) push(net.proxyName(cacheTpl), net.via(url, cacheTpl), net.proxyMeta(cacheTpl));
      if (user && user !== 'auto') push(net.proxyName(user), net.via(url, user), net.proxyMeta(user));
      if (auto) publicRest.forEach(p => push(p.name, net.via(url, p.tpl), p));
    }
    const seen = {};
    return list.filter(a => (seen[a.url] ? false : (seen[a.url] = 1)));
  };

  /** 竞速所有公共代理，挑出第一个可用的并记忆 */
  net.autoPickProxy = async function () {
    const probe = 'https://api.mangadex.org/ping';
    const tasks = net.PROXIES.map(async p => {
      const t0 = u.now();
      try {
        const r = await net.fetch(net.via(probe, p.tpl), {}, 8000);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        await r.text();
        return { p, ms: u.now() - t0 };
      } catch (e) { return null; }
    });
    const done = (await Promise.all(tasks)).filter(Boolean).sort((a, b) => a.ms - b.ms);
    if (!done.length) { net._goodProxy = null; return null; }
    net._goodProxy = done[0].p.tpl;
    net._proxyDeadUntil = 0;
    return { proxy: net._goodProxy, name: done[0].p.name, ms: done[0].ms, all: done.map(d => d.p.name) };
  };

  /**
   * 带预算的智能取源：直连 / 用户代理 / 公共代理链，返回第一个成功的响应。
   * @param {string} url
   * @param {{json?:boolean, allowProxy?:boolean, proxyFirst?:boolean, ms?:number, budget?:number}} o
   */
  net.fetchSource = async function (url, o) {
    o = o || {};
    const per = o.ms || HS.settings.timeoutMs || 9000;
    const budget = o.budget || (o.proxyFirst ? 16000 : 13000);
    const allowProxy = o.allowProxy !== false;
    const attempts = allowProxy ? net.buildAttempts(url, o) : [{ label: '直连', url, meta: null }];
    const deadline = u.now() + budget;
    const errs = [];

    for (let i = 0; i < attempts.length; i++) {
      const at = attempts[i];
      const left = deadline - u.now();
      if (left < 1200) { errs.push('预算耗尽，跳过 ' + at.label); break; }
      const to = Math.min(per, left);
      let raw;
      try {
        const r = await net.fetch(at.url, {}, to);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        raw = await r.text();
      } catch (e) {
        const why = (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) ? '超时' : ((e && e.message) || e);
        errs.push(at.label + '：' + why);
        continue;
      }
      /* 命中公共代理则记下来，后续请求优先复用 */
      if (at.meta && at.meta.tpl && at.meta.tpl !== net.userProxy()) net._goodProxy = at.meta.tpl;
      net.lastRoute = at.label;

      if (o.json) {
        const body = unwrap(raw, at.meta);
        try { return JSON.parse(body); }
        catch (e) { errs.push(at.label + '：返回不是合法 JSON'); continue; }
      }
      return unwrap(raw, at.meta);
    }

    /* 全部失败 → 做一次可达性诊断，给出可执行的结论 */
    const diag = await net.diagnose(url);
    /* 如果连一个公共代理都没成功过，短时间冷却，避免每次检索都空跑整条代理链 */
    const hadProxyAttempt = attempts.some(a => a.meta);
    if (hadProxyAttempt && !net._goodProxy) net._proxyDeadUntil = Date.now() + 60000;
    const err = new Error(net.explainFailure(url, diag));
    err.diagnose = diag;
    err.detail = errs.slice(0, 4).join('；');
    throw err;
  };

  /** 站点可达性诊断：no-cors 能建立连接说明「网络通、只是被跨域拦」 */
  net.diagnose = async function (url) {
    if (!navigator.onLine) return 'offline';
    try {
      await net.withTimeout(5000, signal => fetch(url, {
        mode: 'no-cors', cache: 'no-store', credentials: 'omit',
        referrerPolicy: 'no-referrer', signal
      }));
      return 'cors-blocked';
    } catch (e) {
      return 'unreachable';
    }
  };

  net.explainFailure = function (url, diag) {
    let host = url;
    try { host = new URL(url).host; } catch (e) {}
    const fileHint = (typeof location !== 'undefined' && /^file:/.test(location.protocol))
      ? '；另外当前页面以 file:// 打开，跨域限制更严，建议用本地 HTTP 服务打开（python -m http.server 8777）'
      : '';
    const gwHint = GW.ok ? '' : '；禁漫/拷贝漫画 这类「需要签名 + 不返回跨域头」的站点，' +
      '最省事的解法是启动随附的本地网关：node tools/gateway.js，然后打开 http://127.0.0.1:' + GW.DEFAULT_PORT + '/';
    if (diag === 'offline') return '网络已断开，请检查网络或 VPN';
    if (diag === 'cors-blocked') {
      return host + ' 可以连通，但被浏览器跨域策略拦截，且当前所有 CORS 代理都不可用。' +
        '请改用可用代理或自建代理' + fileHint + gwHint;
    }
    return host + ' 完全不可达（可能被网络限制或被墙）。请开启 VPN，或换一个镜像域名' + fileHint + gwHint;
  };

  /** 手动测试一个代理地址是否可用 */
  net.testProxy = async function (tpl) {
    const target = 'https://api.mangadex.org/ping';
    const t0 = u.now();
    const r = await net.fetch(net.via(target, tpl), {}, 8000);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const txt = (await r.text()).trim().slice(0, 60);
    return { ms: u.now() - t0, body: txt };
  };

  /* ---------------- 探测目标 ---------------- */
  const TARGETS = [
    { id: 'domestic', label: '境内网络 (baidu)',      url: 'https://www.baidu.com/favicon.ico', kind: 'domestic' },
    { id: 'global',   label: '国际出口 (gstatic)',    url: 'https://www.gstatic.com/generate_204', kind: 'global' },
    { id: 'jmcomic',  label: '禁漫天堂',              url: 'https://18comic.vip/',     kind: 'target' },
    { id: 'wnacg',    label: '紳士漫畫',              url: 'https://www.wnacg.com/',   kind: 'target' },
    { id: 'ehentai',  label: 'E-Hentai',              url: 'https://e-hentai.org/',    kind: 'target' },
    { id: 'nhentai',  label: 'nhentai',               url: 'https://nhentai.net/',     kind: 'target' },
    { id: 'hitomi',   label: 'Hitomi',                url: 'https://hitomi.la/',       kind: 'target' },
    { id: 'mangadex', label: 'MangaDex API',          url: 'https://api.mangadex.org/ping', kind: 'target' }
  ];
  const PROBEABLE = ['mangadex', 'nhentai', 'ehentai', 'jmcomic', 'wnacg', 'hitomi'];

  net.ping = function (target, ms) {
    const t0 = u.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms || 3500);
    return fetch(target.url, {
      mode: 'no-cors', cache: 'no-store', credentials: 'omit',
      referrerPolicy: 'no-referrer', signal: ctrl.signal
    }).then(() => ({ id: target.id, label: target.label, kind: target.kind, ok: true, ms: u.now() - t0 }))
      .catch(() => ({ id: target.id, label: target.label, kind: target.kind, ok: false, ms: u.now() - t0 }))
      .finally(() => clearTimeout(timer));
  };

  net._cache = null;

  net.probe = async function (force) {
    const TTL = 45 * 1000;
    if (!force && net._cache && (Date.now() - net._cache.ts) < TTL) return net._cache;

    const targets = await Promise.all(TARGETS.map(t => net.ping(t)));
    const by = {};
    targets.forEach(r => { by[r.id] = r; });

    const ADULT = (function () {
      const on = HS.settings.sources || [];
      const ids = PROBEABLE.filter(id => on.indexOf(id) >= 0);
      return ids.length ? ids : PROBEABLE;
    })();
    const adult = ADULT.map(id => by[id]).filter(Boolean);
    let adultOk = adult.filter(r => r.ok).length;
    const anyTarget = adultOk > 0;
    let blocked = targets.filter(r => r.kind === 'target' && ADULT.indexOf(r.id) >= 0 && !r.ok);
    let blockedNames = blocked.map(r => r.label).join('、');

    let verdict, label, detail;
    if (!navigator.onLine) {
      verdict = 'offline'; label = '离线';
      detail = '浏览器报告网络已断开。请检查网络连接后重新检测。';
    } else if (adultOk === adult.length && adultOk > 0) {
      verdict = 'ok'; label = '目标可达';
      detail = '全部目标站点均可连通，无需额外操作。若结果为空，可能是查询词或标签问题。';
    } else if (adultOk > 0) {
      verdict = 'partial'; label = '部分站点受限';
      detail = adultOk + '/' + adult.length + ' 个目标站点可达，其余（' + blockedNames +
        '）连接失败。要在这些站点上检索，请在浏览器之外自行开启 VPN 后点击重新检测。';
    } else if (by.domestic.ok) {
      verdict = 'vpn-needed'; label = '建议开启 VPN';
      detail = '境内网络正常，但目标站点全部连接失败（典型的区域网络限制）。请在浏览器之外自行开启 VPN / 代理后点击重新检测。';
    } else if (by.global.ok) {
      verdict = 'vpn-needed'; label = '部分受限';
      detail = '国际出口可达，但目标站点连接失败，可能被 DNS 污染或需要代理。';
    } else {
      verdict = 'unknown'; label = '网络异常';
      detail = '所有探测目标均不可达，请确认已联网或已开启 VPN。';
    }

    let proxyOk = null;
    if (net.hasProxy() && net.userProxy() !== 'auto') {
      const url = net.via('https://api.mangadex.org/ping');
      const t0 = u.now();
      try {
        const r = await net.fetch(url, {}, 7000);
        proxyOk = { ok: true, ms: u.now() - t0, status: r.status };
      } catch (e) {
        proxyOk = { ok: false, ms: u.now() - t0, error: e.message };
      }
    }

    /* 网关在线时以网关的出口为准：浏览器的 no-cors 探针走的是浏览器自己的链路，
       被墙的站会误报「不可达」，而网关（带本地代理）其实能打到。 */
    if (GW.ok) {
      try {
        const d = (net._gwDiag && (Date.now() - net._gwDiagAt < 120000))
          ? net._gwDiag
          : await GW.get('/api/diag', {}, 30000);
        net._gwDiag = d; net._gwDiagAt = Date.now();
        const tg = d.targets || {};
        Object.keys(tg).forEach(k => {
          if (!tg[k] || !tg[k].ok) return;
          targets.forEach(t => {
            if (t.id === k && !t.ok) { t.ok = true; t.viaGateway = true; t.ms = tg[k].ms; }
          });
        });
        adultOk = adult.filter(r => r.ok).length;
        blocked = targets.filter(r => r.kind === 'target' && ADULT.indexOf(r.id) >= 0 && !r.ok);
        blockedNames = blocked.map(r => r.label).join('、');
        if (adultOk === adult.length && adultOk > 0) {
          verdict = 'ok'; label = '目标可达';
          detail = '全部目标站点均可连通（其中被墙的部分由本地网关出口打通），无需额外操作。';
        } else if (adultOk > 0) {
          verdict = 'partial'; label = '部分站点受限';
          detail = adultOk + '/' + adult.length + ' 个目标站点可达，其余（' + blockedNames + '）连接失败。' +
            '可在「筛选 → 本地网关」点「检测」跑一次网关自检，确认是不是出口的问题。';
        }
      } catch (e) { /* 自检失败不影响原本的判定 */ }
    }

    net._cache = {
      ts: Date.now(), verdict, label, detail, targets, blocked,
      vpnLikely: verdict === 'vpn-needed' || verdict === 'partial',
      adultOk, adultTotal: adult.length,
      domesticOk: !!(by.domestic && by.domestic.ok),
      globalOk: !!(by.global && by.global.ok),
      targetOk: anyTarget, proxyOk
    };
    HS.bus.emit('net:probe', net._cache);
    return net._cache;
  };

  /* ======================================================================
     GW —— 本地网关客户端
     禁漫/拷贝漫画 的官方 API 需要「自定义请求头 + 签名 + AES 解密」，
     浏览器受同源策略限制无法直接调用（这也是 jasmine / venera 这类项目
     全部是原生客户端的原因：它们用 Rust / 原生 socket 直连）。
     本项目的做法是附带一个零依赖的 Node 网关（tools/gateway.js）：
     浏览器只跟 127.0.0.1 说话，签名与解密都在网关里完成。
     ====================================================================== */
  const GW = net.gateway = {};
  GW.DEFAULT_PORT = 8788;
  GW.ok = false;
  GW.info = null;
  GW.base = '';
  GW._probedAt = 0;

  /** 网关地址：页面本身就是网关提供的同源页面时直接用同源 */
  GW.setting = function () {
    return String((HS.settings && HS.settings.gateway) || '').trim().replace(/\/+$/, '');
  };
  GW.candidates = function () {
    const cfg = GW.setting();
    const list = [];
    if (location.protocol === 'http:' || location.protocol === 'https:') list.push(location.origin);
    if (cfg) list.push(cfg);
    const port = GW.DEFAULT_PORT;
    ['127.0.0.1', 'localhost'].forEach(h => list.push('http://' + h + ':' + port));
    const seen = {};
    return list.filter(x => x && !seen[x] && (seen[x] = 1));
  };
  GW.url = function (path, params) {
    const base = GW.base || GW.setting() || ('http://127.0.0.1:' + GW.DEFAULT_PORT);
    const qs = Object.keys(params || {}).filter(k => params[k] != null && params[k] !== '')
      .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
    return base.replace(/\/+$/, '') + path + (qs ? '?' + qs : '');
  };

  /** 探测网关是否在线（逐个候选地址试） */
  GW.probe = async function (force) {
    if (!force && GW._probedAt && Date.now() - GW._probedAt < 20000) return GW.ok;
    GW._probedAt = Date.now();
    const cands = GW.candidates();
    for (let i = 0; i < cands.length; i++) {
      const base = cands[i];
      try {
        const r = await net.withTimeout(2000, signal => fetch(base + '/api/ping', {
          signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'
        }));
        if (!r.ok) continue;
        const j = await r.json();
        if (j && j.name === 'hs-gateway') {
          GW.ok = true; GW.base = base; GW.info = j;
          HS.bus.emit('net:gateway', { ok: true, base, info: j });
          return true;
        }
      } catch (e) { /* 下一个候选 */ }
    }
    GW.ok = false; GW.info = null;
    HS.bus.emit('net:gateway', { ok: false, base: '' });
    return false;
  };

  /** 调网关接口：同源时无跨域问题，跨源时网关会回 ACAO:* */
  GW.get = async function (path, params, ms) {
    const url = GW.url(path, params);
    const r = await net.fetch(url, {}, ms || 20000);
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try {
        const j = await r.json();
        if (j && j.error) msg = j.error;
      } catch (e) {}
      throw new Error(msg);
    }
    return r.json();
  };

  /** 调网关接口（POST JSON）：哔咔代登录这类需要请求体的接口用 */
  GW.post = async function (path, body, ms) {
    const url = GW.url(path);
    const r = await net.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    }, ms || 30000);
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try {
        const j = await r.json();
        if (j && j.error) msg = j.error;
      } catch (e) {}
      throw new Error(msg);
    }
    return r.json();
  };

  /** 让网关代取任意页面（带上正确的 Referer / UA，绕开跨域与防盗链） */
  GW.proxyUrl = function (url, referer) {
    return GW.url('/api/proxy', { url: url, referer: referer || '' });
  };

  GW.describe = function () {
    if (!GW.ok) return '本地网关未连接';
    const s = (GW.info && GW.info.sources) || [];
    return '本地网关已连接（' + s.join(' / ') + '）';
  };

})(window.HS);
