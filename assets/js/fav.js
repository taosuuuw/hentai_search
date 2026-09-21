/* ==========================================================================
   fav.js — 收藏 + 思维导图式归档（数据层 + 自研零依赖渲染 + 浮层编排）
   ---------------------------------------------------------------------------
   依赖：window.HS（core.js）。零第三方依赖、零网络、不引 CDN。
   与其它模块的关系：
     · 只**新增**自己的 DOM（#fav-chip / #fav-overlay），只**只读**地监听既有 DOM；
       不包装、不改写任何既有全局函数（HS.results / HS.reader / HS.panic… 都不动）。
     · 卡片上的爱心按钮由 results.js 创建（一个只读调用方），本文件负责把状态同步回去。
     · 浮层放在 #hs-app 内部：这样「遮蔽」给 #hs-app 加的那层 blur 会连它一起糊掉。

   ── 两条主键规则（最容易踩坑的地方）─────────────────────────────────────
   1) 收藏主键 = "<source>:<id>"，不是 it.key。
      it.key 是「归一化标题」（core.js 的 u.normTitle），用途是跨源去重 —— 同一部作品在
      两个源上 key 相同，而且标题归一化命中与否会让它在中英两种形态之间跳。拿它当主键
      会让不同作品互相覆盖 / 同一作品找不到自己。it.key 只作为 tk 字段附带存下来。
   2) 记录里**不存** it 对象本身，只挑固定字段（见 norm()）。这样存储增长可控，
      也避免把一些运行时临时状态（_score / alsoOn / 大数组）一起写进 localStorage。

   ── 渲染层为什么是「HTML 节点 + 单张 SVG 连线」而不是全 SVG ─────────────
   直接用 SVG <text> 排版要自己处理换行、省略号、字体度量；用 HTML div 则
   text-overflow: ellipsis、<img> 封面、主题 CSS 变量全部免费。连线只是父节点右边缘中点
   到子节点左边缘中点的三次贝塞尔，交给一张绝对定位、pointer-events:none 的 SVG 就够。

   ── 布局为什么是「叶子堆叠 + 父节点取首尾子节点中心线中点」─────────────────
   数据是严格的层级树（根 → 分组 → 作品），不是网状图，用不上 Reingold–Tilford 的
   轮廓避让。让每个叶子独占一段纵向空间（累加实测高度 + 间隙），父节点落在首尾子节点的
   中心线中点。前提是「可见节点」都已建好 DOM 并用 offsetHeight/offsetWidth 实测过尺寸。
   结果完全确定：同一份数据 + 同一组折叠状态 → 同一张图，不会每次都变。

   ── 手势为什么必须给视口设 touch-action:none ────────────────────────────
   否则移动端浏览器会把单指拖拽识别成页面滚动、把双指识别成页面缩放，事件根本不给我们。
   再叠加「指针总位移 < 6px 才算点击」的阈值，避免拖完手一松就误开作品。另外：按在
   节点上的那一下**不**做 setPointerCapture —— 捕获会把后续事件重定向到视口，
   点击目标就不再是节点，点卡片会失效。
   ========================================================================== */
