/* ==========================================================================
   xlate.js — 跨语言检索串扩展（中文关键词 → 英 / 日 / 西 / 法 … 候选串）
   ---------------------------------------------------------------------------
   为什么需要它：
     本项目的语料大多是**中文输入**，但不少信息源只按自己的语言做匹配。
     LectorManga 是西语站、且检索口是「标题自由文本」——中文词打过去必然 0 条
     （实测：?search=人妻 → total 0；?search=naruto → 9 条）。
     这里把中文查询扩展成一串「对拉丁语系站点有意义的候选串」，交给各源去并行试。

   两条腿，缺一不可：
     ① 离线词典（**0ms、确定性**）：复用项目已有的三张表，不新增词表 ——
          · HS.TAG_ZH   1700+ 条「英文/罗马字标签键 → 中文」
          · NS.GENRES   25 组 {key(英文标签名), aliases[中/日/英]}
          · HS.CONCEPTS 128 组 {key, zh, en, ja, aliases[]}
          · NS.SERIES   100+ 条系列名（含中日英写法），用 TAG_ZH 连成并查集
        另补一张**只覆盖最高频题材词**的 zh → 西 / 法 小表：上面三张表一条西语、
        一条法语数据都没有，而西语站恰恰最需要它。宁可少而准，不做大面积错译。
     ② 在线机器译名（**best-effort**）：离线词典没覆盖的词（多半是人名 / 作品名）
        才走本地网关的 /api/translate（MyMemory，keyless）。硬超时、结果落
        localStorage（60 天 / 300 条）。**翻译失败一律静默降级**，
        绝不让「翻不出来」变成「检索报错」——这是稳定性的前提。

   对外只暴露两个口（都是纯函数 / 幂等，可安全重复调用）：
     X.offline(q) -> [{q, why, lang}]                     同步，0ms
     X.expand(q, {max, ms, onlineMs}) -> Promise<[...]>   离线 + 在线合并
   ========================================================================== */
