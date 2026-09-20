/* ==========================================================================
   dict-hint.js — 黑话词典运行时（HS.dict）
   ---------------------------------------------------------------------------
   职责：把三个数据层合并成一条**纯旁路**判定，只产出提示用的 Hit，绝不改写查询词。
     · assets/dict/core.js        —— 核心层（同步就绪，HS.LEXICON）
     · assets/dict/ip/index.json  —— 包清单：每个包的 id + 锚点（= 懒加载触发词）
     · assets/dict/ip/*.json      —— IP 包，命中锚点才懒加载

   自述契约（本文件即契约，不依赖任何外部文档）：
     · C1 纯旁路：本文件不接触 #q / classifyQuery / S.termFor / 任何适配器。
       Hit.hintQuery 只交给 UI 渲染成 data-q chip，用户点了才由 app.js 既有的
       [data-q] 委托写回 #q。不点，发往上游的查询串一个字节都不会变。
     · C2 无用户层：不读写 localStorage，不做共现学习，不提供自建词表入口。
     · C3 不防扒：词表随包发布；stats() 只给 console 用，不做 UI 入口。
     · C4 词典异常不得影响检索：任何状态（清单 404 / 包损坏 / schema 不认识 /
       网关没起 / fetch 不存在）一律静默降级，lookup 永不抛异常，load 永不 reject。
     · C5 零依赖、零构建：传统 <script>，非 ES Module，无第三方库。

   锚点与懒加载（这里的「锚点」= 触发词）：
     · pending（该懒加载哪个包）由 assets/dict/ip/index.json **清单驱动**；
       清单里没有的包，仍按 core.js 的 anchors 映射表兜底（向后兼容）。
     · 包内 anchors 只在包**已经加载之后**参与资格判定，不触发加载。
     · 清单是懒的：**没有检索就不会有任何额外请求**；清单缺失/坏 → 静默回落到
       只有 core.js 映射表的行为。
     · 公开接口（冻结，不得改签名）：lookup / load / loaded / stats / useGateway /
       tier / pick / describe / chipsHTML / ariaText / terms。
   ========================================================================== */
