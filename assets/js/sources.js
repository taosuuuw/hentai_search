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

    const out = [], seen = {};
    data.forEach(it => { const r = mdParse(it); if (seen[r.key]) return; seen[r.key] = 1; out.push(r); });
    return out.slice(0, limit);
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
  function nhTerms(q, f, intent) {
    const terms = [];
    /* IP / 角色 → 规范系列名（与网关类源的 gwTerms 口径一致），体裁 / 题材 → 词表键名 */
    if (q) {
      if (intent.kind === 'character') terms.push(intent.series || q);
      else if (intent.kind === 'genre' && intent.genre) terms.push(intent.genre.key || q);
      else terms.push(q);
    }
    /* 以下都是「类型明确」的筛选条件，实测命名空间写法正常，保持原样 */
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
    return terms.join(' ');
  }

  /** 排序口径（v2 实测接受 sort=date / sort=popular） */
  function nhSort(f) {
    return f.order === 'latest' ? 'date' : (f.order === 'popular' ? 'popular' : '');
  }

  /** 暴露给验证用：返回「适配器实际会发给上游的串」，网关路径与直连兜底共用同一个 */
  S.nhQueryFor = function (ctx) {
    const c = ctx || {};
    const f = c.f || {};
    const q = String(c.q == null ? '' : c.q);
    return { q: nhTerms(q, f, c.intent || u.classifyQuery(q)), sort: nhSort(f) };
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

  async function nhentaiSearch(ctx) {
    const q = ctx.q, f = ctx.f, limit = ctx.limit;
    const intent = ctx.intent || u.classifyQuery(q);
    const query = nhTerms(q, f, intent);            /* 两条路共用同一个查询串（同口径） */
    if (!query) throw new Error('nhentai 需要至少一个关键词或标签');

    const page = Math.max(1, ctx.page || 1);            /* 「继续加载」靠它翻页 */
    const sort = nhSort(f);

    /* ---- 路线 1（优先）：本地网关代取 ----
       网关有出口代理 + 站点 Referer，是这台机器上唯一稳定的通路 */
    let gwErr = null, gwAnswered = false;
    if (gwReady()) {
      try {
        const res = await HS.net.gateway.get('/api/nhentai/search',
          { q: query, page: page, sort: sort }, 30000);
        if (res && res.ok === false) throw new Error(res.error || '网关返回失败');
        gwAnswered = true;
        const items = gwItems(res, 'nhentai', 'nhentai', 'nhentai（经网关）');
        if (items.length) return items.slice(0, limit);
      } catch (e) { gwErr = e; gwAnswered = false; }
    }

    /* ---- 路线 2（兜底）：浏览器直连 + 公共 CORS 代理 ----
       无网关的用户仍然走这条（本机实测成功率很低，但保留了这条路） */
    let directErr = null, directAnswered = false;
    try {
      let url = 'https://nhentai.net/api/v2/search?query=' + encodeURIComponent(query) + '&page=' + page;
      if (sort) url += '&sort=' + sort;
      const data = await HS.net.fetchSource(url, { json: true, allowProxy: true, proxyFirst: true });
      directAnswered = true;
      const rows = (data && data.result) || [];
      if (rows.length) return rows.slice(0, limit).map(nhParse);
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
        const items = gwItems(res, 'ehentai', 'E-Hentai',
          res.via === 'torrents' ? 'E-Hentai 种子检索兜底' : 'E-Hentai（经网关）');
        if (items.length) return items.slice(0, limit);
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

  function gwTerms(ctx) {
    const f = ctx.f || {};
    const intent = ctx.intent || u.classifyQuery(ctx.q);
    /* 网关这几个源只有关键词检索：
       IP / 角色用规范系列名命中率更高；题材保留原词（中文站对中文标签更友好） */
    let base = ctx.q;
    if (intent.kind === 'character' && intent.series) base = intent.series;
    return [base].concat(f.artist ? [f.artist] : []).filter(Boolean).join(' ').trim();
  }

  /** 禁漫官方 APP API（经网关签名 + AES-ECB 解密） */
  async function jmViaGateway(ctx) {
    const f = ctx.f || {};
    const terms = gwTerms(ctx);
    if (!terms) throw new Error('禁漫天堂需要关键词或画师');
    const order = f.order === 'popular' ? 'mv' : (f.order === 'latest' ? 'mr' : 'mr');
    const res = await HS.net.gateway.get('/api/jm/search', {
      q: terms, page: Math.max(1, ctx.page || 1), o: order,
      hosts: String(HS.settings.jmMirrors || ''),
      web: S.jmDomains()[0] || '18comic.vip'
    }, 35000);
    const items = gwItems(res, 'jmcomic', '禁漫天堂', '官方 APP API');
    if (!items.length) throw new Error('禁漫官方 API 返回 0 条');
    return items.slice(0, ctx.limit);
  }

  /** 拷贝漫画官方 API（经网关 HMAC 签名） */
  async function copymangaSearch(ctx) {
    const terms = gwTerms(ctx);
    if (!gwReady()) throw new Error('拷贝漫画需要本地网关来签名' + GW_HINT);
    if (!terms) throw new Error('拷贝漫画需要关键词或画师');
    const res = await HS.net.gateway.get('/api/copymanga/search', {
      q: terms, page: Math.max(1, ctx.page || 1), limit: u.clamp(ctx.limit * 2, 20, 60)
    }, 35000);
    const items = gwItems(res, 'copymanga', '拷贝漫画', '官方 API');
    if (!items.length) throw new Error('拷贝漫画返回 0 条');
    return items.slice(0, ctx.limit);
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
    const res = await HS.net.gateway.get('/api/pixiv/search', {
      q: terms,
      page: Math.max(1, ctx.page || 1),
      mode: String(HS.settings.pixivMode || 'all') === 'r18' ? 'r18' : 'all',
      cookie: String(HS.settings.pixivCookie || '').trim()
    }, 35000);
    const items = gwItems(res, 'pixiv', 'Pixiv', '官方搜索');
    if (!items.length) throw new Error('Pixiv 返回 0 条');
    return items.slice(0, ctx.limit);
  }

  /** porn-comic.com：纯 HTML 站，全站前置 Cloudflare 人机验证；网关现在会用本机
      Chrome 跑完验证再取页面（首次约 5–8 秒，同一 URL 5 分钟内走缓存） */
  async function porncomicSearch(ctx) {
    const terms = gwTerms(ctx);
    if (!gwReady()) throw new Error('porn-comic 需要本地网关代取' + GW_HINT);
    const f = ctx.f || {};
    const res = await HS.net.gateway.get('/api/porncomic/search', {
      q: terms, page: Math.max(1, ctx.page || 1), extra: (f.tags || [])[0] || ''
    }, 60000);
    const items = gwItems(res, 'porncomic', 'porn-comic', 'HTML');
    if (!items.length) throw new Error('porn-comic 返回 0 条');
    return items.slice(0, ctx.limit);
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

  async function wnacgSearch(ctx) {
    const q = ctx.q, f = ctx.f, limit = ctx.limit;
    const catId = (f.cats || []).map(c => WN_CATE[c]).find(Boolean) || '';
    const candidates = [];
    const wp = Math.max(1, ctx.page || 1);
    if (q) {
      /* venera/wax 现役写法：/search/?q=&f=_all&s=create_time_DESC&syn=yes&p= */
      candidates.push('/search/?q=' + encodeURIComponent(q) + '&f=_all&s=create_time_DESC&syn=yes' +
        (wp > 1 ? '&p=' + wp : ''));
      candidates.push('/search/?q=' + encodeURIComponent(q) + '&m=0' + (wp > 1 ? '&p=' + wp : ''));
      if (wp === 1) candidates.push('/albums-index-tag-' + encodeURIComponent(q) + '.html');
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
      throw new Error('紳士漫畫未返回结果（' + (errs[0] || '所有域名与路径均失败') +
        '；若域名已更换，可在「筛选 → 镜像域名」中追加）');
    }
    return merged.slice(0, limit);
  }

  /* ======================================================================
     6. Hitomi —— HTML 解析（实验性；需代理 + 通常需 VPN）
     ====================================================================== */
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

  /* ======================================================================
     7. Danbooru —— 图片板 API（画师 / 标签检索强项；匿名限 2 个标签）
     ====================================================================== */
  async function danbooruSearch(ctx) {
    const q = ctx.q, f = ctx.f, limit = ctx.limit;
    const tags = [];
    const intent = ctx.intent || u.classifyQuery(q);
    if (f.artist) tags.push(String(f.artist).trim().replace(/\s+/g, '_'));
    if (f.tags && f.tags.length) tags.push(String(f.tags[0]).trim().replace(/\s+/g, '_'));
    /* Danbooru 是标签板：体裁用题材标签名；作品名 / 角色名直接落到 copyright / character 标签上 */
    if (!tags.length && q) {
      const term = (intent.kind === 'genre' && intent.genre) ? intent.genre.key : String(q).trim();
      tags.push(term.replace(/\s+/g, '_'));
    }
    if (!tags.length) throw new Error('Danbooru 需要关键词、画师或标签');

    const url = 'https://danbooru.donmai.us/posts.json?limit=' + u.clamp(limit, 1, 50) +
      '&tags=' + encodeURIComponent(tags.slice(0, 2).join(' ')) +
      ((ctx.page || 1) > 1 ? '&page=' + ctx.page : '');
    const data = await HS.net.fetchSource(url, { json: true, allowProxy: true });
    if (!Array.isArray(data)) throw new Error((data && data.message) || 'Danbooru 返回异常');
    if (!data.length) return [];

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
        return items.slice(0, ctx.limit);
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

  /** 给某个源挑该概念最合适的写法；不是同义概念查询就原样返回 */
  S.termFor = function (src, q, intent) {
    const c = intent && intent.concept;
    if (!c) return q;
    const lang = TAG_LANG[src.id];
    if (!lang) return q;                       // 自定义源等：不动用户原词
    const pick = lang === 'ja' ? (c.ja || c.en || c.zh)
      : lang === 'en' ? (c.en || c.zh)
        : (c.zh || c.en);
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
