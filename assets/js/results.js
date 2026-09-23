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
  /* 已知角色名的命中加分（见 relevance() 里那段注释）。
     ★本轮修正★ 旧版只有一个 CHAR_HIT=16，判据是「条目正文里出现该角色的任何写法」，
     而中日文写法走的是**包含匹配** —— 于是标题里任何含「年」字的东西
     （2026年7月号 / 年上 / 年代印痕 / 十年）都拿到和「这一本真的就是年」一模一样的分。
     一档分不出「真的年」与「只是含年字」，而 _score 又是最末位的排序键，
     所以这个分给得再高也压不住名字档 / 系列加分 —— 这就是用户报的
     「明日方舟标签顶到前面、真的年反而在后面」。现在拆成两档：
       · CHAR_STRONG：**结构化命中** —— 拉丁 / 假名写法按词边界命中标题（`Nian's Sex Addiction
         (Arknights)`），或标签里整段等于角色名，或中日文名字在标题里独立成段。
       · CHAR_WEAK：**只有包含匹配**（「年」出现在 2026年 / 年上 / 去年 里）。
     这两个数值只影响 _score（末位排序键）；真正的先后由 applyView() 出口的
     角色档稳定分区 charFirst() 决定（见那边的注释），不靠分数硬拼。 */
  const CHAR_STRONG = 20;
  const CHAR_WEAK = 5;
  /* 角色档（写进 item._charTier，供 charFirst() 分区用）：
       3 = 真·角色命中（这一本就是这个角色）
       2 = 系列命中（「明日方舟」这个系列的泛内容，与这个角色无关）
       1 = 只是字面含这个名字（年下 / 年上 / 2026年…）
       0 = 都不是
     期望次序（用户原话）：真角色 > 名字就叫「年」的作品 > 系列命中 > 只是含「年」字。 */
  const CHAR_T_STRONG = 3;
  const CHAR_T_SERIES = 2;
  const CHAR_T_WEAK = 1;

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

  /**
   * 这件作品属不属于某个**系列**（别名口径）。
   * 为什么不能直接用 `item.series === intent.series`：同一个系列在各源里写法不同 ——
   * 实测同一次「年」的检索里 `item.series` 同时出现 `明日方舟` / `arknights` / `アークナイツ`
   * 三种（nhentai 给 arknights、禁漫给 アークナイツ、绅士给 明日方舟），严格相等只认其中一种。
   * 别名集只读 core.js 现成的 u.seriesAliases（数据来自 NS.SERIES / TAG_ZH），不新增词表。
   */
  function seriesHit(item, series) {
    const s = String(series == null ? '' : series).toLowerCase().trim();
    if (!s) return false;
    let names = [];
    try { names = (typeof u.seriesAliases === 'function' ? u.seriesAliases(s) : null) || []; } catch (e) { names = []; }
    if (!names.length) names = [s];
    const ser = String(item.series == null ? '' : item.series).toLowerCase().trim();
    if (ser && names.indexOf(ser) >= 0) return true;
    const blob = itemBlob(item);
    return names.some(n => n && aliasHit(blob, n));
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

  /**
   * 中日文名字是否在标题里**独立成段**（前后都不是中日文 / 假名 / 数字 / 拉丁字母）。
   * 为什么必须单独判：单字角色名（「年」）用包含匹配时，
   *   `年`        → 独立成段 ⇒ 这一本真的可能是那个角色；
   *   `年液饭`    → 后面粘着汉字 ⇒ 不算；
   *   `2026年7月号` / `年上` / `年代印痕` / `辰年` → 同样不算。
   * 前一次修复只做了包含匹配，所以「搜年出一堆 2026年10月号 的杂志」才会出现。
   * 数字也算「粘着」—— `25年12月` / `10年間` 这种「年份 / 年数」写法必须留在弱档里。
   */
  const GLUE_RE = /[\u3400-\u9fff\u3040-\u30ff0-9a-z]/;
  const KANA_RE = /[\u3040-\u30ff]/;                    /* 平假名 / 片假名 */
  /* ★假名粘连要分情况★（本轮修正）：旧口径把假名与汉字一视同仁，于是日文标题里
     「年」后面接助词的写法（`[アークナイツ] 年と私`、`年の秘書`）被判成「粘着」，
     掉进系列档 —— 而这些**恰恰是角色本人的作品**：绅士 / 禁漫回来的日文标题基本都是这种形态。
     现在按名字本身分档：名字不含假名（`年` / `林` / `陈`）时，只有**汉字 / 数字 / 拉丁字母**
     才算粘连（`年上` / `年下` / `2026年7月号` / `10年間` / `辰年` / `年A` 全都不变，仍是粘着）；
     名字含假名（`ニェン` / `ケルシー`）时保持旧口径 —— 那时后面的假名可能是名字的一部分
     （`リン` 在 `リンゴ` 里），放宽会把「只是字面像」的条目错判成角色本人。 */
  const HAN_NUM_LATIN_RE = /[\u3400-\u9fff0-9a-z]/;
  function standaloneCJK(text, name) {
    const t = String(text == null ? '' : text);
    const n = String(name == null ? '' : name).trim();
    if (!t || !n) return false;
    const glue = KANA_RE.test(n) ? GLUE_RE : HAN_NUM_LATIN_RE;
    let from = 0;
    for (;;) {
      const at = t.indexOf(n, from);
      if (at < 0) return false;
      const pre = at > 0 ? t.charAt(at - 1) : '';
      const post = at + n.length < t.length ? t.charAt(at + n.length) : '';
      if (!glue.test(pre) && !glue.test(post)) return true;
      from = at + 1;
    }
  }

  /* ---------------- 单字 / 短词角色名：词典补解析 ----------------
     core.js 的 NS.CHARACTERS 只登记 5 个名字（年 / 夕 / 令 / 陈 / 凯尔希），明日方舟等 IP
     包里的其余单字名（林 / 空 / 芬 / 梅 / 锏 …）只存在于 assets/dict/ip/*.json，而那张表
     **不参与查询解析**（core.js 的 charName 只认自己那 5 条）。于是这类查询的
     intent.character 恒为空 ⇒ relevance 的角色档与 applyView 的 charFirst 全都不生效，
     排序退化成「谁的字面里含这个字」——「林檎」「森林浴」排在了角色的作品前面。
     这里补一次 HS.dict.lookup（dict-hint.js 提供的懒加载 IP 词典；没有 / 失败一律静默）：
       · 只认**整串相等**的命中（搜「林檎」不能因此被当成在搜角色林）；
       · 命中必须有 to.character；
       · 系列取命中所在的**包 id**（包 id 就是系列键，如 arknights；core 层与内部占位不算），
         这样 seriesHit 的跨源别名（明日方舟 / arknights / アークナイツ）照旧生效。
     词典还没到（裸单字被 index.json 刻意排除在锚点之外，光靠查询词永远等不到包）时由
     charPackPump() 请一次懒加载、charReload() 到齐后重排一次；两者都不改查询词。 */
  const CHAR_Q_MAX = 4;          /* 单字 / 短词（凯尔希 3 字）才算角色名；更长的查询是作品名 */
  const CHAR_PKG_MAX = 3;        /* 一轮最多请 dict-hint 拉几个包 */
  let charCache = { q: '', ch: null, pk: -1 };
  let charAsking = '';

  /* 已加载的词典包个数：**负结果只在包集合没变时才算数**。
     反例（实测踩到）：冷启动时「林」查不到（包没加载）→ 若把 null 也缓存住，
     等 charReload() 把 arknights 拉回来重排时，charOf 会直接命中这口「空」缓存，
     角色档永远不生效（锏 之所以看起来正常，只是缓存里当时装着别的查询词）。 */
  function dictPackSig() {
    try {
      const D = HS.dict;
      const l = D && typeof D.loaded === 'function' ? D.loaded() : null;
      return l && l.length != null ? l.length : -1;
    } catch (e) { return -1; }
  }

  function charOf(intent, q) {
    if (intent && intent.character) return intent.character;    /* core.js 的 5 个名字：原样 */
    if (!intent || intent.kind !== 'character') return null;
    const qq = String(q == null ? '' : q).trim();
    if (!qq || qq.length > CHAR_Q_MAX) return null;
    const pk = dictPackSig();
    if (charCache.q === qq && (charCache.ch || charCache.pk === pk)) return charCache.ch;
    let ch = null;
    const D = HS.dict;
    if (D && typeof D.lookup === 'function') {
      try {
        const r = D.lookup(qq);
        const hits = (r && r.hits) || [];
        for (let i = 0; i < hits.length; i++) {
          const h = hits[i];
          const sp = h && h.span;
          const to = (h && h.to) || null;
          if (!to || !to.character) continue;
          if (!sp || sp[0] !== 0 || sp[1] !== qq.length) continue;   /* 只认整串命中 */
          const pkg = String(h.pkg || '');
          const series = String(intent.series ||
            (pkg && pkg.charAt(0) !== '@' && pkg !== 'core' ? pkg : ''));
          const en = String(to.character);
          ch = { zh: qq, en: en, ja: '', series: series, aliases: [en] };
          break;
        }
      } catch (e) { ch = null; }    /* 词典异常绝不冒泡（与 dict-hint 的 C4 口径一致） */
    }
    charCache = { q: qq, ch: ch, pk: pk };
    return ch;
  }

  /** 词典包还没到：请 dict-hint 按「查询词 + 结果里出现的系列写法」懒加载对应的 IP 包。
      单字名本身不是锚点（assets/dict/ip/index.json 明确把它们排除在触发词之外），
      而结果里的系列写法（明日方舟 / arknights / アークナイツ）都是锚点 —— 探针串据此组织。 */
  function charPackPump(q, intent, items) {
    const qq = String(q == null ? '' : q).trim();
    if (!qq || qq.length > CHAR_Q_MAX) return;
    if (!intent || intent.kind !== 'character' || intent.character) return;
    if (charAsking === qq || charOf(intent, qq)) return;    /* 已请过 / 已经解析出来 */
    const D = HS.dict;
    if (!D || typeof D.lookup !== 'function' || typeof D.load !== 'function') return;
    charAsking = qq;
    const words = [];
    if (intent.series) words.push(String(intent.series));
    (items || []).forEach(function (it) {
      if (it && it.series && words.length < 4) words.push(String(it.series));
    });
    let pending = [];
    try {
      const probe = (qq + ' ' + u.uniq(words).slice(0, 4).join(' ')).trim();
      pending = (D.lookup(probe) || {}).pending || [];
    } catch (e) { return; }
    if (!pending.length) return;
    Promise.all(pending.slice(0, CHAR_PKG_MAX).map(function (id) {
      try { return D.load(id); } catch (e) { return null; }
    })).then(function () {
      /* 上面那次 probe 借用了 lastQuery（PROBE 按 lastQuery 解析锚点），这里还回去 */
      try { D.lookup(qq); } catch (e) { /* 静默 */ }
      charReload(qq);
    }, function () { charReload(qq); });
  }

  /** 词典到齐后重排一次：只在「还是同一次检索 + 首屏已经画好」时重画，否则什么都不做 */
  function charReload(q) {
    if (!q || R.q !== q) return;
    if (R.streaming || R.appendMode || (R.page || 1) !== 1) return;
    if (!R.raw || !(R.items || []).length) return;
    charCache = { q: '', ch: null, pk: -1 };        /* 词典到齐了：角色重新解析一遍再排 */
    try { R.render(R.raw, { page: 1 }); } catch (e) { /* 重画失败：保持现有结果 */ }
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
    /* ①b ★已知角色名★：把角色自己的拉丁 / 假名写法也当作「译名」参与标题贴合度判定。
       没有这一步，标题写 `Nian's Sex Addiction (Arknights)` 的条目在名字档（_nameKey）上
       和毫不相干的作品一样是 0 档 —— 因为查询词是「年」，而标题里是拉丁写法
       （u.normTitle 又把 `[...]` / `(...)` 整段剥掉，`年` 更是找不到）。
       于是「真的年」只能靠在正文里做包含匹配的弱命中活着，永远被「标题里含年字」的
       年份噪声压住。这一支只读 NS.CHARACTERS 的现成别名，不新增词表；
       push 里已经过滤掉「长度 <2」与「等于查询原词」的串。 */
    if (intent && intent.character) {
      const ch = intent.character;
      push(ch.en); push(ch.ja);
      (ch.aliases || []).forEach(push);
    }
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
    /* 解析出的角色：core.js 的 5 个名字（年 / 夕 / 令 / 陈 / 凯尔希）或**词典补解析**出来的
       单字名（林 / 空 / 芬 / 梅 / 锏…）。下面「系列命中」与「角色档」两道判据共用它：
       补解析出来的角色必须走角色档，不能继续落到系列命中的字面分支（否则「林檎 / 森林浴」
       照样靠字面拿 +9，角色的作品反而一分不拿 —— 这正是单字检索排不出正确次序的第二个原因）。 */
    const ch0 = it ? charOf(it, q) : null;
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
    /* 系列命中（明日方舟泛内容）。
       ★本轮降档★ 旧值是 tags 命中 +9 / series 相同 +6 / 标题含系列名 +4（最高 +19）——
       和「这一本真的有年」(旧 CHAR_HIT=16) 同一量级，于是「只要是明日方舟的」就能拿到
       和「这一本就是这个角色」差不多的分；再叠上标签量 / 页数 / 汉化，系列泛内容就能
       反超真角色（用户反馈的「明日方舟标签顶到前面」）。
       现在整体压到 CHAR_WEAK(5) 与 CHAR_STRONG(20) 之间，只当同档内的次序微调。
       守卫是 `!ch0`：**没有解析出具体角色**的 character 意图
       （`明日方舟` 本身、以及 `年上` / `年下` / `去年` / `三年` 这些字面兜底段）
       走这一支，数值与原版逐字节一致 —— 这一档是回归红线，一个字都没动。
       解析出具体角色的查询（core.js 的 `年` / `夕` / `令` / `陈` / `凯尔希`，以及本轮起由 IP 词典补解析出来的 `林` / `空` / `芬` / `梅` / `锏` …）走下面的角色档。 */
    if (it && it.kind === 'character' && !ch0) {
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

    /* ★已知角色名（本轮重写）★ 例如「年」→《明日方舟》的 年 / Nian / ニェン。
       为什么必须单独一档：上面那段「按命中段数加分」**只在多关键词（段数 ≥2）时**才算，
       而「年」是单字查询 —— 走不到那里。可这个字本身又极常见（年上 / 少年 / 去年 / 三年 /
       2026年7月号），所以这一档同时承担「抬真角色」和「压字面噪声」两件事。

       用户报告（原文）：搜「年」出来的应该是明日方舟的角色年，但「是明日方舟标签的顶到前面了
       而不一定是年这个角色，而且明日方舟的无关年的内容占用了过多」；期望次序是
       「前面是年这个角色的结果，后面是其他可能（如年下之类的）的作品」。

       旧口径只有一条 `aliasHit(blob, 名字)` 的**包含匹配** + 固定 16 分，两个毛病：
         ① 中日文包含匹配 ⇒ `2026年7月号` / `年代印痕` / `年上` 与「这本就是年」同分；
         ② 16 分只进 _score，而 cmpHit() 的主键次序是 段数 → 名字档(_nameKey) → _score ——
            名字档由 u.titleFit 决定，**标题里含一个「年」字就是 1 档**，含「Nian」拉丁写法
            反而是 0 档（查询词是「年」，u.normTitle 又把括号整段剥掉）⇒
            真角色永远排在「标题里恰好有年字」的东西后面。
       现在分两步修：
         · 判据分档（下面算出的 item._charTier）：结构化命中 = 真角色；只有包含匹配 = 弱命中；
           二者都不中但系列命中 = 系列档；再不然 = 无关档；
         · 次序不再靠分数硬拼 —— applyView() 出口新增 charFirst() 稳定分区，
           按 _charTier 分段（见那里的注释）。这里给的 CHAR_STRONG / CHAR_WEAK 只负责
           让 _score 与档位口径一致（同档内仍是「更贴合名字的在前」）。
       与 segHit 一样**只加分、只分区、不过滤**，一条结果都不会被删掉。 */
    if (ch0) {
      const ch = ch0;
      item._charTier = 0;                               // 先归零，后面按判据抬档
      const names = u.uniq([ch.zh, ch.en, ch.ja].concat(ch.aliases || []).map(x => String(x == null ? '' : x).trim()));
      const lower = names.map(n => n.toLowerCase());
      const title = String(item.title || '');
      const titleLow = title.toLowerCase();
      const fields = titleFields(item).map(f => String(f).toLowerCase());
      const tags = (item.tags || []).map(x => String(x).toLowerCase().trim());
      const serHit = seriesHit(item, it.series || ch.series);
      /* ③ 系列命中（明日方舟泛内容）—— 降档：旧值是 tags +9 / series +6 / 标题含 +4 */
      if (serHit) {
        const key = String(it.series || ch.series || '').toLowerCase();
        if (key && (item.tags || []).some(x => String(x).toLowerCase().indexOf(key) >= 0)) s += 4;
        s += 3;                                        // 系列别名命中（arknights / アークナイツ / 明日方舟）
        if (key && titleLow.indexOf(key) >= 0) s += 2;
      }
      /* ① 结构化角色命中（真·角色） */
      let strong = false;
      /* ① a 标签里**整段等于**角色名或别名：站点自己标的，最硬 */
      if (tags.some(t => t && lower.indexOf(t) >= 0)) strong = true;
      /* ① b 拉丁别名按**词边界**命中标题 / 中译名标签（只有 ASCII 别名走这一支；
            中日文别名用 ①c 的独立成段，不做包含匹配） */
      if (!strong) {
        const ascii = lower.filter(n => n && ASCII_ONLY.test(n));
        if (ascii.length && fields.some(f => ascii.some(n => aliasHit(f, n)))) {
          /* ★还要系列佐证★：`chen` / `ling` / `dusk` 这些拉丁词本身也是画师名、日常词，
             光「标题里有这个词」不足以下结论 —— 搜「陈」把标题里带 Chen（画师）的本子
             全顶到最前是有害的。佐证 = 系列命中，或标题里还出现该角色的中日文写法。 */
          const cjkInTitle = names.some(n => n && !ASCII_ONLY.test(n) && title.indexOf(n) >= 0);
          if (serHit || cjkInTitle) strong = true;
        }
      }
      /* ① c 中日文名字在标题里**独立成段**（`年` / `[年] …` / `年 (arknights)`；
             `2026年7月号` / `年上` / `年代印痕` / `辰年` 都不算） */
      if (!strong) strong = names.some(n => n && !ASCII_ONLY.test(n) && standaloneCJK(title, n));
      /* ② 只是字面含名字（弱命中）：任意写法包含匹配 —— 保留旧口径的召回，
            但只给弱档、只加小分，不再和真角色平起平坐 */
      const chHit = names.some(n => n && aliasHit(itemBlob(item), n.toLowerCase()));
      item._charHit = chHit ? 1 : 0;
      item._charStrong = strong ? 1 : 0;
      if (strong) {
        item._charTier = CHAR_T_STRONG;
        s += CHAR_STRONG;
      } else if (serHit) {
        item._charTier = CHAR_T_SERIES;
      } else if (chHit) {
        item._charTier = CHAR_T_WEAK;
        s += CHAR_WEAK;
      }
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
      /* 角色档同理：换查询后必须由本次 relevance 重算，否则「年 → 年上」时
         上一轮留下的档位会把这一轮的条目分错区（追加加载也会带着旧档位参与比较）。 */
      it._charTier = 0; it._charHit = 0; it._charStrong = 0;
      it._score = relevance(it, (q || '').toLowerCase(), f || {});
    });
    /* 多关键词：先命中段数、再名字档 / 贴合度，最后旧分数 */
    out.sort(cmpHit);
    /* 短词角色名还没解析出来（IP 词典包没加载）：请 dict-hint 懒加载一次，到齐后重排。
       放在这里是因为探针串要用「结果里出现的系列写法」（明日方舟 / arknights / アークナイツ
       都是锚点）—— 裸单字被 index.json 刻意排除在锚点之外，单靠查询词等不到包。 */
    charPackPump(q, R.intent || null, out);
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
    const lifted = liftDirectHits(keepDirect.concat(sunk));
    /* ★角色档稳定分区（本轮修正）★ 已知角色名（年 / 夕 / 令 / 陈 / 凯尔希）的检索里，
       把条目按「和这个角色是什么关系」硬性分段（见 relevance() 里 item._charTier 的算法）：
         3 真·角色命中（这一本就是这个角色，或名字就叫「年」）
         2 系列命中（明日方舟里与这个角色无关的泛内容）
         1 只是字面含这个名字（年下 / 年上 / 2026年10月号…）
         0 都不是
       为什么用**稳定分区**而不是改比较器 / 加权重（LESSONS 第 7 条）：
         · cmpHit() 的主键是「段数 → 名字档 → 分数」，而名字档由 u.titleFit 决定 ——
           「标题里恰好含一个年字」就是 1 档，「标题里写 Nian」反而是 0 档，
           单纯抬分数永远翻不过来（分数只是最末位的键）；
         · 比较器只覆盖部分排序模式（页数 / 源名 / 标题 A→Z 都不是 cmpHit），
           分区放在**唯一出口**则对所有模式都成立，且与 liftDirectHits / zhFirst 同款写法；
         · 分区是**次序偏好不是过滤**：一条结果都不会被删掉，只是挪位置。
       ★位置与「汉化置顶」的关系（本轮按用户原话调整过一次，别改回去）★
        用户原话：「**前面是年这个角色的结果**，后面是其他可能（如年下之类的）的作品」。
        先前的写法是 charFirst() 之后**再**套一层 zhFirst()，等于「所有汉化条目整体
        先于所有非汉化条目」，于是**汉化的系列泛内容 / 含字噪声会压过非汉化的真·角色**
        ——实测就是这样：汉化的《2026年7月号》《年代印痕》排在英文的
        《Nian's Sex Addiction》前面，用户点名要的第 1 名反而不是年。
        所以这里把两级优先级的**次序固定为**：
          ① 角色档（真·角色 → 系列 → 只是含字 → 都无关）
          ② 每一档**内部**再「有汉化/中文的排前面」
        即 zhFirst 降为**档内**次级键，而不再跨档覆盖。
        理由：用户的点名诉求是「第 1 个结果是年这个角色」，这是本轮要修的东西；
        而「汉化置顶」原本要解决的是「别让日文原版压过汉化版」——那是**同一批候选之间**
        的次序问题（见 PROJECT.md 的排序管道），在**档内**继续生效就完全保住了原意，
        没有必要让它跨过「这本到底是不是用户要找的那个角色」。
        ★注意★ 非角色查询（含 `明日方舟` / `年上` / `年下` 这种没解析出具体角色的意图）
        **一个字节都不走这条路**：charFirst() 直接原样返回（不分配数组），
        随后仍是纯 zhFirst()，排序与本轮修改前逐字节一致。 */
    /* ★追加模式：到此为止★（用户要求：下滑加载新作品时不许影响已加载的作品）
       appendOrder 已经把「老条目按原顺序」排在最前、新条目按当前规则接在后面，
       这**本身就是**最终次序。后面几道（末位源 / 编号直达 / 角色档 / 汉化置顶）都是
       **稳定分区**：它们只会在整表上重新分组，等于把**新来的**汉化条目插进老卡片中间
       → 已加载的卡片整体下移，用户看到的就是「页面在跳」。
       所以追加模式下直接在这里返回：老顺序 + 新条目接末尾，一个节点都不动。
       非追加（新检索 / 换筛选 / 换排序）走的仍是原来那套完整分区，逐字节未改。 */
    if (R.appendMode) {
      R.order = ordered.map(keyOf);
      return ordered;
    }
    const out = zhFirst(charFirst(lifted));
    R.order = out.map(keyOf);
    return out;
  }

  /** 角色档稳定分区（**只对角色查询生效**）：按 item._charTier 分段，
      每档内部再「有汉化 / 中文的排前面」，档内与档间的其它相对顺序一个字都不动。

      ★为什么把 zhFirst 收进**档内**★（见上面 applyView() 那一段的完整理由）
      用户原话要的是「前面是年这个角色的结果，后面是其他可能」；若先分区再整体套
      zhFirst，所有汉化条目会整体跨过非汉化的真·角色 —— 实测汉化的《2026年7月号》
      就排在了英文的《Nian's Sex Addiction》前面。所以固定为
      「先生效角色档，汉化置顶在**档内**继续生效」。
      非角色查询（没有 intent.character）**原样返回**：一次数组分配都不做。 */
  function charFirst(list) {
    const qi = R.intent;
    /* 角色档只对「解析出了具体角色」的查询生效：core.js 的 5 个名字，或词典补解析出来的
       单字名（林 / 空 / …）。两者都没有 ⇒ 原样返回，一个字节都不走这条路。 */
    if (!qi || (!qi.character && !charOf(qi, R.q))) return list;
    const seg = [[], [], [], []];
    (list || []).forEach(it => {
      const t = (it && it._charTier) || 0;
      seg[t >= 3 ? 0 : (t === 2 ? 1 : (t === 1 ? 2 : 3))].push(it);
    });
    /* 三段都是空的（这一轮一条都没判出角色档）：不折腾，交回给纯 zhFirst */
    if (!seg[0].length && !seg[1].length && !seg[2].length) return list;
    const out = [];
    seg.forEach(g => {
      const yes = [], no = [];
      g.forEach(it => { (it && it.zh ? yes : no).push(it); });
      yes.concat(no).forEach(x => out.push(x));
    });
    return out;
  }

  /** 稳定分区：item.zh 为真的排前面，其余保持原有相对顺序 */
  function zhFirst(list) {
    const yes = [], no = [];
    (list || []).forEach(it => { (it && it.zh ? yes : no).push(it); });
    return yes.length ? yes.concat(no) : (list || []);
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
  /* 尾部卷号 / 上下卷标记：要连着剥好几层（"…2 完" / "…vol3 上"）。
     ★必须认「数字 + 单位」与「第N話/巻」这两种成对写法★（用户点名的例子：
       「上班不要太认真 1话 / 2话」「xxx 上 / 下」）。旧表只有裸数字和裸「上/下」，
       于是 `…认真1话` 先被剥掉「话」→ `…认真1` 又匹配不上裸数字以外的规则 → 卡在带尾巴的
       「…认真1」上，两条话数不同的标题就永远对不上（实测就是漏判的主因）。 */
  const TAIL_VOL = /(?:(?:第\s*)?\d{1,3}|[ivx]{1,4}|vol|volume|part|pt|no|chapter|ch|ep|episode|上|下|中|前|後|后|前編|後編|前篇|后篇|完|総集編|总集篇|上巻|下巻)(?:[话話章集巻卷期冊册編篇]|巻)?$/;
  function stripVol(s) {
    let t = String(s || '');
    for (let i = 0; i < 4; i++) {
      const n = t.replace(TAIL_VOL, '');
      if (n === t) break;
      t = n;
    }
    return t;
  }
  /** 「干掉尾巴」专用：剥离全部括号块（社团 / 作者 / 译者 / 语言标记都不算标题）。
      ★入参既可以是标题字符串，也可以是条目对象★ —— 之前只吃字符串，
     而 nameAlike 传的是条目对象，于是两边都被归一化成空串、判据**静默失效**（实测踩到）。 */
  function bareOf(t) {
    const s = (t && typeof t === 'object') ? t.title : t;
    return String(s == null ? '' : s)
      .replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】|（[^）]*）/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  /** 去掉头尾括号块之后归一化（保留一个「本体」语义，供名字比较用） */
  function bareKeyOf(t) {
    return u.normTitle(bareOf(t) || titleBody(t));
  }
  /** 去掉整个尾部标记后的正文主干（不设长度门槛，调用方自己判） */
  function stemRaw(t) {
    return stripVol(bareKeyOf(t));
  }
  /** 纯「文件类别」词：光靠它自己不成系列，别把两本同名的不同作品叠起来 */
  const TITLE_STOP = ['同人志', '同人誌', '漫画', '漫畫', '本', '作品', '合集', '短篇', '单行本', '單行本',
    '总集篇', '総集編', '画集', '畫集', '插画集', '本子', 'cg集', '杂图', '雜圖', '合订本', '合訂本'];
  /**
   * 命名结构高度相同（用户点名的第二类）：**差异只出现在「作品名的尾部标记」上**，
   * 而正文主干一致 —— 也就是「这样的结构是整个作品名的一部分」。
   *   例：上班不要太认真 1话 / 上班不要太认真 2话 ✓；xxx 上 / xxx 下 ✓；
   *       某系列 第3话 / 某系列 ✓；Seed of Ruin 1 / Seed of Ruin 2 ✓
   * 判定只看**字面主干**（不含译文），所以不会把「人妻猎人」和别的作品混起来。
   * 门槛：主干 ≥2 字（用户例子里的「xxx」就是两三字），且不能是纯类别词。
   * 短标题（≤2 字）不走这条 —— 「年上 / 年下」这种会把不相干的两本叠在一起。
   */
  function cjkShape(a, b) {
    const x = bareKeyOf(a), y = bareKeyOf(b);
    if (!x || !y || x === y) return false;
    const sx = stemRaw(a), sy = stemRaw(b);
    if (!sx || !sy) return false;
    /* 主干一致 + 主干本身够长 + 不是纯类别词 → 两条只差尾部标记，同一部作品的第 N 话 / 上下卷 */
    if (sx === sy && sx.length >= 2 && TITLE_STOP.indexOf(sx) < 0) return true;
    /* 主干是另一个的前缀（「某作品 后篇」这类前后篇共用主干） */
    const short = sx.length <= sy.length ? sx : sy;
    const long = sx.length <= sy.length ? sy : sx;
    if (short.length < 2 || TITLE_STOP.indexOf(short) >= 0) return false;
    if (long.indexOf(short) !== 0) return false;
    return stripVol(long.slice(short.length)).length === 0;
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
   * ★这里的「完全相同」必须带长度门槛★（本轮修掉的误叠）：
   *   `titleParts` 会把「年上」「人妻猎人」这种中日文标题切成**一个 token**，
   *   于是原来那句 `if (ta.join('') === tb.join('')) return true` 对**任何两段 CJK 文本**
   *   都成立 —— 实测「年上」/「年上」被判相似（正常），但这条也让标题完全不同却都只有
   *   一个 token 的两条互相命中。现在改成：短标题（<4 字）一律不走「完全相同」这条，
   *   交给调用方（sameish 的 nameAlike 有自己的 ≥4 门槛）。
   */
  function titleShape(a, b) {
    const ta = titleParts(a), tb = titleParts(b);
    if (!ta.length || !tb.length) return false;
    if (ta.join('') === tb.join('') && ta.join('').length >= 4) return true;
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
       ①b 名字完全相同（归一化后逐字相等，长度 ≥4）—— 用户明确要求「名字完全相同的作品要重叠」
       ①c 标签高度重合（见 tagsAlike）：用户明确要求「标签完全相同的作品要重叠」，
           但通用标签（同人志 / 短篇 / 无修正…）任何两本都共有，必须先把它们剔除再算重合度
       ② 同名——宽松标题指纹一致（含语言 / 汉化变体）
       ③ 同画师——画师串切成 token 后至少共享一个（过滤 Circle / Artist 这类通用词与单字母）
       ④ 标题主干相同——去掉尾部卷号后一致
     ②③④ 仍要求两边命中同一个系列词典。
     ★不要直接用「共同标签数」★（Doujinshi / Oneshot / Loli 这类通用标签谁都有，实测会把 14 本画师各异的
     FGO 同人志叠成一摞）—— 所以 ①c 只在**剔除通用标签之后**还算高度重合时才成立。 */
  /* 无区分度的标签：任何两本同人志都可能共有，不能拿来判定「同一本」。
     ★只收「文件类别 / 语言 / 版本」这类真正的元信息★ —— 像「巨乳 / 美少女 / loli / school」
     这种是**内容标签**，两本的内容标签高度重合恰恰是「很可能同一本」的证据（用户要求
     「标签完全相同的作品要重叠」）。把它们当作无区分度会把这个判据废掉（实测：
     5 个标签里 4 个共享却一个都不算数）。 */
  const TAG_GENERIC = ['同人志', '同人誌', 'doujinshi', 'doujin', 'manga', '漫画', '漫畫', 'comic',
    'oneshot', 'one-shot', '短篇', '単篇', '单篇', '短編', '本', '本子', '无修正', '無修正',
    'uncensored', 'censored', 'translated', 'translation', '翻译', '翻譯', '汉化', '漢化',
    '中文', 'chinese', 'english', 'japanese', '日本語', '日本語版', 'dl版', 'digital',
    'full color', 'fullcolor', '全彩', 'カラー', 'sample', 'preview', 'r-18', 'r18', 'adult',
    '成人', 'erotic', 'hentai', 'series', 'collection', 'anthology', 'artbook', 'cg集',
    '杂图', '雜圖', '单行本', '單行本', '合集', '总集篇', '総集編', '画集', '畫集', '杂志', '雜誌'];
  const TAG_GENERIC_SET = (() => {
    const s = {};
    TAG_GENERIC.forEach(x => { s[u.normTitle(x)] = 1; s[String(x).toLowerCase()] = 1; });
    return s;
  })();
  /** 有区分度的标签集合（归一化 + 去通用词） */
  function tagSet(it) {
    const s = {};
    (it && it.tags || []).forEach(t => {
      const a = String(t || '').toLowerCase().trim();
      const b = u.normTitle(t);
      if (!a && !b) return;
      if (TAG_GENERIC_SET[a] || TAG_GENERIC_SET[b]) return;
      if (a.length < 2 && b.length < 2) return;
      s[b || a] = 1;
    });
    return s;
  }
  /** 标签高度重合：共享 ≥3 个有区分度的标签，且共享数 / 较少一方 ≥ 0.6 */
  function tagsAlike(a, b) {
    const sa = tagSet(a), sb = tagSet(b);
    const ka = Object.keys(sa), kb = Object.keys(sb);
    if (ka.length < 3 || kb.length < 3) return false;
    let shared = 0;
    ka.forEach(k => { if (sb[k]) shared++; });
    if (shared < 3) return false;
    return shared / Math.min(ka.length, kb.length) >= 0.6;
  }
  /**
   * 名字相同（用户点名的第一类，含三种情况）：
   *   ① 中文名相同 —— 归一化后逐字相等（「人妻猎人」/「人妻猎人」）
   *   ② 外语名相同 —— 同上（「Seed of Ruin」/「Seed of Ruin」）；两条其实走同一段代码，
   *      归一化不区分语种，所以这两种天然都覆盖。
   *   ③ 中文与外语**互为译文** —— 离线词典把中文标题翻成外语（`X.offline`），
   *      与另一条的标题比。例：`巨乳人妻` → `big breasts casada` / `big breasts`。
   * 门槛（都要满足）：
   *   · 长度 ≥4（3 字以下太泛 —— 实测「年上」/「年上」会把不相干的两本叠起来）；
   *   · 双方**都不是纯中日文**才算「互为译文」（两条中文标题没有译文关系可言）；
   *   · 译名必须与另一条标题**整串相等**（不取子串！否则 `big breasts` 会命中任何一本
   *     带这个标签的长标题，那是灾难性的误叠）；
   *   · 只有词典真能翻出来才算 —— 整句话（「上班不要太认真」）翻不出，那就走 ① / 命名结构这一路。
   */
  function titleCopies(it) {
    const x = bareKeyOf(it && it.title);
    if (!x) return [];
    const out = [x];
    (HS.xlate && HS.xlate.offline ? (HS.xlate.offline(x) || []) : []).forEach(c => {
      const t = (c && (c.text || c.q)) || '';
      if (t) out.push(u.normTitle(t));
    });
    return out.filter(Boolean);
  }
  function nameAlike(a, b) {
    const x = bareKeyOf(a), y = bareKeyOf(b);
    if (!x || !y) return false;
    const cjkX = /[\u3400-\u9fff]/.test(x), cjkY = /[\u3400-\u9fff]/.test(y);
    /* ① / ② 同名（同语种或跨语种逐字相同） */
    if (x === y) return x.length >= 4;
    /* ③ 互为译文：只有「一边中日文、一边非中日文」才可能是译文关系 */
    if (cjkX !== cjkY) {
      const target = cjkX ? y : x;
      const cands = cjkX ? titleCopies(a) : titleCopies(b);
      if (cands.some(c => c === target && c.length >= 4)) return true;
    }
    return false;
  }
  function sameish(a, b) {
    /* ⓪ 封面指纹相同：同一张封面就是同一本书（换个标题 / 换个源再传），最硬 */
    const ca = coverKey(a.cover), cb = coverKey(b.cover);
    if (ca && cb && ca === cb) return true;
    /* ① 命名结构接近：词级（≥3 词、差异词只是卷号）或中日文（公共前缀 + 卷号尾巴）。
       这两条**不依赖画师、也不依赖系列词典** —— 「终末地轶事 1 / 终末地轶事 2」、
       「Seed of Ruin 1 / 2」这种取名格式高度相似的就该合在一起。 */
    if (titleShape(a.title, b.title)) return true;
    if (cjkShape(a.title, b.title)) return true;
    /* ①b / ①c：用户点名的两条「必须叠」—— 名字完全相同、标签高度重合。
       同样不依赖系列词典（不同站点常常一个标了系列、一个没标）。 */
    if (nameAlike(a, b)) return true;
    if (tagsAlike(a, b)) return true;
    /* 下面几条要求两边命中同一个系列词典 */
    if (!a.series || !b.series || a.series !== b.series) return false;
    if (a.baseKey && b.baseKey && a.baseKey === b.baseKey) return true;
    /* ③ 同画师：★仅凭同画师不再算同一本★（本轮按用户要求收紧）
       旧行为是「同系列 + 同画师 ⇒ 叠」，实测那会把同一个画师在同一个系列里的
       **不同作品**叠成一摞（用户要的恰恰是「重名 / 重标签 / 命名格式一致」才叠，
       而不是「同一个画师画的所有本子」）。现在同画师只有在标题主干也一致时才算 ——
       也就是下面第 ④ 步。 */
    /* ④ 标题主干相同：拉丁标题 ≥6 字符，中日文 ≥4 字（汉字信息密度更高）
       ★先挡空主干★：stripVol 会连着剥尾部卷号，极端情况下能把整个标题剥成空串
       （「マシュ本」→「マシュ」→「マ」→ 空）—— 两条空主干相等会被判成同一本。
       所以长度门槛必须在相等判断**之前**生效（本轮修掉的一处误叠）。 */
    const sa = titleStem(a.title), sb = titleStem(b.title);
    const saOk = sa.length >= 6 || (/[\u3400-\u9fff]/.test(sa) && sa.length >= 4);
    if (!saOk || sa !== sb) return false;
    return true;
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
      const so = R.seriesOnly;
      /* byKey 的那一路用 sameish(ref, ·) 重算，而不是比 baseKey 字符串：
         「人妻猎人 xx话」这类是靠命名结构（titleShape / cjkShape）成叠的，
         它们的 baseKey 各不相同，用字符串比会把同组的大部分条目漏掉。 */
      return list.filter(i => (so.byKey ? sameish(so.ref, i) : i.series === so.v))
        .map(i => ({ type: 'single', item: i }));
    }
    /* ★追加模式的「老卡片冻结」★（用户要求：下滑加载新作品时不许影响已加载的作品）
       list 在追加模式下已经是「老条目按原顺序 + 新条目按相关度接在后」的形态（见 applyView）。
       分组时再补一条关键约束：新来的条目**优先并进已经存在的同一叠**，而不是另开一叠 ——
       沿用旧的「新条目另开一叠」写法会让同一系列在页面上出现两叠卡片（用户看到重复），
       而且新叠只能插在末尾、老叠还留在原位，视觉上就是「同一组被拆开了」。
       并进老叠只改 total/items，不改它在 final 里的位置 ⇒ 老节点的 id 序列完全不变，
       paintList 的「纯追加」快路因此一定命中（不重建、不重排、不动滚动位置）。 */
    const prevIds = {};
    (R._layout || []).forEach(n => { prevIds[layoutId(n)] = 1; });
    const nodeOf = it => ({
      type: 'stack',
      /* 系列词典命中就用系列名当组键（可与「展开全部」联动）；没命中就用标题指纹。
         '~' 前缀保证两种组键不会撞在一起。 */
      key: (it.series ? it.series : '~' + (it.baseKey || it.key)) + '|' + (it.baseKey || it.key),
      ref: it, items: [it], rest: [], total: 1
    });
    const out = [];
    /* 把一条并进某一叠：★超过平铺上限的也留在这叠里★（进 rest，不另立单卡）
       —— 用户要求「上限 5~6 张，但同一组要一路叠下去，直到不存在可叠的一对」。
       旧实现把溢出的条目**摊成单卡**补在这一叠后面，于是页面上看起来是「叠了一摞
       又跟着冒出一堆散卡」，正是他要修的现象。
       注意 rest 只承载「逻辑上属于这一叠」的条目，不再渲染成卡片 —— 它们通过
       「展开全部 N」（`R.seriesOnly`）看到，按 sameish 重算，一条都不会丢。 */
    const joinStack = (n, it) => {
      n.total++;
      if (n.items.length < STACK_MAX) n.items.push(it);
      else n.rest.push(it);
    };
    list.forEach(it => {
      /* ★不再要求「命中系列词典」★
         旧实现在这里有一道 `if (!it.series) 单张平铺` 的早退，而 sameish() 里
         真正与系列词典无关的判据（⓪ 封面指纹相同、① 命名结构高度相似 / 同名同标签
         —— 也就是「人妻猎人 01话 / 02话」这类）被它挡在门外，等于死代码。
         现在一律交给 sameish() 判：它的系列分支仍要求两边命中同一个系列，
         不命中系列的条目只可能靠「同封面」「同命名结构」「同名同标签」入叠。
         ★一条一条往下比 ⇒ 天然成链★：第 k 条只要与前面任何一叠的 ref 相符就并进去，
         并按顺序接在同一叠里；不会出现「A 叠一个、B 叠一个、同一个系列分两摞」。 */
      const hit = out.find(n => n.type === 'stack' && sameish(n.ref, it));
      if (hit) { joinStack(hit, it); return; }
      /* 追加模式：新条目若能并进「上一轮就存在的叠」，按老叠的组键找回去并进去 */
      if (R.appendMode) {
        const cand = nodeOf(it);
        const old = cand.key && prevIds['S:' + cand.key]
          ? out.find(n => n.type === 'stack' && n.key === cand.key) : null;
        if (old) { joinStack(old, it); return; }
      }
      out.push(nodeOf(it));
    });
    /* 只有一本的「系列」降级为普通卡片。
       ★溢出的条目不再补成单卡★（见 joinStack 的说明）：它们属于这一叠，
       展开全部时按 sameish 重算，仍然是完整的一组。 */
    const final = [];
    out.forEach(n => {
      if (n.type !== 'stack') { final.push(n); return; }
      if (n.total >= 2) final.push(n);
      else final.push({ type: 'single', item: n.items[0] });
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
      const so = R.seriesOnly;
      const chip = u.el('button', { class: 'hs-tag hs-tag-series', type: 'button', 'data-on': '1' },
        (so.byKey ? '同一组：' : '系列：') + u.esc(so.label) + ' <small>✕</small>');
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
  /* ---------------- 封面加载：失败必须可恢复，而且**换腿**再试 ----------------
     小卡片的 <img> 是**长生命周期**节点（继续加载时按 layoutId 复用，不重建），
     放大器却是每次打开都新建一个 <img> 重新请求同一个 URL —— 这就是两者唯一的结构差异。
     所以封面**不能**「一失败就把 src 一次性换成占位图并摘掉监听」：只要这一发请求失败过
     （网关代理 502/444、图床限流、浏览器把 lazy 图的 load/error 事件延后……），
     那张小卡片此后就永远只剩占位图（= 用户说的"没有封面"），而点开放大器又看得到真封面。
     规则：
       ① 原图地址记在 img.dataset.cover 上，任何时候都能回到它；
       ② error 后先在**当前这条腿**上按退避重试（最多 COVER_TRIES 次）；
       ③ 这条腿彻底不行 → 换下一条腿（见 u.coverCandidates：直连 ↔ 本地网关，
          网关那边有 DoH 钉 IP 与境内中继，所以"直连不通时图也能出来"）；
       ④ 所有腿都失败才落到占位图；restoreCover() 在重绘 / 打开放大器时把占位图换回原图（自愈）。
     ★不要退回「一次性降级」★ —— 那正是「小卡片没有封面、放大后正常」的成因。 */
  const COVER_TRIES = 2;
  const COVER_BACKOFF = 700;          // ms：第 1 次重试等 700，第 2 次 1400

  /** 去掉 wireCover 加的查询尾巴（判断「现在指着的是不是候选链里的那条」时要还原） */
  function stripBust(s) {
    return String(s || '').replace(/[?&]hs(?:retry|alt|repaint)=[^&]*/g, '').replace(/\?$/, '');
  }

  function wireCover(img, it, force) {
    const want = (it && it.cover) ? String(it.cover) : '';
    const key = (it && (it.key || it.id)) || '';
    /* 候选链：防盗链主机是「网关 → 直连」，其余是「直连 → 网关」 */
    let list = want ? u.coverCandidates(want) : [];
    if (!list.length && want) list = [want];
    img.__cands = list;
    img.__ci = 0;
    img.__tries = 0;
    img.__ok = 0;
    img.dataset.cover = want;
    if (!img.__coverBound) {
      img.__coverBound = 1;
      img.addEventListener('error', function onerr() {
        const cur = img.__cands || [];
        if (!cur.length) return;
        const n = img.__tries || 0;
        if (n < COVER_TRIES) {
          /* ② 同一条腿退避重试 */
          img.__tries = n + 1;
          const url = bust(cur[img.__ci || 0], 'hsretry=' + (n + 1));
          window.setTimeout(() => {
            if (img.__cands === cur) img.src = url;      // 期间被重写过就丢弃这个定时器
          }, COVER_BACKOFF * (n + 1));
          return;
        }
        const next = (img.__ci || 0) + 1;
        if (next < cur.length) {
          /* ③ 换下一条腿（直连 ↔ 网关） */
          img.__ci = next;
          img.__tries = 0;
          img.src = bust(cur[next], 'hsalt=' + next);
          return;
        }
        /* ④ 所有腿都不行才用占位图（同值重设不再触发 error） */
        const ph = u.placeholder(it && it.title, key);
        if (img.getAttribute('src') !== ph) img.src = ph;
      });
      img.addEventListener('load', () => { img.__tries = 0; img.__ok = 1; });
    }
    if (!want) { img.src = u.placeholder(it && it.title, key); return; }
    if (force) { img.src = bust(list[0], 'hsrepaint=' + Date.now()); return; }
    /* 已经指着候选链里的某一条（正在加载 / 已加载）就不重复触发请求 */
    const nowSrc = img.getAttribute('src') || '';
    if (nowSrc && stripBust(nowSrc) === list[0]) return;
    img.src = list[0];
  }

  /** 给 URL 加一个查询尾巴（原来有 query 就用 & 拼） */
  function bust(url, tag) {
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + tag;
  }

  /** 把某张卡片的封面从占位图 / 旧地址换回候选链的起点（it.cover）。
      重绘（paintList）和打开放大器（openCard）各走一次 —— 所以「点开过的那张卡片」
      一定会和放大器显示同一张封面。已经指着候选链里的某条且确认取到了就直接跳过，
      不产生额外请求。 */
  function restoreCover(card) {
    if (!card || !card.__item) return;
    const img = u.$('.hs-card-img img', card);
    if (!img) return;
    const want = card.__item.cover ? String(card.__item.cover) : '';
    if (!want || want.indexOf('data:') === 0) return;
    if (img.__ok && img.dataset.cover === want) return;         // 已经确认取到原图
    const cur = img.getAttribute('src') || '';
    if (cur && cur.indexOf('data:') !== 0) {
      /* 还指着候选链里的某一条（加载中 / 已加载）→ 不去打断它 */
      const now = stripBust(cur);
      const list = img.__cands || [];
      for (let i = 0; i < list.length; i++) if (list[i] === now) return;
    }
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
       它是**唯一**让到右上角的角标（多一个 hs-badge-id 类，见 style.css：
       `.hs-card-badges.is-hi > .hs-badge-id` 绝对定位到卡片右上角）。
       其余角标照旧留在左上角那排、顺序不动；容器加 is-hi（见 cardNode）只为
       「给右上角留位 + 换行」——不再把整排挪到右边。 */
    if (isDirectHit(it)) out.push(u.el('span', {
      class: 'hs-pill hs-pill-jm hs-badge-id',
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
    /* ★展示优先用「从原站取回的完整标签」★（cardtags.js 写进 it.srcTags）：
       检索接口往往不带标签（nhentai 的 v2 检索只回数字 tag_ids、MangaDex 也不带），
       于是这些卡片恒显示「无标签」。取回的那一份**只用于显示**，绝不写回 it.tags ——
       it.tags 参与「同系列 / 同标签」堆叠判定与跨源去重，放宽它的条数会连带改变
       堆叠与排序，那是另一件事。 */
    const list0 = (it.srcTags && it.srcTags.length) ? it.srcTags : it.tags;
    const allTags = (list0 || []).map(t => String(t)).filter(t => t && !/^\d+$/.test(t.trim()));
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

    /* ★不要给卡片封面加 loading="lazy"★（本轮修正）
       症状（用户报「有些作品加载不上封面，大小卡片都有」）：卡片上的封面有一部分
       永远停在占位图上 —— src 指着真地址、请求也真的发出去了（网络面板里 200），
       但**浏览器把 load 事件推迟了**，于是 `img.__ok` 永远是 0、`naturalWidth` 也是 0；
       wireCover 的错误重试与换腿逻辑全都建立在 load / error 事件上，事件不来它就
       永远不动作，用户看到的就是「这张卡没有封面」。
       Chrome 自己的原话（console，本机实测）：
         "Images loaded lazily and replaced with placeholders. Load events are deferred."
       这条路径**只在文档被判定为「不在前台 / 被遮挡」时触发**（本项目最常见的场景：
       开了应急遮蔽、切到别的标签页、把窗口盖住、自动化窗口 noFocus）——
       所以它表现为「有时有、有时没有」，特别难复现。
       阅读器早就把同一条坑堵过了（reader.js 的 loadImg 用 loading="eager"，注释同上），
       卡片封面漏掉了。这里改成 eager：
         · 请求时机没有变化（卡片建立时 wireCover 本来就立刻挂 src）；
         · 只是不再让浏览器「推迟 load 事件」；
         · 于是「文档不在前台」时封面也能正常解码显示。 */
    const img = u.el('img', {
      alt: it.title, loading: 'eager', decoding: 'async', referrerpolicy: 'no-referrer'
    });
    wireCover(img, it);         // 封面：失败可重试、可自愈（见 wireCover 的注释）

    const imgBox = u.el('div', { class: 'hs-card-img' });
    imgBox.appendChild(img);

    /* is-hi 只表示「这是编号直达的那张卡片」：角标容器仍在左上角正常流动，
       样式只在 is-hi 下给容器铺满整条宽度 + 右侧留位，让 jm<编号> 那一枚
       （badgeNodes 的第一枚，带 .hs-badge-id）绝对定位到右上角。 */
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
    /* ★再从原站补一次完整标签★（cardtags.js）：检索接口不带标签的源（nhentai /
       MangaDex）在这里按作品 id 取回，**进入视口时**才发请求（一屏 6–12 张，
       不是一次 30+ 张），取回来只重画这一张卡片的标签行 ——
       不动别的 DOM，滚动中重排会让卡片跳位。失败静默：保持原来那份。 */
    if (HS.cardTags && HS.cardTags.observe) {
      HS.cardTags.observe(card, it, function (tags) {
        if (!tags || !tags.length) return;
        it.srcTags = tags;
        tagBox.innerHTML = '';
        tagNodes(it, 6).forEach(n => tagBox.appendChild(n));
      });
    }
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
      /* 命中系列词典 → 按系列展开（原来那条路，行为一字未改）；
         没命中（「人妻猎人 xx话」这种纯命名结构叠出来的）→ 按这一叠的标题指纹展开，
         否则 R.seriesOnly 会拿一个不存在的系列名去过滤，展开后是空白。 */
      R.seriesOnly = group.ref.series
        ? { v: group.ref.series, label: group.ref.series, byKey: false }
        : { v: group.key, label: group.ref.title || '同名组', byKey: true, ref: group.ref };
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
    else {
      txt = '已显示 ' + shown + ' 张，继续向下滚动会向各源索取更多';
      /* 逐源到底的证据，把「还在等哪个源」说清楚：用户看到「到底了」时能对上账 */
      const pd = R._pageStat && R._pageStat.pending;
      if (pd && pd.length) txt += '（还有 ' + pd.length + ' 个源可能有更多）';
    }
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
      '|' + ((it.alsoOn || []).length) + '|' + (it.pages || 0) +
      /* 编号直达：角标结构不一样（左上角那批之外，右上角**多一枚** jm<编号>）——
         必须进签名。否则同一个 key 的卡片被复用时，__sig 不变 → 角标不重建，
         从直达切到普通（或反过来）就会残留 / 丢失那枚右上角角标。 */
      '|' + (isDirectHit(it) ? 'D' + (it.jmBadge || it.jmDirectId || '') : 'N');
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
  /* 供自测与调试：sameish 的子判据（新增判据必须有单独可测的入口，
     否则「为什么这两本叠在一起 / 没叠」只能靠猜 —— 见 LESSONS 的验证套路） */
  R.tagsAlike = tagsAlike;
  R.tagSet = tagSet;
  R.nameAlike = nameAlike;
  R.titleCopies = titleCopies;
  R.bareKeyOf = bareKeyOf;
  R.stemRaw = stemRaw;
  R.titleShape = titleShape;
  R.cjkShape = cjkShape;
  R.sameArtist = sameArtist;
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
      /* ★第 12 轮（用户需求④）★：「汉化/中文」也是一个结果页筛选位（R.zhOnly），
         但旧代码只在 R.reset() 里清它，全新检索（回车 / 点搜索）不清 ——
         于是「先点汉化/中文，再输新关键词回车」会出现：新结果仍然只留汉化，
         而「全部」chip 又同时是亮的（sourceFilter 已归零），用户看到的就是
         「标签没被自动取消勾选」。这里与 sourceFilter / seriesOnly 一起归零。
         追加检索（page > 1）不清：那时是同一轮检索的延续，筛选必须保持。 */
      R.zhOnly = false;
      R.exhausted = false;
      R.loadingMore = false;
      /* ★必须一起清掉 pageBusy★
         旧代码只清 loadingMore，pageBusy 全靠「追加检索的 after / fail 回调」复位。
         可一旦这次追加检索被新搜索打断（app.js 的 isStale 早退），两个回调都不会执行，
         pageBusy 就永远留在 true —— loadMore() 第 3 行 `if (R.exhausted || R.pageBusy)`
         直接把滚动加载锁死到页面刷新为止。这里与 R.reset()、看门狗一起把它兜住。 */
      R.pageBusy = false;
      R.clearMoreWatch();
      R._shown = 0;
      R._dryRounds = 0;
      /* 逐源「到底」证据表：全新检索必须归零，否则上一轮的「已到尽头」会跟着新关键词走 */
      R._pageState = R.pageStateNew();
      R._pageStat = null;
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

  /* ---------------- 分页「到底」判定（纯函数：不碰 DOM，可直接用 node:vm 自测） ----------------
     用户口径：「往下滑可以一直刷新，直到确实没有任何作品可以被检索」。
     所以「到底」必须由**每个源各自的观测**推出来，不能用「这一批去重后没多」这种全局代理：
     旧口径是 `fresh.length < Math.max(4, pageSize() * 0.15)`（默认 pageSize=60 → 阈值 9），
     可很多源每页本来就只回 5~8 条 —— 第二页一到就误判到底，正是「向下滑不刷新新作品」。

     每个源各自累计三类证据，各自达阈值才算**这个源**走到了尽头：
       · ok 且 rawCount === 0                  → EMPTY：这一页本来就是空的（真末页）
       · ok 且 rawCount > 0，但整批 key 都见过 → DUP  ：这个源没有真分页（再要还是同一批）
       · !ok                                    → FAIL ：这个源本轮失败 / 超时
     阈值 EMPTY×2 / DUP×3 / FAIL×3；任何一个源后来又吐出没见过的条目 → 当场撤销它的
     done（「复活」），宁可多要一轮也不许提前收手。
     全部参与源都到尽头 → exhausted（确实没有作品可检索了）。
     全局兜底：连续 PAGE_DRY_CAP 轮跨源去重后一条新的都没多 → 收手（防「源永远说还有货」空转）。
     三个阈值是调出来的：2/3/3 在「多源交错分页」下不提前收手，又不至于空转太多轮。 */
  const PAGE_EMPTY_CAP = 2, PAGE_DUP_CAP = 3, PAGE_FAIL_CAP = 3, PAGE_DRY_CAP = 6;
  const PAGE_SEEN_CAP = 800;      // 每个源记住的 key 上限（够判断「这批全见过」即可）

  function pageKey(it) { return (it && (it.key || it.id)) || ''; }

  R.pageStateNew = function () { return { src: {}, dry: 0 }; };

  /**
   * 推进一轮追加的「到底」状态。
   * @param {object}  prev    上一轮的 state（R.pageStateNew() 的产物）
   * @param {Array}   results 本轮各源返回（{ src:{id}, ok, rawCount, items }）
   * @param {boolean} grew    本轮跨源去重后总数有没有增加
   * @returns {{state:object, exhausted:boolean, pending:string[], stopped:string[], added:number, dryStop:boolean}}
   */
  R.pageStateNext = function (prev, results, grew) {
    const st = { src: {}, dry: grew ? 0 : ((prev && prev.dry) || 0) };
    /* 拷贝上一轮：本轮没回报的源保留原状态，别因为一次超时把它从「已到尽头」里抹掉 */
    Object.keys((prev && prev.src) || {}).forEach(id => { st.src[id] = Object.assign({}, prev.src[id]); });
    let added = 0;
    (results || []).forEach(r => {
      const id = (r && r.src && r.src.id) || '__unknown';
      const s = st.src[id] || (st.src[id] = { empty: 0, dup: 0, fail: 0, seen: {}, done: false, by: '' });
      if (!s.seen) s.seen = {};
      if (!r || !r.ok) {
        s.fail = (s.fail || 0) + 1; s.empty = 0; s.dup = 0;
        if (s.fail >= PAGE_FAIL_CAP) { s.done = true; s.by = 'fail'; }
        return;
      }
      s.fail = 0;
      const rawN = (typeof r.rawCount === 'number') ? r.rawCount : ((r.items || []).length);
      if (!rawN) {
        s.empty = (s.empty || 0) + 1; s.dup = 0;
        if (s.empty >= PAGE_EMPTY_CAP) { s.done = true; s.by = 'empty'; }
        return;
      }
      s.empty = 0;
      let fresh = 0;
      (r.items || []).forEach(it => {
        const k = pageKey(it);
        if (!k) { fresh++; return; }              // 没有稳定 key 的条目一律当新条目，不误判
        if (!s.seen[k]) { fresh++; s.seen[k] = 1; }
      });
      added += fresh;
      if (fresh) { s.dup = 0; if (s.done) { s.done = false; s.by = ''; } }   // 复活：这源还有货
      else if ((s.dup = (s.dup || 0) + 1) >= PAGE_DUP_CAP) { s.done = true; s.by = 'dup'; }
      const ks = Object.keys(s.seen);
      if (ks.length > PAGE_SEEN_CAP) { for (let i = 0; i < ks.length - PAGE_SEEN_CAP; i++) delete s.seen[ks[i]]; }
    });
    if (!grew) st.dry = ((prev && prev.dry) || 0) + 1;
    const ids = Object.keys(st.src);
    const pending = ids.filter(id => !st.src[id].done);
    const stopped = ids.filter(id => st.src[id].done && st.src[id].by === 'fail');
    /* 只有「所有参与源都到尽头」才算真到底；没有任何源时不许判到底（否则首屏就永久锁死） */
    const exhausted = ids.length > 0 && pending.length === 0;
    const dryStop = !exhausted && st.dry >= PAGE_DRY_CAP;
    return {
      state: st, exhausted: exhausted || dryStop, dryStop: dryStop,
      pending: pending, stopped: stopped, added: added
    };
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
      /* 追加：先剔掉「与已经铺开的中文版重复的语言变体」，再进池子（第一页 / 全新检索不受影响）。 */
      const kept = dropZhLangDup(fresh, flatten(R._pages));
      R._pages = R._pages.concat([{ ok: true, items: kept, src: { id: '__page' } }]);
    } else {
      R._pages = [{ ok: true, items: fresh, src: { id: '__page' } }];
    }
    R._partial = [];
    rebuild();
    /* ★「到底」一律交给 pageStateNext() 按**每源各自的证据**判定★
       旧代码在这里用两个全局代理判到底：① 本页原始返回为空；② 连续两轮去重后没多。
       两个都会提前收手 —— 多源交错分页时，这一轮空的是甲源、乙源还有货；
       「没多」也可能只是这批全是跨源重复。改成逐源累计证据后，
       只有**所有参与源都到尽头**才 exhausted，滚动加载因此能一直要下去。 */
    if (page > 1) {
      const j = R.pageStateNext(R._pageState, results, R.items.length > hadBefore);
      R._pageState = j.state;
      R._pageStat = j;
      R._dryRounds = j.state.dry;
      R.exhausted = !!j.exhausted;     // 可升可降：源「复活」时要把到底状态撤回来
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
  /**
   * 追加批次看门狗。
   * 为什么必须有它：R.loadingMore / R.pageBusy 原来只由 app.js 交回的 after / fail
   * 两个回调复位；而 app.js 的「新检索打断旧检索」会在每个 isStale() 处直接 return
   * （既不 after 也不 fail），于是这两个标志永远停在 true —— 之后每一次滚动到底
   * 都在 loadMore() 的第一行被挡回去，用户看到的就是「往下滑不再出新作品」，只能刷新页面。
   * 看门狗按「整轮检索上限 + 余量」到点强制复位，用代次号防止把新一轮的状态误清。
   */
  R.clearMoreWatch = function () {
    if (R._moreTimer) { clearTimeout(R._moreTimer); R._moreTimer = 0; }
  };
  R._moreGen = 0;

  R.loadMore = function () {
    if (R.streaming || HS.busy || R.loadingMore || !R.items.length) return false;
    const layoutN = (R._layout || []).length;
    /* 本地还有没铺开的候选：直接铺，并且立刻再检查一次底部哨兵。
       旧代码在这里直接 return，不调 kickFoot() —— 如果这一批没把哨兵顶出预取带
       （卡片矮 / 视口高 / 这一批大多被去重吃掉），IntersectionObserver 的相交状态
       没有变化就不会再回调，滚动加载停在原地。 */
    if (R._shown < layoutN) {
      R._shown += pageSize();
      paintList();
      R.kickFoot();
      return true;
    }
    if (R.exhausted || R.pageBusy) { paintFoot(); return false; }
    R.loadingMore = true;
    R.pageBusy = true;
    paintFoot();
    const gen = ++R._moreGen;
    R.clearMoreWatch();
    R._moreTimer = setTimeout(() => {
      if (R._moreGen !== gen) return;
      R.loadingMore = false; R.pageBusy = false;
      paintFoot();
      /* 这一轮没等到任何回调（被打断 / 请求悬挂）：直接把状态放开，让下次滚动能再来一轮 */
      R.kickFoot();
    }, u.clamp((HS.sources && HS.sources.RUN_CAP_MS) || 22000, 8000, 60000) + 8000);
    HS.bus.emit('app:search', {
      page: (R.page || 1) + 1, append: true,
      after: () => {
        R.clearMoreWatch();
        R.loadingMore = false; R.pageBusy = false;
        R._shown += pageSize(); paintList();
        R.kickFoot();
      },
      fail: () => { R.clearMoreWatch(); R.loadingMore = false; R.pageBusy = false; paintFoot(); }
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
  R.kickFoot = function (tries) {
    const foot = u.$('#results-foot');
    if (!foot || R.exhausted || R.loadingMore || R.streaming) return;
    if (foot.getBoundingClientRect().top >= window.innerHeight + 700) return;
    const n = typeof tries === 'number' ? tries : 0;
    setTimeout(() => {
      if (R.exhausted || R.loadingMore || R.streaming || !R.items.length) return;
      /* 首屏结果是在主流程收尾之前就画出来的（app.js 在第 5 步 render，finally 才清 HS.busy），
         所以这一脚经常正好踩在 HS.busy = true 上。旧代码看到 HS.busy 就直接放弃，
         哨兵又因为相交状态没变化而不再回调 → 卡死在第一批。
         现在改成「等它跑完再来」，最多重试 12 次（≈3s）；真忙不过来也不会无限重试。 */
      if (HS.busy) { if (n < 12) R.kickFoot(n + 1); return; }
      const f2 = u.$('#results-foot');
      if (f2 && f2.getBoundingClientRect().top < window.innerHeight + 700) R.loadMore();
    }, 140);
  };

  R.reset = function () {
    R.items = []; R.raw = []; R._pages = []; R._partial = [];
    R.sourceFilter = null; R.seriesOnly = null; R.zhOnly = false;
    R.page = 1; R.exhausted = false; R.loadingMore = false; R.pageBusy = false;
    R.clearMoreWatch();
    R._dryRounds = 0; R._zhDupDropped = 0;
    R._pageState = R.pageStateNew(); R._pageStat = null;
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
      R.seriesOnly = { v: it.series, label: it.series, byKey: false };
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
  /* 「放大 / 详细信息」对外开口：recent.js 的「最近浏览」列表点开某条时直接调它
     （第二个参数 card 传 null = 不是从某张卡片长出来的，走无 FLIP 的居中弹出）。 */
  R.openCard = openCard;

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
    /* ★先把上一本的像素清掉★（用户报「大卡片点开时会先显示上一本的封面」）
       放大器只有一个 <img> 节点，所有卡片共用它 —— 而浏览器在「新 src 已设、新图还没解码完」
       这段时间里会**继续显示旧图**（这是替换元素的标准行为，不是 bug）。于是点开第二本时，
       第一本的封面会一直挂在放大器里，直到新封面取回来才被换掉。
       解法：在挂新地址之前把 src 摘掉 —— 旧像素立刻消失（盒子里是一片自己的底色，
       不是别人的作品），紧接着 wireCover 挂上本作地址，图到了就直接出现，中间不会闪占位图。 */
    img.removeAttribute('src');
    /* 放大卡片与小卡片**共用同一条候选链**（直连 ↔ 网关，见 u.coverCandidates）：
       所以「小卡片出不来、点开却能看」这种两边不一致的情况不会再出现 */
    wireCover(img, it, true);
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
    /* 放大器里也补一次（优先级高于卡片：这张用户已经点开了）。取回来就地重画；
       回调回来时这张可能已经关掉 / 换成了别的作品，所以必须先核对 cm.__item。 */
    if (HS.cardTags && HS.cardTags.enrich) {
      HS.cardTags.enrich(it, function (list) {
        if (!list || !list.length) return;
        if (cm.hidden || cm.__item !== it) return;
        it.srcTags = list;
        tags.innerHTML = '';
        tagNodes(it, 30).forEach(n => tags.appendChild(n));
      });
    }

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
    /* ★默认排序 = 智能排序★
       旧代码只在用户手动改过下拉框时才写 R.sort，于是首次渲染 R.sort === undefined，
       applyView 里 `R.sort === 'rank'` 分支不成立（中文版优先那一步也不生效）。
       这里初始化成与 <select> 的默认值（option value="rank"）一致，避免"界面显示智能排序、
       实际走的是无名字的兜底比较器"这种不一致。 */
    if (!R.sort) R.sort = 'rank';
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
    }
    /* ★滚动兜底（两条路都接）★
       IntersectionObserver 只在「相交状态发生变化」时回调：如果渲染出来的卡片没把
       哨兵顶出预取带，状态一直保持 intersecting，就再也不会回调 —— 表现为「滑到底不动了」。
       所以这里无条件再挂一个滚动监听（节流 200ms），只要哨兵在预取带里就补一脚。
       它只是把 IO 漏掉的那次补回来，真正的去重/到底判断仍由 loadMore() 自己做，
       所以不会重复发请求（loadingMore / pageBusy 两道闸门拦着）。 */
    window.addEventListener('scroll', u.throttle(() => {
      if (!R.items.length || R.loadingMore || R.exhausted || R.streaming || HS.busy) return;
      const box = foot && foot.getBoundingClientRect();
      if (box && box.top < window.innerHeight + 700) R.loadMore();
    }, 200), { passive: true });

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
      /* ★走对外的 R.openCard，而不是闭包里的 openCard★
         recent.js 的「最近浏览」是在模块外**包装** R.openCard 来记账的；
         这里若直接调闭包，包装层就被绕过，点开卡片不会留下浏览记录（实测踩过）。 */
      R.openCard(card.__item, card);
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
