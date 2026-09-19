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

  const STACK_MAX = 5;        // 一个堆叠最多平铺几张

  /* ---------------- 去重 + 重排 ---------------- */
  function weightOf(id) {
    const s = HS.sources.byId[id];
    return s ? s.weight : 0.5;
  }

  /**
   * 相关度：按「查询意图」用不同策略打分。
   *   作品名（title）  → 尽量完全对上名字：完全同名 +16，前缀 +7，包含 +3
   *   IP/角色（character）→ 尽量命中对应标签：标签命中 +9，系列一致 +6
   *   体裁/题材（genre）  → 尽量罗列相关题材：每命中一个相关题材词 +5（上限 14）
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
      const fit = u.titleFit(item.title, q);
      item._fit = fit;
      if (it && it.kind === 'title') {
        s += [0, 3, 7, 16][fit] || 0;
        if (!fit && (item.tags || []).length) s -= 3;   // 名字都对不上，往后放
      } else if (fit === 3) {
        s += 6;
      }
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
    out.forEach(it => { it._score = relevance(it, (q || '').toLowerCase(), f || {}); });
    out.sort((a, b) => b._score - a._score);
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

  /* ---------------- 过滤 + 排序 ---------------- */
  function applyView() {
    let list = R.items.slice();
    if (R.sourceFilter) list = list.filter(i => i.source === R.sourceFilter);
    if (R.zhOnly) list = list.filter(i => i.zh);
    const by = {
      rank: (a, b) => (b.zh ? 1 : 0) - (a.zh ? 1 : 0) || b._score - a._score,
      pages: (a, b) => (b.pages || 0) - (a.pages || 0),
      source: (a, b) => (a.sourceName || '').localeCompare(b.sourceName || '') || b._score - a._score,
      title: (a, b) => (a.title || '').localeCompare(b.title || '')
    }[R.sort] || ((a, b) => b._score - a._score);
    if (R.sort !== 'rank') return list.sort(by);
    /* 默认排序：先保证「相似结果内中文版在前」，再按分数 */
    return preferZh(list.slice().sort((a, b) => b._score - a._score));
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
      chip.addEventListener('click', () => { R.seriesOnly = null; renderHead(); renderGrid(); });
      host.appendChild(chip);
    }

    const mkBtn = (id, label, n) => {
      const b = u.el('button', {
        class: 'hs-tag', type: 'button', 'data-on': (R.sourceFilter === id) ? '1' : '0'
      }, u.esc(label) + (n != null ? ' <small>' + n + '</small>' : ''));
      b.addEventListener('click', () => {
        R.sourceFilter = (R.sourceFilter === id) ? null : id;
        R.page = 1;
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
      zb.addEventListener('click', () => { R.zhOnly = !R.zhOnly; R.page = 1; renderHead(); renderGrid(); });
      host.appendChild(zb);
    }

    Object.keys(counts).sort((a, b) => counts[b] - counts[a]).forEach(id => {
      const nm = (HS.sources.byId[id] || {}).name || id;
      host.appendChild(mkBtn(id, nm, counts[id]));
    });
  }

  /* ---------------- 卡片 ---------------- */
  function catLabel(it) {
    if (!it.cats || !it.cats.length) return '';
    const c = HS.CATS.find(x => x.code === it.cats[0]);
    return c ? c.label : '';
  }

  /** 角标（卡片角上与放大视图共用）：汉化 → R18G / AI → 精确 → 源 → 类型 → 页数 → 多站 */
  function badgeNodes(it) {
    const out = [];
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
    img.addEventListener('error', function onerr() {
      img.removeEventListener('error', onerr);
      img.src = u.placeholder(it.title, it.key || it.id);
    });
    img.src = it.cover || u.placeholder(it.title, it.key || it.id);

    const imgBox = u.el('div', { class: 'hs-card-img' });
    imgBox.appendChild(img);

    const badges = u.el('div', { class: 'hs-card-badges' });
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
    const open = u.el('a', {
      class: 'hs-btn hs-btn-primary', href: it.url, target: '_blank', rel: 'noopener noreferrer'
    }, '打开原站');
    if (!it.url) { open.removeAttribute('target'); }
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
    R._nodes = els;
    R._rendered = els.length;
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
    if (R.page === 1) {
      R._pages = [];
      R.items = [];
      R.sourceFilter = null;
      R.seriesOnly = null;
      R.exhausted = false;
      R.loadingMore = false;
      R._shown = 0;
      R._dryRounds = 0;
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
    R._partial.push(res);
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
    const fresh = flatten(results);
    const hadBefore = R.items.length;
    if (page > 1) {
      R._pages = R._pages.concat([{ ok: true, items: fresh, src: { id: '__page' } }]);
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
    R.page = 1; R.exhausted = false; R.loadingMore = false; R._dryRounds = 0;
    R._layout = []; R._shown = 0; R._nodes = []; R._rendered = 0; R._dirty = false; R._dom = {};
    u.$('#results-grid').innerHTML = '';
    u.$('#results-head').hidden = true;
    u.$('#results-empty').hidden = true;
    const foot = u.$('#results-foot');
    if (foot) { foot.hidden = true; foot.innerHTML = ''; }
  };

  /* ---------------- 点击卡片：放大查看作品基本信息 ---------------- */
  let cm = null;   // 放大视图弹窗

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
            '<a class="hs-btn hs-btn-primary" data-cm-open target="_blank" rel="noopener noreferrer">打开原站</a>' +
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
      renderHead(); renderGrid();
      u.$('#results-grid').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  function closeCard() {
    if (!cm) return;
    cm.hidden = true;
    if (cm.__card) { cm.__card.classList.remove('hs-card-ghost'); cm.__card = null; }
    const box = u.$('.hs-cm-card', cm);
    if (box) { box.style.transition = 'none'; box.style.transform = 'none'; box.style.opacity = '1'; }
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
       等比（不是 x/y 各缩一次，那会把卡片压扁），所以看起来就是"卡片顺着原位原地长大"；
       堆叠摊开时卡片是 rotate 过的，这里用同一个角度，倾斜的卡片也倾斜地放大。
       时长与缓动按"手机打开 App"那种手感：0.34s + 先快后缓，只动 transform / opacity 走合成层。 */
    const cr = card.getBoundingClientRect();
    const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
    const rot = cardRotation(card);
    const cw = card.offsetWidth || cr.width;
    const s = Math.max(0.08, Math.min(1, cw / w));
    const mr = box.getBoundingClientRect();
    const mx = mr.left + mr.width / 2, my = mr.top + mr.height / 2;
    box.style.willChange = 'transform, opacity';
    box.style.transform = 'translate(' + (cx - mx).toFixed(1) + 'px,' + (cy - my).toFixed(1) +
      'px) rotate(' + rot + 'deg) scale(' + s.toFixed(4) + ')';
    box.style.opacity = '0.4';
    requestAnimationFrame(() => {
      box.style.transition = 'transform .34s cubic-bezier(.32,.72,0,1), opacity .22s ease-out';
      box.style.transform = 'none';
      box.style.opacity = '1';
      window.setTimeout(() => { box.style.willChange = ''; }, 460);
    });
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
    cm.__item = it;
    /* 被点的那张卡片先隐身：视觉上就是「这张卡片自己长大」，而且放大视图里封面不再模糊 */
    if (cm.__card && cm.__card !== card) cm.__card.classList.remove('hs-card-ghost');
    cm.__card = card || null;
    if (card) card.classList.add('hs-card-ghost');

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

    cm.hidden = false;
    animateFrom(card);
  }

  R.init = function () {
    u.$('#results-sort').addEventListener('change', e => {
      R.sort = e.target.value; R.page = 1; R._shown = 0; renderGrid();
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

    /* 放大视图开着时，Esc 只关它（不要顺带关掉筛选面板 / 思维链） */
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && cm && !cm.hidden) {
        e.stopImmediatePropagation();
        closeCard();
      }
    });
  };

})(window.HS);
