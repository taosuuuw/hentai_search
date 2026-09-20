/* ==========================================================================
   sources.js — 信息源适配器 + 并行聚合器
   每个适配器实现 search({ q, f, limit }) -> Promise<Item[]>
   统一输出结构见 mk()，含 cats（作品类型）与 isGore / isAI / series 标记
   ========================================================================== */
(function (HS) {
  'use strict';
  const u = HS.u;
  const S = HS.sources = { list: [], byId: {} };

  /* ======================================================================
     归一化与推断
     ====================================================================== */

  /* 作品类型：优先取源站原生分类，缺失时按标题/标签推断 */
  function inferCats(item) {
    const cats = (item.cats || []).slice();
    const blob = (((item.tags || []).join(' ')) + ' ' + (item.title || '')).toLowerCase();
    const add = c => { if (c && cats.indexOf(c) < 0) cats.push(c); };

    if (/cosplay/.test(blob)) add('cosplay');
    if (/\b3d\b|3dcg|3d漫畫|3d漫画/.test(blob)) add('3d');
    if (/anthology|アンソロジー|合集|選集|选集/.test(blob)) add('anthology');
    if (/artbook|art book|畫集|画集|イラスト集|illustration book|插畫集|插画集/.test(blob)) add('artbook');
    if (/image ?set|cg集|cg collection|artistcg|artist cg/.test(blob)) add('cg');
    if (/webtoon|manhwa|韓漫|韩漫/.test(blob)) add('hanman');
    if (/western|美漫/.test(blob)) add('western');

    if (!cats.length) {
      if (/^\s*[\[【]/.test(item.title || '')) add('doujinshi');
      else if (item.pages && item.pages >= 80) add('serial');
      else if (item.pages) add('oneshot');
      else add('comic');
    }
    if (item.pages && item.pages >= 80) add('serial');
    return cats.slice(0, 4);
  }

  function inferFlags(item) {
    const blob = (item.tags || []).join(' ') + ' ' + (item.title || '') + ' ' +
      (item.artist || '') + ' ' + (item.cats || []).join(' ');
    item.isGore = u.hitAny(blob, HS.GORE_TAGS);
    item.isAI = u.hitAny(blob, HS.AI_TAGS);
  }

  /* 「严判源」：综合向站点里大量条目**并不是**成人向，但又没有分级字段，
     判不出来时不能留 null（null = 未知 = 默认筛选会放行），要直接判 false。
     拷贝漫画（copy20）是典型：正版向 / 全年龄向作品和成人向混在同一个搜索里。 */
  const STRICT_ADULT_SOURCES = ['copymanga'];
  /* 严判源自己的成人分类 / 标记词（通用 NS.ADULT_TAGS 之外的补充）。
     ★只在严判源上生效★ —— 避免改动其它源的既有成人判定。 */
  const COPY_ADULT_TAGS = ['限制级', '限制級', 'adult comics', '成人內容', '成人内容'];

  function mk(o) {
    const title = String(o.title || '').replace(/\s+/g, ' ').trim();
    const credit = u.parseCredit(title);
    const item = {
      source: o.source,
      sourceName: o.sourceName,
      id: String(o.id == null ? '' : o.id),
      title: title || credit.clean || '未命名',
      url: o.url || '',
      cover: o.cover || '',
      artist: o.artist || credit.artist || credit.circle || '',
      pages: (typeof o.pages === 'number' && o.pages > 0) ? o.pages : null,
      lang: o.lang || '',
      langs: u.uniq(o.langs || []),
      nsfw: o.nsfw !== false,
      year: o.year || '',
      note: o.note || '',
      cats: o.cats || [],
      tags: u.uniq(o.tags || []).slice(0, 16)
    };
    item.cats = inferCats(item);
    inferFlags(item);
    /* 成人向判定：源自己的分级字段（o.adult）> 源本身就是成人站 > 标签/标题成人词；
       都判不出来就是 null（未知）—— 未知不硬杀，留给跨源合并去验证。
       ★严判源（STRICT_ADULT_SOURCES，目前是拷贝漫画这种综合向站点）例外：
       只有命中**明确成人证据**（源分级字段 / 成人站白名单 / 成人词表）才标 true，
       判不出来一律标 false —— 默认筛选「滤掉确认的非成人向」就会把它们剔除，
       而不是以「未知」的名义全部留在结果里。 */
    const strictAdult = STRICT_ADULT_SOURCES.indexOf(o.source) >= 0;
    if (typeof o.adult === 'boolean') item.adult = o.adult;
    else if (HS.ADULT_SOURCES.indexOf(o.source) >= 0) item.adult = true;
    else {
      let blob = item.tags.join(' ') + ' ' + item.title + ' ' + item.artist;
      if (strictAdult) blob += ' ' + (item.cats || []).join(' ');   // 分类名也算证据（拷贝漫画的成人分类）
      const hit = u.hitAny(blob, HS.ADULT_TAGS) ||
        (strictAdult && u.hitAny(blob, COPY_ADULT_TAGS));
      item.adult = hit ? true : (strictAdult ? false : null);
    }
    item.series = u.matchSeries(item.tags.join(' ') + ' ' + item.title + ' ' + item.artist);
    item.key = u.normTitle(item.title) || (o.source + ':' + item.id);
    /* 汉化 / 中文判定：结果里要特别标出，并在相似结果中排前面 */
    const zi = u.zhInfo(item);
    item.zh = zi.zh; item.zhMark = zi.mark; item.zhScan = zi.scan;
    item.baseKey = u.baseTitle(item.title) || item.key;
    if (!item.cover) item.cover = u.placeholder(item.title, item.source + item.id);
    /* 防盗链封面（pixiv / EH / hitomi…）有网关时代取，能少一批"封面显示不出来" */
    else item.cover = u.coverViaGateway(item.cover);
    return item;
  }
  S.mk = mk;

  /* R18G / AI 模式 + 作品类型 的本地兜底过滤（对所有源统一生效） */
  S.applyModes = function (items, f) {
    f = f || {};
    return items.filter(it => {
      if (f.gore === 'only' && !it.isGore) return false;
      if (f.gore === 'exclude' && it.isGore) return false;
      if (f.ai === 'only' && !it.isAI) return false;
      if (f.ai === 'exclude' && it.isAI) return false;
      if (f.cats && f.cats.length) {
        /* 分类已知但不匹配则剔除；分类未知的条目保留，避免误杀 */
        if (it.cats.length && !it.cats.some(c => f.cats.indexOf(c) >= 0)) return false;
      }
      return true;
    });
  };

  /* ======================================================================
     1. MangaDex —— 官方公开 API，支持 CORS，可直连（主源）
        已按需求取消内容分级控制：固定请求 suggestive / erotica / pornographic
     ====================================================================== */
  let _mdTags = null;
  async function mdTagMap() {
    if (_mdTags) return _mdTags;
    _mdTags = {};
    try {
      const data = await HS.net.fetchSource('https://api.mangadex.org/manga/tag', { json: true });
      (data.data || []).forEach(t => {
        const names = (t.attributes && t.attributes.name) || {};
        Object.keys(names).forEach(k => { _mdTags[String(names[k]).toLowerCase()] = t.id; });
      });
    } catch (e) { /* 标签词典失败不阻塞搜索 */ }
    return _mdTags;
  }

  async function mdResolveTags(names) {
    if (!names || !names.length) return [];
    const map = await mdTagMap();
    const ids = [];
    names.forEach(n => {
      const k = String(n).toLowerCase().trim();
      if (!k) return;
      if (map[k]) { ids.push(map[k]); return; }
      const hit = Object.keys(map).find(x => x.indexOf(k) >= 0 || k.indexOf(x) >= 0);
      if (hit) ids.push(map[hit]);
    });
    return u.uniq(ids);
  }

  /* 作品类型 -> MangaDex 的 format 标签名 */
  const MD_CAT = { doujinshi: 'Doujinshi', oneshot: 'Oneshot', anthology: 'Anthology', artbook: 'Artbook' };

  function mdPickTitle(obj, alts) {
    const order = ['zh', 'zh-hans', 'zh-hk', 'en', 'ja', 'ko'];
    for (const k of order) if (obj && obj[k]) return obj[k];
    if (obj) { const v = Object.values(obj)[0]; if (v) return v; }
    if (alts && alts.length) for (const a of alts) { const v = mdPickTitle(a); if (v) return v; }
    return '';
  }

  function mdParse(it) {
    const a = it.attributes || {};
    const rels = it.relationships || [];
    const coverRel = rels.find(r => r.type === 'cover_art');
    const fileName = coverRel && coverRel.attributes && coverRel.attributes.fileName;
    const artists = rels.filter(r => r.type === 'artist' || r.type === 'author')
      .map(r => (r.attributes && r.attributes.name) || '').filter(Boolean);
    const title = mdPickTitle(a.title, a.altTitles);
    const alt = mdPickTitle(null, a.altTitles);
    const tags = (a.tags || []).map(t => {
      const n = (t.attributes && t.attributes.name) || {};
      return n.en || Object.values(n)[0] || '';
    }).filter(Boolean);
    const lc = (a.availableTranslatedLanguages || []).slice(0, 4);
    const chap = parseFloat(a.lastChapter || '0') || 0;
    const cats = [];
    const tl = tags.map(t => t.toLowerCase());
    if (tl.indexOf('doujinshi') >= 0) cats.push('doujinshi');
    if (tl.indexOf('oneshot') >= 0) cats.push('oneshot');
    if (tl.indexOf('anthology') >= 0) cats.push('anthology');
    if (tl.indexOf('artbook') >= 0) cats.push('artbook');
    if (a.status === 'ongoing' && chap >= 8) cats.push('serial');
    return mk({
      source: 'mangadex', sourceName: 'MangaDex',
      id: it.id, title,
      url: 'https://mangadex.org/title/' + it.id,
      cover: fileName ? ('https://uploads.mangadex.org/covers/' + it.id + '/' + fileName + '.256.jpg') : '',
      artist: artists.slice(0, 2).join(', '),
      pages: null, langs: lc, lang: lc[0] || '',
      year: a.year || '', cats,
      /* MangaDex 自带分级：safe / suggestive / erotica / pornographic。
         请求里已经把 safe 排掉了，剩下 suggestive 属于「青年漫」档 —— 明确标成非成人向 */
      adult: /erotica|pornographic/i.test(String(a.contentRating || '')),
      tags: alt && alt !== title ? tags.concat([alt]) : tags
    });
  }

  async function mangadexSearch(ctx) {
    const q = ctx.q, f = ctx.f, limit = ctx.limit, page = ctx.page || 1;
    const intent = ctx.intent || u.classifyQuery(q);
    const per = u.clamp(limit, 1, 100);
    const pageExtra = page > 1 ? { offset: String((page - 1) * per) } : null;
    let incIds = await mdResolveTags((f.tags || []).concat(
      (f.cats || []).map(c => MD_CAT[c]).filter(Boolean)));
    /* 用户自己的筛选标签（体裁扩召回的那批**不**进「整串当标题」那一路） */
    const userIncIds = incIds.slice();
    const exIds = await mdResolveTags(f.excludeTags);
    let titleQuery = q;
    let orMode = false;
    /* 意图分流：
       IP / 角色 → 按标签精确查（标题查不到角色名）；
       体裁 / 题材 → 用题材词表扩召回，多标签走 OR；
       作品名 → 继续走 title=（尽量完全对上名字）。 */
    if (q && intent.kind === 'character') {
      const names = [q].concat(intent.series && intent.series !== String(q).toLowerCase() ? [intent.series] : []);
      const ids = await mdResolveTags(names);
      if (ids.length) { incIds = incIds.concat(ids); titleQuery = ''; }
    } else if (q && intent.kind === 'genre' && intent.genre) {
      const ids = await mdResolveTags(intent.genre.aliases.concat([intent.genre.key]));
      if (ids.length) { incIds = incIds.concat(ids); orMode = true; titleQuery = ''; }
    }
    incIds = u.uniq(incIds);

    const build = extra => {
      const p = new URLSearchParams();
      p.set('limit', String(u.clamp(limit, 1, 100)));
      p.append('includes[]', 'cover_art');
      p.append('includes[]', 'author');
      p.append('includes[]', 'artist');
      ['suggestive', 'erotica', 'pornographic'].forEach(r => p.append('contentRating[]', r));
      (f.langs || []).forEach(l => {
        const m = HS.LANG_ALIAS[l];
        if (m && m.md) p.append('availableTranslatedLanguage[]', m.md);
      });
      incIds.forEach(id => p.append('includedTags[]', id));
      if (incIds.length > 1) p.set('includedTagsMode', orMode ? 'OR' : 'AND');
      exIds.forEach(id => p.append('excludedTags[]', id));
      if (titleQuery) p.set('title', titleQuery);
      if (f.order === 'latest') p.set('order[latestUploadedChapter]', 'desc');
      else if (f.order === 'popular') p.set('order[followedCount]', 'desc');
      else if (q) p.set('order[relevance]', 'desc');
      else p.set('order[followedCount]', 'desc');
      Object.keys(extra || {}).forEach(k => p.set(k, extra[k]));
      return 'https://api.mangadex.org/manga?' + p.toString();
    };

    const urls = [];
    if (f.artist) {
      try {
        const au = await HS.net.fetchSource(
          'https://api.mangadex.org/author?limit=4&name=' + encodeURIComponent(f.artist), { json: true });
        u.uniq(((au && au.data) || []).map(x => x.id)).slice(0, 3)
          .forEach(id => urls.push(build(Object.assign({ authorOrArtist: id }, pageExtra))));
      } catch (e) { /* 退化为标题检索 */ }
    }
    if (!urls.length) urls.push(build(pageExtra));

    const pages = await Promise.all(urls.map(url =>
      HS.net.fetchSource(url, { json: true, allowProxy: true }).catch(() => null)));

    let data = [];
    pages.forEach(pg => { if (pg && pg.data) data = data.concat(pg.data); });
    if (!data.length && !pages.some(Boolean)) throw new Error('MangaDex 无响应');

    /* 残余词：额外一路「整串当标题」（title=<整串>，只带用户自己的筛选标签）——
       **并集**；失败 / 超时只吞掉，绝不改变上面的报错时机与判定 */
    let laneItems = [];
    const lane = laneOf(ctx, intent);
    if (lane && lane !== titleQuery) {
      const savedInc = incIds, savedOr = orMode, savedTitle = titleQuery;
      incIds = userIncIds; orMode = false; titleQuery = lane;
      const laneUrl = build(pageExtra);
      incIds = savedInc; orMode = savedOr; titleQuery = savedTitle;
      laneItems = await addTitleLane([], () => HS.net.fetchSource(laneUrl, { json: true, allowProxy: true })
        .then(pg => (pg && pg.data) ? pg.data.map(mdParse) : []), lane);
    }

    const out = [], seen = {};
    data.forEach(it => { const r = mdParse(it); if (seen[r.key]) return; seen[r.key] = 1; out.push(r); });
    /* 旧串那一批按原口径截到 limit；「整串当标题」那一路只加不减（最多再补 limit 条） */
    const merged = out.slice(0, limit);
    const taken = {};
    merged.forEach(r => { taken[r.key] = 1; });
    let added = 0;
    for (let i = 0; i < laneItems.length && added < limit; i++) {
      const r = laneItems[i];
      if (taken[r.key]) continue;
      taken[r.key] = 1;
      added++;
      merged.push(r);
    }
    return merged;
  }

  /* ======================================================================
     2. nhentai —— 非官方 JSON API（网关优先；无网关时直连 + 公共 CORS 代理兜底）
     这里踩过两个坑（都已修）：
     ① 通路：本机直连 nhentai.net 的 TLS 会被重置（「基础连接已经关闭：接收时发生错误」，
        Node 侧是 getaddrinfo ENOENT），公共 CORS 代理又慢又常挂 —— 浏览器直连必失败，
        所以有网关时由网关带站点 Referer、走出口代理代取，直连链路只作无网关兜底。
     ② 查询串：v2 的命名空间按标签类型生效（tag:/parody:/character:/artist: …），
        发 `tag:"用户原词"` 常常一条都命中不了 —— 主词一律改发裸词，详见 nhTerms()。
     ====================================================================== */
  const NH_CAT = { doujinshi: 'doujinshi', comic: 'manga', oneshot: 'manga', cg: 'artistcg', artbook: 'imageset', cosplay: 'cosplay', western: 'western' };

  /* 上游 v2 的 thumbnail 是**相对路径**（galleries/<media_id>/thumb.webp），
     直接当封面会解析到页面自己的域上（必然 404）；这里统一补成 t.nhentai.net 绝对地址 */
  function nhCover(r) {
    const thumb = String((r && r.thumbnail) || '').trim();
    if (thumb) return /^https?:\/\//i.test(thumb) ? thumb : ('https://t.nhentai.net/' + thumb.replace(/^\/+/, ''));
    return r && r.media_id ? 'https://t.nhentai.net/galleries/' + r.media_id + '/cover.jpg' : '';
  }

  /* ======================================================================
     多段查询（真·多关键词）：把**每一段的关键词**都发到上游
     ----------------------------------------------------------------------
     旧口径的毛病（实测）：`明日方舟 能天使 后入` 命中系列后 kind === 'character'，
     nhTerms / gwTerms 于是只把系列名发出去 —— 上游收到的就是 `明日方舟`，
     能天使 / 后入 根本没参与检索（合并后 22 条真实结果里 0 条命中 ≥2 段），
     results.js 的「命中段数优先」再准也无从发挥。
     实测（经网关打 nhentai v2，2026-09，total 是精确值）：
       `明日方舟` 25 条/页（total 529）· `明日方舟 能天使 后入` 0 条 ·
       `明日方舟 能天使` 2 条 · `能天使` 7 条 · `原神 派蒙 中出` 0 条 → `原神 派蒙` 5 条。
     逐段发出去之后：`明日方舟 能天使 后入` 合并 24 条、命中 ≥2 段的 2 条升到 #1–#2；
     `原神 派蒙 中出` 命中 ≥2 段的 3 条升到 #1–#3（改前都是 0 条）。

     现在：intent.multi（core.js parseQuery 给的「段数 ≥2」）为真时，逐段取
     「该段最合适的那个词」，按各源口径用空格连接（nhentai / 网关类 / Danbooru
     的多词都是 AND 语义）。**单段查询一步都不走这里** —— nhTerms / gwTerms /
     danbooru 的旧串逐字节不变（回归红线见各自的 legacy 分支）。

     每段只挑一个词（多词是 AND，堆同义词只会把结果打没）：
       series      规范名原文（＝用户那个写法在词典里的规范名；中文查询就是中文名 ——
                   实测 nhentai 裸词 `明日方舟` 能打中中文扫本，不做跨语言改写）
       genre       英 / 日文站 → 词表键名（big breasts）；中文站 → 用户原词（巨乳）；
                   zhdict 段（core.js 反查出来的那种）没有键名 → 用反查到的英文标签键
       concept     按 TAG_LANG 挑写法：en → c.en、ja → c.ja、zh → c.zh（与 S.termFor 同口径）
       character / plain / title   用户原词（词典不认识这类词，只有字面可用）
     ====================================================================== */

  /* TAG_LANG 用短名当键（jm / pixiv…），源 id 是 jmcomic / copymanga…
     这里对齐一次；未登记的一律英文口径（与 S.termFor 现状一致，不改它的行为）。 */
  const SRC_LANG_ALIAS = { jmcomic: 'jm' };
  function langFor(srcId) {
    const k = SRC_LANG_ALIAS[srcId] || srcId;
    return TAG_LANG[k] || 'en';
  }

  /** 一段 → 该源口径下最合适的**那一个**词；挑不出来返回 '' */
  function segWord(seg, lang) {
    if (!seg) return '';
    const t = String(seg.text || '').trim();
    if (seg.kind === 'series') return String(seg.series || t).trim();
    if (seg.kind === 'genre') {
      if (lang === 'zh') return t;                    /* 中文站：中文词比英文键名准 */
      /* 段里只有 aliases（core.js 的 classifySegment 没带 genre 对象）——
         词表键名靠 u.exactGenre 反查回来；zhdict 段（TAG_ZH 反查）没有键名，
         退回 aliases[0]，它正是反查出来的那个英文标签键（如 中出 → creampie）。 */
      const g = seg.genre || u.exactGenre(t) || null;
      return String((g && g.key) || (seg.aliases || [])[0] || t).trim();
    }
    if (seg.kind === 'concept') {
      const c = seg.concept || {};
      const pick = lang === 'ja' ? (c.ja || c.en || c.zh)
        : lang === 'zh' ? (c.zh || c.en)
          : (c.en || c.zh);
      /* 保守化门槛（与 S.termFor 同口径，★只作用于 zh 槽位★）：
         用户这一段**自己有**独立中文写法时（TAG_ZH 命中 / 它本身就是某个概念组的
         zh 名），发它自己的写法，而不是组的 c.zh。动机与 termFor 的门槛完全相同：
         组把两个不同概念凑成一组时（「人妻」曾被并进 milf 组），多关键词查询里
         的分段同样会把 A 段换成 B 的规范词 —— `mature female 中出` 曾经发出
         `熟女 中出`。en / ja 槽位一个字都不动（那里的规范词本来就该由组的
         en / ja 决定，拿中文去顶替只会把发往上游的串改坏）。
         纯别名（自己没有独立翻译，如 mature woman / 已婚女性）照旧被组的规范词替换。 */
      if (lang === 'zh' && typeof S.ownZh === 'function') {
        const own = S.ownZh(t);
        if (own && own !== pick) return own;
      }
      return String(pick || t).trim();
    }
    return t;                                         /* character / plain / title：原词 */
  }

  /**
   * 多段查询的词表（按用户写的顺序、去重）。不是多关键词就返回 [] ——
   * 调用方据此走**逐字不变的旧串**。
   * max > 0 时只取前 max 个词（Danbooru 匿名限 2 个标签）。
   */
  function multiWords(intent, lang, max) {
    if (!intent || !intent.multi) return [];
    const segs = intent.segments || [];
    if (segs.length < 2) return [];
    const out = [];
    for (let i = 0; i < segs.length; i++) {
      const w = segWord(segs[i], lang);
      if (w && out.indexOf(w) < 0) out.push(w);
    }
    if (max > 0 && out.length > max) return out.slice(0, max);
    return out.length >= 2 ? out : [];      /* 去重后只剩一个词＝不再是多关键词，回旧串 */
  }

  /* 每个源、每一页最多发几次上游（只在**多关键词**且前几级拿不够时才走到后面） */
  const MULTI_MAX_TRIES = 3;
  /* 手上条数到多少就收手（别把上游打爆；小源 limit 很小也至少留 3） */
  function needKeep(limit) { return Math.max(3, Math.min(parseInt(limit, 10) || 12, 12)); }

  /**
   * 候选串阶梯：**全段串 → 去掉尾段（仍需 ≥2 段）→ 今天的旧串**。
   * 最后一级一定是旧串，且 tryVariants 是**并集**语义 ⇒ 结果条数只会 ≥ 旧串单跑。
   * ⚠ 从**后**往前丢段：实测 `明日方舟 能天使 后入` 里最后一个词（后入 / 中出
   *   这类动作词）把 AND 打到 0 条，丢掉它就回到「系列 + 角色」的有货区间，
   *   而系列 / 角色段保留着（正是 results.js 排序要用的那两段）。
   */
  function termLadder(words, join, legacy) {
    const out = [];
    const push = s => {
      s = String(s == null ? '' : s).trim();
      if (s && out.indexOf(s) < 0) out.push(s);
    };
    push(join(words));
    if (words.length > 2) push(join(words.slice(0, words.length - 1)));
    push(legacy);
    return out.slice(0, MULTI_MAX_TRIES);
  }

  /**
   * 逐级执行候选串：按顺序发上游、**并集**返回（条数只会 ≥ 任何单级，绝不比旧串少），
   * 到手 ≥ need 条就提前收手 —— 常态只发 1 次请求。
   * 失败语义与旧版一致：
   *   · 「这一级没货」（错误上带 soft，例如各源自己的「返回 0 条」）→ 放宽到下一级；
   *   · **通路/超时等硬失败、以及最后一级（旧串）的任何失败 → 原样抛出**
   *     ⇒ 源整体不通时的请求次数与报错时机跟今天完全一样，不会因为多关键词而翻倍。
   */
  async function tryVariants(list, run, need) {
    const out = [], seen = {};
    for (let i = 0; i < list.length; i++) {
      let got = [];
      try { got = (await run(list[i])) || []; }
      catch (e) {
        if (i === list.length - 1 || !(e && e.soft)) throw e;
        continue;
      }
      for (let j = 0; j < got.length; j++) {
        const it = got[j];
        const k = String((it && (it.key || it.id)) || '');
        if (k && seen[k]) continue;
        if (k) seen[k] = 1;
        out.push(it);
      }
      if (out.length >= need) break;
    }
    return out;
  }

  /** 该源口径下「这一级没货（0 条）」的错误：带 soft，好让阶梯放宽到下一级 */
  function emptyErr(msg) { const e = new Error(msg); e.soft = 1; return e; }

  /* ======================================================================
     残余词 → 追加一路「整串当标题」检索（与 core.js 的 conceptOf 守卫配套）
     ----------------------------------------------------------------------
     症状：`人妻猎人` / `巨乳猎人` / `中出猎人` / `脚底` 这类**粘连成一整串**的查询，
     词典只吃掉了其中一小截（人妻 / 巨乳 / 中出 / 脚），另一半是残余词：
       · core.js 侧：整串曾被判成概念（`人妻猎人` ⇒ concept 人妻）⇒ kind='genre'，
         残余词在检索口就被换掉；
       · sources.js 侧：即便守卫生效（整串不再判成概念，可能变成 character / plain），
         各源的**体裁 / 概念口径**照样会把整串换成词典词发出去 ——
         nhentai 发 `big breasts`、Pixiv 发 `巨乳`、E-Hentai 发 `"big breasts"$`、
         Mangadex 干脆不发 title 只发标签；残余的「猎人」被丢掉，
         名字就叫《巨乳猎人》的作品根本进不了结果集。
     做法：在原有检索**之后**再补一路「整串当标题」（各源自己的标题口径），
     与原有结果**并集**（只加不删；跨源去重照旧交给 results.js 的 R.combine）：
       · 触发：core.js 分类命中了词典词、但整串还有残余词（S.titleLaneFor）；
         查询必须是**单段**（无空格）—— 带空格的多关键词走上一轮的「逐段阶梯」，
         每一段都发过上游，不存在整段被丢；
       · 上限：每源每页**最多多 1 次**（与 MULTI_MAX_TRIES 同一口径）；
       · 失败语义：这一路是**纯加分项** —— 通路失败 / 超时 / 0 条 / 抛栈一律吞掉，
         原有结果的条数与报错时机一个字节都不动（不抛栈、不 soft 放宽）；
       · 幂等：整串与原有路径发过的串相同（`人妻猎人` 守卫生效后就是这样）⇒ 一次都不多发，
         单关键词、无残余词的查询上游串与改动前逐字节相同。
     ====================================================================== */

  /**
   * 残余词检测：整串里含词典词、且去掉词典词后还剩字 ⇒ 返回**用户原词**（要当标题发的那串），
   * 否则返回 ''。只读 core.js / dict.js 的现成数据（intent 的 genre / concept、HS.CONCEPTS），
   * 不新增任何词表、不改任何词典。
   */
  S.titleLaneFor = function (rawQ, intent) {
    const raw = String(rawQ == null ? '' : rawQ).trim();
    const low = raw.toLowerCase();
    if (!low) return '';
    if (/\s/.test(low)) return '';                 /* 多段查询：逐段阶梯已经每段都发过 */
    const words = [];
    const push = w => {
      const s = String(w == null ? '' : w).toLowerCase().trim();
      if (s && words.indexOf(s) < 0) words.push(s);
    };
    /* ① 分类真的命中了词典（体裁 / 题材 / 概念）：直接用那一组词 */
    if (intent && intent.genre) {
      push(intent.genre.key);
      (intent.genre.aliases || []).forEach(push);
    }
    if (intent && intent.concept) (intent.concept.aliases || []).forEach(push);
    /* ② 守卫生效后 kind 可能已经不是 genre / concept（`人妻猎人` ⇒ character / plain）：
       这时自己到概念表里找「被整串裹住的短词」—— 与 conceptOf 老口径同域
       （中日文、命中词 2–3 字；1 字词不收，`明日方舟` 这种系列名不该被单字带偏）。 */
    if (!words.length && /[\u3400-\u9fff\u3040-\u30ff]/.test(low)) {
      (HS.CONCEPTS || []).forEach(c => (c.aliases || []).forEach(a => {
        const w = String(a == null ? '' : a).toLowerCase().trim();
        if (w.length >= 2 && w.length <= 3 && low.length > w.length && low.indexOf(w) >= 0) push(w);
      }));
    }
    if (!words.length) return '';
    if (words.indexOf(low) >= 0) return '';        /* 整串就是词典词：纯关键词，无残余词 */
    let rest = low;
    words.sort((a, b) => b.length - a.length).forEach(w => { rest = rest.split(w).join(' '); });
    if (!rest.replace(/\s+/g, '')) return '';      /* 词典词正好覆盖整串：无残余词 */
    return raw;
  };

  /** 这次这一路要不要发（ctx.titleLane 由 S.run 按**用户原词**填好；缺省时退回 ctx.q，保守） */
  function laneOf(ctx, intent) {
    const raw = (ctx && Object.prototype.hasOwnProperty.call(ctx, 'titleLane'))
      ? ctx.titleLane
      : ((ctx && ctx.rawQ != null) ? ctx.rawQ : (ctx && ctx.q));
    return S.titleLaneFor(raw, intent || (ctx && ctx.intent));
  }

  function itemKey(it) { return String((it && (it.key || it.id)) || ''); }

  /**
   * 并集：把「整串当标题」这一路的结果接到已有结果后面（按 key 去重，**只加不删**）。
   *   · `already`：原有路径已经发过的串（这一路与它重复 ⇒ 一次都不多发）；
   *   · `maxAdd`：这一路**最多再补几条**（调用方给每源的 limit）。
   * ★旧串那一批一条都不截★ —— 截的只有「补进来的这一路」，否则旧串把 limit 填满时
   * 补检索的结果会被 slice 掉，等于白跑一趟（实测就是这个问题：nhentai 返回 12 条
   * big breasts 后，整串那一路的 12 条被截掉，用户还是看不到《巨乳猎人》）。
   * 任何失败（通路 / 超时 / 0 条 / 抛栈）都只吞掉，绝不改变调用方的结果与报错时机。
   */
  async function addTitleLane(items, run, lane, already, maxAdd) {
    if (!lane) return items;
    if (already && already.indexOf(lane) >= 0) return items;
    let got = [];
    try { got = (await run(lane)) || []; } catch (e) { return items; }
    const out = (items || []).slice(), seen = {};
    out.forEach(it => { const k = itemKey(it); if (k) seen[k] = 1; });
    let added = 0;
    for (let i = 0; i < got.length; i++) {
      if (maxAdd && added >= maxAdd) break;
      const it = got[i];
      const k = itemKey(it);
      if (k && seen[k]) continue;
      if (k) seen[k] = 1;
      added++;
      out.push(it);
    }
    return out;
  }

  /** 「整串当标题」的 nhentai 串：原词 + 各筛选条件（结构与 nhTerms 相同，只是不换词） */
  function nhTitleTerms(raw, f) {
    const s = String(raw == null ? '' : raw).trim();
    return s ? [s].concat(nhFilters(f || {})).join(' ') : '';
  }

  /** 「整串当标题」的网关系串：原词 + 画师筛选（结构与 gwTerms 相同，只是不换系列名） */
  function gwTitleTerms(raw, f) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) return '';
    return [s].concat(f && f.artist ? [f.artist] : []).join(' ').trim();
  }

  /**
   * 主词口径：**一律发裸词**（实测数据见下），只有明确的筛选条件才用命名空间。
   * 实测（本机经网关打 https://nhentai.net/api/v2/search，用响应里的 total 判定，
   * total 是精确值，不会被每页 25 条截断）：
   *   · v2 的命名空间是**按标签类型**生效的：parody: / character: / artist: /
   *     language: / category: / tag: 各管一类。用户原词常常不是 tag 类型 ——
   *     "fate" 在站上的规范标签是 parody「fate grand order」，所以
   *     `tag:"fate"` = 0 条、`tag:"fate grand order"` = 0 条（这就是
   *     「nhentai 基本不返回作品」的第二个原因，2026-09-20 实测）。
   *   · 裸词是类型无关的，且每一组对比里都 ≥ 命名空间写法：
   *       fate                 23875  >  parody:"fate"          21466  >  tag:"fate"  0
   *       full color           83504  >  tag:"full color"       83330
   *       foot                 15961  >  tag:"foot"             15815
   *       netorare             43210  >  tag:"netorare"         42702
   *       scathach skadi         128  >  character:"scathach skadi" 109
   *       engo                    50  >  artist:"engo"              35
   *   · 所以主词用裸词；命中率与精度都不吃亏，还免疫「命名空间和标签类型不匹配 → 0 条」。
   */
  /* 「类型明确」的筛选条件（实测命名空间写法正常，**原样保留**，一个字没动）。
     抽出来只为一件事：多关键词时每一级候选串都得带着它们，不能因为改了主词就丢筛选。 */
  function nhFilters(f) {
    const terms = [];
    if (f.artist) terms.push('artist:"' + f.artist + '"');
    (f.tags || []).forEach(t => terms.push('tag:"' + t + '"'));
    (f.excludeTags || []).forEach(t => terms.push('-tag:"' + t + '"'));
    (f.langs || []).forEach(l => {
      const m = HS.LANG_ALIAS[l];
      if (m && m.nh) terms.push('language:' + m.nh);
    });
    if (f.gore === 'only') terms.push('tag:"guro"');
    if (f.gore === 'exclude') terms.push('-tag:"guro"');
    if (f.ai === 'only') terms.push('tag:"ai-generated"');
    if (f.ai === 'exclude') terms.push('-tag:"ai-generated"');
    const nhCat = (f.cats || []).map(c => NH_CAT[c]).find(Boolean);
    if (nhCat) terms.push('category:' + nhCat);
    return terms;
  }

  function nhTerms(q, f, intent) {
    const terms = [];
    /* IP / 角色 → 规范系列名（与网关类源的 gwTerms 口径一致），体裁 / 题材 → 词表键名 */
    if (q) {
      if (intent.kind === 'character') terms.push(intent.series || q);
      else if (intent.kind === 'genre' && intent.genre) terms.push(intent.genre.key || q);
      else terms.push(q);
    }
    return terms.concat(nhFilters(f)).join(' ');
  }

  /**
   * 多关键词时的 nhentai 候选串阶梯（单关键词 → []，调用方走上面的旧串）。
   * 全段裸词（nhentai 多词＝AND）→ 去掉尾段 → 旧串；
   * 多段一个命名空间前缀都不加：NH_CAT / artist: / tag: 之外**主词一律裸词**
   * （实测 `tag:"fate"` → 0 条、裸词 `fate` → 2 万+，理由见上面的主词口径注释）。
   */
  function nhLadder(q, f, intent) {
    const words = multiWords(intent, 'en');
    if (!words.length) return [];
    const sfx = nhFilters(f).join(' ');
    const join = ws => (ws.join(' ') + (sfx ? ' ' + sfx : '')).trim();
    return termLadder(words, join, nhTerms(q, f, intent));
  }

  /** 排序口径（v2 实测接受 sort=date / sort=popular） */
  function nhSort(f) {
    return f.order === 'latest' ? 'date' : (f.order === 'popular' ? 'popular' : '');
  }

  /** 暴露给验证用：返回「适配器实际会发给上游的串」，网关路径与直连兜底共用同一个。
      多关键词时 q 是**第一级**（全段裸词），variants 是完整阶梯（末级＝旧串）；
      单关键词时 q 与旧版逐字节相同、variants 为空数组。 */
  S.nhQueryFor = function (ctx) {
    const c = ctx || {};
    const f = c.f || {};
    const q = String(c.q == null ? '' : c.q);
    const intent = c.intent || u.classifyQuery(q);
    const ladder = nhLadder(q, f, intent);
    return {
      q: ladder.length ? ladder[0] : nhTerms(q, f, intent),
      variants: ladder,
      sort: nhSort(f)
    };
  };

  /** v2 上游条目 → 统一卡片模型（网关路径与直连兜底共用一个口径） */
  function nhParse(r) {
    const title = r.english_title || r.pretty_title || r.japanese_title || ('Gallery #' + r.id);
    /* nhentai v2 的 tag_ids 是「纯数字 id 数组」，站点没有名字映射可用
       （v1 的 /api/gallery/* 已 403、/api/v2/tags 已 404），所以这里只接受
       「看起来像标签名」的值，绝不把数字当标签显示；语言/分类靠标题兜底。 */
    const raw = r.tag_ids;
    const vals = Array.isArray(raw) ? [] : (raw && typeof raw === 'object' ? Object.keys(raw).map(k => raw[k]) : []);
    const tagNames = vals.map(t => String(t)).filter(t => t && !/^\d+$/.test(t));
    const tl = tagNames.map(t => t.toLowerCase());
    const langs = ['chinese', 'english', 'japanese', 'korean', 'spanish', 'french', 'german', 'russian']
      .filter(l => tl.indexOf(l) >= 0);
    const cats = [];
    if (tl.indexOf('imageset') >= 0) cats.push('artbook');
    if (tl.indexOf('cosplay') >= 0) cats.push('cosplay');
    return mk({
      source: 'nhentai', sourceName: 'nhentai',
      id: r.id,
      title: (r.japanese_title && r.english_title ? title + ' / ' + r.japanese_title : title),
      url: 'https://nhentai.net/g/' + r.id + '/',
      cover: nhCover(r),
      pages: r.num_pages || null,
      langs, lang: langs[0] || '', cats,
      tags: tagNames.slice(0, 24)
    });
  }

  /** 网关路：单次请求（多关键词时阶梯的每一级都走它；网关明确报失败＝这一级不通） */
  async function gwNh(query, page, sort) {
    const res = await HS.net.gateway.get('/api/nhentai/search',
      { q: query, page: page, sort: sort }, 30000);
    if (res && res.ok === false) throw new Error(res.error || '网关返回失败');
    return gwItems(res, 'nhentai', 'nhentai', 'nhentai（经网关）');
  }

  /** 直连兜底路：单次请求（原逻辑原样搬进来，只把「查询串」变成参数） */
  async function nhDirect(query, page, sort, limit) {
    let url = 'https://nhentai.net/api/v2/search?query=' + encodeURIComponent(query) + '&page=' + page;
    if (sort) url += '&sort=' + sort;
    const data = await HS.net.fetchSource(url, { json: true, allowProxy: true, proxyFirst: true });
    const rows = (data && data.result) || [];
    return rows.slice(0, limit).map(nhParse);
  }

  async function nhentaiSearch(ctx) {
    const q = ctx.q, f = ctx.f, limit = ctx.limit;
    const intent = ctx.intent || u.classifyQuery(q);
    const query = nhTerms(q, f, intent);            /* 两条路共用同一个查询串（同口径） */
    if (!query) throw new Error('nhentai 需要至少一个关键词或标签');

    const page = Math.max(1, ctx.page || 1);            /* 「继续加载」靠它翻页 */
    const sort = nhSort(f);
    /* 多关键词：全段裸词 → 去掉尾段 → 旧串（单关键词 → []，一个字都不变） */
    const ladder = nhLadder(q, f, intent);
    const need = needKeep(limit);
    /* 残余词：再补一路「整串当标题」（q=<整串> + 同样的筛选条件）。与旧串重复 ⇒ 一次都不多发 */
    const lane = nhTitleTerms(laneOf(ctx, intent), f);

    /* ---- 路线 1（优先）：本地网关代取 ----
       网关有出口代理 + 站点 Referer，是这台机器上唯一稳定的通路 */
    let gwErr = null, gwAnswered = false;
    if (gwReady()) {
      try {
        let items = ladder.length
          ? await tryVariants(ladder, v => gwNh(v, page, sort), need)
          : await gwNh(query, page, sort);
        items = await addTitleLane(items.slice(0, limit), v => gwNh(v, page, sort), lane, [query], limit);
        gwAnswered = true;
        if (items.length) return items;
      } catch (e) { gwErr = e; gwAnswered = false; }
    }

    /* ---- 路线 2（兜底）：浏览器直连 + 公共 CORS 代理 ----
       无网关的用户仍然走这条（本机实测成功率很低，但保留了这条路） */
    let directErr = null, directAnswered = false;
    try {
      let items = ladder.length
        ? await tryVariants(ladder, v => nhDirect(v, page, sort, limit), need)
        : await nhDirect(query, page, sort, limit);
      items = await addTitleLane(items.slice(0, limit), v => nhDirect(v, page, sort, limit), lane, [query], limit);
      directAnswered = true;
      if (items.length) return items;
    } catch (e) { directErr = e; }

    /* 任意一条路正常应答过 → 0 条就是「没搜到」，不是异常 */
    if (gwAnswered || directAnswered) return [];
    /* 两条路都失败 → 说清是哪两条路 */
    throw new Error('nhentai 直连不通（' + ((directErr && directErr.message) || directErr) + '），且网关' +
      (gwErr ? '失败（' + ((gwErr && gwErr.message) || gwErr) + '）' : '未启用') + GW_HINT);
  }

  /* ======================================================================
     3. E-Hentai —— HTML 解析（需代理；部分网络需 VPN）
     ----------------------------------------------------------------------
     实测取证（2026-09，出口 = 本机代理 127.0.0.1:7897 / 出口 IP 54.255.249.22）：
       · 搜索侧**一律返回空集**，且与查询词、UA、请求头、cookie、GET/POST 全无关：
         ?f_search=chinese → 5443B/0 条；?f_search=a → 5392B/0 条；
         /tag/chinese → 5444B/0 条；页面结构正常（搜索框回显了词），就是不返回条目。
       · 非搜索入口同一个出口完全正常：/ → 25 条、/popular → 64 条、
         /toplist.php → 40 条、/g/<gid>/<token>/ → 正常、api.php gdata → 正常。
       · 用本机 Chrome 打开同一个搜索 URL 也是 No hits found —— 与浏览器/Node 无关。
       · 换手机/桌面/iPhone UA、加全套浏览器头、先取首页 cookie 再搜、改成 POST：
         结果一模一样（首页实测连 set-cookie 都不发）。
     结论：本机出口 IP 被 E-Hentai 的搜索侧限制，**cookie 救不了**（cookie 与出口 IP 是两回事）。
     因此这条源改成「网关优先、直连兜底」：
       · 网关 /api/ehentai/search 带完整请求头（+ 可选 --ehentai-cookie）去打搜索；
         真有结果就是真结果；为 0 条时网关会**如实**说明原因，并退到实测可用的
         /torrents.php?search=<词> 兜底（同样给得出 gid+token，可直接在线阅读），
         条目标注 via:'torrents' / searchZero:true，绝不冒充搜索结果。
       · 网关不在时退回原来的浏览器直连（现状：基本必然 0 条，但保留这条路）。
     ====================================================================== */
  const EH_CAT = {
    doujinshi: 'doujinshi', manga: 'comic', 'artist cg': 'cg', 'game cg': 'cg',
    western: 'western', 'non-h': 'doujinshi', 'image set': 'artbook',
    cosplay: 'cosplay', 'asian porn': 'hanman'
  };

  /** 除主词以外的筛选条件（精确标签语法）—— ehTerms 与「整串当标题」那一路共用 */
  function ehFilters(f) {
    f = f || {};
    const terms = [];
    if (f.artist) terms.push('artist:"' + f.artist + '"$');
    (f.tags || []).forEach(t => terms.push('"' + t + '"$'));
    (f.excludeTags || []).forEach(t => terms.push('-"' + t + '"$'));
    (f.langs || []).forEach(l => {
      const m = HS.LANG_ALIAS[l];
      if (m && m.eh) terms.push('language:' + m.eh + '$');
    });
    if (f.gore === 'only') terms.push('"guro"$');
    if (f.gore === 'exclude') terms.push('-"guro"$');
    if (f.ai === 'only') terms.push('"ai-generated"$');
    if (f.ai === 'exclude') terms.push('-"ai-generated"$');
    return terms;
  }

  /** 关键词/标签 → E-Hentai 的检索语法（网关与直连两条路共用同一口径） */
  function ehTerms(ctx) {
    const q = ctx.q, f = ctx.f || {};
    const terms = [];
    const intent = ctx.intent || u.classifyQuery(q);
    /* 意图分流：IP / 角色 与 体裁 / 题材 → 走 E-Hentai 的精确标签语法 "…"$ */
    if (q) {
      if (intent.kind === 'character') terms.push('"' + q + '"$');
      else if (intent.kind === 'genre' && intent.genre) terms.push('"' + intent.genre.key + '"$');
      else terms.push(q);
    }
    return terms.concat(ehFilters(f));
  }

  /** 「整串当标题」口径的 E-Hentai 串：原词**不加**精确标签语法（= 全文检索）+ 其余筛选 */
  function ehTitleTerms(raw, f) {
    const s = String(raw == null ? '' : raw).trim();
    return s ? [s].concat(ehFilters(f)).join(' ') : '';
  }

  async function ehentaiSearch(ctx) {
    const f = ctx.f || {}, limit = ctx.limit;
    const terms = ehTerms(ctx);
    if (!terms.length) throw new Error('E-Hentai 需要至少一个关键词或标签');
    const query = terms.join(' ');
    const page = Math.max(1, ctx.page || 1);

    /* ---- 路线 1（优先）：本地网关代取 ----
       网关有出口代理 + 完整请求头，也是唯一能给出「搜索为什么是空的」和
       /torrents.php 兜底的那条路（浏览器直连连这两个都做不到） */
    let gwErr = null, gwAnswered = false, gwZero = false, gwNote = '';
    if (gwReady()) {
      try {
        const res = await HS.net.gateway.get('/api/ehentai/search',
          { q: ctx.q || '', terms: query, page: page, limit: limit }, 60000);
        if (res && res.ok === false) throw new Error(res.error || '网关返回失败');
        gwAnswered = true;
        gwZero = !!res.searchZero;
        gwNote = String(res.note || '');
        let items = gwItems(res, 'ehentai', 'E-Hentai',
          res.via === 'torrents' ? 'E-Hentai 种子检索兜底' : 'E-Hentai（经网关）').slice(0, limit);
        /* 残余词：再补一路「整串当标题」（**全文检索**，与上面精确标签语法 `"…"$` 那路并集）。
           只走网关这路（原本就是唯一能用的路）；与旧串重复 ⇒ 一次都不多发
           —— 旧串那一批一条不截，补检索最多再补 limit 条 */
        const lane = ehTitleTerms(laneOf(ctx, ctx.intent || u.classifyQuery(ctx.q)), f);
        items = await addTitleLane(items, v => HS.net.gateway.get('/api/ehentai/search',
          { q: lane, terms: v, page: page, limit: limit }, 60000).then(r2 => {
            if (r2 && r2.ok === false) return [];
            return gwItems(r2, 'ehentai', 'E-Hentai', 'E-Hentai（经网关）· 整串当标题');
          }), lane, [query], limit);
        if (items.length) return items;
      } catch (e) { gwErr = e; gwAnswered = false; }
    }

    /* ---- 路线 2（兜底）：浏览器直连 / 公共 CORS 代理 ----
       现状：本机出口下这条必然是 0 条（见上面的取证记录），但无网关的用户仍需要它 */
    let directErr = null, directAnswered = false;
    try {
      const url = 'https://e-hentai.org/?f_search=' + encodeURIComponent(query) +
        '&f_apply=Apply+Filter' + (page > 1 ? '&page=' + (page - 1) : '');
      const html = await HS.net.fetchSource(url, { allowProxy: true, proxyFirst: true });
      directAnswered = true;
      if (/temporarily banned|Your IP address has been/i.test(html)) throw new Error('E-Hentai 拒绝了当前出口 IP');
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const rows = u.$$('#gdt tr, table.itg tr', doc).filter(tr => u.$('a[href*="/g/"]', tr));
      if (rows.length) return rows.slice(0, limit).map(tr => ehRowItem(tr, f));

      /* 直连答了但 0 条：跟网关一样如实报「搜索侧是空集」 */
      gwZero = /No hits found/i.test(html) || gwZero;
    } catch (e) { directErr = e; }

    if (gwZero || (gwAnswered && directAnswered === false)) {
      throw new Error(gwNote || ('E-Hentai 的搜索接口在当前出口 IP 下返回空集'
        + '（实测：本机出口用浏览器打开同一个搜索 URL 也是 No hits found；'
        + '首页 /popular /torrents.php 正常）。换一个非机房的出口 IP 后重启网关即可恢复。'));
    }
    if (gwAnswered || directAnswered) return [];
    throw new Error('E-Hentai 两条路都没通（直连：' + ((directErr && directErr.message) || directErr) +
      '；网关' + (gwErr ? '失败：' + ((gwErr && gwErr.message) || gwErr) : '未启用') + '）');
  }

  /** 直连路线：搜索结果表的一行 → 卡片（原逻辑原样保留） */
  function ehRowItem(tr, f) {
    const a = u.$('a[href*="/g/"]', tr);
    const img = u.$('img', tr);
    const glink = u.$('.glink', tr);
    const title = (glink ? glink.textContent : (img ? img.getAttribute('alt') : '')) || '';
    const tagEls = u.$$('.gt, .gtl, .gtw', tr);
    const tags = tagEls.map(e => e.textContent.trim()).filter(Boolean);
    const cnEl = u.$('.cn', tr);
    const catText = (cnEl ? cnEl.textContent : '').trim().toLowerCase();
    const pagesM = String(tr.textContent || '').match(/(\d+)\s*pages?/i);
    const ratingM = String(tr.textContent || '').match(/(\d+(?:\.\d+)?)\s*\/\s*5/);
    const cover = img ? (img.getAttribute('data-src') || img.getAttribute('src') || '') : '';
    const langs = tags.filter(t => /^(chinese|english|japanese|korean|spanish|french|german|russian|translated|rewrite|speechless)$/i.test(t));
    const cats = EH_CAT[catText] ? [EH_CAT[catText]] : [];
    const href = a.getAttribute('href') || '';
    /* E-Hentai 的在线阅读需要 gid **和 token**：纯 gid 反查不到 token（实测 /g/{gid}/ → 404、
       gdata 接口要 key、高级搜索表单也没有 gid 字段），所以这里把 token 一起编进 id。 */
    const idm = href.match(/\/g\/(\d+)\/([0-9a-f]+)/);
    return mk({
      source: 'ehentai', sourceName: 'E-Hentai',
      id: idm ? (idm[1] + '-' + idm[2]) : href,
      title, url: href, cover,
      artist: (f && f.artist) || '',
      pages: pagesM ? parseInt(pagesM[1], 10) : null,
      langs, lang: langs[0] || '', cats,
      tags: tags.concat(catText ? [catText] : []).concat(ratingM ? ['★' + ratingM[1]] : [])
    });
  }

  /* ======================================================================
     0. 本地网关通道（tools/gateway.js）
     禁漫 / 哔咔 / 拷贝漫画 的官方 API 都要求「自定义请求头 + 签名」，响应还常常
     是 AES 加密的 —— 浏览器受同源策略限制根本发不出去（这正是 jasmine、venera
     这类项目全部做成原生客户端的原因：它们用 Rust/原生 socket 直连）。
     随附的零依赖 Node 网关把签名、解密、取页面放到本机，浏览器只跟 127.0.0.1 说话。
     ====================================================================== */
  const gwReady = () => !!(HS.net.gateway && HS.net.gateway.ok);
  S.gwReady = gwReady;
  const GW_HINT = '（运行 node tools/gateway.js，然后打开 http://127.0.0.1:' +
    (HS.net.gateway ? HS.net.gateway.DEFAULT_PORT : 8788) + '/ 即可解锁）';

  /** 网关返回的条目 → 统一卡片模型 */
  function gwItems(res, source, sourceName, fallbackNote) {
    return ((res && res.items) || []).map(r => mk({
      source, sourceName,
      id: r.id, title: r.title, url: r.url, cover: r.cover,
      artist: r.artist || '', pages: r.pages || null,
      cats: r.cats || [],
      tags: (r.tags || []).concat(r.cats || []),
      adult: r.adult,
      nsfw: true, note: r.note || fallbackNote || ''
    }));
  }

  function gwTerms(ctx, srcId) {
    const f = ctx.f || {};
    const intent = ctx.intent || u.classifyQuery(ctx.q);
    /* 网关这几个源只有关键词检索：
       IP / 角色用规范系列名命中率更高；题材保留原词（中文站对中文标签更友好） */
    let base = ctx.q;
    if (intent.kind === 'character' && intent.series) base = intent.series;
    return [base].concat(f.artist ? [f.artist] : []).filter(Boolean).join(' ').trim();
  }

  /**
   * 多关键词时的网关系候选串阶梯（单关键词 → []，调用方走上面的旧串）。
   * 各段按源的语言口径取词（jm / 拷贝漫画 = zh：中日文段发中文词；
   * porn-comic = en：体裁用英文键名），空格连接 —— 画师筛选每一级都带着。
   */
  function gwLadder(ctx, srcId) {
    const f = ctx.f || {};
    const intent = ctx.intent || u.classifyQuery(ctx.q);
    const words = multiWords(intent, langFor(srcId));
    if (!words.length) return [];
    const sfx = f.artist ? String(f.artist).trim() : '';
    const join = ws => (ws.join(' ') + (sfx ? ' ' + sfx : '')).trim();
    return termLadder(words, join, gwTerms(ctx, srcId));
  }

  /** 暴露给验证用：网关系的候选串（与 S.nhQueryFor 同款；单关键词时 variants 为空） */
  S.gwQueryFor = function (ctx, srcId) {
    const c = ctx || {};
    const id = srcId || 'jmcomic';
    const ladder = gwLadder(c, id);
    return { q: ladder.length ? ladder[0] : gwTerms(c, id), variants: ladder };
  };

  /** 禁漫官方 APP API（经网关签名 + AES-ECB 解密） */
  async function jmViaGateway(ctx) {
    const f = ctx.f || {};
    const terms = gwTerms(ctx, 'jmcomic');
    if (!terms) throw new Error('禁漫天堂需要关键词或画师');
    const order = f.order === 'popular' ? 'mv' : (f.order === 'latest' ? 'mr' : 'mr');
    const page = Math.max(1, ctx.page || 1);
    const ladder = gwLadder(ctx, 'jmcomic');
    const run = v => HS.net.gateway.get('/api/jm/search', {
      q: v, page: page, o: order,
      hosts: String(HS.settings.jmMirrors || ''),
      web: S.jmDomains()[0] || '18comic.vip'
    }, 35000).then(res => {
      const items = gwItems(res, 'jmcomic', '禁漫天堂', '官方 APP API');
      if (!items.length) throw emptyErr('禁漫官方 API 返回 0 条');
      return items;
    });
    const items = (ladder.length ? await tryVariants(ladder, run, needKeep(ctx.limit)) : await run(terms)).slice(0, ctx.limit);
    /* 残余词：再补一路「整串当标题」（q=<整串> + 画师）。与旧串重复 ⇒ 一次都不多发；
       旧串那一批一条不截，补检索最多再补 ctx.limit 条 */
    const lane = gwTitleTerms(laneOf(ctx, ctx.intent || u.classifyQuery(ctx.q)), f);
    return addTitleLane(items, run, lane, [terms], ctx.limit);
  }

  /* ======================================================================
     编号直达（禁漫）—— 用户直接甩一个作品编号（`1474541` / `jm1474541`）时，
     不再把它当关键词丢进全文检索，而是**按编号把那一本取回来**，并在结果里置顶。

     ★取数路径（都是网关**已有**的路由，没有新增任何路由）★
       · POST/search 类：`/api/jm/search?q=<编号>` —— 禁漫官方 APP API 的全文检索。
         实测**编号不被当关键词命中**（q=1474541 → total=1 但 items=[]），所以它只当一条
         「顺手看有没有更全的元数据」的旁路，命中就以它的条目为准（title/artist/tags/pages 更全）。
       · 主力是 `/api/reader?source=jmcomic&id=<编号>` —— 它本来就是阅读器取数用的，
         内部走 APP API 的 `/chapter?id=<编号>`（返回这一本的 `name` = 标题 + 页文件名列表），
         再取章节页模板拿 scramble_id。实测 1474541 能拿到标题与整本页数，
         所以「按编号取单本」是**真取到**了，不是伪造的卡片：
         标题、页数、源 id 全部来自网关返回；封面按官方图床 id 形态
         `<cdn>/media/albums/<编号>_3x4.jpg` 拼（jm 的 id 就是 aid，与页图同目录）。
       · 拿不到就抛错 → 调用方**照原逻辑**搜关键词（如实降级，不伪造）。
     ====================================================================== */
  /** 纯编号输入：`1474541` / `jm1474541` / 前后空格（作者名里的 jm 前缀可省） */
  const JM_DIRECT_RE = /^\s*(?:jm)?(\d{4,})\s*$/i;
  S.jmDirectId = q => {
    const m = String(q == null ? '' : q).match(JM_DIRECT_RE);
    return m ? m[1] : '';
  };
  /** 只有「勾选了禁漫」才启用（settings.sources 就是勾选表；未勾选完全走原逻辑） */
  S.jmDirectEnabled = () => (HS.settings.sources || []).indexOf('jmcomic') >= 0;

  /** 这一条是不是「编号直达」取回来的（results.js 靠它强制置顶 + 标 jm<编号>） */
  S.isJmDirectHit = it => !!(it && it.jmDirect);

  /** 按编号取单本；取不到抛错（→ 上层照原逻辑搜） */
  async function jmDirectItem(ctx) {
    const q = ctx.q;
    const id = S.jmDirectId(q);
    if (!id) throw new Error('不是纯编号输入');
    if (!S.jmDirectEnabled()) throw new Error('没有勾选禁漫天堂');
    if (!gwReady()) throw new Error('编号直达需要本地网关' + GW_HINT);

    const web = S.jmDomains()[0] || '18comic.vip';
    const readerUrl = HS.net.gateway.url('/api/reader', { source: 'jmcomic', id: id });
    /* 两条路并行：search 是旁路（实测编号打不中，打中了就用它的元数据），
       reader 是主力（APP API 的 /chapter?id= 能按编号取到这一本） */
    const [sr, rr] = await Promise.all([
      gwDirectSearch(ctx, id).catch(() => null),
      hsGetJson(readerUrl, 45000).catch(() => null)
    ]);

    let item = ((sr && sr.items) || []).find(x => String(x.id) === String(id)) || null;
    let pages = (item && item.pages) || null;
    let title = (item && item.title) || '';
    /* reader 那一趟顺手补页数：search 旁路即使命中，页面数也常常是 null，别把 23P 丢了 */
    if (item && !pages && rr && rr.ok !== false && (rr.pages || []).length) pages = rr.pages.length;
    if (!item) {
      const rd = (rr && rr.ok !== false) ? rr : null;
      const list = (rd && rd.pages) || [];
      if (!list.length) {
        throw new Error('禁漫按编号没取到这一本（' + id + ' 的详情接口没有返回页）');
      }
      pages = list.length;
      title = String(rd.title || '').replace(/\s+/g, ' ').trim() || ('禁漫 #' + id);
      item = {
        id: id, title: title,
        cover: jmCoverFor(id),
        url: 'https://' + web + '/album/' + id,
        artist: '', tags: [], pages: pages,
        note: '编号直达 · 网关按编号取单本（' + id + '）'
      };
    }
    const it = mk({
      source: 'jmcomic', sourceName: '禁漫天堂',
      id: String(id), title: title, url: item.url, cover: item.cover,
      artist: item.artist || '', pages: pages, tags: item.tags || [],
      nsfw: true, note: item.note || '编号直达 · 禁漫'
    });
    /* 标记：置顶分区 + 卡片右上角 `jm<编号>` 都认这一个字段 */
    it.jmDirect = 1;
    it.jmDirectId = String(id);
    it.jmBadge = 'jm' + id;
    return it;
  }

  /** 网关取 JSON（相对地址也吃；reader 那两条路都用它） */
  async function hsGetJson(url, ms) {
    const r = await HS.net.fetch(url, { credentials: 'omit' }, ms || 30000);
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { const j = await r.json(); if (j && (j.error || j.message)) msg = j.error || j.message; } catch (e) {}
      throw new Error(msg);
    }
    return r.json();
  }

  /** 旁路：把编号丢给全文检索（实测通常打不中，打中就用它更全的元数据） */
  async function gwDirectSearch(ctx, id) {
    const f = (ctx && ctx.f) || {};
    const order = f.order === 'popular' ? 'mv' : 'mr';
    return HS.net.gateway.get('/api/jm/search', {
      q: id, page: 1, o: order,
      hosts: String(HS.settings.jmMirrors || ''),
      web: S.jmDomains()[0] || '18comic.vip'
    }, 25000);
  }

  /** 官方图床的作品封面地址形态（jm 的 id 就是 aid，与页图同目录）。
      `/api/ping` 不带图床域名，所以固定用网关自己的兜底图床（与网关 JM_IMG_FALLBACK 一致）。 */
  const JM_COVER_CDN = 'https://cdn-msp.jmapinodeudzn.net';
  function jmCoverFor(id) {
    return JM_COVER_CDN + '/media/albums/' + id + '_3x4.jpg';
  }

  /** 拷贝漫画官方 API（经网关 HMAC 签名） */
  async function copymangaSearch(ctx) {
    const terms = gwTerms(ctx, 'copymanga');
    if (!gwReady()) throw new Error('拷贝漫画需要本地网关来签名' + GW_HINT);
    if (!terms) throw new Error('拷贝漫画需要关键词或画师');
    const page = Math.max(1, ctx.page || 1);
    const gwLimit = u.clamp(ctx.limit * 2, 20, 60);
    const ladder = gwLadder(ctx, 'copymanga');
    const run = v => HS.net.gateway.get('/api/copymanga/search', {
      q: v, page: page, limit: gwLimit
    }, 35000).then(res => {
      const items = gwItems(res, 'copymanga', '拷贝漫画', '官方 API');
      if (!items.length) throw emptyErr('拷贝漫画返回 0 条');
      return items;
    });
    const items = (ladder.length ? await tryVariants(ladder, run, needKeep(ctx.limit)) : await run(terms)).slice(0, ctx.limit);
    /* 残余词：再补一路「整串当标题」（q=<整串>）。与旧串重复 ⇒ 一次都不多发；
       旧串那一批一条不截，补检索最多再补 ctx.limit 条 */
    const lane = gwTitleTerms(laneOf(ctx, ctx.intent || u.classifyQuery(ctx.q)), ctx.f || {});
    return addTitleLane(items, run, lane, [terms], ctx.limit);
  }

  /** Pixiv（www.pixiv.net）官方搜索接口：经网关取；R-18 需要用户自己的登录 cookie */
  async function pixivSearch(ctx) {
    if (!gwReady()) throw new Error('Pixiv 需要本地网关代取（i.pximg.net 有防盗链）' + GW_HINT);
    /* 网关进程如果是加这个接口之前启动的，/api/ping 里不会列出 pixiv —— 直接给可执行提示，
       否则用户只会看到 404 不知道要重启 */
    const gws = (HS.net.gateway.info && HS.net.gateway.info.sources) || [];
    if (gws.length && gws.indexOf('pixiv') < 0) {
      throw new Error('当前网关是旧进程（/api/ping 里没有 pixiv），重启一次即可：node tools/gateway.js');
    }
    /* 意图分流：题材用词表键名，IP / 角色用规范系列名，其余用原词 */
    const intent = ctx.intent || u.classifyQuery(ctx.q);
    let terms = ctx.q;
    if (intent.kind === 'genre' && intent.genre) {
      /* Pixiv 标签以日文为主：同义概念用日文写法（脚 → 足），其余体裁仍用词表键名 */
      terms = intent.concept ? (intent.concept.ja || ctx.q) : intent.genre.key;
    }
    else if (intent.kind === 'character') terms = intent.series || ctx.q;
    terms = String(terms || '').trim();
    if (!terms) throw new Error('Pixiv 需要关键词');
    const page = Math.max(1, ctx.page || 1);
    const mode = String(HS.settings.pixivMode || 'all') === 'r18' ? 'r18' : 'all';
    const cookie = String(HS.settings.pixivCookie || '').trim();
    const run = v => HS.net.gateway.get('/api/pixiv/search', {
      q: v, page: page, mode: mode, cookie: cookie
    }, 35000).then(res => {
      const got = gwItems(res, 'pixiv', 'Pixiv', '官方搜索');
      if (!got.length) throw new Error('Pixiv 返回 0 条');
      return got;
    });
    const items = (await run(terms)).slice(0, ctx.limit);
    /* 残余词：再补一路「整串当标题」（Pixiv 的 q= 就是按整串检索标签 / 作品名）。
       与旧串重复 ⇒ 一次都不多发；旧串那一批一条不截，补检索最多再补 ctx.limit 条 */
    const lane = laneOf(ctx, intent);
    return addTitleLane(items, run, lane, [terms], ctx.limit);
  }

  /** porn-comic.com：纯 HTML 站，全站前置 Cloudflare 人机验证；网关现在会用本机
      Chrome 跑完验证再取页面（首次约 5–8 秒，同一 URL 5 分钟内走缓存） */
  async function porncomicSearch(ctx) {
    const terms = gwTerms(ctx, 'porncomic');
    if (!gwReady()) throw new Error('porn-comic 需要本地网关代取' + GW_HINT);
    const f = ctx.f || {};
    const page = Math.max(1, ctx.page || 1);
    const extra = (f.tags || [])[0] || '';
    const ladder = gwLadder(ctx, 'porncomic');
    const run = v => HS.net.gateway.get('/api/porncomic/search', {
      q: v, page: page, extra: extra
    }, 60000).then(res => {
      const items = gwItems(res, 'porncomic', 'porn-comic', 'HTML');
      if (!items.length) throw emptyErr('porn-comic 返回 0 条');
      return items;
    });
    const items = (ladder.length ? await tryVariants(ladder, run, needKeep(ctx.limit)) : await run(terms)).slice(0, ctx.limit);
    /* 残余词：再补一路「整串当标题」（q=<整串>）。与旧串重复 ⇒ 一次都不多发；
       旧串那一批一条不截，补检索最多再补 ctx.limit 条 */
    const lane = gwTitleTerms(laneOf(ctx, ctx.intent || u.classifyQuery(ctx.q)), f);
    return addTitleLane(items, run, lane, [terms], ctx.limit);
  }

  /* ======================================================================
     4. 禁漫天堂（JMComic / 18comic）
        优先走官方 APP API（经本地网关）；没有网关时退化为各镜像的 HTML 检索
     ====================================================================== */
  const JM_DOMAINS = ['18comic.vip', '18comic.org', 'jmcomic.me', 'jmcomic1.me', 'jm-comic3.art', 'jm-comic.club'];
  /* 作品类型 -> 站内分类路径 */
  const JM_CAT = { doujinshi: 'doujin', oneshot: 'short', comic: 'single', hanman: 'hanman', western: 'meiman' };

  /** 域名池：内置 + 用户自定义（设置里逗号分隔） */
  function domainPool(builtin, settingKey) {
    const extra = String(HS.settings[settingKey] || '')
      .split(/[\s,;，、]+/).map(s => s.trim()
        .replace(/^https?:\/\//i, '').replace(/\/+$/, '')).filter(Boolean);
    return u.uniq(builtin.concat(extra));
  }
  S.domainPool = domainPool;
  S.jmDomains = () => domainPool(JM_DOMAINS, 'jmMirrors');

  /** 并行竞速：任一成功即返回；全败时给出聚合后的原因 */
  async function raceFetch(urls, opts) {
    const errs = [];
    const tasks = urls.map(async item => {
      const url = typeof item === 'string' ? item : item.url;
      try {
        const body = await HS.net.fetchSource(url, opts);
        if (typeof body !== 'string' || body.length < 300) throw new Error('返回内容过短');
        return { body, item };
      } catch (e) {
        errs.push(((typeof item === 'object' && item.label) || url) + '：' + ((e && e.message) || e));
        throw e;
      }
    });
    try {
      return await Promise.any(tasks);
    } catch (agg) {
      const e = new Error(errs.slice(0, 3).join('；') || '全部候选均失败');
      e.all = errs;
      throw e;
    }
  }

  async function jmFetch(path) {
    const urls = S.jmDomains().map(d => ({ url: 'https://' + d + path, label: d }));
    const got = await raceFetch(urls, { allowProxy: true, proxyFirst: true, ms: 9000, budget: 15000 });
    let domain = '';
    try { domain = new URL(got.item.url).host; } catch (e) {}
    return { html: got.body, domain };
  }

  function jmParse(html, domain, limit) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = [], seen = {};
    const absUrl = href => {
      if (!href) return '';
      if (/^https?:/i.test(href)) return href;
      return 'https://' + domain + (href.charAt(0) === '/' ? href : '/' + href);
    };
    const pickImg = node => {
      if (!node || !node.querySelector) return '';
      const img = node.querySelector('img');
      if (!img) return '';
      const cand = img.getAttribute('data-original') || img.getAttribute('data-src') ||
        img.getAttribute('src') || '';
      return /^data:/i.test(cand) ? '' : cand;
    };

    /* 方案 A：标准 .video-title 结构（RSSHub 同款选择器） */
    u.$$('.video-title', doc).forEach(t => {
      const holder = t.previousElementSibling || t.parentElement;
      const a = t.querySelector('a[href*="/album/"]') ||
        (holder && holder.querySelector ? holder.querySelector('a[href*="/album/"]') : null);
      if (!a) return;
      const href = a.getAttribute('href');
      const id = (href.match(/\/album\/(\d+)/) || [])[1] || href;
      if (seen[id]) return; seen[id] = 1;
      const box = holder || t.parentElement;
      out.push(mk({
        source: 'jmcomic', sourceName: '禁漫天堂',
        id, title: t.textContent.trim() || a.getAttribute('title') || '',
        url: absUrl(href), cover: pickImg(box), tags: [], nsfw: true
      }));
    });

    /* 方案 B：兜底，直接扫所有相册链接 */
    if (out.length < 3) {
      u.$$('a[href*="/album/"]', doc).forEach(a => {
        const href = a.getAttribute('href') || '';
        const id = (href.match(/\/album\/(\d+)/) || [])[1];
        if (!id || seen[id]) return;
        let box = a, img = '';
        for (let i = 0; i < 4 && box && !img; i++) { img = pickImg(box); box = box.parentElement; }
        const im = a.querySelector('img');
        const title = (a.textContent || '').trim() || (a.getAttribute('title') || '') ||
          (im ? (im.getAttribute('alt') || '') : '');
        if (!title) return;
        seen[id] = 1;
        out.push(mk({
          source: 'jmcomic', sourceName: '禁漫天堂',
          id, title, url: absUrl(href), cover: img, tags: [], nsfw: true
        }));
      });
    }
    return out.slice(0, limit);
  }

  async function jmcomicSearch(ctx) {
    const q = ctx.q, f = ctx.f, limit = ctx.limit;
    const catPath = (f.cats || []).map(c => JM_CAT[c]).find(Boolean) || '';
    const screen = q || f.artist || '';
    if (!screen && !catPath) throw new Error('禁漫天堂需要关键词或已选作品类型');

    /* 编号直达：输入就是一串编号（`1474541` / `jm1474541`）且勾选了禁漫时，
       **先去按编号把那一本取回来**（results.js 会把它强制排在第一位）。
       取不到就抛错 → 落到下面的原逻辑（如实降级，不伪造条目）。 */
    if (S.jmDirectId(q) && S.jmDirectEnabled()) {
      const hit = await jmDirectItem(ctx);
      if (hit) return [hit];
    }

    /* 首选：本地网关 → 官方 APP API（实时域名 + 签名 + 解密，最可靠） */
    let gwErr = null;
    if (gwReady() && screen) {
      try { return await jmViaGateway(ctx); } catch (e) { gwErr = e; }
    }

    /* 兜底：镜像站 HTML */
    const order = f.order === 'popular' ? 'mv' : 'mr';
    const page = Math.max(1, ctx.page || 1);
    const path = '/albums' + (catPath ? '/' + catPath : '') +
      '?screen=' + encodeURIComponent(screen).replace(/%20/g, '+') + '&o=' + order +
      (page > 1 ? '&page=' + page : '');
    let html = '', domain = '';
    try {
      const got = await jmFetch(path);
      html = got.html; domain = got.domain;
    } catch (e) {
      throw new Error('禁漫天堂抓取失败：' + e.message + (gwReady() ? '' : '；' + GW_HINT));
    }
    const items = jmParse(html, domain, limit);
    if (!items.length) {
      throw new Error('禁漫天堂返回 0 条（镜像可能已被更换域名，或被反爬/人机验证拦截；' +
        '可在「筛选 → 镜像域名」中追加可用域名' + (gwReady() ? '' : '，或' + GW_HINT) + '）');
    }
    return items;
  }

  /* ======================================================================
     5. 紳士漫畫（wnacg）—— HTML，分类索引 + 关键词检索
     ====================================================================== */
  const WN_BASE = 'https://www.wnacg.com';
  /* 域名取自社区现役实现（ComicSparks/wax、venera-configs/wnacg.js）：这类站点靠换域名续命 */
  const WN_DOMAINS = [
    'www.wn03.ru', 'www.wn04.ru', 'www.wnacg01.cc', 'www.wnacg02.cc', 'www.wnacg03.cc',
    'www.wnacg05.cc', 'wnacg.com', 'wnacg.ru', 'www.wnacg.com', 'www.wnacg.date'
  ];
  S.wnacgDomains = () => domainPool(WN_DOMAINS, 'wnacgMirrors');
  const WN_CATE = {
    doujinshi: '5', comic: '6', oneshot: '7', hanman: '19', western: '17',
    artbook: '2', cg: '2', cosplay: '3', '3d': '22'
  };
  const WN_CATE_LABEL = {
    1: 'doujinshi', 2: 'artbook', 3: 'cosplay', 5: 'doujinshi', 6: 'comic',
    7: 'oneshot', 9: 'comic', 10: 'oneshot', 12: 'doujinshi', 13: 'comic',
    14: 'oneshot', 16: 'doujinshi', 17: 'comic', 18: 'oneshot', 19: 'hanman',
    20: 'hanman', 21: 'hanman', 22: '3d'
  };

  function wnParse(html, strip) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const out = [], seen = {};
    const abs = href => {
      if (!href) return '';
      if (/^https?:/i.test(href)) return href;
      if (href.indexOf('//') === 0) return 'https:' + href;      // 协议相对（紳士的图床就是这种）
      return WN_BASE + (href.charAt(0) === '/' ? href : '/' + href);
    };
    const pick = node => {
      if (!node || !node.querySelector) return '';
      const img = node.querySelector('img');
      if (!img) return '';
      const c = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('src') || '';
      if (/^data:/i.test(c)) return '';
      return abs(c);
    };
    const push = (node, a) => {
      const href = a.getAttribute('href') || '';
      const id = (href.match(/aid-(\d+)/) || [])[1] || href;
      if (!id || seen[id]) return;
      const title = (a.getAttribute('title') || a.textContent || '').trim();
      if (!title) return;
      seen[id] = 1;
      out.push(mk({
        source: 'wnacg', sourceName: '紳士漫畫',
        id, title, url: abs(href), cover: pick(node),
        tags: strip ? [strip] : [], nsfw: true
      }));
    };

    u.$$('.gallary_item', doc).forEach(node => {
      const a = node.querySelector('a[href*="photos-index-aid-"]') || node.querySelector('a[href]');
      if (a) push(node, a);
    });

    if (!out.length) {
      u.$$('a[href*="photos-index-aid-"]', doc).forEach(a => {
        let box = a, img = '';
        for (let i = 0; i < 3 && box && !img; i++) { img = pick(box); box = box.parentElement; }
        const href = a.getAttribute('href') || '';
        const id = (href.match(/aid-(\d+)/) || [])[1];
        if (!id || seen[id]) return;
        const title = (a.getAttribute('title') || a.textContent || '').trim();
        if (!title) return;
        seen[id] = 1;
        out.push(mk({
          source: 'wnacg', sourceName: '紳士漫畫',
          id, title, url: abs(href), cover: img,
          tags: strip ? [strip] : [], nsfw: true
        }));
      });
    }
    return out;
  }

  /** 一级候选串 → 该级的合并结果（原候选路径循环原样搬进来，只把「串」变成参数） */
  async function wnRound(str, catId, wp, limit) {
    const candidates = [];
    if (str) {
      /* venera/wax 现役写法：/search/?q=&f=_all&s=create_time_DESC&syn=yes&p= */
      candidates.push('/search/?q=' + encodeURIComponent(str) + '&f=_all&s=create_time_DESC&syn=yes' +
        (wp > 1 ? '&p=' + wp : ''));
      candidates.push('/search/?q=' + encodeURIComponent(str) + '&m=0' + (wp > 1 ? '&p=' + wp : ''));
      if (wp === 1) candidates.push('/albums-index-tag-' + encodeURIComponent(str) + '.html');
    }
    if (catId) {
      candidates.push('/albums-index-cate-' + catId + '.html');
      if (wp > 1) candidates.push('/albums-index-page-' + wp + '-cate-' + catId + '.html');
    }
    if (!candidates.length) candidates.push('/albums.html');

    const merged = [], seen = {};
    const errs = [];
    const domains = S.wnacgDomains();
    for (const path of candidates) {
      const urls = domains.map(d => ({ url: 'https://' + d + path, label: d }));
      try {
        const got = await raceFetch(urls, { allowProxy: true, proxyFirst: true, ms: 7000, budget: 10000 });
        const strip = WN_CATE_LABEL[catId] || '';
        wnParse(got.body, strip).forEach(it => {
          if (seen[it.key]) return; seen[it.key] = 1; merged.push(it);
        });
        if (merged.length >= Math.max(3, Math.ceil(limit / 2))) break;
      } catch (e) { errs.push(e.message); }
    }
    if (!merged.length) {
      const e = new Error('紳士漫畫未返回结果（' + (errs[0] || '所有域名与路径均失败') +
        '；若域名已更换，可在「筛选 → 镜像域名」中追加）');
      /* 有候选路径**正常返回了页面**、只是 0 条 → 标 soft，允许多关键词梯级放宽再试；
         整条路（所有候选路径）都是抓取失败 → 硬失败，原样抛出（不多发请求）。 */
      if (errs.length < candidates.length) e.soft = 1;
      throw e;
    }
    return merged;
  }

  async function wnacgSearch(ctx) {
    const q = ctx.q, f = ctx.f, limit = ctx.limit;
    const catId = (f.cats || []).map(c => WN_CATE[c]).find(Boolean) || '';
    const wp = Math.max(1, ctx.page || 1);
    const intent = ctx.intent || u.classifyQuery(q);
    /* 多关键词：全段 → 去掉尾段 → 旧串（单关键词 → []，路径与旧版逐字节相同）。
       紳士的关键词检索是「全词匹配」：实测 `明日方舟 能天使 后入` 三条路径全 0 条
       （今天就是报错），去掉尾段 `后入` → 24 条。 */
    const words = q ? multiWords(intent, langFor('wnacg')) : [];
    const ladder = words.length >= 2 ? termLadder(words, ws => ws.join(' '), q) : [];

    const out = [], seen = {};
    const list = ladder.length ? ladder : [q];
    /* 收手阈值沿用本轮内部的「够了」口径（Math.max(3, ceil(limit/2))）：
       一级就拿到今天那么多条就停，不多发一次上游请求。 */
    const need = Math.max(3, Math.ceil(limit / 2));
    /* 原循环一字未改，只是把「原样抛出」接住，好在它**正常返回 / soft 失败**之后再补一路
       「整串当标题」；硬失败（抓取全失败）时下面不会补，错误对象与请求数都原样不变。 */
    let legacyErr = null;
    try {
      for (let i = 0; i < list.length; i++) {
        let got = [];
        try { got = await wnRound(list[i], catId, wp, limit); }
        catch (e) {
          /* 只有「这一级 0 条」（soft）才放宽；抓取失败 / 最后一级 → 原样抛出 */
          if (i === list.length - 1 || !(e && e.soft)) throw e;
          continue;
        }
        for (let j = 0; j < got.length; j++) {
          const it = got[j];
          if (it.key && seen[it.key]) continue;
          if (it.key) seen[it.key] = 1;
          out.push(it);
        }
        if (out.length >= need) break;
      }
    } catch (e) { legacyErr = e; }
    /* 残余词：再补一路「整串当标题」（/search/?q=<整串>）。每页最多多 1 次 wnRound：
       原有路径正常返回 → 并集；原有路径 soft 失败（这一级全词匹配 0 条）→ 当作放宽的下一级；
       硬失败 → 不上这一路（错误原样抛出）。与旧串重复 ⇒ 一次都不多发 */
    const lane = (legacyErr && !legacyErr.soft) ? '' : laneOf(ctx, intent);
    let extra = [];
    if (lane && list.indexOf(lane) < 0) {
      extra = await addTitleLane([], s => wnRound(s, catId, wp, limit), lane);
    }
    if (!out.length && !extra.length) {
      if (legacyErr) throw legacyErr;      /* 硬失败 / soft 失败都原样抛出（错误对象不变） */
      throw new Error('紳士漫畫未返回结果（所有域名与路径均失败' +
        '；若域名已更换，可在「筛选 → 镜像域名」中追加）');
    }
    /* 旧串那一批按原口径截到 limit；「整串当标题」那一路只加不减（最多再补 limit 条） */
    const merged = out.slice(0, limit);
    const taken = {};
    merged.forEach(it => { if (it.key) taken[it.key] = 1; });
    let added = 0;
    for (let i = 0; i < extra.length && added < limit; i++) {
      const it = extra[i];
      if (it.key && taken[it.key]) continue;
      if (it.key) taken[it.key] = 1;
      added++;
      merged.push(it);
    }
    return merged;
  }

  /* ======================================================================
     6. Hitomi —— HTML 解析（实验性；需代理 + 通常需 VPN）
     ====================================================================== */
  /** Hitomi 单次检索（原逻辑原样搬进来，只把「检索词」变成参数） */
  async function hitomiRound(term, limit) {
    const url = 'https://hitomi.la/search.html?query=' + encodeURIComponent(term);
    const html = await HS.net.fetchSource(url, { allowProxy: true, proxyFirst: true });
    const doc = new DOMParser().parseFromString(html, 'text/html');

    let nodes = u.$$('div.gallery-content', doc);
    if (!nodes.length) {
      const seen = {};
      u.$$('a[href]', doc).forEach(a => {
        const href = a.getAttribute('href') || '';
        const m = href.match(/^\/(galleries|doujinshi|manga|cg|imageset)\/([^/]+?)\.html$/);
        if (m && !seen[m[2]]) { seen[m[2]] = 1; nodes.push(a); }
      });
    }
    if (!nodes.length) return [];

    return nodes.slice(0, limit).map(node => {
      const a = node.tagName === 'A' ? node : (u.$('h1 a', node) || u.$('a[href]', node));
      if (!a) return null;
      let href = a.getAttribute('href') || '';
      const img = u.$('img', node);
      const title = (a.textContent || (img && img.getAttribute('alt')) || '').replace(/\s+/g, ' ').trim();
      if (!title) return null;
      if (href && href.charAt(0) === '/') href = 'https://hitomi.la' + href;
      const tags = u.$$('span', node).map(s => s.textContent.trim()).filter(t => t && t.length < 28);
      let cover = img ? (img.getAttribute('data-src') || img.getAttribute('src') || '') : '';
      if (cover.indexOf('//') === 0) cover = 'https:' + cover;
      const idm = href.match(/\/([^/]+)\.html/);
      return mk({
        source: 'hitomi', sourceName: 'Hitomi',
        id: idm ? idm[1] : href,
        title, url: href, cover,
        nsfw: true, tags: tags.slice(0, 10)
      });
    }).filter(Boolean);
  }

  async function hitomiSearch(ctx) {
    const q = ctx.q, f = ctx.f, limit = ctx.limit;
    let term = '';
    if (f.artist) term = 'artist:' + f.artist;
    else if (q) term = q.replace(/\s+/g, '-');
    else if ((f.langs || []).length) {
      const m = HS.LANG_ALIAS[f.langs[0]];
      term = 'language:' + (m && m.eh ? m.eh : f.langs[0]);
    }
    if (!term) throw new Error('Hitomi 需要关键词或画师');

    const items = await hitomiRound(term, limit);
    /* 残余词：再补一路「整串当标题」（query=<整串>，不换成概念写法）。
       画师检索时这一路不参与；与旧串重复 ⇒ 一次都不多发 */
    const lane = f.artist ? '' : laneOf(ctx, ctx.intent || u.classifyQuery(q)).replace(/\s+/g, '-');
    return addTitleLane(items, s => hitomiRound(s, limit), lane, [term], limit);
  }

  /* ======================================================================
     7. Danbooru —— 图片板 API（画师 / 标签检索强项；匿名限 2 个标签）
     ====================================================================== */
  /**
   * 多关键词时的 Danbooru 候选标签串（单关键词 → []，调用方走旧串）。
   * 每段一个**下划线化**标签、空格连接＝AND；匿名账号**最多 2 个标签**（超过会被
   * 直接判 400），所以只取前 2 段（去重后不足 2 个就回旧串）→ 末级＝旧串。
   */
  function danLadder(q, intent) {
    const words = multiWords(intent, 'en', 2);
    if (!words.length) return [];
    const tag = w => String(w).trim().replace(/\s+/g, '_');
    const out = [words.map(tag).join(' ')];
    const legacy = String(q).trim().replace(/\s+/g, '_');
    if (out.indexOf(legacy) < 0) out.push(legacy);
    return out.slice(0, MULTI_MAX_TRIES);
  }

  /** 暴露给验证用：Danbooru 的候选标签串（单关键词时 variants 为空） */
  S.danQueryFor = function (ctx) {
    const c = ctx || {};
    const q = String(c.q == null ? '' : c.q);
    const intent = c.intent || u.classifyQuery(q);
    const ladder = danLadder(q, intent);
    return {
      tags: ladder.length ? ladder[0] : String(q).trim().replace(/\s+/g, '_'),
      variants: ladder
    };
  };

  /** Danbooru 单次取数（原逻辑原样搬进来，只把「标签串」变成参数） */
  async function danFetch(tagStr, ctx, limit) {
    const url = 'https://danbooru.donmai.us/posts.json?limit=' + u.clamp(limit, 1, 50) +
      '&tags=' + encodeURIComponent(tagStr) +
      ((ctx.page || 1) > 1 ? '&page=' + ctx.page : '');
    const data = await HS.net.fetchSource(url, { json: true, allowProxy: true });
    if (!Array.isArray(data)) throw new Error((data && data.message) || 'Danbooru 返回异常');

    return data.map(p => {
      const artist = String(p.tag_string_artist || '').replace(/_/g, ' ');
      const ch = String(p.tag_string_character || '').replace(/_/g, ' ');
      const cp = String(p.tag_string_copyright || '').replace(/_/g, ' ');
      const gen = String(p.tag_string_general || '').split(' ').filter(Boolean);
      const cover = p.preview_file_url || p.large_file_url || p.file_url || '';
      if (!cover) return null;
      return mk({
        source: 'danbooru', sourceName: 'Danbooru',
        id: p.id,
        title: (artist ? artist + ' · ' : '') + (ch || cp || ('post ' + p.id)),
        url: 'https://danbooru.donmai.us/posts/' + p.id,
        cover, artist, pages: null,
        /* Danbooru 自带分级：g / s / q / e —— q、e 算成人向，g、s 明确排除 */
        adult: p.rating === 'e' || p.rating === 'q',
        tags: u.uniq([ch, cp].filter(Boolean).concat(gen.slice(0, 10)))
      });
    }).filter(Boolean);
  }

  async function danbooruSearch(ctx) {
    const q = ctx.q, f = ctx.f, limit = ctx.limit;
    const tags = [];
    const intent = ctx.intent || u.classifyQuery(q);
    if (f.artist) tags.push(String(f.artist).trim().replace(/\s+/g, '_'));
    if (f.tags && f.tags.length) tags.push(String(f.tags[0]).trim().replace(/\s+/g, '_'));
    /* Danbooru 是标签板：体裁用题材标签名；作品名 / 角色名直接落到 copyright / character 标签上 */
    let ladder = [];
    if (!tags.length && q) {
      ladder = danLadder(q, intent);           /* 多关键词：逐段下划线化、多标签 AND */
      if (!ladder.length) {                    /* 旧口径：整串当一个标签 */
        const term = (intent.kind === 'genre' && intent.genre) ? intent.genre.key : String(q).trim();
        tags.push(term.replace(/\s+/g, '_'));
      }
    }
    if (!tags.length && !ladder.length) throw new Error('Danbooru 需要关键词、画师或标签');

    const run = v => danFetch(v, ctx, limit);
    const items = ladder.length
      ? await tryVariants(ladder, run, needKeep(limit))
      : await run(tags.slice(0, 2).join(' '));
    /* 残余词：再补一路「整串当标题」（Danbooru 的 `tags=` 就是整串下划线化）。
       画师 / 标签筛选时这一路不参与（那种查询的主词本来就不走 q）；重复串一次都不多发 */
    const lane = (f.artist || (f.tags && f.tags.length)) ? '' : laneOf(ctx, intent).replace(/\s+/g, '_');
    return addTitleLane(items, run, lane, ladder.concat(tags), limit);
  }

  /* ======================================================================
     10. 自定义中文源 —— 域名轮换的通用解法
     这类站点（禁漫 / 紳士 / 喵紳士 / …）域名经常更换，任何硬编码列表都会过期。
     因此提供「模板 + 自定义域名」：用户随时可以自己加一个能访问的镜像。
     模板结构取自 git 社区维护中的实现（aidoku-zh-sources / RSSHub）。
     ====================================================================== */
  /* 通用工具：从 style="background-image: url(...)" 里取出图片地址 */
  function bgUrl(node) {
    if (!node) return '';
    const st = node.getAttribute('style') || '';
    const m = st.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
    return m ? m[1].trim() : '';
  }

  /* 喵绅士模板：/search?keyword=xxx → .mh-item */
  function parseMhItem(html, base, src) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const abs = href => (!href ? '' : (/^https?:/i.test(href) ? href : base + (href.charAt(0) === '/' ? href : '/' + href)));
    const out = [];
    u.$$('.mh-item', doc).forEach(node => {
      const a = node.querySelector('a[href]');
      if (!a) return;
      const href = a.getAttribute('href') || '';
      const id = href.split('/').filter(Boolean).pop() || href;
      const title = (u.$('.mh-item-detali h2 a', node) || a).textContent.replace(/\s+/g, ' ').trim();
      if (!title) return;
      let cover = bgUrl(u.$('a > p', node) || u.$('p', node));
      if (cover.indexOf('//') === 0) cover = 'https:' + cover;
      const tags = u.$$('.mh-item-detali .mh-tag, .mh-item-detali .tag', node).map(e => e.textContent.trim()).filter(Boolean);
      out.push(mk({
        source: src.id, sourceName: src.name, id,
        title, url: abs(href), cover, tags, nsfw: true
      }));
    });
    return out;
  }

  /* 通用列表模板：扫描任何“作品链接”，尽量配对图片与标题 */
  function parseGeneric(html, base, src) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const abs = href => (!href ? '' : (/^https?:/i.test(href) ? href : base + (href.charAt(0) === '/' ? href : '/' + href)));
    const out = [], seen = {};
    const PAT = /(photos-index-aid-\d+|\/album\/\d+|\/comic\/[^/?#]+|\/book\/[^/?#]+|\/galleries\/[^/?#]+|\/g\/\d+)/i;
    u.$$('a[href]', doc).forEach(a => {
      const href = a.getAttribute('href') || '';
      if (!PAT.test(href)) return;
      const key = href.replace(/[?#].*$/, '');
      if (seen[key]) return;
      let box = a, cover = '';
      for (let i = 0; i < 3 && box && !cover; i++) {
        const img = box.querySelector && box.querySelector('img');
        if (img) {
          const c = img.getAttribute('data-original') || img.getAttribute('data-src') || img.getAttribute('src') || '';
          if (!/^data:/i.test(c)) cover = c;
        }
        if (!cover) cover = bgUrl(box);
        box = box.parentElement;
      }
      const im = a.querySelector('img');
      const title = (a.getAttribute('title') || a.textContent || (im && im.getAttribute('alt')) || '')
        .replace(/\s+/g, ' ').trim();
      if (!title) return;
      seen[key] = 1;
      out.push(mk({
        source: src.id, sourceName: src.name,
        id: key, title, url: abs(href), cover, tags: [], nsfw: true
      }));
    });
    return out;
  }

  const CUSTOM_TPL = {
    mxshm: {
      label: '喵绅士模板 (/search?keyword=)',
      build: (base, q) => base + '/search?keyword=' + encodeURIComponent(q),
      parse: parseMhItem
    },
    wnacg: {
      label: '紳士模板 (/search/?q=)',
      build: (base, q) => base + '/search/?q=' + encodeURIComponent(q) + '&m=0',
      parse: (html, base, src) => wnParse(html, '').map(it => (it.source = src.id, it.sourceName = src.name, it))
    },
    jm: {
      label: '禁漫模板 (/albums?screen=)',
      build: (base, q) => base + '/albums?screen=' + encodeURIComponent(q).replace(/%20/g, '+'),
      parse: (html, base, src) => jmParse(html, base.replace(/^https?:\/\//, ''), 40)
        .map(it => (it.source = src.id, it.sourceName = src.name, it))
    },
    generic: {
      label: '通用模板（自动识别作品链接）',
      build: (base, q) => base + '/search/?q=' + encodeURIComponent(q),
      parse: parseGeneric
    }
  };
  S.CUSTOM_TPL = CUSTOM_TPL;

  S.customList = function () {
    return (HS.settings.customSources || []).filter(c => c && c.domain && c.enabled !== false);
  };

  function customAdapter(cfg) {
    const tpl = CUSTOM_TPL[cfg.template] || CUSTOM_TPL.generic;
    const base = (/^https?:/i.test(cfg.domain) ? cfg.domain : 'https://' + cfg.domain).replace(/\/+$/, '');
    return {
      id: 'custom:' + cfg.domain,
      name: cfg.name || cfg.domain,
      homepage: base,
      desc: '自定义源（' + tpl.label + '）· 域名可随时更换',
      flags: ['自定义', '需代理'],
      proxy: true, vpn: true, weight: 1.0, custom: true,
      search: async ctx => {
        const q = ctx.q || ctx.f.artist || '';
        if (!q) throw new Error('自定义源需要关键词');
        const url = tpl.build(base, q, 1);
        const html = await HS.net.fetchSource(url, { allowProxy: true, proxyFirst: true, ms: 9000, budget: 15000 });
        const items = tpl.parse(html, base, { id: 'custom:' + cfg.domain, name: cfg.name || cfg.domain }) || [];
        if (!items.length) {
          throw new Error('自定义源返回 0 条（模板可能不匹配该站点结构，或该域名已被更换）');
        }
        /* 残余词：再补一路「整串当标题」（同一个模板，只是发用户原词）。
           与旧串重复 ⇒ 一次都不多发；旧串那一批一条不截，补检索最多再补 ctx.limit 条；失败只吞掉 */
        const lane = laneOf(ctx, ctx.intent);
        return addTitleLane(items.slice(0, ctx.limit), async s => {
          const h2 = await HS.net.fetchSource(tpl.build(base, s, 1),
            { allowProxy: true, proxyFirst: true, ms: 9000, budget: 15000 });
          return tpl.parse(h2, base, { id: 'custom:' + cfg.domain, name: cfg.name || cfg.domain }) || [];
        }, lane, [q], ctx.limit);
      }
    };
  }

  /* ======================================================================
     源注册表
     ====================================================================== */
  const REG = [
    {
      id: 'mangadex', name: 'MangaDex', homepage: 'https://mangadex.org',
      desc: '官方公开 API · 可直连 · 元数据最全（固定请求成人分级内容）',
      flags: ['直连', '无需代理'], proxy: false, vpn: false, weight: 1.0,
      search: mangadexSearch
    },
    {
      id: 'jmcomic', name: '禁漫天堂', homepage: 'https://18comic.vip',
      desc: '中文同人志主力站 · 有本地网关时走官方 APP API（实时域名 + 签名 + AES 解密），否则退化为 HTML 镜像',
      flags: ['中文', '官方 API'], proxy: true, vpn: true, weight: 1.25,
      search: jmcomicSearch
    },
    {
      id: 'copymanga', name: '拷贝漫画', homepage: 'https://www.copy20.com',
      desc: '中文正版向站点 · 官方 API 需要 HMAC 签名，经本地网关检索（api.copy2000.online 等节点自动发现）',
      /* weight 被 results.js 消费两处：① relevance() 里 weight*10 当相关度底分（排序）；
         ② R.combine 跨源去重时挑「谁的版本当主体」（weight 高者替换）。
         它是综合向站点，和成人向检索的相关性最弱 → 权重压到全表最低（0.5）。
         ★光靠 weight 只能「分数低」，保证不了「一定排最后」→ 另有 last:true，
         results.js 的 applyView() 会把标了 last 的源稳定分区到所有其它源之后。 */
      flags: ['中文', '需本地网关'], proxy: false, vpn: false, weight: 0.5, last: true,
      search: copymangaSearch
    },
    {
      id: 'porncomic', name: 'porn-comic', homepage: 'https://porn-comic.com',
      desc: '欧美 3D / 同人漫画 HTML 站 · 搜索入口常被 Cloudflare 人机验证挡住（网关不能执行 JS），能过验证的出口才可用',
      flags: ['实验性', '需本地网关', '常被 CF 挡'], proxy: true, vpn: true, weight: 0.85,
      search: porncomicSearch
    },
    {
      id: 'pixiv', name: 'Pixiv', homepage: 'https://www.pixiv.net',
      desc: '官方插画 / 漫画搜索 · 经本地网关检索（封面由网关带 Referer 代理，绕开 i.pximg.net 防盗链）· R-18 需在设置里填自己的 PHPSESSID',
      flags: ['插画向', '需本地网关', 'R-18 需登录'], proxy: false, vpn: true, weight: 0.62,
      search: pixivSearch
    },
    {
      id: 'wnacg', name: '紳士漫畫', homepage: 'https://www.wnacg.com',
      desc: '繁體中文站 · HTML 解析 · 分类索引 + 标签检索 · 需代理',
      flags: ['中文', '需代理'], proxy: true, vpn: true, weight: 1.15,
      search: wnacgSearch
    },
    {
      id: 'nhentai', name: 'nhentai', homepage: 'https://nhentai.net',
      desc: '非官方 JSON API（优先经本地网关代取；无网关时回退直连 / 公共 CORS 代理，成功率低）· 单章作品，可直接在线阅读',
      flags: ['需本地网关', '直连常被墙'], proxy: true, vpn: true, weight: 1.1,
      search: nhentaiSearch
    },
    {
      id: 'ehentai', name: 'E-Hentai', homepage: 'https://e-hentai.org',
      desc: 'HTML 解析 · 需代理 · 标签体系最完善。实测本机出口 IP 下搜索侧一律返回空集（浏览器同 URL 也是 ' +
        'No hits found，与 UA/请求头/cookie 无关）；有本地网关时会如实说明原因，并退到可用的 /torrents.php ' +
        '种子检索兜底（条目带 gid+token，但其中被原站删除的图集会提示读不了 — 实测确实有这种）',
      flags: ['需代理', '搜索受限', '需本地网关'], proxy: true, vpn: true, weight: 1.05,
      search: ehentaiSearch
    },
    {
      id: 'danbooru', name: 'Danbooru', homepage: 'https://danbooru.donmai.us',
      desc: '图片板 · 画师与角色标签检索强项 · 匿名限 2 标签',
      flags: ['画师向', '限 2 标签'], proxy: true, vpn: false, weight: 0.9,
      search: danbooruSearch
    },
    {
      id: 'hitomi', name: 'Hitomi', homepage: 'https://hitomi.la',
      desc: 'HTML 解析（实验性）· 仅支持单词/标签检索',
      flags: ['需代理', '实验性'], proxy: true, vpn: true, weight: 0.95,
      off: true, search: hitomiSearch
    },
  ];

  REG.forEach(s => { S.list.push(s); S.byId[s.id] = s; });
  S.REG = REG;

  S.customAdapters = () => S.customList().map(customAdapter);

  S.enabled = function () {
    const on = HS.settings.sources || [];
    const builtin = REG.filter(s => on.indexOf(s.id) >= 0);
    /* 自定义源只要配置了就参与（它们的 id 动态生成，无法预置在 sources 列表里） */
    const custom = S.customAdapters();
    const list = builtin.concat(custom);
    return list.length ? list : [];
  };

  /** 供 UI 展示：内置源 + 自定义源 */
  S.allForUI = function () {
    return REG.filter(s => !s.off || s.id === 'hitomi').concat(S.customAdapters());
  };

  /* ---------------- 并行聚合器 ---------------- */
  /* 全局上限：慢源不再拖着整个搜索不放，到点就把还没回来的源标记为超时 */
  S.RUN_CAP_MS = 22000;

  /**
   * 动态分配「每个源取多少条」：
   *   auto  ：目标总数 ÷ 启用源数（源少就每个源多要，源多就平均分），下限 6、上限 60
   *   fixed ：用设置里的固定值
   * 这样只开一两个源时也能一次拿到几十条，而不是每源 12 条凑不满一页。
   */
  S.plan = function (nSources) {
    const target = u.clamp(parseInt(HS.settings.targetTotal, 10) || 60, 20, 200);
    const fixed = u.clamp(parseInt(HS.settings.perSource, 10) || 12, 4, 100);
    const auto = HS.settings.perSourceMode !== 'fixed';
    const n = Math.max(1, nSources || 1);
    const limit = auto ? u.clamp(Math.ceil(target / n) + (n <= 2 ? 6 : 0), 6, 60) : fixed;
    return { limit, target, auto, sources: n };
  };

  /* ---------------- 跨语言同义词：按目标源的标签体系挑写法 ----------------
     dict.js 的 HS.CONCEPTS 里，同一个概念同时写着中 / 英 / 日（含罗马字）三种写法。
     搜「脚」和搜「foot」要能打到同一批作品 —— 但直接把原词丢过去没用：
     英文标签站里没有「脚」这个标签，中文站里也未必有 foot。
     所以按源挑：英文标签站给 en、Pixiv 给日文、中文站给中文。 */
  const TAG_LANG = {
    mangadex: 'en', nhentai: 'en', ehentai: 'en', danbooru: 'en', porncomic: 'en', hitomi: 'en',
    pixiv: 'ja',
    jm: 'zh', copymanga: 'zh', wnacg: 'zh'
  };

  /* ---------------- 保守化门槛：用户原词自己有中文写法时，不许被别的别名顶掉 ----------------
     判据（只读 dict.js 已有的两份数据，不新增任何词表）：
       ① HS.TAG_ZH[q] —— q 本身是字典里登记过的英文 / 罗马字标签，自带中文翻译；
       ② q 本身就是某个概念组的 zh 名。
     命中、且「概念组给这个源挑的中文规范词 ≠ 它自己的那个中文写法」时，发**它自己的**
     写法，而不是组的 c.zh。
     动机（2026-02 修）：组把两个不同概念凑成一组时（「人妻」曾被并进 milf 组），
     输入 A 会拿到 B 的规范词 —— 用户搜到的是另一批东西。这条门槛让「有自己的翻译的
     词」永远用自己的翻译，只有「纯别名（自己没有独立翻译）」才被组的规范词替换。
     ★只作用于 zh 槽位★：TAG_ZH 只登记中文，en / ja 槽位（nhentai / Danbooru / Pixiv…）
     的规范词本来就该由概念组的 en / ja 决定，拿中文去顶替只会把发往上游的串改坏
     —— 回归红线：中出 / 无修 / 巨乳 / 寝取 / 触手 / full color / 脚 在各槽位的串
     必须逐字节不变（其中 巨乳 / 无修 / 寝取 / 触手 / full color 根本走的是体裁表，
     压根到不了这里）。 */

  /* 概念组的 zh 名集合（惰性建一次；dict.js 是纯数据，建好后不再变） */
  let CONCEPT_ZH = null;
  function conceptZhSet() {
    if (CONCEPT_ZH) return CONCEPT_ZH;
    const set = {};
    (HS.CONCEPTS || []).forEach(c => {
      const z = String((c && c.zh) || '').toLowerCase().trim();
      if (z) set[z] = 1;
    });
    CONCEPT_ZH = set;
    return set;
  }

  /** 用户原词「自己的」中文写法（没有就返回空串）。只读 HS.TAG_ZH / HS.CONCEPTS。 */
  S.ownZh = function (q) {
    const low = String(q == null ? '' : q).toLowerCase().trim();
    if (!low) return '';
    const hit = (HS.TAG_ZH || {})[low];
    const v = String(hit == null ? '' : hit).trim();
    if (v) return v;
    return conceptZhSet()[low] ? low : '';
  };

  /** 给某个源挑该概念最合适的写法；不是同义概念查询就原样返回 */
  S.termFor = function (src, q, intent) {
    const c = intent && intent.concept;
    if (!c) return q;
    /* 取语种改走 langFor()（它带 SRC_LANG_ALIAS：表里的键是短名 jm，源 id 是 jmcomic）。
       未登记的源（自定义源）不进这一支 —— langFor() 对它们统一给 'en'，直接用会改掉既有行为。 */
    const lang = (TAG_LANG[src.id] || SRC_LANG_ALIAS[src.id]) ? langFor(src.id) : '';
    if (!lang) return q;                       // 自定义源等：不动用户原词
    const pick = lang === 'ja' ? (c.ja || c.en || c.zh)
      : lang === 'en' ? (c.en || c.zh)
        : (c.zh || c.en);
    /* 保守化门槛：只作用于 zh 槽位（见上方注释块） */
    if (lang === 'zh') {
      const own = S.ownZh(q);
      if (own && own !== pick) return own;
    }
    return pick || q;
  };

  S.run = function (opts) {
    const q = (opts.q || '').trim();
    const f = opts.filters || {};
    /* 查询意图只算一次，所有源共用同一套策略分流 */
    const intent = opts.intent || u.classifyQuery(q);
    S.lastIntent = intent;
    const list = S.enabled();
    const page = Math.max(1, parseInt(opts.page || 1, 10) || 1);
    const plan = S.plan(list.length);
    const limit = plan.limit;
    S.lastPlan = plan;
    const cap = opts.capMs === 0 ? 0 : u.clamp(parseInt(opts.capMs || S.RUN_CAP_MS, 10), 6000, 60000);
    const out = [];
    let stopped = false;

    const tasks = list.map(src => (async () => {
      const t0 = u.now();
      if (opts.onStart) opts.onStart(src);
      /* 同义概念按源换写法：q 与 ctx.q 一起换，适配器两种读法都拿到对的词 */
      const term = S.termFor(src, q, intent);
      const sctx = term === q ? opts : Object.assign({}, opts, { q: term });
      let res;
      try {
        const raw = await src.search({
          q: term, f, limit, page, plan, intent, ctx: sctx,
          /* 残余词那一路要用**用户原词**（term 可能已被按源换成了概念 / 体裁写法） */
          titleLane: q,
          /* 已知不返回 CORS 头的站点：直接走代理链，省掉注定失败的直连 */
          proxyFirst: src.proxy === true
        });
        const items = S.applyModes(raw || [], f);
        res = { src, ok: true, ms: u.now() - t0, items, rawCount: (raw || []).length };
      } catch (err) {
        res = { src, ok: false, ms: u.now() - t0, error: (err && err.message) || String(err) };
      }
      if (stopped) return null;                    // 已经收尾，迟到的结果丢弃
      out.push(res);
      if (opts.onDone) opts.onDone(src, res);
      return res;
    })());

    const all = Promise.all(tasks);
    if (!cap) return all.then(r => r.filter(Boolean));

    let timer = null;
    const capP = new Promise(res => { timer = setTimeout(() => res('__cap__'), cap); });
    return Promise.race([all, capP]).then(got => {
      if (got !== '__cap__') { clearTimeout(timer); return got.filter(Boolean); }
      stopped = true;
      list.forEach(src => {
        if (out.some(r => r.src === src)) return;
        const res = {
          src, ok: false, ms: cap,
          error: '超过 ' + u.fmtMs(cap) + ' 未返回，已跳过（该源当前不可达或过慢）'
        };
        out.push(res);
        if (opts.onDone) opts.onDone(src, res);
      });
      return out;
    });
  };

  /* ---------------- 标签词典（供自动补全） ---------------- */
  const TAG_CACHE_KEY = 'hs.tags.v1';
  const STATIC_TAGS = ('sole female,sole male,stockings,glasses,big breasts,school uniform,netorare,vanilla,' +
    'yuri,yaoi,incest,futanari,monster girl,elf,catgirl,cosplay,swimsuit,lingerie,cheating,guro,ryona,' +
    'ai-generated,full color,multi-work series,anthology,artbook,doujinshi,manga,oneshot,webtoon,' +
    'full censorship,uncensored,nakadashi,paizuri,defloration,exhibitionism,bondage,tsundere,' +
    'childhood friend,teacher,office lady,idol,fate,genshin impact,blue archive,hololive,touhou project,' +
    'original,kantai collection,idolmaster,umamusume').split(',').map(s => s.trim()).filter(Boolean);

  S.tags = STATIC_TAGS.slice();

  S.loadTags = async function () {
    try {
      const cached = JSON.parse(localStorage.getItem(TAG_CACHE_KEY) || 'null');
      if (cached && cached.ts && (Date.now() - cached.ts) < 7 * 864e5 && cached.tags && cached.tags.length) {
        S.tags = u.uniq(cached.tags.concat(STATIC_TAGS));
        HS.bus.emit('tags:ready', S.tags);
        return S.tags;
      }
    } catch (e) { /* ignore */ }

    try {
      const data = await HS.net.fetchSource('https://api.mangadex.org/manga/tag', { json: true });
      const names = [];
      (data.data || []).forEach(t => {
        const n = (t.attributes && t.attributes.name) || {};
        if (n.en) names.push(n.en);
      });
      if (names.length) {
        S.tags = u.uniq(names.concat(STATIC_TAGS)).sort();
        try { localStorage.setItem(TAG_CACHE_KEY, JSON.stringify({ ts: Date.now(), tags: names })); } catch (e) {}
      }
    } catch (e) { /* 使用静态词典 */ }
    HS.bus.emit('tags:ready', S.tags);
    return S.tags;
  };

})(window.HS);
