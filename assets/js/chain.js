/* ==========================================================================
   chain.js — 「检索思维链」可视化
   仅在检索时出现；初始即折叠 + 模糊，用户点击表头才展开
   打字机逐行输出 + 逐源进度胶囊 + 计时器 + 总进度条
   ========================================================================== */
(function (HS) {
  'use strict';
  const u = HS.u;
  const C = HS.chain = {};

  let panel, log, srcBox, timerEl, statusEl, progEl, toggleBtn, hintEl, bodyEl;
  let t0 = 0, timerId = null, steps = 0, opened = false;
  const pills = {};

  /* ---------------- 打字机 ---------------- */
  function typewrite(node, text) {
    const level = HS.settings.animLevel;
    const str = String(text == null ? '' : text);
    if (level !== 'full' || str.length < 4) {
      node.textContent = str;
      scroll();
      return Promise.resolve();
    }
    const myNode = node;
    return new Promise(res => {
      const token = myNode._token = (myNode._token || 0) + 1;
      myNode.innerHTML = '';
      const tn = document.createTextNode('');
      const caret = u.el('i', { class: 'hs-caret' });
      myNode.appendChild(tn); myNode.appendChild(caret);
      const chunk = Math.max(1, Math.ceil(str.length / 26));
      let i = 0;
      const id = setInterval(() => {
        if (myNode._token !== token) { clearInterval(id); caret.remove(); return res(); }
        i = Math.min(str.length, i + chunk);
        tn.data = str.slice(0, i);
        scroll();
        if (i >= str.length) { clearInterval(id); caret.remove(); res(); }
      }, 12);
    });
  }

  function scroll() {
    if (!log) return;
    /* 折叠态也要把「最新一行」顶进可视区（overflow:hidden 仍可编程滚动） */
    log.scrollTop = log.scrollHeight;
  }

  /* ---------------- 计时器 ---------------- */
  function startTimer() {
    stopTimer();
    t0 = u.now();
    timerEl.textContent = '0.0s';
    timerId = setInterval(() => { timerEl.textContent = ((u.now() - t0) / 1000).toFixed(1) + 's'; }, 90);
  }
  function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } }

  /* ---------------- 展开 / 折叠 ---------------- */
  C.expand = function (on) {
    opened = !!on;
    panel.dataset.state = opened ? 'open' : 'collapsed';
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', opened ? 'true' : 'false');
    if (hintEl) {
      const base = hintEl.dataset.base || '';
      hintEl.textContent = (opened ? '收起' : '点击展开') + (base ? ' · ' + base : '');
    }
    if (opened) scroll();
  };
  C.toggle = function () { C.expand(!opened); };
  C.isOpen = () => opened;

  C.setHint = function (base) {
    if (!hintEl) return;
    hintEl.dataset.base = base || '';
    hintEl.textContent = (opened ? '收起' : '点击展开') + (base ? ' · ' + base : '');
  };

  /* ---------------- 生命周期 ---------------- */
  C.begin = function () {
    panel.hidden = false;
    log.innerHTML = '';
    srcBox.innerHTML = '';
    Object.keys(pills).forEach(k => delete pills[k]);
    steps = 0;
    progEl.style.width = '3%';
    statusEl.textContent = '思考中';
    statusEl.dataset.s = 'run';
    C.expand(false);                 // 初始折叠（内容带模糊）
    C.setHint('');
    startTimer();
  };

  /** 添加一行思维链步骤 */
  C.step = function (text, opts) {
    opts = opts || {};
    const row = u.el('div', { class: 'hs-step', 'data-s': opts.state || 'run' });
    row.innerHTML = '<span class="hs-step-ico" aria-hidden="true"></span>' +
      '<span class="hs-step-txt"><span class="hs-tw"></span></span>' +
      '<span class="hs-step-meta"></span>';
    const tw = row.querySelector('.hs-tw');
    const metaEl = row.querySelector('.hs-step-meta');
    if (opts.meta) metaEl.textContent = opts.meta;
    /* 只有最新一行保持清晰，更早的行模糊退场（折叠态下这就是「一行清晰摘要」） */
    u.$$('.hs-step', log).forEach(n => n.removeAttribute('data-fresh'));
    row.setAttribute('data-fresh', '1');
    log.appendChild(row);
    scroll();
    steps++;
    const typed = typewrite(tw, text);

    return {
      row, tw, typed,
      set(state, meta, newText) {
        tw._token = (tw._token || 0) + 1;      // 中断打字
        if (newText != null) tw.textContent = newText;
        if (state) row.dataset.s = state;
        if (meta != null) metaEl.textContent = meta;
        u.$$('.hs-step', log).forEach(n => n.removeAttribute('data-fresh'));
        row.setAttribute('data-fresh', '1');
        scroll();
        return this;
      }
    };
  };

  C.progress = function (pct) { progEl.style.width = u.clamp(pct, 0, 100) + '%'; };

  C.status = function (text, state) {
    statusEl.textContent = text;
    statusEl.dataset.s = state || '';
  };

  /** 预渲染所有信息源胶囊 */
  C.prepareSources = function (list) {
    srcBox.innerHTML = '';
    list.forEach(src => {
      const pill = u.el('span', { class: 'hs-srcpill', 'data-s': 'idle', 'data-id': src.id });
      pill.innerHTML = '<i class="hs-sp"></i><b>' + u.esc(src.name) + '</b><span class="hs-sm">等待</span>';
      srcBox.appendChild(pill);
      pills[src.id] = pill;
    });
  };

  /** 更新单个源的状态 */
  C.setSource = function (id, state, ms, count, note) {
    const pill = pills[id];
    if (!pill) return;
    pill.dataset.s = state;
    const small = pill.querySelector('.hs-sm');
    if (state === 'run') small.textContent = '检索中…';
    else if (state === 'ok') small.textContent = (count != null ? count + ' 条' : '完成') + ' · ' + u.fmtMs(ms);
    else if (state === 'fail') small.textContent = '失败';
    else small.textContent = note || '等待';
    if (note && state !== 'ok') pill.title = note;
  };

  C.finish = function (opts) {
    opts = opts || {};
    stopTimer();
    const ms = u.now() - t0;
    C.progress(100);
    C.status(opts.status || '完成', opts.ok === false ? 'fail' : 'done');
    if (opts.line) C.step(opts.line, { state: opts.ok === false ? 'fail' : 'ok', meta: u.fmtMs(ms) });
    if (opts.hint != null) C.setHint(opts.hint);
    return ms;
  };

  C.elapsed = () => u.now() - t0;
  C.hide = function () { panel.hidden = true; stopTimer(); };

  C.init = function () {
    panel = u.$('#chain-panel');
    log = u.$('#chain-log');
    srcBox = u.$('#chain-sources');
    timerEl = u.$('#chain-timer');
    statusEl = u.$('#chain-status');
    progEl = u.$('#chain-progress');
    toggleBtn = u.$('#chain-toggle');
    hintEl = u.$('#chain-hint');
    bodyEl = u.$('#chain-body');
    const chev = u.$('.hs-chev', toggleBtn);
    if (chev && !chev.innerHTML) chev.innerHTML = HS.icon.chev;
    if (toggleBtn) toggleBtn.addEventListener('click', () => C.toggle());
    C.expand(false);
  };

})(window.HS);
