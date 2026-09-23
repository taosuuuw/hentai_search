/* ============================================================================
   卡片 / 放大器的「从原站取回完整标签」
   ----------------------------------------------------------------------------
   问题（用户原话）：「小卡片和大卡片关于作品的标签展示太少，我希望可以从原网站获取标签
   并展示对应位置」。量过原因，是**两条不同的路**：
     ① 检索接口本身不带标签：nhentai 的 /api/v2/search 只回**数字 tag_ids**（网关里
        有注释记着「站点没有名字映射」），MangaDex 的检索口径也没把 tags 带出来 ⇒
        这些卡片原本恒显示「无标签」；
     ② 带回来的被截断：mk() 一刀切 slice(0,16)，卡片再只取前 6。
   于是：能从原站按作品 id 取到标签的源，就在这里补一路**只用于展示**的标签，
   存进 it.srcTags（**绝不写回 it.tags**）。这条边界是有意的：
   it.tags 参与「同系列/同标签」堆叠判定与跨源去重，放宽它的条数会连带改变堆叠与排序，
   属于「看着像顺手改、其实是另一件事」。

   ★哪些源走这里★（2026-09-22 实测）：
     nhentai    /api/proxy → https://nhentai.net/api/v2/galleries/<id>  实测 88 个带名字的标签
     mangadex   /api/proxy → https://api.mangadex.org/manga/<uuid>
     pixiv      /api/proxy → https://www.pixiv.net/ajax/illust/<id>（检索那份只有 16 条，
                            这里是完整的一份 —— 放大器的收益比卡片大）
     jmcomic / copymanga / ehentai → **网关的 /api/tags**（gateway.js 的 TAGS_SRC）：
       这三家的取法要 APP API 的 token / 自家请求头 / 站点自己的出口，走通用代理实测
       禁漫 403、拷贝要 com.copymanga.app- 头、E-Hentai 502，前端做不到。
   **还没接**：wnacg（镜像全挂，取法要那套镜像竞速）、hitomi / danbooru / porncomic /
   lectormanga / kemono（都不是本应用的检索源，卡片上基本不会出现）。

   ★不许打成请求风暴★（这是本文件存在的主要约束）：
     · 只有**进入视口**的卡片才去取（IntersectionObserver，一次性），一屏通常 6–12 张；
     · 同一时刻最多 2 个在飞，同一源两次请求至少隔 280ms
       —— nhentai 对同一出口 IP 很敏感（网关注释：连续十几次检索就开始 429）；
     · 结果按 source:id 落 localStorage，30 天内不再取（同一个作品反复出现、翻页回看、
       重新搜索都命中缓存）；
     · 某个源一旦 403/429/超时，整个源**冷却 5 分钟**，期间不再发请求（宁可标签晚点出现，
       也不要把出口 IP 打黑，那会连检索一起拖垮）；
     · 网关离线 / 该源没有取法 / 缓存已命中 ⇒ 一个请求都不发。
   失败是**静默**的：卡片保持原样（原来的「无标签」或 1–2 个分类），不弹错、不重试。
   ========================================================================== */
