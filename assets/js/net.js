/* ==========================================================================
   net.js — 网络层
   1) 统一超时 fetch（AbortController）
   2) 多代理链：直连 / 用户代理 / 公共代理（自动竞速挑选可用者 + 会话内记忆）
   3) 失败诊断：区分「站点不可达」与「站点可达但被跨域拦截」
   4) 网络环境探测与分级判定（只在检索之前 / 网络变化时执行）
   ========================================================================== */
(function (HS) {
  'use strict';
  const u = HS.u;
  const net = HS.net = {};

  /* ---------------- 基础请求 ---------------- */
  /* 检索作用域（「新检索打断旧检索」的底层开关）
     ------------------------------------------------------------------
     一次检索会并发发出很多请求（多源 × 多候选串 × 代理链逐条重试），
     用户再次提交搜索时，旧的这一整批必须**当场让位**，而不是等它自己超时。
     做法：每次检索开一个 AbortController（scope），此后网络层发出的每个请求都把它
     自己的超时 controller 与 scope controller 串起来 —— scope 一 abort，
     这一批请求在同一帧内全部断掉（fetch 收到 AbortError）。
     ★范围是精确的★：只有检索会开 scope，探测 / 网关卡体检 / 封面图这些
     自己不带 scope 的请求一律不受影响；不存在「关一个把全站请求都掐了」的副作用。 */
  net._scope = null;
  net.openScope = function () {
    net.closeScope();
    net._scope = new AbortController();
    return net._scope;
  };
  net.closeScope = function () {
    const s = net._scope;
    net._scope = null;
    if (s && !s.signal.aborted) {
      try { s.abort(new DOMException('superseded', 'AbortError')); } catch (e) {}
    }
  };
  net.scopeSignal = function () {
    return net._scope ? net._scope.signal : null;
  };

  /** 把「本次调用的超时 controller」挂到 scope 上，返回解绑函数 */
  function linkScope(ctrl) {
    const sig = net.scopeSignal();
    if (!sig) return null;
    if (sig.aborted) {
      try { ctrl.abort(sig.reason); } catch (e) { try { ctrl.abort(); } catch (e2) {} }
      return null;
    }
    const onAbort = () => { try { ctrl.abort(sig.reason); } catch (e) { ctrl.abort(); } };
    try { sig.addEventListener('abort', onAbort, { once: true }); } catch (e) { return null; }
    return () => { try { sig.removeEventListener('abort', onAbort); } catch (e) {} };
  }

  net.withTimeout = function (ms, fn) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), ms);
    const unlink = linkScope(ctrl);
    return fn(ctrl.signal).finally(() => { clearTimeout(timer); if (unlink) unlink(); });
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

  /* ---------------- CORS 代理链 ----------------
     顺序即优先级。★这张表按**实测**维护（tools/netprobe.js --relay 会逐个体检）★：
       · AllOrigins raw / get：实测可用（能带回被墙站的 JSON / HTML / 图片），会限流所以两个都留
       · corsproxy.io      ：实测 HTTP 401（改成要 API key 了）→ 移出
       · api.codetabs.com  ：实测 SNI 阻断（TCP 通、TLS 被重置）→ 移出
       · cors.isomorphic-git.org：实测 403 拒绝代取 → 移出
       · thingproxy.freeboard.io：实测连不上 → 移出
     留着打不通的只会白吃每源的时间预算，所以一个都不留。 */
  net.PROXIES = [
    { id: 'allorigins-raw', name: 'AllOrigins', tpl: 'https://api.allorigins.win/raw?url={url}' },
    { id: 'allorigins-json', name: 'AllOrigins(JSON)', tpl: 'https://api.allorigins.win/get?url={url}', json: true },
    { id: 'local8080', name: '本地 :8080', tpl: 'http://127.0.0.1:8080/?url={url}' }
  ];
  net.PROXY_MAP = {};
  net.PROXIES.forEach(p => { net.PROXY_MAP[p.tpl] = p.name; });

  net.PRESETS = [
    { v: '', label: '不使用代理（仅直连）' },
    { v: 'auto', label: '自动挑选可用公共代理' },
    { v: 'https://api.allorigins.win/raw?url={url}', label: 'AllOrigins' },
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
   *
   * ★本地网关在线时不再叠加公共 CORS 代理链★（2026 实测教训）：
   *   网关自己就有「DoH 钉真 IP / 境内中继」两层，用的还是同一批中继（AllOrigins）；
   *   前端再并发打一遍，等于两边抢同一个限流配额 —— 实测把 AllOrigins 打成 429 之后，
   *   浏览器侧和网关侧**同时**全灭（一次检索能打出上百条 allorigins 请求：每个镜像每条路都试）。
   *   所以网关在线时只留「网关 → 直连」两条，把中继配额让给网关统一调度。
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

    if (gw) {
      if (o.proxyFirst) { pushGw(); push('直连', url, null); }
      else { push('直连', url, null); pushGw(); }
      /* 用户显式配了代理时仍然尊重它（放在网关之后，而不是被吞掉） */
      if (user && user !== 'auto') push(net.proxyName(user), net.via(url, user), net.proxyMeta(user));
      const seen0 = {};
      return list.filter(a => (seen0[a.url] ? false : (seen0[a.url] = 1)));
    }

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
      /* 检索已被新的搜索打断：立刻收手，别再逐条试代理（每次都会当场被 abort） */
      if (net.scopeSignal() && net.scopeSignal().aborted) {
        const st = new Error('检索已被新的搜索打断');
        st.superseded = 1;
        throw st;
      }
      const left = deadline - u.now();
      if (left < 1200) { errs.push('预算耗尽，跳过 ' + at.label); break; }
      const to = Math.min(per, left);
      let raw;
      try {
        const r = await net.fetch(at.url, {}, to);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        raw = await r.text();
      } catch (e) {
        if (net.scopeSignal() && net.scopeSignal().aborted) {
          const st = new Error('检索已被新的搜索打断');
          st.superseded = 1;
          throw st;
        }
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

    /* 全部失败 → 做一次可达性诊断，给出可执行的结论。
       被打断的检索不再诊断：那会多打一次网络，且结论对用户毫无意义。 */
    if (net.scopeSignal() && net.scopeSignal().aborted) {
      const st = new Error('检索已被新的搜索打断');
      st.superseded = 1;
      throw st;
    }
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
    if (diag === 'offline') return '网络已断开，请检查网络连接';
    if (diag === 'cors-blocked') {
      return host + ' 可以连通，但被浏览器跨域策略拦截，且当前所有 CORS 代理都不可用。' +
        '请改用可用代理或自建代理' + fileHint + gwHint;
    }
    return host + ' 浏览器直连不通（被 DNS 污染 / SNI 阻断，或被网络限制）。' +
      '本地网关自带三层补偿 —— 原路直连 → DoH 多解析器钉真 IP → 境内中继，' +
      '多数站（禁漫 / 拷贝 / 绅士 / hitomi / nhentai / E-Hentai）不依赖任何代理也能取到' +
      fileHint + gwHint;
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
    { id: 'copymanga', label: '拷贝漫画',             url: 'https://api.copy2000.online/', kind: 'target' },
    { id: 'wnacg',    label: '紳士漫畫',              url: 'https://www.wnacg.com/',   kind: 'target' },
    { id: 'ehentai',  label: 'E-Hentai',              url: 'https://e-hentai.org/',    kind: 'target' },
    { id: 'nhentai',  label: 'nhentai',               url: 'https://nhentai.net/',     kind: 'target' },
    { id: 'hitomi',   label: 'Hitomi',                url: 'https://hitomi.la/',       kind: 'target' },
    { id: 'danbooru', label: 'Danbooru',              url: 'https://danbooru.donmai.us/', kind: 'target' },
    { id: 'mangadex', label: 'MangaDex API',          url: 'https://api.mangadex.org/ping', kind: 'target' }
  ];
  const PROBEABLE = ['mangadex', 'nhentai', 'ehentai', 'jmcomic', 'copymanga', 'wnacg', 'hitomi', 'danbooru'];

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

  /** ★只读缓存★：检索主流程只看这个，绝不在这里发探测请求（见 app.js 的 doSearch 第 2 步）。
      没有缓存就返回 null，调用方自己决定要不要在后台补一次。 */
  net.probeCached = function () { return net._cache || null; };

  /** 缓存是不是已经过期（超过 TTL）—— 供「空闲时再补一次」判断，本身不发请求 */
  net.probeStale = function (ttlMs) {
    if (!net._cache) return true;
    return (Date.now() - net._cache.ts) > (ttlMs || NET_TTL);
  };

  const NET_TTL = 120 * 1000;

  net.probe = async function (force) {
    const TTL = NET_TTL;
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

    /* ★r17★ 在告诉用户「先启动本地网关」之前，先弄清网关到底在不在。
       真机实测（boot 里 probeNow 在 260ms、probeGateway 在 680ms）：网探针常常**先**把
       临时结论写进缓存，于是网关明明在跑、E-Hentai / 紳士漫畫 都能搜到，横幅却在叫用户去
       启动它 —— 用户据此以为「源坏了」。这里补一次同源 /api/ping（上限 1.2s，拿不到就按
       不在处理），临时文案才说得准。首次探过之后 _probedAt 有值，不会反复重试。 */
    if (!GW.ok && !GW._probedAt) {
      try {
        await Promise.race([GW.probe(true), new Promise(rs => setTimeout(rs, 1200))]);
      } catch (e) { /* 检测失败就当网关不在 */ }
    }

    let verdict, label, detail;
    if (!navigator.onLine) {
      verdict = 'offline'; label = '离线';
      detail = '浏览器报告网络已断开。请检查网络连接后重新检测。';
    } else if (adultOk === adult.length && adultOk > 0) {
      verdict = 'ok'; label = '目标可达';
      detail = '全部目标站点均可连通，无需额外操作。若结果为空，可能是查询词或标签问题。';
    } else if (adultOk > 0) {
      verdict = 'partial'; label = '部分站点受限';
      /* ★r17★ 这段是**临时结论**（浏览器侧探针最多 3.5s），而真正能把被墙站点打通的
         /api/diag 要几十秒。以前无论网关在不在，临时文案都叫用户「先启动本地网关」——
         真机实测：网关明明在跑、E-Hentai / 紳士漫畫 都能搜到，横幅却写着「先启动本地网关」，
         用户因此以为源坏了。网关已连接时改说人话（先例见 line 304 的 gwHint）。 */
      detail = adultOk + '/' + adult.length + ' 个目标站点可达，其余（' + blockedNames +
        '）浏览器直连失败。' +
        (GW.ok
          ? '本地网关已连接，正在用它逐个目标自检（DoH 钉真 IP / 中继），结论稍后自动更新' +
            '—— 浏览器直连不通 ≠ 这些源搜不到，检索会优先走网关。'
          : '先启动本地网关再点一次「检测」—— 网关会用 DoH 钉真 IP / 境内中继' +
            '尽量把它们也打通；也可以在「筛选 → CORS 代理」里换一条出口。');
    } else if (by.domestic.ok) {
      verdict = 'restricted'; label = '目标站点直连受限';
      detail = '本机网络正常，但目标站点浏览器直连全部失败（典型的 DNS 污染 / 区域限制）。' +
        (GW.ok
          ? '本地网关已连接，正在用它逐个目标自检，结论稍后自动更新；检索会优先走网关。'
          : '先启动本地网关（node tools/gateway.js 或 start-engine.cmd）再点「检测」：' +
            '网关会用 DoH 多解析器钉真 IP、必要时走境内中继，多数站不依赖任何代理也能取到数据。');
    } else if (by.global.ok) {
      verdict = 'restricted'; label = '部分受限';
      detail = '国际出口可达，但目标站点连接失败，多为 DNS 污染 —— 本地网关可用 DoH 钉真 IP 打通。' +
        (GW.ok ? '（本地网关已连接，检索会优先走网关）' : '');
    } else {
      verdict = 'unknown'; label = '网络异常';
      detail = '所有探测目标均不可达，请确认本机已联网（或代理设置是否正确）。';
    }

    /* ★先落一个「临时结论」★
       浏览器侧的探针最多 3.5s 就出结果，而下面的 /api/diag 是网关逐个目标跑
       DoH / 中继，慢的时候要几十秒。用户很可能在这中间就按了回车 ——
       临时结论先写进缓存，检索主流程读到的就不是 null，
       思维链上写的是真实的初步判定，而不是「后台检测中」。
       最终结论算完会整体覆盖它（同一个对象字段，语义一致）。 */
    net._cache = {
      ts: Date.now(), provisional: true, verdict, label, detail, targets, blocked,
      restrictedLikely: verdict === 'restricted' || verdict === 'partial',
      gatewayTiers: net._gwTiers || null, gatewayEgress: net._gwEgress || '',
      adultOk, adultTotal: adult.length
    };
    HS.bus.emit('net:probe', net._cache);      /* 临时结论也广播：右上角状态立刻跟上 */

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
          : await GW.get('/api/diag', {}, 20000);
        net._gwDiag = d; net._gwDiagAt = Date.now();
        const tg = d.targets || {};
        const tiers = {};
        Object.keys(tg).forEach(k => {
          if (!tg[k] || !tg[k].ok) return;
          tiers[k] = tg[k].via || '';
          targets.forEach(t => {
            if (t.id === k && !t.ok) { t.ok = true; t.viaGateway = true; t.via = tg[k].via; t.ms = tg[k].ms; }
          });
        });
        net._gwTiers = tiers;
        net._gwEgress = d.egress || '';
        adultOk = adult.filter(r => r.ok).length;
        /* ★r18★ 「这次没等到结论」（网关自检硬超时 unknown）与「被上游按出口 IP 限流封禁」
           （banned）都**不算打不通** —— 把它们写进 blocked 就是用户抱怨的那个误报：
           网关明明能取（第 17 轮已证 wnacg / hitomi 都能取），只是并行自检没在预算内等到答复。
           从 blocked 里摘出去，只在描述里照实说「另有 N 个没等到结论」。 */
        const softIds = Object.keys(tg).filter(k => tg[k] && (tg[k].unknown || tg[k].banned));
        blocked = targets.filter(r => r.kind === 'target' && ADULT.indexOf(r.id) >= 0 && !r.ok &&
          softIds.indexOf(r.id) < 0);
        blockedNames = blocked.map(r => r.label).join('、');
        /* 「网关靠哪一层打通的」：这里通常写满 doh / relay，
           文案要照实说「由本地网关打通」，不引导用户去开任何隧道。 */
        const handled = Object.keys(tiers).filter(k => tiers[k] === 'doh' || tiers[k] === 'relay');
        const handledText = handled.length
          ? '（其中 ' + handled.length + ' 个由本地网关打通：' + handled.slice(0, 4).join('、') +
            (handled.length > 4 ? ' 等' : '') + '）'
          : '';
        if (blocked.length === 0 && softIds.length) {
          /* 「一个都没验出打不通」就是可达 —— 剩下的只是自检没等到答复 / 被上游限流，
             都不该报警。这两种还要分开说：封禁有倒计时，会自己好。 */
          const banIds = softIds.filter(k => tg[k] && tg[k].banned);
          const unkIds = softIds.filter(k => tg[k] && tg[k].unknown);
          verdict = 'ok'; label = '目标可达';
          detail = adultOk + '/' + adult.length + ' 个目标站点可达' + handledText + '；' +
            (banIds.length
              ? '另有 ' + banIds.length + ' 个被上游按出口 IP 限流封禁（' + banIds.join('、') +
                '，静默一会儿自动恢复，不是站点坏了）'
              : '') +
            (banIds.length && unkIds.length ? '；' : '') +
            (unkIds.length
              ? '还有 ' + unkIds.length + ' 个这次没等到自检结论（' + unkIds.slice(0, 4).join('、') +
                (unkIds.length > 4 ? ' 等' : '') + '）—— 那是自检预算到了，不代表打不通，' +
                '检索时会按真实链路走，稍后自动复查'
              : '') + '。';
        } else if (adultOk === adult.length && adultOk > 0) {
          verdict = 'ok'; label = '目标可达';
          detail = '全部目标站点均可连通' + (handledText || '（被墙的部分由本地网关出口打通）') +
            '，无需额外操作。若结果为空，可能是查询词或标签问题。';
        } else if (adultOk > 0) {
          verdict = 'partial'; label = '部分站点受限';
          /* 被上游按出口 IP 限流封禁的（网关自检会带 banned 标记）要与「真打不通」分开说：
             前者有倒计时、静默之后自己会好；混在一起说会让人以为源坏了（第 17 轮的教训）。 */
          const bannedList = Object.keys(tg).filter(k => tg[k] && tg[k].banned);
          detail = adultOk + '/' + adult.length + ' 个目标站点可达' + handledText + '，其余（' +
            blockedNames + '）连网关也打不通' +
            (bannedList.length
              ? '；另有 ' + bannedList.join('、') + ' 被上游按出口 IP 限流封禁（不在上面这份名单里 ——' +
                '它有倒计时，静默之后自己会恢复）'
              : '') +
            ' —— 可在「筛选 → 本地网关」点「检测」看网关自检详情，或换一条 CORS 代理出口。';
        }
      } catch (e) { /* 自检失败不影响原本的判定 */ }
    }

    net._cache = {
      ts: Date.now(), provisional: false, verdict, label, detail, targets, blocked,
      restrictedLikely: verdict === 'restricted' || verdict === 'partial',
      gatewayTiers: net._gwTiers || null,
      gatewayEgress: net._gwEgress || '',
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

  /** ★r18 需求②④「从弹出网页开始」★ 预热：一进页面就让网关把出口自检 / DoH 钉 IP /
      中继选择 / 图片主机钉 IP 全部跑掉。
      · 结论直接塞进 net._gwDiag：随后 net.probe 的「网关段」就能**立刻**算出最终结论
        （而不是等 /api/diag 那几十秒），临时横幅也就不用弹了；
      · 用户第一次敲下关键词时，那条路已经是热的 —— 这笔钱付在弹窗时，不付在搜索时。
      失败一律静默（拿不到预热结果不影响任何功能，退回原来的 /api/diag 路径）。 */
  GW.warm = async function (ms) {
    if (!GW.ok) { try { await GW.probe(true); } catch (e) { return null; } }
    if (!GW.ok) return null;
    try {
      const d = await GW.get('/api/warm', {}, ms || 12000);
      /* ★只有 full 的那一份才配当自检结论★：网关那边只要有一个目标是硬超时，
         就会把 full 置 false —— 把「没等出结论」当成「连网关也打不通」，
         正是用户抱怨的那个误报。不 full 就不落 _gwDiag，随后 net.probe 会退回真正的
         /api/diag（那时横幅仍然不弹，因为 gateway 在线 + 临时结论被 showBanner 拦掉）。 */
      if (d && d.full && d.targets && Object.keys(d.targets).length) {
        net._gwDiag = d; net._gwDiagAt = Date.now();
        const tiers = {};
        Object.keys(d.targets).forEach(k => {
          if (d.targets[k] && d.targets[k].ok) tiers[k] = d.targets[k].via || '';
        });
        net._gwTiers = tiers;
        net._gwEgress = d.egress || '';
      }
      if (d) {
        net._gwUpstream = d.upstream || null;
        HS.bus.emit('net:warm', d);
      }
      return d;
    } catch (e) { return null; }
  };

  /** ★r18 需求③★ 批量预取阅读器接下来要看的页。
      传进来的就是页盒上的 data-url（/api/proxy?url=…&referer=…）—— 网关会把它拆回
      (url, referer) 算缓存键，保证与真正取图时用的是**同一把 key**（否则预取全白做）。
      失败/超时静默：预取是「顺手把后面的图先搬回来」，绝不能影响当前页。 */
  GW.prefetch = function (urls, opt) {
    if (!GW.ok || !urls || !urls.length) return Promise.resolve(null);
    const o = opt || {};
    const list = urls.filter(Boolean).slice(0, o.max || 16);
    if (!list.length) return Promise.resolve(null);
    return GW.get('/api/prefetch',
      { urls: list.join('\n'), timeout: o.timeout || 9000 },
      o.ms || 20000).catch(() => null);
  };

  /** 浏览器自己是不是打不通这个信息源（探针结论 + 网关结论交叉判断）。
      网关的合并会把 t.ok 置回 true 并打上 viaGateway —— 那两个都算「浏览器直连不通」。 */
  net.browserBlocked = function (id) {
    const c = net._cache;
    if (!c || !c.targets) return false;
    const t = c.targets.filter(x => x.id === id)[0];
    return !!(t && (t.ok === false || t.viaGateway === true));
  };

  GW.describe = function () {
    if (!GW.ok) return '本地网关未连接';
    const s = (GW.info && GW.info.sources) || [];
    return '本地网关已连接（' + s.join(' / ') + '）';
  };

})(window.HS);