(function () {
  'use strict';

  var HS = (typeof window !== 'undefined') ? window.HS : null;
  if (!HS || !HS.u) return;                       /* core.js 缺失：整体不启动 */

  var u = HS.u;

  /* ---------------- 常量 ---------------- */
  var SKEY = 'hs.fav.v1';        /* localStorage 键 */
  var FVER = 1;                  /* 数据格式版本 */
  var MAX = 3000;                /* 条数上限；到顶再收藏 → 淘汰 ts 最小的一条 */
  var C_TITLE = 300, C_ARTIST = 120, C_URL = 900, C_STR = 200;
  var MAX_LANGS = 3, MAX_TAGS = 8, MAX_CATS = 4;
  var DEF_COLLAPSE_OVER = 60;    /* 总数超过这个值时，分组默认收起（避免首屏是一堵墙） */
  var MAX_ARTIST_GROUPS = 80;    /* 画师维度：第 81 组起合并为「其他 (n)」 */
  var MAX_TAG_BRANCH = 3;        /* 标签维度：每件作品最多挂 3 个标签枝 */
  var DRAG_CLICK_SLOP = 6;       /* 指针总位移 < 这个值才算「点击」，否则算拖拽 */

  var DIMS = [
    { id: 'source', label: '信息源' },
    { id: 'artist', label: '画师' },
    { id: 'time', label: '时间' },
    { id: 'tag', label: '标签' }
  ];

  /* 自带爱心图标（不改 core.js 的图标表）：2.4 的优雅描边风，viewBox 24 */
  var HEART =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 20.4C10.6 19.4 4.4 15.3 4.4 10.7A4.5 4.5 0 0 1 12 7.7a4.5 4.5 0 0 1 7.6 3c0 4.6-6.2 8.7-7.6 9.7z"/>' +
    '</svg>';

  /* 作品节点菜单里的图标：0.9 描边（图标按钮 14px 下 1.6 会糊），全部继承 currentColor */
  var ICO_BOOK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 7.3C10.5 5.9 8.4 5.2 5.5 5.2H4v12.9h1.5c2.9 0 5 .7 6.5 2.1 1.5-1.4 3.6-2.1 6.5-2.1H20V5.2h-1.5c-2.9 0-5 .7-6.5 2.1z"/>' +
    '<path d="M12 7.3v12.9"/></svg>';
  var ICO_TRASH =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M4.5 7h15"/><path d="M9.5 7V4.6h5V7"/>' +
    '<path d="M6.7 7l.9 12.4h8.8L17.3 7"/>' +
    '<path d="M10.3 11v5.4M13.7 11v5.4"/></svg>';
  var ICO_INFO =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="8.2"/><path d="M12 10.6v6"/><path d="M12 7.9h.01"/></svg>';

  /* 作品节点菜单的静态骨架（只建一次：见 buildMenu） */
  var MENU_HTML =
    '<div class="hs-fav-menu-head"><span class="hs-fav-menu-title"></span></div>' +
    '<button class="hs-btn hs-btn-ghost hs-fav-menu-btn" type="button" data-mact="read">' +
      '<span class="hs-fav-menu-ico" aria-hidden="true">' + ICO_BOOK + '</span>' +
      '<span class="hs-fav-menu-label">在线阅读</span></button>' +
    '<button class="hs-btn hs-btn-ghost hs-fav-menu-btn" type="button" data-mact="del">' +
      '<span class="hs-fav-menu-ico" aria-hidden="true">' + ICO_TRASH + '</span>' +
      '<span class="hs-fav-menu-label">删除收藏</span></button>' +
    '<button class="hs-btn hs-btn-ghost hs-fav-menu-btn" type="button" data-mact="info">' +
      '<span class="hs-fav-menu-ico" aria-hidden="true">' + ICO_INFO + '</span>' +
      '<span class="hs-fav-menu-label">查看详细信息</span></button>' +
    '<p class="hs-fav-menu-hint" hidden></p>';

  function trim(s, n) {
    var v = String(s == null ? '' : s);
    return v.length > n ? v.slice(0, n) : v;
  }
  function isPlainObj(o) {
    return !!o && typeof o === 'object' && !Array.isArray(o);
  }

  /* ======================================================================
     一、数据层
     { v, items: { "<source>:<id>": rec }, ui: { dim, collapsed } }
     任何一步损坏 / 不可用都静默降级，绝不让收藏功能把整页拖垮。
     ====================================================================== */

  var db = {
    v: FVER,
    items: {},
    ui: { dim: 'source', collapsed: null }
  };

  var index = {};                /* 主键 → 记录（与 db.items 同一批对象） */
  var oldest = [];               /* 按 ts 升序排好的记录数组（懒构建） */
  var storageOk = true;          /* localStorage 是否可用（不可用则退化成内存态） */
  var uiTimer = 0;               /* ui 字段写盘防抖 */
  var warnedQuota = false;       /* 「存储不可用」只提示一次，别刷屏 */
  var uiCollapsed = {};          /* nodeId → 1：用户显式收起的节点 */

  /* ---- 本地存储读写：全部包 try/catch ---- */
  function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, raw) {
    try { window.localStorage.setItem(key, raw); return true; }
    catch (e) { return false; }
  }

  /** 把任意来源（盘上 / 导入文件 / 卡片条目）的字段收敛成记录；不可用返回 null */
  function norm(src) {
    if (!isPlainObj(src)) return null;
    var source = trim(src.source == null ? '' : src.source, C_STR);
    var id = trim(src.id == null ? '' : src.id, C_STR);
    var url = trim(src.url == null ? '' : src.url, C_URL);
    var tk = trim(src.tk || src.key || '', C_STR);
    var title = trim(src.title || '', C_TITLE);

    var key = '';
    if (id) key = source + ':' + id;
    else {
      var alt = trim(url || tk || title, C_STR);
      if (alt) key = source + ':' + alt;
    }
    if (!key) return null;
    /* 后缀限长：个别源的 id 本身就是一条很长的 href，别让它撑爆配额 */
    if (key.length > 180) key = key.slice(0, 180);

    var langs = (Array.isArray(src.langs) ? src.langs : []).map(function (x) {
      return trim(x, 40);
    }).filter(Boolean).slice(0, MAX_LANGS);
    var tags = (Array.isArray(src.tags) ? src.tags : []).map(function (x) {
      return trim(String(x == null ? '' : x).trim(), 80);
    }).filter(Boolean).slice(0, MAX_TAGS);
    var cats = (Array.isArray(src.cats) ? src.cats : []).map(function (x) {
      return trim(x, 40);
    }).filter(Boolean).slice(0, MAX_CATS);

    var pages = (typeof src.pages === 'number' && src.pages > 0) ? Math.round(src.pages) : null;
    var ts = (typeof src.ts === 'number' && isFinite(src.ts) && src.ts > 0) ? src.ts : Date.now();

    return {
      k: key,
      source: source || 'unknown',
      sourceName: trim(src.sourceName || source, C_STR),
      id: id,
      tk: tk,
      title: title,
      artist: trim(src.artist || '', C_ARTIST),
      url: url,
      cover: trim(src.cover || '', C_URL),
      pages: pages,
      year: (src.year == null) ? '' : trim(src.year, 12),
      series: src.series ? trim(src.series, C_STR) : null,
      langs: langs,
      tags: tags,
      cats: cats,
      ts: ts
    };
  }

  /** 重建内存索引；任何结构不对的条目直接丢弃 */
  function rebuild() {
    index = {};
    Object.keys(db.items || {}).forEach(function (k) {
      var r = norm(db.items[k]);
      if (r) index[r.k] = r;
    });
    db.items = index;
    oldest = [];
  }

  function loadDB() {
    var raw = lsGet(SKEY);
    if (raw == null) return;                       /* 没存过：保持默认 */
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    if (!isPlainObj(parsed)) return;                /* 损坏 → 静默用空 */
    if (isPlainObj(parsed.items)) db.items = parsed.items;
    if (isPlainObj(parsed.ui)) {
      if (parsed.ui.dim) db.ui.dim = parsed.ui.dim;
      if (Array.isArray(parsed.ui.collapsed)) {
        db.ui.collapsed = parsed.ui.collapsed.filter(function (x) { return typeof x === 'string'; });
      }
    }
  }

  function serialize() {
    return JSON.stringify({ v: FVER, items: db.items, ui: db.ui });
  }

  /** 写盘；失败时按需淘汰最早的几条再试一次（配额满的自救） */
  function sync() {
    if (lsSet(SKEY, serialize())) { storageOk = true; return true; }
    storageOk = false;
    var items = Object.keys(db.items).map(function (k) { return db.items[k]; });
    if (items.length < 3) return false;
    items.sort(function (a, b) { return a.ts - b.ts; });
    items.slice(0, Math.max(1, Math.floor(items.length / 10))).forEach(function (r) {
      delete db.items[r.k];
      delete index[r.k];
    });
    oldest = [];
    if (lsSet(SKEY, serialize())) { storageOk = true; return true; }
    return false;
  }

  /** ui 字段写盘（dim / collapsed）：折叠是高频操作，防抖一下 */
  function syncUI() {
    if (uiTimer) return;
    uiTimer = window.setTimeout(function () {
      uiTimer = 0;
      lsSet(SKEY, serialize());
    }, 600);
  }

  function recOf(it) {
    return (typeof it === 'string') ? (index[it] || null) : norm(it);
  }

  function keyOf(it) {
    if (typeof it === 'string') return it;
    var r = norm(it);
    return r ? r.k : '';
  }

  /* ---- 收藏 / 取消：唯一的写入口 ---- */
  function add(it, quiet, forceTs) {
    var r = norm(it);
    if (!r) return false;
    if (forceTs) r.ts = forceTs;
    var old = index[r.k];
    if (old) r.ts = old.ts;                        /* 已收藏：保留第一次收藏的时间 */
    /* 上限：先淘汰 ts 最小的一条（最早收藏的） */
    if (!old && Object.keys(db.items).length >= MAX) {
      if (!oldest.length) {
        oldest = Object.keys(db.items).map(function (k) { return db.items[k]; })
          .sort(function (a, b) { return a.ts - b.ts; });
      }
      var victim = oldest.shift();
      if (victim && victim.k !== r.k) {
        delete db.items[victim.k];
        delete index[victim.k];
        if (!quiet) HS.toast('收藏已满 ' + MAX + ' 条，已移除最早收藏的一条', 'warn', 3200);
      }
    }
    db.items[r.k] = r;
    index[r.k] = r;
    oldest = [];
    var ok = sync();
    if (!quiet) {
      if (!ok && !warnedQuota) {
        warnedQuota = true;
        HS.toast('浏览器存储不可用，收藏只保留在本次会话中', 'warn', 3400);
      } else {
        HS.toast('已收藏', 'ok', 1400);
      }
    }
    if (!quiet) HS.bus.emit('fav:change', { id: r.k, on: true });
    return true;
  }

  function remove(key, quiet) {
    if (!key || !index[key]) return false;
    delete db.items[key];
    delete index[key];
    oldest = [];
    sync();
    if (!quiet) HS.bus.emit('fav:change', { id: key, on: false });
    return true;
  }

  function count() { return Object.keys(db.items).length; }

  function records() {
    return Object.keys(db.items).map(function (k) { return db.items[k]; })
      .sort(function (a, b) { return b.ts - a.ts; });   /* 最近收藏在前 */
  }

  function clearAll() {
    db.items = {}; index = {}; oldest = [];
    sync();
    HS.bus.emit('fav:change', { id: '', on: false });
  }

  function exportJSON() {
    return JSON.stringify({ v: FVER, items: db.items, ui: db.ui }, null, 2);
  }

  function importJSON(text) {
    var out = { ok: false, added: 0, skipped: 0 };
    var parsed = null;
    try { parsed = JSON.parse(String(text == null ? '' : text)); } catch (e) { return out; }
    var src = (isPlainObj(parsed) && isPlainObj(parsed.items)) ? parsed.items : parsed;
    var list = Array.isArray(src) ? src
      : (isPlainObj(src) ? Object.keys(src).map(function (k) { return src[k]; }) : null);
    if (!list) return out;
    out.ok = true;
    list.forEach(function (raw) {
      var r = norm(raw);
      if (!r) { out.skipped++; return; }
      var old = index[r.k];
      if (old && old.ts >= r.ts) { out.skipped++; return; }   /* 同键取 ts 较新的 */
      add(r, true, r.ts);
      out.added++;
    });
    HS.bus.emit('fav:change', { id: '', on: true });
    return out;
  }

  /* ======================================================================
     二、按维度建树
     id 必须全局唯一且稳定：折叠状态按 id 存，用下标一重排就全乱。
     ====================================================================== */

  /** 一个作品在某维度下属于哪些分组（tag 维度可能多个；永远至少一个） */
  function groupKeys(r, dim) {
    if (dim === 'artist') {
      var a = String(r.artist || '').replace(/\s+/g, ' ').trim();
      return [{ key: a.toLowerCase() || '__none__', label: a || '未知画师' }];
    }
    if (dim === 'time') {
      var d = new Date(r.ts || Date.now());
      if (isNaN(d.getTime())) return [{ key: 'unknown', label: '未知时间' }];
      var m = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2);
      return [{ key: m, label: m }];
    }
    if (dim === 'tag') {
      var seen = {}, out = [];
      (r.tags || []).slice(0, MAX_TAG_BRANCH).forEach(function (t) {
        var k = u.tagKey(t) || String(t || '').trim().toLowerCase();
        if (!k || seen[k]) return;
        seen[k] = 1;
        out.push({ key: k, label: String(t).replace(/\s+/g, ' ').trim() });
      });
      return out.length ? out : [{ key: '__none__', label: '无标签' }];
    }
    return [{ key: String(r.source || 'unknown'), label: r.sourceName || r.source || 'unknown' }];
  }

  /** 分组的稳定 id 列表（与 buildTree 的 id 规则一致，供折叠缺省用） */
  function groupIdsOf(list, dim) {
    var seen = {}, ids = [];
    list.forEach(function (r) {
      groupKeys(r, dim).forEach(function (g) {
        var id = 'g:' + dim + ':' + g.key;
        if (seen[id]) return;
        seen[id] = 1;
        ids.push(id);
      });
    });
    return ids;
  }

  function workNode(r) {
    var img = (r.cover && String(r.cover).indexOf('data:') !== 0)
      ? { url: r.cover, width: 64, height: 88, fit: 'cover' } : null;
    var n = {
      id: 'w:' + r.k,
      topic: trim(r.title || '未命名', 60),
      children: [],
      payload: { k: r.k, ts: r.ts }
    };
    if (img) n.image = img;                        /* 没有封面就不放空 url，渲染层用占位兜底 */
    if (uiCollapsed[n.id]) n.expanded = false;
    return n;
  }

  function buildTree(dim) {
    dim = dim || 'source';
    var rs = records();
    var groups = {}, order = [];
    rs.forEach(function (r) {
      groupKeys(r, dim).forEach(function (g) {
        if (!groups[g.key]) { groups[g.key] = { label: g.label, items: [] }; order.push(g.key); }
        groups[g.key].items.push(r);
      });
    });
    var arr = order.map(function (k) { return groups[k]; });
    if (dim === 'time') {
      arr.sort(function (a, b) { return b.label < a.label ? -1 : (b.label > a.label ? 1 : 0); });
    } else {
      arr.sort(function (a, b) {
        return (b.items.length - a.items.length) || (a.label < b.label ? -1 : (a.label > b.label ? 1 : 0));
      });
    }
    /* 画师维度动辄几百组：第 81 组起合并成「其他 (n)」 */
    if (dim === 'artist' && arr.length > MAX_ARTIST_GROUPS) {
      var tail = arr.slice(MAX_ARTIST_GROUPS);
      var n = 0;
      tail.forEach(function (g) { n += g.items.length; });
      arr = arr.slice(0, MAX_ARTIST_GROUPS).concat([{
        label: '其他 (' + n + ')',
        items: tail.reduce(function (a, g) { return a.concat(g.items); }, [])
      }]);
    }
    var defCollapsed = rs.length > DEF_COLLAPSE_OVER;
    return {
      id: 'root',
      topic: '收藏 (' + rs.length + ')',
      expanded: true,
      children: arr.map(function (g) {
        var id = 'g:' + dim + ':' + g.key;
        return {
          id: id,
          topic: g.label + ' (' + g.items.length + ')',
          expanded: uiCollapsed[id] ? false : !defCollapsed,
          style: { fontWeight: '600' },
          children: g.items.map(workNode)
        };
      })
    };
  }

  /** 把树里显式收起的节点 id 收进 uiCollapsed（重建树时据此还原） */
  function harvestCollapsed(node) {
    if (!node) return;
    if (node.id !== 'root' && node.children && node.children.length && node.expanded === false) {
      uiCollapsed[node.id] = 1;
    }
    (node.children || []).forEach(harvestCollapsed);
  }

  /* ======================================================================
     三、渲染层：平移 / 缩放 / 折叠 / 连线
     ====================================================================== */
  var PAD = 40, GAP_X = 56, LEAF_GAP = 12, MIN_K = 0.25, MAX_K = 3;

  var fm = {
    v: {}, c: {}, map: {}, tree: null, dim: 'source',
    k: 1, tx: 0, ty: 0,
    pts: {}, nPts: 0, moved: 0, pinch0: null,
    drag: false, wheelT: 0,
    w: 0, h: 0, bw: 0, bh: 0
  };

  /* 作品节点菜单的运行时状态（DOM 只在第一次打开时建，见 buildMenu） */
  var menuState = { el: null, open: false, record: null, node: null, trig: null, gen: 0 };

  function isOpen() { return !!fm.v.overlay && !fm.v.overlay.hidden; }
  function menuOpen() { return !!(menuState.open && menuState.el); }

  /** 把一次指针手势收尾：清掉按键集合 / 复位拖拽标记（见 isDrag） */
  function resetGesture() {
    fm.nPts = 0; fm.pts = {}; fm.pinch0 = null;
    fm.drag = false; fm.moved = 0;
  }

  /** 本次手势到底是「拖」还是「点」：
      moved = 指针相对**按下点**的直线距离（不是路径累计长度）—— 手抖着单击会在
      clientX 上抖出几个像素、路径累计很容易过阈值，直线距离不会；捏合过（drag）一律算拖。*/
  function isDrag() { return fm.drag || fm.moved >= DRAG_CLICK_SLOP; }

  /** 指针是否按在菜单里（按在菜单上既不拖画布，也不关任何东西） */
  function inMenu(t) {
    return !!(menuState.el && (t === menuState.el || (t && t.closest && t.closest('#fav-menu'))));
  }

  /* ---------------- 布局：叶子堆叠两遍法 ---------------- */
  function layout(root, map) {
    var cursor = PAD;
    (function walkY(n) {
      var e = map[n.id];
      var h = e ? e.offsetHeight : 30;
      var kids = n.collapsed ? [] : (n.children || []);
      if (!kids.length || !e) {
        n._y = cursor;
        cursor += h + LEAF_GAP;
        return n._y + h / 2;
      }
      var cs = kids.map(walkY);
      var mid = (cs[0] + cs[cs.length - 1]) / 2;
      n._y = mid - h / 2;
      return mid;
    })(root);
    var maxX = 0, maxY = 0;
    (function walkX(n, x) {
      var e = map[n.id];
      n._x = x;
      n._w = e ? e.offsetWidth : 0;
      n._h = e ? e.offsetHeight : 0;
      if (n._x + n._w > maxX) maxX = n._x + n._w;
      if (n._y + n._h > maxY) maxY = n._y + n._h;
      var kids = n.collapsed ? [] : (n.children || []);
      for (var i = 0; i < kids.length; i++) walkX(kids[i], n._x + n._w + GAP_X);
    })(root, PAD);
    fm.bw = maxX + PAD;
    fm.bh = maxY + PAD;
  }

  function apply() {
    if (!fm.c.canvas) return;
    fm.c.canvas.style.transform =
      'translate(' + fm.tx.toFixed(1) + 'px,' + fm.ty.toFixed(1) + 'px) scale(' + fm.k.toFixed(4) + ')';
  }

  function clampK(v) { return Math.min(MAX_K, Math.max(MIN_K, v)); }

  /** 以视口内坐标 (cx,cy) 为锚点缩放：锚点下的那一点缩放前后不动 */
  function zoomAt(cx, cy, nk) {
    nk = clampK(nk);
    if (!isFinite(nk) || nk <= 0) return;
    fm.tx = cx - (cx - fm.tx) * (nk / fm.k);
    fm.ty = cy - (cy - fm.ty) * (nk / fm.k);
    fm.k = nk;
    apply();
  }

  /** 当前双指手势的距离与中点。★ 必须容忍 fm.pts 里只剩一个指针：第三指落下 /
      pointercancel 到达的瞬间事件顺序并不保证与 nPts 一致，早期版本在这里
      直接读 ids[1].x，落一次未捕获异常就把整个手势状态卡死。 */
  function pinchNow() {
    var ids = Object.keys(fm.pts), a = fm.pts[ids[0]], b = fm.pts[ids[1]];
    if (!b) return { d: 1, cx: a ? a.x : 0, cy: a ? a.y : 0 };
    return {
      d: Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)) || 1,
      cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2
    };
  }

  function fit() {
    if (!fm.v.view || !fm.c.canvas) return;
    var vw = fm.v.view.clientWidth, vh = fm.v.view.clientHeight;
    if (!vw || !vh || !fm.bw || !fm.bh) return;
    fm.k = clampK(Math.min(1, Math.min(vw / fm.bw, vh / fm.bh)) * 0.92);
    fm.tx = (vw - fm.bw * fm.k) / 2;
    fm.ty = (vh - fm.bh * fm.k) / 2;
    apply();
  }

  /* ---------------- 手势 ----------------
     ★ 误关的根因与修法（见文件头的三条规则）★
     浏览器在 pointerup 之后**照样**会补发一次 click，而且这次 click 的 target 是
     「按下点」与「松开点」的最近公共祖先 —— 在空白画布上按下再拖动时，就是 #fav-view
     自己（按下时非节点区域做了 setPointerCapture，事件目标也被重定向到视口）。
     原来的「点空白关闭」只比较 e.target 是不是浮层 / 视口 / 画布，完全没看这次手势
     到底拖没拖过，于是**在画布里一拖手一松，浮层就被自己补发的那个 click 关掉了**。
     修法：把「拖」的判定提到一处 —— isDrag()（指针相对按下点的直线距离 ≥ 6px，或捏合过），
     「点空白关闭」「点节点开菜单」「点分组折叠」三个入口全部先过它：拖 ⇒ 一律不当点击。 */
  function endPtr(e) {
    if (!fm.pts[e.pointerId]) return;
    delete fm.pts[e.pointerId];
    fm.nPts--;
    /* ★ 这里**不能**清掉 fm.moved / fm.drag ★
       浏览器的事件顺序是 pointerup → mouseup → click：窗口在 pointerup 之后还会补发
       一次 click，而「点空白关闭 / 点节点开菜单」正是在那次 click 上做判定。
       如果在 pointerup 就把位移清了，判定永远读到 0，就等于没做判定 —— 本 bug 的第一版
       修法就栽在这里（实测：空白处拖 60px 松手，浮层照样关）。位移由下一次
       pointerdown（见 bindGestures）与 window.blur 兜底复位。 */
    if (fm.nPts <= 0) {
      fm.nPts = 0; fm.pts = {}; fm.pinch0 = null;
      if (fm.v.view) fm.v.view.classList.remove('is-drag');
    } else if (fm.nPts === 1) {
      fm.pinch0 = null;
      fm.drag = true;                    /* 双指抬起剩一指：这一段已经算拖过 */
    }
  }

  function bindGestures() {
    var view = fm.v.view;
    view.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      /* 按在菜单上：不接管手势，也不关菜单（菜单有自己的 click 委托） */
      if (inMenu(e.target)) return;
      if (menuOpen()) hideMenu(false);   /* 按在菜单外任意处即收起菜单 —— 但不关浮层 */
      /* ★ 按在节点 / 折叠按钮上时不做指针捕获：捕获会把后续事件重定向到视口，
         点击目标就不再是节点，点卡片会失效。节点上的「拖动」本来也没有语义。 */
      var onNode = !!(e.target.closest && e.target.closest('.hs-fav-node'));
      if (!onNode) { try { view.setPointerCapture(e.pointerId); } catch (err) {} }
      /* ★ 一次新手势从「按下」开始：这里必须无条件复位拖拽标记 ★
         （实测踩到过：在被捕获的节点上拖动时 pointerup 不会回到视口，标记就留到下一次
         单击上，把真正的单击也当成拖 —— 空白点不关、节点点不开菜单。）
         复位在派发 click 之前，所以不会影响任何判定。 */
      fm.moved = 0;
      fm.drag = false;
      fm.pts[e.pointerId] = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY };
      fm.nPts++;
      if (fm.nPts === 2) fm.pinch0 = pinchNow();
      view.classList.add('is-drag');
    });
    view.addEventListener('pointermove', function (e) {
      var p = fm.pts[e.pointerId];
      if (!p) return;
      var dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (fm.nPts === 1) {
        fm.tx += dx; fm.ty += dy;
        /* 相对按下点的直线距离（见 isDrag 的说明） */
        fm.moved = Math.sqrt((e.clientX - p.sx) * (e.clientX - p.sx) +
                             (e.clientY - p.sy) * (e.clientY - p.sy));
        if (fm.moved >= DRAG_CLICK_SLOP) fm.drag = true;
        apply();
      } else if (fm.nPts === 2 && fm.pinch0) {
        var now = pinchNow(), r = view.getBoundingClientRect();
        zoomAt(now.cx - r.left, now.cy - r.top, fm.k * (now.d / fm.pinch0.d));
        fm.tx += now.cx - fm.pinch0.cx;
        fm.ty += now.cy - fm.pinch0.cy;
        apply();
        fm.pinch0 = now;
        fm.moved = 99;                     /* 捏合过就不当点击了 */
        fm.drag = true;
      }
    });
    view.addEventListener('pointerup', endPtr);
    view.addEventListener('pointercancel', function (e) {
      /* 手势被打断：不可能再有对应的那一次 click，所以这里**直接复位**，
         否则「这次算拖」会留到下一次单击上，把真正的单击也当成拖。 */
      if (!fm.pts[e.pointerId]) return;
      delete fm.pts[e.pointerId];
      fm.nPts--;
      resetGesture();
      if (fm.v.view) fm.v.view.classList.remove('is-drag');
    });
    /* 手势丢在半路（切窗口 / 焦点被抢走）：清干净手指状态，别让下一击被上一次的位移误判 */
    window.addEventListener('blur', function () {
      resetGesture();
      if (menuOpen()) hideMenu(false);
      if (fm.v.view) fm.v.view.classList.remove('is-drag');
    });
    view.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (fm.v.view) fm.v.view.classList.add('is-drag');   /* 缩放中不要过渡，跟手 */
      var r = view.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, fm.k * Math.exp(-e.deltaY * 0.0015));
      window.clearTimeout(fm.wheelT);
      fm.wheelT = window.setTimeout(function () {
        if (fm.v.view) fm.v.view.classList.remove('is-drag');
      }, 140);
    }, { passive: false });

    /* 节点点击：委托 + isDrag() 位移阈值（拖完手一松既不弹菜单、也不关浮层） */
    fm.c.nodes.addEventListener('click', function (e) {
      if (isDrag()) return;
      var tog = e.target.closest ? e.target.closest('.hs-fav-tog') : null;
      if (tog) {
        e.preventDefault();
        toggleCollapse(tog.getAttribute('data-node'));
        return;
      }
      var nd = e.target.closest ? e.target.closest('.hs-fav-node') : null;
      if (!nd) return;
      if (nd.__group) { toggleCollapse(nd.getAttribute('data-node')); return; }
      var k = nd.getAttribute('data-key');
      var r = k ? index[k] : null;
      if (!r) return;
      /* 同一节点再点一次 = 收起菜单（键盘用户按 Enter 也走这条） */
      if (menuOpen() && menuState.node === nd) { hideMenu(true); return; }
      openMenu(nd, r);
    });

    /* 作品节点键盘：Enter / Space = 打开同一个菜单（分组节点由 keydown 折叠） */
    fm.c.nodes.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      var nd = e.target.closest ? e.target.closest('.hs-fav-node') : null;
      if (!nd || nd !== e.target) return;
      e.preventDefault();
      if (nd.__group) { toggleCollapse(nd.getAttribute('data-node')); return; }
      var k = nd.getAttribute('data-key');
      var r = k ? index[k] : null;
      if (!r) return;
      if (menuOpen() && menuState.node === nd) { hideMenu(true); return; }
      openMenu(nd, r);
    });
  }

  /* ---------------- 打开作品 / 折叠 ---------------- */
  function toItem(r) {
    return {
      source: r.source, sourceName: r.sourceName, id: r.id, title: r.title,
      url: r.url, cover: r.cover, artist: r.artist, pages: r.pages,
      year: r.year, series: r.series, langs: (r.langs || []).slice(),
      cats: (r.cats || []).slice(), tags: (r.tags || []).slice(),
      key: r.tk || r.k
    };
  }

  /* ======================================================================
     三点五、作品节点菜单（在线阅读 / 删除收藏 / 查看详细信息）
     ----------------------------------------------------------------------
     为什么是「点节点出菜单」而不是「点节点直接打开」：打开是一条不可逆的副作用
     （进阅读器 / 弹新标签），而删除、看详情同样是这一枝上最常用的动作。菜单在一次
     点击里把三条路都摆出来，且能被键盘走完（Tab 进、↑↓ 选、Enter 触发、Esc 退）。

     与手势的关系（①的修复同源）：拖动结束时浏览器照样会补发一次 click，
     所以这里的入口与画布空白关闭都统一用 isDrag() 判定 —— 拖完手一松既不弹菜单、
     也不关浮层。菜单本身不落进 #fav-canvas / #fav-nodes，所以它不会参与平移。
     ====================================================================== */

  /** 菜单里的可点条目（顺序即显示顺序 = 键盘顺序） */
  function menuItems() {
    return menuState.el ? u.$$('.hs-fav-menu-btn', menuState.el) : [];
  }

  /** 只建一次骨架：之后每次打开只改文案 / 位置 / 可见性 */
  function buildMenu() {
    if (menuState.el) return menuState.el;
    var ov = fm.v.overlay;
    if (!ov) return null;
    var el = u.el('div', {
      id: 'fav-menu', class: 'hs-fav-menu', role: 'group', hidden: true,
      'aria-label': '作品操作'
    }, MENU_HTML);
    el.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-mact]') : null;
      var r = menuState.record;
      if (!r) return;
      if (b) runMenuAct(b.getAttribute('data-mact'), r);
      else if (e.target === el) return;               /* 点在面板留白上：不关 */
    });
    /* 键盘：↑↓/Home/End 在条目间移动，Tab 交由浏览器（默认顺序 = DOM 顺序），Esc 退 */
    el.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        hideMenu(true);
        return;
      }
      var last = e.key === 'ArrowUp' || e.key === 'Up' || e.key === 'ArrowDown' || e.key === 'Down' ||
        e.key === 'Home' || e.key === 'End';
      if (!last) return;
      var list = menuItems();
      if (!list.length) return;
      e.preventDefault();
      var i = list.indexOf(document.activeElement);
      var n = list.length;
      var to;
      if (e.key === 'Home') to = 0;
      else if (e.key === 'End') to = n - 1;
      else if (e.key === 'ArrowDown' || e.key === 'Down') to = (i < 0 ? 0 : (i + 1) % n);
      else to = (i < 0 ? n - 1 : (i - 1 + n) % n);
      list[to].focus();
    });
    ov.appendChild(el);
    menuState.el = el;
    return el;
  }

  /** 贴着节点摆：优先贴它左边外侧（作品节点是叶子，左边永远是空的），再夹进窗口 */
  function placeMenu(node, rect) {
    var el = menuState.el;
    if (!el) return;
    el.style.left = '0px';
    el.style.top = '0px';
    var mw = el.offsetWidth || 200;
    var mh = el.offsetHeight || 140;
    var vw = document.documentElement.clientWidth || window.innerWidth || 0;
    var vh = document.documentElement.clientHeight || window.innerHeight || 0;
    var gap = 10, pad = 8;
    var left = rect.right + gap;
    if (left + mw > vw - pad) left = rect.left - mw - gap;    /* 右侧放不下就翻到左边 */
    if (left + mw > vw - pad) left = vw - pad - mw;           /* 还放不下就贴右沿 */
    if (left < pad) left = pad;
    var top = rect.top;
    if (top + mh > vh - pad) top = vh - pad - mh;
    if (top < pad) top = pad;
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
  }

  /** 开菜单；node = 被点的 .hs-fav-node 元素，rec = 对应收藏记录 */
  function openMenu(node, rec) {
    if (!rec || !isOpen()) return;
    var el = buildMenu();
    if (!el) return;
    menuState.open = true;
    menuState.record = rec;
    menuState.node = node || null;
    menuState.trig = node || null;
    menuState.gen++;
    if (node) {
      node.classList.add('is-menu');
      node.setAttribute('aria-expanded', 'true');
    }
    var tit = u.$('.hs-fav-menu-title', el);
    if (tit) {
      tit.textContent = rec.title || '未命名';
      tit.title = rec.title || '';
    }
    var read = u.$('[data-mact="read"] .hs-fav-menu-label', el);
    if (read) {
      read.textContent = (HS.reader && HS.reader.supports && HS.reader.supports(rec.source))
        ? '在线阅读' : '打开原站';
    }
    var del = u.$('[data-mact="del"]', el);
    if (del) del.hidden = !index[rec.k];        /* 详情页里已经取消过收藏 → 不装作还能删 */
    var hint = u.$('.hs-fav-menu-hint', el);
    if (hint) { hint.hidden = true; hint.textContent = ''; }   /* 上一次的「不在结果里」留言不留到这次 */
    el.hidden = false;
    placeMenu(node, el.getBoundingClientRect ? node.getBoundingClientRect() : { left: 0, top: 0 });
    /* 焦点进第一项：键盘用户不必先 Tab 找；鼠标用户看不出差别（无 is-on 样式） */
    var list = menuItems();
    if (list.length && list[0].focus) list[0].focus();
  }

  /** 关菜单。giveFocus = true 时把焦点还给刚才那个节点 */
  function hideMenu(giveFocus) {
    if (!menuState.el) return;                   /* 从没建过：什么都不用做 */
    if (!menuState.open && menuState.el.hidden && !menuState.node) return;
    menuState.open = false;
    menuState.record = null;
    menuState.gen++;
    var node = menuState.node;
    if (menuState.el) {
      menuState.el.hidden = true;
      if (menuState.el.contains(document.activeElement)) {
        try { document.activeElement.blur(); } catch (e) {}
      }
    }
    if (node) {
      node.classList.remove('is-menu');
      node.setAttribute('aria-expanded', 'false');
    }
    if (giveFocus && node && node.focus && node.isConnected) {
      try { node.focus(); } catch (e) {}
    }
    menuState.node = null;
    menuState.trig = null;
  }

  /* ---- 三条动作 ---- */

  /** ① 在线阅读：支持就地进阅读器；不支持就明说原因，再开原站（原站也没有就只提示） */
  function actRead(r) {
    if (HS.reader && HS.reader.supports && HS.reader.supports(r.source)) {
      hideMenu(false);
      if (HS.reader.open) { HS.reader.open(toItem(r)); return; }
    }
    if (!r.url) { HS.toast('这条收藏没有可打开的地址', 'warn', 2600); return; }
    HS.toast('这个来源不支持站内阅读，已为你打开原站', 'info', 2400);
    try { window.open(r.url, '_blank', 'noopener,noreferrer'); }
    catch (e) { HS.toast('浏览器拦下了新标签，请手动打开原站', 'warn', 2600); }
  }

  /** ② 删除收藏：删数据 + 立刻重渲这一枝 + 计数 / 小卡片爱心同步（全走 fav:change） */
  function actDel(r) {
    if (!index[r.k]) { hideMenu(true); return; }
    var key = r.k;
    hideMenu(false);
    remove(key, false);                       /* 内部 emit fav:change → paintCount + render + 卡片同步 */
    HS.toast('已取消收藏', 'info', 1600);
  }

  /** ③ 查看详细信息：复用应用既有的放大器，不新造详情 UI（见下面 findCard 的说明） */
  function actInfo(r) {
    var el = menuState.el;
    var warn = null;
    if (el) warn = u.$('.hs-fav-menu-hint', el);
    var card = findCard(r);
    if (!card) {
      if (warn) {
        warn.textContent = '这件作品不在当前结果列表里，无法用放大器查看；会话内仍可在结果页找到它。';
        warn.hidden = false;
      } else {
        HS.toast('这件作品不在当前结果列表里，无法查看详细信息', 'warn', 3000);
      }
      return;
    }
    hideMenu(false);
    /* 关掉星图但不动叠加层 class（浮层带 backdrop-filter，是 containing block——
       留着它，放大器的 width:min(92vw,980px) 会被算成视口宽度的 92%，定位就跑偏了） */
    var ov = fm.v.overlay;
    if (ov) ov.hidden = true;
    /* 用真 click 走 results.js 的既有委托入口（那是这张卡片唯一的公开入口）：既复用
       它那套放大动画 / 详情排版 / 收藏接线，也不用碰 results.js 一行代码。 */
    var body = u.$('.hs-card-body', card) || card;
    try {
      body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } catch (e) {
      try { body.click(); } catch (e2) { HS.toast('打开详细信息失败', 'warn', 2400); }
    }
    /* 放大器停在浮层之上（z 260 vs 320）→ 由它自己接管画面；这里顺带把浮层的节点卸掉 */
    fm.c.nodes.innerHTML = '';
    fm.c.edges.innerHTML = '';
    fm.map = {};
    fm.tree = null;
    var chip2 = u.$('#fav-chip');
    if (chip2) chip2.setAttribute('aria-expanded', 'false');
    HS.toast('已打开详细信息，Esc 或关闭按钮返回', 'info', 2200);
  }

  /** 在结果网格里找这件作品的小卡片。
      ★ 卡片上的 data-key 是**归一化标题**（results.js 的 it.key || it.id），收藏记录的主键却是
      "<source>:<id>" —— 两者通常不同，所以这里按两个主键都找一遍，再退到「同源同 id」比对。
      找不到只可能是它不在当前结果里（已换检索 / 没滚动到），那时如实提示，不假装能看。 */
  function findCard(r) {
    if (!r) return null;
    var want = [r.k, r.tk, r.id].filter(Boolean);
    var list = u.$$('#results-grid .hs-card');
    var i, k, card, key;
    for (i = 0; i < list.length; i++) {
      card = list[i];
      key = card.getAttribute('data-key');
      for (k = 0; k < want.length; k++) if (key === want[k]) return card;
    }
    /* 退一步：卡片对象本身带着原始条目时，直接比 source + id */
    for (i = 0; i < list.length; i++) {
      card = list[i];
      var it = card.__item;
      if (it && it.source === r.source && String(it.id || '') === String(r.id || '')) return card;
    }
    return null;
  }

  function runMenuAct(act, r) {
    if (!r) { hideMenu(true); return; }
    if (act === 'read') { actRead(r); return; }
    if (act === 'del') { actDel(r); return; }
    if (act === 'info') { actInfo(r); return; }
    hideMenu(true);
  }

  function toggleCollapse(id) {
    if (!id || id === 'root') return;
    var node = fm.map[id] ? fm.map[id].__node : null;
    var open;
    if (node && node.children && node.children.length) {
      open = node.expanded === false;
      node.expanded = open;
      node.collapsed = !open;
    } else {
      open = !!uiCollapsed[id];
    }
    if (open) delete uiCollapsed[id]; else uiCollapsed[id] = 1;
    syncUI();
    /* 把被点的那个节点拉回原来的视口位置，视线不跳 */
    var snap = null;
    var el = fm.map[id];
    if (el) snap = { id: id, r: el.getBoundingClientRect() };
    fm.tree = buildTree(fm.dim);
    render({ snap: snap });
  }

  /* ---------------- 渲染 ---------------- */
  function buildEl(n) {
    var isGroup = !!(n.children && n.children.length);
    var el = u.el('div', {
      class: 'hs-fav-node' + (isGroup ? ' is-group' : ''),
      'data-node': n.id
    });
    el.__node = n;
    el.__group = isGroup;
    if (isGroup) {
      var kids = n.children.length;
      var open = n.expanded !== false;
      el.appendChild(u.el('button', {
        class: 'hs-fav-tog' + (open ? ' is-open' : ''), type: 'button',
        'data-node': n.id, 'aria-expanded': open ? 'true' : 'false',
        title: (open ? '折叠这一枝（' : '展开这一枝（') + kids + '）',
        'aria-label': (open ? '折叠 ' : '展开 ') + n.topic
      }, '<i aria-hidden="true"></i>'));
      el.setAttribute('role', 'button');
      el.tabIndex = 0;
    } else {
      if (n.image && n.image.url) {
        var img = u.el('img', {
          /* eager：同 results.js 的卡片封面 —— loading="lazy" 在「文档不在前台」时
             会被 Chrome 推迟 load 事件（请求照发、就是不绘制），收藏列表就会整片空白。 */
          alt: '', loading: 'eager', decoding: 'async',
          referrerpolicy: 'no-referrer', src: String(n.image.url)
        });
        img.addEventListener('error', function () {
          var ph = u.placeholder(n.topic, n.payload && n.payload.k);
          if (img.getAttribute('src') !== ph) img.src = ph;
        });
        el.appendChild(img);
      } else {
        el.appendChild(u.el('span', { class: 'hs-fav-thumb', 'aria-hidden': 'true' },
          u.esc(String(n.topic || '?').trim().slice(0, 2) || '?')));
      }
      el.appendChild(u.el('span', { class: 'hs-fav-node-topic', title: n.topic }, u.esc(n.topic)));
      if (n.payload) el.setAttribute('data-key', n.payload.k);
      /* 作品节点同样可聚焦 / 可回车：Enter 打开操作菜单（见 bindGestures 的 keydown） */
      el.setAttribute('role', 'button');
      el.setAttribute('aria-haspopup', 'true');
      el.setAttribute('aria-expanded', 'false');
      el.tabIndex = 0;
      if (n.topic) {
        el.setAttribute('aria-label', String(n.topic).slice(0, 80) + '，操作菜单');
        el.title = '点一下：在线阅读 / 删除收藏 / 查看详细信息（点两次收起）';
      }
    }
    return el;
  }

  function render(opts) {
    if (!fm.tree || !fm.c.nodes) return;
    opts = opts || {};
    var snap = opts.snap || null;
    fm.c.nodes.innerHTML = '';
    fm.map = {};
    var order = [];

    (function collect(n, depth) {
      if (n !== fm.tree && n.expanded === false) n.collapsed = true;
      var el = buildEl(n, depth);
      fm.c.nodes.appendChild(el);
      n._el = el;
      fm.map[n.id] = el;
      order.push(n);
      if (!n.collapsed) (n.children || []).forEach(function (c) { collect(c, depth + 1); });
    })(fm.tree, 0);

    layout(fm.tree, fm.map);
    fm.c.canvas.style.width = fm.bw + 'px';
    fm.c.canvas.style.height = fm.bh + 'px';
    fm.c.edges.setAttribute('width', fm.bw);
    fm.c.edges.setAttribute('height', fm.bh);
    fm.c.edges.setAttribute('viewBox', '0 0 ' + fm.bw + ' ' + fm.bh);

    var paths = [];
    order.forEach(function (n) {
      var e = fm.map[n.id];
      e.style.transform = 'translate(' + Math.round(n._x) + 'px,' + Math.round(n._y) + 'px)';
      if (n.collapsed) return;
      (n.children || []).forEach(function (c) {
        if (!fm.map[c.id]) return;
        var x1 = n._x + n._w, y1 = n._y + n._h / 2;
        var x2 = c._x, y2 = c._y + c._h / 2;
        var mx = (x1 + x2) / 2;
        paths.push('M' + x1 + ',' + y1 + 'C' + mx + ',' + y1 + ' ' + mx + ',' + y2 + ' ' + x2 + ',' + y2);
      });
    });
    fm.c.edges.innerHTML = paths.length
      ? '<path class="hs-fav-edge" fill="none" stroke="var(--border-strong)" stroke-width="1.5" ' +
        'vector-effect="non-scaling-stroke" d="' + paths.join(' ') + '"/>'
      : '';

    if (snap) {
      var ne = fm.map[snap.id];
      if (ne) {
        var r2 = ne.getBoundingClientRect();
        fm.tx += (snap.r.left + snap.r.width / 2) - (r2.left + r2.width / 2);
        fm.ty += (snap.r.top + snap.r.height / 2) - (r2.top + r2.height / 2);
      }
      apply();
    } else if (opts.fit) {
      fit();
    }
  }

  /* ======================================================================
     四、卡片 / 放大器上的爱心按钮
     ====================================================================== */
  var ownerMap = null;

  /** 复用 DOM 的卡片上，判断按钮还绑不绑当前条目（只比较对象身份，不读盘） */
  function bindOwner(btn, it) {
    if (!ownerMap) { try { ownerMap = new WeakMap(); } catch (e) { ownerMap = null; } }
    if (ownerMap && ownerMap.get(btn) !== it) { btn.__favItem = it; ownerMap.set(btn, it); }
    if (!ownerMap) btn.__favItem = it;
  }

  /** 画按钮：只读地按当前收藏态改 class / aria / 文案，不绑定任何行为 */
  function paintFavBtn(btn, labelEl) {
    if (!btn || !btn.__favItem) return;
    var it = btn.__favItem;
    var key = keyOf(it);
    var on = !!(key && index[key]);
    btn.setAttribute('data-fav', key);
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    var tip = on ? '取消收藏' : '收藏';
    btn.setAttribute('title', tip);
    btn.setAttribute('aria-label', tip + (it.title ? '：' + String(it.title).slice(0, 60) : ''));
    if (labelEl) labelEl.textContent = on ? '已收藏' : '收藏';
  }

  /** 卡片动作区的补位：让「在线阅读 / 打开原站」保持在最左、爱心排在它后面。
      不能在 makeCardBtn 里直接插好（那时还没有父元素：动作区由调用方 results.js 决定，
      爱心是它 append 进去的第一个孩子），也不能等卡片挂网后再挪（会闪一下）。
      所以顺序是：makeCardBtn 把爱心记进待办队列 → MutationObserver 在同一轮 DOM 构建
      结束、卡片挂网之前把它挪到第一个非爱心按钮之后（那时动作区里恰好是 [爱心, 在线阅读]）
      → 万一这张卡没有主按钮，宏任务兜底按现有顺序落位。 */

  /** 把爱心挪到第一个非爱心按钮之后；已经在该位置就原地不动 */
  function placeFavBtn(b) {
    var parent = b.parentNode;
    if (!parent) return;
    var list = Array.prototype.slice.call(parent.children || []);
    var seen = [], idx = {}, target = [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var key = (el === b) ? 'b' : ('c' + i);
      target.push(key);
      seen.push(key);
      idx[key] = i;
    }
    var anchor = null;
    for (var j = 0; j < target.length; j++) {
      if (target[j] !== 'b') { anchor = target[j]; break; }
    }
    if (!anchor) return;                                  /* 动作区里只有爱心：无处可挪 */
    target.splice(target.indexOf('b'), 1);
    target.splice(target.indexOf(anchor) + 1, 0, 'b');     /* 目标：紧跟第一个非爱心按钮 */
    var same = true;
    for (var k = 0; k < target.length; k++) if (target[k] !== seen[k]) { same = false; break; }
    if (same) return;                                     /* 已经在位（例如第二次进这个函数） */
    b.remove();
    if (target.indexOf('b') >= target.length - 1) parent.appendChild(b);
    else {
      var nextKey = target[target.indexOf('b') + 1];
      parent.insertBefore(b, list[idx[nextKey]]);
    }
  }

  /** 小卡片动作区里的爱心按钮（排在「在线阅读 / 打开原站」之后、其余图标按钮之前） */
  function makeCardBtnInner(it) {
    var b = u.el('button', {
      class: 'hs-btn hs-btn-ico hs-btn-fav', type: 'button', 'data-fav': keyOf(it)
    }, HEART);
    b.__favItem = it;
    paintFavBtn(b, null);
    b.addEventListener('click', function (ev) {
      /* 必须拦住冒泡：#results-grid 的单击委托就是「点卡片 = 放大」，不拦会顺手弹出放大器 */
      ev.preventDefault();
      ev.stopPropagation();
      HS.fav.toggle(b.__favItem);
      paintFavBtn(b, null);
    });
    return b;
  }

  /** 待补位的爱心队列：一张卡一个，绝不用单变量（动作区是一个接一个建的，
      单变量会让「后一张卡」把「前一张卡」的待办顶掉，前一张就漏补位）。 */
  var pendingFav = [];

  /** 把某个待办爱心按当前动作区顺序落位 */
  function flushFav(b) {
    var i = pendingFav.indexOf(b);
    if (i < 0) return;
    pendingFav.splice(i, 1);
    placeFavBtn(b);
  }

  /**
   * 小卡片动作区里的爱心按钮。
   * ★ 它必须是**动作区的最后一个孩子之前**（即紧跟在「在线阅读 / 打开原站」之后）★
   * results.js 决定动作区里元素的顺序，而它把爱心 append 在最前、主按钮 append 在第二。
   * 于是：本次调用把爱心记进待办队列，并挂一个宏任务兜底，等主按钮进来（MutationObserver
   * 回调，早于 rAF / paint）就把它挪到主按钮后面；确实没有主按钮的卡片，宏任务里按现有顺序落位。
   */
  function makeCardBtn(it) {
    var b = makeCardBtnInner(it);
    pendingFav.push(b);
    window.setTimeout(function () { flushFav(b); }, 0);
    return b;
  }

  function armCardReorder() {
    if (armCardReorder._on || typeof MutationObserver !== 'function') return;
    armCardReorder._on = 1;
    try {
      var mo = new MutationObserver(function () {
        if (!pendingFav.length) return;
        pendingFav.slice().forEach(function (b) {
          var i = pendingFav.indexOf(b);
          if (i < 0) return;
          var parent = b.parentNode;
          if (!parent) return;               /* 还没插进动作区，等下一次回调 */
          /* 只有「第一个非爱心按钮」也进来了才动手：那一刻动作区里是 [爱心, 在线阅读] */
          var list = parent.children, anchor = null;
          for (var k = 0; k < list.length; k++) {
            if (list[k] !== b && list[k].classList && list[k].classList.contains('hs-btn') &&
              !list[k].classList.contains('hs-btn-fav')) { anchor = list[k]; break; }
          }
          if (!anchor) return;
          pendingFav.splice(i, 1);
          placeFavBtn(b);
        });
      });
      mo.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch (e) { /* 观察器不可用：保持 DOM 原序（爱心最左），功能不受影响 */ }
  }

  /** 放大器动作区里的收藏按钮：results.js 在 openCard() 里调用本入口做接线 */
  function wireModal(btn, cm) {
    if (!btn) return;
    if (!btn.__favWired) {
      btn.__favWired = 1;
      btn.innerHTML = '<span class="hs-fav-label">收藏</span>';
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (cm && cm.__item) HS.fav.toggle(cm.__item);
        paintFavBtn(btn, u.$('.hs-fav-label', btn));
      });
    }
    if (cm && cm.__item) {
      bindOwner(btn, cm.__item);
      paintFavBtn(btn, u.$('.hs-fav-label', btn));
    }
  }

  /* ======================================================================
     五、浮层与顶栏编排
     ====================================================================== */
  function buildStructure() {
    var app = u.$('#hs-app');
    if (!app) return false;

    /* 顶栏入口：插在 .hs-top-actions 的第一个位置 */
    if (!u.$('#fav-chip')) {
      var actions = u.$('.hs-top-actions');
      if (actions) {
        actions.insertBefore(u.el('button', {
          id: 'fav-chip', class: 'hs-chip', type: 'button',
          title: '收藏星图（快捷键 F）',
          'aria-haspopup': 'dialog', 'aria-expanded': 'false'
        },
          '<span class="hs-fav-heart" aria-hidden="true"></span>' +
          '<span class="hs-chip-label">收藏</span>' +
          '<span id="fav-count" class="hs-chip-state">0</span>'), actions.firstChild);
      }
    }

    /* 浮层：放进 #hs-app（遮蔽的 blur 作用域），紧邻其它浮层 */
    if (!u.$('#fav-overlay')) {
      var dims = DIMS.map(function (d) {
        return '<button type="button" data-dim="' + d.id + '" data-v="' + d.id +
          '" aria-pressed="false">' + u.esc(d.label) + '</button>';
      }).join('');
      var ov = u.el('div', {
        id: 'fav-overlay', class: 'hs-fav', hidden: true,
        role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'fav-title'
      },
        '<div class="hs-fav-head">' +
          '<span class="hs-fav-heart hs-fav-head-ico" aria-hidden="true"></span>' +
          '<b id="fav-title">收藏星图</b>' +
          '<span id="fav-stat" class="hs-fav-stat">0 件</span>' +
          '<span class="hs-fav-spacer"></span>' +
          '<div id="fav-dims" class="hs-seg" role="group" aria-label="分组维度">' + dims + '</div>' +
          '<button id="fav-fit" class="hs-btn hs-btn-ghost" type="button">适应窗口</button>' +
          '<button id="fav-export" class="hs-btn hs-btn-ghost" type="button">导出</button>' +
          '<button id="fav-import" class="hs-btn hs-btn-ghost" type="button">导入</button>' +
          '<button id="fav-clear" class="hs-btn hs-btn-ghost" type="button">清空</button>' +
          '<button id="fav-close" class="hs-icon-btn" type="button" aria-label="关闭收藏星图">' +
            HS.icon.close + '</button>' +
        '</div>' +
        '<div id="fav-view" class="hs-fav-view" tabindex="-1">' +
          '<div id="fav-canvas" class="hs-fav-canvas">' +
            '<svg id="fav-edges" class="hs-fav-edges" aria-hidden="true"></svg>' +
            '<div id="fav-nodes" class="hs-fav-nodes"></div>' +
          '</div>' +
          '<p class="hs-fav-hint">拖动平移 · 滚轮 / 双指缩放 · 点 +/− 折叠 · 点作品节点出菜单 · Esc 关闭</p>' +
          '<div id="fav-empty" class="hs-empty" hidden></div>' +
        '</div>');
      var foot = u.$('#hs-app > .hs-foot');
      var main = u.$('#hs-app > main');
      if (foot && foot.parentNode === app) app.insertBefore(ov, foot);
      else if (main && main.parentNode === app) app.insertBefore(ov, main.nextSibling);
      else app.appendChild(ov);
      /* 浮层上的点击：数据来自 buildMenu()，菜单固定定位在浮层之上（z-index 6 > 画布的 2），
         点菜单里的任何地方都到不了这里，不用额外判断 */
      ov.addEventListener('click', function (e) {
        var act = e.target.closest ? e.target.closest('[data-fav-act]') : null;
        if (act) { closeView(); return; }
        /* 点空白也能关 —— 但必须是「按下到松开没有位移」的那一下单击：
           窗口 / 视口 / 画布上拖完手一松，浏览器一样会补发 click，那时不能关（①的修复）。 */
        var blank = (e.target === ov || e.target === fm.v.view || e.target === fm.c.canvas);
        if (!blank || isDrag()) return;
        if (menuOpen()) hideMenu(false);            /* 单击空白：先收菜单，再收浮层 */
        closeView();
      });
    }
    return true;
  }

  function paintDim() {
    u.$$('#fav-dims [data-dim]').forEach(function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-dim') === fm.dim ? 'true' : 'false');
    });
  }

  function paintCount() {
    var n = count();
    var c = u.$('#fav-count');
    if (c) c.textContent = String(n);
    var chip = u.$('#fav-chip');
    if (chip) chip.classList.toggle('is-empty', n === 0);
    var st = u.$('#fav-stat');
    if (st) st.textContent = n + ' 件';
    var empty = u.$('#fav-empty');
    var view = u.$('#fav-view');
    if (empty && view) {
      var none = n === 0;
      empty.hidden = !none;
      view.classList.toggle('is-emptyview', none);
      if (none) {
        empty.innerHTML = '<b>还没有收藏</b>在结果卡片上点一下爱心，作品就会挂到这棵星图里。' +
          '<div class="hs-empty-actions">' +
          '<button class="hs-btn hs-btn-ghost" type="button" data-fav-act="close">回到结果</button>' +
          '</div>';
      }
    }
  }

  function openView() {
    if (!fm.v.overlay) return;
    if (menuOpen()) hideMenu(false);
    fm.v.overlay.hidden = false;
    fm.v.overlay.classList.add('hs-fav-in');
    window.setTimeout(function () {
      if (fm.v.overlay) fm.v.overlay.classList.remove('hs-fav-in');
    }, 280);
    var chip = u.$('#fav-chip');
    if (chip) chip.setAttribute('aria-expanded', 'true');
    fm.tree = buildTree(fm.dim);
    render({ fit: true });
    if (fm.v.view.focus) fm.v.view.focus();
    /* 首帧量尺寸更准：再适应一次窗口（幂等） */
    window.requestAnimationFrame(function () {
      if (isOpen()) render({ fit: true });
    });
  }

  function closeView() {
    if (!fm.v.overlay || fm.v.overlay.hidden) return;
    var inMenu = menuOpen() && menuState.el && menuState.el.contains(document.activeElement);
    hideMenu(false);                            /* 菜单跟着浮层一起收，否则会留在屏幕上 */
    fm.v.overlay.hidden = true;
    /* 关掉就释放大量节点，省内存；折叠状态已经写进 db.ui，留着 */
    fm.c.nodes.innerHTML = '';
    fm.c.edges.innerHTML = '';
    fm.map = {};
    fm.tree = null;
    var chip = u.$('#fav-chip');
    if (chip) {
      chip.setAttribute('aria-expanded', 'false');
      /* 焦点还给入口：只有焦点原本在浮层里时才抢（点空白关闭时用户已经点在别处了） */
      if (chip.focus && (inMenu || !document.activeElement ||
        document.activeElement === fm.v.view || fm.v.overlay.contains(document.activeElement))) {
        chip.focus();
      }
    }
  }

  /* ---------------- 导出 / 导入 / 清空 ---------------- */
  function stamp() {
    var d = new Date();
    function p(n) { return ('0' + n).slice(-2); }
    return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
  }

  function doExport() {
    try {
      var blob = new Blob([exportJSON()], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = u.el('a', { href: url, download: 'hentai-search-favorites-' + stamp() + '.json' });
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      HS.toast('已导出 ' + count() + ' 条收藏', 'ok', 2200);
    } catch (e) { HS.toast('导出失败：浏览器不支持本地文件导出', 'warn', 3000); }
  }

  function doImport() {
    if (!window.FileReader) { HS.toast('这个浏览器不支持读取本地文件', 'warn'); return; }
    var input = u.el('input', { type: 'file', accept: '.json,application/json' });
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      input.remove();
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        var res = importJSON(fr.result);
        if (!res.ok) { HS.toast('导入失败：文件不是有效的收藏 JSON', 'warn', 3200); return; }
        HS.toast('导入完成：新增 ' + res.added + ' 条，跳过 ' + res.skipped + ' 条', 'ok', 3200);
      };
      fr.onerror = function () { HS.toast('读取文件失败', 'warn'); };
      fr.readAsText(f);
    });
    document.body.appendChild(input);
    input.click();
  }

  function doClear() {
    var n = count();
    if (!n) { HS.toast('还没有收藏', 'info', 1600); return; }
    if (!window.confirm('清空全部 ' + n + ' 条收藏？此操作不可撤销（建议先导出）。')) return;
    clearAll();
    HS.toast('已清空收藏', 'ok', 2000);
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    loadDB();
    rebuild();
    /* 折叠缺省：收藏很多时分组默认收起（状态落在 ui 里，不靠渲染层每次猜） */
    if (!Array.isArray(db.ui.collapsed)) {
      db.ui.collapsed = (count() > DEF_COLLAPSE_OVER) ? groupIdsOf(records(), db.ui.dim || 'source') : [];
      lsSet(SKEY, serialize());
    }
    fm.dim = (db.ui.dim === 'artist' || db.ui.dim === 'time' || db.ui.dim === 'tag')
      ? db.ui.dim : 'source';
    uiCollapsed = {};
    (db.ui.collapsed || []).forEach(function (id) { if (id) uiCollapsed[id] = 1; });

    if (!buildStructure()) return;

    fm.v.overlay = u.$('#fav-overlay');
    fm.v.view = u.$('#fav-view');
    fm.c.canvas = u.$('#fav-canvas');
    fm.c.edges = u.$('#fav-edges');
    fm.c.nodes = u.$('#fav-nodes');
    if (!fm.v.overlay || !fm.v.view || !fm.c.canvas || !fm.c.edges || !fm.c.nodes) return;

    paintDim();
    paintCount();

    var chip = u.$('#fav-chip');
    if (chip) chip.addEventListener('click', openView);
    var closeBtn = u.$('#fav-close');
    if (closeBtn) closeBtn.addEventListener('click', closeView);
    var fitBtn = u.$('#fav-fit');
    if (fitBtn) fitBtn.addEventListener('click', fit);
    var exBtn = u.$('#fav-export');
    if (exBtn) exBtn.addEventListener('click', doExport);
    var imBtn = u.$('#fav-import');
    if (imBtn) imBtn.addEventListener('click', doImport);
    var clBtn = u.$('#fav-clear');
    if (clBtn) clBtn.addEventListener('click', doClear);

    var dimBox = u.$('#fav-dims');
    if (dimBox) {
      dimBox.addEventListener('click', function (e) {
        var b = e.target.closest ? e.target.closest('[data-dim]') : null;
        if (!b) return;
        var d = b.getAttribute('data-dim');
        if (d === fm.dim) return;
        fm.dim = d;
        db.ui.dim = d;
        harvestCollapsed(fm.tree);
        syncUI();
        paintDim();
        fm.tree = buildTree(d);
        render({ fit: true });
      });
    }

    /* 键盘：Esc 关菜单 / 关浮层（先于其它模块的 Esc 处理，避免顺带关筛选面板 / 放大器）；
       F 打开浮层（无修饰键、不在输入框里、阅读器没开着时） */
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (!isOpen()) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        /* Esc 分两层：焦点或菜单在菜单里 → 先只收菜单，浮层留着（键盘用户不会一次丢两层） */
        if (menuOpen() && (inMenu(document.activeElement) || inMenu(e.target))) {
          hideMenu(true);
          return;
        }
        closeView();
        return;
      }
      if (e.key !== 'f' && e.key !== 'F') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      var t = e.target;
      var tag = (t && t.tagName) ? String(t.tagName).toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable)) return;
      if (HS.reader && HS.reader.isOpen && HS.reader.isOpen()) return;
      if (isOpen()) { closeView(); return; }
      e.preventDefault();
      openView();
    });

    window.addEventListener('resize', u.debounce(function () {
      if (isOpen()) render({ fit: true });
    }, 180));

    bindGestures();
    armCardReorder();       /* 爱心在动作区排到「在线阅读 / 打开原站」之后（③） */

    /* 菜单的全局收起 / 手势兜底：按到浮层之外时收菜单，顺手把可能留下的抓取光标清掉 */
    document.addEventListener('pointerdown', function (e) {
      if (!fm.nPts && fm.v.view) fm.v.view.classList.remove('is-drag');
      if (!menuOpen()) return;
      if (fm.v.overlay && fm.v.overlay.contains(e.target)) return;   /* 浮层内：交给视口那一下 */
      hideMenu(false);
    }, true);
    document.addEventListener('pointerup', function (e) {
      if (!fm.pts[e.pointerId] && fm.v.view) fm.v.view.classList.remove('is-drag');
    }, true);
    window.addEventListener('blur', function () { if (menuOpen()) hideMenu(false); });
    window.addEventListener('resize', function () { if (menuOpen()) hideMenu(false); });
    window.addEventListener('scroll', function () { if (menuOpen()) hideMenu(false); }, true);

    wireModal(u.$('[data-cm-fav]'), u.$('#card-modal'));

    HS.bus.on('fav:change', function () {
      paintCount();
      HS.fav.sync();
      /* 记录对象在删除后仍然会被菜单引用：只要它已经不在索引里，菜单就不该再留着 */
      if (menuOpen() && menuState.record && !index[menuState.record.k]) hideMenu(true);
      if (isOpen()) { fm.tree = buildTree(fm.dim); render(); }
    });
    /* 主题切换靠 CSS 变量自动跟随（这里只需保证尺寸量得准，无需重渲） */
    HS.bus.on('theme:set', function () { if (isOpen()) fit(); });
  }

  /* ======================================================================
     六、对外 API（只读口为主；results.js 只用 id / has / toggle / makeCardBtn）
     ====================================================================== */
  var F = HS.fav = {
    HEART: HEART,
    DIMS: DIMS,
    KEY: SKEY,
    VERSION: FVER,
    MAX: MAX,

    id: function (it) { return keyOf(it); },
    has: function (it) { return !!recOf(it); },
    get: function (key) { return index[key] || null; },
    list: records,
    count: count,
    tree: buildTree,
    export: exportJSON,
    import: importJSON,
    clear: clearAll,
    dims: function () { return DIMS.slice(); },
    isOpen: isOpen,
    open: openView,
    close: closeView,
    init: init,

    toggle: function (it) {
      var r = norm(it);
      if (!r) { HS.toast('该条目缺少标识，无法收藏', 'warn', 2600); return false; }
      if (index[r.k]) {
        remove(r.k, false);
        HS.toast('已取消收藏', 'info', 1400);
        return false;
      }
      add(it, false, 0);
      return !!index[r.k];
    },
    add: function (it) { return add(it, false, 0); },
    remove: function (key) { return remove(key, false); },

      /** 重扫 DOM，把所有 [data-fav] 按钮刷成当前收藏态（复用旧卡片后必须调） */
    sync: function (root) {
      u.$$('[data-fav]', root || document).forEach(function (b) {
        if (!b.closest('.hs-card') && !b.closest('.hs-cm')) return;
        /* 卡片 DOM 会按标题键复用：万一换上来的是同 key 的另一条（跨源合并换了代表条目），
           按钮里绑的条目就得跟着换，否则爱心会指着已经不在列表里的那条。 */
        var card = b.closest('.hs-card');
        if (card && card.__item && card.__item !== b.__favItem) bindOwner(b, card.__item);
        var cm = b.closest('.hs-cm');
        if (cm && cm.__item && cm.__item !== b.__favItem) bindOwner(b, cm.__item);
        if (!b.__favItem) return;
        paintFavBtn(b, u.$('.hs-fav-label', b));
      });
    },

    /* results.js 的接线口（卡片构建 / 放大器） */
    makeCardBtn: makeCardBtn,
    ownerOf: bindOwner,
    paintBtn: paintFavBtn,
    wireModal: wireModal,

    /* 只读调试口：布局尺寸 / 缩放 / 折叠 / 菜单 / 拖拽状态一次读出 */
    debug: function () {
      return {
        v: FVER, key: SKEY, dim: fm.dim, count: count(), open: isOpen(),
        k: Math.round(fm.k * 1000) / 1000, tx: Math.round(fm.tx), ty: Math.round(fm.ty),
        canvas: [fm.bw, fm.bh], nodes: Object.keys(fm.map).length,
        collapsed: Object.keys(uiCollapsed), dims: DIMS.map(function (d) { return d.id; }),
        menu: menuOpen(), drag: isDrag(), moved: Math.round(fm.moved)
      };
    }
  };

})();