(function () {
  'use strict';
  const NS = (window.HS = window.HS || {});
  const u = NS.util || {};

  const LS_KEY = 'hs.wtag.v1';
  const TTL = 30 * 864e5;          /* 标签基本不随时间变，30 天足够 */
  const MAX_ENTRIES = 400;         /* 本地缓存上限（超出按插入序淘汰） */
  const MAX_PER_RUN = 60;          /* 一次检索里最多取多少个作品的标签 */
  const CONCURRENCY = 2;
  const GAP_MS = 280;              /* 同源两次请求的最小间隔 */
  const COOLDOWN_MS = 5 * 60e3;    /* 源级失败冷却 */
  const VIS_MARGIN = '260px';      /* 提前一屏开始取，滚到时通常已经就绪 */

  /* ---------------- 本地缓存 ---------------- */
  let store = null;
  function load() {
    if (store) return store;
    store = {};
    try {
      const j = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (j && typeof j === 'object' && j.v === 1 && j.m && typeof j.m === 'object') store = j.m;
    } catch (e) { /* 坏数据当没有 */ }
    return store;
  }
  let saveTimer = 0;
  function save() {
    /* 合并写：一批取回来只落盘一次（localStorage 是同步 IO，别每张卡写一次） */
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = 0;
      try {
        const m = load();
        const keys = Object.keys(m);
        if (keys.length > MAX_ENTRIES) {
          keys.sort((a, b) => (m[a].t || 0) - (m[b].t || 0));
          for (let i = 0; i < keys.length - MAX_ENTRIES; i++) delete m[keys[i]];
        }
        localStorage.setItem(LS_KEY, JSON.stringify({ v: 1, m: m }));
      } catch (e) { /* 配额满 / 隐私模式：静默 */ }
    }, 1200);
  }
  function cacheGet(key) {
    const e = load()[key];
    if (!e || !e.t || (Date.now() - e.t) > TTL) return null;
    return Array.isArray(e.tags) ? e.tags : null;
  }
  function cacheSet(key, tags) {
    load()[key] = { t: Date.now(), tags: tags };
    save();
  }

  /* ---------------- 每源的取标签口径 ----------------
     统一返回字符串数组（已经是可以直接显示的形态）；取不到就返回 []。 */
  const SRC = {};

  /* nhentai：v2 gallery 的 tags 是 [{type,name}]。type 有 category / language / parody /
     character / tag / artist / group / uploader。分类与语言卡片上已有角标、上传者对
     读者没意义、畫师/社团别处在显示 —— 只收 tag / character / parody / group。 */
  SRC.nhentai = function (it) {
    const url = 'https://nhentai.net/api/v2/galleries/' + encodeURIComponent(it.id);
    return gwJson(url, 'https://nhentai.net/').then(function (j) {
      const keep = { tag: 1, character: 1, parody: 1, group: 1 };
      const out = [];
      (j && j.tags || []).forEach(function (t) {
        const type = String((t && t.type) || '').toLowerCase();
        const name = String((t && t.name) || '').trim();
        if (name && keep[type]) out.push(name);
      });
      return out;
    });
  };

  /* MangaDex：attributes.tags[].attributes.name —— 英文优先，没有就取任意一种语言。 */
  SRC.mangadex = function (it) {
    const url = 'https://api.mangadex.org/manga/' + encodeURIComponent(it.id);
    return gwJson(url, 'https://api.mangadex.org/').then(function (j) {
      const out = [];
      ((j && j.data && j.data.attributes && j.data.attributes.tags) || []).forEach(function (t) {
        const n = (t && t.attributes && t.attributes.name) || {};
        const v = n.en || n.ja || n['zh-hk'] || n['zh-ro'] || Object.keys(n).map(k => n[k])[0] || '';
        if (v) out.push(String(v));
      });
      return out;
    });
  };

  /* pixiv：检索接口**本来就带标签**（适配器取 24 条、mk() 截到 16），但作品详情里的
     标签是完整的（实测同一个作品：检索 16 条 vs 详情 20+ 条），所以在放得下更多标签的
     放大器里有真实收益，卡片那 6 个一般看不出差别。 */
  SRC.pixiv = function (it) {
    const url = 'https://www.pixiv.net/ajax/illust/' + encodeURIComponent(it.id);
    return gwJson(url, 'https://www.pixiv.net/').then(function (j) {
      const box = ((j || {}).body || {}).tags || {};
      return (box.tags || []).map(t => (t && t.tag) || '').filter(Boolean);
    });
  };

  /* ---- 下面三个走网关的 /api/tags：它们的取法需要 token / APP 请求头 / 站点自己的出口，
     前端那条 /api/proxy 做不到（2026-09-22 实测：禁漫 403、拷贝要 com.copymanga.app- 头、
     E-Hentai 在通用代理下 502）。返回形状与其它接口一致：{ ok, tags }。 ---- */
  SRC.jmcomic = function (it) { return gwTags('jmcomic', it.id); };
  SRC.copymanga = function (it) { return gwTags('copymanga', it.id); };
  SRC.ehentai = function (it) { return gwTags('ehentai', it.id); };

  /* ---------------- 网关取数 ---------------- */
  function gwJson(url, referer) {
    const g = NS.net && NS.net.gateway;
    if (!g || !g.ok || typeof g.get !== 'function') return Promise.reject(new Error('网关离线'));
    /* /api/proxy 会把上游字节原样回给我们（带 content-type），所以这里直接当 JSON 解。
       Referer 必须显式给：代理缺省用的是本页 origin，nhentai / MangaDex 都会当场 403。 */
    return g.get('/api/proxy', { url: url, referer: referer }, 15000);
  }

  /* 网关自己的按源取标签路由（/api/tags?source=&id=）。失败也回 200 + { ok:false }，
     所以这里要把 ok 判一次，不能只看 HTTP 成功。 */
  function gwTags(source, id) {
    const g = NS.net && NS.net.gateway;
    if (!g || !g.ok || typeof g.get !== 'function') return Promise.reject(new Error('网关离线'));
    return g.get('/api/tags', { source: source, id: id }, 20000).then(function (j) {
      if (!j || j.ok === false) throw new Error((j && j.error) || '网关没有取到标签');
      return (j.tags || []).map(String).filter(Boolean);
    });
  }

  /* ---------------- 队列（并发 + 同源间隔 + 源级冷却） ---------------- */
  const q = [];
  let flying = 0, runCount = 0, runFirst = 0, lastBySrc = {};
  const cool = {};
  const SRC_OF = {};                 /* source -> 取法 */
  Object.keys(SRC).forEach(k => { SRC_OF[k] = SRC[k]; });

  function resetRunIfNeeded() {
    const now = Date.now();
    if (!runFirst || (now - runFirst) > 120000) { runFirst = now; runCount = 0; }
  }

  function pump() {
    while (flying < CONCURRENCY && q.length) {
      const now = Date.now();
      /* 队首若是因为「同源间隔 / 源冷却」还不能发，就往后找一个能发的 —— 但**不跳过**
         已经冷却的源，直接丢掉（它这一轮不会再成功）。 */
      let pick = -1;
      for (let i = 0; i < q.length; i++) {
        const t = q[i];
        if (cool[t.src] && cool[t.src] > now) { q.splice(i, 1); i--; continue; }
        const last = lastBySrc[t.src] || 0;
        if (now - last < GAP_MS) continue;
        pick = i; break;
      }
      if (pick < 0) {
        /* 全都还在等间隔：安排一次重试，别把队列卡死 */
        if (q.length) setTimeout(pump, GAP_MS);
        return;
      }
      const task = q.splice(pick, 1)[0];
      run(task);
    }
  }

  function run(task) {
    flying++;
    lastBySrc[task.src] = Date.now();
    let p;
    try { p = task.fn(task.it); } catch (e) { p = Promise.reject(e); }
    p.then(function (tags) {
      cacheSet(task.key, tags || []);
      task.done(tags || []);
    }, function () {
      /* 失败：这一张静默留白，并且**整个源**冷一会儿 —— 403/429 通常是源级的。 */
      cool[task.src] = Date.now() + COOLDOWN_MS;
      task.done(null);
    }).then(function () {
      flying--;
      setTimeout(pump, GAP_MS);
    });
  }

  function enqueue(it, done) {
    if (!it || !it.source || !it.id) return false;
    const src = String(it.source);
    if (!SRC_OF[src]) return false;
    const key = src + ':' + it.id;
    const hit = cacheGet(key);
    if (hit) { done(hit); return true; }
    if (cool[src] && cool[src] > Date.now()) return false;
    resetRunIfNeeded();
    if (runCount >= MAX_PER_RUN) return false;
    runCount++;
    q.push({ src: src, key: key, it: it, fn: SRC_OF[src], done: done });
    pump();
    return true;
  }

  /* ---------------- 对外：卡片用的一次性观察器 ---------------- */
  let io = null;
  function observer() {
    if (io) return io;
    if (typeof IntersectionObserver !== 'function') return null;
    io = new IntersectionObserver(function (ents) {
      ents.forEach(function (en) {
        if (!en.isIntersecting) return;
        io.unobserve(en.target);
        const job = en.target.__hsTagJob;
        en.target.__hsTagJob = null;
        if (job) job();
      });
    }, { rootMargin: VIS_MARGIN });
    return io;
  }

  const API = {
    /** 这个源能不能取到标签（不能就别在界面上留 loading 痕迹） */
    has: function (source) { return !!SRC_OF[String(source)]; },
    /** 卡片：进视口才取；取到就回调（回调收到的是标签数组） */
    observe: function (cardEl, it, done) {
      if (!cardEl || !API.has(it && it.source)) return false;
      const key = String(it.source) + ':' + it.id;
      const hit = cacheGet(key);
      if (hit) { done(hit); return true; }
      const fire = function () { enqueue(it, done); };
      const ob = observer();
      if (!ob) { fire(); return true; }
      cardEl.__hsTagJob = fire;
      ob.observe(cardEl);
      return true;
    },
    /** 放大器：立刻取（优先级高于卡片），命中缓存则同步回调 */
    enrich: function (it, done) {
      if (!it || !API.has(it.source)) return false;
      const key = String(it.source) + ':' + it.id;
      const hit = cacheGet(key);
      if (hit) { done(hit); return true; }
      return enqueue(it, done);
    },
    /* 诊断出口（与项目其它诊断一致：只读、挂 window） */
    diag: function () {
      return { queued: q.length, flying: flying, run: runCount, cool: Object.keys(cool).filter(k => cool[k] > Date.now()) };
    }
  };

  NS.cardTags = API;
})();