(function (HS) {
  'use strict';
  if (!HS) return;

  const X = HS.xlate = {};

  const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;
  const KANA = /[\u3040-\u30ff]/;
  const LATIN = /[A-Za-z]/;

  X.hasCJK = s => CJK.test(String(s == null ? '' : s));
  /** 「对拉丁语系站点有意义」：含拉丁字母或假名（纯汉字 / 韩文对它们毫无意义） */
  X.useful = s => { const t = String(s == null ? '' : s); return LATIN.test(t) || KANA.test(t); };

  /* ---------------- 内置 zh → 西 / 法 常用表（离线、0ms） ----------------
     只收最高频的题材词，且只给「能在标题 / 简介里真的出现」的写法。
     刻意不追求覆盖度：错译会把检索带偏，比不译更糟。 */
  const ZH_ES = {
    '人妻': 'casada', '熟女': 'madura', '巨乳': 'pechos grandes', '爆乳': 'pechos enormes',
    '贫乳': 'pechos pequeños', '萝莉': 'loli', '正太': 'shota', '妹妹': 'hermana pequeña',
    '姐姐': 'hermana mayor', '母女': 'madre e hija', '姐妹': 'hermanas', '母亲': 'madre',
    '老师': 'profesora', '女仆': 'sirvienta', '护士': 'enfermera', '偶像': 'idol',
    '泳装': 'traje de baño', '制服': 'uniforme', '和服': 'kimono', '丝袜': 'medias',
    '百合': 'yuri', '耽美': 'yaoi', '扶她': 'futanari', '触手': 'tentáculos',
    '催眠': 'hipnosis', '奴隶': 'esclava', '痴女': 'ninfómana', '纯爱': 'romance',
    '出轨': 'infidelidad', '怀孕': 'embarazo', '分娩': 'parto', '兽耳': 'orejas de animal',
    '猫娘': 'chica gato', '魔法少女': 'chica mágica', '吸血鬼': 'vampiro', '恶魔': 'demonio',
    '天使': 'ángel', '校园': 'escuela', '公司': 'oficina', '电车': 'tren',
    '温泉': 'onsen', '足': 'pies', '口交': 'sexo oral', '肛交': 'sexo anal',
    '全彩': 'color', '无修': 'sin censura', '调教': 'entrenamiento', '学校': 'escuela'
  };
  const ZH_FR = {
    '人妻': 'femme mariée', '熟女': 'femme mûre', '巨乳': 'gros seins', '萝莉': 'loli',
    '妹妹': 'petite soeur', '姐姐': 'grande soeur', '母亲': 'mère', '老师': 'professeure',
    '女仆': 'servante', '护士': 'infirmière', '泳装': 'maillot de bain', '制服': 'uniforme',
    '百合': 'yuri', '耽美': 'yaoi', '扶她': 'futanari', '触手': 'tentacules',
    '催眠': 'hypnose', '纯爱': 'romance', '出轨': 'infidélité', '怀孕': 'grossesse',
    '校园': 'école', '魔法少女': 'magical girl', '全彩': 'couleur', '无修': 'non censuré',
    '女仆': 'servante', '学校': 'école', '姐妹': 'soeurs'
  };

  /* ---------------- 词干变体（本轮新增） ----------------
     为什么必须有：
       LectorManga 的检索是 **LIKE %q%**（实测：`capitalis` / `capitalist` 都能命中
       《Harem Capitalista》，而 `capitalismo` 命中 0 条）。机器译名给的是**名词**，
       站点标题用的却常是**同词根的另一个词性** —— 中文「资本主义」→ es「capitalismo」，
       而实际作品叫「Harem Capitalista」。只发译名本体就永远差这一步。
     做法（两条，都很保守）：
       ① 精确后缀替换：西/葡/意的 `-ismo ↔ -ista ↔ -iste ↔ -ist` 是同一词根的不同词性，
          直接替换出一两条候选（capitalismo → capitalista / capitalist）；
       ② 通用词干：砍掉常见后缀、保留 ≥6 个字符（capitalismo → capital）。
          因为站点是 LIKE %q%，一个词干能一次覆盖它所有词形。
     门槛刻意收紧（只对**单个纯拉丁词**、长度 ≥6 生效，每条最多 2 个变体）：
     宁可少给候选，也不要让一堆无意义的短词干把并行请求和结果精度都带坏。 */
  const STEM_PAIRS = [
    ['ismo', 'ista'], ['ismo', 'ist'], ['ismo', 'isme'],
    ['ista', 'ismo'], ['ista', 'ist'], ['iste', 'ista'], ['iste', 'ism'],
    ['istica', 'istico'], ['istico', 'istica']
  ];
  const STEM_SUFFIX = [
    'isticamente', 'istico', 'istica', 'mente', 'ciones', 'cione', 'dades', 'dad',
    'ismos', 'istas', 'ismo', 'ista', 'iste', 'icos', 'icas', 'ico', 'ica', 'ales', 'es', 's'
  ];

  X.stems = function (word) {
    const s = String(word == null ? '' : word).trim().toLowerCase();
    const out = [];
    const push = v => { if (v && v !== s && v.length >= 5 && out.indexOf(v) < 0) out.push(v); };
    /* 只处理单个纯拉丁词：多词短语 / 含数字 / 含中日文的都不碰 */
    if (!s || s.indexOf(' ') >= 0 || !/^[a-zà-öø-ÿ]+$/.test(s) || s.length < 6) return out;
    STEM_PAIRS.forEach(p => { if (s.length > p[0].length && s.slice(-p[0].length) === p[0]) push(s.slice(0, -p[0].length) + p[1]); });
    for (let i = 0; i < STEM_SUFFIX.length; i++) {
      const suf = STEM_SUFFIX[i];
      if (s.length <= suf.length) continue;
      if (s.slice(-suf.length) !== suf) continue;
      const stem = s.slice(0, -suf.length);
      if (stem.length >= 6) { push(stem); break; }
    }
    return out.slice(0, 2);
  };

  /* ---------------- 切词表：中日文词 → 候选串 ---------------- */
  let SEG = null;

  function buildSeg() {
    if (SEG) return SEG;
    const map = {};
    const put = (term, cands) => {
      const t = String(term == null ? '' : term).trim().toLowerCase();
      /* 只收「本身是中日文」的词：拉丁词不需要翻译，收进来只会浪费切词时间 */
      if (!t || t.length < 2 || !CJK.test(t)) return;
      if (!map[t]) map[t] = [];
      (cands || []).forEach(c => {
        const s = String(c == null ? '' : c).trim();
        if (!s) return;
        if (s.toLowerCase() === t) return;                 /* 与自己相同 = 没翻译 */
        if (!X.useful(s)) return;                          /* 对拉丁语系站点没意义 */
        if (map[t].indexOf(s) < 0) map[t].push(s);
      });
    };

    /* ① TAG_ZH：英文 / 罗马字键 → 中文值（值可能带 "A/B" 多种写法） */
    const dict = HS.TAG_ZH || {};
    Object.keys(dict).forEach(k => {
      const zh = String(dict[k] == null ? '' : dict[k]).trim();
      if (!zh) return;
      zh.split(/[\/、,，|]/).forEach(part => put(part, [String(k).toLowerCase()]));
    });

    /* ② GENRES：aliases（含中文）→ 英文标签键名 */
    (HS.GENRES || []).forEach(g => (g.aliases || []).forEach(a => put(a, [g.key])));

    /* ③ CONCEPTS：zh / aliases → en / ja */
    (HS.CONCEPTS || []).forEach(c => {
      const cands = [c.en, c.ja].filter(Boolean);
      const zhs = [c.zh].concat(c.aliases || []);
      zhs.forEach(z => put(z, cands));
    });

    /* ④ 内置西 / 法小表 */
    Object.keys(ZH_ES).forEach(z => put(z, [ZH_ES[z]]));
    Object.keys(ZH_FR).forEach(z => put(z, [ZH_FR[z]]));

    const keys = Object.keys(map).sort((a, b) => b.length - a.length);
    SEG = { map: map, keys: keys, maxLen: keys.length ? keys[0].length : 0 };
    return SEG;
  }

  /** 贪心最长匹配切词：把「巨乳人妻」切成 巨乳 + 人妻（不认识的字符单独成块） */
  function segment(q) {
    const s = buildSeg();
    const out = [];
    if (!s.maxLen) return out;
    let i = 0;
    while (i < q.length) {
      let hit = '';
      const cap = Math.min(s.maxLen, q.length - i);
      for (let L = cap; L >= 2; L--) {
        const w = q.substr(i, L);
        if (s.map[w]) { hit = w; break; }
      }
      if (hit) { out.push({ w: hit, c: s.map[hit] }); i += hit.length; }
      else { out.push({ w: q.charAt(i), c: null }); i += 1; }
    }
    return out;
  }

  /* ---------------- 系列：同作品的不同写法连成一组 ----------------
     与 core.js 的 seriesGroups() 同一套做法（那边没导出，这里独立再建一份）。
     只用**已有数据**连通，不新增任何词表：
       · TAG_ZH 里「键与值都出现在 NS.SERIES 中」的那些对（arknights ↔ 明日方舟 …）
       · NS.SERIES 里显式列着的片假名写法对照 */
  const SERIES_SAME = [
    ['arknights', 'アークナイツ'], ['azur lane', 'アズールレーン'],
    ['umamusume', 'ウマ娘'], ['love live', 'ラブライブ'],
    ['starsavior', 'スターセイヴァー']
  ];
  let SERIES_MAP = null;

  function buildSeries() {
    if (SERIES_MAP) return SERIES_MAP;
    const parent = {};
    const add = x => { if (parent[x] === undefined) parent[x] = x; return x; };
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { a = find(add(a)); b = find(add(b)); if (a !== b) parent[b] = a; };
    const inS = {};
    (HS.SERIES || []).forEach(x => { inS[String(x).toLowerCase()] = 1; });
    const dict = HS.TAG_ZH || {};
    Object.keys(dict).forEach(k => {
      const kk = String(k).toLowerCase().trim();
      const vv = String(dict[k] == null ? '' : dict[k]).toLowerCase().trim();
      if (!kk || !vv) return;
      if (inS[kk] || inS[vv]) union(kk, vv);
    });
    SERIES_SAME.forEach(p => union(p[0], p[1]));
    const byRoot = {};
    Object.keys(parent).forEach(x => { const r = find(x); (byRoot[r] = byRoot[r] || []).push(x); });
    SERIES_MAP = {};
    Object.keys(parent).forEach(x => { SERIES_MAP[x] = byRoot[find(x)]; });
    return SERIES_MAP;
  }

  /* ---------------- 离线候选（同步、0ms） ---------------- */
  function pushUnique(out, seen, text, why, lang) {
    const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!t || !X.useful(t)) return;
    const k = t.toLowerCase();
    if (seen[k]) return;
    seen[k] = 1;
    out.push({ q: t, why: why || '', lang: lang || '' });
  }

  /** pushUnique + 紧跟着它的词干变体（顺序很重要：变体必须紧跟在母词后面，
      这样 lectormanga 那种「只取前 N 条候选」的并行批次不会把变体挤掉） */
  function pushWithStems(out, seen, text, why, lang) {
    const before = out.length;
    pushUnique(out, seen, text, why, lang);
    if (out.length === before) return;              // 母词被去重掉就不再加变体
    const parent = out[before].q;
    X.stems(parent).forEach(v => pushUnique(out, seen, v, '词干变体：' + parent, lang));
  }

  X.offline = function (q) {
    const raw = String(q || '').replace(/\s+/g, ' ').trim();
    if (!raw) return [];
    const low = raw.toLowerCase();
    const out = [], seen = {};
    if (!X.hasCJK(low)) return out;                   /* 本来就是拉丁 / 假名查询：不用扩展 */

    /* ① 整串直接命中词典（系列 / 体裁 / 概念 / 标签反查） */
    const seg = buildSeg().map;
    if (seg[low]) seg[low].forEach(c => pushWithStems(out, seen, c, '词典译名', ''));
    const grp = buildSeries()[low];
    if (grp) grp.forEach(g => pushUnique(out, seen, g, '系列译名', ''));

    /* ② 空格分隔的整串：逐词翻，再拼成一条 */
    const words = low.split(' ').filter(Boolean);
    if (words.length > 1) {
      const parts = words.map(w => (seg[w] && seg[w][0]) || (CJK.test(w) ? '' : w));
      if (parts.every(Boolean) && parts.some(p => LATIN.test(p))) {
        pushUnique(out, seen, parts.join(' '), '逐词译名', 'mixed');
      }
    }

    /* ③ 无空格的中日文串：贪心切词后逐词翻，拼成一条整串（"巨乳人妻" → "big breasts casada"） */
    if (CJK.test(low) && low.indexOf(' ') < 0) {
      const segs = segment(low);
      if (segs.length > 1 && segs.some(s => s.c)) {
        const parts = [];
        let allLatin = true;
        segs.forEach(s => {
          if (s.c && s.c.length) {
            parts.push(s.c[0]);
            if (!LATIN.test(s.c[0])) allLatin = false;
          } else {
            parts.push(s.w);
            if (CJK.test(s.w)) allLatin = false;
          }
        });
        if (allLatin && parts.length) pushUnique(out, seen, parts.join(' '), '逐词译名', 'mixed');
      }
      /* 单个词自己也当候选：有些站对单标签 / 短标题更敏感（这批带词干变体） */
      segs.forEach(s => { if (s.c && s.c.length) pushWithStems(out, seen, s.c[0], '词：' + s.w, ''); });
    }

    return out;
  };

  /* ---------------- 在线译名（网关代取 + localStorage 缓存） ---------------- */
  const XK = 'hs.xlate.v1';
  const X_TTL = 60 * 864e5;
  const X_MAX = 300;

  function xread() {
    try {
      const raw = window.localStorage.getItem(XK);
      if (!raw) return {};
      const db = JSON.parse(raw);
      if (!db || typeof db !== 'object' || !db.items || typeof db.items !== 'object') return {};
      return db.items;
    } catch (e) { return {}; }
  }
  function xwrite(items) {
    try { window.localStorage.setItem(XK, JSON.stringify({ v: 1, items: items })); return true; }
    catch (e) { return false; }
  }

  /** 在线机器译名。任何异常 / 超时 / 旧网关 → 返回空对象（调用方静默降级） */
  X.online = async function (q, ms) {
    const key = String(q || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 120);
    if (!key || !X.hasCJK(key)) return {};
    const items = xread();
    const hit = items[key];
    if (hit && hit.r && (!hit.t || Date.now() - hit.t < X_TTL)) return hit.r;
    const gw = HS.net && HS.net.gateway;
    /* 旧网关没有 xlate 能力位：直接跳过，省一次注定 404 的本地往返 */
    if (!gw || !gw.ok || !(gw.info && gw.info.xlate)) return {};
    const budget = Math.max(1200, Math.min(5000, ms || 2500));
    let r = {};
    try {
      const res = await gw.get('/api/translate',
        { q: key, to: 'en,es,ja,fr', ms: String(budget) }, budget + 800);
      r = (res && res.results) || {};
    } catch (e) { r = {}; }
    /* 命中才写缓存；空结果不写，免得把「这一次网络抖了」固化 60 天 */
    if (Object.keys(r).length) {
      items[key] = { r: r, t: Date.now() };
      const keys = Object.keys(items);
      if (keys.length > X_MAX) {
        keys.sort((a, b) => (Number(items[a].t) || 0) - (Number(items[b].t) || 0));
        keys.slice(0, keys.length - X_MAX).forEach(k => { delete items[k]; });
      }
      xwrite(items);
    }
    return r;
  };

  /**
   * 离线 + 在线合并（**推荐入口**）。
   * @param {string} q
   * @param {{max?:number, ms?:number, online?:boolean}} o
   *        max    最多返回几条候选（默认 4）
   *        ms     在线翻译的总预算（毫秒，默认 2500）
   *        online false 时只走离线词典（用于「先发快的那批」）
   * @returns {Promise<Array<{q:string, why:string, lang:string}>>}
   */
  X.expand = async function (q, o) {
    o = o || {};
    const raw = String(q || '').replace(/\s+/g, ' ').trim();
    if (!raw) return [];
    const max = Math.max(1, Math.min(8, parseInt(o.max, 10) || 4));
    const out = X.offline(raw);
    const seen = {};
    out.forEach(c => { seen[c.q.toLowerCase()] = 1; });
    if (o.online !== false && X.hasCJK(raw) && out.length < max) {
      const r = await X.online(raw, o.ms);
      /* ★每个译名后面紧跟它的词干变体★ —— 顺序在这里是有意义的：
         LectorManga 只并发发前几条候选，而「机器译名恰好是另一个词性」正是最常见的
         落空原因（实测：资本主义 → es「capitalismo」0 条，而作品叫「Harem Capitalista」；
         变体 capitalista / capitalist / capital 都能命中）。把变体插在母词后面，
         它才不会被 max 截掉。 */
      ['es', 'en', 'fr', 'ja'].forEach(lang => {
        const t = r && r[lang];
        if (!t) return;
        pushWithStems(out, seen, t, '机器译名(' + lang + ')', lang);
      });
    }
    return out.filter(c => X.useful(c.q)).slice(0, max);
  };

  /* 只读调试口（自测 / 人工验证用，不参与渲染与检索） */
  X.debug = function () {
    const s = buildSeg();
    return {
      terms: s.keys.length,
      maxLen: s.maxLen,
      series: Object.keys(buildSeries()).length,
      zhEs: Object.keys(ZH_ES).length,
      zhFr: Object.keys(ZH_FR).length,
      cached: Object.keys(xread()).length
    };
  };
})(window.HS);
