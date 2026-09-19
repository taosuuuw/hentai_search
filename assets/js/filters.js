/* ==========================================================================
   filters.js — 上拉抽屉：作品类型 / 语言 / R18G / AI / 画师 / 标签 / 信息源 / 代理
   ========================================================================== */
(function (HS) {
  'use strict';
  const u = HS.u;
  const F = HS.filtersUI = {};
  let sheet, grab, sheetBody, sheetInner;

  /* ---------------- Chip 多选组 ---------------- */
  function renderChips(host, items, getVal, setVal) {
    host.innerHTML = '';
    items.forEach(it => {
      const on = getVal().indexOf(it.code) >= 0;
      const btn = u.el('button', {
        class: 'hs-tag', type: 'button', 'data-code': it.code, 'aria-pressed': on ? 'true' : 'false'
      }, u.esc(it.label));
      btn.addEventListener('click', () => {
        const cur = getVal().slice();
        const i = cur.indexOf(it.code);
        if (i >= 0) cur.splice(i, 1); else cur.push(it.code);
        setVal(cur);
        btn.setAttribute('aria-pressed', cur.indexOf(it.code) >= 0 ? 'true' : 'false');
        F.touch();
      });
      host.appendChild(btn);
    });
  }

  /* ---------------- 三段式开关（R18G / AI） ---------------- */
  const SEG = [
    { v: 'any', label: '不限' },
    { v: 'only', label: '只看' },
    { v: 'exclude', label: '排除' }
  ];

  function renderSeg(host, key) {
    host.innerHTML = '';
    SEG.forEach(o => {
      const on = (HS.filters[key] || 'any') === o.v;
      const b = u.el('button', {
        type: 'button', 'data-v': o.v, 'aria-pressed': on ? 'true' : 'false'
      }, o.label);
      b.addEventListener('click', () => {
        HS.filters[key] = o.v;
        u.$$('button', host).forEach(x => x.setAttribute('aria-pressed', x.dataset.v === o.v ? 'true' : 'false'));
        F.touch();
      });
      host.appendChild(b);
    });
  }

  /* ---------------- Chip 输入（标签） ---------------- */
  function ChipInput(host, key, placeholder) {
    const state = { key, host };
    host.innerHTML = '';
    const input = u.el('input', { type: 'text', placeholder: placeholder || '', list: 'hs-tag-list' });
    host.appendChild(input);

    host.addEventListener('click', e => { if (e.target === host) input.focus(); });

    function paint() {
      u.$$('.hs-ci-tag', host).forEach(n => n.remove());
      (HS.filters[key] || []).forEach(v => {
        const tag = u.el('span', { class: 'hs-ci-tag', 'data-neg': key === 'excludeTags' ? '1' : '0' });
        tag.appendChild(document.createTextNode(v));
        const x = u.el('button', { type: 'button', title: '移除', 'aria-label': '移除 ' + v }, '×');
        x.addEventListener('click', ev => {
          ev.stopPropagation();
          HS.filters[key] = (HS.filters[key] || []).filter(t => t !== v);
          paint(); F.touch();
        });
        tag.appendChild(x);
        host.insertBefore(tag, input);
      });
      F.updateBadge();
    }

    function commit(v) {
      v = String(v || '').trim().replace(/^#/, '');
      if (!v) return;
      const arr = HS.filters[key] = HS.filters[key] || [];
      if (arr.indexOf(v) < 0) arr.push(v);
      input.value = '';
      paint(); F.touch();
    }

    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
        e.preventDefault();
        if (input.value.trim()) commit(input.value);
        else HS.bus.emit('filters:submit');
      } else if (e.key === 'Backspace' && !input.value) {
        const arr = HS.filters[key] || [];
        if (arr.length) { arr.pop(); paint(); F.touch(); }
      }
    });
    input.addEventListener('input', () => {
      const v = input.value.trim().toLowerCase();
      if (!v) return;
      const exact = (HS.sources.tags || []).find(t => t.toLowerCase() === v);
      if (exact) commit(exact);
    });
    input.addEventListener('blur', () => { if (input.value.trim()) commit(input.value); });

    state.paint = paint;
    paint();
    return state;
  }

  /* ---------------- 信息源选择 ---------------- */
  function renderSources() {
    const host = u.$('#f-sources');
    host.innerHTML = '';
    HS.sources.REG.forEach(src => {
      const on = (HS.settings.sources || []).indexOf(src.id) >= 0;
      const lab = u.el('label', { class: 'hs-srccard', 'data-on': on ? '1' : '0' });
      const cb = u.el('input', { type: 'checkbox' });
      cb.checked = on;
      cb.addEventListener('change', () => {
        const cur = (HS.settings.sources || []).slice();
        const i = cur.indexOf(src.id);
        if (cb.checked && i < 0) cur.push(src.id);
        if (!cb.checked && i >= 0) cur.splice(i, 1);
        if (!cur.length) { cb.checked = true; HS.toast('至少保留一个信息源', 'warn'); return; }
        HS.settings.sources = cur;
        HS.store.save(HS.settings);
        lab.dataset.on = cb.checked ? '1' : '0';
        F.touch();
        HS.bus.emit('settings:change', { key: 'sources', val: cur });
      });
      const flags = src.flags.map(f => {
        const t = /VPN/i.test(f) ? 'vpn'
          : (/代理|网关/.test(f) ? 'proxy'
            : (/离线|直连|中文|多镜像|画师向/.test(f) ? 'ok' : ''));
        return '<span class="hs-flag" data-t="' + t + '">' + u.esc(f) + '</span>';
      }).join('');
      lab.appendChild(cb);
      lab.appendChild(u.el('span', {}, '<b>' + u.esc(src.name) + '</b><i>' + u.esc(src.desc) +
        '</i><span class="hs-srcflags">' + flags + '</span>'));
      host.appendChild(lab);
    });
  }

  /* ---------------- 拉出式面板：从搜索框【顶部】向上展开 ---------------- */
  let slider, sliderThumb, searchBar, sheetWrap, sheetShell;

  const SHEET_GAP = 8;          // 面板底边与搜索框上沿的间距

  /** 底边永远贴着搜索框上沿（与 padding 让位量无关） */
  function layoutSheet() {
    if (!searchBar || !sheet) return;
    sheet.style.bottom = (searchBar.offsetHeight + SHEET_GAP) + 'px';
  }

  /** 搜索框为了给面板让位而向下滑动的最大距离 */
  function shiftMax() {
    if (window.innerHeight < 560) return 0;
    return u.clamp(Math.round(window.innerHeight * 0.17), 0, 170);
  }

  /**
   * 面板能长多高：顶边不能越过视口顶部。
   *   面板总高 = 内容高度 + 拉手条高度(shell)
   *   可用高度 = 搜索框在视口中的位置 + 向下让位量 - 间距 - 拉手条 - 顶部留白
   */
  function maxPanelH(r) {
    if (!sheetInner || !searchBar) return 320;
    const content = sheetInner.offsetHeight || 460;
    const pad = (sheetWrap && parseFloat(sheetWrap.style.paddingTop)) || 0;
    const baseTop = searchBar.getBoundingClientRect().top - pad;    // 扣掉当前让位位移
    const shellH = (sheetShell && sheetShell.offsetHeight) || 34;
    const room = baseTop + (r * shiftMax()) - SHEET_GAP - shellH - 10;
    return Math.max(132, Math.min(content, Math.max(132, room), window.innerHeight * 0.78));
  }

  /** ratio: 0=收起（贴住搜索框上沿） 1=完全拉出（顶到视口上沿） */
  function setRatio(r, animate) {
    r = u.clamp(r, 0, 1);
    const maxH = maxPanelH(r);
    sheet.dataset.ratio = r.toFixed(2);
    sheet.dataset.open = r >= 0.5 ? '1' : '0';
    grab.setAttribute('aria-expanded', r > 0.02 ? 'true' : 'false');

    if (animate === false) sheet.dataset.dragging = '1';
    /* 搜索框往下让位，面板才有向上展开的空间 */
    if (sheetWrap) {
      const pad = Math.round(r * shiftMax());
      sheetWrap.style.paddingTop = pad + 'px';
    }
    sheetBody.style.maxHeight = Math.round(r * maxH) + 'px';
    sheetBody.style.visibility = r > 0.01 ? 'visible' : '';

    if (sliderThumb) sliderThumb.style.setProperty('--thumb-y', (9 - 20 * r).toFixed(1) + 'px');
    if (slider) slider.setAttribute('aria-valuenow', Math.round(r * 100));

    const lb = grab.querySelector('.hs-sheet-label');
    if (lb) lb.textContent = r > 0.5 ? '下拉收起筛选' : (r > 0.02 ? '继续上拉展开' : '向上拉出筛选');
  }

  function sheetOpen(on) { setRatio(on ? 1 : 0); }
  F.openSheet = sheetOpen;

  /** 把搜索框挪到视口里能看到整块面板的位置，再开始拉 */
  function ensureRoom() {
    if (!searchBar) return;
    const barPageTop = searchBar.getBoundingClientRect().top + window.scrollY;
    const want = Math.min(window.innerHeight * 0.34, barPageTop);
    const target = Math.max(0, Math.round(barPageTop - want));
    if (Math.abs(target - window.scrollY) > 4) window.scrollTo(0, target);
  }

  function initSheet() {
    let dragging = false, startY = 0, startRatio = 0, moved = 0;
    let activeEl = null;

    /* 拖动开始：拉手 / 滑块 都走同一套逻辑 */
    function down(e) {
      if (e.button != null && e.button !== 0) return;
      dragging = true; moved = 0; startY = e.clientY;
      activeEl = e.currentTarget;
      ensureRoom();
      startRatio = parseFloat(sheet.dataset.ratio || '0') || 0;
      const h = sheetBody.getBoundingClientRect().height;
      if (h > 4) startRatio = u.clamp(h / maxPanelH(startRatio), 0, 1);
      sheet.dataset.dragging = '1';
      if (sheetWrap) sheetWrap.dataset.dragging = '1';
      if (slider) { slider.dataset.dragging = '1'; slider.dataset.active = '1'; }
      try { activeEl.setPointerCapture(e.pointerId); } catch (err) {}
      e.preventDefault();
    }

    function move(e) {
      if (!dragging) return;
      const dy = startY - e.clientY;                    // 向上拉动为正
      moved = Math.max(moved, Math.abs(dy));
      setRatio(startRatio + dy / maxPanelH(startRatio), false);
    }

    function up() {
      if (!dragging) return;
      dragging = false;
      sheet.dataset.dragging = '0';
      if (sheetWrap) sheetWrap.dataset.dragging = '0';
      if (slider) { slider.dataset.dragging = '0'; slider.dataset.active = '0'; }
      const r = parseFloat(sheet.dataset.ratio || '0') || 0;
      /* 两端吸附，中间保留用户拉到的位置 */
      const snap = (moved < 6) ? (r > 0.5 ? 0 : 1) : (r < 0.14 ? 0 : (r > 0.88 ? 1 : r));
      setRatio(snap, true);
      setTimeout(() => { moved = 0; }, 0);
    }

    [grab, slider].forEach(el => {
      if (!el) return;
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('lostpointercapture', up);
    });

    /* 键盘可达：方向键调节、回车/空格切换 */
    if (slider) {
      slider.addEventListener('keydown', e => {
        const r = parseFloat(sheet.dataset.ratio || '0') || 0;
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); ensureRoom(); setRatio(r + 0.2); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); setRatio(r - 0.2); }
        else if (e.key === 'Enter' || e.key === ' ' || e.key === 'Home' || e.key === 'End') {
          e.preventDefault(); ensureRoom();
          setRatio(e.key === 'End' ? 1 : (e.key === 'Home' ? 0 : (r > 0.5 ? 0 : 1)));
        }
      });
    }

    /* 面板内部点击不参与外部收起逻辑 */
    sheet.addEventListener('click', e => e.stopPropagation());
    /* 点面板和搜索框以外的地方就收起 */
    document.addEventListener('pointerdown', e => {
      const r = parseFloat(sheet.dataset.ratio || '0') || 0;
      if (r <= 0.02) return;
      if (sheet.contains(e.target) || searchBar.contains(e.target)) return;
      setRatio(0, true);
    });
    window.addEventListener('resize', u.debounce(() => {
      layoutSheet();
      const r = parseFloat(sheet.dataset.ratio || '0') || 0;
      if (r > 0) setRatio(r, false);
    }, 160));
  }

  /* ---------------- 自定义源列表 ---------------- */
  function renderCustom() {
    const host = u.$('#f-custom-list');
    if (!host) return;
    const list = HS.settings.customSources || [];
    host.innerHTML = '';
    if (!list.length) {
      host.appendChild(u.el('p', { class: 'hs-hint', style: 'margin:0 0 6px' },
        '还没有自定义源。当某个中文站的域名失效时，把能打开的镜像加进来即可。'));
      return;
    }
    list.forEach((c, i) => {
      const row = u.el('div', { class: 'hs-csrow' });
      const tpl = HS.sources.CUSTOM_TPL[c.template] || {};
      row.appendChild(u.el('span', {}, '<b>' + u.esc(c.name || c.domain) + '</b><i>' +
        u.esc(c.domain) + ' · ' + u.esc(tpl.label || c.template) + '</i>'));
      const del = u.el('button', { class: 'hs-btn hs-btn-ico', type: 'button', title: '删除该源' }, HS.icon.close);
      del.addEventListener('click', () => {
        HS.settings.customSources.splice(i, 1);
        HS.store.save(HS.settings);
        renderCustom();
        F.touch();
      });
      row.appendChild(del);
      host.appendChild(row);
    });
  }
  F.renderCustom = renderCustom;

  /* ---------------- 同步 / 初始化 ---------------- */
  F.refreshSources = renderSources;

  function syncAll() {
    u.$$('#f-langs .hs-tag').forEach(b => {
      b.setAttribute('aria-pressed', (HS.filters.langs || []).indexOf(b.dataset.code) >= 0 ? 'true' : 'false');
    });
    u.$$('#f-cats .hs-tag').forEach(b => {
      b.setAttribute('aria-pressed', (HS.filters.cats || []).indexOf(b.dataset.code) >= 0 ? 'true' : 'false');
    });
    u.$$('#f-gore button').forEach(b => {
      b.setAttribute('aria-pressed', (HS.filters.gore || 'any') === b.dataset.v ? 'true' : 'false');
    });
    u.$$('#f-ai button').forEach(b => {
      b.setAttribute('aria-pressed', (HS.filters.ai || 'any') === b.dataset.v ? 'true' : 'false');
    });
    const artist = u.$('#f-artist'); if (artist && artist.value !== (HS.filters.artist || '')) artist.value = HS.filters.artist || '';
    const order = u.$('#f-order'); if (order) order.value = HS.filters.order || 'relevance';
    const pmin = u.$('#f-pages-min'); if (pmin) pmin.value = HS.filters.pagesMin || '';
    const pmax = u.$('#f-pages-max'); if (pmax) pmax.value = HS.filters.pagesMax || '';
    const per = u.$('#f-persource'); if (per) per.value = HS.settings.perSource;
    const proxy = u.$('#f-proxy'); if (proxy) proxy.value = HS.settings.proxy || '';
    const preset = u.$('#f-proxy-preset');
    if (preset) {
      const p = HS.settings.proxy || '';
      preset.value = (!p || p === 'auto' || HS.net.PROXY_MAP[p]) ? p : '__custom__';
    }
    const jm = u.$('#f-jm-mirrors'); if (jm && document.activeElement !== jm) jm.value = HS.settings.jmMirrors || '';
    const wn = u.$('#f-wn-mirrors'); if (wn && document.activeElement !== wn) wn.value = HS.settings.wnacgMirrors || '';
    if (F.tagInputs) F.tagInputs.forEach(t => t.paint());
    if (F.renderCustom) F.renderCustom();
    F.updateBadge();
  }
  F.syncAll = syncAll;

  F.updateBadge = function () {
    const f = HS.filters;
    let n = 0;
    if (f.artist) n++;
    n += (f.tags || []).length + (f.excludeTags || []).length;
    n += (f.langs || []).length + (f.cats || []).length;
    if (f.gore && f.gore !== 'any') n++;
    if (f.ai && f.ai !== 'any') n++;
    if (f.order && f.order !== 'relevance') n++;
    if (f.pagesMin) n++;
    if (f.pagesMax) n++;
    const b = u.$('#filter-count');
    if (b) { b.textContent = n; b.hidden = n === 0; }
    return n;
  };

  F.touch = function () {
    HS.store.saveFilters(HS.filters);
    F.updateBadge();
    HS.bus.emit('filters:change', F.get());
  };

  F.get = function () {
    return Object.assign({}, HS.filters, {
      pagesMin: HS.filters.pagesMin === '' ? null : parseInt(HS.filters.pagesMin, 10),
      pagesMax: HS.filters.pagesMax === '' ? null : parseInt(HS.filters.pagesMax, 10)
    });
  };

  F.reset = function () {
    Object.assign(HS.filters, JSON.parse(JSON.stringify(HS.DEFAULT_FILTERS)));
    HS.store.saveFilters(HS.filters);
    syncAll();
    HS.bus.emit('filters:change', F.get());
    HS.toast('筛选条件已重置');
  };

  F.addTag = function (t) {
    if (!t) return;
    HS.filters.tags = HS.filters.tags || [];
    if (HS.filters.tags.indexOf(t) < 0) HS.filters.tags.push(t);
    syncAll(); F.touch();
  };

  F.setArtist = function (a) {
    HS.filters.artist = a || '';
    syncAll(); F.touch();
    sheetOpen(true);
  };

  F.init = function () {
    sheet = u.$('#filter-panel');
    grab = u.$('#sheet-grab');
    sheetBody = u.$('#sheet-body');
    sheetInner = u.$('.hs-sheet-inner', sheet);
    slider = u.$('#sheet-slider');
    sliderThumb = u.$('.hs-slider-thumb', sheet);
    searchBar = u.$('#search-form');
    sheetWrap = u.$('#search-wrap');
    sheetShell = u.$('.hs-sheet-shell', sheet);
    const chev = u.$('.hs-chev', grab);
    if (chev && !chev.innerHTML) chev.innerHTML = HS.icon.chev;
    F.tagInputs = [];
    initSheet();
    layoutSheet();
    setRatio(0, true);

    renderChips(u.$('#f-cats'), HS.CATS, () => HS.filters.cats || [], v => { HS.filters.cats = v; });
    renderChips(u.$('#f-langs'), HS.LANGS, () => HS.filters.langs || [], v => { HS.filters.langs = v; });
    renderSeg(u.$('#f-gore'), 'gore');
    renderSeg(u.$('#f-ai'), 'ai');
    renderSources();

    F.tagInputs.push(ChipInput(u.$('#f-tags'), 'tags', '输入标签后回车，如 full color'));
    F.tagInputs.push(ChipInput(u.$('#f-exclude'), 'excludeTags', '要排除的标签，如 netorare'));

    /* 标签自动补全数据源 */
    const dl = u.el('datalist', { id: 'hs-tag-list' });
    document.body.appendChild(dl);
    const fillTags = tags => {
      dl.innerHTML = (tags || []).slice(0, 400).map(t => '<option value="' + u.esc(t) + '"></option>').join('');
    };
    fillTags(HS.sources.tags);
    HS.bus.on('tags:ready', fillTags);

    /* 输入绑定 */
    u.$('#f-artist').addEventListener('change', e => { HS.filters.artist = e.target.value.trim(); F.touch(); });
    u.$('#f-order').addEventListener('change', e => { HS.filters.order = e.target.value; F.touch(); });
    u.$('#f-pages-min').addEventListener('change', e => { HS.filters.pagesMin = e.target.value; F.touch(); });
    u.$('#f-pages-max').addEventListener('change', e => { HS.filters.pagesMax = e.target.value; F.touch(); });
    u.$('#f-persource').addEventListener('change', e => {
      HS.settings.perSource = u.clamp(parseInt(e.target.value, 10) || 12, 4, 40);
      e.target.value = HS.settings.perSource;
      HS.store.save(HS.settings);
    });

    /* 镜像域名（禁漫 / 紳士 域名经常更换，允许自行追加） */
    const bindMirror = (sel, key, label) => {
      const el = u.$(sel);
      if (!el) return;
      el.addEventListener('change', () => {
        HS.settings[key] = el.value.trim();
        HS.store.save(HS.settings);
        HS.toast(HS.settings[key] ? label + '镜像已更新' : label + '镜像已清空');
      });
    };
    bindMirror('#f-jm-mirrors', 'jmMirrors', '禁漫');
    bindMirror('#f-wn-mirrors', 'wnacgMirrors', '紳士');

    /* 自定义中文源 */
    const tplSel = u.$('#f-cs-tpl');
    if (tplSel) {
      tplSel.innerHTML = Object.keys(HS.sources.CUSTOM_TPL)
        .map(k => '<option value="' + k + '">' + u.esc(HS.sources.CUSTOM_TPL[k].label) + '</option>').join('');
    }
    u.$('#f-cs-add').addEventListener('click', () => {
      const name = u.$('#f-cs-name').value.trim();
      const domain = u.$('#f-cs-domain').value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
      const template = u.$('#f-cs-tpl').value || 'generic';
      if (!domain) { HS.toast('请填写域名', 'warn'); return; }
      if (HS.sources.customList().some(c => c.domain === domain)) { HS.toast('该域名已存在', 'warn'); return; }
      HS.settings.customSources = (HS.settings.customSources || []).concat([{
        name: name || domain, domain, template, enabled: true
      }]);
      HS.store.save(HS.settings);
      u.$('#f-cs-name').value = ''; u.$('#f-cs-domain').value = '';
      renderCustom();
      HS.toast('已添加自定义源：' + (name || domain), 'ok');
    });

    /* 代理 */
    const proxyInput = u.$('#f-proxy');
    const presetSel = u.$('#f-proxy-preset');
    proxyInput.addEventListener('change', () => {
      HS.settings.proxy = proxyInput.value.trim();
      HS.store.save(HS.settings); F.updateBadge();
      HS.net.resetProxyHealth();
      HS.toast(HS.settings.proxy ? '已启用代理：' + HS.net.proxyName(HS.settings.proxy) : '已改用自动代理链');
      HS.net._cache = null;
      HS.bus.emit('proxy:change');
    });
    presetSel.addEventListener('change', async () => {
      if (presetSel.value === '__custom__') { proxyInput.focus(); return; }
      if (presetSel.value === 'auto') {
        HS.settings.proxy = 'auto';
        HS.store.save(HS.settings);
        HS.net.resetProxyHealth();
        HS.toast('正在竞速挑选可用公共代理…', 'info', 2200);
        const picked = await HS.net.autoPickProxy();
        HS.net._cache = null;
        HS.toast(picked
          ? '已选用 ' + picked.name + '（' + u.fmtMs(picked.ms) + '）'
          : '没有可用的公共代理，请改用自建代理或开启 VPN',
          picked ? 'ok' : 'err', 3800);
        HS.bus.emit('proxy:change');
        return;
      }
      proxyInput.value = presetSel.value;
      proxyInput.dispatchEvent(new Event('change'));
    });
    u.$('#f-proxy-test').addEventListener('click', async e => {
      const btn = e.currentTarget;
      const p = proxyInput.value.trim();
      if (!p) { HS.toast('请先填写代理地址', 'warn'); return; }
      btn.disabled = true; btn.textContent = '测试中…';
      try {
        const r = await HS.net.testProxy(p);
        HS.toast('代理可用 · ' + u.fmtMs(r.ms) + ' · ' + r.body.slice(0, 24), 'ok', 3200);
      } catch (err) {
        HS.toast('代理不可用：' + err.message, 'err', 4200);
      } finally { btn.disabled = false; btn.textContent = '测试'; }
    });

    /* 本地网关 */
    const gwInput = u.$('#f-gateway');
    const gwState = u.$('#f-gw-state');
    const paintGw = ok => {
      if (!gwState) return;
      gwState.dataset.state = ok ? 'ok' : 'off';
      gwState.textContent = ok
        ? '✓ 已连接 ' + HS.net.gateway.base + '（禁漫官方 API / 拷贝漫画 可用）'
        : '未检测到本地网关';
      const btn = u.$('#f-gw-detect');
      if (btn) btn.dataset.on = ok ? '1' : '0';
    };
    if (gwInput) {
      gwInput.value = HS.settings.gateway || '';
      gwInput.addEventListener('change', async () => {
        HS.settings.gateway = gwInput.value.trim();
        HS.store.save(HS.settings);
        HS.toast('正在检测网关…', 'info', 1600);
        const ok = await HS.net.gateway.probe(true);
        paintGw(ok);
        HS.toast(ok ? '网关可用：' + HS.net.gateway.base : '未检测到网关，请确认已运行 node tools/gateway.js', ok ? 'ok' : 'err', 4200);
      });
    }
    if (u.$('#f-gw-detect')) {
      u.$('#f-gw-detect').addEventListener('click', async () => {
        HS.toast('正在检测网关…', 'info', 1600);
        const ok = await HS.net.gateway.probe(true);
        paintGw(ok);
        HS.toast(ok ? HS.net.gateway.describe() : '未检测到网关：在项目目录执行 node tools/gateway.js', ok ? 'ok' : 'err', 4200);
      });
    }
    if (u.$('#f-gw-open')) {
      u.$('#f-gw-open').addEventListener('click', () => {
        const base = HS.net.gateway.base || HS.net.gateway.setting() || ('http://127.0.0.1:' + HS.net.gateway.DEFAULT_PORT);
        window.open(base.replace(/\/+$/, '') + '/', '_blank', 'noopener');
      });
    }
    HS.bus.on('net:gateway', d => paintGw(!!(d && d.ok)));

    /* 抽屉按钮 */
    u.$('#fp-close').addEventListener('click', () => sheetOpen(false));
    u.$('#fp-reset').addEventListener('click', () => F.reset());
    HS.bus.on('filters:submit', () => HS.bus.emit('app:search'));

    syncAll();
  };

})(window.HS);
