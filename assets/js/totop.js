/* ==========================================================================
   totop.js — 右下角「迅速回顶」按钮
   契约：
   · 只在**滑动超过一段距离**后出现（阈值 = max(480px, 视口高度 × 0.6)），
     回到阈值以上立刻消失 —— 太早出现会压住结果卡片右下角的操作区。
   · 点击后**迅速**回顶：自绘 rAF 补间 340ms easeOutCubic，
     比浏览器原生 scroll-behavior:smooth 快得多（原生在长页面上要 600ms+）。
     动效关闭（html.hs-nomotion / 设置里 animLevel=off / 系统 prefers-reduced-motion）
     时直接瞬移，不做补间。
   · 补间期间用户自己一滚（wheel / 触摸 / 键盘 / 拖动滚动条）就立刻交还控制权，
     绝不跟用户抢滚动。
   · rAF 被挂起（隐藏 / 被遮挡的文档）时不会「点了没反应」：另有一个兜底定时器
     （JUMP_MS×2+150ms）到点直接瞬移收尾，用户抢滚动时两者一起被 disarm() 取消。
   · 纯函数 T.shouldShow(y, vh) 把「该不该出现」抽出来，便于 node:vm 自测，不依赖 DOM。
   · 按钮写在 #hs-app 内（panic 遮蔽时会被一起模糊、连同 pointer-events 一起失效，
     这正是想要的）；z-index 夹在吸顶栏之上、卡片弹窗之下（见 style.css .hs-totop）。
   ========================================================================== */
(function (HS) {
  'use strict';
  const u = HS.u;
  const T = HS.totop = {};

  /* 出现阈值下限：一屏的 0.6 倍 / 480px 取大者 */
  const SHOW_MIN_PX = 480;
  const SHOW_VH_RATIO = 0.6;
  /* 回顶补间时长：用户要的是「迅速」 */
  const JUMP_MS = 340;
  /* 判定「用户自己抢走了滚动」的容差（px） */
  const STEAL_PX = 6;

  let btn = null;
  let raf = 0;
  let guard = 0;          // 兜底定时器：rAF 被挂起时也得把这一跳走完
  let armed = false;      // 补间进行中且已挂上「用户抢滚动」监听

  /** 纯函数：给定滚动位置与视口高度，判断按钮该不该出现 */
  T.shouldShow = function (y, vh) {
    const need = Math.max(SHOW_MIN_PX, Math.round((vh || 800) * SHOW_VH_RATIO));
    return (y || 0) > need;
  };

  function reduced() {
    if (document.documentElement.classList.contains('hs-nomotion')) return true;
    if (HS.settings && HS.settings.animLevel === 'off') return true;
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function scrollY() {
    return window.scrollY || document.documentElement.scrollTop || 0;
  }

  /** 只在**状态真的翻转**时写 DOM：滚动高频里零成本，也避免每帧重排 */
  function paint() {
    if (!btn) return;
    const on = T.shouldShow(scrollY(), window.innerHeight);
    const cur = btn.dataset.show === '1';
    if (on === cur) return;
    btn.dataset.show = on ? '1' : '0';
    btn.tabIndex = on ? 0 : -1;
    btn.setAttribute('aria-hidden', on ? 'false' : 'true');
  }

  /* ---------------- 回顶 ---------------- */
  function disarm() {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (guard) { clearTimeout(guard); guard = 0; }
    if (!armed) return;
    armed = false;
    window.removeEventListener('wheel', onSteal, { passive: true });
    window.removeEventListener('touchstart', onSteal, { passive: true });
    window.removeEventListener('keydown', onSteal);
  }

  function onSteal() { disarm(); paint(); }

  T.jump = function () {
    const y0 = scrollY();
    disarm();
    if (y0 <= 0) { paint(); return; }
    if (reduced()) { window.scrollTo(0, 0); paint(); return; }

    armed = true;
    window.addEventListener('wheel', onSteal, { passive: true });
    window.addEventListener('touchstart', onSteal, { passive: true });
    window.addEventListener('keydown', onSteal);

    /* 兜底：隐藏 / 被遮挡的文档里 Chrome 会挂起 rAF（本项目 reader.js 已实测过同一条
       「隐藏文档不绘制」的路径），补间一帧都跑不了，按钮看着就像坏了。
       到点还没走完就直接瞬移收尾；用户中途抢滚动时 disarm() 会把它一起取消。 */
    guard = setTimeout(function () {
      if (!armed) return;
      window.scrollTo(0, 0);
      disarm();
      paint();
    }, JUMP_MS * 2 + 150);

    const now = () => (window.performance && window.performance.now)
      ? window.performance.now() : Date.now();
    const t0 = now();
    let last = y0;                  // 上一帧我们**写过**的位置，用来识别「被人抢了」

    function step() {
      raf = 0;
      if (!armed) return;
      const cur = scrollY();
      if (Math.abs(cur - last) > STEAL_PX) { disarm(); paint(); return; }  // 滚动条被拖动
      const p = Math.min(1, (now() - t0) / JUMP_MS);
      const e = 1 - Math.pow(1 - p, 3);                                    // easeOutCubic
      const y = Math.round(y0 * (1 - e));
      last = y;
      window.scrollTo(0, y);
      if (p >= 1 || y <= 0) { disarm(); paint(); return; }
      raf = requestAnimationFrame(step);
    }
    raf = requestAnimationFrame(step);
  };

  /* ---------------- 初始化 ---------------- */
  T.init = function () {
    btn = u.$('#to-top');
    if (!btn) return;
    /* 图标表里加了 'up'；万一没取到也不至于整页崩，退化成文字「顶」 */
    const svg = HS.icon && HS.icon.up;
    if (svg) btn.innerHTML = svg;
    else btn.textContent = '顶';
    btn.setAttribute('aria-label', '回到顶部');
    btn.title = '回到顶部';
    btn.setAttribute('aria-hidden', 'true');
    btn.tabIndex = -1;
    btn.dataset.show = '0';

    btn.addEventListener('click', e => { e.preventDefault(); T.jump(); });

    /* 滚动用节流（前沿触发 + 尾部补一次），比 debounce 跟手 */
    window.addEventListener('scroll', u.throttle(paint, 120), { passive: true });
    window.addEventListener('resize', u.debounce(() => { paint(); }, 180));
    paint();
  };

})(window.HS);
