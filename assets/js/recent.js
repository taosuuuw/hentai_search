/* ==========================================================================
   recent.js — 「最近浏览」：本机浏览足迹 / 顶栏入口 / 时间序列表 / 详细信息
   --------------------------------------------------------------------------
   设计口径（与 fav.js 同一套本机存储风格，互不干扰）：
     · 只在**用户真的进入某个作品**时记一笔：放大卡片（详细信息）与在线阅读。
       检索本身、翻页、改筛选都不记 —— 那些不是「浏览过的作品」。
     · 纯本机：localStorage 键 hs.recent.v1，不上传、不参与检索。
     · 时间倒序 = 存储顺序。同一条作品重复浏览只把时间戳往上顶，不产生重复行。
     · 容量双闸：条数上限 CAP，以及 MAX_AGE 天自动过期；localStorage 写失败时
       逐条丢弃最旧的记录再重试（配额满了不能把功能整个卡死）。
     · 整套读写包 try/catch：存储不可用时退化成「空列表 + 不写入」，界面照常能开。
   与其它模块的关系：
     · 读：HS.results.openCard（放大 / 详细信息）、HS.reader.open（在线阅读）。
       两个入口都用**包装**的方式挂钩，不改动它们各自的实现，也不改调用点。
     · 写：只写自己的 KEY；不动 hs.fav.v1 / hs.suggest.v1 / hs.settings.v2。
   ========================================================================== */
