/* ==========================================================================
   reader.js — 阶段一 · 在线阅读器
   · 全屏覆盖层（惰性创建）：顶部工具条 + 纵向连续滚动的图片列 + 底部进度条
   · 三个源：MangaDex（多章）/ nhentai（单章）/ Danbooru（单图）
     页地址由本地网关 /api/reader 提前转成 /api/proxy?...，浏览器不撞防盗链
   · 「自动连读」滚到章末自动接上下一章（仍然插一条章节分隔标题），并预取下一章
   · 打开时 Esc 只关阅读器（results.js 的放大卡片 Esc 处理里会先问 isOpen()）
   ========================================================================== */
(function (HS) {
  'use strict';
  const u = HS.u;
  const RD = HS.reader = {};

  /* 在线阅读的源（与 tools/gateway.js 的 READER_SOURCES 白名单保持一致）。
     jmcomic（禁漫）与 porncomic（porn-comic）都是**真的能读**的源：
       · jmcomic：网关从章节页模板里读到 scramble_id，并按站点自己的算法算好
         每页的分块数（bands）；这里的 loadImg 收到 bands 就用 canvas 还原
         （图片经 /api/proxy 同源取回，canvas 不会被污染）。
       · porncomic：条目页整站前置 Cloudflare，由网关的本机 Chrome 通道过验证；
         正文图在 file*.acgnngca.com，不经 CF。
     两者网关侧失败时都会回 ok:false + 中文原因，前端照常显示原因面板。 */
  const SRC_NAME = {
    mangadex: 'MangaDex', nhentai: 'nhentai', danbooru: 'Danbooru',
    wnacg: '紳士漫畫', ehentai: 'E-Hentai', hitomi: 'Hitomi', pixiv: 'Pixiv',
    copymanga: '拷贝漫画', jmcomic: '禁漫天堂', porncomic: 'porn-comic'
  };
  const HOMEPAGE = {
    mangadex: 'https://mangadex.org/',
    nhentai: 'https://nhentai.net/',
    danbooru: 'https://danbooru.donmai.us/',
    wnacg: 'https://www.wnacg.com/',
    ehentai: 'https://e-hentai.org/',
    hitomi: 'https://hitomi.la/',
    pixiv: 'https://www.pixiv.net/',
    copymanga: 'https://www.copy20.com/',
    jmcomic: 'https://18comic.vip/',
    porncomic: 'https://porn-comic.com/'
  };
  const AUTO_DELAY = 900;      // 滚到章末后等这么久再自动接下一章（给用户一点反悔时间）
  /* 网关没在跑 / 还是旧进程时统一用这句「能直接照做」的中文提示：不只是弹一个
     转瞬即逝的 toast，阅读器自己的错误面板里也会显示（否则看着就像阅读器坏了） */
  const GW_START_HINT = '在线阅读需要本机网关：先在项目目录执行 node tools/gateway.js' +
    '（默认 http://127.0.0.1:8788/），再重新打开阅读器。';

  /* 阅读方向：'v' = 上下连续滚动（默认，纵向），'h' = 左右一次一页（横向）
     按钮上的两个图标照 HS.icon 的画法内联写在这里（不引外部资源） */
  const DIRS = { v: '上下', h: '左右' };
  const ICO_V = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"' +
    ' stroke-linecap="round"><path d="M12 4.2v15.6"/><path d="M7.6 8.6L12 4.2l4.4 4.4"/>' +
    '<path d="M7.6 15.4L12 19.8l4.4-4.4"/></svg>';
  const ICO_H = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"' +
    ' stroke-linecap="round"><path d="M4.2 12h15.6"/><path d="M8.6 7.6L4.2 12l4.4 4.4"/>' +
    '<path d="M15.4 7.6L19.8 12l-4.4 4.4"/></svg>';

  /* 图片缩放：范围 50%–300%，步进 20%（Ctrl/Cmd + + / - / 0 也能用）。
     倍数只驱动 root 上的 CSS 变量 --hs-rd-zoom（图片尺寸由它算出来），
     不写进页码 / 章末判定用的几何量，所以缩放不会动进度与章末逻辑。
     **倍率按作品记忆**：不再是全局一个值 —— 没见过的新作品一律 100%，
     在某作品里改过倍率就记住**那个作品**的（同作品换章共享，见 zoomKeyOf）。 */
  const ZOOM_MIN = 0.5, ZOOM_MAX = 3, ZOOM_STEP = 0.2;

  /* ---- 按作品记忆的缩放：自己的 localStorage 键（不往 HS.settings 里塞新结构） ----
     键 hs.rd.zoom.v1  结构 { v:1, items:{ "<source>:<id>": { z:1.4, t:1699999999999 } } }
       · 主键口径与收藏一致（fav.js 的 norm()）：有 id 就用 "<source>:<id>"；
         没有 id 才退到 url → key（归一化标题）→ title 兜底（见 zoomKeyOf）。
         **chapter 不进主键** —— 同一作品的各章共用一条记录。
       · z = 倍率（50%–300%，两位小数），t = 最后一次写入时间（只用于上限淘汰）。
       · 上限 500 条，超了淘汰 t 最小（最旧）的；写盘失败再丢最旧的一批重试一次。
       · 键不存在 / JSON 损坏 / 结构不对 / 存储不可用（无痕模式、配额满）一律静默降级：
         读回落 100%，写返回 false 且**不影响本次会话里的缩放**，绝不抛。 */
  const ZOOM_KEY = 'hs.rd.zoom.v1';
  const ZOOM_VER = 1;
  const ZOOM_MAX_ITEMS = 500;
  const ZOOM_KEY_MAX = 180;      // 键总长上限（与 fav.js 同口径：个别源的 id 本身就是一条长 href）
  const ZOOM_SUB_MAX = 160;      // id / 兜底串的上限

  /* ---- 按需加载（lazy src）参数 -------------------------------------------
     · 页盒**全部**先渲染成占位盒（宽高比照旧由 --hs-rd-ar 撑住，布局不跳），
       但一开始谁都不带 src。
     · 真正写 src 的只有「当前视口附近」那些页：纵向 = 窗口 [当前页 -NEAR_V,
       当前页 +NEAR_V+2]（往前多留两页，阅读是从上往下走的），横向单页 = 当前页 ±1
       （左右各留一张，翻页几乎瞬时）。
     · 推进加载窗口的**只有一条链**（本文件没有 IntersectionObserver）：
       滚动 → onScroll 的 rAF → schedulePump() → pumpNear()。
       各入口另外显式调一次，不等滚动：RD.open() / jumpChapter() / appendNext()
       负责首屏、切章、自动接续，goToIndex() 负责纵向跳页，onVisible() 负责
       标签页回前台；横向走 paintHPage() → pumpH()。
       历史提醒：这里曾有一套页面观察器（pio），但它只在 loadPage() 里 observe()，
       而同一次调用末尾已经打了 data-loaded，回调必然走早退分支 —— **永远不会真的
       发起一次新加载**；它的 root 还写成纵向并不滚动的 .hs-rd-scroll。已整段删除。
     · 已经加载过的页**不卸载**（S.loaded 记账 + 页盒带 data-loaded）：
       上下回滚时不会重新发起请求、不会闪，也不会因为卸载又把滚动高度改掉。
       代价只是内存里多留几张已看过的图，比来回抖动划算得多。
     · 本地实测（Chromium，隐藏文档）：document.visibilityState === 'hidden' 时
       Chrome 对 loading="lazy" 的图片**推迟 onload** —— 请求照发、200 照记，
       但就是不绘制，表现为「占位盒不换图、计数停在 0 0 页」。这里给按需加载的
       图写 loading="eager" 就是绕开那条路径（加载范围已经由我们自己控住了，
       不需要浏览器再猜），可见文档下行为也更可预期。 */
  const NEAR_V = 3;          // 纵向：当前页上下各提前加载几页
  const NEAR_H = 1;          // 横向：当前页左右各提前加载几页

  let root = null;     // 覆盖层（惰性创建）
  let el = {};         // 覆盖层里的各个节点
  let open = false;
  let io = null;       // 章末观察器
  let rafPending = false;
  let pumpPending = false;
  let autoTimer = null;

  /* 当前这次阅读的全部状态 */
  let S = null;

  RD.supports = function (source) {
    return Object.prototype.hasOwnProperty.call(SRC_NAME, String(source || ''));
  };
  RD.isOpen = function () { return open; };
  RD.current = function () { return open ? S && S.item : null; };

  /* ---------------- 小工具 ---------------- */
  const isTouch = () => !!(window.matchMedia && window.matchMedia('(hover: none)').matches);

  /** 网关在别处（页面不是网关本身提供的）时，给相对代理地址补上网关前缀 */
  function gwAbs(url) {
    const s = String(url || '');
    if (s.indexOf('/api/') !== 0) return s;
    const gw = HS.net && HS.net.gateway;
    if (!gw) return s;
    const base = String(gw.base || (gw.setting && gw.setting()) ||
      ('http://127.0.0.1:' + (gw.DEFAULT_PORT || 8788))).replace(/\/+$/, '');
    return base + s;
  }

  const pageEls = () => (root ? u.$$('.hs-rd-pg', el.pages) : []);
  const chapLabel = i => (S.chapters[i] && S.chapters[i].name) || ('第 ' + (i + 1) + ' 话');

  /** 纵向判定的基准盒子：谁在滚就用谁。
      当前样式下纵向真正滚动的是覆盖层 .hs-rd（.hs-rd-scroll 高度不受限，滚不动），
      拿 .hs-rd 当基准 = 以视口顶部为准，页面滚上去多少就是第几页。 */
  function vRef() {
    if (root && root.scrollHeight > root.clientHeight + 2) return root;
    return el.scroll;
  }

  /** 当前视野里那一页属于第几章（0 基）—— 页元素上带 data-ch */
  function visibleChapter() {
    const list = pageEls();
    if (!list.length) return 0;
    if (isH()) {
      const p = list[currentIndex()];
      return parseInt(p && p.getAttribute('data-ch'), 10) || 0;
    }
    const top = vRef().getBoundingClientRect().top;
    let ch = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i].getBoundingClientRect().top - top < 140) ch = parseInt(list[i].getAttribute('data-ch'), 10) || 0;
      else break;
    }
    return ch;
  }

  /* ---------------- DOM ---------------- */
  function build() {
    root = u.el('div', { class: 'hs-rd', id: 'hs-reader', hidden: true, role: 'dialog', 'aria-modal': 'true' });
    root.innerHTML =
      '<div class="hs-rd-bar" data-rd-bar>' +
        '<button class="hs-icon-btn hs-rd-close" type="button" data-rd-close aria-label="关闭阅读器">' + HS.icon.close + '</button>' +
        '<div class="hs-rd-head">' +
          '<h2 class="hs-rd-title" data-rd-title></h2>' +
          '<div class="hs-rd-sub">' +
            '<span class="hs-rd-src" data-rd-src></span>' +
            '<a class="hs-rd-link" data-rd-home target="_blank" rel="noopener noreferrer">' +
              (HS.icon.ext || '') + '<span>打开原站</span></a>' +
          '</div>' +
        '</div>' +
        '<div class="hs-rd-tools">' +
          /* 章节入口：一个**明确的按钮**（写着当前是第几话 / 共几话）+ 点开的章名列表。
             列表是覆盖层里的 fixed 面板（不写进文档流，不撑开顶栏），滚动 / 点选都在里面做。 */
          '<div class="hs-rd-chap" data-rd-chapwrap hidden>' +
            '<button class="hs-rd-chapbtn" type="button" data-rd-chapbtn aria-haspopup="listbox"' +
              ' aria-expanded="false" title="选择章节">' +
              '<span class="hs-rd-chapcur" data-rd-chapcur></span>' +
              '<i class="hs-rd-caret">' + (HS.icon.chev || '') + '</i>' +
            '</button>' +
            '<div class="hs-rd-chappick" data-rd-chappick hidden>' +
              '<div class="hs-rd-chappickhead">' +
                '<span>选择章节</span><span class="hs-rd-chapnum" data-rd-chapnum></span>' +
              '</div>' +
              '<div class="hs-rd-chaplist" data-rd-chaplist role="listbox" aria-label="章节列表"></div>' +
            '</div>' +
          '</div>' +
          '<button class="hs-rd-dir" type="button" data-rd-dir aria-pressed="false" title="切换阅读方向：上下连续 / 左右单页">' +
            '<span class="hs-rd-dir-ico" data-rd-dirico>' + ICO_V + '</span>' +
            '<span data-rd-dirlab>上下</span></button>' +
          '<button class="hs-rd-auto" type="button" data-rd-auto aria-pressed="false" title="滚到章末自动接上下一话">' +
            (HS.icon.zap || '') + '<span>自动连读</span></button>' +
          '<div class="hs-rd-zoom" role="group" aria-label="图片缩放">' +
            '<button class="hs-rd-zbtn" type="button" data-rd-zoomout title="缩小（Ctrl + −）" aria-label="缩小">−</button>' +
            '<button class="hs-rd-zval" type="button" data-rd-zoomval title="点击复位 100%（Ctrl + 0）" aria-label="当前缩放倍数，点击复位">100%</button>' +
            '<button class="hs-rd-zbtn" type="button" data-rd-zoomin title="放大（Ctrl + +）" aria-label="放大">+</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="hs-rd-scroll" data-rd-scroll tabindex="-1">' +
        '<div class="hs-rd-col" data-rd-pages></div>' +
        '<div class="hs-rd-foot" data-rd-foot>' +
          '<div class="hs-rd-sep" data-rd-footsep>本章结束</div>' +
          '<div class="hs-rd-foot-btns">' +
            '<button class="hs-btn hs-btn-ghost" type="button" data-rd-prev hidden>上一话</button>' +
            '<button class="hs-btn hs-btn-primary" type="button" data-rd-next hidden>下一话</button>' +
          '</div>' +
          '<div class="hs-rd-foot-hint" data-rd-foothint></div>' +
        '</div>' +
      '</div>' +
      '<div class="hs-rd-status"><span class="hs-rd-prog" data-rd-prog></span><span class="hs-rd-tip" data-rd-tip></span></div>' +
      /* 左右模式的两个不可见点击热区：左半屏=上一页、右半屏=下一页。
         固定铺满整个视口（不随页面滚动 / 缩放跑），只在 [data-dir="h"] 下显示。
         它们本身 pointer-events: none —— 判页在下面的 pointer 事件里做，
         这样按住拖动平移放大后的图片不会被热区抢走事件、也不会误翻页 */
      '<div class="hs-rd-hot" data-rd-hotzone aria-hidden="true">' +
        '<div class="hs-rd-hot-l" data-rd-hot-prev></div>' +
        '<div class="hs-rd-hot-r" data-rd-hot-next></div>' +
      '</div>' +
      '<div class="hs-rd-loading" data-rd-loading hidden><i class="hs-rd-spin"></i><span data-rd-loadtxt>正在取回页面…</span></div>' +
      '<div class="hs-rd-error" data-rd-error hidden></div>';
    document.body.appendChild(root);

    el.bar = u.$('[data-rd-bar]', root);
    el.scroll = u.$('[data-rd-scroll]', root);
    el.pages = u.$('[data-rd-pages]', root);
    el.title = u.$('[data-rd-title]', root);
    el.src = u.$('[data-rd-src]', root);
    el.home = u.$('[data-rd-home]', root);
    el.chapWrap = u.$('[data-rd-chapwrap]', root);
    el.chapBtn = u.$('[data-rd-chapbtn]', root);
    el.chapCur = u.$('[data-rd-chapcur]', root);
    el.chapPick = u.$('[data-rd-chappick]', root);
    el.chapNum = u.$('[data-rd-chapnum]', root);
    el.chapList = u.$('[data-rd-chaplist]', root);
    el.dir = u.$('[data-rd-dir]', root);
    el.zoomWrap = u.$('.hs-rd-zoom', root);
    el.zoomVal = u.$('[data-rd-zoomval]', root);
    el.zoomIn = u.$('[data-rd-zoomin]', root);
    el.zoomOut = u.$('[data-rd-zoomout]', root);
    el.hot = u.$('[data-rd-hotzone]', root);
    el.dirIco = u.$('[data-rd-dirico]', root);
    el.dirLab = u.$('[data-rd-dirlab]', root);
    el.auto = u.$('[data-rd-auto]', root);
    el.foot = u.$('[data-rd-foot]', root);
    el.footSep = u.$('[data-rd-footsep]', root);
    el.prev = u.$('[data-rd-prev]', root);
    el.next = u.$('[data-rd-next]', root);
    el.footHint = u.$('[data-rd-foothint]', root);
    el.prog = u.$('[data-rd-prog]', root);
    el.tip = u.$('[data-rd-tip]', root);
    el.loading = u.$('[data-rd-loading]', root);
    el.loadTxt = u.$('[data-rd-loadtxt]', root);
    el.error = u.$('[data-rd-error]', root);

    u.$$('[data-rd-close]', root).forEach(b => b.addEventListener('click', () => RD.close()));
    if (el.chapBtn) el.chapBtn.addEventListener('click', e => { e.stopPropagation(); toggleChapPick(); });
    /* 章名列表：一个委托监听搞定任意多章（100+ 话也不逐个挂 listener），点中即切章 */
    if (el.chapList) el.chapList.addEventListener('click', e => {
      const it = e.target && e.target.closest ? e.target.closest('.hs-rd-chapitem') : null;
      if (!it) return;
      e.stopPropagation();
      closeChapPick();
      jumpChapter(parseInt(it.getAttribute('data-chap'), 10) || 0);
    });
    /* 列表里滚轮只滚列表：横向模式下滚轮 = 翻页，别让鼠标停在章名列表上误翻页 */
    if (el.chapPick) el.chapPick.addEventListener('wheel', e => e.stopPropagation(), { passive: true });
    el.dir.addEventListener('click', () => setDir(S && S.dir === 'h' ? 'v' : 'h'));
    el.auto.addEventListener('click', () => setAuto(!S.auto));
    /* 缩放：两个按钮 + 点倍数复位（Ctrl/Cmd 组合键在 onKey 里处理） */
    if (el.zoomIn) el.zoomIn.addEventListener('click', () => zoomBy(ZOOM_STEP));
    if (el.zoomOut) el.zoomOut.addEventListener('click', () => zoomBy(-ZOOM_STEP));
    if (el.zoomVal) el.zoomVal.addEventListener('click', () => setZoom(1));
    el.prev.addEventListener('click', () => jumpChapter(visibleChapter() - 1));
    el.next.addEventListener('click', () => jumpChapter(Math.max(visibleChapter(), S.lastRendered) + 1));
    el.scroll.addEventListener('scroll', onScroll, { passive: true });
    /* 纵向实际滚的是覆盖层本身，所以它的滚动也要听（否则计数器 / 章节下拉不跟着走） */
    root.addEventListener('scroll', onScroll, { passive: true });
    /* 横向：滚轮翻页要 preventDefault 所以不能是 passive；
       pointer 事件用来区分「点一下」和「按住拖动平移图片」 */
    el.scroll.addEventListener('wheel', onWheel, { passive: false });
    el.scroll.addEventListener('pointerdown', onTapStart, { passive: true });
    el.scroll.addEventListener('pointerup', onTapEnd, { passive: true });
    el.scroll.addEventListener('pointercancel', onTapCancel, { passive: true });
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver(entries => {
        if (entries.some(e => e.isIntersecting)) maybeContinue();
      }, { root: root, rootMargin: '600px 0px' });
    }
  }

  /* ---------------- 按需加载（只给视口附近的页写 src） ----------------
     记账：S.loaded[i] = 这一页已经真正发过请求（含失败 / 手动重试），**不卸载**；
           S.inWindow[i] = 这一页现在落在加载窗口里（滑出去只把标记清掉，src 留着）。
     唯一的触发链（本文件没有 IntersectionObserver）：
       onScroll（.hs-rd / .hs-rd-scroll 的 scroll，rAF 合并）→ schedulePump()
       → pumpNear()：窗口 = currentIndex() 的 -NEAR_V ~ +(NEAR_V+2)。
     各入口另外**显式**调一次，不等滚动：
       · RD.open() / jumpChapter() / appendNext() —— 首屏、切章、自动接续
       · goToIndex()（纵向跳页）/ onVisible()（标签页回前台）
       · 横向走 paintHPage() → pumpH()（当前页 ±1，一次只有一页在视口里）
     src 一旦挂上就不再摘（已加载的页不卸载）：上下回滚不重新请求、不闪，
     滚动高度也不会因为卸载而变。 */
  /** 判断 / 清账：窗口内的页要 src，窗口外的只清 inWindow 标记（不卸载已加载的） */
  function pumpNear() {
    if (!S || !root) return;
    const list = pageEls();
    if (!list.length) return;
    const n = list.length;
    const idx = u.clamp(currentIndex(), 0, n - 1);
    /* 纵向多留一点「往前」的余量（阅读是从上往下走的），到头了就夹住 */
    const back = NEAR_V, ahead = NEAR_V + 2;
    const lo = Math.max(0, idx - back);
    const hi = Math.min(n - 1, idx + ahead);
    for (let i = 0; i < n; i++) {
      const want = i >= lo && i <= hi;
      if (want) loadPage(list[i], i);
      else if (S.inWindow[i]) S.inWindow[i] = false;
    }
  }

  /** 横向：只加载当前页 ±1 —— 当前页必须**立刻**加载（一次只有一页在视口里） */
  function pumpH() {
    if (!S || !root) return;
    const list = pageEls();
    if (!list.length) return;
    const n = list.length;
    const idx = u.clamp(S.hIdx >= 0 ? S.hIdx : 0, 0, n - 1);
    const lo = Math.max(0, idx - NEAR_H), hi = Math.min(n - 1, idx + NEAR_H);
    for (let i = lo; i <= hi; i++) loadPage(list[i], i);
  }

  /** 滚动 → rAF 合并：真正的 src 交给下一帧的 pumpNear()（一次滚动只重算一次窗口，不抖） */
  function schedulePump() {
    if (!open || !S || pumpPending) return;
    pumpPending = true;
    const run = () => { pumpPending = false; if (open && S) pumpNear(); };
    if (window.requestAnimationFrame) window.requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  /** 让一页**真正开始加载**：已经发过请求的一律跳过（不重复请求、不重绘 canvas）。
      返回 true 表示这一刻状态有变化（新进入加载窗口 / 新发起请求）。 */
  function loadPage(box, i) {
    if (!box || !S) return false;
    let dirty = false;
    if (!S.inWindow[i]) { S.inWindow[i] = true; dirty = true; }
    if (box.getAttribute('data-loaded')) return dirty;
    box.setAttribute('data-loaded', '1');
    S.loaded[i] = true;
    loadImg(box, 0, 0);
    return true;
  }

  /** 关掉阅读器时收住按需加载：丢掉还没执行的那次 pump（页盒随即被 clearPages 清空） */
  function releaseImages() {
    pumpPending = false;
  }

  /** 标签页从前台 / 后台切回来时补一次按需加载。
      隐藏文档里 Chrome 对图片的处理不可靠（实测：loading="lazy" 的 onload 被推迟，
      请求发出去、200 也记了，但就是不绘制）。可见之后对所有「已经挂了 src、却还没
      载入成功」的页调一次 img.decode()，把浏览器欠下的那次绘制补上；
      已经在窗口里的页照 pumpNear() 正常处理。 */
  function onVisible() {
    if (!open || !S) return;
    if (document.visibilityState === 'hidden') return;
    schedulePump();
    if (isH()) pumpH();
    u.$$('.hs-rd-img img', el.pages).forEach(im => {
      if (!im.getAttribute('src') || im.naturalWidth > 0) return;
      const box = im.closest && im.closest('.hs-rd-pg');
      if (box && box.classList.contains('is-ok')) return;
      try { if (im.decode) im.decode().catch(() => {}); } catch (e) {}
    });
  }

  /* ---------------- 顶栏 / 章末条 / 底部进度 ---------------- */
  /** 第 i 话的显示名：优先用上游给的名字，空名字才回落到「第 N 话」。
      cap > 0 时截断（按钮里的字太长会把工具条挤爆），列表里用全名。 */
  function chapLabelFor(i, cap) {
    let s = chapLabel(i);
    if (cap && s.length > cap) s = s.slice(0, cap - 1) + '…';
    return s;
  }

  /** 章节入口按钮上的字：「当前话名 · 第 N / 共 M 话」（多章才有意义） */
  function paintChapCur() {
    if (!S || !el.chapCur) return;
    const n = S.chapters.length;
    if (n <= 1) return;
    const i = u.clamp(visibleChapter(), 0, n - 1);
    el.chapCur.textContent = chapLabelFor(i, 16) + ' · 第 ' + (i + 1) + ' / 共 ' + n + ' 话';
  }


  /** 重建章名列表：只在章节数变化时做（滚动时只更新高亮，不重建，别打断用户滚动 / 点击）。
      行元素带 data-chap = 下标，点击走 el.chapList 上那个委托监听。 */
  function buildChapList() {
    if (!S || !el.chapList) return;
    const n = S.chapters.length;
    el.chapList.innerHTML = S.chapters.map((c, i) =>
      '<button class="hs-rd-chapitem" type="button" role="option" data-chap="' + i + '"' +
      ' title="' + u.esc(c.name || ('第 ' + (i + 1) + ' 话')) + '">' +
      '<span class="hs-rd-chapno">' + (i + 1) + '</span>' +
      '<span class="hs-rd-chapname">' + u.esc(c.name || ('第 ' + (i + 1) + ' 话')) + '</span>' +
      '</button>').join('');
    el.chapList.setAttribute('data-n', String(n));
    if (el.chapNum) el.chapNum.textContent = '共 ' + n + ' 话';
    paintChapActive();
  }

  /** 把当前话在列表里标出来（is-cur + aria-selected）；列表没建过就先建 */
  function paintChapActive() {
    if (!S || !el.chapList) return;
    const n = S.chapters.length;
    if (parseInt(el.chapList.getAttribute('data-n'), 10) !== n) { buildChapList(); return; }
    const i = u.clamp(visibleChapter(), 0, n - 1);
    u.$$('.hs-rd-chapitem', el.chapList).forEach((b, k) => {
      const on = k === i;
      b.classList.toggle('is-cur', on);
      if (on) b.setAttribute('aria-selected', 'true'); else b.removeAttribute('aria-selected');
    });
  }

  /** 打开 / 收起章节列表 */
  function toggleChapPick(force) {
    if (!el.chapPick || !el.chapBtn) return;
    const want = (typeof force === 'boolean') ? force : el.chapPick.hidden;
    el.chapPick.hidden = !want;
    el.chapBtn.setAttribute('aria-expanded', want ? 'true' : 'false');
    if (want) {
      paintChapActive();
      /* 打开时把当前话滚进视野（100+ 话时不做这一步等于每次都要自己找） */
      const cur = u.$('.hs-rd-chapitem.is-cur', el.chapList);
      if (cur && cur.scrollIntoView) { try { cur.scrollIntoView({ block: 'center' }); } catch (e) {} }
    }
  }

  function closeChapPick() { toggleChapPick(false); }

  /** 点面板 / 按钮之外的地方 = 收起（用捕获阶段的 pointerdown：一定在切页判定之前，不会漏） */
  function onDocDown(e) {
    if (!open || !el.chapPick || el.chapPick.hidden) return;
    const t = e.target;
    /* 注意：e.target === document 时 closest('[data-rd-chappick]') 会命中文档根，
       等于永远不收；所以只用面板节点自己 contains() 判，且必须排除 document 本身。 */
    if (t && t.nodeType === 1 && (el.chapPick.contains(t) || (el.chapBtn && el.chapBtn.contains(t)))) return;
    closeChapPick();
  }

  function paintBar() {
    if (!S) return;
    el.title.textContent = S.title || (SRC_NAME[S.source] + ' #' + S.id);
    el.src.textContent = SRC_NAME[S.source] + ' · #' + S.id;
    const home = HOMEPAGE[S.source] || '';
    if (home) { el.home.href = home; el.home.hidden = false; } else { el.home.hidden = true; }
    const multi = S.chapters.length > 1;
    el.chapWrap.hidden = !multi;
    if (multi) {
      const i = u.clamp(visibleChapter(), 0, S.chapters.length - 1);
      if (el.chapCur) el.chapCur.textContent =
        chapLabelFor(i, 16) + ' · 第 ' + (i + 1) + ' / 共 ' + S.chapters.length + ' 话';
      paintChapActive();
      if (el.chapBtn) el.chapBtn.title = '选择章节：当前 ' + chapLabel(i) +
        '（第 ' + (i + 1) + ' / 共 ' + S.chapters.length + ' 话）';
    } else {
      closeChapPick();
    }
    el.auto.setAttribute('aria-pressed', S.auto ? 'true' : 'false');
    el.auto.classList.toggle('is-on', !!S.auto);
  }

  function paintFoot() {
    if (!S) return;
    el.footSep.textContent = chapLabel(S.lastRendered) + ' · 结束';
    const n = S.chapters.length;
    if (n > 1) {
      el.prev.hidden = S.lastRendered <= 0;
      el.next.hidden = S.lastRendered >= n - 1;
      el.footHint.textContent = (S.auto && S.lastRendered < n - 1)
        ? '自动连读已开启：滚到底就接「' + chapLabel(S.lastRendered + 1) + '」'
        : '第 ' + (S.lastRendered + 1) + ' / ' + n + ' 话';
    } else {
      el.prev.hidden = true; el.next.hidden = true;
      el.footHint.textContent = '单章作品 · 没有更多章节';
    }
  }

  function paintProg(idx) {
    if (!S) return;
    const ch = visibleChapter();
    /* 滚动时只更新按钮上的当前话名（列表高亮要遍历上百个节点，等真的打开列表再刷） */
    if (S.chapters.length > 1 && el.chapWrap && !el.chapWrap.hidden) {
      if (el.chapCur) el.chapCur.textContent =
        chapLabelFor(ch, 16) + ' · 第 ' + (ch + 1) + ' / 共 ' + S.chapters.length + ' 话';
    }
    let txt = (idx || 0) + ' / ' + (S.pageTotal || pageEls().length) + ' 页';
    if (S.chapters.length > 1) txt += ' · 第 ' + (ch + 1) + ' 话 / 共 ' + S.chapters.length + ' 话';
    el.prog.textContent = txt;
    /* 键盘提示只在桌面端显示（触屏没有键盘），文案随阅读方向变 */
    el.tip.textContent = isTouch() ? '' : tipText();
  }

  /** 底部那行键盘帮助：翻页键两种方向都一样，只是把当前方向说明白 */
  function tipText() {
    const base = 'Esc 关闭 · ←/→ 翻页 · Home/End 首末页 · Ctrl +/− 缩放';
    return base + (isH() ? ' · 当前：左右单页' : ' · 当前：上下连续');
  }

  function setAuto(on) {
    if (!S) return;
    S.auto = !!on;
    HS.settings.readerAuto = S.auto;
    if (HS.store && HS.store.save) HS.store.save(HS.settings);
    paintBar(); paintFoot();
    HS.toast(S.auto ? '自动连读已开启：滚到章末自动接下一话' : '自动连读已关闭', S.auto ? 'ok' : 'info', 1800);
    if (S.auto) { prefetchNext(); maybeContinue(); }
  }

  /* ---------------- 阅读方向（纵向上下连续 / 横向左右单页） ---------------- */
  const isH = () => !!(S && S.dir === 'h');

  function paintDir() {
    if (!S) return;
    const h = S.dir === 'h';
    if (root) root.setAttribute('data-dir', h ? 'h' : 'v');
    if (el.dirLab) el.dirLab.textContent = DIRS[h ? 'h' : 'v'];
    if (el.dirIco) el.dirIco.innerHTML = h ? ICO_H : ICO_V;
    if (el.dir) {
      el.dir.setAttribute('aria-pressed', h ? 'true' : 'false');
      el.dir.title = h ? '当前：左右单页（点击切回上下连续）' : '当前：上下连续（点击切到左右单页）';
    }
    /* 点击热区只在左右模式下「存在」（视觉上不可见，pointer-events: none） */
    if (el.hot) el.hot.hidden = !h;
    if (el.tip) el.tip.textContent = isTouch() ? '' : tipText();
  }

  /** 切方向：先记住当前是第几页，换完布局再对回同一页；设置写进 HS.settings 持久化 */
  function setDir(dir, quiet) {
    if (!S) return;
    const next = dir === 'h' ? 'h' : 'v';
    if (next === S.dir && root && root.getAttribute('data-dir') === next) return;
    const keep = currentIndex();          // 用旧方向量出来的当前页
    S.dir = next;
    /* 两个方向各记一份「当前页」：横向是显式下标（S.hIdx），纵向靠滚动位置量。
       切方向时先把要切过去的那份写死，再走一次 goToIndex，就能停在同一个作品页上 */
    S.hIdx = keep;
    HS.settings.readerDir = next;
    if (HS.store && HS.store.save) HS.store.save(HS.settings);
    paintDir();
    goToIndex(keep);                      // 新布局下把同一页对回来
    watchFoot();                          // 纵向要把章末条放回列尾，横向交给 syncFoot 决定露不露
    if (isH() && S.auto) maybeContinue();
    if (!quiet) HS.toast(isH() ? '已切到左右单页（←/→ 或点左/右半屏翻页）' : '已切到上下连续', 'info', 1600);
  }

  /* ---------------- 图片缩放（--hs-rd-zoom） ----------------
     ── 存储层：按作品记倍率 ─────────────────────────────────────────────────
     为什么不用 HS.settings.readerZoom 当「新作品的缺省倍率」：
       用户的要求是「没打过交道的作品一律 100%」。老版本把倍率存成**全局唯一值**，
       升级上来的人盘上就留着 1.4；拿它当缺省等于让第一个打开的新作品继承那个全局值 ——
       正好是这次要修掉的行为。设置页 / 任何 UI 也都没有读写这个字段（全仓库只有本文件
       提过它），所以它现在**既不读也不写**，只是一个留在盘上的遗留字段（不删、不清，
       免得动到用户其它数据）。将来若真要做「新作品缺省倍率」的界面，改 NEW_WORK_ZOOM
       这一处即可 —— 且必须只作用在**没有自己记忆**的作品上（zoomGet 的两个兜底分支）。 */
  const NEW_WORK_ZOOM = 1;

  /* 本地存储读写：一律包 try/catch（无痕模式 / 被策略禁用时 localStorage 会直接抛） */
  function rdLsGet(key) { try { return window.localStorage.getItem(key); } catch (e) { return null; } }
  function rdLsSet(key, raw) { try { window.localStorage.setItem(key, raw); return true; } catch (e) { return false; } }

  /** 作品主键：与收藏一致的口径 —— 有 id 用 "<source>:<id>"，没有才兜底到 url / 标题。
      为什么强调这一点：it.key 是「归一化标题」（core.js 的 u.normTitle），
      同一部作品在不同源上 key 相同、不同作品也可能撞上，拿它当主键会让不同作品的倍率互相覆盖。
      返回 '' 表示连兜底都没有（这条记录不落盘，永远 100%），绝不写一个空键进去。 */
  function zoomKeyOf(item) {
    if (!item) return '';
    const source = String(item.source == null ? '' : item.source).trim().slice(0, 40) || 'unknown';
    const id = String(item.id == null ? '' : item.id).trim();
    /* id 缺失时的兜底顺序与收藏相同：url → key（归一化标题）→ title */
    const alt = id ? '' : String(item.url || item.key || item.title || '').trim();
    const sub = (id || alt).slice(0, ZOOM_SUB_MAX);
    if (!sub) return '';
    const k = source + ':' + sub;
    return k.length > ZOOM_KEY_MAX ? k.slice(0, ZOOM_KEY_MAX) : k;
  }

  /** 读出 items 表：键不存在 / JSON 损坏 / 结构不对 → 空表（调用方随即回落 100%） */
  function zoomReadItems() {
    const raw = rdLsGet(ZOOM_KEY);
    if (!raw) return {};
    let db = null;
    try { db = JSON.parse(raw); } catch (e) { return {}; }
    if (!db || typeof db !== 'object' || Array.isArray(db)) return {};
    const items = db.items;
    if (!items || typeof items !== 'object' || Array.isArray(items)) return {};
    return items;
  }

  const zoomPack = items => JSON.stringify({ v: ZOOM_VER, items: items });

  /** 按 t 升序（最旧在前）：t 缺失 / 坏掉的当 0（最先被淘汰）；同 t 按键名定序，结果可复现 */
  function zoomOldest(items) {
    return Object.keys(items).map(k => {
      const r = items[k];
      const t = (r && typeof r === 'object') ? Number(r.t) : 0;
      return { k: k, t: isFinite(t) ? t : 0 };
    }).sort((a, b) => (a.t - b.t) || (a.k < b.k ? -1 : (a.k > b.k ? 1 : 0)));
  }

  /** 条数上限：超出 ZOOM_MAX_ITEMS 就淘汰最旧的那些 */
  function zoomEvict(items) {
    const n = Object.keys(items).length;
    if (n <= ZOOM_MAX_ITEMS) return items;
    zoomOldest(items).slice(0, n - ZOOM_MAX_ITEMS).forEach(r => { delete items[r.k]; });
    return items;
  }

  /** 写回 items 表；整包写失败（配额满之类）就丢掉最旧的一批再试一次，仍失败返回 false */
  function zoomWriteItems(items) {
    if (rdLsSet(ZOOM_KEY, zoomPack(items))) return true;
    const rows = zoomOldest(items);
    const drop = Math.max(1, Math.floor(rows.length / 10));
    if (rows.length - drop < 1) return false;       // 只剩一两条：宁可不写，也别把记录清空
    rows.slice(0, drop).forEach(r => { delete items[r.k]; });
    return rdLsSet(ZOOM_KEY, zoomPack(items));
  }

  /** 倍率归一：夹到 50%–300% 并取两位小数（与 setZoom 完全同一套规则） */
  function normZoom(v) {
    return Math.round(u.clamp(v, ZOOM_MIN, ZOOM_MAX) * 100) / 100;
  }

  /** 读这个作品的倍率：没记过 / 记的值坏了 / 键都建不出来 → NEW_WORK_ZOOM（100%） */
  function zoomGet(item) {
    const k = zoomKeyOf(item);
    if (!k) return normZoom(NEW_WORK_ZOOM);
    const rec = zoomReadItems()[k];
    /* 容忍几种历史 / 手改形态：数字、数字字符串、{z,t} 对象 */
    let v = NaN;
    if (typeof rec === 'number') v = rec;
    else if (typeof rec === 'string') v = Number(rec);
    else if (rec && typeof rec === 'object') v = Number(rec.z);
    if (!isFinite(v) || v <= 0) return normZoom(NEW_WORK_ZOOM);
    return normZoom(v);
  }

  /** 记下这个作品（key = zoomKeyOf 的结果）的倍率；key 为空就只在会话里生效。
      100% 也照记：在某作品里按 Ctrl+0 复位 = 这个作品要 100%。
      写不进盘也不算失败 —— 本次会话里的缩放照常生效，只是下次打开回到 100%。 */
  function zoomSet(key, v) {
    if (!key) return false;
    const items = zoomReadItems();
    items[key] = { z: normZoom(v), t: Date.now() };
    zoomEvict(items);
    return zoomWriteItems(items);
  }

  /** 把倍数画到 CSS 变量上：图片尺寸由变量算出来，页码 / 章末几何完全不受影响 */
  function paintZoom() {
    if (!root || !S) return;
    const z = S.zoom;
    root.style.setProperty('--hs-rd-zoom', String(z));
    /* 放大后在当前页内部可以滚（看图不算翻页）；100% 时收起滚动，避免没必要的滚动条 */
    const sc = z > 1.001 ? 'auto' : 'hidden';
    if (el.scroll) el.scroll.style.overflow = isH() ? 'hidden' : sc;
    if (el.pages) el.pages.style.overflow = sc;
    if (el.zoomVal) el.zoomVal.textContent = Math.round(z * 100) + '%';
    if (el.zoomOut) el.zoomOut.disabled = z <= ZOOM_MIN + 1e-6;
    if (el.zoomIn) el.zoomIn.disabled = z >= ZOOM_MAX - 1e-6;
  }

  /** 设定缩放倍数：夹到 50%–300%，按**当前作品**记忆（S.zoomKey 在 RD.open 时算好） */
  function setZoom(v, quiet) {
    if (!S) return;
    const next = normZoom(v);
    if (next === S.zoom) { paintZoom(); return; }
    S.zoom = next;
    /* 作品主键在 RD.open 时就算好并存进 S —— 别在这里现算 item：S.item 是调用方给的对象，
       中途被换掉的话就会把倍率记到另一个作品头上 */
    zoomSet(S.zoomKey, next);
    paintZoom();
    if (!quiet) HS.toast('缩放 ' + Math.round(next * 100) + '%', 'info', 1100);
  }

  function zoomBy(d) { if (S) setZoom((S.zoom || 1) + d, true); }

  /** Ctrl/Cmd + '+/-/0'：命中返回 true。key 在各键盘 / 布局下写法不一，几种都认 */
  function zoomKeys(e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
    const k = e.key || '';
    if (k === '+' || k === '=' || k === 'Add') { setZoom(((S && S.zoom) || 1) + ZOOM_STEP, true); return true; }
    if (k === '-' || k === '_' || k === 'Subtract') { setZoom(((S && S.zoom) || 1) - ZOOM_STEP, true); return true; }
    if (k === '0' || k === ')') { setZoom(1, true); return true; }
    return false;
  }

  /** 章末条在横向是浮层：只有停在最后一页才露出来（hidden 交给全局 [hidden] 规则） */
  function syncFoot() {
    if (!S || !root) return;
    const list = pageEls();
    if (isH()) {
      const atEnd = list.length > 0 && currentIndex() >= list.length - 1;
      el.foot.hidden = !atEnd;
      root.classList.toggle('is-chapend', atEnd);
    } else {
      root.classList.remove('is-chapend');
    }
  }

  /** 回到顶部：纵向真正滚动的是覆盖层 .hs-rd（.hs-rd-scroll 高度不受限），
      横向没有横向滚动了，只把放大后的页内滚动复位 */
  function resetScroll() {
    if (!root) return;
    el.scroll.scrollTop = 0;
    el.scroll.scrollLeft = 0;
    root.scrollTop = 0;
    if (el.pages) { el.pages.scrollTop = 0; el.pages.scrollLeft = 0; }
  }

  /* ---------------- 禁漫（jmcomic）的 canvas 还原 ----------------
     站点自己的做法（templates/frontend/airav/js/jquery.photo-0.5.js 的 onImageLoaded，
     逐行核对过）：
       · 块数 num 由 get_num(btoa(aid), btoa(page)) 决定 —— 网关已经按同一套规则算好，
         写在 pages[].bands 里，前端不重复实现（少一处能算错的地方）；
       · 把图片按 num **等分**，第 i 块取自源图第 (num-1-i) 块 —— 也就是整体上下颠倒；
         h % num 的余数并进第一块（这块比别的块高 remainder 像素）。
     搬运用 canvas：图片经 /api/proxy 同源取回，drawImage 之后 canvas 不会被污染。
     还原失败（拿不到 2d 上下文之类）就保留原图，并把失败标在盒子上，绝不静默乱画。 */
  const SCRAMBLE_CSS_ID = 'hs-rd-scramble-css';
  /** style.css 不在本次改动范围内，所以这几条**自身样式**从 reader.js 注入；
      选择器与 .hs-rd-img img / .hs-rd[data-dir="h"] .hs-rd-img img / 小屏那条一一对应，
      保证 canvas 在纵向 / 横向 / 缩放 / 小屏下的尺寸行为与原来的 <img> 完全一致。 */
  function ensureScrambleCss() {
    if (document.getElementById(SCRAMBLE_CSS_ID)) return;
    const st = document.createElement('style');
    st.id = SCRAMBLE_CSS_ID;
    st.textContent =
      /* 纵向与 .hs-rd-img img 一致：铺满页宽（页宽里已经含了缩放倍数），不再给第二条上限。
         canvas 同样是「有固有宽高比的替换元素」：max-width 与 max-height 一起给会被等比
         缩到两条上限之内，各页渲染宽度就不一样（和图片那条规则是同一个坑）。 */
      '.hs-rd-img canvas{display:block;width:100%;height:auto;margin:0 auto;' +
      'max-width:none;max-height:none;}' +
      '.hs-rd[data-dir="h"] .hs-rd-img canvas{width:calc(100% * var(--hs-rd-zoom,1));' +
      'max-width:none;height:auto;max-height:calc(100% * var(--hs-rd-zoom,1));object-fit:contain;}';
    (document.head || document.documentElement).appendChild(st);
  }

  /** 把这一页还原到 canvas（成功 = canvas 顶替图片显示，返回 true） */
  function paintScramble(box, img) {
    const num = parseInt(box.getAttribute('data-bands'), 10) || 0;
    if (num < 2) return false;
    const w = img.naturalWidth || 0, h = img.naturalHeight || 0;
    if (!w || !h || h < num) return false;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.className = 'hs-rd-canvas';
    const ctx = cv.getContext && cv.getContext('2d');
    if (!ctx) return false;
    const remainder = Math.floor(h % num);
    for (let i = 0; i < num; i++) {
      let copyH = Math.floor(h / num);
      let py = copyH * i;
      const y = h - copyH * (i + 1) - remainder;   /* 第 i 块取自倒数第 (i+1) 块 */
      if (i === 0) copyH += remainder; else py += remainder;
      if (copyH <= 0 || y < 0) continue;
      ctx.drawImage(img, 0, y, w, copyH, 0, py, w, copyH);
    }
    const holder = u.$('.hs-rd-img', box);
    if (!holder) return false;
    ensureScrambleCss();
    img.style.display = 'none';        /* 原图（含 src）留着，只是不再显示 */
    holder.appendChild(cv);
    return true;
  }

  /* ---------------- 页面渲染 ---------------- */
  function makePage(p, chIdx) {
    const box = u.el('div', { class: 'hs-rd-pg', 'data-ch': String(chIdx), 'data-url': p.url });
    /* 备用地址：网关对同一页给出的另一条通路（MangaDex = at-home 节点 ↔ uploads 镜像）。
       主地址加载失败会自动换它重试一次，两条都失败才让用户手动点重试。 */
    if (p.alt && p.alt !== p.url) box.setAttribute('data-url-alt', p.alt);
    /* 禁漫：这一页是分块打乱的。scramble 是章节的 scramble_id（数字，网关给的），
       bands 是算好的块数 —— 两个都在才还原（只有 bands 才真的能干活）。 */
    if (p.scramble > 0 && p.bands > 1) {
      box.setAttribute('data-scramble', String(p.scramble));
      box.setAttribute('data-bands', String(p.bands));
    }
    const holder = u.el('div', { class: 'hs-rd-img' });
    /* 占位盒的宽高比交给 CSS 变量（.hs-rd-img 里 aspect-ratio: var(--hs-rd-ar, auto)）：
       图片载入后由 .is-ok 把 aspect-ratio 收成 auto，盒子才会贴着图片、不留空白 */
    if (p.w > 0 && p.h > 0) holder.style.setProperty('--hs-rd-ar', p.w + ' / ' + p.h);
    box.appendChild(holder);
    /* 这里**不**写 img / src：按需加载由 pumpNear() / pumpH() 决定谁先真正开始取图
       （页盒先全部渲染成占位盒，布局高度由上面的 --hs-rd-ar 撑住，不会跳） */
    return box;
  }

  /** 这一页第 idx 条地址：0 = 主地址，1 = 备用地址（没有备用就返回空串） */
  function pageSrc(box, idx) {
    return (idx === 1 ? box.getAttribute('data-url-alt') : box.getAttribute('data-url')) || '';
  }

  function loadImg(box, idx, bust) {
    const holder = u.$('.hs-rd-img', box);
    if (!holder) return;
    const base = pageSrc(box, idx);
    if (!base) { failImg(box, idx); return; }
    /* 重试时带一个 cache-busting 查询参数，绕开浏览器缓存里那次失败 */
    const src = bust ? (base + (base.indexOf('?') >= 0 ? '&' : '?') + '_r=' + bust) : base;
    holder.classList.remove('is-fail');
    holder.innerHTML = '';
    /* loading="eager"：加载范围已经由 pumpNear() / pumpH() 控住，不需要浏览器再猜；
       而且隐藏文档里 Chrome 会**推迟 loading="lazy" 图片的 onload**（请求照发、200 照记，
       就是不绘制），改成 eager 就走不到那条路径上。 */
    const img = u.el('img', { alt: '', loading: 'eager', decoding: 'async', referrerpolicy: 'no-referrer' });
    img.addEventListener('load', () => {
      /* 禁漫：先按站点算法把分块还原到 canvas，再标 is-ok（图片本身已经加载完了）。
         还原失败就把失败标在盒子上并按原图显示 —— 不静默乱画，也不留白。 */
      if (box.getAttribute('data-bands')) {
        try { if (!paintScramble(box, img)) box.setAttribute('data-rd-scramble', 'fail'); }
        catch (e) { box.setAttribute('data-rd-scramble', 'fail'); }
      }
      box.classList.add('is-ok');
    });
    img.addEventListener('error', () => {
      /* 主地址失败且还有备用域名：自动换备用再试一次，用户不用操作；
         两条都不通才显示「加载失败 · 重试」 */
      if (idx === 0 && pageSrc(box, 1)) { loadImg(box, 1, bust); return; }
      failImg(box, idx);
    });
    img.src = gwAbs(src);
    holder.appendChild(img);
  }

  function failImg(box, idx) {
    const holder = u.$('.hs-rd-img', box);
    if (!holder || holder.classList.contains('is-fail')) return;
    holder.classList.add('is-fail');
    holder.innerHTML = '';
    const btn = u.el('button', { class: 'hs-rd-retry', type: 'button' },
      '<span>加载失败</span><i>· 重试</i>');
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const n = (parseInt(box.getAttribute('data-bust'), 10) || 0) + 1;
      box.setAttribute('data-bust', String(n));
      /* 上次是主地址失败的 —— 手动重试就先从备用地址开始 */
      const start = (idx === 0 && pageSrc(box, 1)) ? 1 : 0;
      loadImg(box, start, n + '-' + Date.now());
    });
    holder.appendChild(btn);
  }

  /** 清空页面并释放图片：别让一堆大图挂在内存里 */
  function clearPages() {
    releaseImages();
    if (S) { S.loaded = {}; S.inWindow = {}; }        // 页盒全没了，按需加载的记账一并归零
    u.$$('img', el.pages).forEach(im => { im.removeAttribute('src'); });
    el.pages.innerHTML = '';
  }

  function renderPages(chIdx, pages) {
    const frag = document.createDocumentFragment();
    pages.forEach(p => frag.appendChild(makePage(p, chIdx)));
    el.pages.appendChild(frag);
    S.pageTotal = pageEls().length;
  }

  /* ---------------- 取数据 ---------------- */
  const readerUrl = chapterId => HS.net.gateway.url('/api/reader', {
    source: S.source, id: S.id, chapter: chapterId || ''
  });

  function showLoading(on, txt) {
    if (!el.loading) return;
    el.loading.hidden = !on;
    if (txt) el.loadTxt.textContent = txt;
  }

  /** 统一的错误面板：<b>标题</b> + 若干段落 + 一句灰色小贴士（一律当纯文本转义） */
  function showError(title, lines, tip) {
    if (!root || !el.error) return;
    root.classList.add('is-ready');
    el.prog.textContent = '';
    el.tip.textContent = '';
    el.error.hidden = false;
    el.error.innerHTML = '';
    el.error.appendChild(u.el('b', {}, u.esc(title)));
    (lines || []).filter(Boolean).forEach(t => el.error.appendChild(u.el('p', {}, u.esc(t))));
    if (tip) el.error.appendChild(u.el('p', { class: 'hs-rd-error-tip' }, u.esc(tip)));
  }

  async function fetchChapter(chapterId, silent) {
    if (!silent) showLoading(true, '正在取回页面…');
    try {
      const r = await fetch(readerUrl(chapterId), {
        cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer'
      });
      const j = await r.json().catch(() => null);
      if (!j) throw new Error('网关返回的不是 JSON（HTTP ' + r.status + '）');
      if (!j.ok) throw new Error(j.error || '网关拒绝了这次请求');
      return j;
    } finally {
      if (!silent) showLoading(false);
    }
  }

  /* ---------------- 章节切换 / 自动连读 ---------------- */
  /** 切到某一章：清空当前列，只渲染这一章（下拉 / 上一话 / 下一话 都走这里） */
  async function jumpChapter(idx) {
    if (!S || S.busy) return;
    if (idx < 0 || idx >= S.chapters.length) return;
    S.busy = true;
    try {
      let pages = S.pagesByCh[idx];
      if (!pages) {
        const j = await fetchChapter(S.chapters[idx].id);
        pages = j.pages || [];
        S.pagesByCh[idx] = pages;
        S.fetched[idx] = true;
      }
      clearPages();
      S.pageTotal = 0;
      S.hIdx = 0;                         // 换章一律回到新章第 1 页
      renderPages(idx, pages);
      S.lastRendered = idx;
      el.foot.hidden = true;
      el.error.hidden = true;
      paintBar(); paintFoot(); paintProg(1);
      resetScroll();
      pumpNear();                         // 新章第 1 页（含后面几页）立刻开始加载，不等滚动
      if (isH()) paintHPage();            // 横向：只显示出第 1 页（paintHPage 里也会补 pumpH）
      watchFoot();
      prefetchNext();
    } catch (e) {
      HS.toast('打开失败：' + ((e && e.message) || e), 'err', 4200);
    } finally {
      S.busy = false;
    }
  }

  /** 预取下一章（自动连读要无缝接上，所以提前拿回来） */
  async function prefetchNext() {
    if (!S) return;
    const nxt = S.lastRendered + 1;
    if (nxt >= S.chapters.length || S.fetched[nxt] || S.fetching[nxt]) return;
    S.fetching[nxt] = true;
    S.fetchErr[nxt] = '';
    try {
      const j = await fetchChapter(S.chapters[nxt].id, true);
      S.pagesByCh[nxt] = j.pages || [];
      S.fetched[nxt] = true;
    } catch (e) {
      S.fetchErr[nxt] = (e && e.message) || String(e);
    } finally {
      S.fetching[nxt] = false;
    }
  }

  /** 章末自动接续：把下一章的图**追加**到当前列末尾，并插一条章节分隔标题 */
  async function appendNext() {
    if (!S || S.busy || S.appending) return;
    const nxt = S.lastRendered + 1;
    if (nxt >= S.chapters.length) return;
    S.appending = true;
    el.footHint.textContent = '正在接上「' + chapLabel(nxt) + '」…';
    try {
      if (!S.fetched[nxt]) await prefetchNext();
      if (!S.fetched[nxt]) throw new Error(S.fetchErr[nxt] || '没有取到下一章的数据');
      const firstNew = pageEls().length;   // 新章首页在拼接后的页列表里是第几页
      el.pages.appendChild(u.el('div', { class: 'hs-rd-sep hs-rd-sep-in' }, u.esc(chapLabel(nxt))));
      renderPages(nxt, S.pagesByCh[nxt] || []);
      S.lastRendered = nxt;
      paintFoot();
      watchFoot();
      prefetchNext();
      pumpNear();                         // 接上来的新章同样按窗口加载（别一次把整章都拉下来）
      /* 横向一次一页：接上以后直接把这一页翻到新章首页（瞬时换图；纵向维持原来的滚动位置不动） */
      if (isH()) goToIndex(firstNew);
    } catch (e) {
      el.footHint.textContent = '自动连读失败：' + ((e && e.message) || e) + '（可点「下一话」重试）';
    } finally {
      S.appending = false;
    }
  }

  /** 章末哨兵：纵向滚到接近底部就把章末条露出来（横向没有纵向滚动，改用当前页判定） */
  function watchFoot() {
    if (isH()) {
      if (io) io.disconnect();               // 横向的章末条是 fixed 浮层，观察它没有意义
      syncFoot();
      return;
    }
    el.foot.hidden = false;
    if (io) { io.disconnect(); io.observe(el.foot); }
  }

  function maybeContinue() {
    if (!S || !S.auto || S.appending || S.busy) return;
    if (S.lastRendered + 1 >= S.chapters.length) {
      el.footHint.textContent = '已经是最后一话';
      return;
    }
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => { autoTimer = null; appendNext(); }, AUTO_DELAY);
  }

  /* ---------------- 进度 / 键盘 / 翻页手势 ---------------- */
  function onScroll() {
    if (rafPending) return;
    rafPending = true;
    window.requestAnimationFrame(() => {
      rafPending = false;
      if (!open || !S) return;
      const list = pageEls();
      if (!list.length) { paintProg(0); return; }
      const idx = currentIndex();
      schedulePump();                     // 滚过一屏就重算加载窗口（rAF 合并，滚动时不抖）
      paintProg(idx + 1);
      /* 横向：翻到最后一页就等于纵向「滚到底」——章末条、自动连读都从这儿触发 */
      if (isH()) {
        syncFoot();
        if (idx >= list.length - 1) maybeContinue();
      }
    });
  }

  /* ---------------- 翻页 / 定位（两种方向各一套几何） ----------------
     横向 = 一次只显示一页（S.hIdx 记第几页，其余页 display:none），切页就是直接换图，
     没有横向滚动、没有 scroll-snap、没有滑动动画；纵向仍是原来的连续滚动。 */
  /** 当前停在第几页（0 基）：横向用显式下标，纵向沿用「顶部已过线」的判定 */
  function currentIndex() {
    const list = pageEls();
    if (!list.length) return 0;
    if (isH()) {
      const i = (S && typeof S.hIdx === 'number') ? S.hIdx : 0;
      return u.clamp(i, 0, list.length - 1);
    }
    const top = vRef().getBoundingClientRect().top;
    let cur = 0;
    for (let i = 0; i < list.length; i++) {
      if (list[i].getBoundingClientRect().top - top < 140) cur = i;
      else break;
    }
    return cur;
  }

  /** 停到第 i 页：横向只把这一页显示出来（瞬时，无动画），纵向把它滚到视野顶部 */
  function goToIndex(i) {
    const list = pageEls();
    if (!list.length) return;
    const idx = u.clamp(i, 0, list.length - 1);
    if (isH()) {
      S.hIdx = idx;
      paintHPage();                       // paintHPage() 里会立刻按需加载这一页
    } else {
      list[idx].scrollIntoView({ behavior: 'auto', block: 'start' });
      pumpNear();                         // 跳页后立刻按新位置（重新）算加载窗口
    }
    paintProg(idx + 1);
    syncFoot();
  }

  /** 横向：只留当前页（其余 display:none）、把页内滚动复位到左上角，并更新计数器 / 章末判定。
      hIdx = -1 表示「这一批页还没定位过」→ 默认落在第 1 页（仍然会画出 is-cur） */
  function paintHPage() {
    if (!root || !isH()) return;
    const list = pageEls();
    if (!list.length) return;
    if (!(S.hIdx >= 0)) S.hIdx = 0;
    const i = u.clamp(S.hIdx, 0, list.length - 1);
    S.hIdx = i;
    for (let n = 0; n < list.length; n++) list[n].classList.toggle('is-cur', n === i);
    /* 放大后页内可以滚 / 拖：换页就回到这一页的左上角 */
    if (el.pages) { el.pages.scrollTop = 0; el.pages.scrollLeft = 0; }
    pumpH();                              // 一次只有一页在视口：当前页必须**立刻**开始加载
    paintProg(i + 1);
    syncFoot();
  }

  function jumpTo(dir) {
    const list = pageEls();
    if (!list.length) return;
    goToIndex(currentIndex() + dir);
  }

  /* 横向：滚轮（鼠标 / 触控板）换算成翻页 —— 瞬时换图，不是平滑滚动。
     Ctrl/Cmd + 滚轮留给浏览器 / 缩放，不抢。 */
  let wheelLock = 0;

  function onWheel(e) {
    if (!open || !isH() || e.ctrlKey || e.metaKey) return;   // ctrl+滚轮 = 缩放，别抢
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    e.preventDefault();
    const now = Date.now();
    if (now < wheelLock) return;                   // 一次滚轮手势只翻一页
    wheelLock = now + 240;
    jumpTo(d > 0 ? 1 : -1);
  }

  /* 左右模式：点左半屏 = 上一页、右半屏 = 下一页（两个不可见热区的位置）。
     触屏不再用滑动判定（横向、纵向滑动都不翻页，避免误触和和「拖动看放大图」打架），
     所以这里只在「按下-抬起几乎没移动」时才算一次点击；按住拖动 = 平移图片。 */
  const TAP_SLOP = 12;
  let tapFrom = null;

  function onTapStart(e) {
    if (!open || !isH() || e.button > 0) { tapFrom = null; return; }
    tapFrom = { x: e.clientX, y: e.clientY, id: e.pointerId };
  }

  function onTapEnd(e) {
    if (!open || !isH() || !tapFrom) { tapFrom = null; return; }
    const from = tapFrom;
    tapFrom = null;
    if (from.id !== e.pointerId) return;
    if (Math.abs(e.clientX - from.x) > TAP_SLOP || Math.abs(e.clientY - from.y) > TAP_SLOP) return;
    /* 点「加载失败 · 重试」不翻页 */
    if (e.target && e.target.closest && e.target.closest('.hs-rd-retry')) return;
    const w = el.scroll.clientWidth || window.innerWidth || 1;
    const x = e.clientX - el.scroll.getBoundingClientRect().left;
    jumpTo(x < w / 2 ? -1 : 1);
  }

  function onTapCancel() { tapFrom = null; }

  function jumpEdge(last) {
    const list = pageEls();
    if (!list.length) return;
    goToIndex(last ? list.length - 1 : 0);
  }

  function inField(t) {
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable === true;
  }

  /* 捕获阶段先处理：保证 Esc 只关阅读器，绝不落到放大卡片 / 筛选抽屉上 */
  function onKey(e) {
    if (!open) return;
    /* Ctrl/Cmd + '+ / - / 0' = 图片缩放（在下面的「不带组合键」守卫之前处理） */
    if (!inField(e.target) && zoomKeys(e)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey || inField(e.target)) return;
    const k = e.key;
    if (k === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      /* 章名列表开着就先收列表（Escape 的第一层），再按一次才关阅读器 */
      if (el.chapPick && !el.chapPick.hidden) closeChapPick(); else RD.close();
      return;
    }
    if (k === 'ArrowRight' || k === 'PageDown') { e.preventDefault(); e.stopImmediatePropagation(); jumpTo(1); return; }
    if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); e.stopImmediatePropagation(); jumpTo(-1); return; }
    /* 横向单页：↑/↓ 也当翻页（和滚轮的换算一致）；纵向照旧不抢上下键（要留给滚动） */
    if (isH() && k === 'ArrowDown') { e.preventDefault(); e.stopImmediatePropagation(); jumpTo(1); return; }
    if (isH() && k === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); jumpTo(-1); return; }
    if (k === 'Home') { e.preventDefault(); e.stopImmediatePropagation(); jumpEdge(false); return; }
    if (k === 'End') { e.preventDefault(); e.stopImmediatePropagation(); jumpEdge(true); }
  }

  /* ---------------- 打开 / 关闭 ---------------- */
  /* 退出阅读器后「页面被顶到最上方」的根因与修法 -------------------------------
     根因：open 时给 html/body 加 .hs-rd-open（style.css：`overflow: hidden`）。
     页面的滚动容器就是文档本身（html/body 是滚动盒，.hs-main 不是），
     一旦文档根被设成 overflow:hidden，**滚动位置会被浏览器夹回 0**（本机实测：
     加之前 window.pageYOffset = 1912，加完同一帧读就是 0）；close 只是把 class
     摘掉，位置不会自己回来 —— 用户看到的就是「在阅读器里按 Esc，整页跳回顶部」。
     修法：进阅读器之前把位置记下来，解锁之后还原。
     时机：只能等 HS.results.closeCard() 的**反向动画**（340ms）也落位之后再补一次，
     否则卡片幽灵态的复原会把还原过的滚动位置再顶一次；所以这里 rAF 一次 +
     一次短延时兜底（只有又被打回顶部时才补，避免和用户自己的滚动打架）。
     另外确认过：关闭路径上**没有**别的 window.scrollTo / scrollTop=0 / scrollIntoView ——
     reader.js 里的 resetScroll() 只复位阅读器覆盖层自己的 el.scroll / el.pages，
     碰不到页面滚动位置。 */
  let pageScrollSave = null;

  function capturePageScroll() {
    const de = document.documentElement, b = document.body;
    pageScrollSave = {
      x: window.pageXOffset || de.scrollLeft || (b && b.scrollLeft) || 0,
      y: window.pageYOffset || de.scrollTop || (b && b.scrollTop) || 0
    };
  }

  function putPageScroll(s) {
    if (!s) return;
    try { window.scrollTo(s.x || 0, s.y || 0); } catch (e) {}
    /* 个别布局把滚动条挂在 body 上，兜一下（文档根滚不了时 body 才有意义） */
    try {
      const de = document.documentElement, b = document.body;
      if (Math.abs((window.pageYOffset || 0) - (s.y || 0)) > 1 && b && b.scrollHeight > b.clientHeight) {
        b.scrollTop = s.y || 0;
        if (de) de.scrollTop = s.y || 0;
      }
    } catch (e) {}
  }

  function restorePageScroll() {
    const s = pageScrollSave;
    pageScrollSave = null;
    if (!s || (!s.y && !s.x)) return;                    // 本来就在最上面就什么都不用做
    const once = () => {
      if (!open && Math.abs((window.pageYOffset || 0) - s.y) > 1) putPageScroll(s);
    };
    once();                                              // 解锁这一帧先立刻还原
    if (window.requestAnimationFrame) window.requestAnimationFrame(once);
    /* 卡片反向动画 340ms 之后才落位；只有「又被打回顶部」时才再补一次 */
    setTimeout(() => {
      if (!open && (window.pageYOffset || 0) <= 1 && s.y > 1) putPageScroll(s);
    }, 420);
  }

  RD.open = async function (item) {
    if (!item || !RD.supports(item.source)) {
      HS.toast('这个来源还不支持在线阅读：MangaDex / nhentai / Danbooru / 紳士漫畫 / E-Hentai / Hitomi / Pixiv / 拷贝漫画 / 禁漫天堂 / porn-comic', 'warn', 3800);
      return;
    }
    if (!root) build();

    S = {
      item: item, source: String(item.source), id: String(item.id),
      title: item.title || '',
      chapters: [], pagesByCh: {}, fetched: {}, fetching: {}, fetchErr: {},
      lastRendered: 0, pageTotal: 0, busy: false, appending: false,
      auto: !!HS.settings.readerAuto,
      /* 上次用的阅读方向，'h' 才是横向，其它值（含没存过）都当纵向 */
      dir: HS.settings.readerDir === 'h' ? 'h' : 'v',
      /* 横向的当前页下标（显式状态，不依赖滚动位置）；-1 = 这一批页还没定位过 */
      hIdx: -1,
      /* 按需加载记账：loaded[i] = 这一页已经发过请求（不卸载）；
         inWindow[i] = 这一页当前落在加载窗口里（滑出去只清标记，src 留着） */
      loaded: {}, inWindow: {},
      /* 缩放：**按作品**记忆。这个作品没记过（或记录坏了）就是 100%（NEW_WORK_ZOOM），
         绝不会继承上一个作品 / 老版本那个全局值；主键在打开时算好，改倍率就写这个键。 */
      zoom: zoomGet(item),
      zoomKey: zoomKeyOf(item)
    };
    open = true;
    root.hidden = false;
    capturePageScroll();                                 // 必须在加 hs-rd-open 之前记（加完就丢了）
    document.body.classList.add('hs-rd-open');            // 防止背景滚动（自己加自己清）
    document.documentElement.classList.add('hs-rd-open');
    clearPages();
    el.foot.hidden = true;
    el.footHint.textContent = '';
    el.error.hidden = true;
    el.title.textContent = S.title || '正在读取…';
    el.src.textContent = SRC_NAME[S.source] + ' · #' + S.id;
    el.prog.textContent = '正在取回页面…';
    el.tip.textContent = '';
    el.chapWrap.hidden = true;
    paintDir();                                          // 沿用上次的阅读方向（默认上下连续）
    paintZoom();                                         // 这个作品自己的倍率（没记过 = 100%）
    resetScroll();
    closeChapPick();                                     // 每次打开都从「收起」开始
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('visibilitychange', onVisible);

    /* 先确认网关在线：图片只能由网关代取（浏览器直连会撞防盗链 / 跨域），
       网关不在时就地给出「怎么启动」的中文提示，而不是让用户等一个笼统的失败 */
    if (!HS.net.gateway.ok) await HS.net.gateway.probe(true);
    if (!HS.net.gateway.ok) {
      HS.toast('在线阅读需要本地网关：先在项目目录执行 node tools/gateway.js', 'err', 5600);
      showError('在线阅读需要本机网关', [
        '图片由本机网关代取（浏览器直接取会撞防盗链 / 跨域），现在没有探测到网关在运行。'
      ], GW_START_HINT);
      el.chapWrap.hidden = true;
      el.foot.hidden = true;
      return;
    }

    try {
      const j = await fetchChapter('');
      S.title = j.title || S.title;
      S.chapters = (j.chapters || []).map(c => ({ id: String(c.id), name: c.name || '' }));
      if (!S.chapters.length) S.chapters = [{ id: '', name: '单章' }];
      S.pagesByCh[0] = j.pages || [];
      /* 上游本身没有可读页（实测：MangaDex 有些条目 /manga/{id}/feed 直接 total=0，
         即这个条目压根没有章节）。以前这里会静默留白、底部还写着「单章 · 没有更多章节」，
         看着像坏了；现在明确说清楚原因，并引导去原站。 */
      if (!S.pagesByCh[0].length && !(j.chapters || []).length) {
        showError('这本在这里没有可读的图', [
          '上游返回了 0 页：可能是这个条目在原站只以卷册 / CD 形式存在、没有可读章节，或者刚好被限流了。'
        ], '可以点右上角「打开原站」去原站看；过一会儿再试也可能只是限流。');
        el.chapWrap.hidden = true;
        paintBar(); paintFoot();
        return;
      }
      S.fetched[0] = true;
      S.lastRendered = 0;
      S.pageTotal = 0;
      renderPages(0, S.pagesByCh[0]);
      root.classList.add('is-ready');
      paintBar(); paintFoot(); paintProg(1);
      /* 首屏按需：只把「当前页 ± 几页」真正挂上 src，后面的等滚动到附近再说 */
      pumpNear();
      /* 横向单页：光加载还不够 —— 一屏只显示 .is-cur 那一页，首屏必须先把第 1 页标出来，
         否则打开时整列都是 display:none（看着是空白），要按一次方向键才出图。
         与 jumpChapter() 里那一行同款（本机实测：纵向打开正常，横向打开原本空白）。 */
      if (isH()) paintHPage();
      watchFoot();
      prefetchNext();
    } catch (e) {
      /* 两种「不是站点坏了」的情况要分开讲清楚，并给能照做的下一步：
         · 网关是旧进程 → 新接口没注册，报「未知接口 /api/reader」
         · 网关没在跑   → fetch 直接网络层报错（连接被拒 / Failed to fetch） */
      const emsg = String((e && e.message) || e || '');
      const staleGw = /未知接口|not found|\b404\b/i.test(emsg);
      const noGw = /failed to fetch|networkerror|load failed|network error|connection refused|econnrefused/i.test(emsg);
      if (staleGw || noGw) {
        HS.toast('在线阅读需要本地网关：先在项目目录执行 node tools/gateway.js', 'err', 5600);
        showError('没能取回页面', [emsg], staleGw
          ? '本机网关是旧进程（没有 /api/reader 接口）：先停掉占用 8788 的旧进程，再在项目目录执行 node tools/gateway.js 重启一次。'
          : GW_START_HINT);
      } else {
        showError('没能取回页面', [emsg],
          '关掉重试即可；如果提示是 Cloudflare 或 403，通常要换一个出口代理。');
      }
      el.chapWrap.hidden = true;
      el.foot.hidden = true;
    }
  };

  RD.close = function () {
    /* 退出阅读器 = 直接回到"小卡片"状态：把放大卡片也一起收掉，不停在放大态 */
    try { if (HS.results && HS.results.closeCard) HS.results.closeCard(); } catch (e) {}
    if (!open) return;
    open = false;
    clearTimeout(autoTimer);
    autoTimer = null;
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onDocDown, true);
    document.removeEventListener('visibilitychange', onVisible);
    releaseImages();
    closeChapPick();
    if (io) io.disconnect();
    if (root) {
      root.hidden = true;
      root.classList.remove('is-ready');
      root.classList.remove('is-chapend');       // 横向章末浮层的让位状态一并清掉
    }
    clearPages();                                        // 关掉时清 src，释放大图
    document.body.classList.remove('hs-rd-open');
    document.documentElement.classList.remove('hs-rd-open');
    S = null;
    /* 解锁之后再把页面滚回原来那一段（根因与时机见上面的说明）：
       这一步必须在 HS.results.closeCard() 之后 —— 卡片的反向动画会重排，
       还原要放到它也落位之后（restorePageScroll 里自己带了那一帧的兜底）。 */
    restorePageScroll();
  };

  /** 点同一个作品 = 切换开关；点别的作品 = 直接换过去 */
  RD.toggle = function (item) {
    if (open && S && S.item && S.source === String(item.source) && S.id === String(item.id)) RD.close();
    else RD.open(item);
  };

})(window.HS);
