/* ==========================================================================
   reader.js — 阶段一 · 在线阅读器
   · 全屏覆盖层（惰性创建）：顶部工具条 + 纵向连续滚动的图片列 + 底部进度条
   · 支持的源**以 SRC_NAME 为准**（与 tools/gateway.js 的 READER_SOURCES 白名单一一对应：
     MangaDex / nhentai / Danbooru / 紳士漫畫 / E-Hentai / Hitomi / Pixiv / 拷贝漫画 /
     禁漫天堂 / porn-comic / LectorManga，一一实现，不再在这里抄一份会过期的清单）
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
    copymanga: '拷贝漫画', jmcomic: '禁漫天堂', porncomic: 'porn-comic',
    lectormanga: 'LectorManga'
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
    porncomic: 'https://porn-comic.com/',
    lectormanga: 'https://lector-mangas.lat/'
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
    /* 拖动平移：pointermove / pointerup 挂在 **window** 上（不是只挂滚动容器）。
       原因见 panMove 的注释：指针拖快一点就会移出容器，只挂容器会「拖两下就断」。
       必须非 passive —— 拖动成立时要 preventDefault，免得选中文字 / 触发图片原生拖拽。 */
    window.addEventListener('pointermove', onTapMove, { passive: false });
    window.addEventListener('pointerup', onTapEnd);
    window.addEventListener('pointercancel', onTapCancel);
    /* 抬起/取消统一在这里收尾（window 上的监听在元素监听之后触发，不影响 onTapEnd 读 panMoved） */
    window.addEventListener('pointerup', panEnd, true);
    window.addEventListener('pointercancel', panEnd, true);
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
    /* 窗口之后再往前要几页（需求③）：这一批是「下一屏就要用」的，值最高 */
    prefetchAhead(hi + 1, n, list);
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
    prefetchAhead(hi + 1, n, list);
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

  /* ---------------- ★r18 需求③★ 提前把后面的页搬回来（交给网关批量预取） ----------------
     为什么要预取：一页图的真实代价是「网关取上游 → 过图片缓存 → 回浏览器」，
     而 loadPage 只让**窗口内**的页开始加载，窗口外是零成本空白 ——
     于是每一次翻页都在付第一字节。这里在窗口之后再往前多要几页，
     让网关并发搬进它自己的图片缓存（/api/prefetch 用与取图**同一把缓存键**），
     用户真翻过去时就是命中缓存：更快，而且上游失败的那几页还有机会被重试一次。
     约束：只认 data-url（真正的 /api/proxy?url=…&referer=… 地址）；同一页只问一次；
     节流（PA_MIN_GAP_MS）避免连续滚动把网关打满；失败静默 —— 预取只是顺手，绝不能影响当前页。 */
  const PA_LOOKAHEAD = 6;
  const PA_MIN_GAP_MS = 1200;
  let paAskedAt = 0;
  function prefetchAhead(from, n, list) {
    const g = HS.net && HS.net.gateway;
    if (!g || !g.prefetch || !g.ok) return;
    if (from >= n) return;
    const now = Date.now();
    if (now - paAskedAt < PA_MIN_GAP_MS) return;
    paAskedAt = now;
    const to = Math.min(n - 1, from + PA_LOOKAHEAD - 1);
    const urls = [];
    for (let i = from; i <= to; i++) {
      const box = list[i];
      if (!box || box.getAttribute('data-prefetched')) continue;
      const du = box.getAttribute('data-url') || '';
      if (!du) continue;
      box.setAttribute('data-prefetched', '1');
      urls.push(du);
    }
    if (urls.length) g.prefetch(urls, { max: PA_LOOKAHEAD, timeout: 9000 });
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
      /* 打开时把当前话滚进视野（100+ 话时不做这一步等于每次都要自己找）。
         ★只动列表自己的 scrollTop，不用 scrollIntoView★（用户报「点章节按钮图片会稍微上滑」）：
         scrollIntoView 会把**所有**可滚祖先都滚一遍，而页面流的可滚祖先是阅读区本身
         —— .hs-rd-pg / .hs-rd-col 现在都是 overflow:auto（见 paintZoom），于是这一下会把
         正在看的漫画往上挪一截。自己算偏移只影响列表这一个盒子，阅读区位置一个像素都不动。 */
      const cur = u.$('.hs-rd-chapitem.is-cur', el.chapList);
      if (cur) {
        const box = el.chapList;
        const top = cur.offsetTop - (box.clientHeight - cur.offsetHeight) / 2;
        box.scrollTop = Math.max(0, top);
      }
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

  /* ======================================================================
     多章节作品的阅读进度：读到第几章、章内第几页
     ----------------------------------------------------------------------
     键 hs.rd.prog.v1   结构 { v:1, items:{ "<source>:<id>": {
       ch: 章节稳定 id（可为 ''）, ci: 章节下标, cn: 总章数,
       nm: 章节名, p: 章内 0 基页下标, pn: 该章页数, t: 写入时间
     } } }
     · 主键口径与缩放完全一致（reuse zoomKeyOf）：同一作品的各章共用一条记录。
     · **章节优先按稳定 id 记**，下标只当兜底：网关侧的章节列表可能被截断 / 重新编号
       （MD_MAX_CHAPTERS / JM_MAX_CHAPTERS 都会截），按 id 找比按下标夹取可靠。
     · 读不到 / JSON 坏 / 无痕模式写不进去 → 静默降级为「没有进度」，绝不抛。
     ====================================================================== */
  const PROG_KEY = 'hs.rd.prog.v1';
  const PROG_VER = 1;
  const PROG_MAX_ITEMS = 600;
  const PROG_TTL = 180 * 864e5;      // 半年没碰过的记录不再续读（还会被上限淘汰）

  /** 通用：读出某个「{v, items}」型 localStorage 键的 items 表 */
  function lsItemsRead(key) {
    const raw = rdLsGet(key);
    if (!raw) return {};
    let db = null;
    try { db = JSON.parse(raw); } catch (e) { return {}; }
    if (!db || typeof db !== 'object' || Array.isArray(db)) return {};
    const items = db.items;
    if (!items || typeof items !== 'object' || Array.isArray(items)) return {};
    return items;
  }

  /** 通用：按 t 升序（最旧在前），t 缺失当 0；同 t 按键名定序，结果可复现 */
  function lsItemsOldest(items) {
    return Object.keys(items).map(k => {
      const r = items[k];
      const t = (r && typeof r === 'object') ? Number(r.t) : 0;
      return { k: k, t: isFinite(t) ? t : 0 };
    }).sort((a, b) => (a.t - b.t) || (a.k < b.k ? -1 : (a.k > b.k ? 1 : 0)));
  }

  /** 通用：写回 items 表；配额满就丢掉最旧的一批再试一次 */
  function lsItemsWrite(key, ver, max, items) {
    const pack = () => JSON.stringify({ v: ver, items: items });
    if (rdLsSet(key, pack())) return true;
    const rows = lsItemsOldest(items);
    const drop = Math.max(1, Math.floor(rows.length / 10));
    if (rows.length - drop < 1) return false;
    rows.slice(0, drop).forEach(r => { delete items[r.k]; });
    return rdLsSet(key, pack());
  }

  /** 读某个作品的进度：没有 / 过期 / 结构坏 → null */
  function progGet(item) {
    const k = zoomKeyOf(item);
    if (!k) return null;
    const r = lsItemsRead(PROG_KEY)[k];
    if (!r || typeof r !== 'object') return null;
    const t = Number(r.t) || 0;
    if (t && Date.now() - t > PROG_TTL) return null;
    const ci = parseInt(r.ci, 10);
    return {
      key: k,
      ch: String(r.ch == null ? '' : r.ch),
      ci: isFinite(ci) && ci >= 0 ? ci : 0,
      cn: Math.max(0, parseInt(r.cn, 10) || 0),
      name: String(r.nm || ''),
      page: Math.max(0, parseInt(r.p, 10) || 0),
      pages: Math.max(0, parseInt(r.pn, 10) || 0),
      ts: t
    };
  }
  /** 对外只读口：recent.js 用它显示「看到第 N 话（最新 / 非最新）」 */
  RD.progressOf = progGet;

  let progTimer = 0;

  /** 记下当前进度。force=false 走 800ms 防抖（滚动时每帧都会调，绝不能每帧写盘） */
  function progSave(force) {
    if (!S) return;
    if (!force) {
      if (progTimer) return;
      progTimer = setTimeout(() => { progTimer = 0; if (S) progSave(true); }, 800);
      return;
    }
    if (progTimer) { clearTimeout(progTimer); progTimer = 0; }
    const key = S.zoomKey;                 /* 与缩放同一个作品主键（RD.open 时算好） */
    if (!key || !S.chapters.length) return;
    const ci = u.clamp(visibleChapter(), 0, Math.max(0, S.chapters.length - 1));
    const ch = S.chapters[ci] || {};
    const items = lsItemsRead(PROG_KEY);
    items[key] = {
      ch: String(ch.id || ''),
      ci: ci,
      cn: S.chapters.length,
      nm: String(ch.name || ''),
      p: Math.max(0, currentIndex()),
      pn: (S.pagesByCh[ci] || []).length || 0,
      t: Date.now()
    };
    lsItemsWrite(PROG_KEY, PROG_VER, PROG_MAX_ITEMS, items);
  }

  /** 把倍数画到 CSS 变量上：图片尺寸由变量算出来，页码 / 章末几何完全不受影响 */
  function paintZoom() {
    if (!root || !S) return;
    const z = S.zoom;
    root.style.setProperty('--hs-rd-zoom', String(z));
    /* ★这里不再 clearPanShift()★（2026-09-23 第 11 轮真机取证修掉的）
       原写法「换倍率就清掉拖拽位移」，在「100% 时先拖动图片、再按放大」这条真实操作上是错的：
       100% 时页盒两轴余量都是 0，拖动只能走 <img> 的 transform 档（见 panPrepareShift：
       pan.shift = !pan.sx && !pan.sy），位移一清，画面立刻弹回正中；紧接着 zoomAnchorApply()
       想用 scrollLeft 把它补回来，而 scrollLeft 已经是 0、补不到负值 ⇒ 只能眼看着跳。
       真机实测 5 种形状（竖/横/方/超宽/小图）在这条路径上**全部漂 47.7~49.6px**。
       缩放本来就该保住拖拽后的位置：zoomAnchorResidual() 是按「panOffset 是活的」设计的
       （那边用 `const pl = p.left - panOffset.x` 把位移反推出去）。所以清理动作只留给
       「换页 goToIndex()」和「重新打开 RD.open()」两处。 */
    /* 溢出策略：★100% 时也保留 auto★（与「按住拖动不限放大态」配套，见 panStart）——
       否则图比一屏大时也没有滚动量，拖动就永远没有位移。
       代价只是「图比容器大」时可能出现细滚动条（scrollbar-gutter: stable 已在 CSS 里，
       出现/消失不会让图片尺寸抖动）；图比容器小时盒子里没有可滚余量，滚动条不会出现。 */
    if (el.scroll) el.scroll.style.overflow = isH() ? 'hidden' : 'auto';
    if (el.pages) el.pages.style.overflow = 'auto';
    /* ★放大态标记★：CSS 靠它给出 cursor:grabbing 与 touch-action:none。
       touch-action:none 只在放大后加 —— 100% 时触屏还要靠浏览器原生滚动翻页，
       那时禁掉 touch-action 会把整页滚不动。 */
    root.classList.toggle('is-zoom', z > 1.001);
    if (el.zoomVal) el.zoomVal.textContent = Math.round(z * 100) + '%';
    if (el.zoomOut) el.zoomOut.disabled = z <= ZOOM_MIN + 1e-6;
    if (el.zoomIn) el.zoomIn.disabled = z >= ZOOM_MAX - 1e-6;
  }

  /* ---------------- 缩放锚点（第 7 轮，第 10 轮重做度量与残差）----------------
     用户报告（第 7 轮）：「在线阅读放缩图片位置会位移，我希望中心线是保持原位的」。
     老实现只改 --hs-rd-zoom：图片以自身左上角为基准变大，视口中心对着的那块内容
     就被推走了（放大后画面整体往左上飘），所以看起来是「位置位移」。
     修法：改倍率之前先记下「视口正中对着图上的哪一个点」（用相对画面盒的分数坐标），
     改完量一次同一个点跑到哪儿了，把滚动量补回去 —— 中心线钉住不动。

     ★第 10 轮为什么要重做度量★
     第 9 轮的补丁用 img 元素盒子的分数坐标，但 object-fit:contain 会在元素盒里留白，
     而元素盒的宽高比又 = 页盒 client 尺寸的宽高比 —— 一放大就冒出滚动条，
     页盒的 clientWidth/clientHeight 同时变化（真机实测 846 → 831、1265 → 1235），
     于是同一个「元素盒分数」在缩放前后指向的画面内容并不完全相同。
     真机实测（tools/ui-truth-before.json，Chrome headless + CDP 真鼠标）：
       100%→120% 漂 27.05px、120%→140% 漂 0.37px、140%→120% 漂 0.31px、
       120%→100% 漂 123.08px —— 漂移全集中在跨越 100% 这个门槛的那一步。
     第 10 轮：① 锚点改成「真正渲染出来的画面」的分数（picBox 用 naturalWidth/Height
     算 contain 之后的画面矩形），与留白、与滚动条怎么变都无关；
     ② 滚动补偿不再是唯一手段：页盒滚不动（≤100%）或滚不到位时，补一层残差位移
     （与手动拖拽同一套 transform 机制），把那个物理点真正送回视口正中。 */
  /** 一个「画面元素」的固有像素尺寸：<img> 看 naturalWidth/Height；禁漫还原用的
      <canvas> 看位图尺寸（width/height 属性就是原图像素）；页盒兜底返回 0（这时
      picBox 会退到「用元素自己的矩形」，与改动前一致）。 */
  function natSize(node) {
    if (!node) return { w: 0, h: 0 };
    if (String(node.tagName || '').toLowerCase() === 'canvas') {
      return { w: node.width || 0, h: node.height || 0 };
    }
    return { w: node.naturalWidth || 0, h: node.naturalHeight || 0 };
  }

  /** 一页里**真正显示出来**的那个元素：canvas → img → 页盒兜底。
      ★为什么不能直接 u.$('.hs-rd-img img')★（2026-09-23 根因）
      禁漫的页在 DOM 里同时躺着两样东西：先建的 <img>（分块还原完就被
      `img.style.display='none'` 藏起来，src 还留着）和还原后的 <canvas class="hs-rd-canvas">。
      用 `.hs-rd-img img` 会命中那个**隐藏的 img**：它的 getBoundingClientRect() 全是 0 ⇒
      picBox() 退化成零矩形 ⇒ 锚点分数变成 0.5/0.5、滚动补偿算成 scrollLeft += (0 - 视口中心)
      （被夹回 0）、残差又因 p.w<1 直接 return = **零补偿**（表现：放大后内容向右长出、
      图片位置向右位移）；同一根因让 imgAtPoint() 把 transform 写到那个隐藏元素上
      = 「100% / 缩小态按住拖不动」。所以这里按「谁有真实矩形就用谁」挑。 */
  function pageVisual(pg) {
    if (!pg) return null;
    const cands = [u.$('.hs-rd-img canvas', pg), u.$('.hs-rd-img img', pg), u.$('.hs-rd-img', pg)];
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i];
      if (!c) continue;
      const r = c.getBoundingClientRect();
      if (r.width >= 1 && r.height >= 1) return c;
    }
    return null;
  }

  function picBox(img) {
    const r = img.getBoundingClientRect();
    const n = natSize(img);
    const nw = n.w, nh = n.h;
    if (!nw || !nh || r.width < 1 || r.height < 1) {
      return { left: r.left, top: r.top, w: r.width, h: r.height, el: r };
    }
    const s = Math.min(r.width / nw, r.height / nh);
    const w = nw * s, h = nh * s;
    return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, w: w, h: h, el: r };
  }

  /** 锚点要用「哪一页」：首选 .is-cur，纵向退到「视口正中命中的那张图」所在的页盒。
      ★为什么必须兜这一层★
      .is-cur 此前**只有横向的 paintHPage() 会写**（它开头就是 `if (!isH()) return;`），
      纵向连续模式的 currentPageEl() 因此恒为 null —— 而 zoomAnchor() / zoomAnchorResidual()
      都以它为入口，两个函数一起空转 ⇒ 纵向缩放是**零补偿**。
      真机实测（tools/reader-zoom-v1.json，Chrome headless + CDP 真鼠标，视口 1280×900）：
        100%→120% 图上那个点漂 79.14px、120%→140% 漂 105.80px、缩小同量级
        （漂移 = |Δ倍数| × 锚点在该图上的分数 × 图高，正好等于「一点没补」的理论值）；
        同一次运行的横向对照是 0.12–0.20px（锚点机制本身没问题，缺的只是「哪一页」）。 */
  function anchorPageEl() {
    const pg = currentPageEl();
    if (pg || isH()) return pg;
    const list = pageEls();
    if (!list.length) return null;
    const cx = window.innerWidth / 2, cy = window.innerHeight / 2;
    let best = null, bestD = Infinity;
    for (let i = 0; i < list.length; i++) {
      const im = pageVisual(list[i]);
      if (!im) continue;
      const r = im.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return list[i];
      const d = Math.abs((r.top + r.bottom) / 2 - cy);   /* 没有页盖住正中就取中心最近的一页 */
      if (d < bestD) { bestD = d; best = list[i]; }
    }
    return best || list[currentIndex()] || null;
  }

  function zoomAnchor() {
    if (!root) return null;
    const pg = anchorPageEl();
    if (!pg) return null;
    const img = pageVisual(pg);
    if (!img) return null;
    const p = picBox(img);
    return {
      img: img,
      fx: p.w > 1 ? (window.innerWidth / 2 - p.left) / p.w : 0.5,
      fy: p.h > 1 ? (window.innerHeight / 2 - p.top) / p.h : 0.5,
      cx: window.innerWidth / 2,
      cy: window.innerHeight / 2
    };
  }

  /** 位移写盘：与手动拖拽同一套（transform + transition:none），只是不经过 pan 状态机 */
  function shiftApply(obj, x, y) {
    if (!obj || !obj.style) return;
    obj.style.transition = 'none';
    obj.style.transform = 'translate3d(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px,0)';
  }

  function zoomAnchorApply(a) {
    if (!a || !a.img || !a.img.isConnected) return;
    const p = picBox(a.img);
    const tx = p.left + a.fx * p.w;          /* 那个物理点现在在屏幕上的位置 */
    const ty = p.top + a.fy * p.h;
    /* 容器在缩放前后「能不能滚」会变（z=1 常常没余量，放大后才有），所以这里重新解一遍。
       ★必须用 scrollPair()：老代码横向走 hBoxFor（h 模式=页盒，对），
       纵向却走 vBoxFor（h 模式候选 .hs-rd-scroll / .hs-rd-col 全是 overflow:hidden、零余量，
       兜底返回的元素根本不滚）⇒ 纵向补偿是空操作 = 用户看到的「左右翻页模式下放缩还是位移」。 */
    const pair = scrollPair();
    /* ★把「滚前还剩多少余量」记回锚点★：zoomAnchorResidual() 要靠它判断「这一轴的误差
       到底是不是滚动已经尽力了」（见那边「为什么残差必须先问余量」）。
       不记的话，残差会把「滚动本来补得挺好、只是亚像素没对齐」的轴也强行夹到边界上。 */
    a.roomX = pair.x ? Math.max(0, pair.x.scrollWidth - pair.x.clientWidth) : 0;
    a.roomY = pair.y ? Math.max(0, pair.y.scrollHeight - pair.y.clientHeight) : 0;
    if (pair.y) pair.y.scrollTop += (ty - a.cy);   /* 往下飘了就往下滚，把点拉回视口正中 */
    if (pair.x) pair.x.scrollLeft += (tx - a.cx);
    else if (pair.y) pair.y.scrollLeft += (tx - a.cx);
  }

  /** 第 10 轮：滚动补不动的部分用位移补足（跨 100% 门槛时页盒滚不动，就靠这一层）。
      夹住的条件是「补完以后整幅画面仍待在页盒里」：页盒是 overflow:hidden，
      顶出去就把画面裁掉一条 —— 宁可留几十像素的位移，也不能切掉画面。 */
  function zoomAnchorResidual(a) {
    if (!a || !a.img || !a.img.isConnected) return;
    /* ★纵向一律不走残差★：纵向的滚动余量总有上万像素（实测 100% 时 root 余量 7757px），
       zoomAnchorApply() 那一步滚动补偿就够钉住锚点；而这里的位移会落到 <img> 的 transform 上，
       纵向的 .hs-rd-img 是 overflow:hidden 且**只比图片本身大一圈**（style.css:2180），
       一挪就被裁掉一条 —— 有位移反而更糟。横向才是必须靠它的一档（≤100% 时页盒两轴都没余量）。 */
    if (!isH()) return;
    const pg = anchorPageEl();
    if (!pg) return;
    /* ★为什么残差必须先问「这一轴的滚动还有没有余量」★（2026-09-23 真机取证修掉的）
       zoomAnchorApply() 的滚动补偿在横图上其实**做对了**：真机实测横图 1600×900 在
       h 模式 100%→120%，滚动把锚点落到离正中 0.29px。可紧接着这里跑第一遍残差时，
       量到「画面自然位置在页盒上沿之上 13.76px」，而夹取区间是 [13.76, 19.10]
       （两端同号 ⇒ **不含 0**），于是把 13.76px 的向下位移写到了 <img> 的 transform 上
       —— 把已经对齐的画面硬推下去 13.76px。用户看到的就是「横图放大时图片会跳一下」，
       实测漂移 13.51px（竖图 0.19px、方图 0.20px，唯独横图中招）。
       根因不是夹取公式写错，而是**分工错了**：滚动已经把误差收到亚像素，
       残差却还要在「自然位置本来就贴边」的画面上再插一脚。
       所以这里的判据是「滚动是否已经无力」：
         · 该轴缩放后有余量（room > 1）⇒ 误差交给滚动，残差不动这一轴；
         · 余量为 0（≤100% 时页盒两轴都没得滚、或已经滚到尽头）⇒ 才由位移补足。
       逐轴判断，而不是整体跳过：横图在 120% 时 x 有余量（给滚动）、y 没余量（给残差），
       正是需要分开处理的组合。 */
    const allowX = !(a.roomX > 1);
    const allowY = !(a.roomY > 1);
    if (!allowX && !allowY) return;              /* 两轴都有滚动余量：残差完全不介入 */
    /* 跑两遍：第一遍补掉大头；第二遍吃掉「布局二次变化」（跨 100% 门槛时页盒 client
       尺寸会变：滚动条出现/消失、CSS 居中规则切换）留下的零头。getBoundingClientRect()
       已经含当前 transform，所以目标位移要**累加**在 panOffset 上，不能重新赋值。 */
    for (let pass = 0; pass < 2; pass++) {
      const p = picBox(a.img);
      if (p.w < 1 || p.h < 1) return;
      const b = pg.getBoundingClientRect();
      const pl = p.left - panOffset.x, pt = p.top - panOffset.y;   /* 去掉位移后的原始画面位置 */
      let dx = panOffset.x + (a.cx - (p.left + a.fx * p.w));
      let dy = panOffset.y + (a.cy - (p.top + a.fy * p.h));
      /* 页盒 overflow:hidden：位移必须保证画面仍「盖住」页盒（顶出去就裁掉一条画面）。
         要求的两个 gap 一正一负时合法区间是**有序**区间 [min,max]：
         画面比页盒大的时候两个 gap 都是负的，这时仍有合法位移区间（把画面往还盖得住
         的方向挪），老代码把它当「空区间」直接归零 ⇒ 120% 时纵向残差 21.49 一直补不掉。 */
      const gx = b.left - pl, hx = b.right - (pl + p.w);
      const gy = b.top - pt, hy = b.bottom - (pt + p.h);
      /* ★夹取只在「画面此刻确实盖住页盒」时才成立★（第 11 轮真机补修）
         画面比页盒小的那一轴（≤100% 的留白轴）本来就没有「盖住」可言：这时按 gap 区间
         夹取会把位移硬拉回 0 —— 用户拖到的位置在缩放时被弹回。真机实测：100% 拖 (130,95)
         放大到 300% 再缩回 100%，竖图漂 45.18px、横图漂 105.76px（横图 x 轴正好填满页盒
         ⇒ 夹取区间塌成 [0,0]，130px 的位移被整个抹掉）。而用户自己拖出缝之后，
        那一轴当下就已经盖不住了 —— 盖不住就不夹，让残差如实把锚点钉回视口正中。 */
      const coverX = p.left <= b.left + 0.5 && p.left + p.w >= b.right - 0.5;
      const coverY = p.top <= b.top + 0.5 && p.top + p.h >= b.bottom - 0.5;
      if (!allowX) dx = panOffset.x;
      else if (coverX) dx = Math.max(Math.min(gx, hx), Math.min(Math.max(gx, hx), dx));
      if (!allowY) dy = panOffset.y;
      else if (coverY) dy = Math.max(Math.min(gy, hy), Math.min(Math.max(gy, hy), dy));
      const moved = Math.abs(dx - panOffset.x) > 0.5 || Math.abs(dy - panOffset.y) > 0.5;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;         /* 已经对上：保持现状 */
      if (!moved) return;                                          /* 第二遍没有新东西可补 */
      panOffset = { x: dx, y: dy };
      shiftApply(a.img, panOffset.x, panOffset.y);
    }
  }

  /** 设定缩放倍数：夹到 50%–300%，按**当前作品**记忆（S.zoomKey 在 RD.open 时算好） */
  function setZoom(v, quiet) {
    if (!S) return;
    const next = normZoom(v);
    /* ★不能在这里对 `next === S.zoom` 早退：≤100% 时画面的位置靠 panOffset 上的残差位移维持，
       早退分支只调 paintZoom()（写一遍 CSS 变量、不做锚点补偿）⇒ 点一下「100%」按钮
       （比如 out2 之后已经是 100%）图片会猛地跳回正中（实测 128.42px）。
       注：paintZoom 现在已不再清位移，这个早退不再有「清位移」的副作用，但上面的「漏补偿」仍然成立。 */
    const anchor = zoomAnchor();              /* 必须在改 --hs-rd-zoom 之前量 */
    S.zoom = next;
    /* 作品主键在 RD.open 时就算好并存进 S —— 别在这里现算 item：S.item 是调用方给的对象，
       中途被换掉的话就会把倍率记到另一个作品头上 */
    zoomSet(S.zoomKey, next);
    paintZoom();                              /* 里面会 clearPanShift：先清掉旧位移再补偿 */
    zoomAnchorApply(anchor);                  /* ① 滚动补偿 */
    zoomAnchorResidual(anchor);               /* ② 滚动补不动的残差（≤100% 只能靠它） */
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
      /* 横向：盒子（.hs-rd-img）已经按倍数长大，canvas 只要铺满盒子就行。
         flex:none 同样必须有 —— 否则 flex 收缩会把放大结果缩回去。 */
      '.hs-rd[data-dir="h"] .hs-rd-img canvas{width:100%;height:100%;flex:none;' +
      'max-width:none;max-height:none;object-fit:contain;}';
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
    /* draggable="false"：图片默认可拖拽，按住一拖就会变成 HTML5 原生拖放，
       期间 pointermove / pointerup **根本不会派发** —— 表现就是「按住拖不动」。
       CSS 里的 -webkit-user-drag:none 只管 WebKit，这里再显式关掉原生死拽。
       注意不影响我们自己的「按住拖动平移」：那是 pointer 事件，与原生拖放无关。 */
    const img = u.el('img', {
      alt: '', loading: 'eager', decoding: 'async', referrerpolicy: 'no-referrer',
      draggable: 'false'
    });
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
    /* 已经是这一章：不重画、不复位滚动（下拉里点到当前话时位置必须原地不动） */
    if (idx === S.lastRendered) return;
    S.busy = true;
    try {
      let pages = S.pagesByCh[idx];
      if (!pages) {
        const j = await fetchChapter(S.chapters[idx].id);
        /* ★取章期间用户可能已经退出阅读器★（用户要求：正在加载图片时也能直接退出）
           RD.close() 已把 S 置空，这里再往下写就是往 null 上写页、写进度 ——
           退出后必须原地收手，不能继续渲染，也不能覆盖已保存的进度。 */
        if (!open || !S) return;
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
      else markCurV(0);                   // 纵向：新章第 1 页就是「正在看的这一页」
      watchFoot();
      prefetchNext();
      progSave(true);                     // 换章 = 一次明确的进度变更，立刻落盘
    } catch (e) {
      if (open && S) HS.toast('打开失败：' + ((e && e.message) || e), 'err', 4200);
    } finally {
      if (S) S.busy = false;              // S 已置空 = 阅读器已关：没有东西要解锁了
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
      /* 取章 / 加载期间退出阅读器：S 已置空，别再往已经拆掉的界面里塞页面 */
      if (!open || !S) return;
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
      if (open && S) el.footHint.textContent = '自动连读失败：' + ((e && e.message) || e) + '（可点「下一话」重试）';
    } finally {
      if (S) S.appending = false;
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
      /* ★纵向也要标 .is-cur★（横向由 paintHPage() 标）：把「正在看的这一页」这个
         共有概念在两种模式下都维护起来 —— 它是 currentPageEl() 的输入。 */
      if (!isH()) markCurV(idx);
      schedulePump();                     // 滚过一屏就重算加载窗口（rAF 合并，滚动时不抖）
      paintProg(idx + 1);
      progSave(false);                    // 进度：800ms 防抖后落盘（每帧写盘会把主线程拖死）
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

  /** 纵向：把 .is-cur 标到 currentIndex() 那一页（横向由 paintHPage() 负责）。
      为什么需要它：currentPageEl() 只认 .is-cur，而纵向此前没人写这个类 ⇒ 恒 null。
      .is-cur 在纵向没有任何样式副作用（style.css 里 .hs-rd-pg.is-cur 的规则全部
      限定在 [data-dir="h"] 下，见 style.css:2305-2307），纯粹是给 JS 读的标记。
      缓存上一次的序号：滚动时每帧都要调它，已经标对就别去动 DOM。 */
  let lastCurV = -1;
  function markCurV(i) {
    if (!el.pages || isH()) return;
    const list = pageEls();
    if (!list.length) return;
    const k = u.clamp(typeof i === 'number' ? i : currentIndex(), 0, list.length - 1);
    if (k === lastCurV && list[k] && list[k].classList.contains('is-cur')) return;
    lastCurV = k;
    for (let n = 0; n < list.length; n++) list[n].classList.toggle('is-cur', n === k);
  }

  /** 停到第 i 页：横向只把这一页显示出来（瞬时，无动画），纵向把它滚到视野顶部 */
  function goToIndex(i) {
    const list = pageEls();
    if (!list.length) return;
    /* 换页复位「图片拖动位移」（第 9 轮：位移现在是保留的，换页必须归零，
       否则下一页会继承上一页拖出来的偏移）。页内的 scroll 偏移另有按页记忆，
       见 paintHPage() —— 两者互不干扰。 */
    clearPanShift();
    const idx = u.clamp(i, 0, list.length - 1);
    if (isH()) {
      S.hIdx = idx;
      paintHPage();                       // paintHPage() 里会立刻按需加载这一页
    } else {
      list[idx].scrollIntoView({ behavior: 'auto', block: 'start' });
      pumpNear();                         // 跳页后立刻按新位置（重新）算加载窗口
      markCurV(idx);                      // 纵向：「正在看的这一页」= 刚跳到的这一页
    }
    paintProg(idx + 1);
    syncFoot();
    progSave(false);                       // 明确跳页：记一次进度（防抖）
  }

  /** 横向：只留当前页（其余 display:none），并更新计数器 / 章末判定。
      hIdx = -1 表示「这一批页还没定位过」→ 默认落在第 1 页（仍然会画出 is-cur）

      ★页内平移位置按页记忆★（放大后左右拖出来的偏移）
      此前每换一页都把位置清零，于是「拖到右下角 → 翻下一页 → 翻回来」会回到左上角，
      用户看到的是「翻页后不在刚才拖动后的位置」。
      这里在切走时把这一页的 scrollLeft/scrollTop 记在页盒自己身上（box._sx/_sy），
      切回来时原样恢复；没拖过的页是 0，行为与改动前一致。
      刻意不落盘：这是「这次阅读时的看图位置」，不是进度，刷新后回到左上角才符合预期。 */
  function paintHPage() {
    if (!root || !isH()) return;
    const list = pageEls();
    if (!list.length) return;
    if (!(S.hIdx >= 0)) S.hIdx = 0;
    const i = u.clamp(S.hIdx, 0, list.length - 1);
    S.hIdx = i;
    /* 先把「正要离开的那一页」的位置记下来，再切类名 */
    const prev = u.$('.hs-rd-pg.is-cur', el.pages);
    if (prev) { prev._sx = prev.scrollLeft; prev._sy = prev.scrollTop; }
    for (let n = 0; n < list.length; n++) list[n].classList.toggle('is-cur', n === i);
    if (el.pages) { el.pages.scrollTop = 0; el.pages.scrollLeft = 0; }
    /* 恢复这一页上次的位置（第一次看 = 左上角） */
    const box = list[i];
    if (box && box !== prev) {
      box.scrollLeft = box._sx || 0;
      box.scrollTop = box._sy || 0;
    }
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

  /* ---------------- 按住拖动 = 平移图片（放大看图的主要手段） ----------------
     位移有两种落点（第 7 轮定稿，判定见下面 panPrepareShift 的注释）：
       · 容器有余量的轴 → 写 scrollLeft / scrollTop（首选：有真实边界、不会露空白）；
       · 两个轴都装得下（整张图都在屏幕里）→ 平移 <img> 自己的 transform，抬手弹回。
     为什么优先「改滚动偏移」而不是一路 transform：
       本文件的缩放（paintZoom）改的是**尺寸变量** --hs-rd-zoom，放大后超出的那部分
       本来就已经在滚动盒子里（纵向 X 在 .hs-rd-col，纵向 Y 在覆盖层 .hs-rd；
       横向在 .hs-rd-pg.is-cur，样式里给了 overflow:auto + scrollbar-gutter:stable）。
       用 transform 平移**页盒**会把 getBoundingClientRect().top 一起挪走，直接破坏
       currentIndex() / visibleChapter() 的翻页判定与 goToIndex() 的 scrollIntoView，
       属于高风险改动 —— 所以第二种落点刻意只动 <img>：currentIndex() 量的是
       .hs-rd-pg 的 rect（reader.js:1234），量不到 <img> 自己的位移。
     行为约定：
       · 任意倍率都能按住拖动（不再要求已放大，见 panStart 注释）；
       · 图比一屏大：拖 = 滚那个方向，到底就停住（有真实边界）；
       · 图整屏装得下：拖 = 图片跟着指针走（橡皮筋软限位），松手 220ms 弹回原位；
       · 位移小于 PAN_SLOP 时不算拖动 —— 「点一下翻页」「点重试按钮」完全不受影响；
       · 拖动一旦成立就 setPointerCapture，指针滑出图外也不会断。 */
  const PAN_SLOP = 4;
  let pan = null;
  /* 本次「按下 → 抬起」序列是否已经构成一次拖动。
     单独用一个标志（而不是读 pan.moved）的原因：pointerup 在 window 上先把 pan 清掉，
     el.scroll 上那个「点一下翻页」的处理器可能已经看不到 pan 了 —— 用标志就不会漏判。 */
  let panMoved = false;

  /* ---------------- 位移落点的判定与「拖动位移」的收尾（第 7 轮 / 第 9 轮） ----------------
     用户要求：「任何大小下都应该实现按住鼠标移动图片的功能」（第 7 轮）；
     第 9 轮追加：「左右翻页模式下，除放大之外都无法拖拽图片，需要修复」。
     每个「按下 → 抬起」先看两个轴各自有没有滚动余量：
       · 只要有一个轴装不下（有余量）→ 照旧拖滚动位置（有边界，也不会露空白）；
       · 两个轴都装得下（整张图都在屏幕里，100% 时就是这一档）→ 拖的是
         **图片自己的位移**：指针移动多少图就挪多少（橡皮筋软限位）。
     ★第 9 轮改的正是这一档的收尾★：以前抬手 220ms 弹回原位 —— 探针实测拖 160px、
     松手 400ms 后 transform 已经变回 none（itf: matrix(…,-157.4,0) → none），
     所以用户看到的是「除了放大根本拖不动」。现在**抬手保留位移**（panOffset 累积，
     下一次按下从当前位置继续拖），复位只发生在换倍率 / 换页 / 重开阅读器时
     （都走 clearPanShift()）—— 拖不丢，也真的拖得动。
     为什么只动 <img> 而不是页盒：见上面「按住拖动」那段的说明（页盒 rect 是翻页
     判定的输入；<img> 的位移量不到，两种落点因此互不干扰）。
     为什么不需要临时取消任何 overflow：位移目标是 <img>，它外面的裁切盒
     （.hs-rd-img / 页盒）本来就跟视口同宽同高，挪开露出的那条边就在视口之内
     （看见的是阅读器底色），所以视觉上成立，不用去动 overflow。
     触屏语义保持原样：touch-action:none 仍然只在 .is-zoom（放大态）下加，
     所以 100% 时单指拖动依旧交给浏览器原生滚动翻页，不会被这里抢走。 */
  /** 已经累积下来的图片位移（像素）；换倍率 / 换页 / 重开阅读器时归零 */
  let panOffset = { x: 0, y: 0 };

  /** 当前页盒（横纵两种模式都靠 .is-cur 标出「正在看的这一页」） */
  function currentPageEl() { return el.pages ? u.$('.hs-rd-pg.is-cur', el.pages) : null; }

  /** 某个盒子在一条轴上的可滚余量（正数才滚得动） */
  function roomOf(box, axis) {
    if (!box) return 0;
    return Math.max(0, axis === 'x' ? (box.scrollWidth - box.clientWidth)
                                    : (box.scrollHeight - box.clientHeight));
  }

  /** 横向真正能滚的盒子：h 模式是当前页盒；v 模式先看 el.pages 再看 root */
  function hBoxFor(pg) {
    if (isH()) return pg || null;
    const cands = [el.pages, el.scroll];
    for (let i = 0; i < cands.length; i++) if (roomOf(cands[i], 'x') > 2) return cands[i];
    return null;
  }

  /** 纵向真正能滚的盒子（vRef() 已按 scrollHeight 选过，这里再确认一次余量） */
  function vBoxFor() {
    const cands = [vRef(), el.scroll, el.pages];
    for (let i = 0; i < cands.length; i++) if (roomOf(cands[i], 'y') > 2) return cands[i];
    return vRef() || el.scroll || null;
  }

  /** 当前模式下「真正会滚」的那对盒子：横轴一个、纵轴一个。
     ★拖动、缩放补偿必须用同一对盒子★ —— 量的点在 A 元素里、补回去的滚动却写在 B 元素上
     （B 根本不滚），表现就是「拖了没反应」「放缩还是会位移」。
       · 横向单页（h）：页盒 .hs-rd-pg 是唯一的滚动容器（overflow:auto，两个轴都它滚），
         而 .hs-rd-scroll 与 .hs-rd-col 都是 overflow:hidden（零余量）⇒ 横纵都取页盒。
       · 纵向连续（v）：纵轴是整列的 vRef()，横轴才是页盒 / root。 */
  function scrollPair() {
    const pg = currentPageEl();
    if (isH()) return { x: pg, y: pg };
    return { x: hBoxFor(pg), y: vBoxFor() };
  }

  /** 指针底下的那张图（没命中就退到当前页的图）—— 拖哪张就动哪张。
      ★必须走 pageVisual()★：禁漫的页在 DOM 里可见的是还原出来的 <canvas>，而
      `.hs-rd-img img` 命中的是那个被 display:none 藏起来的原图（rect 全 0），
      位移就会写到看不见的元素上 = 按住拖了半天画面纹丝不动。 */
  function imgAtPoint(x, y) {
    const list = el.pages ? u.$$('.hs-rd-pg', el.pages) : [];
    for (let i = 0; i < list.length; i++) {
      const ob = pageVisual(list[i]);
      if (!ob) continue;
      const r = ob.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return ob;
    }
    return pageVisual(currentPageEl());
  }

  /** 橡皮筋软限位：超过 limit 之后增长越来越慢，最多到 limit*1.6 —— 拖不飞，也不生硬 */
  function softPan(v, limit) {
    const a = Math.abs(v);
    if (a <= limit) return v;
    const capped = limit * (1 + 0.6 * (1 - Math.exp(-(a - limit) / Math.max(1, limit))));
    return v < 0 ? -capped : capped;
  }

  /** 软限位：100% 这一档图整屏装得下，能挪的范围由它定 —— 够把图推到一边去细看，
      但推不到「丢」的程度（橡皮筋最多到 limit*1.6）。第 9 轮从 ~154px 放宽到 ~384px，
      因为位移现在是**保留**的（不再弹回），范围太小等于「只能抖一下」。 */
  function panShiftLimit() {
    return Math.max(120, Math.min(420, (window.innerWidth || 800) * 0.30));
  }

  /** 写图片位移（拖动中不要 transition，否则跟手会拖出惯性感） */
  function panShiftApply() {
    if (!pan || !pan.obj) return;
    pan.obj.style.transition = 'none';
    pan.obj.style.transform = 'translate3d(' + pan.px.toFixed(1) + 'px,' + pan.py.toFixed(1) + 'px,0)';
  }

  /** 清掉图上的位移，并把累积量归零（换倍率 / 换页 / 重开 / 收尾都用它）。
      目标既可能是 <img>，也可能是禁漫那种还原用的 <canvas> 或盒子本身，三样都清。 */
  function clearPanShift() {
    panOffset = { x: 0, y: 0 };
    if (!el.pages) return;
    const list = u.$$('.hs-rd-img img, .hs-rd-img canvas, .hs-rd-img', el.pages);
    for (let i = 0; i < list.length; i++) {
      if (!list[i].style.transform && !list[i].style.transition) continue;
      list[i].style.transition = '';
      list[i].style.transform = '';
    }
  }

  /** 按下时决定这一轮拖动走「滚」还是走「临时位移」 */
  function panPrepareShift(e) {
    if (!pan) return;
    pan.px = 0; pan.py = 0; pan.obj = null; pan.shift = false;
    /* ★两个轴各解一次「真正会滚的盒子」★：h 模式两个轴都是页盒（老代码这里给
       pan.yBox 留了 undefined，放大后纵向有滚动余量 ⇒ 走动分支时直接抛 TypeError，
       指针处理就此断掉 = 「放大后无法上下拖拽」）。 */
    const pair = scrollPair();
    pan.xBox = pair.x; pan.yBox = pair.y;
    pan.sx = roomOf(pan.xBox, 'x') > 2;
    pan.sy = roomOf(pan.yBox, 'y') > 2;
    /* ★两个轴都装得下 → 才算「整张图都在屏幕里」，这时拖动才落到临时位移上★
       只要有一个轴装不下，就保持老语义（拖 = 滚那一个轴），不会出现
       「斜着一拖整页横着飘」这种副作用。 */
    pan.shift = !pan.sx && !pan.sy;
    if (!pan.shift) {
      /* 起点跟解析出来的盒子对齐（别用按下那一刻另一个元素上的读数） */
      pan.l = pan.xBox ? pan.xBox.scrollLeft : 0;
      pan.t = pan.yBox ? pan.yBox.scrollTop : 0;
      return;
    }
    /* ★这里不再清位移★：位移是累积且保留的（第 9 轮），按下时把它作为起点，
       所以「拖一下、松手、再拖一下」是接着走，而不是每次从 0 重来。 */
    pan.obj = imgAtPoint(e.clientX, e.clientY);
    if (!pan.obj) { pan.shift = false; return; }
    pan.baseX = panOffset.x;
    pan.baseY = panOffset.y;
  }

  function panStart(e) {
    pan = null;
    panMoved = false;
    if (!open || !S || e.button > 0) return;
    /* 工具条按钮 / 「加载失败·重试」/ 章节下拉：不抢它们的指针。
       ★刻意不排除 <a> 和 <img>★ —— 阅读页里的图片就是 <img>，
       排除它等于这个功能在鼠标下永远不触发。 */
    if (e.target && e.target.closest &&
      e.target.closest('button, .hs-rd-retry, .hs-rd-bar, .hs-rd-chappick')) return;
    /* ★按住拖动不再要求已放大★（用户要求：任意倍率都能按住移动图片）
       各模式下的实际位移：
         · 横向单页：写当前页盒子的 scrollLeft/scrollTop —— 页盒子按 contain 显示，
           只要图比一屏大就有真实的横纵滚动量；图比一屏小则没有可滚的余量。
         · 纵向连续：写 vRef() 的 scrollTop / el.pages 的 scrollLeft —— 纵向本来就在滚，
           按住拖动 = 直接拖滚动位置（100% 下同样成立，超出部分能拖着看）。
       「图整屏装得下（两个轴都没有滚动余量）」的那一档由下面的 panPrepareShift()
       接管：位移落到图片自己的 transform 上，抬手弹回（见上面那段说明）。 */
    /* 拖动的盒子（xBox / yBox）与起点 scrollLeft / scrollTop 一律由下面的
       panPrepareShift() 用 scrollPair() 解析 —— 目标只有一个来源，不会再出现
       「按下那一刻读的是 A 元素、指针移动时写的是 B 元素」这种错配。
       这里只负责记指针起点 + 确认这一模式下确实有可拖的容器。 */
    if (isH()) {
      if (!currentPageEl()) return;           /* 一页都还没画出来，没什么可拖的 */
      pan = { id: e.pointerId, x: e.clientX, y: e.clientY, kind: 'h' };
    } else {
      if (!vRef() && !root) return;
      pan = { id: e.pointerId, x: e.clientX, y: e.clientY, kind: 'v' };
    }
    panPrepareShift(e);                       /* 决定这一轮走「滚」还是走「临时位移」 */
  }

  /** 指针移动：★挂在 window 上★，而不是只挂 .hs-rd-scroll。
      只挂滚动容器的话，指针一旦移到图外（拖快一点就会）事件就断了，
      用户看到的就是「拖两下就不动了」。window 上收事件 + pointerId 校验最稳。 */
  function panMove(e) {
    if (!pan || e.pointerId !== pan.id) return;
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    if (!panMoved) {
      if (Math.abs(dx) < PAN_SLOP && Math.abs(dy) < PAN_SLOP) return;
      panMoved = true;
      /* 拖动一旦成立就捕获指针：即使滑出窗口也不会丢事件。
         （刻意不在 pointerdown 就捕获：那会让 click 的 target 变成容器，
           页内「加载失败·重试」这类按钮就点不动了。） */
      const host = el.scroll;
      try { if (host && host.setPointerCapture) host.setPointerCapture(e.pointerId); } catch (err) {}
    }
    if (e.cancelable) e.preventDefault();      /* 拖动中不要选中文字 / 触发图片原生拖拽 */
    if (pan.shift) {
      /* 图整屏装得下：拖的是图片自己（橡皮筋软限位），**抬手保留位移**（第 9 轮）。
         ★符号与下面「滚」那一档一致★：scrollLeft/scrollTop 变小 = 内容朝指针方向走，
         所以位移写 +dx / +dy（老代码是 -dx / -dy，手感正好相反）。 */
      const lim = panShiftLimit();
      pan.px = softPan(pan.baseX + dx, lim);
      pan.py = softPan(pan.baseY + dy, lim);
      panShiftApply();
      return;
    }
    if (pan.sx && pan.xBox) pan.xBox.scrollLeft = pan.l - dx;
    if (pan.sy && pan.yBox) pan.yBox.scrollTop = pan.t - dy;
  }

  /** 指针抬起 / 取消：只清 pan，panMoved 留给 onTapEnd 判「这是拖动不是点击」 */
  function panEnd() {
    if (!pan) return;
    const host = el.scroll;
    try { if (host && host.releasePointerCapture && host.hasPointerCapture &&
      host.hasPointerCapture(pan.id)) host.releasePointerCapture(pan.id); } catch (e) {}
    /* ★抬手保留位移★（第 9 轮）：不再弹回原位 —— 用户要的是「除了放大，100% 也能拖图片」，
       弹回等于拖了白拖。位移上限由 panShiftLimit() 的软限位兜住，图不会被拖丢；
       换倍率 / 换页 / 重开阅读器都会 clearPanShift() 复位。 */
    if (pan.shift && pan.obj) {
      panOffset = { x: pan.px || 0, y: pan.py || 0 };
      pan.obj.style.transition = '';
      pan.obj.style.transform = 'translate3d(' + panOffset.x.toFixed(1) + 'px,' +
        panOffset.y.toFixed(1) + 'px,0)';
    }
    pan = null;
  }

  function onTapStart(e) {
    panStart(e);
    if (!open || !isH() || e.button > 0) { tapFrom = null; return; }
    tapFrom = { x: e.clientX, y: e.clientY, id: e.pointerId };
  }

  function onTapMove(e) { panMove(e); }

  function onTapEnd(e) {
    /* 这一下是「按住拖动」而不是「点一下」：不翻页。panMoved 在下一次 pointerdown 才复位。 */
    if (panMoved) { tapFrom = null; return; }
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

  function onTapCancel() { tapFrom = null; panEnd(); }

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
     时机（第 7 轮修正）：解锁 + 复位要在 RD.close 的**最前面**做完，必须赶在
     HS.results.closeCard() 量出 FLIP 终点之前（原因见 RD.close 里的时序说明）；
     这一步自身仍带 rAF 一次 + 一次短延时兜底（只有又被打回顶部时才补），
     用来兜住卡片反向动画 340ms 落位时的重排。
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

  /** 还原页面滚动。force=true 供「关闭阅读器」用：
      那一刻 open 还是 true（close 的收尾逻辑还没跑完），但页面必须马上解锁复位 ——
      原因见 RD.close 里的时序说明（要赶在 closeCard() 量矩形之前）。 */
  function restorePageScroll(force) {
    const s = pageScrollSave;
    pageScrollSave = null;
    if (!s || (!s.y && !s.x)) return;                    // 本来就在最上面就什么都不用做
    const live = () => (force === true || !open);
    const once = () => {
      if (live() && Math.abs((window.pageYOffset || 0) - s.y) > 1) putPageScroll(s);
    };
    once();                                              // 解锁这一帧先立刻还原
    if (window.requestAnimationFrame) window.requestAnimationFrame(once);
    /* 卡片反向动画 340ms 之后才落位；只有「又被打回顶部」时才再补一次 */
    setTimeout(() => {
      if (live() && (window.pageYOffset || 0) <= 1 && s.y > 1) putPageScroll(s);
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
      zoomKey: zoomKeyOf(item),
      /* 上次读到哪（章节 + 页）；章节列表拿到之后在下面解析成真实的章下标 */
      resume: progGet(item)
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
    clearPanShift();                                     // 重新打开：清掉上次拖拽留下的临时位移（paintZoom 已不代劳）
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

      /* ★续读：把「上次读到第几章第几页」解析成这一批的真实章下标★
         章节**优先按稳定 id 找**（列表可能被网关截断 / 重新编号），找不到再按下标夹取。
         第 0 章已经在上面取回来了，只有 idx > 0 才需要多发一次 /api/reader。 */
      let startCh = 0, startPage = 0;
      if (S.resume && S.chapters.length) {
        let idx = -1;
        if (S.resume.ch) idx = S.chapters.findIndex(c => String(c.id) === S.resume.ch);
        if (idx < 0) idx = u.clamp(S.resume.ci || 0, 0, S.chapters.length - 1);
        if (idx > 0) {
          try {
            const j2 = await fetchChapter(S.chapters[idx].id);
            S.pagesByCh[idx] = j2.pages || [];
            S.fetched[idx] = true;
            startCh = idx;
          } catch (e) {
            /* 那一章取不回来（被删 / 限流）：不打断阅读，老老实实从第 1 章开头开始 */
            startCh = 0;
            HS.toast('上次读到的那一章取不回来了，已从第 1 章打开', 'warn', 3600);
          }
        } else {
          startCh = idx;
        }
        /* 只有「真的落在记录里的那一章」时才恢复页号：
           章取不回来而降级到第 0 章时，那个页号属于另一章，照搬会落到莫名其妙的位置 */
        startPage = (startCh === idx) ? (S.resume.page || 0) : 0;
      }
      const firstPages = S.pagesByCh[startCh] || S.pagesByCh[0] || [];
      S.lastRendered = startCh;
      renderPages(startCh, firstPages);
      root.classList.add('is-ready');
      paintBar(); paintFoot(); paintProg(1);
      /* 首屏按需：只把「当前页 ± 几页」真正挂上 src，后面的等滚动到附近再说 */
      pumpNear();
      /* 横向单页：光加载还不够 —— 一屏只显示 .is-cur 那一页，首屏必须先把第 1 页标出来，
         否则打开时整列都是 display:none（看着是空白），要按一次方向键才出图。
         与 jumpChapter() 里那一行同款（本机实测：纵向打开正常，横向打开原本空白）。 */
      if (isH()) paintHPage();
      else markCurV(0);                   // 纵向：首屏第 1 页就是「正在看的这一页」
      /* 定位到章内那一页。页盒的宽高比由 --hs-rd-ar 占位撑住，所以图片还没下载完
         scrollIntoView 也能落对位置（纵向走 scrollIntoView，横向走 paintHPage）。 */
      const want = u.clamp(startPage, 0, Math.max(0, firstPages.length - 1));
      if (want > 0 || startCh > 0) {
        goToIndex(want);
        HS.toast('已定位到上次读到的地方：' + chapLabel(startCh) +
          (want > 0 ? ' 第 ' + (want + 1) + ' 页' : ''), 'info', 3000);
      }
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
    /* ★退出阅读器 = 直接回到"小卡片"状态★：把放大卡片也一起收掉，不停在放大态。
       第 7 轮时序修正（用户报告：「退出时大卡片乱飘再回到原位变成小卡片」）——
       必须先「解锁页面滚动 + 复位」，再让 results.closeCard() 去做反向动画：
         closeCard() 会量小卡片当前的屏幕矩形当 FLIP 终点（results.js 的
         --cm-x/--cm-y/--cm-r/--cm-s）；而阅读器开着时 html/body.hs-rd-open
         （style.css:1917 `overflow:hidden`）把页面滚动夹在 0，
         于是量到的终点是「页面在最顶部」时的坐标 —— 大卡片朝一个远离用户视口的方向
         飞走，之后 restorePageScroll() 才把页面滚回原位，看起来就是「乱飘再回到原位」。
       安全性：复位只写 window.scrollTo，不会重排卡片；closeCard() 后面摘掉
       .hs-card-ghost（style.css `.hs-card-ghost{opacity:0;pointer-events:none}`）
       也只改 opacity、同样不重排 —— 所以提前解锁不会把滚动位置又顶走。 */
    const wasOpen = !!open;
    if (wasOpen) {
      document.body.classList.remove('hs-rd-open');
      document.documentElement.classList.remove('hs-rd-open');
      restorePageScroll(true);        /* force：这一刻 open 还是 true，必须显式要求还原 */
    }
    try { if (HS.results && HS.results.closeCard) HS.results.closeCard(); } catch (e) {}
    if (!open) return;
    /* ★关闭 = 最后一次可靠的进度落盘时机★
       S 马上就会被置空（下一行往下），而且此时章节 / 页码 / 页数都还是完整的。
       放在最前面写，避免后面任何一步出问题把这次保存吞掉。 */
    try { progSave(true); } catch (e) {}
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
    S = null;
    /* 注意：解锁与页面滚动复位已经在函数开头做完了（必须赶在 closeCard() 量矩形之前，
       否则反向动画的终点是「页面在最顶部」的坐标 —— 见上面的时序说明）。
       这里只把拖拽可能留下的临时位移收干净，避免下次打开残留。 */
    clearPanShift();
  };

  /** 点同一个作品 = 切换开关；点别的作品 = 直接换过去 */
  RD.toggle = function (item) {
    if (open && S && S.item && S.source === String(item.source) && S.id === String(item.id)) RD.close();
    else RD.open(item);
  };

})(window.HS);
