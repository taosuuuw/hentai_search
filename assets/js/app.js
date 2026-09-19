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
        ? '✓ 已连接：' + HS.net.gateway.base + '（禁漫官方 API / 拷贝漫画 / 哔咔 可用）'
        : '未检测到（运行 node tools/gateway.js 后可解锁禁漫官方 API、拷贝漫画、哔咔）';
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
    box.innerHTML =
      '<b>输入关键词即可开始</b>' +
      '<p style="margin:8px 0 4px">会用下面的信息源并行检索：' +
      HS.sources.enabled().map(s => u.esc(s.name)).join(' · ') +
      (HS.sources.enabled().length < HS.sources.REG.length
        ? '（按住搜索框上沿的滑块向上拉出筛选）' : '') + '</p>' +
      '<div class="hs-empty-actions">' +
      ['fate', 'blue archive', '大嘘', 'full color', 'hololive'].map(k =>
        '<button class="hs-btn hs-btn-ghost" data-q="' + u.esc(k) + '">' + u.esc(k) + '</button>').join('') +
      '</div>' +
      '<p style="margin-top:14px;font-size:12px">按住搜索框上沿的滑块向上拉出筛选 · 紧急时刻按 <kbd>' +
      u.esc(HS.panic.label(HS.settings.panicKey)) + '</kbd> 可立刻模糊整个页面（可在设置中修改）</p>';
    u.$$('#results-empty [data-q]').forEach(b => b.addEventListener('click', () => {
      u.$('#q').value = b.dataset.q;
      doSearch();
    }));
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
    return bits.join(' · ') || '无附加条件';
  }

  async function doSearch() {
    if (searching) return;
    const q = (u.$('#q').value || '').trim();
    const f = HS.filtersUI.get();
    const hasFilter = f.artist || (f.tags || []).length || (f.langs || []).length ||
      (f.cats || []).length || f.pagesMin || f.pagesMax || (f.gore && f.gore !== 'any') || (f.ai && f.ai !== 'any');

    if (!q && !hasFilter) {
      HS.toast('请输入关键词，或展开筛选指定画师 / 标签 / 作品类型', 'warn', 3200);
      HS.filtersUI.openSheet(true);
      u.$('#q').focus();
      return;
    }

    searching = true;
    searchedOnce = true;
    setBusy(true);
    u.$('#vpn-banner').hidden = true;
    HS.results.skeletons(Math.min(HS.settings.perSource, 12));

    const C = HS.chain;
    C.begin();
    const srcList = HS.sources.enabled();
    C.prepareSources(srcList);
    HS.results.streamStart(q, f);

    try {
      /* 1. 查询解析 */
      const s1 = C.step('解析查询意图…');
      await s1.typed;
      await u.sleep(90);
      s1.set('ok', '已解析', '解析完成：' + describeFilters(q, f));
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
      s3.set('ok', srcList.length + ' 个源', '启用：' + srcList.map(s => s.name).join(' · ') +
        (HS.net.hasProxy() && HS.net.userProxy() !== 'auto'
          ? '（经代理 ' + HS.net.proxyName(HS.settings.proxy) + '）'
          : (HS.settings.autoProxy !== false ? '（自动代理链：直连 → 公共代理依次尝试）' : '（仅直连）')));
      C.progress(44);

      /* 4. 并行检索 */
      const s4 = C.step('并行发起检索请求…');
      const t4 = u.now();
      let done = 0;
      const results = await HS.sources.run({
        q, filters: f,
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
      const items = HS.results.render(results, { q, f });
      s5.set('ok', rawTotal + ' → ' + items.length,
        '聚合完成：原始 ' + rawTotal + ' 条 → 跨源去重后 ' + items.length + ' 条');
      C.progress(92);

      /* 6. 重排 */
      const s6 = C.step('按相关度重排、归并同系列…');
      await u.sleep(140);
      const seriesN = u.uniq(items.filter(i => i.series).map(i => i.series)).length;
      s6.set('ok', 'Top ' + Math.min(items.length, 5),
        items.length
          ? '重排完成：' + (seriesN ? '识别出 ' + seriesN + ' 个系列（同系列已叠成卡片，悬停展开） · ' : '') + '封面默认模糊'
          : '未得到有效结果，建议放宽语言/类型或开启代理');
      C.progress(100);

      const ms = C.finish({
        status: items.length ? '完成' : '无结果',
        ok: items.length > 0,
        hint: items.length ? items.length + ' 条结果' : '无结果',
        line: items.length
          ? '检索完成：' + items.length + ' 个可能相关的结果'
          : '检索完成：没有找到匹配结果'
      });
      u.$('#results-meta').innerHTML =
        '找到 <em>' + items.length + '</em> 个可能相关的结果 · 用时 ' + u.fmtMs(ms) +
        ' · 成功源 ' + okList.length + '/' + results.length;

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
    } finally {
      searching = false;
      setBusy(false);
    }
  }

  /* ---------------- 快捷键 ---------------- */
  function isEditable(t) {
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable === true;
  }

  function bindHotkeys() {
    window.addEventListener('keydown', e => {
      /* Ctrl/Cmd + K 或 / 聚焦搜索框 */
      if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault(); u.$('#q').focus(); u.$('#q').select(); return;
      }
      if (e.key === '/' && !isEditable(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault(); u.$('#q').focus(); u.$('#q').select(); return;
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

    u.$('#search-form').addEventListener('submit', e => { e.preventDefault(); doSearch(); });
    input.addEventListener('input', () => { clear.hidden = !input.value; });
    clear.addEventListener('click', () => { input.value = ''; clear.hidden = true; input.focus(); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });

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

    /* 结果区空态里的动作 */
    document.addEventListener('click', e => {
      const b = e.target.closest('[data-q]');
      if (b) { u.$('#q').value = b.dataset.q; doSearch(); }
    });
  }

  /* ---------------- 事件订阅 ---------------- */
  function wire() {
    HS.bus.on('app:search', () => doSearch());
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
    HS.settingsUI.init();
    bind();
    bindHotkeys();
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