(function (HS) {
  'use strict';
  const u = HS.u;
  const R = HS.recent = {};

  const KEY = 'hs.recent.v1';
  const VER = 1;
  const CAP = 200;                    /* 最多保留多少条 */
  const MAX_AGE = 60 * 864e5;         /* 超过 60 天自动过期 */
  const TITLE_MAX = 240;
  const TAG_MAX = 12;

  let db = { v: VER, items: [] };     /* items 天然按 ts 倒序（见 add） */
  let index = {};                     /* key → rec */
  let modal = null, listEl = null, emptyEl = null, countEl = null;
  let opener = null;
  let storageOk = true;

  /* ---------------- 存储 ---------------- */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, raw) { try { localStorage.setItem(k, raw); return true; } catch (e) { return false; } }

  function trim(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) : s;
  }
  function arr(v, n) {
    return (Array.isArray(v) ? v : []).map(function (x) { return trim(x, 60); }).filter(Boolean).slice(0, n);
  }

  /** 条目 → 存储记录（只留可序列化、对「回头再看」有用的字段） */
  function recOf(it) {
    if (!it || typeof it !== 'object') return null;
    const key = String(it.key || '') ||
      (String(it.source || '') + ':' + String(it.id || it.url || it.title || ''));
    if (!key || key === ':') return null;
    const item = {
      source: trim(it.source, 40),
      sourceName: trim(it.sourceName || it.source, 40),
      id: trim(it.id, 120),
      key: trim(it.key || '', 160),
      title: trim(it.title, TITLE_MAX),
      url: trim(it.url, 500),
      cover: trim(it.cover, 500),
      artist: trim(it.artist, 120),
      pages: (typeof it.pages === 'number' && isFinite(it.pages)) ? it.pages : null,
      cats: arr(it.cats, 6),
      tags: arr(it.tags, TAG_MAX),
      langs: arr(it.langs, 6),
      lang: trim(it.lang, 12),
      year: trim(it.year, 8),
      series: trim(it.series, 120),
      note: trim(it.note, 200),
      zh: it.zh ? 1 : 0,
      nsfw: it.nsfw !== false,
      adult: it.adult ? 1 : 0
    };
    return { k: key, ts: Date.now(), n: 1, item: item };
  }

  function rebuild() {
    index = {};
    (db.items || []).forEach(function (r) { if (r && r.k) index[r.k] = r; });
  }

  function loadDB() {
    const raw = lsGet(KEY);
    db = { v: VER, items: [] };
    if (raw) {
      try {
        const p = JSON.parse(raw);
        const src = Array.isArray(p) ? p : (p && Array.isArray(p.items) ? p.items : []);
        const now = Date.now();
        const seen = {};
        src.forEach(function (r) {
          if (!r || !r.k || !r.item) return;
          if (seen[r.k]) return;
          const ts = parseInt(r.ts, 10) || 0;
          if (ts && (now - ts) > MAX_AGE) return;      /* 过期条目在读入时就丢掉 */
          seen[r.k] = 1;
          db.items.push({
            k: String(r.k),
            ts: ts || now,
            n: Math.max(1, parseInt(r.n, 10) || 1),
            item: r.item
          });
        });
        db.items.sort(function (a, b) { return b.ts - a.ts; });
        db.items = db.items.slice(0, CAP);
      } catch (e) { db = { v: VER, items: [] }; }
    }
    rebuild();
  }

  function serialize() { return JSON.stringify({ v: VER, items: db.items }); }

  /** 落盘：配额满时逐条丢最旧的再试（丢到能写进去为止，最多试 8 次） */
  function sync() {
    if (lsSet(KEY, serialize())) { storageOk = true; return true; }
    for (let i = 0; i < 8 && db.items.length; i++) {
      db.items = db.items.slice(0, Math.max(1, Math.floor(db.items.length * 0.7)));
      rebuild();
      if (lsSet(KEY, serialize())) { storageOk = true; return true; }
    }
    storageOk = false;
    return false;
  }

  function count() { return db.items.length; }

  /** 纯读：时间倒序的记录表 */
  function records() { return db.items.slice(); }

  /* ---------------- 记账 ---------------- */
  function add(it) {
    const rec = recOf(it);
    if (!rec) return null;
    const old = index[rec.k];
    if (old) {
      old.ts = rec.ts;
      old.n = (old.n || 1) + 1;
      old.item = rec.item;                 /* 元数据可能这次更全，用新的覆盖 */
      /* 置顶：直接从原位置移到队首，别整表重排（记录表本来就是按 ts 倒序的） */
      const i = db.items.indexOf(old);
      if (i > 0) { db.items.splice(i, 1); db.items.unshift(old); }
    } else {
      db.items.unshift(rec);
      index[rec.k] = rec;
      if (db.items.length > CAP) {
        const drop = db.items.pop();
        if (drop) delete index[drop.k];
      }
    }
    sync();
    if (isOpen()) render();
    HS.bus.emit('recent:change', { count: count() });
    return rec;
  }

  function remove(key) {
    const r = index[key];
    if (!r) return false;
    const i = db.items.indexOf(r);
    if (i >= 0) db.items.splice(i, 1);
    delete index[key];
    sync();
    if (isOpen()) render();
    HS.bus.emit('recent:change', { count: count() });
    return true;
  }

  function clearAll() {
    db.items = [];
    index = {};
    sync();
    if (isOpen()) render();
    HS.bus.emit('recent:change', { count: 0 });
  }

  /* ---------------- 时间显示 ---------------- */
  function pad(n) { return ('0' + n).slice(-2); }
  function dayKey(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function clock(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }

  /** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 HH:MM / M月D日 HH:MM / 年-月-日 */
  function when(ts) {
    const d = new Date(ts);
    const diff = Date.now() - ts;
    if (diff < 60e3) return '刚刚';
    if (diff < 3600e3) return Math.floor(diff / 60e3) + ' 分钟前';
    const today = new Date();
    const yest = new Date(today.getTime() - 864e5);
    if (dayKey(d) === dayKey(today)) return '今天 ' + clock(d);
    if (dayKey(d) === dayKey(yest)) return '昨天 ' + clock(d);
    if (d.getFullYear() === today.getFullYear()) return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + clock(d);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /** 分组表头：今天 / 昨天 / 更早的具体日期 */
  function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    const yest = new Date(today.getTime() - 864e5);
    if (dayKey(d) === dayKey(today)) return '今天';
    if (dayKey(d) === dayKey(yest)) return '昨天';
    if (d.getFullYear() === today.getFullYear()) return (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
    return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
  }

  function subtitle(it) {
    const bits = [];
    if (it.artist) bits.push(it.artist);
    if (it.series) bits.push(it.series);
    if (it.pages) bits.push(it.pages + 'P');
    if (it.langs && it.langs.length) bits.push(it.langs.slice(0, 2).join('/'));
    else if (it.lang) bits.push(it.lang);
    return bits.join(' · ');
  }

  /* ---------------- 视图 ---------------- */
  function buildModal() {
    if (modal) return modal;
    modal = u.el('div', { class: 'hs-modal hs-rec', id: 'recent-modal', hidden: true, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'recent-title' });
    modal.innerHTML =
      '<div class="hs-modal-card hs-rec-card" role="document">' +
        '<div class="hs-modal-head">' +
          '<span class="hs-head-ico" aria-hidden="true">' + HS.icon.clock + '</span>' +
          '<h2 id="recent-title">最近浏览</h2>' +
          '<span class="hs-rec-count" id="recent-count">0 条</span>' +
          '<button class="hs-btn hs-btn-text hs-rec-clear" type="button" data-rec-clear>清空</button>' +
          '<button class="hs-icon-btn" type="button" data-rec-close aria-label="关闭">' + HS.icon.close + '</button>' +
        '</div>' +
        '<div class="hs-modal-body hs-rec-body">' +
          '<div class="hs-rec-list" id="recent-list"></div>' +
          '<div class="hs-rec-empty" id="recent-empty" hidden></div>' +
        '</div>' +
        '<div class="hs-modal-foot">' +
          '<span class="hs-rec-hint">记录只保存在这台设备上 · 点任意一条查看详细信息</span>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    listEl = u.$('#recent-list', modal);
    emptyEl = u.$('#recent-empty', modal);
    countEl = u.$('#recent-count', modal);

    u.$$('[data-rec-close]', modal).forEach(b => b.addEventListener('click', () => close()));
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    u.$('[data-rec-clear]', modal).addEventListener('click', () => {
      if (!count()) return;
      if (!window.confirm('清空全部浏览记录？（只影响这台设备）')) return;
      clearAll();
      HS.toast('已清空浏览记录', 'ok', 2200);
    });
    return modal;
  }

  function thumbNode(it) {
    const box = u.el('div', { class: 'hs-rec-thumb' });
    const src = it.cover ? String(it.cover) : '';
    if (src) {
      /* loading="eager"：与卡片封面同一个理由（见 results.js cardNode 那段注释）——
         文档被判为「不在前台 / 被遮挡」时，Chrome 会把 loading="lazy" 图片的 load
         事件推迟（请求照发、200 照记，就是不绘制），于是缩略图永远停在空白。
         这里只挂一次 error 就换占位，等不到 load 也没法补救，所以必须 eager。 */
      const img = u.el('img', { alt: '', loading: 'eager', decoding: 'async', referrerpolicy: 'no-referrer' });
      /* 封面可能失效（第三方图床 / 源站换域名）：失败就换成占位，不留破图 */
      img.addEventListener('error', () => { img.remove(); box.classList.add('is-blank'); }, { once: true });
      img.src = src;
      box.appendChild(img);
    } else {
      box.classList.add('is-blank');
    }
    if (it.nsfw !== false && HS.settings.blurCovers) box.classList.add('is-blur');
    return box;
  }

  /* ---------------- 阅读进度标注 ----------------
     数据不落进本模块的存储：进度由 reader.js 单独维护（hs.rd.prog.v1），
     这里只**实时读**一次 —— 于是「看到第几话」永远是最新的，
     也不需要在 recOf / loadDB 的白名单里加字段（加了反而容易出现两处不一致）。 */
  function progLabel(it) {
    if (!HS.reader || typeof HS.reader.progressOf !== 'function') return null;
    let p = null;
    try { p = HS.reader.progressOf(it); } catch (e) { return null; }
    if (!p) return null;
    const cn = p.cn || 0;
    const pageBit = (p.page > 0 && p.pages > 0) ? '第 ' + (p.page + 1) + '/' + p.pages + ' 页' : '';
    if (cn > 1) {
      const last = p.ci >= cn - 1;
      const name = String(p.name || '').trim();
      let s = '看到 第 ' + (p.ci + 1) + ' 话' + (name && name.indexOf('第 ') !== 0 ? '（' + name + '）' : '') +
        ' / 共 ' + cn + ' 话';
      if (pageBit) s += ' · ' + pageBit;
      s += last ? ' · 最新章' : ' · 未追到最新';
      return { text: s, last: last, multi: true };
    }
    if (pageBit) return { text: '看到 ' + pageBit, last: false, multi: false };
    return null;
  }

  function rowNode(rec) {
    const it = rec.item || {};
    const row = u.el('div', { class: 'hs-rec-row', 'data-k': rec.k, role: 'button', tabindex: '0' });
    row.appendChild(thumbNode(it));

    const main = u.el('div', { class: 'hs-rec-main' });
    main.appendChild(u.el('div', { class: 'hs-rec-title' }, u.esc(it.title || '未命名')));
    const sub = subtitle(it);
    if (sub) main.appendChild(u.el('div', { class: 'hs-rec-sub' }, u.esc(sub)));
    const meta = u.el('div', { class: 'hs-rec-meta' });
    meta.appendChild(u.el('span', { class: 'hs-rec-src' }, u.esc(it.sourceName || it.source || '')));
    meta.appendChild(u.el('span', { class: 'hs-rec-time' }, when(rec.ts)));
    if ((rec.n || 1) > 1) meta.appendChild(u.el('span', { class: 'hs-rec-n' }, '看过 ' + rec.n + ' 次'));
    /* 多章节作品额外标出「看到第几话 / 一共几话 / 是不是最新章」 */
    const pl = progLabel(it);
    if (pl) {
      meta.appendChild(u.el('span', {
        class: 'hs-rec-prog' + (pl.multi ? (pl.last ? ' is-last' : ' is-behind') : ''),
        title: pl.text
      }, u.esc(pl.text)));
    }
    main.appendChild(meta);
    row.appendChild(main);

    const acts = u.el('div', { class: 'hs-rec-acts' });
    const read = u.el('button', { class: 'hs-rec-act', type: 'button', title: '在线阅读', 'aria-label': '在线阅读' }, '阅读');
    if (!(HS.reader && HS.reader.supports && HS.reader.supports(it.source))) read.hidden = true;
    read.addEventListener('click', ev => {
      ev.stopPropagation();
      if (HS.reader && HS.reader.open) { close(); HS.reader.open(it); }
    });
    acts.appendChild(read);
    const del = u.el('button', { class: 'hs-rec-act hs-rec-del', type: 'button', title: '从记录中移除', 'aria-label': '从记录中移除' }, '×');
    del.addEventListener('click', ev => { ev.stopPropagation(); remove(rec.k); });
    acts.appendChild(del);
    row.appendChild(acts);

    function openDetail() {
      close();
      if (HS.results && HS.results.openCard) HS.results.openCard(it, null);
      else if (it.url) window.open(it.url, '_blank', 'noopener');
    }
    row.addEventListener('click', openDetail);
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(); }
    });
    return row;
  }

  function render() {
    if (!modal) return;
    const rs = records();
    if (countEl) countEl.textContent = rs.length + ' 条';
    const clearBtn = u.$('[data-rec-clear]', modal);
    if (clearBtn) clearBtn.hidden = !rs.length;
    emptyEl.hidden = rs.length > 0;
    if (!rs.length) {
      emptyEl.innerHTML = '还没有浏览记录。<br><span>在结果里点开任意一张卡片（或直接在线阅读），就会在这里按时间留下一条。</span>';
      listEl.innerHTML = '';
      return;
    }
    const frag = document.createDocumentFragment();
    let lastDay = '';
    rs.forEach(function (rec) {
      const d = dayLabel(rec.ts);
      if (d !== lastDay) {
        lastDay = d;
        frag.appendChild(u.el('div', { class: 'hs-rec-day' }, u.esc(d)));
      }
      frag.appendChild(rowNode(rec));
    });
    listEl.innerHTML = '';
    listEl.appendChild(frag);
  }

  function isOpen() { return !!modal && !modal.hidden; }

  function open() {
    buildModal();
    render();
    modal.hidden = false;
  }

  function close() {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    if (opener && opener.focus) { try { opener.focus(); } catch (e) {} }
    opener = null;
  }

  /* ---------------- 挂钩 ---------------- */
  /* 用「包装」而不是改实现：两个入口各自的参数、返回值、异常语义原样保留，
     记账失败也绝不影响原有流程（包在 try/catch 里）。 */
  function wrap(target, name, pick) {
    if (!target || typeof target[name] !== 'function' || target[name].__recentWrapped) return false;
    const orig = target[name];
    const fn = function () {
      try {
        const it = pick.apply(null, arguments);
        if (it) add(it);
      } catch (e) { /* 记账失败不影响主流程 */ }
      return orig.apply(this, arguments);
    };
    fn.__recentWrapped = 1;
    target[name] = fn;
    return true;
  }

  function hook() {
    wrap(HS.results, 'openCard', it => it);
    wrap(HS.reader, 'open', it => it);
  }

  /* ---------------- 导出 ---------------- */
  R.KEY = KEY;
  R.cap = CAP;
  R.count = count;
  R.list = records;
  R.add = function (it) { return add(it); };
  R.remove = function (k) { return remove(k); };
  R.clear = function () { clearAll(); };
  R.when = when;
  R.open = open;
  R.close = close;
  R.isOpen = isOpen;
  R.render = render;

  R.init = function () {
    loadDB();
    hook();
    const btn = u.$('#recent-btn');
    if (btn) {
      /* 第 9 轮（用户原话：「最近浏览不需要紫点，就有一个按钮就可以」）：
         只留一个**纯图标按钮** —— 不再注入「最近浏览」文字与条数角标，
         也不再挂 .hs-icon-btn-label（那个 class 是带文字/紫色底的顶栏按钮用的，
         设置入口还在用它）。名字仍由 title / aria-label 给出，浮上去就能看到。 */
      if (!btn.querySelector('svg')) btn.innerHTML = HS.icon.clock;
      btn.classList.remove('hs-icon-btn-label');
      btn.addEventListener('click', e => { opener = e.currentTarget; if (isOpen()) close(); else open(); });
    }
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && isOpen()) { e.stopPropagation(); close(); }
    });
    HS.bus.on('theme:set', () => { /* 主题变化不需要重画：颜色全部走 CSS 变量 */ });
  };

})(window.HS);
