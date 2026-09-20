/* ==========================================================================
   results.js — 结果聚合后处理与渲染
   跨源去重 → 相关性重排 → 同系列堆叠 → 卡片渲染（封面模糊 / 骨架 / 流式）
   ========================================================================== */
(function (HS) {
  'use strict';
  const u = HS.u;
  const R = HS.results = {};

  R.raw = [];           // 原始合并结果
  R.items = [];         // 处理后的结果
  R.q = ''; R.f = {};
  R._partial = [];      // 流式接收阶段的逐源结果
  R.streaming = false;
  R.page = 1;           // 已经向各源要到的页数（向下滚动时递增）
  R._pages = [];        // 已累计的原始结果（继续加载时不断追加）
  R.pageBusy = false;
  R.loadingMore = false;// 正在向各源索取下一批
  R.zhOnly = false;     // 只看汉化 / 中文
  R.intent = null;      // 查询意图（title / character / genre）

  R.sourceFilter = null;
  R.seriesOnly = null;  // 只看某个系列（由堆叠角标触发）

  /* 单页渲染状态：_layout 是全量布局，_shown 是已经铺开的节点数，滚到底继续追加 */
  R._layout = [];
  R._shown = 0;
  R._nodes = [];
  R._rendered = 0;
  R._dom = {};          // layoutId → 已铺开的 DOM 节点（继续加载时复用，避免重建闪烁）
  R._dirty = false;     // 累积结果里有条目被合并过 → 不能走「纯追加」快路
  R.order = [];         // 已经铺开的那批的展示顺序（条目 key 序列）
  R.appendMode = false; // 本次渲染是不是「追加」：true = 老顺序原样保留，新条目只能接在末尾

  const STACK_MAX = 5;        // 一个堆叠最多平铺几张

  /* ---------------- 去重 + 重排 ---------------- */
  function weightOf(id) {
    const s = HS.sources.byId[id];
    return s ? s.weight : 0.5;
  }

  /**
   * 源优先级（**硬性分区，不是打分**）：注册表里标了 `last` 的源 —— 目前只有拷贝漫画
   * （综合向站点，和成人向检索的相关性最弱）—— 一律排在其它所有源之后。
   * 为什么不用 weight：weight 只进 relevance() 的底分，是一条软性偏置，别的源只要标题 /
   * 标签命中得好就照样能把它顶下去，保证不了「一定在最后」。这里用**稳定分区**实现：
   * 组内相对顺序完全不动（同一源内部仍按现有相关性排），只是把末位源整体挪到末尾。
   * ★不要把它塞进 buildLayout / sameish★ —— 同系列堆叠是另一套逻辑，本改动不碰。
   */
  function isLastSource(it) {
    const s = (it && HS.sources && HS.sources.byId) ? HS.sources.byId[it.source] : null;
    return !!(s && s.last);
  }
  /** 稳定分区：非末位源在前、末位源在后；两段各自的相对顺序原样保留 */
  function sinkLastSources(list) {
    const head = [], tail = [];
    (list || []).forEach(it => { (isLastSource(it) ? tail : head).push(it); });
    return tail.length ? head.concat(tail) : head;
  }

  /* ---------------- 编号直达置顶 ----------------
     用户直接甩一个禁漫作品编号（`1474541` / `jm1474541`）时，sources.js 会**按编号**
     把那一本取回来并打上 `jmDirect` 标记；这里把它稳定分区到**所有排序结果的最前面**。
     位置选在 applyView() 的最后一环（sinkLastSources 之后），所以：
       · 不管 R.sort 是默认 / 页数 / 源名 / 标题，也不管 appendMode（继续加载）——
         置顶分区都是最后一道，必然吃到第一位；
       · 不参与打分（relevance 给数字输入打不出好分），所以不靠「分数高」保证，
         用与末位源对称的**硬性稳定分区**实现；
       · 「拷贝漫画排最后」的分区在这个分区之前跑完，两者互不干扰（末位分区只动
         copymanga 那些条目，置顶分区只把编号直达项提到最前，其余条目相对顺序一条不动）；
       · 也不进 buildLayout / sameish —— 同系列堆叠照旧，只是它一定落在第一个布局节点。
     去重：编号直达项是**最高优先级**，命中的那一本不能被「中文版去重」剔掉 ——
     这一条在 dropZhLangDup 里显式放过（见 kind 判定），这里再把与它同 key 的重复项摘掉，
     保证页面上只有它这一张（同 key 的其它语言变体是不同 key，不受影响）。 */
  function isDirectHit(it) {
    if (!it) return false;
    if (it.jmDirect || it.directHit) return true;
    return !!(HS.sources && HS.sources.isJmDirectHit && HS.sources.isJmDirectHit(it));
  }
  /** 稳定分区：编号直达项按原顺序在最前，其余条目相对顺序一条不动 */
  function liftDirectHits(list) {
    const head = [], rest = [];
    (list || []).forEach(it => { (isDirectHit(it) ? head : rest).push(it); });
    return head.length ? head.concat(rest) : rest;
  }

  /* ---------------- 多段命中（多关键词排序的主导项） ----------------
     查询里出现多个关键词时，core.js 的 classifyQuery 会给出 segments（逐段判定的意图）。
     这里数一件作品**同时命中了几段**，然后：

       · 排序上：**先比命中段数，再比旧分数**（见 cmpHit / applyView 的比较器）——
         严格的字典序主导，段数多的一定在前，不论它来自多弱的源、多小的热度。
       · 分数上：命中段数 × SEG_HIT，全部命中再 + SEG_ALL（让 _score 自身也带着段数信息，
         与排序口径一致）。

     为什么必须是字典序、而不是「每段给固定分」就够：
       旧分数项的跨度很大（源权重 10×0.5–1.25、标题完全命中 +16、标签命中 +9、
       汉化 +6、画质/页数 +5……单项就能差 40 分以上），固定分再大也可能被旧项翻盘 ——
       实测：一段命中但热度高的条目能压过两段命中的条目。所以「段数优先」用比较器实现，
       固定分只负责让 _score 与排序口径一致。
     为什么这样排：
       · 用户打多个词 = 想要「同时满足这些词」的东西；旧口径里只要命中系列就能拿到
         标签 / 系列 / 标题三项加分，单个关键词足以把「只跟它相关的作品」顶到最前。
       · 段数相同时，源权重 / 热度 / 页数 / 汉化这些旧项照旧决定次序。
       · **是排序偏好，不是过滤**：一段都没命中的条目照样保留在结果里，只是排在后面。
       · 只有 multi（真·多关键词，段数 ≥2）才算段数 —— 单关键词查询的分数与顺序
         与旧版逐字节一致（_segHit 为 undefined，字典序键恒为 0）。
     ==================================================================== */
  const SEG_HIT = 13;   // 每命中一段（进 _score）
  const SEG_ALL = 9;    // 全部段都命中，_score 上再抬一档

  /** 排序主键之一：命中段数（非多关键词查询一律 0） */
  function segKey(it) { return (it && it._segHit) || 0; }
  /** 排序比较器：① 多关键词命中段数（字典序主导）② 名字档（名字符合 > 仅标签命中）
      ③ 名字贴合度（完全同名 > 前缀 > 包含）④ 旧分数 */
  function cmpHit(a, b) {
    return segKey(b) - segKey(a) || nameKey(b) - nameKey(a) || nameTie(a, b) || b._score - a._score;
  }

  /** 条目正文（小写）：标题 + 画师 + 系列 + 标签 + 备注。不缓存 —— 跨源合并会往 tags 里并数据 */
  function itemBlob(it) {
    return [it.title, it.artist, it.series, (it.tags || []).join(' '), it.note]
      .filter(Boolean).join(' ').toLowerCase();
  }

  /** 别名命中：纯 ASCII 别名要求**词边界**（否则 'ol' 会命中 'loli' / 'college'），
      中日文别名按包含匹配。 */
  const ASCII_ONLY = /^[\x20-\x7e]+$/;
  function aliasHit(blob, alias) {
    const a = String(alias == null ? '' : alias).toLowerCase().trim();
    if (!a) return false;
    if (!ASCII_ONLY.test(a)) return blob.indexOf(a) >= 0;
    let from = 0;
    for (;;) {
      const at = blob.indexOf(a, from);
      if (at < 0) return false;
      const pre = at > 0 ? blob.charAt(at - 1) : '';
      const post = at + a.length < blob.length ? blob.charAt(at + a.length) : '';
      if (!/[a-z0-9]/.test(pre) && !/[a-z0-9]/.test(post)) return true;
      from = at + 1;
    }
  }

  /** 一件作品是否命中某个查询段（b 传条目正文可以复用，避免每段拼一次） */
  function segHit(it, seg, b) {
    if (!seg) return false;
    const blob = b == null ? itemBlob(it) : b;
    if (seg.kind === 'series' && seg.series) {
      const names = seg.aliases && seg.aliases.length ? seg.aliases : [seg.series];
      if (it.series && names.indexOf(String(it.series).toLowerCase()) >= 0) return true;
      return names.some(n => aliasHit(blob, n));
    }
    const list = (seg.aliases && seg.aliases.length) ? seg.aliases : [seg.text];
    return list.some(a => aliasHit(blob, a));
  }

  /* ======================================================================
     「名字符合」优先（本次修复的核心）
     ----------------------------------------------------------------------
     症状（用户报告）：搜 `人妻猎人` 时，排在最前面的不是名字就叫《人妻猎人》的那一本，
     而是「标题里恰好含有『人妻』」的别的作品。
     根因：core.js 的 classifyQuery('人妻猎人') 命中概念 `人妻`（conceptOf 允许中文短词
     包含匹配）⇒ kind='genre'，于是 relevance() 走「按 tags 命中题材别名 ×5（上限 14）」
     那一支，**titleFit 只在 kind==='title' 时才计分** —— 名字完全对上的一本只拿到
     「标题字面 +9 / 标题归一 +5」，而一本名字毫不相干、只是标签沾边的作品靠
     「源权重 + 中文 + 页数 + 标签量」就能反超。
     语义：**名字符合（含译名 / 中译名）必须无条件排在「只是标签同义」的前面**。
     做法（只影响排序，不做任何过滤 —— 一条结果都不会被删掉）：
       · 每次都算标题贴合度（不再只在 kind==='title' 时算），并把它拆成
         「直接同名」与「译名同名」两档（译名档权重略低，不能盖过直接同名）；
       · 中英 / 中日互查（译名）：只读 dict.js 的 TAG_ZH / HS.CONCEPTS，不新增任何词表 ——
         `人妻猎人` →（去掉已命中的概念词「人妻」）→ 残余 `猎人` → TAG_ZH 反查
         → `hunter`；`明日方舟` →（seriesAliases）→ `arknights`；`寝取` → `netorare` / `ntr`；
         `milf hunter` → `熟女` 这类反查也走同一条路；
       · 简繁 / 异体：TAG_ZH 条目里并列的其它中文写法仍是**译名档**；
                  结构判据 —— 查询在标题里同位置对齐、只差一个字（`人妻猎人`/`人妻獵人`、
                     `寝取`/`寢取`）**并入「直接同名」档（+16，与完全同名同档）**；
                     安全边界不变：2 字查询只认整串等长，≥3 字才允许子串滑动；
       · 排序上新增**名字档比较器**（与既有的「多关键词命中段数」并列，段数仍优先）：
         完全同名（直接）> 完全同名（译名 / 简繁）> 前缀 > 包含 > 无关；同档内再按旧分数；
       · `copymanga 末位分区` / `编号直达置顶` / `同系列堆叠` / 追加顺序（R.order /
         R.appendMode）都不在这个比较器的作用域里 —— 它们仍是 applyView() 的最后几道。
     未做的（要改 core.js / sources.js 才能彻底解决，见交接报告）：
       · classifyQuery 仍把 `人妻猎人` 判成 kind='genre'（概念 `人妻`），sources.js 据此
         只按「人妻」检索，所以「名字就叫《人妻猎人》」的那几本**根本不在结果集里**时
         无从谈起 —— 本次只能修「在结果集里时怎么排」。
      ====================================================================== */

  /* 中英 / 中日互查用的「译名等价串」：把查询换成它**在别的语言 / 别的写法下的样子**，
     用来判断一条标题是不是就是用户要找的那部作品（只是译名 / 简繁不同）。
     数据全部来自现成字段，**不新增词表**：
       · classifyQuery 已认出的 concept.aliases（同一概念的中 / 日写法）
       · TAG_ZH 正查（中文 → 英文 / 罗马字键）与反查（英文 / 罗马字键 → 中文值）
       · 查询去掉已命中的概念 / 题材词后的**残余词**再查一次
         （`人妻猎人` 命中概念「人妻」→ 残余 `猎人` → 反查 `hunter`）
       · 同一个 TAG_ZH 条目里并列的**其它中文写法**（`netorare` → `寝取、寢取` 这种简繁并列）
     注意：译名等价串**只与标题比对**，绝不参与标签计分 —— 标签分项口径一字未改。 */
  const XALIAS_MAX = 48;
  let ZH_REV_DERIVED = null;
  /** 反查表：英文 / 罗马字键 → 该键指向的中文值（只为译名互查服务，只读 TAG_ZH） */
  function revDict() {
    if (ZH_REV_DERIVED) return ZH_REV_DERIVED;
    const dict = HS.TAG_ZH || {};
    const rev = Object.create(null);
    Object.keys(dict).forEach(k => {
      const v = String(dict[k] == null ? '' : dict[k]).toLowerCase().trim();
      if (v) (rev[v] = rev[v] || []).push(String(k).toLowerCase());
    });
    ZH_REV_DERIVED = rev;
    return rev;
  }
  function xAliases(q, intent) {
    const low = String(q == null ? '' : q).toLowerCase().trim();
    const set = [];
    /* 查询自己已经命中的概念 / 题材词，**不能**再当成「译名」参与标题比对：
       搜 `人妻猎人` 时「人妻」正是查询里那个词，用它去比标题就会把
       《巨乳人妻玲子…》这种「只是标签沾边」的条目也判成「名字符合」——
       那正是本次要修的反面。译名只留**查询里没出现过的其它写法 / 语言**。
       （`寝取` 的本体就是题材别名，但它没有 concept.aliases，这里不拦；
        它真正的译名来自反查表 netorare / ntr，仍然生效。） */
    const own = Object.create(null);
    const c = intent && intent.concept;
    if (c) {
      own[low] = 1;
      (c.aliases || []).forEach(a => { own[String(a).toLowerCase()] = 1; });
    }
    /* 注意：**不能**把题材别名（genre.aliases）整批排除 —— 搜 `寝取` 时题材别名里就有
       它真正的译名 `netorare` / `ntr`，搜 `明日方舟` 时系列别名里有 `arknights`；
       排除掉就把译名判定一并废了。只排除「与查询本身完全同字」的写法（那是查询原词，
       拿它比标题只会把「标题里含这个词」误判成名字符合）。 */
    own[low] = 1;
    const push = x => {
      const s = String(x == null ? '' : x).toLowerCase().trim();
      if (s.length < 2 || s === low || own[s]) return;
      if (set.indexOf(s) < 0 && set.length < XALIAS_MAX) set.push(s);
    };
    const dict = HS.TAG_ZH || {};
    const rev = revDict();
    /* ① 同一概念的其它语言写法（core.js 已经算好了） */
    if (c) (c.aliases || []).forEach(push);
    if (intent && intent.genre) (intent.genre.aliases || []).forEach(push);
    /* ② 中文 → 英文 / 罗马字（整串与残余词都查） */
    const lookup = tok => {
      const t = String(tok || '').toLowerCase();
      if (t.length < 2) return;
      const zh = dict[t];
      if (zh) (rev[String(zh).toLowerCase()] || []).forEach(push);
      const list = rev[t] || [];
      if (list.length && list.length <= 8) list.forEach(push);
    };
    lookup(low);
    /* 残余词：`人妻猎人` 去掉命中词「人妻」→ `猎人`。
       残余词常常只是一个**词组片段**（`猎人` 在 TAG_ZH 里只是 `monster hunter`→`怪物猎人` 的尾段），
       所以这里再做一次「中文值**包含**残余词」的反查 —— 仍然只读 TAG_ZH，不新增数据。 */
    const residualLookup = tok => {
      const t = String(tok || '').toLowerCase();
      if (t.length < 2) return;
      lookup(t);
      let n = 0;
      Object.keys(rev).forEach(v => {
        if (n >= 6 || v.length < t.length || v.indexOf(t) < 0) return;
        n++;
        rev[v].slice(0, 2).forEach(k => {
          /* 只取那条 key 里「除去公共中文部分」剩下的外文词：`monster hunter` → `hunter` */
          String(k).split(/[\s/]+/).forEach(w => { if (w.length >= 2) push(w); });
        });
      });
    };
    /* 残余词：`人妻猎人` 去掉命中词「人妻」→ `猎人` */
    const words = [];
    if (c) (c.aliases || []).forEach(a => words.push(String(a).toLowerCase()));
    if (intent && intent.genre) (intent.genre.aliases || []).forEach(a => words.push(String(a).toLowerCase()));
    let residual = low;
    words.sort((a, b) => b.length - a.length).forEach(a => {
      if (a.length >= 2) residual = residual.split(a).join(' ');
    });
    residual.split(/\s+/).forEach(residualLookup);
    /* ③ 同一个 TAG_ZH 条目里并列的其它中文写法（`netorare` → `寝取、寢取`），
          以及「中文键 → 中文值」的等价写法（同一 tag 的简繁两种写法）。 */
    const zhSiblings = tok => {
      const t = String(tok || '').toLowerCase();
      if (t.length < 2) return;
      const sink = v => {
        if (!v) return;
        String(v).split(/[、,，/|]+/).forEach(x => {
          const w = x.trim();
          if (w.length >= 2 && /[\u3400-\u9fff]/.test(w)) push(w);
        });
      };
      sink(dict[t]);
      const list = rev[t] || [];
      if (list.length && list.length <= 4) list.forEach(k => sink(dict[k]));
    };
    zhSiblings(low);
    residual.split(/\s+/).forEach(zhSiblings);
    return set;
  }

  const XALIAS_CACHE = {};
  /**
   * 查询是否「看起来像一个作品名」——决定要不要做中英 / 简繁互查（译名判定）。
   *   · 带括号 / 引号 / 数字：通常是「关键词串」或编号，不当作品名；
   *   · 中日文：单块 ≤8 字（`人妻猎人` 算，`巨乳人妻玲子` 这种长串不算）；
   *   · 拉丁：≤3 个词，且**至少一个词能在 TAG_ZH 的键里找到**
   *     （`milf hunter` / `hitozuma hunter` 算 —— 它们是「罗马字 / 英译的作品名」；
   *      `big breasts` 这种纯题材词不算，避免把题材词硬当作品名跨语言硬套）。
   */
  function queryLooksTitle(q) {
    const s = String(q || '').trim();
    if (!s || /[[\]【】()（）「」『』"']/.test(s) || /\d/.test(s)) return false;
    if (/[\u3400-\u9fff\u3040-\u30ff]/.test(s)) return !/\s/.test(s) && s.length <= 8;
    const words = s.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length || words.length > 3) return false;
    if (!/^[a-z0-9!'.:\-\s]+$/.test(s)) return false;
    const dict = HS.TAG_ZH || {}, rev = revDict();
    return words.some(w => w.length >= 3 && (dict[w] != null || rev[w] != null));
  }
  /** 查询的「译名等价串」；查询本身不是作品名形状时返回空（避免把题材词当作品名跨语言硬套） */
  function xAliasesFor(q, intent) {
    if (!queryLooksTitle(q)) return [];
    const key = String(q).toLowerCase();
    if (!XALIAS_CACHE[key]) XALIAS_CACHE[key] = xAliases(q, intent);
    return XALIAS_CACHE[key];
  }

  /** 一条标题与查询的贴合度（与 u.titleFit 完全同口径，只读调用） */
  function fitOf(title, q) { return u.titleFit(title, q); }

  /* 简繁「一字之差」容差：TAG_ZH 里**没有**对照的简繁对（`猎` / `獵` 这类：词典只有
     `monster hunter`→`怪物猎人` 整词，没有 `猎人` 这一条）无法从数据里推导，但可以按
     **结构**判：短串（查询）在长串（标题）里**同位置对齐**、只差一个字 —— 这几乎只可能是
     同一部作品的简繁两种写法（`人妻猎人` / `人妻獵人`、`寝取` / `寢取らせ`）。
     判据是**纯结构**的（仓库里没有简繁对照数据：`dict.js` 里 `獵` / `寢` 出现 0 次），
     因此它分不清「真简繁对」与「任意差一个汉字的词对」—— `巨乳` / `巨孔`、`人妻` / `人妖`
     同样满足结构。按维护者选定的**安全口径**，命中后按字数分档：
       · **≥3 字**变体 → 并入 `fit`（直接同名档 +16）；
       · **2 字**变体  → 只并入 `xfit`（译名档 +12；2 字无法与任意差一字词对区分，不许顶到第 1）。
     限制（宁可漏判不可误判）：
       · 只在查询是「作品名形状」（见 queryLooksTitle）时生效；
       · 两边都得是中日文，对齐窗口内只允许一个字不同；
       · 2 字查询**只认整串等长**的对照（`寝取` / `寢取`）—— 代码里是**显式的等长硬闸**
         （不许任何前缀 / 子串对齐），允许它滑动会立刻误判
         （实测 `巨乳` 会把《巨卡×女飘》当成同一个名字）；3 字起才允许子串对齐。
       · 返回值 = 变体档：`0` 不命中 / `2` 两字变体（见 nameFit 的 ③ → xfit）/
         `3` 三字及以上（见 nameFit 的 ③ → fit）。 */
  const CVAR_MIN_SUB = 3;
  function cjkOneCharVariant(title, q) {
    if (!queryLooksTitle(q)) return 0;
    const a = u.normTitle(title), b = u.normTitle(q);
    if (!a || !b || a === b) return 0;
    const short = a.length <= b.length ? a : b;
    const long = a.length <= b.length ? b : a;
    if (short.length < 2 || long.length < short.length) return 0;
    if (!/[\u3400-\u9fff]/.test(short) || !/[\u3400-\u9fff]/.test(long)) return 0;
    /* 2 字查询：**只认整串等长**的对照（`寝取` / `寢取`），一个位置的滑动都不许有。
       少了这一条，`巨乳` 会在真标题《巨卡×女飄》上「同位置对齐、只差一个字」而误判成同名
       （实测：真网关搜 `巨乳` 时它一度排在第 1 条）；≥3 字才放开子串滑动（见下面的 last）。 */
    if (short.length < CVAR_MIN_SUB && a.length !== b.length) return 0;
    /* 所有对齐位置都要试：`寢取らせ篇` 这类标题里，查询出现在中间而不是开头。
       2 字查询这里只认「整串等长」的对照（`寝取` / `寢取`）—— 允许它做子串滑动会误判
       （`巨乳` 会把《巨卡×女飘》当成同一个名字）；代价是 2 字查询在更长的标题里
       （`寢取らせ篇`）只能靠译名（netorare / ntr）命中，这是有意的取舍。 */
    const last = short.length >= CVAR_MIN_SUB ? long.length - short.length : 0;
    for (let at = 0; at <= last; at++) {
      let diff = 0, same = 0, ok = true;
      for (let i = 0; i < short.length; i++) {
        const x = short.charAt(i), y = long.charAt(at + i);
        if (x === y) { same++; continue; }
        if (!/[\u3400-\u9fff]/.test(x) || !/[\u3400-\u9fff]/.test(y)) { ok = false; break; }
        diff++;
        if (diff > 1) { ok = false; break; }
      }
      /* 窗口内只允许**一个字**不同，且其余每个位置都必须完全相同 */
      if (ok && diff === 1 && same === short.length - 1) return short.length >= CVAR_MIN_SUB ? 3 : 2;
    }
    return 0;
  }
  /** 参与「名字符合」判定的标题字段：主标题 + 中译名（mk() 把中译名挂在 tags 里） */
  function titleFields(it) {
    const out = [String(it.title || '')];
    const tags = it.tags || [];
    for (let i = 0; i < tags.length && out.length < 4; i++) {
      const t = String(tags[i] || '');
      if (t && t !== out[0]) out.push(t);
    }
    return out;
  }
  /**
   * 名字贴合度（含译名 / 中译名）：
   *   fit  0–3 与 u.titleFit 同口径（3 完全同名 / 2 前缀 / 1 包含），取各标题字段最优
   *   xfit 0–3 同上，但用「跨语言译名等价串」命中的（**≥3 字**的简繁一字之差已并入 fit，
   *           **2 字**的简繁一字之差留在这里） —— 只算标题，不算标签
   */
  function nameFit(it, q, xa) {
    const fields = titleFields(it);
    /* ① 直接贴合：与 u.titleFit 完全同口径 */
    let fit = 0;
    for (let i = 0; i < fields.length; i++) fit = Math.max(fit, fitOf(fields[i], q));
    /* ② 译名贴合：只比主标题，且只比「查询里没出现的其它语言 / 其它写法」 */
    let xfit = 0;
    if (xa && xa.length && fit < 3) {
      const main = fields[0];
      for (let i = 0; i < xa.length; i++) {
        xfit = Math.max(xfit, u.titleFit(main, xa[i]));
        if (xfit === 3) break;
      }
    }
    /* ③ 只差一字的简繁变体（`人妻猎人` / `人妻獵人`）：**按字数分档并入** ——
          ≥3 字进 `fit`（直接同名档 +16），2 字进 `xfit`（译名档 +12）。
          判据不新造 —— 仍只走上面的 cjkOneCharVariant（同窗对齐、只差一个字、其余位置全同；
          2 字查询只认整串等长，≥3 字才允许子串滑动）。
          2 字为什么只进 xfit：判据是**纯结构**的（仓库无简繁对照数据），2 字里「真简繁对」
          与「任意差一个汉字的词对」无法区分（`巨乳`/`巨孔`、`人妻`/`人妖`），并进直接同名档
          会把无关的 2 字词顶到第 1 条；留在译名档既保住简繁互认的收益，又不压过真正的直接同名。
          注意：TAG_ZH 派生的**跨语言译名**（中英 / 中日）仍只走 ② 的 xfit，**不**并入 fit ——
          这里唯一提升的就是「≥3 字简繁一字之差」这一类。 */
    if (!fit) {
      for (let i = 0; i < fields.length; i++) {
        const v = cjkOneCharVariant(fields[i], q);
        if (v === 3 && xfit < 3) { fit = 3; break; }
        if (v === 2 && xfit < 3) xfit = 3;
      }
    }
    return { fit: fit, xfit: xfit };
  }
  /** 直接同名的加分：完全同名 +16 / 前缀 +7 / 包含 +3（与旧的 title 口径一致） */
  const DIRECT_BONUS = [0, 3, 7, 16];
  /** 译名同名的加分：整体低一档，保证「直接同名」永远压得住「译名同名」 */
  const XLANG_BONUS = [0, 2, 5, 12];
  /**
   * 名字档（排序主键）：
   *   ≥3  标题与查询**直接**完全同名 / **≥3 字**简繁一字之差（最硬）
   *   2   标题是查询的**跨语言译名**完全同名 / **2 字简繁一字之差**（+12） / 直接前缀命中
   *   1   标题含查询，或只是译名前缀 / 包含
   *   0   名字对不上（只剩标签 / 其它分项）
   * 档内保留小数位（xfit/10），让「译名贴合度更高的」在前。
   */
  function tierOf(fit, xfit) {
    if (fit === 3) return 3;
    if (fit === 2) return 2;
    if (xfit === 3) return 2 + xfit / 10;
    return Math.max(fit, xfit / 10);
  }
  /** 排序主键之二：名字档 */
  function nameKey(it) { return (it && it._nameKey) || 0; }
  /** 名字档内再比贴合度（直接贴合优先），最后才轮到旧分数 */
  function nameTie(a, b) {
    const fa = (a && a._fit) || 0, fb = (b && b._fit) || 0;
    if (fb !== fa) return fb - fa;
    const xa = (a && a._xFit) || 0, xb = (b && b._xFit) || 0;
    return xb - xa;
  }

  /**
   * 相关度：按「名字是否对得上」+「查询意图」用不同策略打分。
   *   名字符合（任何意图都算）→ 完全同名 +16 / 前缀 +7 / 包含 +3；
   *                              跨语言译名（中英 / 中日互查）同名 +12 / 前缀 +5 / 包含 +2
   *                              （简繁**一字之差**：**≥3 字**并入「完全同名」档 +16，
   *                                **2 字**按译名档 +12 —— 见 nameFit 的 ③）
   *   作品名（title）  → 名字完全对不上的条目再 -3 往后放
   *   IP/角色（character）→ 尽量命中对应标签：标签命中 +9，系列一致 +6
   *   体裁/题材（genre）  → 尽量罗列相关题材：每命中一个相关题材词 +5（上限 14）
   * 多关键词（multi）→ 在以上基础上叠加「命中段数」主导项（见上），旧项一律保留。
   * ★本次修复★：名字贴合度**始终**参与打分与排序（不再只在 kind==='title' 时算），
   *   见上面的「名字符合优先」段 —— 排序主键由 cmpHit 落实，是偏好不是过滤。
   */
  function relevance(item, q, f) {
    const it = R.intent || (q ? u.classifyQuery(q) : null);
    let s = weightOf(item.source) * 10;
    s += item.cover && item.cover.indexOf('data:') !== 0 ? 3 : 0;
    if (q) {
      const t = String(item.title || '').toLowerCase();
      if (t.indexOf(q) >= 0) s += 9;
      const c = u.normTitle(item.title), nq = u.normTitle(q);
      if (nq && c.indexOf(nq) >= 0) s += 5;
      /* 名字贴合度：始终计算，并写入 item 上的三个排序辅助字段
         （_fit 仍是「直接贴合度」—— 简繁一字变体现在也算直接同名，所以 title 意图下
           它同样会带出卡片上的「精确」角标，这是与「视作直接同名」一致的预期） */
      const xa = xAliasesFor(q, it);
      const nf = nameFit(item, q, xa);
      item._fit = nf.fit;
      item._xFit = nf.xfit;
      item._nameFit = Math.max(nf.fit, nf.xfit);
      item._nameKey = tierOf(nf.fit, nf.xfit);
      s += Math.max(DIRECT_BONUS[nf.fit] || 0, XLANG_BONUS[nf.xfit] || 0);
    }
    if (it && it.kind === 'character') {
      const key = String(it.series || q || '').toLowerCase();
      if (key) {
        if ((item.tags || []).some(x => String(x).toLowerCase().indexOf(key) >= 0)) s += 9;
        if (item.series && it.series && item.series === it.series) s += 6;
        if (String(item.title || '').toLowerCase().indexOf(key) >= 0) s += 4;
      }
    } else if (it && it.kind === 'genre' && it.genre) {
      const hit = (item.tags || []).filter(x => {
        const tl = String(x).toLowerCase();
        return it.genre.aliases.some(a => tl.indexOf(String(a).toLowerCase()) >= 0);
      }).length;
      s += Math.min(14, hit * 5);
    }
    if (f.artist) {
      const a = (item.artist || '').toLowerCase();
      if (a && a.indexOf(String(f.artist).toLowerCase()) >= 0) s += 7;
    }
    (f.tags || []).forEach(tag => {
      const tl = String(tag).toLowerCase();
      if ((item.tags || []).some(x => String(x).toLowerCase().indexOf(tl) >= 0)) s += 3;
    });
    if (item.pages) s += Math.min(3, item.pages / 20);
    if (item.zh) s += 4.5;                        // 有汉化 / 中文的更值得先看
    if (item.zhScan) s += 1.5;                    // 明确的汉化组版本再加一点
    if (f.pagesMin && item.pages && item.pages < f.pagesMin) s -= 4;
    if (f.pagesMax && item.pages && item.pages > f.pagesMax) s -= 4;
    if ((f.langs || []).length && (item.langs || []).length &&
      item.langs.some(l => f.langs.indexOf(l) >= 0)) s += 4;
    if (item.series) s += 1.5;                    // 可归入系列的更可能被复用
    s += Math.min(2, (item.tags || []).length / 6);

    /* —— 多关键词：命中段数进 _score（排序主键见 cmpHit）——
       只有 multi（段数 ≥2）才计分：单关键词查询走不到这里，分数与旧版逐字节一致。
       一段都没命中 → 加 0，条目照常保留（排序偏好，不是过滤）。 */
    if (it && it.multi && it.segments && it.segments.length >= 2) {
      let hit = 0;
      const blob = itemBlob(item);
      for (let i = 0; i < it.segments.length; i++) if (segHit(item, it.segments[i], blob)) hit++;
      item._segHit = hit;
      s += hit * SEG_HIT;
      if (hit === it.segments.length) s += SEG_ALL;   // 全部关键词都满足：_score 再抬一档
    }
    return s;
  }

  /** 合并所有源返回，跨源去重（同作品多来源合并为一条，记录 alsoOn） */
  R.combine = function (results, q, f) {
    const all = [];
    results.forEach(r => { if (r.ok && r.items) r.items.forEach(it => all.push(it)); });

    const map = {};
    all.forEach(it => {
      const k = it.key || (it.source + it.id);
      const cur = map[k];
      if (!cur) { it.alsoOn = []; map[k] = it; return; }
      R._dirty = true;    // 已有条目被合并 / 替换，必须整面重画才能反映，不能走纯追加快路
      if (weightOf(it.source) > weightOf(cur.source)) {
        it.alsoOn = u.uniq((cur.alsoOn || []).concat([cur.sourceName]));
        map[k] = it;
      } else {
        cur.alsoOn = u.uniq((cur.alsoOn || []).concat([it.sourceName]));
        if (!cur.cover || cur.cover.indexOf('data:') === 0) {
          if (it.cover && it.cover.indexOf('data:') !== 0) cur.cover = it.cover;
        }
        if (!cur.pages && it.pages) cur.pages = it.pages;
        if (!cur.artist && it.artist) cur.artist = it.artist;
        cur.tags = u.uniq((cur.tags || []).concat(it.tags || [])).slice(0, 16);
        cur.cats = u.uniq((cur.cats || []).concat(it.cats || []));
      }
      /* 汉化信息不能因为去重丢掉：任一变体有中文，这一条就算有中文 */
      const keep = map[k];
      if (it.zh && !keep.zh) {
        keep.zh = true;
        keep.zhMark = it.zhMark || '中文';
        keep.zhScan = !!it.zhScan;
        keep.tags = u.uniq((keep.tags || []).concat([keep.zhMark])).slice(0, 16);
      }
      if (it.zhScan) keep.zhScan = true;
      /* 成人向跨源验证（「其他途径检验」）：同一本只要在任一来源被确认成人向，合并后就算成人向；
         反过来，只有在当前还是未知时，才允许被明确的「非成人向」降级 */
      if (it.adult === true) keep.adult = true;
      else if (it.adult === false && keep.adult == null) keep.adult = false;
    });

    let out = Object.keys(map).map(k => map[k]);
    /* 成人向筛选放在跨源合并之后：这样「同一本在别的源被确认成人向」才能把它救回来。
       只有两档（UI 不给「不限」）：strict = 只留已确认；其余 = 滤掉明确非成人向 */
    const adultMode = (HS.filters && HS.filters.adult) === 'strict' ? 'strict' : 'yes';
    if (adultMode === 'strict') out = out.filter(i => i.adult === true);
    else out = out.filter(i => i.adult !== false);
    out.forEach(it => {
      /* 先清掉上一次查询留在同一条目对象上的排序辅助键（对象可能被复用）——
         非多关键词查询的段数键必须恒为 0；名字档 / 贴合度同理，必须由本次 relevance 重算，
         否则继续加载（追加）时新条目会拿着上一轮的名字档参与比较。 */
      it._segHit = 0;
      it._nameKey = 0; it._nameFit = 0; it._xFit = 0;
      it._score = relevance(it, (q || '').toLowerCase(), f || {});
    });
    /* 多关键词：先命中段数、再名字档 / 贴合度，最后旧分数 */
    out.sort(cmpHit);
    return preferZh(out);
  };

  /**
   * 相似结果里，有汉化 / 中文的排前面。
   * 做法：按宽松标题指纹分组，组内先按「有中文」再按相关度排；组的整体位置不变，
   * 所以不会把相关度排序打乱，只是把同一作品的中文版提到它那几个变体之前。
   */
  function preferZh(list) {
    const groups = {};
    list.forEach(it => {
      const k = it.baseKey || it.key;
      (groups[k] = groups[k] || []).push(it);
    });
    const out = [], done = {};
    list.forEach(it => {
      const k = it.baseKey || it.key;
      if (done[k]) return;
      done[k] = 1;
      const g = groups[k];
      if (g.length > 1 && g.length <= 8) {
        g.slice().sort((a, b) =>
          (b.zh ? 1 : 0) - (a.zh ? 1 : 0) ||
          (b.zhScan ? 1 : 0) - (a.zhScan ? 1 : 0) ||
          b._score - a._score).forEach(x => out.push(x));
      } else {
        g.forEach(x => out.push(x));
      }
    });
    return out;
  }

  /* ---------------- 过滤 + 排序 ----------------
     展示顺序由 R.order 兜住（已经铺开的那批条目的 key 序列）：
       · 全新检索 / 用户主动改筛选或排序 → 整体重排，R.order 一起刷新；
       · 继续加载（追加）→ 老顺序**原样不动**，新出现的条目（key 不在 R.order 里）
         内部按当前相关度规则排好后**接到末尾**。
     这样「继续加载 / 流式返回」的新作品只会出现在最下面，不会把用户已经看过的那批顶走。 */
  function keyOf(it) { return it.key || it.id; }

  /** 追加：老顺序原样保留，新 key 按 ranked 的顺序接在末尾 */
  function appendOrder(ranked) {
    const pool = {};
    ranked.forEach(it => { pool[keyOf(it)] = it; });
    const seen = {}, out = [];
    (R.order || []).forEach(k => {
      const it = pool[k];
      if (!it || seen[k]) return;
      seen[k] = 1; out.push(it);
    });
    ranked.forEach(it => {
      const k = keyOf(it);
      if (seen[k]) return;
      seen[k] = 1; out.push(it);
    });
    return out;
  }

  function applyView() {
    const direct = (R.items || []).filter(isDirectHit);
    let list = R.items.slice();
    /* 编号直达项是最高优先级：先按「和用户当前筛选一致」的口径留下它，
       再从候选里摘掉与它同 key 的条目（同 key 只会是同一本，避免出现两张一样的卡）。
       剩下的筛选 / 排序 / 追加顺序 / 末位源分区**一律照原样**，一条都不动。 */
    const keepDirect = direct.filter(i =>
      (!R.sourceFilter || i.source === R.sourceFilter) && (!R.zhOnly || i.zh));
    if (keepDirect.length) {
      const dk = {};
      keepDirect.forEach(i => { dk[keyOf(i)] = 1; });
      list = list.filter(i => !dk[keyOf(i)]);
    }
    if (R.sourceFilter) list = list.filter(i => i.source === R.sourceFilter);
    if (R.zhOnly) list = list.filter(i => i.zh);
    const by = {
      rank: (a, b) => (b.zh ? 1 : 0) - (a.zh ? 1 : 0) || cmpHit(a, b),
      pages: (a, b) => (b.pages || 0) - (a.pages || 0),
      source: (a, b) => (a.sourceName || '').localeCompare(b.sourceName || '') || b._score - a._score,
      title: (a, b) => (a.title || '').localeCompare(b.title || '')
    }[R.sort] || cmpHit;
    /* 默认排序：先保证「相似结果内中文版在前」，再按多关键词命中段数 → 旧分数。
       注意：页数 / 源名 / 标题是用户显式选的排序，比较器一字未动 —— 多段打分只会
       影响它们的**同值并列**（并列时按相关性先后），不会盖过它们的主键。 */
    const ranked = R.sort === 'rank'
      ? preferZh(list.slice().sort(cmpHit))
      : list.sort(by);
    const ordered = R.appendMode ? appendOrder(ranked) : ranked;
    /* 最后一道：末位源（copymanga，注册表里 last:true）硬性压到所有其它源之后。
       放在 appendOrder 之后 → 「继续加载」时新一批的 copymanga 也只会接在最末尾；
       稳定分区保证非 copymanga 的老顺序（R.order 里的既有名次）一条都不动。 */
    const sunk = sinkLastSources(ordered);
    /* 真正最后一道：编号直达项置顶（在末位源分区之后 → 「拷贝漫画排最后」也挤不掉它）。
       所有排序模式 / 追加模式下都成立：这里是唯一的出口。 */
    const out = liftDirectHits(keepDirect.concat(sunk));
    R.order = out.map(keyOf);
    return out;
  }

  /* ---------------- 同系列堆叠布局 ----------------
     堆叠只给「确实同系列」的作品，先要命中系列词典（fate / blue archive …），
     再要满足至少一条「高度相符」：
       ① 同名——宽松标题指纹一致（含语言 / 汉化变体）
       ② 同画师——画师串切成 token 后至少共享一个（过滤掉 Circle / Artist 这类通用词与单字母）
       ③ 名字高度相似——一个标题完整包含另一个（较短的那个有实义长度）
     既不是同画师、名字也对不上的，一律单张平铺，不参与堆叠。
     注意：★不要用「共同标签数」当判据★ —— Doujinshi / Oneshot / Loli 这类通用标签
     任何两本同系列作品都共有，等于没筛（实测会把 14 本画师各异的 FGO 同人志叠成一摞）。 */
  /** 画师串 → 有效 token（去掉 Circle / Artist 这类通用词，以及过短的编号） */
  const ARTIST_STOP = ['circle', 'circles', 'artist', 'artists', 'unknown', 'various', 'none',
    'n/a', 'team', 'group', 'studio', 'inc', 'the', 'and', 'works'];
  function artistTokens(s) {
    return u.uniq(String(s || '').toLowerCase()
      .split(/[\/,;()（）\[\]、，·／|]+/)
      .map(x => x.trim())
      .filter(x => x.length >= 3 && ARTIST_STOP.indexOf(x) < 0 && !/^\d+$/.test(x)));
  }
  /** 同画师：共享至少一个有效 token（比子串包含安全得多） */
  function sameArtist(a, b) {
    const ta = artistTokens(a), tb = artistTokens(b);
    if (!ta.length || !tb.length) return false;
    const set = {};
    ta.forEach(t => { set[t] = 1; });
    return tb.some(t => set[t]);
  }

  /** 去掉尾部卷号 / 版本号后的标题主干（「同名不同卷」判定用；先剥掉 [社团] 括号） */
  function titleStem(t) {
    return stripVol(u.normTitle(titleBody(t)));
  }

  /* ---------------- 标题结构比较用的工具（括号里的社团 / 作者名不算标题） ---------------- */
  /** 去掉头尾的 [社团] / (作者) / 【…】 / （…）括号块 */
  function titleBody(t) {
    const s = String(t || '');
    const cleaned = s
      .replace(/^\s*(?:\[[^\]]*\]|\([^)]*\)|【[^】]*】|（[^）]*）)\s*/g, '')
      .replace(/\s*(?:\[[^\]]*\]|\([^)]*\)|【[^】]*】|（[^）]*）)\s*$/g, '')
      .trim();
    return cleaned || s.trim();
  }
  /* 尾部卷号 / 上下卷标记：要连着剥好几层（"…2 完" / "…vol3 上"） */
  const TAIL_VOL = /(?:\d{1,3}|[ivx]{1,4}|vol|volume|part|pt|no|chapter|ch|ep|episode|上|下|中|前|後|后|前編|後編|前篇|后篇|完|総集編|总集篇|上巻|下巻)$/;
  function stripVol(s) {
    let t = String(s || '');
    for (let i = 0; i < 4; i++) {
      const n = t.replace(TAIL_VOL, '');
      if (n === t) break;
      t = n;
    }
    return t;
  }
  /** 纯「文件类别」词：光靠它自己不成系列，别把两本同名的不同作品叠起来 */
  const TITLE_STOP = ['同人志', '同人誌', '漫画', '漫畫', '本', '作品', '合集', '短篇', '单行本', '單行本',
    '总集篇', '総集編', '画集', '畫集', '插画集', '本子', 'cg集', '杂图', '雜圖', '合订本', '合訂本'];
  /** 中日文标题的结构接近：公共前缀够长，多出来的尾巴只是卷号 / 第 N 话这类标记 */
  function cjkShape(a, b) {
    const x = u.normTitle(titleBody(a)), y = u.normTitle(titleBody(b));
    if (!x || !y || x === y) return false;
    if (!/[\u3400-\u9fff]/.test(x) || !/[\u3400-\u9fff]/.test(y)) return false;
    const sx = stripVol(x), sy = stripVol(y);
    /* 剥掉尾部卷号 / 上下卷后完全一致 → 同一系列的连载、上下卷（3 字起，纯类别词不算） */
    if (sx && sx === sy && sx.length >= 3 && TITLE_STOP.indexOf(sx) < 0) return true;
    const short = x.length <= y.length ? x : y;
    const long = x.length <= y.length ? y : x;
    if (short.length < 4 || TITLE_STOP.indexOf(short) >= 0) return false;
    if (long.indexOf(short) !== 0) return false;
    const tail = long.slice(short.length).trim();
    if (!tail) return true;
    if (tail.length <= 2) return true;
    return /^(?:\d+|[ivx]+|vol\.?\s*\d*|上|下|中|前|後|后|前編|後編|前篇|后篇|完|総集編|总集篇|第[一二三四五六七八九十百\d]+[话話章集篇]?)$/.test(tail);
  }

  /* 卷号 / 上下卷这类「只差一个标记」的词，允许命名结构判定时忽略 */
  function isVolToken(t) {
    return /^(?:\d{1,3}|[ivx]{1,4}|vol\d*|volume\d*|part\d*|pt\d*|no\d*|chapter\d*|ch\d*|ep\d*|上|下|中|前|後|后|前編|後編|前篇|后篇|完|総集編|总集篇|上巻|下巻)$/.test(t);
  }
  /** 保留词边界的标题归一化（u.normTitle 会把空格也吃掉，没法分词） */
  function titleParts(t) {
    return String(t || '').toLowerCase()
      .replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】|（[^）]*）/g, ' ')
      .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff]+/g, ' ')
      .trim().split(/\s+/).filter(Boolean);
  }
  /**
   * 命名结构接近：词数相差 ≤1、至少 3 个词、≥70% 的词相同，且差异词全是卷号类。
   * 例：`Seed of Ruin 1` / `Seed of Ruin 2` ✓；`Fate Grand Order A` / `… B` ✗（单个字母不算卷号）。
   */
  function titleShape(a, b) {
    const ta = titleParts(a), tb = titleParts(b);
    if (!ta.length || !tb.length) return false;
    if (ta.join('') === tb.join('')) return true;
    if (Math.abs(ta.length - tb.length) > 1) return false;
    const setA = {}, setB = {};
    ta.forEach(x => { setA[x] = 1; });
    tb.forEach(x => { setB[x] = 1; });
    const diff = ta.filter(x => !setB[x]).concat(tb.filter(x => !setA[x]));
    if (!diff.length || !diff.every(isVolToken)) return false;
    const same = ta.filter(x => setB[x]).length;
    const base = Math.min(ta.length, tb.length);
    return base >= 3 && same / base >= 0.7;
  }

  /* 封面指纹：同一张封面 = 同一本书（换标题 / 换源再传） */
  const COVER_JUNK = ['cover', 'covers', 'thumbnail', 'thumb', 'main', 'index', 'image', 'img',
    'photo', 'preview', 'sample', 'proxy', 'default', 'placeholder', 'noimage', 'onepiece'];
  function coverClean(x) {
    return String(x || '').toLowerCase()
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/^\d{2,4}x\d{2,4}(?:[_-]\d+)*(?:[_-][a-z0-9]+)*/, '')   // 250x250_80_a2 这类尺寸前缀
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
  }
  function coverKeyOk(k) {
    if (!k || k.length < 7) return false;
    if (COVER_JUNK.indexOf(k) >= 0) return false;
    return /\d/.test(k) || k.length >= 12;    // 有数字的 id，或够长的哈希
  }
  /** 从封面地址抠指纹；网关代理地址（/api/proxy?url=…）先解出内层地址 */
  function coverKey(url) {
    let s = String(url || '').trim();
    if (!s || s.indexOf('data:') === 0) return '';
    if (s.indexOf('url=') >= 0) {
      const m = s.match(/[?&]url=([^&]+)/);
      if (!m) return '';
      try { s = decodeURIComponent(m[1]); } catch (e) { return ''; }
    }
    const segs = s.split(/[?#]/)[0].split('/').filter(Boolean);
    const last = coverClean(segs[segs.length - 1]);
    if (coverKeyOk(last)) return last;
    const parent = coverClean(segs[segs.length - 2]);   // nhentai / 18comic 这类封面名是 cover+序号，用上层 id
    return coverKeyOk(parent) ? parent : '';
  }

  /* ---------------- 同系列堆叠布局 ----------------
     判据（命中任一即叠，不再死卡画师 —— 有时候画师名其实是上传者名）：
       ⓪ 封面指纹相同：同一张封面就是同一本书，最硬，连系列词典都不需要
       ① 命名结构接近（只差卷号 / 上下卷），也不依赖系列词典
       ② 同名——宽松标题指纹一致（含语言 / 汉化变体）
       ③ 同画师——画师串切成 token 后至少共享一个（过滤 Circle / Artist 这类通用词与单字母）
       ④ 标题主干相同——去掉尾部卷号后一致
     ②③④ 仍要求两边命中同一个系列词典。
     ★不要用「共同标签数」★（Doujinshi / Oneshot / Loli 这类通用标签谁都有，实测会把 14 本画师各异的
     FGO 同人志叠成一摞）；★也不要用「标题互相包含」★（'fategrandorder' 会被任何 'Fate/Grand Order - xxx' 命中）。 */
  function sameish(a, b) {
    /* ⓪ 封面指纹相同：同一张封面就是同一本书（换个标题 / 换个源再传），最硬 */
    const ca = coverKey(a.cover), cb = coverKey(b.cover);
    if (ca && cb && ca === cb) return true;
    /* ① 命名结构接近：词级（≥3 词、差异词只是卷号）或中日文（公共前缀 + 卷号尾巴）。
       这两条**不依赖画师、也不依赖系列词典** —— 「终末地轶事 1 / 终末地轶事 2」、
       「Seed of Ruin 1 / 2」这种取名格式高度相似的就该合在一起。 */
    if (titleShape(a.title, b.title)) return true;
    if (cjkShape(a.title, b.title)) return true;
    /* 下面几条要求两边命中同一个系列词典 */
    if (!a.series || !b.series || a.series !== b.series) return false;
    if (a.baseKey && b.baseKey && a.baseKey === b.baseKey) return true;
    if (sameArtist(a.artist, b.artist)) return true;
    /* ④ 标题主干相同：拉丁标题 ≥6 字符，中日文 ≥4 字（汉字信息密度更高） */
    const sa = titleStem(a.title), sb = titleStem(b.title);
    if (!sa || sa !== sb) return false;
    return sa.length >= 6 || (/[\u3400-\u9fff]/.test(sa) && sa.length >= 4);
  }

  /* ---------------- 追加时的重复剔除：已铺开的是中文版，新来的只是同一本的其它语言版本 ----------------
     用户诉求：继续加载（追加）时，如果**已经铺开**的某条是中文版，而新来的这条只是同一本的
     非中文版本（日文原版 / 英文版，标题也常常不是中文），就不要再铺一张重复的卡。
     设计原则（用户明确要求）：
       ★宁可漏杀，不可误杀★：只在「追加」场景生效（R.appendMode 为真），全新检索 / 第一页的
       结果一条都不动；而且**只丢新来的那一条**，已经铺开的 DOM 与 R.order 完全不动。
     判据（下面是两条证据，任一成立才把新来的那条丢掉）：
       A 封面图床指纹一致 —— 同一张封面 = 同一本（换标题 / 换源再传）。只认能从封面 URL
         **可靠抠出「作品级 id」**的形态（COVER_WORK_PATTERNS）；抠不出来就不判，交给 B。
         实测：语言版本在多数源上是**不同图床 id**（e-hentai / hitomi / 紳士 / 拷贝…），
         这几条路本来也抠不出可比指纹，所以这条证据只在少数源上可能命中。
       B 词条级标题指纹一致（u.baseTitle：语言 / 汉化组 / DL 版标记都剥掉，但**保留卷号**）
         —— 等价于「同一个标题、同一个卷，只差语言标记」；再要求画师不冲突、系列不冲突。
         另外容忍 nhentai 的 `english_title / japanese_title` 拼接标题（只对 nhentai 生效）。
     ★不要拿 sameish / titleStem 当击杀判据★：sameish 认为「同系列不同卷」也是同一本
     （titleShape / cjkShape / 同画师都算命中），titleStem 干脆把卷号剥掉了 —— 用它们杀人会把
     「第 2 卷」误杀成「第 1 卷」。这里是「同一个卷号、同一条标题，只差语言」，比它们严得多。 */

  /** 纯「文件类别」词：这种标题指纹本身没有区分度，不能当击杀依据 */
  const DUP_GENERIC_LIST = ['oneshot', 'doujinshi', 'manga', 'comic', 'artbook', 'anthology',
    'collection', 'untitled', 'unnamed', 'no title', 'gallery', 'image set', 'imageset'];
  const DUP_GENERIC = {};
  DUP_GENERIC_LIST.concat(TITLE_STOP).forEach(x => {
    const k = u.baseTitle ? u.baseTitle(x) : u.normTitle(x);
    if (k) DUP_GENERIC[k] = 1;
  });
  function dupKeyOk(k) {
    if (!k || DUP_GENERIC[k]) return false;
    if (/[\u3400-\u9fff]/.test(k)) return k.length >= 3;   // 中日文信息密度高，3 字起
    return k.length >= 5;                                  // 拉丁标题 5 字符起（「title」这种太泛的靠 DUP_GENERIC 挡）
  }

  /** 封面地址先剥掉网关代理壳（/api/proxy?url=…&referer=…） */
  function unwrapCover(url) {
    let s = String(url || '').trim();
    if (!s || s.indexOf('data:') === 0) return '';
    if (s.indexOf('url=') >= 0) {
      const m = s.match(/[?&]url=([^&]+)/);
      if (!m) return '';
      try { s = decodeURIComponent(m[1]); } catch (e) { return ''; }
    }
    return s;
  }

  /* 能从封面 URL 可靠认出「作品级 id」的图床形态（认不出来一律返回 '' = 这条证据不成立）。
     ★只认「一条作品 = 一个 id」的形态★：像 `/…/<id>/cover.jpg` 这种把**父级 id** 当指纹的做法
     很危险 —— 有些源在那个位置放的是画师 / 用户 id，两本不同的书会撞在一起（宁可漏杀）。
     前缀（nh / md / jm）避免不同站点之间的数字 id 互撞；md5 用 h: 前缀，因为「同一张图」本来就
     该跨源算同一本。 */
  const COVER_WORK_PATTERNS = [
    /* nhentai：t.nhentai.net/galleries/<media_id>/…（media_id 就是画廊 id） */
    { re: /^https?:\/\/[^/]*nhentai\.net\/galleries\/(\d+)(?:[/?#]|$)/i, tag: 'nh' },
    /* MangaDex：uploads.mangadex.org/covers/<manga uuid>/… */
    { re: /^https?:\/\/[^/]*mangadex\.org\/covers\/([0-9a-f-]{36})(?:[/?#]|$)/i, tag: 'md' },
    /* 禁漫：<jmCdn>/media/albums/<album id>…（_3x4 之类尺寸尾巴不影响 id） */
    { re: /^https?:\/\/[^/]*\/media\/albums\/(\d+)(?:[_.?#/]|$)/i, tag: 'jm' },
    /* Danbooru：cdn.donmai.us/(…/)<md5>… */
    { re: /^https?:\/\/cdn\.donmai\.us\/(?:[^/?#]+\/)*([0-9a-f]{32})(?:[.?/#]|$)/i, tag: 'h' }
  ];
  /** 封面 → 作品级指纹；认不出来返回 ''（= 不判，宁可漏杀） */
  function coverWorkKey(it) {
    const s = unwrapCover(it && it.cover);
    if (!s) return '';
    for (let i = 0; i < COVER_WORK_PATTERNS.length; i++) {
      const m = s.match(COVER_WORK_PATTERNS[i].re);
      if (m) return COVER_WORK_PATTERNS[i].tag + ':' + m[1].toLowerCase();
    }
    /* 通用兜底：文件名本身就是一条 id（md5 / uuid）—— 同一张图换源再传也算同一本 */
    const base = (s.split(/[?#]/)[0].split('/').filter(Boolean).pop() || '')
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/^\d{2,4}x\d{2,4}(?:[_-]\d+)*/, '');
    if (/^[0-9a-f]{32}$/i.test(base)) return 'h:' + base.toLowerCase();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(base)) {
      return 'u:' + base.toLowerCase();
    }
    return '';
  }

  /* 语言标记 → 「有没有中文可读」。u.zhInfo 只认 'zh'，而 nhentai 的 langs 是
     'chinese' / 'english' 这种全词（实测 mk() 里 langs 就是这么来的），这里补上这一档。 */
  const ZH_LANG_RE = /^(?:zh|zh-cn|zh-tw|zh-hans|zh-hant|chinese|中文|漢化|汉化|中国翻译|中國翻譯|中文版|官中|简体|繁體|繁体|簡體)$/i;
  const ZH_IN_TITLE_RE = /汉化|漢化|中国翻译|中國翻譯|中文版|官中|繁体中文|繁體中文|简体中文|簡體中文|\[\s*(?:chinese|zh|中文)\s*\]|【\s*中文\s*】/i;
  /** 这条是不是「有中文可读」的那一条（比 item.zh 更宽一点） */
  function isZhItem(it) {
    if (!it) return false;
    if (it.zh) return true;
    const langs = (it.langs || []).concat(it.lang ? [it.lang] : []);
    if (langs.some(l => ZH_LANG_RE.test(String(l).trim()))) return true;
    return ZH_IN_TITLE_RE.test(String(it.title || ''));
  }

  /** 词条级标题指纹（保留卷号；只把语言 / 汉化组 / DL 版这类标记剥掉） */
  function titleSigs(it) {
    const t = String((it && it.title) || '');
    if (!t) return [];
    const out = [];
    const add = s => {
      const k = String((u.baseTitle ? u.baseTitle(s) : u.normTitle(s)) || '');
      if (dupKeyOk(k)) out.push(k);
    };
    add(t);
    /* nhentai 的标题是 `english_title / japanese_title` 拼起来的（sources.js 的 nhParse）：
       前一段才是书名，后一段只是同一本的另一语言标题。只对 nhentai 生效 —— 别的源里 ' / '
       没有这个含义，不能拆。 */
    if (String(it.source) === 'nhentai' && t.indexOf(' / ') > 0) {
      const segs = t.split(' / ');
      if (segs.length === 2) add(segs[0]);
    }
    return u.uniq(out);
  }

  /** 画师冲突：两边都写了画师 token 且一个都不共享 → 当成两本不同的书（不判重复） */
  function artistConflict(a, b) {
    const ta = artistTokens(a && a.artist), tb = artistTokens(b && b.artist);
    if (!ta.length || !tb.length) return false;              // 有一边没写画师 → 不算冲突
    return !sameArtist(a && a.artist, b && b.artist);
  }

  /**
   * 这一对（ea = 已经铺开的、nb = 新来的）算不算「同一本的中文版 vs 语言变体」重复？
   * 方向是**单向**的：ea 有中文、nb 没有。反过来一律不判 —— 用户明确要求
   * 「两本都是中文」「同系列不同本」「不同作者」都不能被误杀。
   */
  function zhLangDup(ea, nb) {
    if (!ea || !nb) return false;
    if (keyOf(ea) === keyOf(nb)) return false;               // 同 key 早就被 combine 合并成一条
    if (!isZhItem(ea) || isZhItem(nb)) return false;         // 只处理「已铺开的是中文、新来的不是」
    /* A 封面作品级指纹一致（最硬的一条；这条路不看画师 —— 同一张封面几乎不可能是两本不同的书） */
    const fa = coverWorkKey(ea), fb = coverWorkKey(nb);
    if (fa && fb && fa === fb) return true;
    /* B 词条级标题指纹一致 + 系列 / 画师不冲突 */
    const ka = titleSigs(ea), kb = titleSigs(nb);
    if (!ka.length || !kb.length) return false;
    if (!ka.some(k => kb.indexOf(k) >= 0)) return false;
    if (ea.series && nb.series && ea.series !== nb.series) return false;
    return !artistConflict(ea, nb);
  }

  /**
   * 追加场景的剔除：known = 已经铺开的条目（上一页 + 本页先前收到的），
   * incoming = 这一批新来的。返回「该留下的那几条」（顺序不变）。
   *   · R.appendMode 为假（全新检索 / 第一页）→ 原样返回，第一页结果与既有规则完全一致；
   *   · 批内先留下的条目也会进 known → 同一批里再来的重复同样被丢掉（先到的那条说了算）；
   *   · 只从 incoming 里剔，**绝不回头删已经铺开的条目**（老顺序不动、新 key 接末尾）。
   */
  function dropZhLangDup(incoming, known) {
    const list = incoming || [];
    if (!R.appendMode || !list.length) return list;
    const pool = (known || []).slice();
    const out = [];
    list.forEach(nb => {
      /* 编号直达项优先级最高：它是用户点名要的那一本，任何去重都不能把它剔掉 */
      if (isDirectHit(nb)) { out.push(nb); pool.push(nb); return; }
      if (pool.some(ea => zhLangDup(ea, nb))) {
        R._zhDupDropped = (R._zhDupDropped || 0) + 1;
        return;
      }
      out.push(nb);
      pool.push(nb);
    });
    return out;
  }
  /* 供自测与调试：追加去重（dropZhLangDup）与它的信号 */
  R.zhDupFilter = dropZhLangDup;
  R.zhDupSignals = {
    isZhItem: isZhItem, coverWorkKey: coverWorkKey, titleSigs: titleSigs, pair: zhLangDup
  };

  function buildLayout(list) {
    if (R.seriesOnly) {
      return list.filter(i => i.series === R.seriesOnly).map(i => ({ type: 'single', item: i }));
    }
    const out = [];
    list.forEach(it => {
      if (!it.series) { out.push({ type: 'single', item: it }); return; }
      /* 并进第一个「高度相符」的堆叠，否则自己开一叠 */
      const hit = out.find(n => n.type === 'stack' && sameish(n.ref, it));
      if (hit) {
        hit.total++;
        if (hit.items.length < STACK_MAX) hit.items.push(it);
        else hit.rest.push(it);
        return;
      }
      out.push({ type: 'stack', key: it.series + '|' + (it.baseKey || it.key), ref: it, items: [it], rest: [], total: 1 });
    });
    /* 只有一本的「系列」降级为普通卡片；超出平铺上限的补在堆叠后面，一张都不丢 */
    const final = [];
    out.forEach(n => {
      if (n.type !== 'stack') { final.push(n); return; }
      if (n.total >= 2) final.push(n);
      else final.push({ type: 'single', item: n.items[0] });
      (n.rest || []).forEach(it => final.push({ type: 'single', item: it }));
    });
    return final;
  }

  /** 决定每一叠向哪边展开，避免右侧越界 */
  function applyFanDirection() {
    const grid = u.$('#results-grid');
    if (!grid) return;
    const gr = grid.getBoundingClientRect();
    u.$$('.hs-stack', grid).forEach(st => {
      const r = st.getBoundingClientRect();
      if (!r.width) return;
      const center = r.left + r.width / 2;
      st.dataset.fan = (center > gr.left + gr.width * 0.55) ? 'left' : 'right';
    });
  }
  R.applyFanDirection = applyFanDirection;

  /* ---------------- 源 / 系列 过滤条 ---------------- */
  function renderHead() {
    const host = u.$('#results-srcfilter');
    const counts = {};
    R.items.forEach(i => { counts[i.source] = (counts[i.source] || 0) + 1; });
    host.innerHTML = '';

    if (R.seriesOnly) {
      const chip = u.el('button', { class: 'hs-tag hs-tag-series', type: 'button', 'data-on': '1' },
        '系列：' + u.esc(R.seriesOnly) + ' <small>✕</small>');
      chip.addEventListener('click', () => { R.seriesOnly = null; R.appendMode = false; renderHead(); renderGrid(); });
      host.appendChild(chip);
    }

    const mkBtn = (id, label, n) => {
      const b = u.el('button', {
        class: 'hs-tag', type: 'button', 'data-on': (R.sourceFilter === id) ? '1' : '0'
      }, u.esc(label) + (n != null ? ' <small>' + n + '</small>' : ''));
      b.addEventListener('click', () => {
        R.sourceFilter = (R.sourceFilter === id) ? null : id;
        R.page = 1;
        R.appendMode = false;      // 用户主动改筛选 = 整体重排，不是追加
        renderHead(); renderGrid();
      });
      return b;
    };
    host.appendChild(mkBtn(null, '全部', R.items.length));

    /* 汉化 / 中文单独一个筛选位 */
    const zhN = R.items.filter(i => i.zh).length;
    if (zhN) {
      const zb = u.el('button', {
        class: 'hs-tag hs-tag-zh', type: 'button', 'data-on': R.zhOnly ? '1' : '0',
        title: '只看有汉化 / 中文的版本'
      }, '汉化/中文 <small>' + zhN + '</small>');
      zb.addEventListener('click', () => { R.zhOnly = !R.zhOnly; R.page = 1; R.appendMode = false; renderHead(); renderGrid(); });
      host.appendChild(zb);
    }

    Object.keys(counts).sort((a, b) => counts[b] - counts[a]).forEach(id => {
      const nm = (HS.sources.byId[id] || {}).name || id;
      host.appendChild(mkBtn(id, nm, counts[id]));
    });
  }

  /* ---------------- 卡片 ---------------- */
  /* ---------------- 封面加载：失败必须可恢复 ----------------
     小卡片的 <img> 是**长生命周期**节点（继续加载时按 layoutId 复用，不重建），
     放大器却是每次打开都新建一个 <img> 重新请求同一个 URL —— 这就是两者唯一的结构差异。
     所以封面**不能**「一失败就把 src 一次性换成占位图并摘掉监听」：只要这一发请求失败过
     （网关代理 502/444、图床限流、浏览器把 lazy 图的 load/error 事件延后……），
     那张小卡片此后就永远只剩占位图（= 用户说的"没有封面"），而点开放大器又看得到真封面。
     规则：
       ① 原图地址记在 img.dataset.cover 上，任何时候都能回到它；
       ② error 后先按退避重试原图（最多 COVER_TRIES 次），全失败才落到占位图；
       ③ restoreCover() 在重绘 / 打开放大器时把占位图换回原图（自愈）。
     ★不要退回「一次性降级」★ —— 那正是「小卡片没有封面、放大后正常」的成因。 */
  const COVER_TRIES = 2;
  const COVER_BACKOFF = 700;          // ms：第 1 次重试等 700，第 2 次 1400

  function wireCover(img, it, force) {
    const want = (it && it.cover) ? String(it.cover) : '';
    const key = (it && (it.key || it.id)) || '';
    img.__tries = 0;
    img.__ok = 0;
    img.dataset.cover = want;
    if (!img.__coverBound) {
      img.__coverBound = 1;
      img.addEventListener('error', function onerr() {
        const w = img.dataset.cover || '';
        if (!w) return;
        const n = img.__tries || 0;
        if (n < COVER_TRIES) {
          img.__tries = n + 1;
          const url = bust(w, 'hsretry=' + (n + 1));
          window.setTimeout(() => {
            if ((img.dataset.cover || '') === w) img.src = url;
          }, COVER_BACKOFF * (n + 1));
          return;
        }
        const ph = u.placeholder(it && it.title, key);
        if (img.getAttribute('src') !== ph) img.src = ph;   // 真的拿不到才用占位图（同值重设不再触发 error）
      });
      img.addEventListener('load', () => { img.__tries = 0; img.__ok = 1; });
    }
    if (!want) { img.src = u.placeholder(it && it.title, key); return; }
    /* force=true：即使 src 已经指着原图也**强制重取一次**（浏览器对同一个失败过的 URL
       直接重设同值往往不会重新请求，得带一个一次性的查询尾巴） */
    img.src = force ? bust(want, 'hsrepaint=' + Date.now()) : want;
  }

  /** 给 URL 加一个查询尾巴（原来有 query 就用 & 拼） */
  function bust(url, tag) {
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + tag;
  }

  /** 把某张卡片的封面从占位图 / 旧地址换回原图（it.cover）。
      重绘（paintList）和打开放大器（openCard）各走一次 —— 所以「点开过的那张卡片」
      一定会和放大器显示同一张封面。已经指着原图且确认取到了的直接跳过，不产生额外请求。 */
  function restoreCover(card) {
    if (!card || !card.__item) return;
    const img = u.$('.hs-card-img img', card);
    if (!img) return;
    const want = card.__item.cover ? String(card.__item.cover) : '';
    if (!want || want.indexOf('data:') === 0) return;
    const cur = img.getAttribute('src') || '';
    if (cur === want) return;                             // 已经指着原图（加载中 / 已加载）
    if (cur && cur.indexOf('data:') !== 0) return;         // 重试地址之类，不去打断
    wireCover(img, card.__item);
  }

  /**
   * 放大器把小卡片的封面**真取回来了**（同一个 URL）→ 顺手把这给小卡片也救回来。
   * 这条路径专门兜住「请求失败但 error 事件没来」的情况（浏览器会把 lazy 图的
   * load / error 事件延后 —— 控制台会打 "Load events are deferred"）：
   * 这时 src 还指着原图、也没有占位图，光看 src 判断不出它到底有没有取到，
   * 所以只在用户点开卡片（= 我们已经确认这张封面能被取到）时强制重取一次。
   * 有 img.__ok 标记时（正常浏览器 load 会来）直接跳过，不会多请求。 */
  function healCardCover(card) {
    if (!card || !card.__item) return;
    const img = u.$('.hs-card-img img', card);
    const want = card.__item.cover ? String(card.__item.cover) : '';
    if (!img || !want || want.indexOf('data:') === 0) return;
    if (img.__ok && img.dataset.cover === want) return;         // 已经确认取到原图
    wireCover(img, card.__item, true);
  }

  function catLabel(it) {
    if (!it.cats || !it.cats.length) return '';
    const c = HS.CATS.find(x => x.code === it.cats[0]);
    return c ? c.label : '';
  }

  /** 角标（卡片角上与放大视图共用）：编号直达 → 汉化 → R18G / AI → 精确 → 源 → 类型 → 页数 → 多站 */
  function badgeNodes(it) {
    const out = [];
    /* 编号直达：用户点名要的那一本，标签就是它的编号本身（`jm1474541`）。
       容器加 is-hi（见 cardNode）→ 样式把整排角标挪到**右上角**，与左上角那排不重叠。 */
    if (isDirectHit(it)) out.push(u.el('span', {
      class: 'hs-pill hs-pill-jm',
      title: '编号直达：按禁漫编号取回的这本作品（' + (it.jmDirectId || '') + '）'
    }, u.esc(it.jmBadge || ('jm' + (it.jmDirectId || it.id || '')))));
    if (it.zh) out.push(u.el('span', {
      class: 'hs-pill hs-pill-zh',
      title: it.zhScan ? '有汉化 / 翻译版本' : '有中文版本'
    }, u.esc(it.zhMark || '中文')));
    if (it.isGore) out.push(u.el('span', { class: 'hs-pill hs-pill-gore', title: '猎奇 / R18G 内容' }, 'R18G'));
    if (it.isAI) out.push(u.el('span', { class: 'hs-pill hs-pill-ai', title: 'AI 生成 / AI 绘画' }, 'AI'));
    if (it._fit === 3 && R.intent && R.intent.kind === 'title') out.push(u.el('span', {
      class: 'hs-pill hs-pill-match', title: '标题与关键词完全一致'
    }, '精确'));
    out.push(u.el('span', { class: 'hs-pill hs-pill-src' }, u.esc(it.sourceName || it.source)));
    const cl = catLabel(it);
    if (cl) out.push(u.el('span', { class: 'hs-pill' }, u.esc(cl)));
    if (it.pages) out.push(u.el('span', { class: 'hs-pill' }, it.pages + 'P'));
    if ((it.alsoOn || []).length) out.push(u.el('span', { class: 'hs-pill' }, '+' + it.alsoOn.length + ' 站'));
    return out;
  }

  /** 标签行（卡片与放大视图共用）：R18G / AI 词高亮，纯数字的 tag id 不显示 */
  function tagNodes(it, limit) {
    const out = [];
    const allTags = (it.tags || []).map(t => String(t)).filter(t => t && !/^\d+$/.test(t.trim()));
    const list = allTags.slice(0, limit || 6);
    list.forEach(t => {
      const tl = t.toLowerCase();
      const flag = u.hitAny(tl, HS.GORE_TAGS) ? ' hs-mtag-gore' : (u.hitAny(tl, HS.AI_TAGS) ? ' hs-mtag-ai' : '');
      /* 标签中文化：有对照就显示中文，原始英文放进 tooltip（不丢信息） */
      const zh = u.zhTag(t);
      out.push(u.el('span', {
        class: 'hs-mtag' + flag,
        title: zh === t ? t : (zh + ' · ' + t)
      }, u.esc(zh)));
    });
    if (allTags.length > list.length) out.push(u.el('span', { class: 'hs-mtag' }, '+' + (allTags.length - list.length)));
    if (!list.length) out.push(u.el('span', { class: 'hs-mtag hs-mtag-none' }, '无标签'));
    return out;
  }

  function cardNode(it, idx) {
    const card = u.el('article', {
      class: 'hs-card', 'data-src': it.source, 'data-key': it.key || it.id,
      /* R18G / AI 标记：既是角标，也是「初始模糊只糊标记项」的判定依据 */
      'data-flag': (it.isGore || it.isAI) ? '1' : '0'
    });

    const img = u.el('img', {
      alt: it.title, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer'
    });
    wireCover(img, it);         // 封面：失败可重试、可自愈（见 wireCover 的注释）

    const imgBox = u.el('div', { class: 'hs-card-img' });
    imgBox.appendChild(img);

    const badges = u.el('div', { class: 'hs-card-badges' + (isDirectHit(it) ? ' is-hi' : '') });
    badgeNodes(it).forEach(n => badges.appendChild(n));
    imgBox.appendChild(badges);

    const reveal = u.el('button', { class: 'hs-card-reveal', type: 'button' }, '点击显示');
    reveal.addEventListener('click', ev => {
      ev.preventDefault(); ev.stopPropagation();
      const on = card.getAttribute('data-reveal') === '1';
      card.setAttribute('data-reveal', on ? '0' : '1');
      reveal.textContent = on ? '点击显示' : '重新模糊';
    });
    imgBox.appendChild(reveal);
    card.appendChild(imgBox);

    const body = u.el('div', { class: 'hs-card-body' });
    body.appendChild(u.el('div', { class: 'hs-card-title' }, u.esc(it.title)));

    const subBits = [];
    if (it.artist) subBits.push(u.esc(it.artist.slice(0, 26)));
    if (it.langs && it.langs.length) subBits.push(it.langs.slice(0, 2).join('/'));
    else if (it.lang) subBits.push(u.esc(it.lang));
    if (it.year) subBits.push(u.esc(String(it.year)));
    if (subBits.length) body.appendChild(u.el('div', { class: 'hs-card-sub' }, subBits.join(' <i class="hs-dot"></i> ')));

    /* 标签：每张卡片都把对应标签列出来，R18G / AI 相关标签单独高亮 */
    const tagBox = u.el('div', { class: 'hs-card-tags' });
    tagNodes(it, 6).forEach(n => tagBox.appendChild(n));
    body.appendChild(tagBox);
    card.appendChild(body);

    const actions = u.el('div', { class: 'hs-card-actions' });
    /* 收藏爱心（fav.js）：插在动作区第一个位置，与「在线阅读 / 打开原站」并列。
       fav.js 缺失时整块跳过 —— 卡片构建不能因为收藏模块不在就报错。
       这里只调用它的两个口子（makeCardBtn / paintBtn），爱心自己的 click 已经拦住冒泡，
       不会触发 #results-grid 的「点卡片 = 放大」委托。 */
    if (HS.fav && HS.fav.makeCardBtn) actions.appendChild(HS.fav.makeCardBtn(it));
    /* 打开原站 / 在线阅读：阅读器支持的来源（HS.reader.supports）就地变成「在线阅读」，
       点它**直接开阅读器**（不再跳原站）；不支持的来源保持原样（仍是跳原站的 <a>，功能不丢）。
       两条路径都显式 stopPropagation：#results-grid 的单击委托是「点卡片 = 放大」，
       虽然 .hs-card-actions 里的元素本来就已被放过，这里仍拦住，别让栈摊开 / 卡片点击也吃到。
       ★放大卡片里那个 [data-cm-read]「在线阅读」按钮不归这里管，保持原样。★ */
    const toReader = !!(HS.reader && HS.reader.supports && HS.reader.supports(it.source));
    let open;
    if (toReader) {
      const rdLabel = '在线阅读' + (it.title ? '：' + String(it.title).slice(0, 60) : '');
      open = u.el('button', {
        class: 'hs-btn hs-btn-primary', type: 'button',
        title: rdLabel, 'aria-label': rdLabel
      }, '在线阅读');
      open.addEventListener('click', ev => {
        ev.preventDefault(); ev.stopPropagation();
        if (HS.reader && HS.reader.open) HS.reader.open(it);
      });
    } else {
      open = u.el('a', {
        class: 'hs-btn hs-btn-primary', href: it.url, target: '_blank', rel: 'noopener noreferrer'
      }, '打开原站');
      if (!it.url) { open.removeAttribute('target'); }
    }
    actions.appendChild(open);

    const cp = u.el('button', { class: 'hs-btn hs-btn-ico', type: 'button', title: '复制链接' }, HS.icon.copy);
    cp.addEventListener('click', async ev => {
      ev.stopPropagation();
      try { await navigator.clipboard.writeText(it.url || ''); HS.toast('链接已复制', 'ok', 1500); }
      catch (e) { HS.toast('复制失败，请手动复制', 'warn'); }
    });
    actions.appendChild(cp);

    if (it.artist) {
      const af = u.el('button', { class: 'hs-btn hs-btn-ico', type: 'button', title: '按画师筛选：' + it.artist }, HS.icon.user);
      af.addEventListener('click', ev => { ev.stopPropagation(); HS.filtersUI.setArtist(it.artist); });
      actions.appendChild(af);
    }
    card.appendChild(actions);

    /* 放大视图要拿到原始条目 */
    card.__item = it;
    /* 入场动画交给 .hs-card-new（只在新卡片上挂），这里只给同一批内做错峰 */
    card.style.setProperty('--in-i', String(Math.min(idx, 12)));
    return card;
  }

  /** 同系列堆叠：多张卡片叠放，悬停/点击后像手牌一样展开 */
  function stackNode(group) {
    const wrap = u.el('div', {
      class: 'hs-stack', 'data-key': group.key, 'data-fan': 'right',
      role: 'group', 'aria-label': '同系列 ' + group.total + ' 本'
    });
    group.items.forEach((it, i) => {
      const card = cardNode(it, 0);
      card.style.setProperty('--i', String(i));
      card.style.animationDelay = (i * 30) + 'ms';
      card.style.zIndex = String(40 - i);
      if (i > 0) card.setAttribute('tabindex', '-1');
      wrap.appendChild(card);
    });

    /* 鼠标停在哪一张，哪一张就过渡到最顶层。
       这里不用逐张卡片的 :hover（重叠时命中会在卡片之间跳），而是用「未抬起」的
       几何位置把指针 x 映射到卡片索引：扇开后每张只比上一张多露一个 step，
       所以从左到右依次对应第 0、1、2… 张，移动是单调的，切换自然不抖。 */
    const cards = u.$$('.hs-card', wrap);
    let raised = -1, raf = 0, pendingX = null;

    const setRaised = i => {
      if (raised === i) return;
      raised = i;
      cards.forEach((c, k) => c.classList.toggle('is-raised', k === i));
    };

    function indexFromX(clientX) {
      const n = cards.length;
      if (!n) return -1;
      const wr = wrap.getBoundingClientRect();            // 整摞自身不带 transform，是稳定基准
      if (!wr.width) return -1;
      const fan = parseFloat(getComputedStyle(wrap).getPropertyValue('--fan')) || 56;
      const step = Math.max(16, Math.abs(fan));
      const right = wrap.dataset.fan !== 'left';
      const dx = right ? (clientX - wr.left) : (wr.right - clientX);
      if (dx < wr.width) return 0;
      return u.clamp(1 + Math.floor((dx - wr.width) / step), 0, n - 1);
    }

    wrap.addEventListener('pointermove', e => {
      pendingX = e.clientX;
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; if (pendingX != null) setRaised(indexFromX(pendingX)); });
    });
    cards.forEach((c, i) => c.addEventListener('focus', () => setRaised(i)));
    cards.forEach((c, i) => c.addEventListener('click', () => setRaised(i)));
    wrap.addEventListener('pointerleave', () => { pendingX = null; setRaised(-1); });
    wrap.addEventListener('blur', () => setRaised(-1), true);

    const count = u.el('div', { class: 'hs-stack-count' }, group.total + ' 本同系列');
    wrap.appendChild(count);

    const tag = u.el('button', { class: 'hs-stack-tag', type: 'button' },
      '展开全部 <small>' + group.total + '</small>');
    tag.addEventListener('click', ev => {
      ev.preventDefault(); ev.stopPropagation();
      R.seriesOnly = group.key;
      R.appendMode = false;                    // 只看该系列 = 整体重排
      renderHead(); renderGrid();
      u.$('#results-grid').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    wrap.appendChild(tag);

    /* 触屏：点一下先把整摞摊开；已经摊开后再点就交给卡片点击（放大查看）。
       鼠标设备本来就靠 hover 摊开，直接放行给卡片点击。 */
    wrap.addEventListener('click', ev => {
      if (ev.target.closest('.hs-card-actions') || ev.target.closest('.hs-stack-tag')) return;
      if (wrap.dataset.open === '1') return;
      if (!window.matchMedia || !window.matchMedia('(hover: none)').matches) return;
      ev.stopPropagation();
      wrap.dataset.open = '1';
    });
    return wrap;
  }

  /* ---------------- 单页渲染：所有结果铺在同一面，向下滚动继续追加 ---------------- */
  function paintFoot() {
    const foot = u.$('#results-foot');
    if (!foot) return;
    if (!R.items.length) { foot.hidden = true; foot.innerHTML = ''; return; }
    const layoutN = (R._layout || []).length;
    const shown = Math.min(R._shown, layoutN);
    const moreLocal = layoutN > R._shown;
    foot.hidden = false;
    foot.dataset.busy = R.loadingMore ? '1' : '0';
    let txt;
    if (moreLocal) txt = '已显示 ' + shown + ' / ' + layoutN + ' 张，继续向下滚动加载更多';
    else if (R.loadingMore) txt = '正在向各源索取更多结果…';
    else if (R.exhausted) txt = '已经到底了 · 共 ' + R.items.length + ' 条可检索结果';
    else txt = '已显示 ' + shown + ' 张，继续向下滚动会向各源索取更多';
    foot.innerHTML = '<span class="hs-foot-hint">' + u.esc(txt) + '</span>';
  }

  /** 内容签名：条目自身变了（去重后换了更好的封面 / 多了中文 / 补了页数）就重建这一张 */
  function cardSig(n) {
    if (n.type === 'stack') {
      return 'S|' + n.key + '|' + n.items.length + '|' +
        n.items.map(x => (x.key || x.id) + ':' + String(x.cover || '').length).join(',');
    }
    const it = n.item;
    return 'C|' + (it.key || it.id) + '|' + String(it.cover || '').length + '|' + (it.zh ? 1 : 0) +
      '|' + ((it.alsoOn || []).length) + '|' + (it.pages || 0);
  }

  /**
   * 铺开已经加载的节点。
   * 关键：**按稳定 id 复用已有 DOM**（`R._dom`），只新建真正新出现的卡片。
   * 这样继续加载 / 重新排序时，老卡片的 <img> 不会重建（不重新请求图片、不会整页闪一下），
   * 新找到的卡片才带 `.hs-card-new` 入场动画 —— 就是「原有的不动、新来的有加载动画」。
   */
  function paintList() {
    const grid = u.$('#results-grid');
    const layout = R._layout || [];
    const end = Math.min(layout.length, R._shown);
    if (!R._dom) R._dom = {};
    const keep = {};
    const els = [];
    let fresh = 0;
    for (let i = 0; i < end; i++) {
      const n = layout[i];
      const id = layoutId(n);
      const sig = cardSig(n);
      let el = R._dom[id];
      if (!el || el.__sig !== sig) {
        if (el && el.parentNode) el.parentNode.removeChild(el);
        el = n.type === 'stack' ? stackNode(n) : cardNode(n.item, fresh);
        if (n.type !== 'stack') el.dataset.key = n.item.key || n.item.id;
        el.__sig = sig;
        el.__id = id;
        el.classList.add('hs-card-new');
        fresh++;
        R._dom[id] = el;
      }
      keep[id] = 1;
      els.push(el);
    }
    /* 回收已经不在布局里的卡片 */
    Object.keys(R._dom).forEach(id => {
      if (keep[id]) return;
      const el = R._dom[id];
      if (el && el.parentNode) el.parentNode.removeChild(el);
      delete R._dom[id];
    });
    /* 只在位置确实不对时才移动节点：多数情况下这一圈什么都不做 */
    for (let i = 0; i < els.length; i++) {
      if (grid.children[i] !== els[i]) grid.insertBefore(els[i], grid.children[i] || null);
    }
    while (grid.children.length > els.length) grid.removeChild(grid.lastChild);
    /* 封面自愈：复用老卡片时 <img> 不重建，但要把已经掉到占位图的封面换回原图。
       只对「当前指着占位图」的重设 src，指着原图的一律不动（不产生额外请求）。 */
    els.forEach(el => {
      if (el.classList.contains('hs-card')) restoreCover(el);
      else u.$$('.hs-card', el).forEach(restoreCover);
    });
    R._nodes = els;
    R._rendered = els.length;
    /* 复用的旧卡片上，爱心可能还停在上一个条目的状态（DOM 复用不会重建它），
       这里统一重扫一次刷成当前收藏态；fav.js 不在就跳过。 */
    if (HS.fav && HS.fav.sync) HS.fav.sync(grid);
    /* 入场动画跑完就把标记摘掉，之后再移动节点也不会重播 */
    if (fresh) window.setTimeout(() => { els.forEach(e => e.classList.remove('hs-card-new')); }, 700);
    requestAnimationFrame(applyFanDirection);
    paintFoot();
  }

  /** 布局节点的稳定标识（判断新旧布局是否「纯追加」用） */
  function layoutId(n) {
    return n.type === 'stack' ? ('S:' + n.key) : ('C:' + (n.item.key || n.item.id));
  }
  function samePrefix(next, prev) {
    if (next.length < prev.length) return false;
    for (let i = 0; i < prev.length; i++) if (layoutId(next[i]) !== layoutId(prev[i])) return false;
    return true;
  }

  /**
   * 重画结果面。keepShown=true 时保留已经铺开的深度（流式追加 / 继续加载后）。
   * 两条路径：
   *   ① 新布局是旧布局的**纯追加** → 只把新节点接到后面，DOM 不重建、不重排，
   *      滚动位置自然不动（旧实现每次都整面重建，追加时会把用户「甩」回去，
   *      表现就是「加载新作品时暂时看不到之前那些」）。
   *   ② 排序 / 筛选 / 去重合并导致顺序变化 → 整面重画，但用结果区顶部在视口里的
   *      位置当锚点，画完把滚动偏移还回去，避免同样的跳动。
   */
  function renderGrid(keepShown) {
    const grid = u.$('#results-grid');
    const all = applyView();
    const next = buildLayout(all);
    const prev = R._layout || [];
    const appendOnly = !!keepShown && R._nodes.length > 0 && !R._dirty && samePrefix(next, prev);

    if (!keepShown || !R._shown) R._shown = pageSize();
    R._layout = next;

    if (!next.length) {
      R._nodes = []; R._rendered = 0; R._dirty = false; R._dom = {};
      grid.innerHTML = '';
      if (R.streaming) { u.$('#results-empty').hidden = true; paintFoot(); return; }
      const filtered = (R.sourceFilter && R.items.length) || (R.seriesOnly && R.items.length) ||
        (R.zhOnly && R.items.length);
      u.$('#results-empty').hidden = false;
      u.$('#results-empty').innerHTML = filtered
        ? '<b>该筛选下没有结果</b>点击上方「全部」或清掉系列筛选查看其它来源。'
        : '<b>没有找到相关结果</b>可以试试：<div class="hs-empty-actions">' +
          '<button class="hs-btn hs-btn-ghost" data-act="relax">放宽语言限制</button>' +
          '<button class="hs-btn hs-btn-ghost" data-act="cats">清空作品类型</button>' +
          '<button class="hs-btn hs-btn-ghost" data-act="modes">关掉 R18G / AI 过滤</button>' +
          '<button class="hs-btn hs-btn-ghost" data-act="proxy">检查代理设置</button></div>';
      const acts = {
        relax: () => { HS.filters.langs = []; HS.filtersUI.syncAll(); HS.bus.emit('app:search'); },
        cats: () => { HS.filters.cats = []; HS.filtersUI.syncAll(); HS.filtersUI.touch(); HS.bus.emit('app:search'); },
        modes: () => { HS.filters.gore = 'any'; HS.filters.ai = 'any'; HS.filtersUI.syncAll(); HS.filtersUI.touch(); HS.bus.emit('app:search'); },
        proxy: () => { HS.filtersUI.openSheet(true); const p = u.$('#f-proxy'); if (p) p.focus(); }
      };
      u.$$('#results-empty [data-act]').forEach(b => b.addEventListener('click', () => acts[b.dataset.act] && acts[b.dataset.act]()));
      paintFoot();
      return;
    }

    u.$('#results-empty').hidden = true;
    if (R._shown < Math.min(pageSize(), next.length)) R._shown = Math.min(pageSize(), next.length);

    /* 一律走「按 id 复用 DOM」的铺法：老卡片连 <img> 都不重建，只有新卡片播入场动画。
       顺序变了才需要把滚动位置按结果区顶部锚点还回去（纯追加不用动）。 */
    const anchor = appendOnly ? null : grid.getBoundingClientRect().top;
    R._dirty = false;
    paintList();
    if (anchor !== null) {
      const drift = grid.getBoundingClientRect().top - anchor;
      if (drift) window.scrollBy(0, drift);
    }
  }
  R.renderGrid = renderGrid;

  /** 当前视图里叠了几组（供思维链汇报） */
  R.stackCount = function () {
    return (R._layout || []).filter(n => n.type === 'stack').length;
  };

  /* 供自测与调试：堆叠判定与布局 */
  R.sameish = sameish;
  R.buildLayout = buildLayout;
  /* 供自测与调试：展示顺序（含末位源分区） */
  R.applyView = applyView;
  R.sinkLastSources = sinkLastSources;
  R.isLastSource = isLastSource;
  /* 供自测与调试：编号直达（置顶分区 + 标记判定） */
  R.isDirectHit = isDirectHit;
  R.liftDirectHits = liftDirectHits;

  /* ---------------- 工具 ---------------- */

  /* ---------------- 公开 API ---------------- */
  function flatten(results) {
    const out = [];
    (results || []).forEach(r => { if (r && r.ok && r.items) r.items.forEach(it => out.push(it)); });
    return out;
  }

  function pageSize() {
    return u.clamp(parseInt(HS.settings.pageSize, 10) || 60, 12, 200);
  }
  R.pageSize = pageSize;

  /** 池子里积累的候选结果（翻页只增加候选，不改动已有排序） */
  function pool() {
    return R._pages.concat(R._partial);
  }

  function rebuild() {
    R.items = R.combine(pool(), R.q, R.f);
    return R.items;
  }

  /** 开始流式接收：先到的源先出结果，不必等最慢的源超时（保留骨架屏） */
  R.streamStart = function (q, f, page) {
    R.q = q || ''; R.f = f || {};
    R.intent = u.classifyQuery(R.q);
    R.page = Math.max(1, parseInt(page || 1, 10) || 1);
    R._partial = [];
    /* 追加阶段：老顺序保留 + 新条目接末尾；全新检索：整体重排 */
    R.appendMode = R.page > 1;
    if (R.page === 1) {
      R._pages = [];
      R.items = [];
      R.sourceFilter = null;
      R.seriesOnly = null;
      R.exhausted = false;
      R.loadingMore = false;
      R._shown = 0;
      R._dryRounds = 0;
      R._zhDupDropped = 0;      // 全新检索从零开始数「追加去重丢了几条」（仅用于自测 / 调试）
      R.order = [];
    }
    R.streaming = true;
    u.$('#results-head').hidden = false;
    u.$('#results-empty').hidden = true;
    u.$('#results-meta').innerHTML = R.page > 1 ? '正在追加更多结果…' : '正在检索…';
    if (R.page === 1) {
      const sf = u.$('#results-srcfilter');
      if (sf) sf.innerHTML = '';
    }
  };

  /** 某个源返回后立即并入结果 */
  R.streamPush = function (res) {
    if (!R.streaming) return;
    const before = R.items.length;
    /* 追加（page > 1）时同样先剔掉与「已经铺开的条目」重复的语言变体：
       known = 上一页的池子 + 本页已经收到的那些源（后到的重复项才丢，先到的说了算）。
       只替换这一条的 items，不动别的字段（ok / error / src 都要留着给下面数成功源）。 */
    let push = res;
    if (R.appendMode && res && res.ok && res.items && res.items.length) {
      const kept = dropZhLangDup(res.items, flatten(R._pages).concat(flatten(R._partial)));
      if (kept.length !== res.items.length) push = Object.assign({}, res, { items: kept });
    }
    R._partial.push(push);
    rebuild();
    const okSrc = R._partial.filter(r => r.ok && r.items && r.items.length).length;
    u.$('#results-meta').innerHTML = '已收到 <em>' + R.items.length + '</em> 条 · 完成源 ' +
      okSrc + '/' + R._partial.length + '（其余仍在检索中）';
    if (R.items.length !== before) { renderHead(); renderGrid(true); }
  };

  R.skeletons = function (n) {
    const grid = u.$('#results-grid');
    grid.innerHTML = '';
    u.$('#results-empty').hidden = true;
    u.$('#results-head').hidden = false;
    u.$('#results-meta').innerHTML = '正在检索…';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < (n || 8); i++) {
      const c = u.el('div', { class: 'hs-card hs-card-skel' });
      c.innerHTML = '<div class="hs-skel hs-skel-img"></div>' +
        '<div class="hs-skel hs-skel-line l1"></div>' +
        '<div class="hs-skel hs-skel-line l2"></div>' +
        '<div class="hs-skel hs-skel-line l3"></div>';
      c.style.animationDelay = (i * 30) + 'ms';
      frag.appendChild(c);
    }
    grid.appendChild(frag);
  };

  R.render = function (results, meta) {
    meta = meta || {};
    R.streaming = false;
    R.raw = results;
    const page = Math.max(1, parseInt(meta.page || R.page, 10) || 1);
    R.page = page;
    R.appendMode = page > 1;      // 追加：老顺序不动，新条目接末尾
    const fresh = flatten(results);
    const hadBefore = R.items.length;
    if (page > 1) {
      /* 追加：先剔掉「与已经铺开的中文版重复的语言变体」，再进池子（第一页 / 全新检索不受影响）。
         拿 fresh（源实际返回的条数）判「这一批是不是太少」，口径与原来一致。 */
      const kept = dropZhLangDup(fresh, flatten(R._pages));
      R._pages = R._pages.concat([{ ok: true, items: kept, src: { id: '__page' } }]);
      if (fresh.length < Math.max(4, pageSize() * 0.15)) R.exhausted = true;
    } else {
      R._pages = [{ ok: true, items: fresh, src: { id: '__page' } }];
    }
    R._partial = [];
    rebuild();
    /* 干燥轮次：追加后一条新条目都没多 → 这些源没有真分页（再要还是同一批），
       跨源去重后什么都不剩。连续两轮没进展就判定到底，避免「继续向下滚动」永远转圈。 */
    if (page > 1) {
      if (R.items.length > hadBefore) R._dryRounds = 0;
      else if ((R._dryRounds = (R._dryRounds || 0) + 1) >= 2) R.exhausted = true;
    }

    const okSrc = results.filter(r => r.ok && r.items && r.items.length).length;
    const failSrc = results.filter(r => !r.ok).length;
    const ps = pageSize();
    const zhN = R.items.filter(i => i.zh).length;

    u.$('#results-head').hidden = false;
    const bits = ['找到 <em>' + R.items.length + '</em> 个可能相关的结果'];
    const it = R.intent;
    if (it && it.kind && it.kind !== 'empty') {
      const extra = it.series ? '（' + u.esc(it.series) + '）'
        : (it.genre ? '（' + u.esc(it.genre.label) + '）' : '');
      bits.push('策略 <b class="hs-intent">' + u.esc(it.label) + '</b>' + extra);
    }
    if (R.items.length > ps) bits.push('向下滚动继续加载');
    if (zhN) bits.push('<b class="hs-zh-count">' + zhN + ' 个有汉化/中文</b>');
    if (typeof meta.ms === 'number') bits.push('用时 ' + u.fmtMs(meta.ms));
    bits.push('成功源 ' + okSrc + '/' + results.length);
    u.$('#results-meta').innerHTML = bits.join(' · ');

    renderHead();
    renderGrid(true);
    /* 首屏太短（结果少 / 视口高）时自动再要一批，把预取带填满 */
    setTimeout(() => R.kickFoot(), 220);

    /* 全部失败时给出可执行的诊断 */
    if (!R.items.length && failSrc === results.length) {
      const reasons = results.map(r => (HS.sources.byId[r.src.id] || {}).name + '：' + r.error).join('；');
      HS.toast('所有信息源均失败，请查看下方提示', 'err', 4200);
      u.$('#results-empty').hidden = false;
      u.$('#results-empty').innerHTML =
        '<b>所有信息源都失败了</b><p style="margin:6px 0 2px;max-width:640px">' + u.esc(reasons) + '</p>' +
        '<div class="hs-empty-actions">' +
        '<button class="hs-btn hs-btn-primary" data-act="net">重新检测网络</button>' +
        '<button class="hs-btn hs-btn-ghost" data-act="proxy">配置 CORS 代理</button></div>';
      const acts = {
        net: () => HS.bus.emit('net:recheck'),
        proxy: () => { HS.filtersUI.openSheet(true); const p = u.$('#f-proxy'); if (p) p.focus(); }
      };
      u.$$('#results-empty [data-act]').forEach(b => b.addEventListener('click', () => acts[b.dataset.act] && acts[b.dataset.act]()));
    }
    return R.items;
  };

  /**
   * 向下滚动到底时加载更多。
   *   本地还有没铺开的候选 → 直接铺（不发请求）
   *   本地铺完了但还没到底   → 向各源再要一批，回来接着铺
   * 所有结果都在同一面，不再有上一页 / 下一页。
   */
  R.loadMore = function () {
    if (R.streaming || HS.busy || R.loadingMore || !R.items.length) return false;
    const layoutN = (R._layout || []).length;
    if (R._shown < layoutN) { R._shown += pageSize(); paintList(); return true; }
    if (R.exhausted || R.pageBusy) { paintFoot(); return false; }
    R.loadingMore = true;
    R.pageBusy = true;
    paintFoot();
    HS.bus.emit('app:search', {
      page: (R.page || 1) + 1, append: true,
      after: () => {
        R.loadingMore = false; R.pageBusy = false;
        R._shown += pageSize(); paintList();
        R.kickFoot();
      },
      fail: () => { R.loadingMore = false; R.pageBusy = false; paintFoot(); }
    });
    return true;
  };

  /**
   * 追加结束后再检查一次底部哨兵。
   * IntersectionObserver 只在「相交状态发生变化」时回调：如果这一批没把哨兵顶出预取带
   * （源没有真分页、条目全被跨源去重、或屏幕太高），哨兵会一直停在相交状态、
   * 再也不会回调 —— 滚动加载就卡死在第一批，用户看到的是「滚到底了却没有新作品」。
   * 所以这里手动再踢一脚；真没进展的轮次由 R._dryRounds 兜底收手，不会无限请求。
   */
  R.kickFoot = function () {
    const foot = u.$('#results-foot');
    if (!foot || R.exhausted || R.loadingMore || R.streaming || HS.busy) return;
    if (foot.getBoundingClientRect().top < window.innerHeight + 700) {
      setTimeout(() => { if (!R.exhausted && !R.loadingMore) R.loadMore(); }, 140);
    }
  };

  R.reset = function () {
    R.items = []; R.raw = []; R._pages = []; R._partial = [];
    R.sourceFilter = null; R.seriesOnly = null; R.zhOnly = false;
    R.page = 1; R.exhausted = false; R.loadingMore = false; R._dryRounds = 0; R._zhDupDropped = 0;
    R._layout = []; R._shown = 0; R._nodes = []; R._rendered = 0; R._dirty = false; R._dom = {};
    R.order = []; R.appendMode = false;
    u.$('#results-grid').innerHTML = '';
    u.$('#results-head').hidden = true;
    u.$('#results-empty').hidden = true;
    const foot = u.$('#results-foot');
    if (foot) { foot.hidden = true; foot.innerHTML = ''; }
  };

  /* ---------------- 点击卡片：放大查看作品基本信息 ---------------- */
  let cm = null;   // 放大视图弹窗
  let cmTimer = 0;     // 关闭（反向）动画的定时器
  let cmGen = 0;       // 代次：动画期间又开了新的 → 老的收尾回调作废，别把新开的收掉
  let cmClosing = false; // 正在播关闭动画

  /** 这张卡片此刻是否需要糊：开关打开就是所有作品一律糊（R18G / AI 只做筛选，不做区别对待） */
  function cardBlurred() {
    return document.documentElement.classList.contains('hs-blurcovers');
  }

  function buildCardModal() {
    cm = u.el('div', {
      class: 'hs-modal hs-cm', id: 'card-modal', hidden: true,
      role: 'dialog', 'aria-modal': 'true', 'data-blur': '0', 'data-reveal': '0'
    });
    cm.innerHTML =
      '<div class="hs-cm-card" role="document">' +
        '<button class="hs-icon-btn hs-cm-close" type="button" data-cm-close aria-label="关闭">' + HS.icon.close + '</button>' +
        '<div class="hs-cm-img">' +
          '<img alt="" decoding="async" referrerpolicy="no-referrer">' +
          '<div class="hs-card-badges" data-cm-badges></div>' +
        '</div>' +
        '<div class="hs-cm-body">' +
          '<h2 class="hs-cm-title" data-cm-title></h2>' +
          '<div class="hs-cm-sub" data-cm-sub></div>' +
          '<div class="hs-cm-tags hs-card-tags" data-cm-tags></div>' +
          '<dl class="hs-cm-meta" data-cm-meta></dl>' +
          '<div class="hs-cm-actions">' +
            /* 「在线阅读」固定在动作区第一位（DOM 顺序，不用 CSS order）：
               读屏/Tab 顺序与视觉顺序一致；不支持的来源靠 hidden 隐藏，不占位也不可聚焦。 */
            '<button class="hs-btn hs-btn-primary" type="button" data-cm-read hidden>在线阅读</button>' +
            '<button class="hs-btn hs-btn-ghost" type="button" data-cm-fav>收藏</button>' +
            '<a class="hs-btn hs-btn-ghost" data-cm-open target="_blank" rel="noopener noreferrer">打开原站</a>' +
            '<button class="hs-btn hs-btn-ghost" type="button" data-cm-copy>复制链接</button>' +
            '<button class="hs-btn hs-btn-ghost" type="button" data-cm-artist hidden>按画师筛选</button>' +
            '<button class="hs-btn hs-btn-ghost" type="button" data-cm-series hidden>只看该系列</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(cm);

    u.$$('[data-cm-close]', cm).forEach(b => b.addEventListener('click', () => closeCard()));
    cm.addEventListener('click', e => { if (e.target === cm) closeCard(); });

    const reveal = u.$('[data-cm-reveal]', cm);
    if (reveal) reveal.addEventListener('click', e => e.stopPropagation());
    u.$('[data-cm-copy]', cm).addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText((cm.__item && cm.__item.url) || '');
        HS.toast('链接已复制', 'ok', 1500);
      } catch (err) { HS.toast('复制失败，请手动复制', 'warn'); }
    });
    /* 在线阅读：按钮和封面两条路径都进阅读器 */
    const readBtn = u.$('[data-cm-read]', cm);
    readBtn.addEventListener('click', () => {
      if (!cm.__item) return;
      if (HS.reader) HS.reader.open(cm.__item);
    });
    const cmImg = u.$('.hs-cm-img', cm);
    if (cmImg) {
      cmImg.addEventListener('click', e => {
        if (!cmImg.hasAttribute('data-rd')) return;           // 只有支持阅读器的来源才可点
        if (e.target.closest('a, button')) return;
        if (cm.__item && HS.reader) HS.reader.open(cm.__item);
      });
    }
    /* 放大器的封面真取到了 → 顺手确认被点的那张小卡片也能显示同一张封面（见 healCardCover） */
    const cmImgEl = u.$('.hs-cm-img img', cm);
    if (cmImgEl) cmImgEl.addEventListener('load', () => { if (cm.__card) healCardCover(cm.__card); });
    u.$('[data-cm-artist]', cm).addEventListener('click', () => {
      const it = cm.__item;
      if (!it || !it.artist) return;
      closeCard();
      HS.filtersUI.setArtist(it.artist);
    });
    u.$('[data-cm-series]', cm).addEventListener('click', () => {
      const it = cm.__item;
      if (!it || !it.series) return;
      closeCard();
      R.seriesOnly = it.series;
      R.appendMode = false;                      // 只看该系列 = 整体重排
      renderHead(); renderGrid();
      u.$('#results-grid').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  /** 立即落位：撤掉放大器、清干净内联样式、把小卡片恢复可见（幽灵态的反向过程） */
  function settleClose() {
    window.clearTimeout(cmTimer); cmTimer = 0;
    cmClosing = false;
    if (!cm) return;
    const box = u.$('.hs-cm-card', cm);
    if (box) {
      box.style.animation = '';
      box.style.transition = 'none';
      box.style.transform = 'none';
      box.style.opacity = '1';
      box.style.willChange = '';
    }
    cm.hidden = true;
    if (cm.__card) { cm.__card.classList.remove('hs-card-ghost'); cm.__card = null; }
  }

  /**
   * 关闭放大器：**反向动画** —— 从当前放大态缩回它原来那张小卡片的位置 / 尺寸 / 倾斜角，
   * 动画播完再撤掉放大器、把小卡片显示出来（就是打开动画 hs-cm-in 的倒放）。
   *   · 与打开共用 --cm-* 自定义属性和关键帧机制，线性缓动，时长贴近打开（.32s ≈ .34s）
   *   · 关掉动效（hs-nomotion / prefers-reduced-motion）/ 没记录到卡片时直接落位
   *   · 阅读器退出也会走这里（assets/js/reader.js）：本函数**同步返回**，
   *     阅读器不会被卡片动画卡住；它自己随后立刻 hidden，动画在已经露出来的页面上播完
   */
  function closeCard() {
    if (!cm) return;
    const gen = ++cmGen;
    window.clearTimeout(cmTimer); cmTimer = 0;
    if (cmClosing) { settleClose(); return; }        // 已经在下落 → 再按一次直接落位
    const card = cm.__card;
    const box = u.$('.hs-cm-card', cm);
    const still = document.documentElement.classList.contains('hs-nomotion') ||
      (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (!box || !card || still || !window.requestAnimationFrame || cm.hidden) { settleClose(); return; }

    /* 反向 FLIP：终点 = 那张小卡片**此刻**的矩形与倾斜角（期间可能滚动 / 重排过）。
       先摘掉入场动画、量到不含变换的静止矩形（left/top 是内联的），再把反向关键帧挂上。 */
    box.style.animation = 'none';
    box.style.transform = 'none';
    void box.offsetWidth;
    const cr = card.getBoundingClientRect();
    const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
    const rot = cardRotation(card);
    const cw0 = card.offsetWidth || cr.width;
    const mr = box.getBoundingClientRect();
    const mx = mr.left + mr.width / 2, my = mr.top + mr.height / 2;
    const s = Math.max(0.08, Math.min(1, cw0 / (box.offsetWidth || cw0)));
    box.style.setProperty('--cm-x', (cx - mx).toFixed(1) + 'px');
    box.style.setProperty('--cm-y', (cy - my).toFixed(1) + 'px');
    box.style.setProperty('--cm-r', rot + 'deg');
    box.style.setProperty('--cm-s', s.toFixed(4));
    box.style.willChange = 'transform, opacity';
    void box.offsetWidth;                            // 强制重排，保证反向动画每次都能重播
    box.style.animation = 'hs-cm-out .32s linear both';
    cmClosing = true;
    /* 动画期间小卡片保持隐身；播完（或期间又开了新的 → gen 变了）才落位 */
    cmTimer = window.setTimeout(() => { if (gen === cmGen) settleClose(); }, 340);
  }
  R.closeCard = closeCard;

  /**
   * 从「卡片所在位置」长成放大器（而不是从屏幕正中弹出来）：
   *   ① 把放大器摆到卡片附近（视口内夹紧）
   *   ② 用 FLIP：先把它缩放到卡片矩形，再过渡回原位
   * 关掉动效（设置里的「动画强度=关闭」或系统 prefers-reduced-motion）时直接落位。
   */
  function animateFrom(card) {
    const box = u.$('.hs-cm-card', cm);
    if (!box) return;
    box.style.transition = 'none';
    box.style.transform = 'none';
    box.style.transformOrigin = 'center center';
    box.style.opacity = '1';

    const w = box.offsetWidth, h = box.offsetHeight;
    let left, top;
    if (card) {
      const r = card.getBoundingClientRect();
      left = Math.round(r.left + r.width / 2 - w / 2);
      top = Math.round(r.top + r.height / 2 - h / 2);
    } else {
      left = Math.round((window.innerWidth - w) / 2);
      top = Math.round((window.innerHeight - h) / 2);
    }
    left = Math.min(Math.max(8, left), Math.max(8, window.innerWidth - w - 8));
    top = Math.min(Math.max(8, top), Math.max(8, window.innerHeight - h - 8));
    box.style.left = left + 'px';
    box.style.top = top + 'px';

    const still = document.documentElement.classList.contains('hs-nomotion') ||
      (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (still || !card || !window.requestAnimationFrame) { box.style.willChange = ''; return; }

    /* 起点：卡片中心 + 卡片自己的倾斜角 + 等比缩放。
       动画是**线性**的（用户指定），并且**全程保持卡片自己的倾斜角、结束也不回正** ——
       斜着摊开的那张卡片就是沿着自己的倾斜轴放大成一张同样斜着的大卡片。
       尺寸 = 卡片本身的 2 倍（"放大到原来的一倍"），视口太窄就夹住并重新夹紧左/上边界。 */
    const cr = card.getBoundingClientRect();
    const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
    const rot = cardRotation(card);
    const cw0 = card.offsetWidth || cr.width;
    const s = Math.max(0.08, Math.min(1, cw0 / (box.offsetWidth || cw0)));
    const mr = box.getBoundingClientRect();
    const mx = mr.left + mr.width / 2, my = mr.top + mr.height / 2;
    box.style.setProperty('--cm-x', (cx - mx).toFixed(1) + 'px');
    box.style.setProperty('--cm-y', (cy - my).toFixed(1) + 'px');
    box.style.setProperty('--cm-r', rot + 'deg');
    box.style.setProperty('--cm-s', s.toFixed(4));
    box.style.willChange = 'transform, opacity';
    box.style.animation = 'none';
    void box.offsetWidth;                       // 强制重排，保证动画每次都能重播
    /* 动画用 both 填充并**保留不撤**：100% 帧本身就等于最终静止状态（含倾斜角），
       撤掉动画会让合成层丢掉、重栅格化一次 —— 用户看到的"抖一抖"就是那一下。 */
    box.style.animation = 'hs-cm-in .34s linear both';
  }

  /** 卡片当前的旋转角（堆叠摊开时卡片带 rotate）——放大时要顺着同样的倾斜 */
  function cardRotation(card) {
    try {
      const t = window.getComputedStyle(card).transform;
      if (!t || t === 'none') return 0;
      const m = t.match(/matrix\(([^)]+)\)/);
      if (!m) return 0;
      const v = m[1].split(',').map(Number);
      const deg = Math.atan2(v[1], v[0]) * 180 / Math.PI;
      return Math.abs(deg) < 0.4 ? 0 : Math.round(deg * 10) / 10;
    } catch (e) { return 0; }
  }

  function openCard(it, card) {
    if (!cm) buildCardModal();
    /* 上一次的关闭动画还没播完就又被点开：作废它，别让它事后把放大器收掉 */
    cmGen++; window.clearTimeout(cmTimer); cmTimer = 0; cmClosing = false;
    cm.__item = it;
    /* 兜底清理：不管上一轮从哪条路径退出的，先把所有还在隐身的卡片恢复出来
       —— 幽灵态只可能属于当前这张被点开的卡片 */
    u.$$('#results-grid .hs-card-ghost').forEach(c => { if (c !== card) c.classList.remove('hs-card-ghost'); });
    /* 被点的那张卡片先隐身：视觉上就是「这张卡片自己长大」，而且放大视图里封面不再模糊 */
    if (cm.__card && cm.__card !== card) cm.__card.classList.remove('hs-card-ghost');
    cm.__card = card || null;
    if (card) card.classList.add('hs-card-ghost');
    /* 顺手把小卡片的封面救回原图：放大器的封面就是它马上要显示的那张，同一个 URL */
    restoreCover(card);

    const img = u.$('.hs-cm-img img', cm);
    img.src = it.cover || u.placeholder(it.title, it.key || it.id);
    img.alt = it.title || '';

    const badges = u.$('[data-cm-badges]', cm);
    badges.innerHTML = '';
    badgeNodes(it).forEach(n => badges.appendChild(n));

    u.$('[data-cm-title]', cm).textContent = it.title || '未命名';

    const sub = [];
    if (it.artist) sub.push(u.esc(it.artist));
    if (it.langs && it.langs.length) sub.push(u.esc(it.langs.slice(0, 3).join('/')));
    else if (it.lang) sub.push(u.esc(it.lang));
    if (it.year) sub.push(u.esc(String(it.year)));
    if (it.pages) sub.push(it.pages + 'P');
    u.$('[data-cm-sub]', cm).innerHTML = sub.join(' <i class="hs-dot"></i> ');

    const tags = u.$('[data-cm-tags]', cm);
    tags.innerHTML = '';
    tagNodes(it, 30).forEach(n => tags.appendChild(n));

    const rows = [['信息源', (it.sourceName || it.source) +
      ((it.alsoOn || []).length ? '（也出现在 ' + it.alsoOn.join(' / ') + '）' : '')]];
    if (it.artist) rows.push(['画师 / 社团', it.artist]);
    const cl = catLabel(it);
    if (cl) rows.push(['作品类型', cl]);
    if (it.langs && it.langs.length) rows.push(['语言', it.langs.join(' / ')]);
    else if (it.lang) rows.push(['语言', it.lang]);
    if (it.year) rows.push(['年份', String(it.year)]);
    if (it.pages) rows.push(['页数', it.pages + ' P']);
    if (it.series) rows.push(['系列', it.series]);
    if (it.note) rows.push(['备注', it.note]);
    const meta = u.$('[data-cm-meta]', cm);
    meta.innerHTML = '';
    rows.forEach(pair => {
      meta.appendChild(u.el('dt', {}, u.esc(pair[0])));
      meta.appendChild(u.el('dd', {}, u.esc(pair[1])));
    });

    const open = u.$('[data-cm-open]', cm);
    if (it.url) { open.setAttribute('href', it.url); open.hidden = false; }
    else { open.removeAttribute('href'); open.hidden = true; }
    u.$('[data-cm-copy]', cm).hidden = !it.url;
    u.$('[data-cm-artist]', cm).hidden = !it.artist;
    u.$('[data-cm-series]', cm).hidden = !it.series;
    /* 「在线阅读」只在阅读器支持的来源上出现；封面同步变成可点入口 */
    const canRead = !!(HS.reader && HS.reader.supports(it.source));
    u.$('[data-cm-read]', cm).hidden = !canRead;
    const cmImg = u.$('.hs-cm-img', cm);
    if (cmImg) {
      if (canRead) { cmImg.setAttribute('data-rd', '1'); cmImg.title = '在线阅读'; }
      else { cmImg.removeAttribute('data-rd'); cmImg.removeAttribute('title'); }
    }

    /* 收藏按钮（fav.js）：文案与实心/空心状态必须跟着当前条目走。
       cm.__item 刚在上面赋好，这里同步一次；点击行为由 fav.js 自己接线。 */
    if (HS.fav && HS.fav.wireModal) HS.fav.wireModal(u.$('[data-cm-fav]', cm), cm);

    /* 尺寸 = 卡片本身的 2 倍（"放大到原来的一倍"），**在显示之前就定好**：
       显示后再改宽度会引发一次整层重排+重画，那一下就是用户看到的"放大时顿挫"。 */
    const box0 = u.$('.hs-cm-card', cm);
    if (box0 && card) {
      const cw0 = card.offsetWidth || card.getBoundingClientRect().width;
      const want = Math.max(240, Math.min(Math.round(cw0 * 2), Math.max(280, window.innerWidth - 16)));
      if (want && Math.abs(box0.offsetWidth - want) > 2) box0.style.width = want + 'px';
    }
    cm.hidden = false;
    animateFrom(card);
  }

  R.init = function () {
    u.$('#results-sort').addEventListener('change', e => {
      R.sort = e.target.value; R.page = 1; R._shown = 0;
      R.appendMode = false;      // 用户主动改排序 = 整体重排，不是追加
      renderGrid();
    });
    window.addEventListener('resize', u.debounce(applyFanDirection, 160));

    /* 单页 + 无限滚动：底部哨兵进入视野就继续加载（提前 700px 预取） */
    const foot = u.$('#results-foot');
    if (foot && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver(entries => {
        if (entries.some(e => e.isIntersecting)) R.loadMore();
      }, { rootMargin: '700px 0px' });
      io.observe(foot);
      R._io = io;
    } else {
      /* 兜底：没有 IntersectionObserver 就用滚动事件 */
      window.addEventListener('scroll', u.debounce(() => {
        if (!R.items.length || R.loadingMore) return;
        const box = foot && foot.getBoundingClientRect();
        if (box && box.top < window.innerHeight + 700) R.loadMore();
      }, 160), { passive: true });
    }

    /* 点卡片 = 单击一次就放大（不再需要"先揭示、再点开"两步）。
       封面揭示：桌面靠 hover，触屏/想固定看就点卡片上的「点击显示」按钮（那是显式操作，会保持）。
       只放过真正的交互元素，其余位置（含操作行的空白）都算点卡片。 */
    u.$('#results-grid').addEventListener('click', e => {
      const card = e.target.closest('.hs-card');
      if (!card || card.classList.contains('hs-card-skel')) return;
      if (!card.__item) return;
      if (e.target.closest('a')) return;
      if (e.target.closest('.hs-card-actions button, .hs-card-actions .hs-btn')) return;
      if (e.target.closest('.hs-card-reveal')) {
        const on = card.getAttribute('data-reveal') === '1';
        card.setAttribute('data-reveal', on ? '0' : '1');
        return;
      }
      openCard(card.__item, card);
    });

    /* 放大视图开着时，Esc 只关它（不要顺带关掉筛选面板 / 思维链）；
       阅读器开着时连它也不关 —— 交给阅读器自己处理 */
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && cm && !cm.hidden) {
        if (HS.reader && HS.reader.isOpen()) return;
        e.stopImmediatePropagation();
        closeCard();
      }
    });
  };

})(window.HS);
