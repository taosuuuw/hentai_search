/* suggest.js — 搜索联想泡泡 + 本地词频
 * 依赖：window.HS（core.js）。词表来源共 6 个，**全部可选**，缺哪个就静默跳过哪个：
 *   ① HS.TAG_ZH      （dict.js，约 1711 键 + 1593 值：标签中英日 ↔ 中文）
 *   ② HS.CONCEPTS    （dict.js，约 121 组别名）
 *   ③ HS.SERIES_SORTED（core.js，作品 / 系列表）
 *   ④ HS.GENRE_FLAT  （core.js，体裁别名 + 中文 label）
 *   ⑤ 黑话词典        （**HS.dict 的只读枚举口**：dict-hint.js 的 HS.dict.terms()，
 *                        返回**已加载**的全部词条 + 锚点，含「椰羊」这类圈内名。
 *                        探测口仍是 terms/list/entries/allTerms/all 五个键（谁先有
 *                        数组就用谁，见 dictNativeTerms）；HS.dict 缺失 / 版本旧 /
 *                        没有枚举口时**这一路静默少收**，不崩也不算错 ——
 *                        本文件不跨层去读词典自己消费的数据层。）
 *   ⑥ IP 包清单      （assets/dict/ip/index.json，**本文件只读懒加载**：24 个包的
 *                        1022 条锚点中，未被上面 5 源收录的那些并进词表，来源标
 *                        'manifest'，副标题 = 包名，如「芙莉莲 · 葬送的芙莉莲」。
 *                        HS.dict.terms() 只能枚举**已加载**的包，所以「佩丽卡 / 终末地」
 *                        这类未加载包的锚点此前在联想里看不到，这一路补的就是它们。
 *                        没输入不请求、只请求一次、失败静默降级且不重试。）
 * 加载位置：dict.js / assets/dict/core.js / dict-hint.js 之后，app.js 之前的任意位置
 * 均可（本文件不依赖 app.js）。
 *
 * ── 设计边界（与「黑话提示」功能完全解耦）─────────────────────────────
 *  1) 本文件【只读地】监听既有 DOM 事件（#q 的 input / keydown / 焦点，
 *     #search-form 的 submit），不修改、不包装任何既有全局函数。
 *  2) 只「填入」，绝不检索：填入后不触发 submit、不调用 HS 的任何检索 API。
 *  3) 不维护任何「外号 → 正名」映射，词表只用于前缀/包含匹配，原样展示。
 *  4) localStorage 只存 纯文本词 + 次数 + 最近时间（无别名、无映射）。
 *  5) 词表缺失 / 存储不可用 / JSON 损坏 → 全部静默降级，绝不影响检索。
 */
