/* ==========================================================================
   app.js — 引导与主流程
   主题 → 成年门 → 模块初始化 → 网络探测 → 搜索主流程（思维链 + 并行检索）
   ========================================================================== */
(function (HS) {
  'use strict';
  const u = HS.u;
  let searching = false;
  let searchedOnce = false;
  /* 检索代次：每提交一次搜索 +1。同一时刻只有「最新那一代」允许写界面 ——
     被打断的旧检索里所有回调都靠它认亲，发现不是自己就安静退出（见 doSearch）。 */
  let searchSeq = 0;

  /* ---------------- 主题 ---------------- */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    const btn = u.$('#theme-toggle');
    if (btn) {
      /* 显示「将要切换到的模式」图标 */
      btn.innerHTML = t === 'dark' ? HS.icon.sun : HS.icon.moon;
      btn.title = t === 'dark' ? '切换到浅色模式' : '切换到深色模式';
    }
  }
  function toggleTheme() {
    HS.settings.theme = HS.settings.theme === 'dark' ? 'light' : 'dark';
    HS.store.save(HS.settings);
    applyTheme(HS.settings.theme);
  }

  function applyBlurCovers(on) {
    document.documentElement.classList.toggle('hs-blurcovers', !!on);
  }

  /* ---------------- 本地网关 ---------------- */
  /** 网关在线 → 更新面板状态、自动启用「拷贝漫画」并提示一次 */
  async function probeGateway(announce) {
    const el = u.$('#f-gw-state');
    if (el) { el.dataset.state = 'busy'; el.textContent = '检测本地网关…'; }
    const ok = await HS.net.gateway.probe(true);
    /* ★r18 需求②④★ 只要网关一连上，就让它立刻把出口自检 / DoH 钉真 IP / 中继选择
       以及四个源（E-Hentai / 拷贝漫画 / porn-comic / MangaDex）的路先热起来。
       GW.warm 会把结论写进 HS.net._gwDiag —— 随后 net.probe 的「网关段」就能直接算出
       **最终**结论（而不必等 /api/diag 那几十秒），临时横幅也就没有出场机会。
       失败一律静默：预热拿不到只是回到原来的路径，不影响任何功能。 */
    if (ok && HS.net.gateway.warm) HS.net.gateway.warm();
    paintGateway(ok, announce);
    return ok;
  }

  function paintGateway(ok, announce) {
    const el = u.$('#f-gw-state');
    const btn = u.$('#f-gw-detect');
    if (btn) btn.dataset.on = ok ? '1' : '0';
    if (el) {
      el.dataset.state = ok ? 'ok' : 'off';
      el.textContent = ok
        ? '✓ 已连接：' + HS.net.gateway.base + '（禁漫官方 API / 拷贝漫画 可用）'
        : '未检测到（运行 node tools/gateway.js 后可解锁禁漫官方 API、拷贝漫画）';
    }
    if (!ok) return;
    /* 网关在的时候把「拷贝漫画」「LectorManga」也打开，用户能在信息源里看到它们。
       这两个源只能经网关取数（不返回跨域头 / 需要签名），网关不在时勾了也是白勾。
       ★只加网关照实报了名字的那些★：`/api/ping` 的 sources 就是「这个进程实现了哪些接口」，
       拿着旧网关（没有 lectormanga 路由）硬开，只会每次检索都多一条红字失败。 */
    const gws = (HS.net.gateway.info && HS.net.gateway.info.sources) || [];
    const want = gws.length ? ['copymanga', 'lectormanga'].filter(id => gws.indexOf(id) >= 0) : ['copymanga'];
    const on = HS.settings.sources || [];
    const add = want.filter(id => on.indexOf(id) < 0);
    if (add.length) {
      HS.settings.sources = on.concat(add);
      HS.store.save(HS.settings);
      if (HS.filtersUI.refreshSources) HS.filtersUI.refreshSources();
      if (announce !== false) HS.toast('检测到本地网关：已启用 ' +
        add.map(id => (HS.sources.byId[id] && HS.sources.byId[id].name) || id).join('、') +
        '，禁漫天堂自动走官方 API', 'ok', 3600);
    }
  }

  /* ---------------- 网络状态 ----------------
     ★探测只在「检索开始之前」发生★
     用户要求：检索过程中不再做网络检查 —— 那一步会白白吃掉几百毫秒到几秒，
     而且它得出的结论对这一次检索毫无用处（最慢的源照样要等）。
     所以现在的分工是：
       · 开机后 260ms 探一次（首屏之前就完成，这是「检索之前就完成」的那一次）；
       · 之后只有**观测到网络情况变化**才重探：online / offline、
         navigator.connection 的 change、本地网关上线下线、页面重新可见、
         以及每 3 分钟一次的空闲复查（仅在没在检索时才允许跑）。
       · doSearch 里的「网络状态」那一步只**读缓存**，一个网络请求都不发。 */
  function paintChip(probe) {
    const chip = u.$('#net-chip');
    const txt = u.$('#net-chip-text');
    if (!chip || !txt) return;
    if (!probe) { chip.dataset.state = 'busy'; txt.textContent = '网络检测中…'; return; }
    const map = {
      ok: ['ok', '目标可达'],
      partial: ['warn', '部分站点受限'],
      restricted: ['warn', '部分受限'],
      offline: ['err', '离线'],
      unknown: ['warn', '网络异常']
    };
    const m = map[probe.verdict] || ['warn', probe.label];
    chip.dataset.state = m[0];
    txt.textContent = m[1];
    chip.title = probe.detail + '（点击重新检测）';
  }

  function showBanner(probe) {
    const b = u.$('#net-banner');
    if (!b) return;
    if (!probe || probe.verdict === 'ok') { b.hidden = true; return; }
    /* ★r18 需求④★ 弹出网页时不该看到「部分网点没有连接」★
       网关在线时，**临时结论**（浏览器侧探针最多 3.5s 就出结果）一律不弹横幅：
       真机实测弹窗后 1 秒内它就写「N/M 个可达，其余浏览器直连失败」，而网关其实早就
       把这些站接住了（/api/warm 立刻能证明）。只等最终结论 —— 那时还有真不可达的才提示。 */
    const gwLive = !!(HS.net.gateway && HS.net.gateway.ok);
    if (probe.provisional && gwLive) { b.hidden = true; return; }
    b.hidden = false;
    b.dataset.kind = (probe.verdict === 'offline' || probe.verdict === 'unknown') ? 'err' : 'warn';
    /* 全程不提 VPN：本地网关自带的「原路 → DoH 钉真 IP → 境内中继」三层补偿
       才是这里的兜底手段，文案要与探针结论一致。 */
    const gwHelps = !!(probe.gatewayTiers && Object.keys(probe.gatewayTiers).length);
    /* ★r17★ 标题也要认「网关在不在」：临时结论里 gatewayTiers 还是 null（要等 /api/diag），
       于是网关明明连着，标题却写「先试本地网关」——真机实测横幅因此自相矛盾
       （描述行说「本地网关已连接」，标题行却叫用户去找网关）。GW.ok 是同步可知的。
       （gwLive 已在函数开头声明：r18 需求④要在那里先把临时结论拦掉） */
    u.$('#net-banner-title').textContent =
      probe.verdict === 'offline' ? '当前设备离线'
        : probe.verdict === 'partial' ? '部分目标站点不可达' + (gwHelps ? '（其余已由本地网关打通）' : '')
        : (gwHelps || gwLive) ? '目标站点浏览器直连不通 —— 本地网关已接管'
        : '部分目标站点取不到数据 —— 先试本地网关，再试公共 CORS 代理';
    u.$('#net-banner-desc').textContent = probe.detail;
    const list = u.$('#net-banner-list');
    list.innerHTML = (probe.blocked || []).slice(0, 5)
      .map(t => '<li>' + u.esc(t.label) + ' 连接失败（' + u.fmtMs(t.ms) + '）</li>').join('');
    u.$('#net-proxy-enable').hidden = HS.net.hasProxy();
  }

  let netWatchTimer = 0;

  async function probeNow(force, announce) {
    /* 只有「用户主动点检测」且手上还没有任何结论时才清空状态；
       否则（网络变化 / 空闲复查）保留上一次的结论，避免右上角无谓地闪一下「检测中」。 */
    if (force && !HS.net.probeCached()) paintChip(null);
    const probe = await HS.net.probe(force);
    paintChip(probe);
    showBanner(probe);
    if (announce) {
      HS.toast(probe.verdict === 'ok'
        ? '网络可达'
        : '检测结果：' + probe.label, probe.verdict === 'ok' ? 'ok' : 'warn', 3200);
    }
    return probe;
  }

  /** 只在「没在检索」时探测；正在检索就推到这一轮结束之后（不打断、不抢网） */
  function probeWhenIdle(force) {
    if (HS.busy || searching) { scheduleNetWatch(4000); return; }
    probeNow(!!force, false);
  }

  function scheduleNetWatch(ms) {
    clearTimeout(netWatchTimer);
    netWatchTimer = setTimeout(() => { netWatchTimer = 0; probeWhenIdle(false); }, ms || 1500);
  }

  /**
   * 网络情况变化监听。
   * 这里就是用户要的「只有观测到网络情况变化才进行」：所有分支都由**事件**驱动，
   * 没有任何一条挂在检索路径上。TTL 到期也不会自己乱探，只有上面那几种变化
   * 或用户手动点「网络检测」才会真的发请求。
   */
  function initNetWatch() {
    const on = (t, fn) => { try { window.addEventListener(t, fn); } catch (e) {} };
    on('online', () => probeNow(true, true));
    on('offline', () => probeNow(true, false));
    /* 网络类型 / 有效带宽变化（Chromium 支持；不支持就静默跳过） */
    try {
      const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (c && c.addEventListener) c.addEventListener('change', () => probeNow(true, false));
    } catch (e) {}
    /* 本地网关的上线 / 下线同样是「网络情况变化」（它决定了禁漫 / 拷贝 / LectorManga 能不能取数） */
    HS.bus.on('net:gateway', () => scheduleNetWatch(600));
    /* 页面重新可见 / 每 3 分钟一次空闲复查：都只在不检索时执行 */
    document.addEventListener('visibilitychange', () => { if (!document.hidden) probeWhenIdle(false); });
    setInterval(() => { if (!document.hidden) probeWhenIdle(false); }, 180000);
  }

  /* ---------------- 欢迎态 ---------------- */
  function renderWelcome() {
    const grid = u.$('#results-grid');
    if (grid.children.length) return;
    u.$('#results-head').hidden = true;
    const box = u.$('#results-empty');
    box.hidden = false;
    /* 空状态里不再放任何说明文字；随机「贤者名言」挂到页面接近底部的独立一层 */
    box.innerHTML = '';
    sageLine(sagePick());
  }

  /** 取一句随机贤者名言（贤者时间 neta，仿贤人语录体） */
  function sagePick() {
    const qs = HS.SAGE_QUOTES || [];
    return qs.length ? qs[Math.floor(Math.random() * qs.length)] : null;
  }

  /** 贤者名言：固定在页脚上方那一层里；检索一开始就收起来 */
  function sageLine(s) {
    let el = u.$('#sage-line');
    if (!el) {
      el = u.el('div', { id: 'sage-line', class: 'hs-sageline', hidden: true });
      document.body.appendChild(el);
    }
    if (!s) { el.hidden = true; el.innerHTML = ''; return; }
    el.innerHTML = '<blockquote class="hs-sage"><p>' + u.esc(s.text) + '</p>' +
      '<cite>—— ' + u.esc(s.who) + '</cite></blockquote>';
    el.hidden = false;
  }
  /* ---------------- 黑话提示（纯旁路：只产出提示，绝不改写查询词） ----------------
     词典接口缺失（脚本没加载 / 词典文件缺失）时 DICT 为 null，本功能整体静默关闭，
     检索链路完全不受影响（C4）。判定结果只变成搜索框里的一个泡泡；点泡泡里的 chip
     才会走 boot 里既有的 [data-q] 委托写回 #q 并重新检索（C1）。 */
  const DICT = (HS.dict && typeof HS.dict.lookup === 'function') ? HS.dict : null;
  let slangEl = null;                                   /* 搜索框内的泡泡（懒创建，不动 index.html 的 DOM） */
  let slangCtx = { token: 0, q: '', empty: null, hits: [], dismissed: false };

  function slangLookup(q) {
    try {
      if (!DICT) return { hits: [], pending: [] };
      const r = DICT.lookup(q);
      if (r && Array.isArray(r.hits)) return { hits: r.hits, pending: Array.isArray(r.pending) ? r.pending : [] };
    } catch (e) { /* 静默降级：词典出问题绝不影响检索 */ }
    return { hits: [], pending: [] };
  }

  /** 建泡泡：挂在 .hs-searchbar 里，绝对定位到「已输入文字之后」 */
  function slangBox() {
    if (slangEl && slangEl.isConnected) return slangEl;
    const bar = u.$('.hs-searchbar');
    if (!bar) return null;
    const el = u.el('div', {
      class: 'hs-slang-bubble', role: 'group', 'aria-label': '黑话提示',
      'data-open': '0', 'data-flip': '0', hidden: true
    });
    el.innerHTML = '<span class="hs-slang-lead" aria-hidden="true">理解为</span>' +
      '<span class="hs-slang-chips"></span>' +
      '<button class="hs-slang-x" type="button" aria-label="收起黑话提示">×</button>';
    bar.appendChild(el);
    slangBind(el);
    return (slangEl = el);
  }

  function slangBind(el) {
    if (el._slangBound) return;
    el._slangBound = 1;
    /* 点泡泡外面（输入框本身除外）收起 */
    document.addEventListener('pointerdown', e => {
      if (!slangEl || slangEl.hidden) return;
      if (slangEl.contains(e.target)) return;
      if (e.target === u.$('#q')) return;
      slangDismiss();
    }, true);
    el.addEventListener('click', e => {
      if (e.target.closest('.hs-slang-x')) slangDismiss();
    });
    /* Esc 收起（并把焦点还给输入框）。
       注意 #q 是 type="search"：Chromium 的原生行为是 Esc 清空输入框。
       泡泡开着时先吃掉这一下 —— 否则用户只想收起提示，却把关键词一起弄丢了。 */
    document.addEventListener('keydown', e => {
      if (!slangEl || slangEl.hidden) return;
      if (e.key !== 'Escape') return;
      e.preventDefault();
      slangDismiss();
      const q = u.$('#q');
      if (q) q.focus();
    });
    const q = u.$('#q');
    if (!q) return;
    /* ↓ / → 从输入框进入泡泡（键盘可达；chip 是真按钮，回车/空格即应用） */
    q.addEventListener('keydown', e => {
      if (!slangEl || slangEl.hidden) return;
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowRight') return;
      const first = slangEl.querySelector('.hs-slang-chip[data-q]') || slangEl.querySelector('.hs-slang-x');
      if (first) { e.preventDefault(); first.focus(); }
    });
    /* ★第 7 轮 ④：打字判定不在这里绑★
       slangBind 只有泡泡**首次创建**时才跑（slangBox ← slangPaint ← slangRefresh），
       而 slangRefresh 以前只在提交检索后调用 —— 冷启动、还没检索过时这段根本不执行，
       所以「把 input 监听写进 slangBind」= 监听永远不注册（真机实测：打字出来了联想列表、
       泡泡一个都没有）。改由 slangWatchInput() 在 bind() 里无条件挂一次。 */
  }

  function slangClose() {
    if (!slangEl) return;
    slangEl.hidden = true;
    slangEl.setAttribute('data-open', '0');
  }

  /** 用户主动收起：本轮检索内不再自动弹回来（检索结束时的重画也不许重新打开） */
  function slangDismiss() {
    slangCtx.dismissed = true;
    slangClose();
  }

  /** 量出输入框里已输入文字的像素宽度（用 canvas 按输入框的实际字体量） */
  function slangTextWidth(input) {
    try {
      const cs = window.getComputedStyle(input);
      const c = slangTextWidth._c || (slangTextWidth._c = document.createElement('canvas'));
      const ctx = c.getContext ? c.getContext('2d') : null;
      if (!ctx) return input.value.length * 9;
      ctx.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
      return ctx.measureText(input.value).width;
    } catch (e) { return input.value.length * 9; }
  }

  /** 泡泡锚点 = 输入框左内边距 + 文字宽度；右侧被清空/搜索按钮挡住时翻到搜索框下方 */
  function slangPlace() {
    const el = slangEl, bar = u.$('.hs-searchbar'), input = u.$('#q');
    if (!el || !bar || !input) return;
    const barRect = bar.getBoundingClientRect();
    if (!barRect.width) return;
    try {
      const inRect = input.getBoundingClientRect();
      const cs = window.getComputedStyle(input);
      const padL = parseFloat(cs.paddingLeft) || 0;
      const want = (inRect.left - barRect.left) + padL + slangTextWidth(input) + 10;
      const clear = u.$('#clear-q');
      const go = u.$('#search-btn');
      const clearRect = (clear && !clear.hidden) ? clear.getBoundingClientRect() : null;
      const goRect = go ? go.getBoundingClientRect() : null;
      const edge = clearRect ? clearRect.left : (goRect ? goRect.left : barRect.right);
      const limit = (edge - barRect.left) - 8;
      const w = el.offsetWidth || 220;
      const inline = want + w <= limit;
      const maxLeft = Math.max(6, barRect.width - w - 8);
      el.setAttribute('data-flip', inline ? '0' : '1');
      /* data-flip=1 时泡泡整块翻到搜索框下方，left 只需夹在盒内；两支以前写成了同一个
         表达式（`inline ? want : want` 恒等），翻下去之后仍按 want 定位 —— 顺手清掉死分支。 */
      el.style.left = Math.round(Math.max(6, Math.min(want, maxLeft))) + 'px';
      el.style.maxWidth = Math.round(Math.max(120, barRect.width - 12)) + 'px';
    } catch (e) { el.setAttribute('data-flip', '0'); }
  }

  /** 画泡泡：show 是已经分好档、截过条的 Hit 列表（最多 2 条，3.9） */
  function slangPaint(show) {
    if (!DICT) return;
    const el = slangBox();
    if (!el) return;
    const input = u.$('#q');
    if (slangCtx.dismissed) { slangClose(); return; }
    if (!show || !show.length || !input || !input.value.trim()) { slangClose(); return; }
    const chips = el.querySelector('.hs-slang-chips');
    if (chips) chips.innerHTML = DICT.chipsHTML(show);
    let anyActive = false;
    for (let i = 0; i < show.length; i++) if (DICT.tier(show[i]) === 'active') { anyActive = true; break; }
    const lead = el.querySelector('.hs-slang-lead');
    if (lead) lead.textContent = anyActive ? '理解为' : '可能理解为';
    el.setAttribute('data-tier', anyActive ? 'active' : 'low');
    el.setAttribute('aria-label', '黑话提示：' + DICT.ariaText(show));
    el.hidden = false;
    el.setAttribute('data-open', '1');
    slangPlace();
  }

  /** 主动提示档随时出；低置信档只在「无结果」时出（3.9 两档策略） */
  function slangRefresh(withLow) {
    if (!DICT) return;
    const a = DICT.pick(slangCtx.hits, 'active', 2);
    const l = withLow ? DICT.pick(slangCtx.hits, 'low', Math.max(0, 2 - a.length)) : [];
    slangPaint(a.concat(l));
  }

  /** 3.8-2/3：命中锚点但对应 IP 包未加载 → 异步补加载，到齐后重算一次并追加提示。
      绝不重发检索请求（检索词从未因词典改变过）。 */
  function slangLoadPending(pending, token) {
    if (!DICT || !pending || !pending.length) return;
    Promise.all(pending.map(id => DICT.load(id))).then(() => {
      if (token !== slangCtx.token) return;         /* 已经是另一次检索了 */
      slangCtx.hits = slangLookup(slangCtx.q).hits;
      slangRefresh(slangCtx.empty === true);
    }).catch(() => { /* 包拉不到就维持原样，静默 */ });
  }

  /** ④ 打字过程中就出泡泡：把判定链路挂到输入框上，**无条件**绑一次（不依赖泡泡是否已创建）。
      三点注意：
      ① IME 组字中不查：中文输入法会产生一串 isComposing 的 input 事件，拿拼音串查词典只会闪噪声；
         组字结束（compositionend）再查一次，才是用户真正打进去的那个词。
      ② 防抖 + token：连打时只查最后一次；每次 token +1，先前在途的补包回来认不出亲就作废。
      ③ 手动改词后旧提示仍立刻失效 —— 由「重新判定」取代「直接收起」：新词没命中就
         slangPaint([]) 主动收起，泡泡也不会停在旧锚点上。 */
  let slangWatchBound = false;
  function slangWatchInput() {
    if (slangWatchBound) return;
    const q = u.$('#q');
    if (!q) return;
    slangWatchBound = true;
    q.addEventListener('input', e => {
      if (e && (e.isComposing || e.inputType === 'insertCompositionText')) return;
      slangTypeSoon();
    });
    q.addEventListener('compositionend', () => slangTypeSoon());
  }

  /** ④ 打字判定：防抖后走与「提交检索」完全相同的链路（命中分档 / 懒补包 / 画泡泡全部复用） */
  const SLANG_TYPE_MS = 180;
  let slangTypeTimer = 0;
  function slangTypeSoon() {
    if (!DICT) return;
    if (slangTypeTimer) clearTimeout(slangTypeTimer);
    slangTypeTimer = setTimeout(function () {
      slangTypeTimer = 0;
      const input = u.$('#q');
      const raw = input ? String(input.value || '').trim() : '';
      const r = slangLookup(raw);
      slangCtx = { token: slangCtx.token + 1, q: raw, empty: null, hits: r.hits, dismissed: false };
      slangRefresh(false);
      slangLoadPending(r.pending, slangCtx.token);
    }, SLANG_TYPE_MS);
  }

  /** 黑话 chip 上的 data-q-span（"起,止"）→ [起,止]；缺失/不合法返回 null */
  function slangSpan(v) {
    const m = /^(\d+),(\d+)$/.exec(String(v == null ? '' : v));
    if (!m) return null;
    const a = Number(m[1]), b = Number(m[2]);
    return b > a ? [a, b] : null;
  }

  /**
   * 黑话 chip 点击后的 #q 文本：**只把被点中的那一段**换成 hintQuery，同一句里别的片段
   * 原样留着（「牛头人 车万」点其一，不会把另一个也抹掉）。这是一次由用户点击引发的普通
   * 文本编辑，属 C1 允许的动作 —— 判定本身仍是纯旁路，不点就一个字节都不改。
   * 片段信息缺失、或与当前输入对不上（用户中途手改过词）→ 退回整串替换（老行为）。
   */
  function slangApplyChip(input, btn) {
    const d = (btn && btn.dataset) || {};
    const want = d.q || '';
    if (!input) return want;
    const span = slangSpan(d.qSpan);
    const from = d.qFrom || '';
    if (!span || !from) return want;
    const raw = input.value || '';
    /* lookup 拿的是 trim 后的串，Hit.span 也是；补回前导空白才是 raw 里的下标 */
    const lead = raw.length - raw.replace(/^\s+/, '').length;
    const s = lead + span[0], e = lead + span[1];
    if (e > raw.length || raw.slice(s, e) !== from) return want;
    return raw.slice(0, s) + want + raw.slice(e);
  }

  /* ---------------- 搜索主流程 ---------------- */
  function setBusy(on) {
    const btn = u.$('#search-btn');
    btn.disabled = on;
    btn.dataset.busy = on ? '1' : '0';
    u.$('.hs-sb-go-txt', btn).textContent = on ? '检索中' : '搜索';
  }

  function catLabels(codes) {
    return (codes || []).map(c => {
      const d = HS.CATS.find(x => x.code === c);
      return d ? d.label : c;
    }).join('/');
  }

  function describeFilters(q, f) {
    const bits = [];
    if (q) bits.push('关键词 “' + q + '”');
    if (f.artist) bits.push('画师 ' + f.artist);
    if ((f.cats || []).length) bits.push('类型 ' + catLabels(f.cats));
    if ((f.tags || []).length) bits.push('标签 ' + f.tags.join('/'));
    if ((f.excludeTags || []).length) bits.push('排除 ' + f.excludeTags.join('/'));
    if ((f.langs || []).length) bits.push('语言 ' + f.langs.join('/'));
    if (f.pagesMin || f.pagesMax) bits.push('页数 ' + (f.pagesMin || 0) + '–' + (f.pagesMax || '∞'));
    if (f.gore && f.gore !== 'any') bits.push('R18G ' + ({ only: '只看', exclude: '排除' }[f.gore] || f.gore));
    if (f.ai && f.ai !== 'any') bits.push('AI 绘画 ' + ({ only: '只看', exclude: '排除' }[f.ai] || f.ai));
    if (f.fem && f.fem !== 'any') bits.push('堪美/女性向 ' + ({ only: '只看', exclude: '排除' }[f.fem] || f.fem));
    if (f.threeD && f.threeD !== 'any') bits.push('3D ' + ({ only: '只看', exclude: '排除' }[f.threeD] || f.threeD));
    if (f.adult === 'strict') bits.push('只留已确认成人向');
    return bits.join(' · ') || '无附加条件';
  }

  async function doSearch(opts) {
    /* 一个源都没启用就别发请求了：以前还有「示例数据」兜底，现在没有兜底源 */
    if (!HS.sources.enabled().length) {
      HS.toast('没有启用任何信息源：在筛选面板的「信息源」里勾选至少一个', 'warn', 4200);
      HS.filtersUI.openSheet(true);
      return;
    }
    sageLine(null);      // 一开始检索就把底部那句名言收起来
    opts = opts || {};
    const page = Math.max(1, parseInt(opts.page || 1, 10) || 1);
    const append = page > 1;
    const q = (u.$('#q').value || '').trim();
    const f = HS.filtersUI.get();
    const hasFilter = f.artist || (f.tags || []).length || (f.langs || []).length ||
      (f.cats || []).length || f.pagesMin || f.pagesMax || (f.gore && f.gore !== 'any') || (f.ai && f.ai !== 'any') ||
      (f.fem && f.fem !== 'any') || (f.threeD && f.threeD !== 'any') ||
      f.adult === 'strict';

    if (!q && !hasFilter) {
      HS.toast('请输入关键词，或展开筛选指定画师 / 标签 / 作品类型', 'warn', 3200);
      HS.filtersUI.openSheet(true);
      u.$('#q').focus();
      return;
    }

    /* ★新检索打断旧检索★
       以前这里是 `if (searching) return;` —— 检索中再按一次回车等于什么都没发生，
       用户只能干等最慢的源把 22 秒预算耗完（也正是「搜索似乎卡住了」的来源）。
       现在改成**当场接管**，分两步，缺一不可：
         ① 网络层：closeScope() 把上一次检索的整个网络作用域 abort 掉 ——
            那一批在途请求（多源 × 多候选串 × 代理链）在同一帧内全部断掉；
         ② 逻辑层：代次 +1，旧链路里的每个回调（思维链逐条写入、逐源胶囊、
            流式 push、finally 里的状态复位）第一件事就是比对代次，
            不是最新一代就 return —— 绝不会把旧结果写进新检索的界面。
       两步都要做：只 abort 网络的话，旧链路 catch 到 AbortError 仍会去写 DOM。 */
    const mySeq = ++searchSeq;
    const isStale = () => mySeq !== searchSeq;
    const superseded = searching;
    if (superseded) {
      try { HS.net.closeScope(); } catch (e) {}
      HS.toast('已打断上一次检索，正在按新关键词重新检索', 'ok', 2600);
    }

    /* 黑话判定第一遍：同步（核心层永远就绪）。纯旁路，不改 q、不改 intent（C1） */
    const slang = slangLookup(q);

    searching = true;
    HS.busy = true;

    /* ★从这里开始就进 try★
       旧代码把 HS.busy = true 与下面这一串 UI 准备（slangRefresh / setBusy / chain.begin /
       skeletons / streamStart）放在 try **之外**：其中任何一处抛错，HS.busy 就永远停在 true，
       而 results.js 的滚动加载与底部补刀都以 HS.busy 为闸门 —— 表现就是「往下滑再也不出新作品」，
       只能刷新页面。把它整段纳入 try，catch/finally 就一定能把它复位。 */
    try {
      searchedOnce = true;
      slangCtx = { token: slangCtx.token + 1, q: q, empty: null, hits: slang.hits, dismissed: false };
      const mySlangToken = slangCtx.token;            /* 本次检索的提示身份，异步回调靠它认亲 */
      slangClose();                                   /* 上一轮的提示先收起 */
      slangRefresh(false);                            /* 主动提示档立刻出泡泡（3.8-1） */
      slangLoadPending(slang.pending, slangCtx.token);
      setBusy(true);
      const nb = u.$('#net-banner'); if (nb) nb.hidden = true;
      if (!append) HS.results.skeletons(Math.min(HS.settings.perSource, 12));

      const C = HS.chain;
      C.begin();
      const srcList = HS.sources.enabled();
      C.prepareSources(srcList);
      HS.results.streamStart(q, f, page);

      /* ★代次守卫遍布每一个 await 之后★
         一次检索里有好几处 await（打字机、sleep）。用户中途又提交了搜索时，
         旧链路会从 await 处**继续往下跑**——如果不在这里拦，它就会把
         「选择信息源」「并行发起检索请求」这些行**追加到新检索的思维链上**
         （实测过：同一条「启用：…」会重复出现两次，看起来像新检索自己发了两次）。
         拦截点只有一个判据：代次不是最新的，就地退出，一个字都不写。 */
      /* 1. 查询解析：按意图分流（作品名 / IP 角色 / 体裁题材 → 不同检索策略） */
      const intent = u.classifyQuery(q);
      const intentExtra = intent.series ? '（' + intent.series + '）'
        : (intent.genre ? '（' + intent.genre.label + '）' : '');
      const s1 = C.step(append ? '准备追加下一批结果…' : '解析查询意图…');
      await s1.typed;
      await u.sleep(90);
      if (isStale()) return;
      s1.set('ok', intent.label,
        '意图判定：' + intent.label + intentExtra + ' · ' + describeFilters(q, f));
      C.progress(16);

      /* 2. 网络状态（★只读缓存，绝不在这里发探测请求★）
         探测已经在「检索之前」完成（开机那一次 + 之后每次网络变化）。
         这里只是把已知结论写进思维链，所以这一步是 0 延迟的 ——
         既不再拖慢检索，也不会把「探测网络环境」这种与本次查询无关的工作塞进主流程。 */
      const s2 = C.step('网络状态（已提前检测）…');
      const probe = HS.net.probeCached();
      if (isStale()) return;
      if (probe) {
        paintChip(probe);
        s2.set(probe.verdict === 'ok' ? 'ok' : 'warn',
          probe.verdict === 'ok' ? '直连可用' : probe.label,
          '缓存结论：' + (probe.verdict === 'ok' ? '网络可达' : probe.label) +
          '（' + probe.targets.filter(t => t.ok).length + '/' + probe.targets.length +
          ' 个探测点连通）· 检测于 ' + Math.max(0, Math.round((Date.now() - probe.ts) / 1000)) + ' 秒前');
      } else {
        /* 缓存还没到（极少数：开机探测尚未回来就提交了搜索）：不阻塞，后台补一次 */
        s2.set('ok', '后台检测中', '本次检索不等待网络检测；结论出来后会更新右上角状态' + '。');
        scheduleNetWatch(400);
      }
      C.progress(32);

      /* 3. 信息源选择 */
      const s3 = C.step('选择信息源（并行调度）…');
      await s3.typed;
      if (isStale()) return;
      const plan = HS.sources.plan(srcList.length);
      s3.set('ok', srcList.length + ' 个源', '启用：' + srcList.map(s => s.name).join(' · ') +
        '｜每源最多 ' + plan.limit + ' 条' +
        (plan.auto ? '（' + srcList.length + ' 个源 × ' + plan.limit + ' ≈ 目标 ' + plan.target + ' 条，源少就多要）' : '（固定每源条数）') +
        (HS.net.hasProxy() && HS.net.userProxy() !== 'auto'
          ? '｜经代理 ' + HS.net.proxyName(HS.settings.proxy)
          : (HS.settings.autoProxy !== false ? '｜自动代理链' : '｜仅直连')) +
        (page > 1 ? '｜第 ' + page + ' 页（追加）' : ''));
      C.progress(44);

      /* 4. 并行检索 */
      const s4 = C.step('并行发起检索请求…');
      const t4 = u.now();
      let done = 0;
      /* ★开检索作用域★：从这里往下发出的每一个网络请求都归属本次检索，
         下一次提交搜索时会由 HS.net.closeScope() 一次性 abort（见函数顶部）。 */
      HS.net.openScope();
      const results = await HS.sources.run({
        q, filters: f, page, intent,
        capMs: HS.sources.RUN_CAP_MS,
        isStale: isStale,
        onStart: src => { if (!isStale()) C.setSource(src.id, 'run'); },
        onDone: (src, r) => {
          if (isStale()) return;                    /* 已被新的检索接管：一个字都不写 */
          done++;
          C.setSource(src.id, r.ok ? 'ok' : 'fail', r.ms, r.ok ? r.items.length : 0, r.error);
          C.progress(44 + (done / srcList.length) * 34);
          C.step(
            r.ok
              ? '✓ ' + src.name + ' 返回 ' + r.items.length + ' 条（' + u.fmtMs(r.ms) + '）'
              : '✕ ' + src.name + ' 失败：' + r.error,
            { state: r.ok ? 'ok' : 'fail', meta: u.fmtMs(r.ms) }
          );
          /* 先到的源先出结果，不等最慢的源 */
          HS.results.streamPush(r);
        }
      });
      if (isStale()) return;                        /* 旧检索：结果与界面全部作废 */
      const okList = results.filter(r => r.ok && r.items && r.items.length);
      const failList = results.filter(r => !r.ok);
      s4.set(okList.length ? 'ok' : 'fail',
        okList.length + ' / ' + results.length + ' 个源有结果',
        '并行请求耗时 ' + u.fmtMs(u.now() - t4) + '：成功 ' + okList.length + ' · 失败 ' + failList.length);
      C.progress(80);

      /* 5. 聚合去重 */
      const rawTotal = results.reduce((n, r) => n + ((r.ok && r.items) ? r.items.length : 0), 0);
      const s5 = C.step('跨源比对、去重与合并…');
      await u.sleep(140);
      if (isStale()) return;
      const items = HS.results.render(results, { q, f, page });
      s5.set('ok', rawTotal + ' → ' + items.length,
        '聚合完成：原始 ' + rawTotal + ' 条 → 跨源去重后 ' + items.length + ' 条');
      C.progress(92);

      /* 6. 重排 */
      const s6 = C.step('按相关度重排、归并同系列…');
      await u.sleep(140);
      if (isStale()) return;
      const stacks = HS.results.stackCount ? HS.results.stackCount() : 0;
      s6.set('ok', 'Top ' + Math.min(items.length, 5),
        items.length
          ? '重排完成：' +
            (stacks ? stacks + ' 组高度相符的同系列已叠成卡片（悬停展开） · ' : '') +
            (HS.settings.blurCovers ? '封面与角标默认模糊' : '封面直接显示') +
            ' · 单页展示，向下滚动继续加载'
          : '未得到有效结果，建议放宽语言/类型或开启代理');
      C.progress(100);

      const ms = C.finish({
        status: items.length ? '完成' : '无结果',
        ok: items.length > 0,
        hint: items.length ? items.length + ' 条结果' : '无结果',
        line: (append ? '第 ' + page + ' 页检索完成：累计 ' : '检索完成：') +
          items.length + ' 个可能相关的结果'
      });
      const zhN = items.filter(i => i.zh).length;
      const it = HS.results.intent || {};
      const intentBit = (it.kind && it.kind !== 'empty')
        ? ' · 策略 <b class="hs-intent">' + u.esc(it.label) + '</b>' +
          (it.series ? '（' + u.esc(it.series) + '）' : (it.genre ? '（' + u.esc(it.genre.label) + '）' : ''))
        : '';
      u.$('#results-meta').innerHTML =
        '找到 <em>' + items.length + '</em> 个可能相关的结果' + intentBit +
        (items.length > HS.results.pageSize() ? ' · 向下滚动继续加载' : '') +
        (zhN ? ' · <b class="hs-zh-count">' + zhN + ' 个有汉化/中文</b>' : '') +
        ' · 用时 ' + u.fmtMs(ms) + ' · 成功源 ' + okList.length + '/' + results.length;
      /* 低置信档只在「无结果」时才追加进泡泡（3.9）；有结果时维持主动提示档 */
      if (slangCtx.token === mySlangToken) {
        slangCtx.empty = items.length === 0;
        slangRefresh(slangCtx.empty);
      }
      if (typeof opts.after === 'function') opts.after(items);

      if (items.length && failList.length && !HS.net.hasProxy()) {
        const proxied = failList.filter(r => HS.sources.byId[r.src.id] && HS.sources.byId[r.src.id].proxy);
        if (proxied.length) {
          HS.toast(proxied.map(r => HS.sources.byId[r.src.id].name).join('、') + ' 因跨域限制失败，可在「筛选 → CORS 代理」启用代理', 'warn', 5200);
        }
      }
    } catch (err) {
      /* 被打断的旧检索不报错、不写界面：那不是故障，是用户自己按了新的搜索 */
      if (isStale() || (err && (err.superseded || err.name === 'AbortError'))) return;
      console.error(err);
      C.finish({ status: '出错', ok: false, line: '检索流程异常：' + ((err && err.message) || err) });
      HS.toast('检索出错：' + ((err && err.message) || err), 'err', 4200);
      if (typeof opts.fail === 'function') opts.fail(err);
    } finally {
      /* ★只有最新一代才允许复位全局忙碌态★
         旧检索的 finally 若照旧执行，会把新检索的「检索中」按钮和 HS.busy 一起清掉
         —— 界面显示可以再点，实际还在跑，正是竞态的味道。 */
      if (!isStale()) {
        searching = false;
        HS.busy = false;
        setBusy(false);
        /* 本次检索的网络作用域到此为止：留着只会让下一轮请求挂在一个不会再用到的 controller 上 */
        try { HS.net.closeScope(); } catch (e) {}
      }
    }
  }

  /* ---------------- 焦点来源：键盘 / 指针 ---------------- */
  /* 「点击输入不要高光、键盘进入要有描边」这件事纯 CSS 做不到：
     Chromium 里文本输入框在鼠标点击时同样匹配 :focus-visible（本机实测 true）。
     这里只维护一个开关类：按下 Tab → html.hs-kb（CSS 里才画 accent 焦点环），
     指针按下 → 摘掉。除了这个类，没有任何 JS 参与焦点样式。 */
  function bindFocusModality() {
    window.addEventListener('keydown', e => {
      if (e.key === 'Tab') document.documentElement.classList.add('hs-kb');
    }, true);
    window.addEventListener('pointerdown', () => {
      document.documentElement.classList.remove('hs-kb');
    }, true);
  }

  /* ---------------- 顶栏自动隐藏（Win11 任务栏式） ---------------- */
  /* 默认向上滑出视野；指针进到视口顶边 6px 内滑回来；离开延时 620ms 再收起。
     · 只切 html 上的 class，位移由 CSS 的 transform 做，键盘焦点由 :focus-within 兜底。
     · 只在「有 hover 能力的精确指针」上启用：触摸设备没有 mousemove，
       启用就等于把设置按钮藏起来摸不到 —— 不挂 class 时顶栏常驻可见。 */
  const TOP_PEEK_PX = 6;      /* 顶边感应区高度 */
  const TOP_HIDE_MS = 620;    /* 指针离开后的收起延时 */
  function initTopAutoHide() {
    const top = u.$('.hs-top');
    if (!top) return;
    if (!window.matchMedia || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    document.documentElement.classList.add('hs-top-auto');

    let timer = null;
    function reveal() {
      if (timer) { clearTimeout(timer); timer = null; }
      document.documentElement.classList.add('hs-top-peek');
    }
    function conceal() {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        /* 指针还停在顶栏上、或键盘焦点还在里面，就先不收 */
        if (top.matches(':hover') || top.matches(':focus-within')) return;
        document.documentElement.classList.remove('hs-top-peek');
      }, TOP_HIDE_MS);
    }

    /* ★鼠标点过顶栏按钮之后要能自动收起★（用户报：点了「目标可达」就再也不收，
       非得点别处才行）。原因是两件事叠在一起：
         · CSS 有一条 `html.hs-top-auto .hs-top:focus-within { transform: none; }`
           —— 为了键盘可用性（Tab 进来时顶栏必须可见，否则焦点跑到看不见的地方）；
         · 点 <button> 的副作用就是**给它焦点**，而且浏览器对鼠标点击的按钮会一直保留焦点，
           于是 :focus-within 永远成立、conceal() 里那道「焦点还在里面」也永远为真。
       解法：**鼠标这一下点完就主动 blur 掉**，焦点不再留在顶栏里 —— 之后鼠标离开、
       或指针滑回顶栏外，就会按正常节奏收起。键盘可见性不受影响：只有 pointerdown
       之后的 focus 才移除（Tab / 快捷键走的是 focusin，没有 pointerdown，不匹配）。 */
    top.addEventListener('pointerdown', () => {
      window.setTimeout(() => {
        const ae = document.activeElement;
        if (ae && ae !== document.body && top.contains(ae) && ae.blur) ae.blur();
      }, 0);
    });

    window.addEventListener('mousemove', e => {
      if (e.clientY <= TOP_PEEK_PX) reveal(); else conceal();
    }, { passive: true });
    document.addEventListener('mouseleave', conceal);   /* 指针离开窗口也算离开 */
    top.addEventListener('mouseenter', reveal);
    top.addEventListener('mouseleave', conceal);
    /* 键盘：显示交给 CSS :focus-within；焦点离开顶栏后再收起 */
    top.addEventListener('focusin', reveal);
    top.addEventListener('focusout', conceal);
  }

  /* ---------------- 快捷键 ---------------- */
  function isEditable(t) {
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable === true;
  }

  /** 键盘发起的聚焦：挂上 hs-kb，让搜索框画出键盘焦点环（与 Tab 同一条路径） */
  function kbFocus(el) {
    document.documentElement.classList.add('hs-kb');
    el.focus();
  }

  function bindHotkeys() {
    window.addEventListener('keydown', e => {
      /* Ctrl/Cmd + K 或 / 聚焦搜索框 */
      if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault(); kbFocus(u.$('#q')); u.$('#q').select(); return;
      }
      if (e.key === '/' && !isEditable(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault(); kbFocus(u.$('#q')); u.$('#q').select(); return;
      }
      /* Esc 收起筛选抽屉 / 折叠思维链 */
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey) {
        const sheet = u.$('#filter-panel');
        if (sheet && sheet.dataset.open === '1') { HS.filtersUI.openSheet(false); }
        else if (HS.chain.isOpen()) HS.chain.expand(false);
      }
    });
  }

  /* ---------------- 绑定 ---------------- */
  function bind() {
    const input = u.$('#q');
    const clear = u.$('#clear-q');

    /* 检索的唯一入口：只有「按下搜索键」才走到这里 —— 回车 / 点搜索按钮 /
       快捷词 chip；筛选控件（语言/类型/标签/信息源…）照旧走各自的防抖。
       搜索框的 input / composition / 清空一律**不**检索：不请求、不清结果区、
       不铺骨架屏、不动「正在检索」状态，所以这里没有任何 input/keyup 级别的检索调用。 */
    function submitSearch() { doSearch(); }

    u.$('#search-form').addEventListener('submit', e => { e.preventDefault(); submitSearch(); });

    /* 输入法拼字期间（中文/日文选词）的回车是「确认候选」，不是搜索键 */
    let composing = false;
    let composedAt = 0;
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; composedAt = Date.now(); });

    /* 输入只做 UI 记账：切换清空按钮的显隐，不碰检索 */
    input.addEventListener('input', () => { clear.hidden = !input.value; });
    /* 第 7 轮 ④：黑话提示泡泡的「打字判定」也在此处无条件挂一次（纯旁路：不检索、不改 #q，
       只在命中词典时把泡泡画出来；上面那条「input 一律不检索」的契约不受影响） */
    slangWatchInput();
    clear.addEventListener('click', () => { input.value = ''; clear.hidden = true; input.focus(); });
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      if (composing || e.isComposing || e.keyCode === 229) return;   /* 选词中的回车 */
      if (Date.now() - composedAt < 120) return;                    /* 刚确认完候选的那次回车 */
      e.preventDefault();
      submitSearch();
    });
    /* 极简提示：只挂原生 tooltip / 无障碍描述，不新增 UI 组件 */
    input.title = '输入关键词后按回车（或点「搜索」）才检索';
    if (!input.getAttribute('aria-description')) {
      input.setAttribute('aria-description', '输入不触发检索；按回车或点击搜索按钮才检索');
    }

    u.$('#theme-toggle').addEventListener('click', toggleTheme);
    /* 手动重检：这是唯一「用户主动要求」的探测入口，其余全部由网络变化事件驱动 */
    const netChip = u.$('#net-chip');
    if (netChip) netChip.addEventListener('click', () => probeNow(true, true));

    const netRecheck = u.$('#net-recheck');
    if (netRecheck) netRecheck.addEventListener('click', async () => {
      const p = await probeNow(true, false);
      if (p.verdict === 'ok') { HS.toast('已连通，继续检索', 'ok'); HS.bus.emit('app:search'); }
      else HS.toast('仍然不可达：' + p.label + '。可先用本地网关代取，或改用公共 CORS 代理', 'warn', 4600);
    });
    const netProxyOn = u.$('#net-proxy-enable');
    if (netProxyOn) netProxyOn.addEventListener('click', () => {
      const preset = 'https://api.allorigins.win/raw?url={url}';
      HS.settings.proxy = preset;
      HS.store.save(HS.settings);
      HS.net._cache = null;
      HS.filtersUI.syncAll();
      HS.toast('已启用 AllOrigins 代理，重新检索中…', 'ok', 3200);
      const b = u.$('#net-banner'); if (b) b.hidden = true;
      HS.bus.emit('app:search');
    });
    /* 自动竞速挑选一个可用的公共代理 */
    const netAutoProxy = u.$('#net-auto-proxy');
    if (netAutoProxy) netAutoProxy.addEventListener('click', async e => {
      const btn = e.currentTarget;
      btn.disabled = true; btn.textContent = '正在挑选…';
      try {
        const picked = await HS.net.autoPickProxy();
        HS.net._cache = null;
        if (picked) {
          HS.settings.proxy = 'auto';
          HS.store.save(HS.settings);
          HS.filtersUI.syncAll();
          HS.toast('已选用 ' + picked.name + '（' + u.fmtMs(picked.ms) + '），重新检索中…', 'ok', 3600);
          const b = u.$('#net-banner'); if (b) b.hidden = true;
          HS.bus.emit('app:search');
        } else {
          HS.toast('没有可用的公共代理。可以启动随附的本地网关（node tools/gateway.js），它自带 DoH 与境内中继', 'err', 5600);
        }
      } finally { btn.disabled = false; btn.textContent = '自动挑选可用代理'; }
    });
    const hideNet = () => { const b = u.$('#net-banner'); if (b) b.hidden = true; };
    const netGo = u.$('#net-continue'); if (netGo) netGo.addEventListener('click', hideNet);
    const netSkip = u.$('#net-dismiss'); if (netSkip) netSkip.addEventListener('click', hideNet);

    /* 成年门 */
    const gate = u.$('#gate');
    if (!HS.settings.adultOk) gate.hidden = false;
    u.$('#gate-ok').addEventListener('click', () => {
      HS.settings.adultOk = true;
      HS.store.save(HS.settings);
      gate.hidden = true;
      u.$('#q').focus();
    });

    /* 结果区空态里的动作；黑话泡泡里的 chip 也走这条既有委托 —— 只有用户点击才会改写 #q（C1）。
       黑话 chip 带 data-q-span / data-q-from，走「只替换被点中的那一段」，其余片段保留。 */
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-q]');
      if (!b) return;
      const q = u.$('#q');
      const next = slangApplyChip(q, b);
      if (q) q.value = next;
      submitSearch();
    });

    /* 黑话泡泡：窗口尺寸变化后重新贴回「已输入文字之后」 */
    window.addEventListener('resize', u.debounce(() => {
      if (slangEl && !slangEl.hidden) slangPlace();
    }, 140));
  }

  /* ---------------- 事件订阅 ---------------- */
  function wire() {
    HS.bus.on('app:search', p => doSearch(p));
    HS.bus.on('net:recheck', () => probeNow(true, true));
    /* net:probe 会广播两次：浏览器探针出结果时的**临时结论**（≤3.5s），
       以及 /api/diag 跑完的最终结论。两次都刷状态，用户不必等网关自检跑完。 */
    HS.bus.on('net:probe', p => { paintChip(p); showBanner(p); });
    /* ★r18 需求②④★ 预热结论一到就「兑现」成最终结论：此时网关段算得飞快
       （net._gwDiag 已就绪），横幅要么不弹、要么直接说真话，没有中间态。
       只兑现一次：避免与 boot 的探针互相触发。 */
    let warmFolded = false;
    HS.bus.on('net:warm', () => {
      if (warmFolded) return;
      warmFolded = true;
      const c = HS.net.probeCached();
      if (!c || c.provisional) probeNow(true, false);
    });
    HS.bus.on('theme:set', applyTheme);
    HS.bus.on('blurcovers:set', applyBlurCovers);
    /* 代理设置变了 = 网络出口变了，属于「网络情况变化」，重探一次 */
    HS.bus.on('proxy:change', () => probeNow(true, false));
    HS.bus.on('settings:change', d => {
      if (d && d.key === 'sources' && HS.filtersUI.refreshSources) HS.filtersUI.refreshSources();
      if (d && d.key === 'perSource') HS.store.save(HS.settings);
    });

    /* 筛选变化后自动重搜（防抖，且仅在已经搜过一次之后） */
    let t = null;
    HS.bus.on('filters:change', () => {
      if (!searchedOnce) return;
      clearTimeout(t);
      t = setTimeout(() => { if (!searching) doSearch(); }, 520);
    });
  }

  /* ---------------- 启动 ---------------- */
  function boot() {
    applyTheme(HS.settings.theme || 'dark');
    applyBlurCovers(HS.settings.blurCovers);
    document.documentElement.classList.toggle('hs-nomotion', HS.settings.animLevel === 'off');

    HS.chain.init();
    HS.filtersUI.init();
    HS.results.init();
    HS.panic.init();
    if (HS.fav && HS.fav.init) HS.fav.init();
    /* 最近浏览：必须在 results.js / reader.js 之后初始化 —— 它包装这两个模块的入口记账 */
    if (HS.recent && HS.recent.init) HS.recent.init();
    HS.settingsUI.init();
    /* 右下角回顶按钮（独立模块，拿不到就跳过，不影响别的启动步骤） */
    if (HS.totop && HS.totop.init) HS.totop.init();
    bind();
    bindHotkeys();
    bindFocusModality();
    initTopAutoHide();
    wire();

    renderWelcome();
    HS.sources.loadTags();

    /* ★r18 需求②④★ 先把网关探明并预热，**再**做网络自检。
       顺序反过来的话，网探针会先落一个「浏览器直连失败」的临时结论（本机被墙站失败得极快，
       常常几十毫秒），横幅就抢在网关结论之前弹出来 —— 用户要的是「弹出时网点已经连好」。
       网关不在时 probeGateway 也只是快失败（同源 /api/ping），拖不动后面的检测。 */
    initNetWatch();
    setTimeout(() => probeGateway(false), 120);
    setTimeout(() => probeNow(true, false), 300);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})(window.HS);
