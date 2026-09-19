/* ==========================================================================
   settings.js — 设置弹窗（声明式字段 → 自动持久化 → 广播 settings:change）
   ========================================================================== */
(function (HS) {
  'use strict';
  const u = HS.u;
  const S = HS.settingsUI = {};
  let modal, body, opener = null;

  const TABS = [
    { id: 'look',    label: '外观' },
    { id: 'search',  label: '搜索' },
    { id: 'privacy', label: '隐私与遮蔽' },
    { id: 'about',   label: '关于' }
  ];
  let active = 'look';
  const syncers = [];   // 打开弹窗时从 HS.settings 回填

  function set(key, val) {
    HS.settings[key] = val;
    HS.store.save(HS.settings);
    HS.bus.emit('settings:change', { key, val });
  }

  /* ---------------- 控件 ---------------- */
  function row(title, desc, control) {
    const r = u.el('div', { class: 'hs-set-row' });
    r.appendChild(u.el('div', {}, '<b>' + u.esc(title) + '</b>' + (desc ? '<i>' + u.esc(desc) + '</i>' : '')));
    r.appendChild(control);
    return r;
  }

  function group(title, rows) {
    const g = u.el('div', { class: 'hs-set-group' });
    if (title) g.appendChild(u.el('h3', {}, u.esc(title)));
    rows.forEach(r => g.appendChild(r));
    return g;
  }

  function switchEl(key, onChange) {
    const w = u.el('label', { class: 'hs-switch' });
    const input = u.el('input', { type: 'checkbox' });
    w.appendChild(input);
    w.appendChild(u.el('span'));
    input.addEventListener('change', () => { set(key, input.checked); if (onChange) onChange(input.checked); });
    syncers.push(() => { input.checked = !!HS.settings[key]; });
    return w;
  }

  function selectEl(key, opts, onChange) {
    const s = u.el('select', { class: 'hs-input hs-select' });
    opts.forEach(o => {
      const opt = u.el('option', { value: o.value }, u.esc(o.label));
      s.appendChild(opt);
    });
    s.addEventListener('change', () => { set(key, s.value); if (onChange) onChange(s.value); });
    syncers.push(() => { s.value = HS.settings[key]; });
    return s;
  }

  function numberEl(key, min, max, onChange) {
    const i = u.el('input', { class: 'hs-input', type: 'number', min: min, max: max, step: 1, style: 'width:110px' });
    i.addEventListener('change', () => {
      const v = u.clamp(parseInt(i.value, 10) || HS.DEFAULTS[key], min, max);
      i.value = v; set(key, v); if (onChange) onChange(v);
    });
    syncers.push(() => { i.value = HS.settings[key]; });
    return i;
  }

  function textEl(key, placeholder, onChange) {
    const i = u.el('input', { class: 'hs-input', type: 'text', placeholder: placeholder, style: 'min-width:280px;flex:1' });
    i.addEventListener('change', () => { set(key, i.value.trim()); if (onChange) onChange(i.value.trim()); });
    syncers.push(() => { i.value = HS.settings[key] || ''; });
    return i;
  }

  /* ---------------- 各标签页 ---------------- */
  function buildLook() {
    return [
      group('外观', [
        row('深色模式', '也可以直接点顶栏的月亮/太阳图标切换',
          selectEl('theme', [{ value: 'dark', label: '深色' }, { value: 'light', label: '浅色' }],
            v => HS.bus.emit('theme:set', v))),
        row('结果封面默认模糊', '悬停或点击封面才显示原图，避免误暴露',
          switchEl('blurCovers', v => HS.bus.emit('blurcovers:set', v))),
        row('动画强度', '「精简」关闭打字机效果，只保留状态变化；「关闭」全局禁用动效',
          selectEl('animLevel', [
            { value: 'full', label: '完整' },
            { value: 'lite', label: '精简' },
            { value: 'off', label: '关闭' }
          ], v => {
            document.documentElement.classList.toggle('hs-nomotion', v === 'off');
          }))
      ])
    ];
  }

  function buildSearch() {
    const proxyInput = u.el('input', {
      class: 'hs-input', type: 'text', placeholder: 'https://your-proxy/?url={url}', style: 'min-width:280px;flex:1'
    });
    const tip = u.el('i', {}, '');
    proxyInput.addEventListener('change', () => {
      set('proxy', proxyInput.value.trim());
      HS.net._cache = null;
      HS.bus.emit('proxy:change');
      if (HS.filtersUI) HS.filtersUI.syncAll();
      tip.textContent = HS.settings.proxy ? '已保存：' + HS.net.proxyName(HS.settings.proxy) : '已停用代理';
    });
    syncers.push(() => { proxyInput.value = HS.settings.proxy || ''; });

    const testBtn = u.el('button', { class: 'hs-btn hs-btn-ghost', type: 'button' }, '测试代理');
    testBtn.addEventListener('click', async () => {
      const p = proxyInput.value.trim();
      if (!p) { HS.toast('请先填写代理地址', 'warn'); return; }
      testBtn.disabled = true; testBtn.textContent = '测试中…';
      try {
        const r = await HS.net.testProxy(p);
        HS.toast('代理可用 · ' + u.fmtMs(r.ms) + ' · 响应 ' + r.body.slice(0, 20), 'ok', 3400);
        tip.textContent = '代理可用（' + u.fmtMs(r.ms) + '）';
      } catch (e) {
        HS.toast('代理不可用：' + e.message, 'err', 4000);
        tip.textContent = '代理不可用：' + e.message;
      } finally { testBtn.disabled = false; testBtn.textContent = '测试代理'; }
    });

    const proxyRow = u.el('div', { class: 'hs-proxyrow' });
    proxyRow.appendChild(proxyInput);
    proxyRow.appendChild(testBtn);
    const proxyBox = u.el('div', { style: 'display:grid;gap:6px;flex:1;min-width:280px' });
    proxyBox.appendChild(proxyRow);
    proxyBox.appendChild(tip);

    const gwTip = u.el('i', {}, HS.settings.picacgGateway ? '已配置' : '未配置：哔咔漫画源会直接报错并提示');
    const gwInput = textEl('picacgGateway', 'https://your-hibiapi.example', null);
    gwInput.addEventListener('change', () => {
      gwTip.textContent = HS.settings.picacgGateway ? '已保存；网关可用时「哔咔漫画」源即可工作' : '未配置：哔咔漫画源会直接报错并提示';
    });
    const gwBox = u.el('div', { style: 'display:grid;gap:6px;flex:1;min-width:280px' });
    gwBox.appendChild(gwInput);
    gwBox.appendChild(gwTip);

    /* 本地网关：禁漫官方 API / 拷贝漫画 / 哔咔 的签名与解密都在这里代劳 */
    const lgTip = u.el('i', { id: 'set-localgw-tip' }, '检测中…');
    const lgInput = textEl('gateway', 'http://127.0.0.1:8788', null);
    const lgTest = u.el('button', { class: 'hs-btn hs-btn-ghost', type: 'button' }, '检测');
    const lgSync = ok => {
      lgTip.textContent = ok
        ? '✓ 已连接 ' + HS.net.gateway.base + '（' + ((HS.net.gateway.info && HS.net.gateway.info.sources) || []).join(' / ') + '）'
        : '未检测到。在项目目录执行 node tools/gateway.js 后重新检测；用 http://127.0.0.1:8788/ 打开本页面可完全避开跨域';
      lgTest.dataset.on = ok ? '1' : '0';
    };
    lgTest.addEventListener('click', async () => {
      lgTip.textContent = '检测中…';
      lgInput.dispatchEvent(new Event('change'));
      lgSync(await HS.net.gateway.probe(true));
    });
    lgInput.addEventListener('change', () => {
      set('gateway', lgInput.value.trim());
    });
    syncers.push(() => {
      lgInput.value = HS.settings.gateway || '';
      lgSync(HS.net.gateway.ok);
    });
    HS.bus.on('net:gateway', d => lgSync(!!(d && d.ok)));
    const lgRow = u.el('div', { class: 'hs-proxyrow' });
    lgRow.appendChild(lgInput);
    lgRow.appendChild(lgTest);
    const lgBox = u.el('div', { style: 'display:grid;gap:6px;flex:1;min-width:280px' });
    lgBox.appendChild(lgRow);
    lgBox.appendChild(lgTip);

    return [
      group('请求行为', [
        row('每源结果数', '并行检索时每个信息源最多取回多少条', numberEl('perSource', 4, 40)),
        row('单源超时', '毫秒。超时即视为该源失败，不阻塞其它源', numberEl('timeoutMs', 3000, 30000))
      ]),
      group('本地网关（推荐）', [
        (function () {
          const r = u.el('div', { class: 'hs-set-row' });
          r.appendChild(u.el('div', {}, '<b>网关地址</b><i>禁漫天堂的官方 App API（实时域名 + md5 token + AES-ECB 解密）、拷贝漫画（HMAC 签名）、哔咔（HMAC-SHA256 签名 + 登录 token）都必须带自定义请求头，浏览器受同源策略限制发不出去 —— 这正是 jasmine / venera 这类项目全是原生客户端的原因。随附的 tools/gateway.js 是零依赖 Node 网关，把签名与解密放在本机</i>'));
          r.appendChild(lgBox);
          return r;
        })()
      ]),
      group('哔咔漫画（PicACG）自建网关', [
        (function () {
          const r = u.el('div', { class: 'hs-set-row' });
          r.appendChild(u.el('div', {}, '<b>网关地址</b><i>可选的备用通道：本地网关不可用时，回落到你自建的 HibiAPI 等网关</i>'));
          r.appendChild(gwBox);
          return r;
        })()
      ]),
      group('CORS 代理', [
        (function () {
          const r = u.el('div', { class: 'hs-set-row' });
          r.appendChild(u.el('div', {}, '<b>代理地址</b><i>浏览器直连受限的站点需要通过代理中转；公共代理能看到你的查询内容</i>'));
          r.appendChild(proxyBox);
          return r;
        })()
      ])
    ];
  }

  function buildPrivacy() {
    const rec = u.el('div', { class: 'hs-keyrec', id: 'set-panickey' });
    const tip = u.el('i', { class: 'hs-keyrec-err' }, '');
    const recBox = u.el('div', { style: 'display:grid;gap:5px;justify-items:end' });
    recBox.appendChild(rec);
    recBox.appendChild(tip);

    const clearBtn = u.el('button', { class: 'hs-btn hs-btn-ghost', type: 'button' }, '清除全部本地数据');
    clearBtn.addEventListener('click', () => {
      HS.store.clear();
      HS.toast('已清除本地设置，正在重载…', 'ok');
      setTimeout(() => location.reload(), 600);
    });

    const exportBtn = u.el('button', { class: 'hs-btn hs-btn-ghost', type: 'button' }, '导出设置');
    exportBtn.addEventListener('click', async () => {
      const json = JSON.stringify({ settings: HS.settings, filters: HS.filters }, null, 2);
      try { await navigator.clipboard.writeText(json); HS.toast('设置 JSON 已复制到剪贴板', 'ok', 3000); }
      catch (e) { HS.toast('复制失败', 'err'); }
    });

    return [
      group('遮蔽（尊严保护）', [
        row('遮蔽快捷键', '点击后按下你想要的组合键；支持单键（如 F2、Esc）', recBox),
        row('切到后台自动遮蔽', '标签页失去焦点时自动启用遮蔽', switchEl('panicAutoOnHide')),
        row('遮蔽时替换标题与图标', '把标签页标题改为「新标签页」，避免被瞥见', switchEl('panicHideTitle'))
      ]),
      group('数据', [
        row('本地数据', '所有设置只保存在本机 localStorage，不会上传任何服务器', (function () {
          const box = u.el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' });
          box.appendChild(exportBtn); box.appendChild(clearBtn); return box;
        })())
      ])
    ];
  }

  function buildAbout() {
    const d = u.el('div', { class: 'hs-about' });
    d.innerHTML =
      '<p><b>EroMeta v' + HS.VERSION + '</b> — 一个纯前端的成人向同人志元数据聚合搜索界面。</p>' +
      '<ul>' +
      '<li>不托管、不缓存、不代理任何图片或作品文件，只索引第三方站点公开的元数据。</li>' +
      '<li>所有筛选与查询都在浏览器内完成，不经过任何自建服务器。</li>' +
      '<li>需要经代理中转的源，其查询内容会被代理服务方看到；介意隐私请自建代理。</li>' +
      '<li>VPN 需要在浏览器之外自行开启，本页面只做检测与提醒。</li>' +
      '<li>请确认你已成年，且访问此类内容在你所在地区合法。版权归原作者所有，请支持正版。</li>' +
      '</ul>' +
      '<p style="color:var(--fg-3)">已注册信息源：' + HS.sources.REG.map(s => u.esc(s.name)).join(' / ') + '</p>';
    return [d];
  }

  const BUILDERS = { look: buildLook, search: buildSearch, privacy: buildPrivacy, about: buildAbout };

  /* ---------------- 渲染 ---------------- */
  function renderTabs() {
    const bar = u.$('.hs-modal-tabs', modal);
    bar.innerHTML = '';
    TABS.forEach(t => {
      const b = u.el('button', { class: 'hs-tab', type: 'button', role: 'tab', 'aria-selected': active === t.id ? 'true' : 'false' }, u.esc(t.label));
      b.addEventListener('click', () => { active = t.id; render(); });
      bar.appendChild(b);
    });
  }

  function render() {
    renderTabs();
    body.innerHTML = '';
    (BUILDERS[active]() || []).forEach(n => body.appendChild(n));
    syncers.forEach(f => f());
    if (active === 'privacy') {
      const rec = u.$('#set-panickey');
      const tip = rec && rec.parentNode ? u.$('.hs-keyrec-err', rec.parentNode) : null;
      if (rec) HS.panic.mountRecorder(rec, tip);
    }
    modal.querySelector('.hs-modal-body').scrollTop = 0;
  }

  /* ---------------- 开关弹窗 ---------------- */
  S.open = function (tab) {
    if (tab) active = tab;
    if (opener) opener.focus();
    modal.hidden = false;
    render();
  };
  S.close = function () {
    modal.hidden = true;
    if (opener && opener.focus) opener.focus();
    opener = null;
  };
  S.toggle = function () { if (modal.hidden) S.open(); else S.close(); };

  S.init = function () {
    modal = u.el('div', { class: 'hs-modal', id: 'settings-modal', hidden: true, role: 'dialog', 'aria-modal': 'true' });
    modal.innerHTML =
      '<div class="hs-modal-card" role="document">' +
      '<div class="hs-modal-head"><h2>设置</h2>' +
      '<button class="hs-icon-btn" type="button" data-close aria-label="关闭">' + HS.icon.close + '</button></div>' +
      '<div class="hs-modal-tabs" role="tablist"></div>' +
      '<div class="hs-modal-body"></div>' +
      '<div class="hs-modal-foot">' +
      '<span style="font-size:11.5px;color:var(--fg-3)">设置即时生效并保存在本机</span>' +
      '<span class="hs-spacer"></span>' +
      '<button class="hs-btn hs-btn-text" type="button" data-close>关闭</button>' +
      '</div></div>';
    document.body.appendChild(modal);
    body = u.$('.hs-modal-body', modal);

    u.$$('[data-close]', modal).forEach(b => b.addEventListener('click', () => S.close()));
    modal.addEventListener('click', e => { if (e.target === modal) S.close(); });

    u.$('#settings-btn').addEventListener('click', e => { opener = e.currentTarget; S.open(); });
    u.$('#foot-settings').addEventListener('click', e => { opener = e.currentTarget; S.open(); });

    /* 全局 Esc 关闭（若遮蔽键为 Esc，则由 panic 的捕获阶段优先处理） */
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !modal.hidden) { e.stopPropagation(); S.close(); }
    });
  };

})(window.HS);
