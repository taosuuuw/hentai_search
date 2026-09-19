/* ==========================================================================
   panic.js — 一键极速遮蔽（尊严保护）
   设计要点：
   · 遮罩层在 HTML 中预置，切换只做 class / inline style 变更，无过渡、无异步
   · 双保险：外层遮罩（不透明+backdrop-filter，先于滤镜绘制）+ #hs-app 整体模糊
   · 快捷键可自定义，支持单键与组合键，含输入框保护
   · 顶栏常驻状态图标，实时显示 ON/OFF
   ========================================================================== */
(function (HS) {
  'use strict';
  const u = HS.u;
  const P = HS.panic = {};

  let app, overlay, indicator, indicatorState, hintEl, bigIco;
  let recording = false;
  let savedTitle = null, savedIcon = null;

  /* ---------------- 快捷键编解码 ---------------- */
  const KEYLABEL = {
    Escape: 'Esc', Space: 'Space', Backquote: '`', Minus: '-', Equal: '=',
    BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'",
    Comma: ',', Period: '.', Slash: '/', Enter: 'Enter', Tab: 'Tab', CapsLock: 'Caps',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Home: 'Home', End: 'End',
    PageUp: 'PgUp', PageDown: 'PgDn', Insert: 'Ins', Delete: 'Del', Backspace: '⌫', ContextMenu: 'Menu'
  };

  function keyLabel(code) {
    if (/^Key([A-Z])$/.test(code)) return code.slice(3);
    if (/^Digit(\d)$/.test(code)) return code.slice(5);
    if (/^Numpad(\w+)$/.test(code)) return 'Num' + code.slice(6);
    if (/^F\d{1,2}$/.test(code)) return code;
    return KEYLABEL[code] || code;
  }

  /** 把 KeyboardEvent 规范化为稳定字符串，如 'Ctrl+Shift+KeyX' */
  P.canon = function (e) {
    const code = e.code || '';
    if (!code) return '';
    if (/^(Control|Alt|Shift|Meta)(Left|Right)$/.test(code)) return ''; // 纯修饰键
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Meta');
    return mods.concat([code]).join('+');
  };

  /** 显示用：'Ctrl+Shift+KeyX' -> 'Ctrl + Shift + X'（Mac 用符号） */
  P.label = function (canon, plain) {
    if (!canon) return '（未设置）';
    const mac = u.isMac();
    const parts = String(canon).split('+').map((p, i, arr) => {
      if (i === arr.length - 1) return keyLabel(p);
      if (mac) return { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' }[p] || p;
      return p;
    });
    return parts.join(plain ? ' + ' : ' + ');
  };

  P.kbdHTML = function (canon) {
    if (!canon) return '<kbd>—</kbd>';
    return String(canon).split('+').map(p => '<kbd>' + u.esc(keyLabel(p)) + '</kbd>').join('+');
  };

  P.hasModifier = canon => /^(Ctrl|Alt|Shift|Meta)\+/.test(canon || '');

  /* ---------------- 遮蔽状态 ---------------- */
  P.isOn = () => document.documentElement.classList.contains('hs-panic');

  function applyOverlay(on) {
    if (!overlay) return;
    overlay.style.opacity = on ? '1' : '0';
    overlay.style.visibility = on ? 'visible' : 'hidden';
    overlay.style.pointerEvents = on ? 'auto' : 'none';
    overlay.setAttribute('aria-hidden', on ? 'false' : 'true');
  }

  function applyBlur(on) {
    if (!app) return;
    if (on) {
      app.style.filter = 'blur(26px) saturate(.35) brightness(.5)';
      app.style.pointerEvents = 'none';
      app.style.userSelect = 'none';
    } else {
      app.style.filter = '';
      app.style.pointerEvents = '';
      app.style.userSelect = '';
    }
  }

  function paintIndicator() {
    const on = P.isOn();
    if (indicator) {
      indicator.setAttribute('aria-pressed', on ? 'true' : 'false');
      indicator.title = (on ? '已遮蔽 · 点击或按 ' : '快速模糊 · ') + P.label(HS.settings.panicKey);
    }
    if (indicatorState) indicatorState.textContent = on ? 'ON' : 'OFF';
    if (bigIco) bigIco.dataset.on = on ? '1' : '0';
    if (hintEl) hintEl.innerHTML = '按 ' + P.kbdHTML(HS.settings.panicKey) + ' 或点击任意位置恢复';
    HS.bus.emit('panic:change', on);
  }

  function hideTitle() {
    if (!HS.settings.panicHideTitle) return;
    if (savedTitle == null) savedTitle = document.title;
    if (savedIcon == null) {
      const l = document.querySelector('link[rel="icon"]');
      savedIcon = l ? l.getAttribute('href') : '';
    }
    document.title = '新标签页';
    const l = document.querySelector('link[rel="icon"]');
    if (l) l.setAttribute('href', 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22%3E%3Crect width=%2216%22 height=%2216%22 rx=%223%22 fill=%22%23bbb%22/%3E%3C/svg%3E');
  }

  function restoreTitle() {
    if (savedTitle != null) { document.title = savedTitle; savedTitle = null; }
    if (savedIcon != null) {
      const l = document.querySelector('link[rel="icon"]');
      if (l && savedIcon) l.setAttribute('href', savedIcon);
      savedIcon = null;
    }
  }

  function pauseMedia() {
    u.$$('video, audio').forEach(m => { try { m.pause(); } catch (e) {} });
  }

  /**
   * 切换遮蔽状态。同步执行，立即写入样式，保证「按下即生效」。
   */
  P.set = function (on, viaKey) {
    on = !!on;
    if (on === P.isOn()) { paintIndicator(); return on; }
    document.documentElement.classList.toggle('hs-panic', on);
    applyBlur(on);
    applyOverlay(on);
    if (on) { hideTitle(); pauseMedia(); }
    else restoreTitle();
    paintIndicator();
    if (on && viaKey) HS.settings._lastPanic = Date.now();
    return on;
  };

  P.toggle = function (viaKey) { return P.set(!P.isOn(), viaKey); };

  P.setKey = function (canon) {
    HS.settings.panicKey = canon;
    HS.store.save(HS.settings);
    paintIndicator();
    HS.bus.emit('panic:key', canon);
  };

  /* ---------------- 事件绑定 ---------------- */
  function inEditable(e) {
    const t = e.target;
    if (!t) return false;
    const tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable === true;
  }

  function onKeydown(e) {
    if (recording) return;
    if (e.repeat) return;
    const canon = P.canon(e);
    if (!canon || canon !== HS.settings.panicKey) return;
    /* 单键（无修饰符）在输入框中不触发，避免打字误伤 */
    if (!P.hasModifier(canon) && canon !== 'Escape' && inEditable(e)) return;
    e.preventDefault();
    e.stopPropagation();
    P.toggle(true);
  }

  /* ---------------- 快捷键录制器 ---------------- */
  /**
   * 把一个元素变成快捷键录制按钮。
   * @param {HTMLElement} el  显示当前的组合键
   * @param {HTMLElement} tip 可选的错误/提示元素
   */
  P.mountRecorder = function (el, tip) {
    function start() {
      recording = true;
      el.dataset.rec = '1';
      el.textContent = '请按组合键…（Esc 取消）';
      if (tip) tip.textContent = '';
    }
    function stop() {
      recording = false;
      el.dataset.rec = '0';
      el.textContent = P.label(HS.settings.panicKey, true);
    }
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.addEventListener('click', start);
    el.addEventListener('focus', start);
    el.addEventListener('blur', stop);
    el.addEventListener('keydown', ev => {
      if (!recording) return;
      ev.preventDefault();
      ev.stopPropagation();
      const canon = P.canon(ev);
      if (ev.key === 'Escape' && !canon) { el.blur(); return; }
      if (!canon) { el.textContent = '继续按…（如 X 或 F2）'; return; }
      if (canon === HS.settings.panicKey) { el.blur(); return; }
      P.setKey(canon);
      if (tip) {
        tip.textContent = P.hasModifier(canon)
          ? ''
          : '提示：单键组合在输入框内不会触发，避免打字误遮挡。';
      }
      el.blur();
    });
    stop();
    return { start, stop };
  };

  /* ---------------- 初始化 ---------------- */
  P.init = function () {
    app = u.$('#hs-app');
    overlay = u.$('#panic-overlay');
    indicator = u.$('#panic-indicator');
    indicatorState = u.$('#panic-indicator-state');
    hintEl = u.$('#panic-hint');
    bigIco = u.$('.hs-panic-ico');

    /* 捕获阶段监听，优先级最高，不受其它快捷键影响 */
    window.addEventListener('keydown', onKeydown, true);

    indicator.addEventListener('click', () => P.set(!P.isOn()));
    overlay.addEventListener('click', () => P.set(false));

    /* 切到后台自动遮蔽 */
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && HS.settings.panicAutoOnHide && !P.isOn()) P.set(true);
    });

    /* 初始样式（若刷新时残留 class） */
    if (P.isOn()) { applyBlur(true); applyOverlay(true); }
    else applyOverlay(false);
    paintIndicator();
  };

})(window.HS);