(function () {
  'use strict';

  var HS = (typeof window !== 'undefined') ? window.HS : null;
  if (!HS || !HS.u) return;                       /* core.js 缺失：整体不启动 */

  var u = HS.u;
  var KEY = 'hs.suggest.v1';                      /* localStorage 键 */
  var VERSION = 2;
  var CAP = 200;                                  /* 历史上限：纯文本词条数 */
  var MAX_ITEMS = 6;                              /* 最多显示几条 */
  var HALF_LIFE_MS = 14 * 24 * 3600 * 1000;       /* 新鲜度半衰期：14 天 */
  var MIN_LEN = 1;                                /* 1 个字符即可开始联想（输入侧门槛，未改） */
  var MIN_WORD_LEN = 2;                           /* 词表词最短 2 字（沿用旧门槛：1 字词会独吞候选位） */
  var MAX_WORD_LEN = 48;                          /* 词表词最长 48 字（旧值 24，见 §2 注释的长度实测依据） */
  var COMPOSE_GRACE = 120;                         /* 与 app.js 一致的选词回车宽限 */

  /* ======================================================================
     1. 存储层：{ v, items: [{ t, c, a }] }  t=纯文本词 c=次数 a=最近使用时间
     全部读写包 try/catch；任何异常都退化成「空历史 + 不写入」。
     ====================================================================== */
  var mem = null;        /* 存储不可用时的内存兜底 */
  var usable = true;
  var cache = null;      /* 解析后的数组缓存 */

  function storageGet() {
    if (!usable) return null;
    try { return window.localStorage.getItem(KEY); } catch (e) { usable = false; return null; }
  }
  function storageSet(raw) {
    if (!usable) return false;
    try { window.localStorage.setItem(KEY, raw); return true; }
    catch (e) { usable = false; return false; }
  }

  function sanitizeItem(it) {
    if (!it || typeof it !== 'object') return null;
    var t = (typeof it.t === 'string') ? it.t.replace(/\s+/g, ' ').trim() : '';
    if (!t || t.length > 64) return null;
    var c = Number(it.c);
    var a = Number(it.a);
    if (!isFinite(c) || c < 1) c = 1;
    if (c > 1e6) c = 1e6;
    if (!isFinite(a) || a < 0) a = 0;
    return { t: t, c: Math.round(c), a: Math.round(a) };
  }

  function readAll() {
    if (cache) return cache;
    var out = [];
    var raw = storageGet();
    if (raw === null && !usable) {
      cache = mem || [];
      return cache;
    }
    if (raw) {
      var parsed = null;
      try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      var arr = null;
      if (parsed && Object.prototype.toString.call(parsed) === '[object Array]') arr = parsed;
      else if (parsed && parsed.items && Object.prototype.toString.call(parsed.items) === '[object Array]') arr = parsed.items;
      if (arr) {
        for (var i = 0; i < arr.length && out.length < CAP; i++) {
          var it = sanitizeItem(arr[i]);
          if (it) out.push(it);
        }
      }
    }
    cache = out;
    return cache;
  }

  /* 频率 × 新鲜度：见文件末尾注释（log2 频率 × 指数衰减） */
  function decay(ageMs) {
    if (!isFinite(ageMs) || ageMs < 0) ageMs = 0;
    var r = Math.pow(2, -ageMs / HALF_LIFE_MS);
    return r < 0.02 ? 0.02 : r;
  }
  function freqScore(c) {
    var v = Math.log(c + 1) / Math.LN2;
    return 1 + (v > 6 ? 6 : v);
  }
  function histScore(it, now) {
    return freqScore(it.c) * decay(now - it.a);
  }

  function writeAll(items) {
    var trimmed = items;
    if (trimmed.length > CAP) {
      var now = Date.now();
      trimmed = trimmed.slice().sort(function (a, b) { return histScore(b, now) - histScore(a, now); }).slice(0, CAP);
    }
    trimmed.sort(function (a, b) { return b.a - a.a; });
    cache = trimmed;
    var payload = { v: VERSION, items: [] };
    for (var i = 0; i < trimmed.length; i++) payload.items.push({ t: trimmed[i].t, c: trimmed[i].c, a: trimmed[i].a });
    var raw = null;
    try { raw = JSON.stringify(payload); } catch (e) { raw = null; }
    if (raw !== null) storageSet(raw);
    if (!usable) mem = trimmed;
  }

  function record(term) {
    var t = String(term == null ? '' : term).replace(/\s+/g, ' ').trim();
    if (!t || t.length > 64) return;
    var items = readAll();
    var k = t.toLowerCase();
    var now = Date.now();
    var found = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].t.toLowerCase() === k) { found = items[i]; break; }
    }
    if (found) { found.c += 1; found.a = now; found.t = t; }
    else { items.push({ t: t, c: 1, a: now }); }
    writeAll(items);
  }

  /* ======================================================================
     2. 词表层：5 个来源合并成一张去重词表（缺谁跳过谁，绝不抛异常）
        · 每个来源各自 try/catch：某个来源缺字段 / 抛错，只丢它自己。
        · 去重「先到先得」：构建顺序决定同名词条保留谁的副标题（zh）。
        · 长度门槛 MIN_WORD_LEN–MAX_WORD_LEN：
          实测 5 个来源全部词条（含重复 3869 条）的长度分布为
          p50=4 / p95=14 / p99=18 / 最大 27（ouran high school host club）。
          旧上限 24 会静默丢掉 3 条长作品名（27/26/25 字），因此上限放宽；
          取 48 = 「40–64」区间内、覆盖当前最长词 27 的 1.7 倍余量，
          又不至于让泡泡里的长串失控（CSS .hs-sg-text 限宽 14em）。
          长度 > 40 的词目前在五源里为 0 条，48 纯属给未来的余量。
          下限仍为 2：1 字词（如体裁别名「孕」）用 1 个字的前缀会把候选位
          全占满，且旧门槛本就排除它们 —— 保持既有行为。
     ====================================================================== */
  var wordIndex = null;
  var buildMs = 0;              /* 只给只读诊断口 HS.suggest.sources() 用 */
  var srcCount = null;

  /* 词条规范化：与旧代码 `String(x).replace(/\s+/g,' ').trim()` 语义完全一致，
     只是给「不含任何空白字符」的绝大多数词条加了条快路径 ——
     约 3900 条词如果每条都跑一次全局正则替换，构建会凭空多花几毫秒。 */
  var WS_RE = /\s/;
  function normTerm(term) {
    var t = String(term == null ? '' : term);
    if (!WS_RE.test(t)) return t;                /* 无空白 → 替换与 trim 都是空操作 */
    return t.replace(/\s+/g, ' ').trim();
  }

  /* 黑话词典的只读枚举口：dict-hint.js 现提供 HS.dict.terms()（全部词条 + 锚点）。
     这里保持「形状无关」的探测：五个候选键里谁先给出非空数组就用谁，
     所以将来换名字（或上层换成别的实现）也不用改这里。都没有 → null（这一路少收） */
  var DICT_ENUM_KEYS = ['terms', 'list', 'entries', 'allTerms', 'all'];
  var dictEnumKey = '';            /* 实际生效的键名，只给只读诊断口 HS.suggest.sources() 看 */
  function dictNativeTerms() {
    var d = HS.dict;
    dictEnumKey = '';
    if (!d || typeof d !== 'object') return null;
    for (var i = 0; i < DICT_ENUM_KEYS.length; i++) {
      var v = null;
      try { v = d[DICT_ENUM_KEYS[i]]; } catch (e) { v = null; }   /* 只读探测，永不抛 */
      if (v == null) continue;
      if (typeof v === 'function') { try { v = v(); } catch (e2) { v = null; } }
      if (v && v.length) { dictEnumKey = DICT_ENUM_KEYS[i]; return v; }
    }
    return null;
  }
  /* 把枚举口可能给的各种形状（字符串 / {t|from|term|text}）归一成 {t, zh} */
  function normDictTerm(x) {
    if (x == null) return null;
    if (typeof x === 'string') return { t: x, zh: '' };
    if (typeof x !== 'object') return null;
    var t = x.t || x.from || x.term || x.text || x.zh || '';
    var zh = x.zh || x.label || x.meaning || '';
    if (String(zh) === String(t)) zh = '';
    return t ? { t: t, zh: zh } : null;
  }

  /* ======================================================================
     2b. IP 包清单（assets/dict/ip/index.json）—— 只读懒加载的锚点层
     ─────────────────────────────────────────────────────────────────────
     为什么需要：HS.dict.terms() 只枚举**已经加载**的包，未加载包的锚点
     （「佩丽卡 / 终末地 / 芙莉莲」这类圈内名）在联想里一条都看不到。
     这里只读地拉一次清单，把 anchors 并进同一张词表（src = 'manifest'，
     副标题 = 包名），之后它们和既有词条走**完全相同**的扫描 / 打分 / 排序路径。
     边界（与 dict-hint.js 的 C4 同构）：
       · **没输入不请求**：唯一触发点在 §3 collect() 里、q 过了 MIN_LEN 之后。
       · 只请求一次：idle → loading → ready | failed；failed 之后永不重试。
       · fetch 不存在 / 404 / JSON 坏 / 结构不认识 → 静默降级成「少收这一路」，
         既有词表、排序、历史、检索行为一个字节都不变。
       · 只读消费，不改 dict-hint.js 与 assets/dict/**，也不复用其内部状态。
     ====================================================================== */
  var MANIFEST_URL = 'assets/dict/ip/index.json';
  var MANIFEST_MAX = 4000;          /* 防御性上限：坏清单不能把词表撑爆 */
  var manifestState = 'idle';       /* idle | loading | ready | failed */
  var manifestKeys = null;          /* 清单锚点小写集合（Object.create(null)）：精确命中的豁免判定 */
  var manifestPkgs = 0;             /* 清单里读到锚点的包数 */
  var manifestMs = 0;               /* 解析 + 并入的耗时（只给只读诊断口 sources() 看） */

  /* 宽松解析：packages 允许是数组（{id,name,anchors}）或 { id: [锚点…] } 对象 ——
     与 dict-hint.js 的 parseManifest 同构；anchors 也允许单个字符串。
     结构完全不认识 → null（当作失败，不重试）。包名 name 拿去当副标题。 */
  function normManifestAnchors(data) {
    if (!data || typeof data !== 'object') return null;
    var src = data.packages;
    var pkgs = null;
    var i, j;
    if (Object.prototype.toString.call(src) === '[object Array]') {
      pkgs = [];
      for (i = 0; i < src.length; i++) {
        var p = src[i];
        if (!p || typeof p !== 'object') continue;         /* 逐条跳过坏项，不整单作废 */
        pkgs.push({ name: normTerm(p.name || p.id || ''), anchors: p.anchors });
      }
    } else if (src && typeof src === 'object') {
      pkgs = [];
      var ids = Object.keys(src);
      for (i = 0; i < ids.length; i++) pkgs.push({ name: normTerm(ids[i]), anchors: src[ids[i]] });
    }
    if (!pkgs) return null;
    var out = [];
    for (i = 0; i < pkgs.length; i++) {
      var a = pkgs[i].anchors;
      if (typeof a === 'string') a = [a];
      if (!a || !a.length) continue;
      manifestPkgs++;
      for (j = 0; j < a.length && out.length < MANIFEST_MAX; j++) {
        var t = normTerm(a[j]);
        if (!t) continue;
        out.push({ t: t, zh: pkgs[i].name });
      }
    }
    return out;
  }

  /* 把清单锚点并进同一张词表：先到先得去重（既有 5 源优先，同名条目保留既有副标题），
     长度门槛与既有词表一致。并入后 wordScan 仍然只有**一条**扫描路径 —— 新增的
     1021 条只是让同一个 for 循环多跑 1021 次，不新增第二份 indexOf。 */
  function mergeManifest(rawTerms) {
    var t0 = (window.performance && window.performance.now) ? window.performance.now() : 0;
    if (wordIndex === null) { try { wordIndex = buildIndex(); } catch (e) { wordIndex = []; } }
    var seen = Object.create(null);
    var i;
    for (i = 0; i < wordIndex.length; i++) seen[wordIndex[i].t.toLowerCase()] = 1;
    var added = 0;
    for (i = 0; i < rawTerms.length; i++) {
      var t = rawTerms[i].t;
      if (t.length < MIN_WORD_LEN || t.length > MAX_WORD_LEN) continue;
      var k = t.toLowerCase();
      if (seen[k]) continue;                    /* 同词去重：既有 5 源赢了就不覆盖 src */
      seen[k] = 1;
      wordIndex.push({ t: t, zh: rawTerms[i].zh || '', src: 'manifest' });
      added++;
    }
    if (srcCount) srcCount.manifest = (srcCount.manifest || 0) + added;
    manifestMs = t0 ? (window.performance.now() - t0) : 0;
  }

  /* 懒加载清单（只读）。永不 reject；失败后不再请求。 */
  function ensureManifest() {
    if (manifestState !== 'idle') return;
    if (!window.fetch || !window.Promise) { manifestState = 'failed'; return; }
    manifestState = 'loading';
    var req = null;
    try { req = window.fetch(MANIFEST_URL, { credentials: 'same-origin' }); }
    catch (e) { manifestState = 'failed'; return; }
    if (!req || typeof req.then !== 'function') { manifestState = 'failed'; return; }
    req.then(function (res) {
      if (!res || !res.ok) return null;
      return res.json();
    }).then(function (data) {
      var terms = normManifestAnchors(data);
      if (!terms) { manifestState = 'failed'; return; }
      /* 豁免集合：清单里出现过的锚点（含被既有 5 源抢先收录的同名词），
         用于 §3「精确命中即收起」的判定 —— 见 collect() 与文件头说明。 */
      var keys = Object.create(null);
      for (var i = 0; i < terms.length; i++) keys[terms[i].t.toLowerCase()] = 1;
      manifestKeys = keys;
      try { mergeManifest(terms); } catch (e) { manifestKeys = null; manifestState = 'failed'; return; }
      manifestState = 'ready';
      /* 清单到得比输入晚：到手后按当前输入补刷一次（refresh 自带空输入 / 选词中判断）。
         用户已经显式收起过（Esc / 点外部 / 失焦 / 点过某条）就不再顶回来。 */
      if (!dismissed) { try { refresh(); } catch (e2) {} }
    }).then(null, function () { manifestState = 'failed'; });   /* 静默：这一路少收 */
  }

  function buildIndex() {
    if (wordIndex) return wordIndex;
    var t0 = (window.performance && window.performance.now) ? window.performance.now() : 0;
    var seen = Object.create(null);
    var list = [];
    var counts = { tag: 0, concept: 0, series: 0, genre: 0, dict: 0, manifest: 0, _droppedLong: 0 };

    function push(term, zh, src) {
      var t = normTerm(term);
      if (!t) return;
      if (t.length < MIN_WORD_LEN) return;
      if (t.length > MAX_WORD_LEN) { counts._droppedLong++; return; }
      var k = t.toLowerCase();
      if (seen[k]) return;                       /* 同词去重（先到先得） */
      seen[k] = 1;
      list.push({ t: t, zh: zh ? String(zh) : '', src: src });
      if (counts[src] != null) counts[src]++;
    }
    /* 每个来源独立兜底：缺表 / 结构变了 / 抛异常 → 只丢这一个来源 */
    function from(fn) { try { fn(); } catch (e) { /* 静默跳过 */ } }

    /* —— ① dict.js：TAG_ZH（英文 / 罗马字 / 日文键 + 中文值本身） —— */
    from(function () {
      var tags = HS.TAG_ZH;
      if (!tags || typeof tags !== 'object') return;
      for (var k in tags) {
        if (!Object.prototype.hasOwnProperty.call(tags, k)) continue;
        push(k, tags[k], 'tag');
        push(tags[k], '', 'tag');
      }
    });

    /* —— ② dict.js：CONCEPTS（别名组） —— */
    from(function () {
      var cs = HS.CONCEPTS;
      if (!cs || !cs.length) return;
      for (var i = 0; i < cs.length; i++) {
        var g = cs[i];
        if (!g) continue;
        if (g.aliases && g.aliases.length) {
          for (var j = 0; j < g.aliases.length; j++) push(g.aliases[j], g.zh || '', 'concept');
        }
        push(g.en, g.zh || '', 'concept');
        push(g.zh, '', 'concept');
        push(g.ja, g.zh || '', 'concept');
      }
    });

    /* —— ③ core.js：SERIES_SORTED（作品 / 系列表，已是长词优先序） —— */
    from(function () {
      var ss = HS.SERIES_SORTED;
      if (!ss || !ss.length) return;
      for (var i = 0; i < ss.length; i++) push(ss[i], '', 'series');
    });

    /* —— ④ core.js：GENRE_FLAT（{g, a} 别名表；同时收中文 label 与 key） —— */
    from(function () {
      var gf = HS.GENRE_FLAT;
      if (!gf || !gf.length) return;
      for (var i = 0; i < gf.length; i++) {
        var it = gf[i];
        if (!it) continue;
        var g = it.g || null;
        var label = (g && g.label) || '';
        push(it.a, label, 'genre');              /* 别名 → 副标题给中文 label */
        if (g) {
          push(g.label, '', 'genre');
          push(g.key, label, 'genre');
        }
      }
    });

    /* —— ⑤ 黑话词典 —— */
    from(function () {
      var native = dictNativeTerms();            /* HS.dict 的只读枚举口（terms() 等五键探测） */
      if (!native) return;                       /* 没有枚举口：这一路静默少收，不跨层兜底 */
      for (var i = 0; i < native.length; i++) {
        var n = normDictTerm(native[i]);
        if (n) push(n.t, n.zh, 'dict');
      }
    });

    wordIndex = list;
    srcCount = counts;
    buildMs = t0 ? (window.performance.now() - t0) : 0;
    return wordIndex;
  }

  /* 历史词小写集合：用于「历史优先」去重（历史里已有的词不再被词表重复收录） */
  function historyKeys() {
    var items = readAll();
    var map = Object.create(null);
    for (var i = 0; i < items.length; i++) map[items[i].t.toLowerCase()] = 1;
    return map;
  }

  /* ======================================================================
     3. 候选合并：历史（tier 1）永远高于词表（tier 0）
     同 tier 内按各自分数降序；同分时短词优先（更适合直接搜）。

     §3c「精确命中即收起」规则（本次新增，口径写死在这里）：
       输入规范化后（trim + 空白折叠 + 小写，即 q）与**合并词表**里任一条目
       完全相等 → collect() 直接返回 []，refresh() 走既有的「无候选即收起」
       分支，泡泡消失。用户口径：关键词打完整、意思准确时不该再挡着。
       两个刻意的边界：
         · **只对合并词表判定，不含历史**：历史沿用下面既有的「同词不再提示」
           （k === q 跳过），它不会单独把泡泡收掉。
         · **例外：清单锚点（IP 入口词）不收**。q 命中 assets/dict/ip/index.json
           里出现过的锚点（manifestKeys）时，泡泡继续给该词与同 IP 的其它锚点
           （如「佩丽卡 · 明日方舟：终末地」）—— 见 §2b 与文件头 ⑥：这正是
           「未加载包锚点可见」的落点，收掉它就等于让这一路只能在前缀下可见。
     ====================================================================== */
  function collect(query, now) {
    var raw = String(query || '').replace(/\s+/g, ' ').trim();
    var q = raw.toLowerCase();
    if (q.length < MIN_LEN) return [];

    ensureManifest();                               /* 有输入才懒拉清单；idle 之外是空操作 */

    var seen = historyKeys();
    var out = [];
    var i, k, it;

    /* —— 3a. 本地历史：前缀命中优先，其次包含命中 —— */
    var hist = readAll();
    for (i = 0; i < hist.length; i++) {
      it = hist[i];
      k = it.t.toLowerCase();
      if (k === q) continue;                        /* 与当前输入完全一样：没必要提示 */
      var hit = (k.indexOf(q) === 0) ? 2 : (k.indexOf(q) >= 0 ? 1 : 0);
      if (!hit && raw.indexOf(' ') >= 0) {
        /* 多词输入：整串不对时退回「最后一个词」做前缀匹配 */
        var last = q.split(' ').pop();
        if (last && last.length >= MIN_LEN) hit = (k.indexOf(last) === 0) ? 2 : (k.indexOf(last) >= 0 ? 1 : 0);
      }
      if (!hit) continue;
      seen[k] = 1;
      out.push({
        t: it.t,
        src: 'history',
        tier: 1,
        score: 100 + histScore(it, now) + (hit === 2 ? 40 : 0),
        zh: '',
        c: it.c
      });
    }

    /* —— 3b. 词表（6 个来源合并后的同一张表）：前缀命中 → 包含命中 ——
       只保留一条全量扫描路径：单字符前缀（最坏情形）实测约 0.7ms/次（并入
       1021 条清单锚点后重测值，见验证报告），距 16.7ms 一帧还有 20 倍以上余量，
       因此不做前缀分桶 —— 分桶会连「包含命中」（羊 → 椰羊）一起丢掉，
       属于既有行为，不能变。
       这里刻意**不加「来源加成」**：tier 与打分函数与改动前逐字一致，
       新增来源只是并入同一池子，既有排序（前缀优先 / 短词优先 / 字典序）不变。 */
    if (wordIndex === null) {
      try { wordIndex = buildIndex(); } catch (e) { wordIndex = []; }
    }
    var exact = wordScan(q, seen, out);

    /* §3c：精确命中 → 收起（清单锚点例外，理由见函数头注释） */
    if (exact && !(manifestKeys && manifestKeys[q] === 1)) return [];

    out.sort(function (a, b) {
      if (a.tier !== b.tier) return b.tier - a.tier;
      if (b.score !== a.score) return b.score - a.score;
      if (a.t.length !== b.t.length) return a.t.length - b.t.length;
      return a.t < b.t ? -1 : (a.t > b.t ? 1 : 0);
    });
    return out.slice(0, MAX_ITEMS);
  }

  /* 在词表里扫一遍：前缀命中记高分，包含命中记低分（包含命中最多收 40 条）
     返回：q 是否与表里某条**完全相等**（供 §3c 的「精确命中即收起」判定）。
     注意：这里的全量 indexOf 同时承担「前缀」与「包含」两种命中，
     所以不能改成「按首字分桶」——分桶会丢掉包含命中（如 羊 → 椰羊），
     那属于既有行为，不能变。宁可多扫 4800 条（0.7ms）也不动语义。 */
  function wordScan(q, seen, out) {
    var dict = wordIndex || [];
    var subs = 0;
    var exact = false;
    for (var i = 0; i < dict.length; i++) {
      var d = dict[i];
      var k = d.t.toLowerCase();
      if (k === q) exact = true;                     /* 同词去重前先记精确命中 */
      if (seen[k]) continue;
      var p = k.indexOf(q);
      if (p < 0) continue;
      if (p !== 0) { if (subs >= 40) continue; subs++; }
      seen[k] = 1;
      out.push({
        t: d.t,
        src: d.src || 'dict',
        tier: 0,
        score: p === 0 ? (50 + 30 * (q.length / k.length)) : (10 + 10 * (q.length / k.length)),
        zh: d.zh || '',
        c: 0
      });
    }
    return exact;
  }

  /* ======================================================================
     4. 视图层：从搜索栏下沿冒出的泡泡层
     仅在搜索框【下方】绝对定位，不占流内空间 → 绝不顶开搜索框。
     ====================================================================== */
  var qEl = u.$('#q');
  var formEl = u.$('#search-form');
  if (!qEl) return;                                /* 没有搜索框：不启动 */

  var host = u.$('#search-wrap') || (formEl && formEl.parentNode) || qEl.parentNode;
  var panel = null, box = null, refs = [];
  var open = false;
  var items = [];
  var active = -1;
  var composing = false;
  var composedAt = 0;
  var suppress = false;
  var seq = 0;
  /* 用户显式收起过（Esc / 点外部 / 失焦 / 点了某条泡泡）：置 1。
     唯一用途是拦住 §2b 清单到货时的那次自动补刷 —— 否则「拉清单」这一路
     会把用户刚收起的泡泡从底下顶回来。任何一次新的输入/拼字/聚焦都会清掉它。 */
  var dismissed = false;

  function motionOff() {
    try {
      if (document.documentElement.classList.contains('hs-nomotion')) return true;
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
    } catch (e) {}
    return false;
  }

  function build() {
    if (panel) return true;
    if (!host || !host.appendChild) return false;
    panel = u.el('div', {
      class: 'hs-sg-layer',
      hidden: 'hidden',
      'data-open': '0',
      role: 'listbox',
      'aria-label': '搜索联想'
    });
    box = u.el('div', { class: 'hs-sg-bubbles' });
    panel.appendChild(box);
    host.appendChild(panel);
    return true;
  }

  function clearBox() {
    while (box && box.firstChild) box.removeChild(box.firstChild);
    refs = [];
  }

  function show() {
    if (!panel) return;
    panel.hidden = false;
    panel.setAttribute('data-open', '1');
  }
  function hide() {
    if (!panel) return;
    panel.setAttribute('data-open', '0');
    panel.hidden = true;
    active = -1;
    items = [];
    clearBox();
    open = false;
  }

  /* 同步视图：items → DOM → 定位 */
  function render() {
    open = true;
    if (!panel) return;
    clearBox();
    var key = (qEl.value || '').trim().toLowerCase();

    for (var i = 0; i < items.length; i++) {
      (function (idx) {
        var it = items[idx];
        var chip = u.el('button', {
          type: 'button',
          class: 'hs-sg-item' + (it.src === 'history' ? ' hs-sg-item--hist' : ''),
          'data-src': it.src,
          'data-idx': String(idx),
          role: 'option',
          tabindex: '-1'
        });
        chip.appendChild(u.el('span', { class: 'hs-sg-text' }, u.esc(it.t)));
        if (it.zh && it.zh.toLowerCase() !== it.t.toLowerCase()) {
          chip.appendChild(u.el('span', { class: 'hs-sg-sub' }, u.esc(it.zh)));
        }
        if (it.src === 'history' && it.c > 1) {
          chip.appendChild(u.el('span', { class: 'hs-sg-count' }, '×' + it.c));
        }
        chip.style.animationDelay = (idx * 26) + 'ms';
        box.appendChild(chip);
        refs.push(chip);
      })(i);
    }

    /* 高亮当前项：优先保持上次选中的词 */
    var keep = (active >= 0 && items[active]) ? items[active].t : '';
    active = -1;
    if (keep) {
      for (var j = 0; j < items.length; j++) {
        if (items[j].t === key) continue;
        if (items[j].t === keep) { active = j; break; }
      }
    }
    paint();
    show();
    if (!motionOff()) {
      /* 重放「冒泡」动画：先撤下 data-open 再强制回流 */
      panel.setAttribute('data-open', '0');
      void panel.offsetWidth;
      panel.setAttribute('data-open', '1');
    }
  }

  function paint() {
    for (var i = 0; i < refs.length; i++) {
      var on = (i === active);
      refs[i].setAttribute('data-on', on ? '1' : '0');
      if (on && refs[i].scrollIntoView) {
        try { refs[i].scrollIntoView({ block: 'nearest' }); } catch (e) {}
      }
    }
    try {
      qEl.setAttribute('aria-expanded', (open && items.length) ? 'true' : 'false');
      if (open && active >= 0 && items[active]) qEl.setAttribute('aria-activedescendant', 'hs-sg-' + active);
      else qEl.removeAttribute('aria-activedescendant');
    } catch (e) {}
  }

  /* 刷新：算出候选；空输入 / 选词中 / 无候选 → 收起 */
  function refresh() {
    seq++;
    if (suppress) return;
    if (composing || (Date.now() - composedAt) < COMPOSE_GRACE) return;  /* 尊重输入法 */
    var raw = (qEl.value || '');
    if (!raw.trim()) { hide(); return; }
    try { items = collect(raw, Date.now()); } catch (e) { items = []; }
    if (!items.length) { hide(); return; }
    if (!build()) return;
    render();
  }

  /* —— 输入法提交后的「补刷」定时器（本次修的 bug 的根因所在）——
     症状：把关键词打完（中文要走输入法）、再删掉几个字，泡泡才出现。
     根因：input[type=search] 上的 composition 序列是
           compositionstart → (compositionupdate)* → compositionend → input；
         提交那一次 input 紧跟 compositionend（同一次事件循环内，远小于
         COMPOSE_GRACE=120ms），于是被 refresh() 顶部的
         `(Date.now() - composedAt) < COMPOSE_GRACE` 直接吞掉，
         而**之后没有任何东西再调 refresh()** —— 拼字期间的全部 input 又都被
         composing / e.isComposing 挡下。结果：整整一个词打完，泡泡一次都没刷过；
         直到用户敲下第一个「非输入法」按键（删字/空格/回车…）才补上。
     修法：compositionend 之后排一个 COMPOSE_GRACE 到期即触发的补刷，
         把「提交后的第一次刷新」补回来。语义不变：拼字期间一律不弹；
         grace 内照样不弹（既不抢输入法选词，也不抢 app.js 的 Enter 宽限），
         grace 一过就按当前输入出候选；期间任何一次新输入都会重排/清掉这个定时器。 */
  var graceTimer = 0;
  function clearGraceTimer() {
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = 0; }
  }
  function scheduleGraceRefresh() {
    clearGraceTimer();
    graceTimer = setTimeout(function () {
      graceTimer = 0;
      refresh();
    }, COMPOSE_GRACE + 20);
  }

  /* ======================================================================
     5. 填入：只改搜索框的值并派发一次 input（让别人的清空按钮等 UI 同步），
        不 submit、不 search、不碰任何检索入口。
     ====================================================================== */
  function fill(text) {
    var val = String(text == null ? '' : text);
    suppress = true;
    try {
      qEl.value = val;
      try {
        var ev = document.createEvent('Event');
        ev.initEvent('input', true, true);
        qEl.dispatchEvent(ev);
      } catch (e2) {}
      try { qEl.focus(); qEl.setSelectionRange(val.length, val.length); } catch (e3) {}
    } finally {
      suppress = false;
    }
    /* 用户已经点了某一条：这是一次「显式选择」，随后清单到货不许再把泡泡顶回来 */
    dismissed = true;
    hide();
  }

  /* ======================================================================
     6. 事件接入：全部只读监听，不改动任何既有监听器
     ====================================================================== */

  /* —— 输入法：拼字期间（中文/日文选词）不弹、不更新；提交后排一次补刷 —— */
  qEl.addEventListener('compositionstart', function () {
    composing = true;
    dismissed = false;                              /* 又开始输入了：显式收起的记录作废 */
    clearGraceTimer();                              /* 又开始拼字：撤掉待触发的补刷 */
    hide();
  }, true);
  qEl.addEventListener('compositionupdate', function () { composing = true; }, true);
  qEl.addEventListener('compositionend', function () {
    composing = false;
    composedAt = Date.now();
    scheduleGraceRefresh();                         /* ← bug ① 的修复点：提交后补刷 */
  }, true);

  /* —— 输入 / 换行粘贴 / 程序化赋值 ——
     ⚠ 这里刻意**不** clearGraceTimer()：Chrome 的提交顺序是
     compositionend → input，那次 input 必然落在 grace 内、被 refresh() 早退吞掉，
     正好要靠 compositionend 排下的补刷来兜底；真·普通输入时根本没有待触发的补刷，
     而补刷自己读的是当前 #q 的值，晚到也不会用旧文本。 */
  qEl.addEventListener('input', function (e) {
    if (e && e.isComposing) return;
    dismissed = false;
    refresh();
  }, true);
  qEl.addEventListener('change', function () {
    if (composing) return;
    dismissed = false;
    refresh();
  }, true);

  /* —— 键盘：capture 阶段先于 app.js 的冒泡监听器，消费掉才能既填入又不检索 —— */
  qEl.addEventListener('keydown', function (e) {
    if (composing || e.isComposing || e.keyCode === 229) return;
    var k = e.key;

    if (k === 'Escape') {
      if (open) { hide(); dismissed = true; e.preventDefault(); }
      return;
    }
    if (!open || !items.length) return;

    if (k === 'ArrowDown' || k === 'ArrowUp') {
      e.preventDefault();
      e.stopImmediatePropagation();
      var n = items.length;
      active = (k === 'ArrowDown')
        ? ((active + 1) % n)
        : ((active <= 0 ? n : active) - 1);
      paint();
      return;
    }
    if (k === 'Tab') {
      if (active < 0) return;                       /* 没选中就让 Tab 正常走焦点 */
      var itT = items[active];
      if (!itT) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      fill(itT.t);
      return;
    }
    if (k === 'Enter') {
      if (active < 0) return;                       /* 没选中：交给 app.js 正常检索 */
      var itE = items[active];
      if (!itE) return;
      /* 只填入：拦下事件，app.js 的 Enter→submitSearch 不会执行 */
      e.preventDefault();
      e.stopImmediatePropagation();
      fill(itE.t);
      return;
    }
  }, true);

  /* —— 鼠标点击泡泡（pointerdown 早于 blur，先消费掉再填入）—— */
  function onPoint(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var el = t.closest('.hs-sg-item');
    if (!el || !box || !box.contains(el)) return;
    if (e.button && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    fill(el.querySelector('.hs-sg-text') ? el.querySelector('.hs-sg-text').textContent : el.textContent);
  }
  if (host) {
    host.addEventListener('pointerdown', onPoint, true);
    host.addEventListener('mousedown', onPoint, true);   /* pointer 事件不可用时的兜底 */
  }

  /* —— 点外部 / 焦点离开 / 页面隐藏 → 收起 —— */
  document.addEventListener('pointerdown', function (e) {
    if (!open) return;
    var t = e.target;
    if (panel && t && panel.contains && panel.contains(t)) return;
    if (t === qEl || (qEl.contains && qEl.contains(t))) return;
    dismissed = true;                                /* 显式收起：清单到货不再顶回来 */
    hide();
  }, true);

  qEl.addEventListener('focus', function () { dismissed = false; }, true);
  qEl.addEventListener('blur', function () {
    setTimeout(function () { if (!suppress) { dismissed = true; hide(); } }, 120);
  }, true);
  window.addEventListener('pagehide', function () { hide(); });

  /* —— 提交即记账：只记「用户真正提交过的词」，不拦截、不影响检索 —— */
  function noteSubmit() {
    clearGraceTimer();               /* 已经去检索了：别再让补刷把泡泡顶回来 */
    try { record(qEl.value); } catch (e) {}
  }
  if (formEl) formEl.addEventListener('submit', noteSubmit, true);
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || composing || e.isComposing) return;
    var t = e.target;
    if (t !== qEl) return;
    if (document.activeElement !== qEl) return;
    if (Date.now() - composedAt < COMPOSE_GRACE) return;
    /* app.js 的 Enter 保护条件一致；此处只记账，不 preventDefault、不提交 */
    noteSubmit();
  }, true);

  hide();

  /* 只读调试口（供人工/自动化验证，不参与渲染与检索） */
  HS.suggest = {
    key: KEY,
    max: MAX_ITEMS,
    cap: CAP,
    /* 纯读：返回最近一次用于某前缀的候选（不写 DOM、不写存储） */
    peek: function (q) {
      try { return collect(q, Date.now()); } catch (e) { return []; }
    },
    history: function () {
      try {
        return readAll().map(function (x) { return { t: x.t, c: x.c, a: x.a }; });
      } catch (e) { return []; }
    },
    /* 纯读：词表各来源实际收录条数 + 构建耗时（首次调用会触发懒构建，之后只读缓存）。
       manifest* 字段反映 assets/dict/ip/index.json 的懒加载层：没输入过就是
       idle / 0 条（这一层只在 collect() 里、q 过了 MIN_LEN 之后才会被请求）。 */
    sources: function () {
      try {
        if (wordIndex === null) wordIndex = buildIndex();
        var c = srcCount || {};
        return {
          tag: c.tag || 0, concept: c.concept || 0, series: c.series || 0,
          genre: c.genre || 0, dict: c.dict || 0,
          manifest: c.manifest || 0,
          droppedTooLong: c._droppedLong || 0,
          total: (wordIndex || []).length,
          buildMs: Math.round(buildMs * 1000) / 1000,
          mergeMs: Math.round(manifestMs * 1000) / 1000,
          manifestState: manifestState,               /* idle | loading | ready | failed */
          manifestPkgs: manifestPkgs,
          manifestKeys: manifestKeys ? Object.keys(manifestKeys).length : 0,
          /* 词条来自哪个枚举口：'HS.dict' = 走 HS.dict 的只读枚举口；
             'none' = HS.dict 缺失 / 没有枚举口（这一路静默少收，不跨层兜底） */
          dictEnum: dictEnumKey ? 'HS.dict' : 'none',
          dictEnumKey: dictEnumKey || null
        };
      } catch (e) { return {}; }
    },
    score: histScore
  };

  /* ======================================================================
     排序公式（写在代码末尾备查）
     ─────────────────────────────────────────────────────────────────────
     历史：histScore = (1 + min(log2(count+1), 6)) × max(2^(-age/14d), 0.02)
           前缀命中额外 +40；输出分 = 100 + histScore + 前缀奖励  → tier 1
     词表：前缀命中 50 + 30×|q|/|词|；包含命中 10 + 10×|q|/|词| → tier 0
           （6 个来源并入同一池子，**不给任何来源加成**，排序与前缀/短词规则不变）
     排序：tier 降序 → score 降序 → 词长升序 → 字典序；取前 6。
     即：提交过的词永远排在词典词之前，历史内部「常用 + 最近」越强越靠前；
     14 天半衰期保证一个月前的热门词仍高于一次性新词，但会缓慢下沉。
     例外（§3c）：q 与词表某条完全相等 → 直接收起泡泡（清单锚点除外）。
     ====================================================================== */
})();