(function (HS) {
  'use strict';
  if (!HS) return;

  const SCHEMA = 1;                  /* 认识的包 schema 版本；不认识就丢弃该包 */
  const IP_DIR = 'assets/dict/ip/';  /* 内置 IP 包目录（与内置层同构，改完刷新即生效） */
  const CORE_PKG = 'core';
  const MAX_Q = 600;                 /* 超长输入保护 */
  const MANIFEST_FILE = 'index.json';/* 包清单文件名：id + 锚点/触发词 */
  const MANIFEST_URL = IP_DIR + MANIFEST_FILE;
  const PROBE = '@manifest';         /* 内部占位 id：只用来让 load() 等一次清单就绪 */
  const PRE_FETCH_MAX = 3;           /* 低优先预取上限：一次会话最多补拉几个无触发词的包 */

  const pkgs = {};                   /* pkgId -> {id, name, ver, anchors, entries, src} */
  const loadedIds = [];              /* 成功加载的包 id（顺序即加载顺序） */
  const loading = {};                /* pkgId -> Promise（避免重复拉取） */
  const failures = {};               /* pkgId -> 失败原因，只给 stats() 看，不影响行为 */
  let gatewayBase = '';              /* 开发期热加载根（默认空 = 不做任何额外请求） */

  /* 包清单状态（清单只在一次检索里才会被请求） */
  let manifest = null;               /* { list: [{id, anchors:[]}], ids: [id, …] } */
  let manifestState = 'idle';        /* idle | loading | ready | failed（failed 后不再请求） */
  let manifestPromise = null;
  let prefetchQueued = false;        /* 低优先预取：一次会话只排一次 */
  let lastQuery = '';                /* 最近一次 lookup 的词：清单到齐后按它补解析锚点 */

  /* ---------------- 基础工具 ---------------- */
  function lex() {
    const L = HS.LEXICON;
    return (L && typeof L === 'object') ? L : null;
  }

  function str(v) { return v == null ? '' : String(v); }

  /** 逐字符小写：保证与原串 1:1 对位（少数会变长的字符保持原样） */
  function lower1to1(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charAt(i), l = c.toLowerCase();
      out += (l.length === 1 ? l : c);
    }
    return out;
  }

  function isAsciiWord(s) { return /^[\x20-\x7e]+$/.test(s); }
  function isWordChar(c) { return !!c && /[0-9a-z_]/.test(c); }

  /** 英文整词匹配的词边界（中文 from 允许包含匹配，英文不允许，避免 foot 命中 football） */
  function wordBounded(s, at, len) {
    const before = at > 0 ? s.charAt(at - 1) : '';
    const after = at + len < s.length ? s.charAt(at + len) : '';
    return !isWordChar(before) && !isWordChar(after);
  }

  function findOccurrences(text, needle, ascii) {
    const out = [];
    if (!text || !needle || needle.length > text.length) return out;
    let from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at < 0) break;
      if (!ascii || wordBounded(text, at, needle.length)) out.push(at);
      from = at + 1;                 /* 允许重叠命中，重复项交给去重收敛 */
    }
    return out;
  }

  /**
   * 匹配用的「视图」：原文（逐字符小写）与谐音归一化后的串。
   * 归一化只为判定服务，map[] 把归一化串的下标映回原文下标，
   * 因此 Hit.from / Hit.span 永远取自用户原文。
   */
  function variantsOf(q, H) {
    const out = [{ text: lower1to1(q), map: null }];
    const hom = H && H.homophone;
    if (!hom || typeof hom !== 'object') return out;
    const keys = Object.keys(hom).filter(k => k).sort((a, b) => b.length - a.length);
    if (!keys.length) return out;
    const lows = keys.map(k => ({ k: k, low: lower1to1(k) }));
    let text = '', map = [], changed = false, i = 0;
    while (i < q.length) {
      let hit = '';
      for (let n = 0; n < lows.length; n++) {
        const it = lows[n];
        if (i + it.k.length > q.length) continue;
        if (lower1to1(q.substr(i, it.k.length)) === it.low) { hit = it.k; break; }
      }
      const repl = hit ? lower1to1(str(hom[hit])) : '';
      if (hit && repl) {
        changed = true;
        for (let j = 0; j < repl.length; j++) {
          text += repl.charAt(j);
          map.push(i + Math.min(j, hit.length - 1));
        }
        i += hit.length;
      } else {
        text += lower1to1(q.charAt(i));
        map.push(i);
        i++;
      }
    }
    if (changed && text !== out[0].text) out.push({ text: text, map: map });
    return out;
  }

  /* ---------------- hintQuery 生成 ---------------- */
  function findConcept(key) {
    const want = str(key).toLowerCase().trim();
    if (!want) return null;
    const list = HS.CONCEPTS || [];
    for (let i = 0; i < list.length; i++) {
      if (str(list[i] && list[i].key).toLowerCase() === want) return list[i];
    }
    return null;
  }
  function findGenre(key) {
    const want = str(key).toLowerCase().trim();
    if (!want) return null;
    const list = HS.GENRES || [];
    for (let i = 0; i < list.length; i++) {
      if (str(list[i] && list[i].key).toLowerCase() === want) return list[i];
    }
    return null;
  }
  /** 取 NS.SERIES 里的规范写法（通常是英文小写）；不在表里就不产出 chip */
  function findSeries(v) {
    const want = str(v).toLowerCase().trim();
    if (!want) return '';
    const list = HS.SERIES || [];
    for (let i = 0; i < list.length; i++) {
      if (str(list[i]).toLowerCase() === want) return str(list[i]);
    }
    return '';
  }

  /**
   * 用户点提示后会填进 #q 的词：必须是一个**现有链路能正确理解**的词。
   * 找不到对应词条就返回空串 —— 该 Hit 不产出 chip，绝不退化成填英文 key。
   */
  function hintQueryFor(to, kind) {
    const t = (to && typeof to === 'object') ? to : null;
    if (!t) return '';
    if (t.concept) {
      const c = findConcept(t.concept);
      return c ? str(c.zh || c.en || '') : '';
    }
    if (t.genre) {
      const g = findGenre(t.genre);
      return g ? str(g.label || '') : '';
    }
    if (t.series) return findSeries(t.series);
    if (t.character) return str(t.character);
    return '';                       /* attr / term 等：本期不产出 chip */
  }

  /* ---------------- 匹配 ---------------- */
  function makeHit(q, e, span, pkg, src, variants) {
    const from = q.slice(span[0], span[1]);
    const to = (e.to && typeof e.to === 'object') ? e.to : null;
    const kind = str(e.kind) || (to ? Object.keys(to)[0] : '');
    return {
      from: from,
      span: [span[0], span[1]],
      to: to,
      kind: kind,
      label: str(e.label) || from,
      conf: (typeof e.conf === 'number' && isFinite(e.conf)) ? e.conf : 0.5,
      ambiguous: !!e.ambiguous,
      src: src,
      pkg: pkg,
      why: str(e.why),
      hintQuery: hintQueryFor(to, kind)
    };
  }

  function matchEntries(q, entries, pkg, src, variants) {
    const out = [];
    if (!entries || !entries.length) return out;
    for (let n = 0; n < entries.length; n++) {
      const e = entries[n];
      if (!e || typeof e.from !== 'string') continue;
      const from = str(e.from).trim();
      if (!from) continue;
      const low = lower1to1(from);
      const ascii = isAsciiWord(low);
      for (let v = 0; v < variants.length; v++) {
        const view = variants[v];
        const at = findOccurrences(view.text, low, ascii);
        for (let k = 0; k < at.length; k++) {
          const pos = at[k];
          const s = view.map ? view.map[pos] : pos;
          const eIdx = view.map ? view.map[pos + low.length - 1] : (pos + low.length - 1);
          if (s == null || eIdx == null) continue;
          out.push(makeHit(q, e, [s, eIdx + 1], pkg, src, variants));
        }
      }
    }
    return out;
  }

  function dedupe(hits) {
    const seen = {};
    const out = [];
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      if (!h.span || h.span[1] <= h.span[0]) continue;
      const key = h.span[0] + ':' + h.span[1] + '|' + JSON.stringify(h.to) + '|' + h.kind;
      const prev = seen[key];
      if (prev == null) { seen[key] = out.length; out.push(h); continue; }
      if (h.conf > out[prev].conf) out[prev] = h;   /* 同义重复保留置信度更高的那条 */
    }
    return out;
  }

  /**
   * 「最长匹配优先」：一次输入里，同一段文字可能被多条词条命中
   * （「明日方舟终末地」同时命中「明日方舟」「终末地」「明日方舟终末地」）。
   * 短命中若被更长的命中区间**完整包含**，它只是更长那条的一部分，单列出来会把用户
   * 送去搜错的作品（「明日方舟」→ 初代 arknights），所以整条丢弃；只有互不包含的
   * 片段才各自保留（「牛头人 车万」两条都在）。区间**等长**的不同解释不算被包含 ——
   * 那是真多义，交给 markSameFragmentConflicts 降档处理。
   */
  function dropCovered(hits) {
    if (hits.length < 2) return hits;
    const keep = [];
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      const len = h.span[1] - h.span[0];
      let covered = false;
      for (let j = 0; j < hits.length; j++) {
        if (i === j) continue;
        const o = hits[j];
        if ((o.span[1] - o.span[0]) <= len) continue;
        if (o.span[0] <= h.span[0] && h.span[1] <= o.span[1]) { covered = true; break; }
      }
      if (!covered) keep.push(h);
    }
    return keep;
  }

  /**
   * 「同一个片段」的真多义处理：同一个 from 在 ≥2 个层/包中命中
   * （且指向不同的 to，否则早已被 dedupe 收敛成一条）时，**这一个片段**本身有两种解释，
   * 把这组命中标成 ambiguous。
   *
   * 标成 ambiguous 的后果只有一个：tier() 把它们从主动档降到兜底档（只在无结果时出）。
   * 它**不影响准入** —— 这些 Hit 依旧照常留在 hits 里、照常能渲染成 chip。
   *
   * 这里**不做**「同一次 lookup 里 ≥2 个 Hit 指向不同 to ⇒ 整句 ambiguous」：
   * 输入里每个被识别到的黑话片段是**独立候选**，各按自身 conf / ambiguous / hintQuery
   * 决定档位，互不连坐。因此「牛头人 车万」这类多片段组合在**有结果**的检索里也照常出
   * 主动提示（每处仍 ≤2 条）。
   */
  function markSameFragmentConflicts(hits) {
    if (hits.length < 2) return hits;
    const byFrom = {};
    for (let i = 0; i < hits.length; i++) {
      const h = hits[i];
      (byFrom[h.from] = byFrom[h.from] || {})[h.pkg] = 1;
    }
    let dup = false;
    for (const f in byFrom) if (Object.keys(byFrom[f]).length >= 2) { dup = true; break; }
    if (!dup) return hits;
    return hits.map(function (h) {
      if (Object.keys(byFrom[h.from] || {}).length < 2) return h;
      return Object.assign({}, h, { ambiguous: true });
    });
  }

  /* ---------------- 锚点（触发词） ---------------- */
  function anchorHit(q, anchor, variants) {
    const a = str(anchor).trim();
    if (!a) return false;
    const low = lower1to1(a);
    const ascii = isAsciiWord(low);
    for (let v = 0; v < variants.length; v++) {
      if (findOccurrences(variants[v].text, low, ascii).length) return true;
    }
    return false;
  }

  /* ---------------- 包清单（assets/dict/ip/index.json） ----------------
     清单是懒加载触发词的**注册表**，结构（宽松读取，字段缺失/类型不对都不算致命）：
       {
         "schema": 1,
         "ver": "2026.09.1",
         "packages": [
           { "id": "arknights", "file": "arknights.json", "anchors": ["明日方舟", …] },
           …
         ]
       }
     `packages` 也接受 `{ "<id>": ["锚点", …] }` 的对象写法。
     任何异常（404 / JSON 坏 / 结构不认识 / fetch 不可用）都只是把 manifestState 置为
     'failed'，行为回到「只认 core.js 的 anchors 映射表」—— 检索一律不受影响（C4）。 */

  function strList(v) {
    if (typeof v === 'string') return v.trim() ? [v.trim()] : [];
    if (!Array.isArray(v)) return [];
    const out = [];
    for (let i = 0; i < v.length; i++) {
      const a = str(v[i]).trim();
      if (a && out.indexOf(a) < 0) out.push(a);
    }
    return out;
  }

  /** 包 id 只允许是可安全拼进 URL 的短标识（拒绝空 / 分隔符 / 点开头 / 超长） */
  function validPkgId(id) {
    const s = str(id).trim();
    if (!s || s.length > 64) return false;
    if (s.indexOf('/') >= 0 || s.indexOf('\\') >= 0 || s.indexOf('.') === 0) return false;
    if (s === PROBE) return false;
    return true;
  }

  function parseManifest(data) {
    if (!data || typeof data !== 'object') return null;
    const raw = [];
    const src = data.packages;
    if (Array.isArray(src)) {
      for (let i = 0; i < src.length; i++) {
        const it = src[i];
        if (!it || typeof it !== 'object') continue;
        raw.push({ id: str(it.id).trim(), anchors: strList(it.anchors) });
      }
    } else if (src && typeof src === 'object') {
      Object.keys(src).forEach(function (k) {
        raw.push({ id: str(k).trim(), anchors: strList(src[k]) });
      });
    }
    const list = [], ids = [];
    for (let i = 0; i < raw.length; i++) {
      const id = raw[i].id;
      if (!validPkgId(id) || ids.indexOf(id) >= 0) continue;   /* 逐条跳过坏项，不整单作废 */
      ids.push(id);
      list.push({ id: id, anchors: raw[i].anchors });
    }
    if (!list.length) return null;
    return { list: list, ids: ids };
  }

  /** 按需请求清单（只请求一次；失败后不再重试，避免反复打 404） */
  function ensureManifest() {
    if (manifestState === 'loading' || manifestState === 'ready' || manifestState === 'failed') {
      return manifestPromise || Promise.resolve(manifestState === 'ready');
    }
    manifestState = 'loading';
    manifestPromise = Promise.resolve()
      .then(function () { return fetchJson(MANIFEST_URL); })
      .then(function (data) {
        const m = parseManifest(data);
        if (m) { manifest = m; manifestState = 'ready'; schedulePrefetch(); }
        else { manifestState = 'failed'; }
        return manifestState === 'ready';
      })
      .catch(function () { manifestState = 'failed'; return false; });   /* 永不 reject */
    return manifestPromise;
  }

  /** core.js 的 anchors 映射表里有没有给这个包登记过触发词（兜底注册表） */
  function coreAnchored(id) {
    const H = lex();
    const am = (H && H.anchors && typeof H.anchors === 'object') ? H.anchors : null;
    if (!am) return false;
    for (const a in am) {
      if (!Object.prototype.hasOwnProperty.call(am, a)) continue;
      if (str(am[a]).trim() === id) return true;
    }
    return false;
  }

  /**
   * 低优先预取（兜底）：清单里「已登记、但一个触发词都没有」的包 —— 将来新增包时忘了
   * 给它登记触发词，这类包永远等不到 pending，会**静默失效**；这里在空闲时机把它拉进来，
   * 之后靠「全都没命中时放开所有已加载包」的兜底路径照常出提示。
   *
   * 时机：清单就绪之后（而清单只在一次检索里才会被请求）→ 即「首次检索触发的 idle 时机」。
   * 上限：一次会话只排一次，最多 PRE_FETCH_MAX 个包，串行加载，不与检索抢带宽。
   */
  function runPrefetch() {
    try {
      if (!manifest) return;
      const want = [];
      for (let i = 0; i < manifest.list.length && want.length < PRE_FETCH_MAX; i++) {
        const p = manifest.list[i];
        if (pkgs[p.id] || loading[p.id]) continue;
        if (p.anchors.length || coreAnchored(p.id)) continue;   /* 有触发词的包按需加载 */
        want.push(p.id);
      }
      let chain = Promise.resolve();
      want.forEach(function (id) {
        chain = chain.then(function () { return loadPkg(id); });
      });
    } catch (e) { /* 预取失败无所谓：它本来就是兜底 */ }
  }

  function schedulePrefetch() {
    if (prefetchQueued) return;
    prefetchQueued = true;
    try {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(function () { runPrefetch(); }, { timeout: 2000 });
        return;
      }
    } catch (e) {}
    try { window.setTimeout(function () { runPrefetch(); }, 1200); } catch (e2) {}
  }

  /**
   * PROBE 路径：等清单就绪，再按「最近一次检索的词」补解析一遍锚点，把新出现的
   * pending 包拉起来。全新会话的**第一次**检索里清单还没到手，就是靠它补上的
   * （lookup 会把 PROBE 放进 pending，上层 load 它就等于「等注册表 + 补拉」）。
   */
  function resolveProbe() {
    return ensureManifest().then(function (ok) {
      if (!ok || !manifest) return;
      const q = str(lastQuery).trim();
      if (!q || q.length > MAX_Q) return;
      const H = lex();
      const variants = variantsOf(q, H);
      const jobs = [];
      for (let i = 0; i < manifest.list.length; i++) {
        const p = manifest.list[i];
        if (pkgs[p.id] || loading[p.id]) continue;
        for (let k = 0; k < p.anchors.length; k++) {
          if (anchorHit(q, p.anchors[k], variants)) { jobs.push(loadPkg(p.id)); break; }
        }
      }
      return Promise.all(jobs);
    }).catch(function () { /* 静默：补拉失败不影响任何检索 */ });
  }

  /* ---------------- 公开接口（冻结） ---------------- */

  /**
   * 黑话判定。不改动任何查询状态（不改 #q、不改 intent、不做任何 UI 动作）。
   * 唯一的副作用是：**首次**调用时按需请求一次包清单 assets/dict/ip/index.json
   * （清单就绪后就不再请求；失败也不再重试）。没有检索 → 本函数不被调用 → 零额外请求。
   * @param {string} q 用户原始输入（已 trim）
   * @returns {{hits: Array, pending: string[]}}
   *   pending 里除了包 id，还可能含内部占位 id '@manifest'（清单尚未就绪时的
   *   「等注册表」信号，只有 load() 认识它）—— 它不会变成任何包，也不会进 stats()。
   */
  HS.dict = HS.dict || {};

  HS.dict.lookup = function (qRaw) {
    const empty = { hits: [], pending: [] };
    try {
      const q = str(qRaw).trim();
      if (!q || q.length > MAX_Q) return empty;
      const H = lex();
      const variants = variantsOf(q, H);
      const coreEntries = (H && Array.isArray(H.entries)) ? H.entries : [];
      lastQuery = q;

      /* 1. 核心层（永远同步就绪） */
      const coreHits = matchEntries(q, coreEntries, CORE_PKG, 'builtin', variants);

      /* 2. 锚点：决定哪些包有资格 + 哪些包需要懒加载。
            触发词有两个来源：清单（主）与 core.js 的 anchors 映射表（兜底）。 */
      const anchorsMap = (H && H.anchors && typeof H.anchors === 'object') ? H.anchors : {};
      const pending = [];
      const byAnchor = {};
      const notePending = function (id) {
        if (!id) return;
        byAnchor[id] = 1;
        if (!pkgs[id] && pending.indexOf(id) < 0) pending.push(id);
      };

      if (manifest) {
        for (let i = 0; i < manifest.list.length; i++) {
          const p = manifest.list[i];
          for (let k = 0; k < p.anchors.length; k++) {
            if (anchorHit(q, p.anchors[k], variants)) { notePending(p.id); break; }
          }
        }
      }
      /* 清单里没有的包，仍按 core.js 的映射表照旧触发（向后兼容） */
      Object.keys(anchorsMap).forEach(function (a) {
        if (!anchorHit(q, a, variants)) return;
        notePending(str(anchorsMap[a]).trim());
      });
      /* 已加载的包：自己的锚点也让它有资格（包内锚点不触发加载，只放行判定） */
      Object.keys(pkgs).forEach(function (id) {
        const list = pkgs[id].anchors || [];
        for (let i = 0; i < list.length; i++) {
          if (anchorHit(q, list[i], variants)) { byAnchor[id] = 1; break; }
        }
      });

      /* 清单还没到手：挂上 PROBE，让上层等注册表就绪后按本词补一次解析。
         failed 之后不再挂 —— 那时已经没有「补」的可能，也不该再发请求。 */
      if (manifestState === 'idle' || manifestState === 'loading') {
        if (pending.indexOf(PROBE) < 0) pending.push(PROBE);
        ensureManifest();
      }

      /* 3. 已加载的包：命中锚点的先算；全都没命中时才放开兜底（锚点门控） */
      let pkgHits = [];
      Object.keys(pkgs).forEach(function (id) {
        if (!byAnchor[id]) return;
        pkgHits = pkgHits.concat(matchEntries(q, pkgs[id].entries, id, pkgs[id].src || 'builtin', variants));
      });
      if (!coreHits.length && !pkgHits.length) {
        Object.keys(pkgs).forEach(function (id) {
          if (byAnchor[id]) return;
          pkgHits = pkgHits.concat(matchEntries(q, pkgs[id].entries, id, pkgs[id].src || 'builtin', variants));
        });
      }

      /* 最长匹配优先 → 同一片段的跨包多义降档 */
      const hits = markSameFragmentConflicts(dropCovered(dedupe(coreHits.concat(pkgHits))));
      hits.sort(function (a, b) {
        if (b.conf !== a.conf) return b.conf - a.conf;
        return a.span[0] - b.span[0];
      });
      return { hits: hits, pending: pending };
    } catch (e) {
      return empty;                  /* 任何意外都降级成「没有提示」，绝不让检索受累（C4） */
    }
  };

  /**
   * 懒加载一个 IP 包。失败必须 resolve（内部静默回退），不得 reject。
   * 传入内部占位 id '@manifest' 时表示「等包清单就绪 + 按最近一次检索补拉锚点」。
   * @returns {Promise<void>}
   */
  HS.dict.load = function (pkgId) {
    const id = str(pkgId).trim();
    if (!id) return Promise.resolve();
    if (id === PROBE) return resolveProbe();
    return loadPkg(id);
  };

  function loadPkg(pkgId) {
    const id = str(pkgId).trim();
    if (!id) return Promise.resolve();
    if (pkgs[id]) return Promise.resolve();
    if (loading[id]) return loading[id];
    let p = Promise.resolve()
      .then(function () { return fetchPkg(id); })
      .then(function (pkg) {
        if (pkg) {
          pkgs[pkg.id] = pkg;
          if (loadedIds.indexOf(pkg.id) < 0) loadedIds.push(pkg.id);
          delete failures[id];
        } else {
          failures[id] = failures[id] || '未取到 / schema 不认识';
        }
      })
      .catch(function (e) {
        failures[id] = str(e && e.message || e) || '加载异常';
      });
    loading[id] = p;
    return p;
  }

  /** 已成功加载的包 id 数组 */
  HS.dict.loaded = function () {
    try { return loadedIds.slice(); } catch (e) { return []; }
  };

  /* ---------------- 只读枚举口（供上层取「全部词面」，不必跨层读内部数据） ----------------
     把一条条词条（或锚点）按统一形状推进 out；from 小写去重，先到先得。 */
  function pushTerms(out, seen, list, pkg, src, role) {
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || typeof e.from !== 'string') continue;
      const from = str(e.from).trim();
      if (!from) continue;
      const k = lower1to1(from);
      if (seen[k]) continue;               /* 同词面只出一次（entries 先于 anchors） */
      seen[k] = 1;
      const to = (e.to && typeof e.to === 'object') ? e.to : null;
      out.push({
        from: from,
        label: str(e.label),               /* 用于副标题的标签 / 说明；没有就是空串 */
        kind: str(e.kind) || (to ? Object.keys(to)[0] : ''),
        role: role,                        /* 'entry' = 词条；'anchor' = 锚点 */
        conf: (typeof e.conf === 'number' && isFinite(e.conf)) ? e.conf : (role === 'anchor' ? 0 : 0.5),
        pkg: str(e.pkg) || pkg,
        src: src
      });
    }
  }

  /**
   * 只读枚举口：返回**当前全部词面**（本文件唯一的只读枚举 API，其余 API 与行为不变）。
   *
   * 范围：核心层 entries + **已经成功加载**的 IP 包 entries + 已加载包的 anchors +
   *      核心层 anchors。锚点（如「小火龙」「椰羊」）也是用户会输入的圈内名，所以一并枚举；
   *      **尚未加载**的包锚点不在内（没加载就不知道它有哪些触发词）。
   * 去重：按 from 逐字符小写去重，先到先得（entries 先于 anchors）。
   *
   * 形状（向后兼容：条目字段名沿用 entries 的既有约定 from / label / kind / conf）：
   *   {
   *     from:  string,  // 词面：用户在搜索框里可能输入的形式（锚点即锚点词）
   *     label: string,  // 用于副标题的标签 / 说明（如「射爆 / 颜射」）；没有则 ''
   *     kind:  string,  // 条目的 to 类型（concept / genre / series / character / attr …）；锚点为 ''
   *     role:  string,  // 'entry' = 词条；'anchor' = 锚点（IP 包的加载触发词）
   *     conf:  number,  // 条目置信度（缺省 0.5，与 lookup 的兜底一致）；锚点 0
   *     pkg:   string,  // 'core' 或包 id（如 'genshin'）
   *     src:   string   // 'builtin'（随包发布）| 'gateway'（开发期热加载）
   *   }
   *
   * 返回的数组与每个元素都是**本次调用新造的副本**，调用方怎么改都动不到内部数据
   * （内部词表依旧只能由 lookup / load 读写）。永不抛异常：任何异常都返回已枚举到的
   * 部分（一条都给不出时就是 []），词典缺失也只是空数组（C4）。
   * @returns {Array<{from:string,label:string,kind:string,role:string,conf:number,pkg:string,src:string}>}
   */
  HS.dict.terms = function () {
    const out = [];
    try {
      const seen = {};
      const H = lex();
      pushTerms(out, seen, (H && Array.isArray(H.entries)) ? H.entries : [], CORE_PKG, 'builtin', 'entry');
      Object.keys(pkgs).forEach(function (id) {
        const p = pkgs[id];
        const pid = str(p && p.id) || id;
        const src = (p && p.src) || 'builtin';
        pushTerms(out, seen, (p && p.entries) || [], pid, src, 'entry');
        /* 包内 anchors 也是用户会输入的圈内名（「小火龙」「椰羊」），一并枚举 */
        pushTerms(out, seen, ((p && p.anchors) || []).map(function (a) {
          return { from: a, label: '' };
        }), pid, src, 'anchor');
      });
      const anchorsMap = (H && H.anchors && typeof H.anchors === 'object') ? H.anchors : {};
      pushTerms(out, seen, Object.keys(anchorsMap).map(function (a) {
        return { from: a, label: '', pkg: str(anchorsMap[a]).trim() };
      }), CORE_PKG, 'builtin', 'anchor');
    } catch (e) {
      return out;                          /* 异常只截断枚举，绝不外抛（C4） */
    }
    return out;
  };

  /** 诊断用：只给 console 看，不做 UI 入口（C3） */
  HS.dict.stats = function () {
    try {
      const H = lex();
      const coreN = (H && Array.isArray(H.entries)) ? H.entries.length : 0;
      let pkgN = 0;
      const names = [CORE_PKG];
      Object.keys(pkgs).forEach(function (id) { pkgN += (pkgs[id].entries || []).length; names.push(id); });
      return {
        layers: gatewayBase ? ['builtin', 'gateway'] : ['builtin'],
        packages: names,
        entries: coreN + pkgN,
        ver: H ? str(H.ver) : '',
        updated: H ? str(H.updated) : '',
        schema: H ? H.schema : null,
        gateway: gatewayBase || null,
        failures: Object.assign({}, failures),
        manifest: manifestState,                                  /* idle | loading | ready | failed */
        registered: manifest ? manifest.ids.slice() : []          /* 清单里登记过的包 id */
      };
    } catch (e) {
      return { layers: [], packages: [], entries: 0, ver: '', error: str(e && e.message || e) };
    }
  };

  /**
   * 开发期热加载通道。
   * 默认不设置 —— 不做任何额外请求，网关没起也绝无报错（C4）。
   * 维护者本地起网关后，在 console 里：
   *   HS.dict.useGateway('/api/dict')   // 该根下按 <base>/<包 id>.json 提供内容
   * 高优先级层覆盖同 from 的低优先级条目（同名条目后加载的胜出）。
   * 传入空串即关闭该层。
   */
  HS.dict.useGateway = function (base) {
    gatewayBase = str(base).trim().replace(/\/+$/, '');
    return { gateway: gatewayBase || null };
  };

  /* ---------------- 取包与校验 ---------------- */
  function fetchPkg(id) {
    const urls = [];
    if (gatewayBase) urls.push(gatewayBase + '/' + encodeURIComponent(id) + '.json');
    urls.push(IP_DIR + encodeURIComponent(id) + '.json');
    return tryUrls(id, urls, 0);
  }

  function tryUrls(id, urls, i) {
    if (i >= urls.length) return Promise.resolve(null);
    return fetchJson(urls[i]).then(function (data) {
      const pkg = validatePkg(data, id, urls[i]);
      if (pkg) return pkg;
      return tryUrls(id, urls, i + 1);
    });
  }

  function fetchJson(url) {
    return new Promise(function (resolve) {
      try {
        if (typeof fetch !== 'function') return resolve(null);
        fetch(url, { credentials: 'same-origin' })
          .then(function (res) {
            if (!res || !res.ok) return resolve(null);
            return res.json().then(resolve, function () { resolve(null); });   /* JSON 损坏 → 静默 */
          })
          .catch(function () { resolve(null); });                              /* 网关没起 / 跨域 → 静默 */
      } catch (e) {
        resolve(null);
      }
    });
  }

  /**
   * 包校验：schema 版本不认识就丢弃该包。
   * 包**以请求时用的 id 为键**：文件内容里的 data.id 只当显示名用。若拿 data.id 当键，
   * 一旦包里写的 id 与文件名不一致，包会被存到另一个键下 —— pending 里那个 id 永远
   * 命中不到（loading 已 resolve，也不会重试），表现为「永久静默失效」。
   */
  function validatePkg(data, id, url) {
    if (!data || typeof data !== 'object') return null;
    if (Number(data.schema) !== SCHEMA) return null;
    const entries = Array.isArray(data.entries) ? data.entries.filter(function (e) {
      return e && typeof e === 'object' && typeof e.from === 'string' && e.from &&
        e.to && typeof e.to === 'object';
    }) : [];
    if (!entries.length) return null;
    return {
      id: id,
      name: str(data.name) || str(data.id) || id,
      ver: str(data.ver),
      src: (url && gatewayBase && url.indexOf(gatewayBase) === 0) ? 'gateway' : 'builtin',
      anchors: Array.isArray(data.anchors) ? data.anchors.filter(Boolean).map(str) : [],
      entries: entries
    };
  }

  /* ---------------- 呈现辅助（HTML 由 app.js 挂进搜索框的泡泡） ---------------- */
  /** 两档策略：conf ≥ .85 且非多义且有 hintQuery 才是「主动提示」档。
      档位**逐条（逐片段）**判定：一个 Hit 的置信度不因同一次输入里的**别的**片段而降档。 */
  HS.dict.tier = function (hit) {
    try {
      if (!hit) return 'low';
      if (hit.ambiguous) return 'low';
      if (!(hit.conf >= 0.85)) return 'low';
      if (!hit.hintQuery) return 'low';
      return 'active';
    } catch (e) { return 'low'; }
  };

  /** 取某一档的前 n 条（hits 已按 conf 降序，调用方不再排序）。
      max **只在没传（null / undefined / 非有限数）时才默认 2** —— 显式的 0 必须原样生效：
      app.js 的 slangRefresh 用 `Math.max(0, 2 - 已出的主动档条数)` 算「低置信档还能出几条」，
      算出 0 的意思就是一条都不许出（每处最多 2 条）；旧写法 `max || 2` 会把 0 当成
      「没传」，于是无结果的兜底档又会补 2 条低置信 chip，同屏超出上限。 */
  HS.dict.pick = function (hits, tier, max) {
    const out = [];
    try {
      const cap = (max == null || !isFinite(Number(max))) ? 2 : Math.max(0, Math.floor(Number(max)));
      const list = Array.isArray(hits) ? hits : [];
      for (let i = 0; i < list.length && out.length < cap; i++) {
        if (HS.dict.tier(list[i]) === tier) out.push(list[i]);
      }
    } catch (e) {}
    return out;
  };

  /** 「「社保」→ 射爆 / 颜射」—— 命中的原词 + 理解成什么（三要素之一二） */
  HS.dict.describe = function (hit) {
    if (!hit) return '';
    return '「' + str(hit.from) + '」→ ' + str(hit.label || hit.from);
  };

  function esc(s) {
    if (HS.u && typeof HS.u.esc === 'function') return HS.u.esc(s);
    return str(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /**
   * 点下去实际会填进 #q 的词，若**无法从 label 看出来**就返回它（否则返回空串）。
   * 用途：chip 显示「原神」而点击填 `genshin` 时，必须让用户看见目标是 genshin ——
   * 所见即所得，避免用户以为点了等于没点、或以为会填别的作品。
   */
  function hintTarget(hit) {
    const q = str(hit && hit.hintQuery);
    if (!q) return '';
    const lab = str((hit && hit.label) || (hit && hit.from));
    const norm = function (s) {
      return str(s).toLowerCase().replace(/[\s\-_·、，,/（）()「」【】]/g, '');
    };
    if (norm(lab).indexOf(norm(q)) >= 0) return '';   /* 目标已经明摆在 label 里 */
    return q;
  }

  /**
   * 泡泡内的 chip 列表 HTML（接入点由 app.js 放进搜索框里的泡泡）。
   * 有 hintQuery 的才是可点的 chip（data-q 交给 app.js 既有的 [data-q] 委托）；
   * 没有 hintQuery 的只出说明文字，不给点击。
   * 可点的 chip 额外带 data-q-span / data-q-from（= 该 Hit 在自己那句输入里的片段），
   * 让 app.js 点击时**只替换被点中的那一段**，多片段输入（如「牛头人 车万」）不会因为
   * 点一个就丢掉另一个；片段对不上当前输入时 app.js 自动退回整串替换。
   * hintQuery 与 label 不同（且光看 label 看不出目标）时，chip 上补一句「（检索 xxx）」，
   * 同时 title / aria-label 里始终写明目标词。
   */
  HS.dict.chipsHTML = function (hits) {
    let html = '';
    const list = Array.isArray(hits) ? hits : [];
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      const tier = HS.dict.tier(h);
      const tag = tier === 'active' ? '' : '<span class="hs-slang-tag">可能</span>';
      const why = str(h.why);
      const title = why
        ? '为什么：' + why + (h.hintQuery ? '（点击后改用「' + h.hintQuery + '」重新检索）' : '')
        : (h.hintQuery ? '点击后改用「' + h.hintQuery + '」重新检索' : '');
      const target = hintTarget(h);
      const cls = 'hs-slang-chip' + (h.hintQuery ? '' : ' hs-slang-note');
      const inner = tag + esc(HS.dict.describe(h)) + (target ? '（检索 ' + esc(target) + '）' : '');
      const sp = (h.span && h.span[1] > h.span[0]) ? (h.span[0] + ',' + h.span[1]) : '';
      if (h.hintQuery) {
        html += '<button class="' + cls + '" type="button" data-tier="' + tier + '"' +
          ' data-q="' + esc(h.hintQuery) + '"' +
          (sp ? ' data-q-span="' + sp + '" data-q-from="' + esc(h.from) + '"' : '') +
          (title ? ' title="' + esc(title) + '"' : '') +
          ' aria-label="' + esc(HS.dict.describe(h) + '，点后改用「' + h.hintQuery + '」重新检索' + (why ? '。' + why : '')) + '"' +
          '>' + inner + '</button>';
      } else {
        html += '<span class="' + cls + '" data-tier="' + tier + '"' +
          (title ? ' title="' + esc(title) + '"' : '') + '>' + inner + '</span>';
      }
    }
    return html;
  };

  /** 泡泡的无障碍描述：三要素（原词 / 理解成什么 / 点什么）都在里面 */
  HS.dict.ariaText = function (hits) {
    const list = Array.isArray(hits) ? hits : [];
    const bits = [];
    for (let i = 0; i < list.length; i++) {
      const h = list[i];
      bits.push(HS.dict.describe(h) + (h.why ? '（' + h.why + '）' : '') +
        (h.hintQuery ? '，点后改用「' + h.hintQuery + '」重新检索' : ''));
    }
    return bits.join('；');
  };

})(window.HS);
