/* ==========================================================================
   results.js — 结果聚合后处理与渲染
   跨源去重 → 相关性重排 → 同系列堆叠 → 卡片渲染（封面模糊 / 骨架 / 流式）
   ========================================================================== */
(function (HS) {
  'use strict';
  const u = HS.u;
  const R = HS.results = {};

  R.raw = [];           // 原始合并结果
  R.items = [];         // 处理后的结果
  R.q = ''; R.f = {};
  R._partial = [];      // 流式接收阶段的逐源结果
  R.streaming = false;
  R.sort = 'rank';
  R.sourceFilter = null;
  R.seriesOnly = null;  // 只看某个系列（由堆叠角标触发）

  const STACK_MAX = 5;  // 一个堆叠最多平铺几张

  /* ---------------- 去重 + 重排 ---------------- */
  function weightOf(id) {
    const s = HS.sources.byId[id];
    return s ? s.weight : 0.5;
  }

  function relevance(item, q, f) {
    let s = weightOf(item.source) * 10;
    s += item.cover && item.cover.indexOf('data:') !== 0 ? 3 : 0;
    if (q) {
      const t = item.title.toLowerCase();
      if (t.indexOf(q) >= 0) s += 9;
      const c = u.normTitle(item.title), nq = u.normTitle(q);
      if (nq && c.indexOf(nq) >= 0) s += 5;
    }
    if (f.artist) {
      const a = (item.artist || '').toLowerCase();
      if (a && a.indexOf(String(f.artist).toLowerCase()) >= 0) s += 7;
    }
    (f.tags || []).forEach(tag => {
      const tl = String(tag).toLowerCase();
      if ((item.tags || []).some(x => String(x).toLowerCase().indexOf(tl) >= 0)) s += 3;
    });
    if (item.pages) s += Math.min(3, item.pages / 20);
    if (f.pagesMin && item.pages && item.pages < f.pagesMin) s -= 4;
    if (f.pagesMax && item.pages && item.pages > f.pagesMax) s -= 4;
    if ((f.langs || []).length && (item.langs || []).length &&
      item.langs.some(l => f.langs.indexOf(l) >= 0)) s += 4;
    if (item.series) s += 1.5;                    // 可归入系列的更可能被复用
    s += Math.min(2, (item.tags || []).length / 6);
    return s;
  }

  /** 合并所有源返回，跨源去重（同作品多来源合并为一条，记录 alsoOn） */
  R.combine = function (results, q, f) {
    const all = [];
    results.forEach(r => { if (r.ok && r.items) r.items.forEach(it => all.push(it)); });

    const map = {};
    all.forEach(it => {
      const k = it.key || (it.source + it.id);
      const cur = map[k];
      if (!cur) { it.alsoOn = []; map[k] = it; return; }
      if (weightOf(it.source) > weightOf(cur.source)) {
        it.alsoOn = u.uniq((cur.alsoOn || []).concat([cur.sourceName]));
        map[k] = it;
      } else {
        cur.alsoOn = u.uniq((cur.alsoOn || []).concat([it.sourceName]));
        if (!cur.cover || cur.cover.indexOf('data:') === 0) {
          if (it.cover && it.cover.indexOf('data:') !== 0) cur.cover = it.cover;
        }
        if (!cur.pages && it.pages) cur.pages = it.pages;
        if (!cur.artist && it.artist) cur.artist = it.artist;
        cur.tags = u.uniq((cur.tags || []).concat(it.tags || [])).slice(0, 16);
        cur.cats = u.uniq((cur.cats || []).concat(it.cats || []));
      }
    });

    const out = Object.keys(map).map(k => map[k]);
    out.forEach(it => { it._score = relevance(it, (q || '').toLowerCase(), f || {}); });
    out.sort((a, b) => b._score - a._score);
    return out;
  };

  /* ---------------- 过滤 + 排序 ---------------- */
  function applyView() {
    let list = R.items.slice();
    if (R.sourceFilter) list = list.filter(i => i.source === R.sourceFilter);
    const by = {
      rank: (a, b) => b._score - a._score,
      pages: (a, b) => (b.pages || 0) - (a.pages || 0),
      source: (a, b) => (a.sourceName || '').localeCompare(b.sourceName || '') || b._score - a._score,
      title: (a, b) => (a.title || '').localeCompare(b.title || '')
    }[R.sort] || ((a, b) => b._score - a._score);
    return list.sort(by);
  }

  /* ---------------- 同系列堆叠布局 ---------------- */
  function buildLayout(list) {
    if (R.seriesOnly) {
      return list.filter(i => i.series === R.seriesOnly).map(i => ({ type: 'single', item: i }));
    }
    const out = [], groups = {};
    list.forEach(it => {
      const k = it.series;
      if (!k) { out.push({ type: 'single', item: it }); return; }
      if (!groups[k]) {
        const g = { type: 'stack', key: k, items: [], total: 0 };
        groups[k] = g; out.push(g);
      }
      groups[k].total++;
      if (groups[k].items.length < STACK_MAX) groups[k].items.push(it);
    });
    /* 只有一本的「系列」降级为普通卡片 */
    return out.map(n => (n.type === 'stack' && n.total < 2) ? { type: 'single', item: n.items[0] } : n);
  }

  /** 决定每一叠向哪边展开，避免右侧越界 */
  function applyFanDirection() {
    const grid = u.$('#results-grid');
    if (!grid) return;
    const gr = grid.getBoundingClientRect();
    u.$$('.hs-stack', grid).forEach(st => {
      const r = st.getBoundingClientRect();
      if (!r.width) return;
      const center = r.left + r.width / 2;
      st.dataset.fan = (center > gr.left + gr.width * 0.55) ? 'left' : 'right';
    });
  }
  R.applyFanDirection = applyFanDirection;

  /* ---------------- 源 / 系列 过滤条 ---------------- */
  function renderHead() {
    const host = u.$('#results-srcfilter');
    const counts = {};
    R.items.forEach(i => { counts[i.source] = (counts[i.source] || 0) + 1; });
    host.innerHTML = '';

    if (R.seriesOnly) {
      const chip = u.el('button', { class: 'hs-tag hs-tag-series', type: 'button', 'data-on': '1' },
        '系列：' + u.esc(R.seriesOnly) + ' <small>✕</small>');
      chip.addEventListener('click', () => { R.seriesOnly = null; renderHead(); renderGrid(); });
      host.appendChild(chip);
    }

    const mkBtn = (id, label, n) => {
      const b = u.el('button', {
        class: 'hs-tag', type: 'button', 'data-on': (R.sourceFilter === id) ? '1' : '0'
      }, u.esc(label) + (n != null ? ' <small>' + n + '</small>' : ''));
      b.addEventListener('click', () => {
        R.sourceFilter = (R.sourceFilter === id) ? null : id;
        renderHead(); renderGrid();
      });
      return b;
    };
    host.appendChild(mkBtn(null, '全部', R.items.length));
    Object.keys(counts).sort((a, b) => counts[b] - counts[a]).forEach(id => {
      const nm = (HS.sources.byId[id] || {}).name || id;
      host.appendChild(mkBtn(id, nm, counts[id]));
    });
  }

  /* ---------------- 卡片 ---------------- */
  function catLabel(it) {
    if (!it.cats || !it.cats.length) return '';
    const c = HS.CATS.find(x => x.code === it.cats[0]);
    return c ? c.label : '';
  }

  function cardNode(it, idx) {
    const card = u.el('article', { class: 'hs-card', 'data-src': it.source, 'data-key': it.key || it.id });

    const img = u.el('img', {
      alt: it.title, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer'
    });
    img.addEventListener('error', function onerr() {
      img.removeEventListener('error', onerr);
      img.src = u.placeholder(it.title, it.key || it.id);
    });
    img.src = it.cover || u.placeholder(it.title, it.key || it.id);

    const imgBox = u.el('div', { class: 'hs-card-img' });
    imgBox.appendChild(img);

    const badges = u.el('div', { class: 'hs-card-badges' });
    badges.appendChild(u.el('span', { class: 'hs-pill hs-pill-src' }, u.esc(it.sourceName || it.source)));
    const cl = catLabel(it);
    if (cl) badges.appendChild(u.el('span', { class: 'hs-pill' }, u.esc(cl)));
    if (it.pages) badges.appendChild(u.el('span', { class: 'hs-pill' }, it.pages + 'P'));
    if ((it.alsoOn || []).length) badges.appendChild(u.el('span', { class: 'hs-pill' }, '+' + it.alsoOn.length + ' 站'));
    imgBox.appendChild(badges);

    const reveal = u.el('button', { class: 'hs-card-reveal', type: 'button' }, '点击显示');
    reveal.addEventListener('click', ev => {
      ev.preventDefault(); ev.stopPropagation();
      const on = card.getAttribute('data-reveal') === '1';
      card.setAttribute('data-reveal', on ? '0' : '1');
      reveal.textContent = on ? '点击显示' : '重新模糊';
    });
    imgBox.appendChild(reveal);
    card.appendChild(imgBox);

    const body = u.el('div', { class: 'hs-card-body' });
    body.appendChild(u.el('div', { class: 'hs-card-title' }, u.esc(it.title)));

    const subBits = [];
    if (it.artist) subBits.push(u.esc(it.artist.slice(0, 26)));
    if (it.langs && it.langs.length) subBits.push(it.langs.slice(0, 2).join('/'));
    else if (it.lang) subBits.push(u.esc(it.lang));
    if (it.year) subBits.push(u.esc(String(it.year)));
    if (subBits.length) body.appendChild(u.el('div', { class: 'hs-card-sub' }, subBits.join(' <i class="hs-dot"></i> ')));

    const tagBox = u.el('div', { class: 'hs-card-tags' });
    (it.tags || []).slice(0, 3).forEach(t => tagBox.appendChild(u.el('span', { class: 'hs-mtag', title: t }, u.esc(t))));
    if ((it.tags || []).length > 3) tagBox.appendChild(u.el('span', { class: 'hs-mtag' }, '+' + (it.tags.length - 3)));
    body.appendChild(tagBox);
    card.appendChild(body);

    const actions = u.el('div', { class: 'hs-card-actions' });
    const open = u.el('a', {
      class: 'hs-btn hs-btn-primary', href: it.url, target: '_blank', rel: 'noopener noreferrer'
    }, '打开原站');
    if (!it.url || it.url === '#demo') { open.removeAttribute('target'); open.setAttribute('href', '#demo'); }
    actions.appendChild(open);

    const cp = u.el('button', { class: 'hs-btn hs-btn-ico', type: 'button', title: '复制链接' }, HS.icon.copy);
    cp.addEventListener('click', async ev => {
      ev.stopPropagation();
      try { await navigator.clipboard.writeText(it.url || ''); HS.toast('链接已复制', 'ok', 1500); }
      catch (e) { HS.toast('复制失败，请手动复制', 'warn'); }
    });
    actions.appendChild(cp);

    if (it.artist) {
      const af = u.el('button', { class: 'hs-btn hs-btn-ico', type: 'button', title: '按画师筛选：' + it.artist }, HS.icon.user);
      af.addEventListener('click', ev => { ev.stopPropagation(); HS.filtersUI.setArtist(it.artist); });
      actions.appendChild(af);
    }
    card.appendChild(actions);

    card.style.animationDelay = Math.min(idx * 22, 620) + 'ms';
    return card;
  }

  /** 同系列堆叠：多张卡片叠放，悬停/点击后像手牌一样展开 */
  function stackNode(group) {
    const wrap = u.el('div', {
      class: 'hs-stack', 'data-key': group.key, 'data-fan': 'right',
      role: 'group', 'aria-label': '同系列 ' + group.total + ' 本'
    });
    group.items.forEach((it, i) => {
      const card = cardNode(it, 0);
      card.style.setProperty('--i', String(i));
      card.style.animationDelay = (i * 30) + 'ms';
      card.style.zIndex = String(40 - i);
      if (i > 0) card.setAttribute('tabindex', '-1');
      wrap.appendChild(card);
    });

    /* 鼠标停在「哪一张」上，哪一张就过渡到最顶层（sticky：走过缝隙也不会闪回） */
    const cards = u.$$('.hs-card', wrap);
    let raised = -1;
    const setRaised = i => {
      if (raised === i) return;
      raised = i;
      cards.forEach((c, k) => c.classList.toggle('is-raised', k === i));
    };
    cards.forEach((c, i) => c.addEventListener('pointerenter', () => setRaised(i)));
    cards.forEach((c, i) => c.addEventListener('focus', () => setRaised(i)));
    wrap.addEventListener('pointerleave', () => setRaised(-1));
    wrap.addEventListener('blur', () => setRaised(-1), true);

    const count = u.el('div', { class: 'hs-stack-count' }, group.total + ' 本同系列');
    wrap.appendChild(count);

    const tag = u.el('button', { class: 'hs-stack-tag', type: 'button' },
      '展开全部 <small>' + group.total + '</small>');
    tag.addEventListener('click', ev => {
      ev.preventDefault(); ev.stopPropagation();
      R.seriesOnly = group.key;
      renderHead(); renderGrid();
      u.$('#results-grid').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    wrap.appendChild(tag);

    /* 触屏：点一下堆叠即可摊开 */
    wrap.addEventListener('click', ev => {
      if (ev.target.closest('.hs-card-actions')) return;
      if (wrap.dataset.open === '1') { wrap.dataset.open = '0'; return; }
      if (!ev.target.closest('.hs-stack-tag')) wrap.dataset.open = '1';
    });
    return wrap;
  }

  function renderGrid() {
    const grid = u.$('#results-grid');
    const list = applyView();
    grid.innerHTML = '';

    if (!list.length) {
      if (R.streaming) { u.$('#results-empty').hidden = true; return; }
      const filtered = (R.sourceFilter && R.items.length) || (R.seriesOnly && R.items.length);
      u.$('#results-empty').hidden = false;
      u.$('#results-empty').innerHTML = filtered
        ? '<b>该筛选下没有结果</b>点击上方「全部」或清掉系列筛选查看其它来源。'
        : '<b>没有找到相关结果</b>可以试试：<div class="hs-empty-actions">' +
          '<button class="hs-btn hs-btn-ghost" data-act="relax">放宽语言限制</button>' +
          '<button class="hs-btn hs-btn-ghost" data-act="cats">清空作品类型</button>' +
          '<button class="hs-btn hs-btn-ghost" data-act="modes">关掉 R18G / AI 过滤</button>' +
          '<button class="hs-btn hs-btn-ghost" data-act="proxy">检查代理设置</button>' +
          '<button class="hs-btn hs-btn-ghost" data-act="demo">只看示例数据</button></div>';
      const acts = {
        relax: () => { HS.filters.langs = []; HS.filtersUI.syncAll(); HS.bus.emit('app:search'); },
        cats: () => { HS.filters.cats = []; HS.filtersUI.syncAll(); HS.filtersUI.touch(); HS.bus.emit('app:search'); },
        modes: () => { HS.filters.gore = 'any'; HS.filters.ai = 'any'; HS.filtersUI.syncAll(); HS.filtersUI.touch(); HS.bus.emit('app:search'); },
        proxy: () => { HS.filtersUI.openSheet(true); const p = u.$('#f-proxy'); if (p) p.focus(); },
        demo: () => useDemoOnly()
      };
      u.$$('#results-empty [data-act]').forEach(b => b.addEventListener('click', () => acts[b.dataset.act] && acts[b.dataset.act]()));
      return;
    }

    u.$('#results-empty').hidden = true;
    const layout = buildLayout(list);
    const frag = document.createDocumentFragment();
    layout.forEach((node, i) => {
      if (node.type === 'stack') frag.appendChild(stackNode(node));
      else {
        const c = cardNode(node.item, i);
        c.dataset.key = node.item.key || node.item.id;
        frag.appendChild(c);
      }
    });
    grid.appendChild(frag);
    requestAnimationFrame(applyFanDirection);
  }
  R.renderGrid = renderGrid;

  /* ---------------- 工具 ---------------- */
  function useDemoOnly() {
    HS.settings.sources = ['demo'];
    HS.store.save(HS.settings);
    HS.bus.emit('settings:change', { key: 'sources', val: ['demo'] });
    HS.toast('已切换为「仅示例数据」来源', 'ok', 2600);
    HS.bus.emit('app:search');
  }

  /* ---------------- 公开 API ---------------- */
  /** 开始流式接收：先到的源先出结果，不必等最慢的源超时（保留骨架屏） */
  R.streamStart = function (q, f) {
    R.q = q || ''; R.f = f || {};
    R._partial = [];
    R.items = [];
    R.streaming = true;
    R.sourceFilter = null;
    R.seriesOnly = null;
    u.$('#results-head').hidden = false;
    u.$('#results-empty').hidden = true;
    u.$('#results-meta').innerHTML = '正在检索…';
    const sf = u.$('#results-srcfilter');
    if (sf) sf.innerHTML = '';
  };

  /** 某个源返回后立即并入结果 */
  R.streamPush = function (res) {
    if (!R.streaming) return;
    const before = R.items.length;
    R._partial.push(res);
    R.items = R.combine(R._partial, R.q, R.f);
    const okSrc = R._partial.filter(r => r.ok && r.items && r.items.length).length;
    u.$('#results-meta').innerHTML = '已收到 <em>' + R.items.length + '</em> 条 · 完成源 ' +
      okSrc + '/' + R._partial.length + '（其余仍在检索中）';
    if (R.items.length !== before) { renderHead(); renderGrid(); }
  };

  R.skeletons = function (n) {
    const grid = u.$('#results-grid');
    grid.innerHTML = '';
    u.$('#results-empty').hidden = true;
    u.$('#results-head').hidden = false;
    u.$('#results-meta').innerHTML = '正在检索…';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < (n || 8); i++) {
      const c = u.el('div', { class: 'hs-card hs-card-skel' });
      c.innerHTML = '<div class="hs-skel hs-skel-img"></div>' +
        '<div class="hs-skel hs-skel-line l1"></div>' +
        '<div class="hs-skel hs-skel-line l2"></div>' +
        '<div class="hs-skel hs-skel-line l3"></div>';
      c.style.animationDelay = (i * 30) + 'ms';
      frag.appendChild(c);
    }
    grid.appendChild(frag);
  };

  R.render = function (results, meta) {
    meta = meta || {};
    R.streaming = false;
    R.raw = results;
    R.items = R.combine(results, meta.q, meta.f || {});
    R.sourceFilter = null;
    R.seriesOnly = null;

    const okSrc = results.filter(r => r.ok && r.items && r.items.length).length;
    const failSrc = results.filter(r => !r.ok).length;

    u.$('#results-head').hidden = false;
    const bits = ['找到 <em>' + R.items.length + '</em> 个可能相关的结果'];
    if (typeof meta.ms === 'number') bits.push('用时 ' + u.fmtMs(meta.ms));
    bits.push('成功源 ' + okSrc + '/' + results.length);
    u.$('#results-meta').innerHTML = bits.join(' · ');

    renderHead();
    renderGrid();

    /* 全部失败时给出可执行的诊断 */
    if (!R.items.length && failSrc === results.length) {
      const reasons = results.map(r => (HS.sources.byId[r.src.id] || {}).name + '：' + r.error).join('；');
      HS.toast('所有信息源均失败，请查看下方提示', 'err', 4200);
      u.$('#results-empty').hidden = false;
      u.$('#results-empty').innerHTML =
        '<b>所有信息源都失败了</b><p style="margin:6px 0 2px;max-width:640px">' + u.esc(reasons) + '</p>' +
        '<div class="hs-empty-actions">' +
        '<button class="hs-btn hs-btn-primary" data-act="net">重新检测网络</button>' +
        '<button class="hs-btn hs-btn-ghost" data-act="proxy">配置 CORS 代理</button>' +
        '<button class="hs-btn hs-btn-ghost" data-act="demo">仅用示例数据演示</button></div>';
      const acts = {
        net: () => HS.bus.emit('net:recheck'),
        proxy: () => { HS.filtersUI.openSheet(true); const p = u.$('#f-proxy'); if (p) p.focus(); },
        demo: () => useDemoOnly()
      };
      u.$$('#results-empty [data-act]').forEach(b => b.addEventListener('click', () => acts[b.dataset.act] && acts[b.dataset.act]()));
    }
    return R.items;
  };

  R.reset = function () {
    R.items = []; R.raw = []; R.sourceFilter = null; R.seriesOnly = null;
    u.$('#results-grid').innerHTML = '';
    u.$('#results-head').hidden = true;
    u.$('#results-empty').hidden = true;
  };

  R.init = function () {
    u.$('#results-sort').addEventListener('change', e => { R.sort = e.target.value; renderGrid(); });
    window.addEventListener('resize', u.debounce(applyFanDirection, 160));

    /* 点击封面切换揭示 */
    u.$('#results-grid').addEventListener('click', e => {
      const imgBox = e.target.closest('.hs-card-img');
      if (!imgBox || e.target.closest('.hs-card-reveal')) return;
      const card = imgBox.closest('.hs-card');
      if (!card || card.classList.contains('hs-card-skel')) return;
      if (!document.documentElement.classList.contains('hs-blurcovers')) return;
      card.setAttribute('data-reveal', card.getAttribute('data-reveal') === '1' ? '0' : '1');
    });
  };

})(window.HS);
