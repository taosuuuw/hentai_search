/* ==========================================================================
   app.js — 引导与主流程
   主题 → 成年门 → 模块初始化 → 网络探测 → 搜索主流程（思维链 + 并行检索）
   ========================================================================== */
(function (HS) {
  'use strict';
  const u = HS.u;
  let searching = false;
  let searchedOnce = false;

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
    /* 网关在的时候把「拷贝漫画」也打开，用户能在信息源里看到它 */
    const on = HS.settings.sources || [];
    if (on.indexOf('copymanga') < 0) {
      HS.settings.sources = on.concat(['copymanga']);
      HS.store.save(HS.settings);
      if (HS.filtersUI.refreshSources) HS.filtersUI.refreshSources();
      if (announce !== false) HS.toast('检测到本地网关：已启用 拷贝漫画，禁漫天堂自动走官方 API');
    }
  }

  /* ---------------- 网络状态 ---------------- */
  function paintChip(probe) {
    const chip = u.$('#vpn-chip');
    const txt = u.$('#vpn-chip-text');
    if (!probe) { chip.dataset.state = 'busy'; txt.textContent = '网络检测中…'; return; }
    const map = {
      ok: ['ok', '目标可达'],
      partial: ['warn', '部分站点受限'],
      'vpn-needed': ['warn', '建议开 VPN'],
      offline: ['err', '离线'],
      unknown: ['warn', '网络异常']
    };
    const m = map[probe.verdict] || ['warn', probe.label];
    chip.dataset.state = m[0];
    txt.textContent = m[1];
    chip.title = probe.detail + '（点击重新检测）';
  }

  function showBanner(probe) {
    const b = u.$('#vpn-banner');
    if (!probe || probe.verdict === 'ok') { b.hidden = true; return; }
    b.hidden = false;
    b.dataset.kind = (probe.verdict === 'offline' || probe.verdict === 'unknown') ? 'err' : 'warn';
    u.$('#vpn-banner-title').textContent =
      probe.verdict === 'offline' ? '当前设备离线'
        : probe.verdict === 'partial' ? '部分目标站点不可达 —— 可能需要在浏览器之外开启 VPN'
        : '检测到目标站点不可达 —— 可能需要在浏览器之外开启 VPN';
    u.$('#vpn-banner-desc').textContent = probe.detail;
    const list = u.$('#vpn-banner-list');
    list.innerHTML = (probe.blocked || []).slice(0, 5)
      .map(t => '<li>' + u.esc(t.label) + ' 连接失败（' + u.fmtMs(t.ms) + '）</li>').join('');
    u.$('#vpn-proxy-enable').hidden = HS.net.hasProxy();
  }

  async function probeNow(force, announce) {
    paintChip(null);
    const probe = await HS.net.probe(force);
    paintChip(probe);
    showBanner(probe);
    if (announce) {
      HS.toast(probe.verdict === 'ok'
        ? '网络可达，无需 VPN'
        : '检测结果：' + probe.label, probe.verdict === 'ok' ? 'ok' : 'warn', 3200);
    }
    return probe;
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
    /* 手动改词后旧提示即失效，收起，避免泡泡停在旧位置误导 */
    q.addEventListener('input', () => slangDismiss());
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
      el.style.left = Math.round(Math.max(6, Math.min(inline ? want : want, maxLeft))) + 'px';
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
    if (searching) return;
    opts = opts || {};
    const page = Math.max(1, parseInt(opts.page || 1, 10) || 1);
    const append = page > 1;
    const q = (u.$('#q').value || '').trim();
    const f = HS.filtersUI.get();
    const hasFilter = f.artist || (f.tags || []).length || (f.langs || []).length ||
      (f.cats || []).length || f.pagesMin || f.pagesMax || (f.gore && f.gore !== 'any') || (f.ai && f.ai !== 'any') ||
      f.adult === 'strict';

    if (!q && !hasFilter) {
      HS.toast('请输入关键词，或展开筛选指定画师 / 标签 / 作品类型', 'warn', 3200);
      HS.filtersUI.openSheet(true);
      u.$('#q').focus();
      return;
    }

    /* 黑话判定第一遍：同步（核心层永远就绪）。纯旁路，不改 q、不改 intent（C1） */
    const slang = slangLookup(q);

    searching = true;
    HS.busy = true;
    searchedOnce = true;
    slangCtx = { token: slangCtx.token + 1, q: q, empty: null, hits: slang.hits, dismissed: false };
    const mySlangToken = slangCtx.token;            /* 本次检索的提示身份，异步回调靠它认亲 */
    slangClose();                                   /* 上一轮的提示先收起 */
    slangRefresh(false);                            /* 主动提示档立刻出泡泡（3.8-1） */
    slangLoadPending(slang.pending, slangCtx.token);
    setBusy(true);
    u.$('#vpn-banner').hidden = true;
    if (!append) HS.results.skeletons(Math.min(HS.settings.perSource, 12));

    const C = HS.chain;
    C.begin();
    const srcList = HS.sources.enabled();
    C.prepareSources(srcList);
    HS.results.streamStart(q, f, page);

    try {
      /* 1. 查询解析：按意图分流（作品名 / IP 角色 / 体裁题材 → 不同检索策略） */
      const intent = u.classifyQuery(q);
      const intentExtra = intent.series ? '（' + intent.series + '）'
        : (intent.genre ? '（' + intent.genre.label + '）' : '');
      const s1 = C.step(append ? '准备追加下一批结果…' : '解析查询意图…');
      await s1.typed;
      await u.sleep(90);
      s1.set('ok', intent.label,
        '意图判定：' + intent.label + intentExtra + ' · ' + describeFilters(q, f));
      C.progress(16);

      /* 2. 网络探测（智能判断是否需要 VPN） */
      const s2 = C.step('探测网络环境与可用出口…');
      const probe = await HS.net.probe();
      paintChip(probe);
      if (probe.verdict !== 'ok') showBanner(probe);
      s2.set(probe.verdict === 'ok' ? 'ok' : 'warn',
        probe.verdict === 'ok' ? '直连可用' : probe.label,
        probe.verdict === 'ok'
          ? '网络可达（' + probe.targets.filter(t => t.ok).length + '/' + probe.targets.length + ' 个探测点连通），无需 VPN'
          : '网络受限：' + probe.detail);
      C.progress(32);

      /* 3. 信息源选择 */
      const s3 = C.step('选择信息源（并行调度）…');
      await s3.typed;
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
      const results = await HS.sources.run({
        q, filters: f, page, intent,
        capMs: HS.sources.RUN_CAP_MS,
        onStart: src => C.setSource(src.id, 'run'),
        onDone: (src, r) => {
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
      const items = HS.results.render(results, { q, f, page });
      s5.set('ok', rawTotal + ' → ' + items.length,
        '聚合完成：原始 ' + rawTotal + ' 条 → 跨源去重后 ' + items.length + ' 条');
      C.progress(92);

      /* 6. 重排 */
      const s6 = C.step('按相关度重排、归并同系列…');
      await u.sleep(140);
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
      console.error(err);
      C.finish({ status: '出错', ok: false, line: '检索流程异常：' + ((err && err.message) || err) });
      HS.toast('检索出错：' + ((err && err.message) || err), 'err', 4200);
      if (typeof opts.fail === 'function') opts.fail(err);
    } finally {
      searching = false;
      HS.busy = false;
      setBusy(false);
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
    u.$('#vpn-chip').addEventListener('click', () => probeNow(true, true));

    u.$('#vpn-recheck').addEventListener('click', async () => {
      const p = await probeNow(true, false);
      if (p.verdict === 'ok') { HS.toast('已连通，继续检索', 'ok'); HS.bus.emit('app:search'); }
      else HS.toast('仍然不可达：' + p.label + '。请确认 VPN 已开启后再试', 'warn', 4200);
    });
    u.$('#vpn-proxy-enable').addEventListener('click', () => {
      const preset = 'https://api.allorigins.win/raw?url={url}';
      HS.settings.proxy = preset;
      HS.store.save(HS.settings);
      HS.net._cache = null;
      HS.filtersUI.syncAll();
      HS.toast('已启用 AllOrigins 代理，重新检索中…', 'ok', 3200);
      u.$('#vpn-banner').hidden = true;
      HS.bus.emit('app:search');
    });
    /* 自动竞速挑选一个可用的公共代理 */
    u.$('#vpn-auto-proxy').addEventListener('click', async e => {
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
          u.$('#vpn-banner').hidden = true;
          HS.bus.emit('app:search');
        } else {
          HS.toast('没有可用的公共代理。请在浏览器之外开启 VPN，或自建一个代理', 'err', 5200);
        }
      } finally { btn.disabled = false; btn.textContent = '自动挑选可用代理'; }
    });
    u.$('#vpn-continue').addEventListener('click', () => { u.$('#vpn-banner').hidden = true; });
    u.$('#vpn-dismiss').addEventListener('click', () => { u.$('#vpn-banner').hidden = true; });

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
    HS.bus.on('theme:set', applyTheme);
    HS.bus.on('blurcovers:set', applyBlurCovers);
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
    HS.settingsUI.init();
    bind();
    bindHotkeys();
    bindFocusModality();
    initTopAutoHide();
    wire();

    renderWelcome();
    HS.sources.loadTags();

    /* 首次网络探测：不阻塞界面，探测完更新状态与提醒 */
    setTimeout(() => probeNow(true, false), 260);
    /* 本地网关探测（有就跑，没有也不影响） */
    setTimeout(() => probeGateway(false), 680);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})(window.HS);
