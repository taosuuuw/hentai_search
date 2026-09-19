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
    item.series = u.matchSeries(item.tags.join(' ') + ' ' + item.title + ' ' + item.artist);
    item.key = u.normTitle(item.title) || (o.source + ':' + item.id);
    if (!item.cover) item.cover = u.placeholder(item.title, item.source + item.id);
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
      tags: alt && alt !== title ? tags.concat([alt]) : tags
    });
  }

  async function mangadexSearch(ctx) {
    const q = ctx.q, f = ctx.f, limit = ctx.limit;
    const incIds = await mdResolveTags((f.tags || []).concat(
      (f.cats || []).map(c => MD_CAT[c]).filter(Boolean)));
    const exIds = await mdResolveTags(f.excludeTags);

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
      if (incIds.length > 1) p.set('includedTagsMode', 'AND');
      exIds.forEach(id => p.append('excludedTags[]', id));
      if (q) p.set('title', q);
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
          .forEach(id => urls.push(build({ authorOrArtist: id })));
      } catch (e) { /* 退化为标题检索 */ }
    }
    if (!urls.length) urls.push(build());

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
     2. nhentai —— 非官方 JSON API（需 CORS 代理；部分地区需 VPN）
     ====================================================================== */
  const NH_CAT = { doujinshi: 'doujinshi', comic: 'manga', oneshot: 'manga', cg: 'artistcg', artbook: 'imageset', cosplay: 'cosplay', western: 'western' };

  async function nhentaiSearch(ctx) {
    const q = ctx.q, f = ctx.f, limit = ctx.limit;
    const terms = [];
    if (q) terms.push(q);
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
    if (!terms.length) throw new Error('nhentai 需要至少一个关键词或标签');

    let url = 'https://nhentai.net/api/v2/search?query=' + encodeURIComponent(terms.join(' '));
    if (f.order === 'latest') url += '&sort=date';
    else if (f.order === 'popular') url += '&sort=popular';

    const data = await HS.net.fetchSource(url, { json: true, allowProxy: true, proxyFirst: true });
    const rows = (data && data.result) || [];
    if (!rows.length) return [];

    return rows.slice(0, limit).map(r => {
      const title = r.english_title || r.japanese_title || ('Gallery #' + r.id);
      const tagNames = r.tag_ids ? Object.keys(r.tag_ids).map(k => r.tag_ids[k]) : [];
      const langs = ['chinese', 'english', 'japanese', 'korean', 'spanish', 'french', 'german', 'russian']
        .filter(l => tagNames.some(t => String(t).toLowerCase() === l));
      const tl = tagNames.map(t => String(t).toLowerCase());
      const cats = [];
      if (tl.indexOf('imageset') >= 0) cats.push('artbook');
      if (tl.indexOf('cosplay') >= 0) cats.push('cosplay');
      return mk({
        source: 'nhentai', sourceName: 'nhentai',
        id: r.id,
        title: (r.japanese_title && r.english_title ? title + ' / ' + r.japanese_title : title),
        url: 'https://nhentai.net/g/' + r.id + '/',
        cover: r.thumbnail || (r.media_id ? 'https://t.nhentai.net/galleries/' + r.media_id + '/cover.jpg' : ''),
        pages: r.num_pages || null,
        langs, lang: langs[0] || '', cats,
        tags: tagNames.slice(0, 24)
      });
    });
  }

  /* ======================================================================
     3. E-Hentai —— HTML 解析（需代理；部分网络需 VPN）
     ====================================================================== */
  const EH_CAT = {
    doujinshi: 'doujinshi', manga: 'comic', 'artist cg': 'cg', 'game cg': 'cg',
    western: 'western', 'non-h': 'doujinshi', 'image set': 'artbook',
    cosplay: 'cosplay', 'asian porn': 'hanman'
  };

  async function ehentaiSearch(ctx) {
    const q = ctx.q, f = ctx.f, limit = ctx.limit;
    const terms = [];
    if (q) terms.push(q);
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
    if (!terms.length) throw new Error('E-Hentai 需要至少一个关键词或标签');

    const url = 'https://e-hentai.org/?f_search=' + encodeURIComponent(terms.join(' ')) + '&f_apply=Apply+Filter';
    const html = await HS.net.fetchSource(url, { allowProxy: true, proxyFirst: true });
    if (/temporarily banned|Your IP address has been/i.test(html)) throw new Error('E-Hentai 拒绝了当前出口 IP');

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const rows = u.$$('#gdt tr, table.itg tr', doc).filter(tr => u.$('a[href*="/g/"]', tr));
    if (!rows.length) return [];

    return rows.slice(0, limit).map(tr => {
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
      const idm = href.match(/\/g\/(\d+)\//);
      return mk({
        source: 'ehentai', sourceName: 'E-Hentai',
        id: idm ? idm[1] : href,
        title, url: href, cover,
        artist: f.artist || '',
        pages: pagesM ? parseInt(pagesM[1], 10) : null,
        langs, lang: langs[0] || '', cats,
        tags: tags.concat(catText ? [catText] : []).concat(ratingM ? ['★' + ratingM[1]] : [])
      });
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
      nsfw: true, note: r.note || fallbackNote || ''
    }));
  }

  function gwTerms(ctx) {
    const f = ctx.f || {};
    return [ctx.q].concat(f.artist ? [f.artist] : []).filter(Boolean).join(' ').trim();
  }

  /** 禁漫官方 APP API（经网关签名 + AES-ECB 解密） */
  async function jmViaGateway(ctx) {
    const f = ctx.f || {};
    const terms = gwTerms(ctx);
    if (!terms) throw new Error('禁漫天堂需要关键词或画师');
    const order = f.order === 'popular' ? 'mv' : (f.order === 'latest' ? 'mr' : 'mr');
    const res = await HS.net.gateway.get('/api/jm/search', {
      q: terms, page: 1, o: order,
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
    const res = await HS.net.gateway.get('/api/copymanga/search', { q: terms, page: 1, limit: 30 }, 35000);
    const items = gwItems(res, 'copymanga', '拷贝漫画', '官方 API');
    if (!items.length) throw new Error('拷贝漫画返回 0 条');
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
    const path = '/albums' + (catPath ? '/' + catPath : '') +
      '?screen=' + encodeURIComponent(screen).replace(/%20/g, '+') + '&o=' + order;
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
    const abs = href => (!href ? '' : (/^https?:/i.test(href) ? href : WN_BASE + (href.charAt(0) === '/' ? href : '/' + href)));
    const pick = node => {
      if (!node || !node.querySelector) return '';
      const img = node.querySelector('img');
      if (!img) return '';
      const c = img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('src') || '';
      return /^data:/i.test(c) ? '' : c;
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
    if (q) {
      /* venera/wax 现役写法：/search/?q=&f=_all&s=create_time_DESC&syn=yes&p= */
      candidates.push('/search/?q=' + encodeURIComponent(q) + '&f=_all&s=create_time_DESC&syn=yes');
      candidates.push('/search/?q=' + encodeURIComponent(q) + '&m=0');
      candidates.push('/albums-index-tag-' + encodeURIComponent(q) + '.html');
    }
    if (catId) candidates.push('/albums-index-cate-' + catId + '.html');
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
     7. 哔咔漫画（PicACG）
        官方 App API 需要 HMAC 签名 + 自定义请求头：浏览器直连会被 CORS 拒绝，
        公共 CORS 代理也不会转发这些请求头 → 必须经由服务端网关转发。
        这里对接 HibiAPI 风格的网关；网关地址在设置里填写（可自建）。
     ====================================================================== */
  function picacgFindList(node, depth) {
    depth = depth || 0;
    if (!node || depth > 6) return null;
    if (Array.isArray(node)) {
      const objs = node.filter(x => x && typeof x === 'object' && !Array.isArray(x));
      if (objs.length && objs.some(o => o.title || o.name) &&
        objs.some(o => o.thumb || o.cover || o.image || o.thumbnail)) return objs;
      for (const it of node) { const r = picacgFindList(it, depth + 1); if (r) return r; }
      return null;
    }
    if (typeof node === 'object') {
      for (const k of Object.keys(node)) { const r = picacgFindList(node[k], depth + 1); if (r) return r; }
    }
    return null;
  }

  async function picacgSearch(ctx) {
    const q = ctx.q, f = ctx.f, limit = ctx.limit;
    const terms = [q].concat(f.artist ? [f.artist] : []).filter(Boolean).join(' ');
    if (!terms) throw new Error('PicACG 需要关键词或画师');

    let gwErr = null;
    /* 首选：本地网关 → 官方 APP API（HMAC-SHA256 签名） */
    if (gwReady()) {
      try {
        const res = await HS.net.gateway.get('/api/picacg/search', { q: terms, page: 1, sort: 'dd' }, 35000);
        const items = gwItems(res, 'picacg', '哔咔漫画', '官方 APP API');
        if (items.length) return items.slice(0, limit);
      } catch (e) { gwErr = e; }
    }

    /* 次选：自建 HibiAPI 网关 */
    const base = String(HS.settings.picacgGateway || '').trim().replace(/\/+$/, '');
    if (!base) {
      if (gwErr) throw new Error('哔咔官方接口没有返回结果：' + gwErr.message);
      throw new Error('PicACG 需要服务端网关：启动随附的本地网关' + GW_HINT +
        '；或在 设置 → 搜索 → PicACG 网关 填写你自建的 HibiAPI 地址');
    }

    const url = base + '/api/picacg/search?keyword=' + encodeURIComponent(terms) + '&page=1';
    const data = await HS.net.fetchSource(url, { json: true, allowProxy: false });
    const rows = picacgFindList(data) || [];
    if (!rows.length) throw new Error('PicACG 网关返回结构无法识别或没有结果');

    return rows.slice(0, limit).map(r => {
      const cats = (r.categories || []).map(c => String(typeof c === 'string' ? c : (c && c.title) || ''));
      const catBlob = cats.join(' ').toLowerCase();
      const out = [];
      if (/同人|doujin/.test(catBlob)) out.push('doujinshi');
      if (/單本|单本|short|短篇/.test(catBlob)) out.push('oneshot');
      if (/長篇|长篇|连载/.test(catBlob)) out.push('serial');
      if (/韓漫|韩漫/.test(catBlob)) out.push('hanman');
      if (/美漫|western/.test(catBlob)) out.push('western');
      const thumb = r.thumb || r.thumbnail || {};
      const cover = (thumb.fileServer && thumb.path)
        ? (thumb.fileServer + '/static/' + thumb.path)
        : (typeof thumb === 'string' ? thumb : (r.cover || ''));
      return mk({
        source: 'picacg', sourceName: '哔咔漫画',
        id: r._id || r.id,
        title: r.title || r.name || '',
        url: 'https://www.picacomic.com/comic/' + (r._id || r.id),
        cover, artist: r.author || '', pages: r.pagesCount || null,
        cats: out, tags: cats.concat(r.tags || []), nsfw: true,
        note: '经网关返回'
      });
    });
  }

  /* ======================================================================
     8. Danbooru —— 图片板 API（画师 / 标签检索强项；匿名限 2 个标签）
     ====================================================================== */
  async function danbooruSearch(ctx) {
    const q = ctx.q, f = ctx.f, limit = ctx.limit;
    const tags = [];
    if (f.artist) tags.push(String(f.artist).trim().replace(/\s+/g, '_'));
    if (f.tags && f.tags.length) tags.push(String(f.tags[0]).trim().replace(/\s+/g, '_'));
    if (!tags.length && q) tags.push(String(q).trim().replace(/\s+/g, '_'));
    if (!tags.length) throw new Error('Danbooru 需要关键词、画师或标签');

    const url = 'https://danbooru.donmai.us/posts.json?limit=' + u.clamp(limit, 1, 50) +
      '&tags=' + encodeURIComponent(tags.slice(0, 2).join(' '));
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
        tags: u.uniq([ch, cp].filter(Boolean).concat(gen.slice(0, 10)))
      });
    }).filter(Boolean);
  }

  /* ======================================================================
     9. Demo —— 完全离线示例源（含同系列多本，便于演示堆叠展开）
     ====================================================================== */
  const DEMO_BASE = [
    { t: '[Karaage (Hiten)] Fate Quartet', a: 'Hiten', p: 26, tags: ['fate', 'saber', 'full color'], lang: 'zh' },
    { t: '[Cior (Ken-1)] Fate Night Collection', a: 'Cior', p: 34, tags: ['fate', 'rin tohsaka', 'full color'], lang: 'zh' },
    { t: '[Musou] Fate Gathering', a: 'Musou', p: 22, tags: ['fate', 'saber', 'netorare'], lang: 'ja' },
    { t: '[Homunculus (Cola)] Fate Grand Order Anthology', a: 'Cola', p: 128, tags: ['fate grand order', 'anthology', 'full color'], lang: 'en' },
    { t: '[Homunculus (Cola)] Blue Archive Compilation', a: 'Cola', p: 48, tags: ['blue archive', 'full color'], lang: 'en' },
    { t: '[Cior (Ken-1)] Blue Archive Fanbook', a: 'Cior', p: 40, tags: ['blue archive', 'full color'], lang: 'zh' },
    { t: '[みちきんぐ] Blue Archive Sensei Log', a: 'Michiking', p: 96, tags: ['blue archive', 'sole female'], lang: 'ja' },
    { t: '[大嘘] 足フェチレッスン', a: '大嘘', p: 34, tags: ['footjob', 'sole female'], lang: 'ja' },
    { t: '[Digital Lover (Nakajima Yuka)] 制服と放課後', a: 'Nakajima Yuka', p: 22, tags: ['school uniform', 'romance'], lang: 'zh' },
    { t: '[Ashiomi Masato] Office Hours', a: 'Ashiomi Masato', p: 18, tags: ['office lady', 'stockings'], lang: 'en' },
    { t: '[Cior (Ken-1)] Hololive Fanbook', a: 'Cior', p: 40, tags: ['hololive', 'full color'], lang: 'zh' },
    { t: '[朝凪] 純愛アンソロジー', a: '朝凪', p: 28, tags: ['netorare', 'sole female'], lang: 'ja' },
    { t: '[AI Art Lab] Genshin AI Collection', a: 'AI Art Lab', p: 64, tags: ['genshin impact', 'ai-generated', 'full color'], lang: 'zh' },
    { t: '[Guro Works] Dark Fantasy R18G', a: 'Guro Works', p: 44, tags: ['guro', 'ryona', 'dark'], lang: 'ja' }
  ];

  async function demoSearch(ctx) {
    const q = String(ctx.q || '').toLowerCase();
    const f = ctx.f || {};
    await u.sleep(180 + Math.random() * 260);
    let rows = DEMO_BASE.slice();
    if (q) {
      const hit = rows.filter(r => (r.t + ' ' + r.a + ' ' + r.tags.join(' ')).toLowerCase().indexOf(q) >= 0);
      rows = hit.length ? hit : rows.slice(0, 6);
    }
    if (f.langs && f.langs.length) {
      const hit = rows.filter(r => f.langs.indexOf(r.lang) >= 0);
      if (hit.length) rows = hit;
    }
    return rows.slice(0, ctx.limit).map((r, i) => mk({
      source: 'demo', sourceName: '示例数据',
      id: 'demo-' + i, title: r.t, url: '#demo',
      cover: u.placeholder(r.a, r.t + i),
      artist: r.a, pages: r.p,
      lang: r.lang, langs: [r.lang], nsfw: true,
      cats: r.tags.indexOf('anthology') >= 0 ? ['anthology'] : [],
      tags: r.tags,
      note: '离线示例条目，非真实结果'
    }));
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
      flags: ['中文', '需本地网关'], proxy: false, vpn: false, weight: 1.2,
      search: copymangaSearch
    },
    {
      id: 'wnacg', name: '紳士漫畫', homepage: 'https://www.wnacg.com',
      desc: '繁體中文站 · HTML 解析 · 分类索引 + 标签检索 · 需代理',
      flags: ['中文', '需代理'], proxy: true, vpn: true, weight: 1.15,
      search: wnacgSearch
    },
    {
      id: 'nhentai', name: 'nhentai', homepage: 'https://nhentai.net',
      desc: 'JSON API · 需 CORS 代理 · 部分地区需 VPN',
      flags: ['需代理', '可能需 VPN'], proxy: true, vpn: true, weight: 1.1,
      search: nhentaiSearch
    },
    {
      id: 'ehentai', name: 'E-Hentai', homepage: 'https://e-hentai.org',
      desc: 'HTML 解析 · 需代理 · 标签体系最完善',
      flags: ['需代理', '可能需 VPN'], proxy: true, vpn: true, weight: 1.05,
      search: ehentaiSearch
    },
    {
      id: 'danbooru', name: 'Danbooru', homepage: 'https://danbooru.donmai.us',
      desc: '图片板 · 画师与角色标签检索强项 · 匿名限 2 标签',
      flags: ['画师向', '限 2 标签'], proxy: true, vpn: false, weight: 0.9,
      search: danbooruSearch
    },
    {
      id: 'picacg', name: '哔咔漫画', homepage: 'https://www.picacomic.com',
      desc: '官方 App API：HMAC-SHA256 签名 + 需登录 token，经本地网关检索（网关可代登录）',
      flags: ['中文', '需本地网关'], proxy: false, vpn: false, weight: 1.2,
      off: true, search: picacgSearch
    },
    {
      id: 'hitomi', name: 'Hitomi', homepage: 'https://hitomi.la',
      desc: 'HTML 解析（实验性）· 仅支持单词/标签检索',
      flags: ['需代理', '实验性'], proxy: true, vpn: true, weight: 0.95,
      off: true, search: hitomiSearch
    },
    {
      id: 'demo', name: '示例数据', homepage: '#',
      desc: '完全离线的本地示例（含同系列多本），用于演示与断网兜底',
      flags: ['离线'], proxy: false, vpn: false, weight: 0.4,
      search: demoSearch
    }
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
    return list.length ? list : REG.filter(s => s.id === 'demo');
  };

  /** 供 UI 展示：内置源 + 自定义源 */
  S.allForUI = function () {
    return REG.filter(s => !s.off || s.id === 'picacg' || s.id === 'hitomi').concat(S.customAdapters());
  };

  /* ---------------- 并行聚合器 ---------------- */
  /* 全局上限：慢源不再拖着整个搜索不放，到点就把还没回来的源标记为超时 */
  S.RUN_CAP_MS = 22000;

  S.run = function (opts) {
    const q = (opts.q || '').trim();
    const f = opts.filters || {};
    const limit = u.clamp(parseInt(HS.settings.perSource, 10) || 12, 1, 40);
    const list = S.enabled();
    const cap = opts.capMs === 0 ? 0 : u.clamp(parseInt(opts.capMs || S.RUN_CAP_MS, 10), 6000, 60000);
    const out = [];
    let stopped = false;

    const tasks = list.map(src => (async () => {
      const t0 = u.now();
      if (opts.onStart) opts.onStart(src);
      let res;
      try {
        const raw = await src.search({
          q, f, limit, ctx: opts,
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
