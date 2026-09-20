/* ==========================================================================
   settings.js — 设置弹窗（声明式字段 → 自动持久化 → 广播 settings:change）
   ========================================================================== */
(function (HS) {
  'use strict';
  const u = HS.u;
  const S = HS.settingsUI = {};
  let modal, body, opener = null;

  const TABS = [
    { id: 'look',    label: '外观',        icon: HS.icon.palette },
    { id: 'search',  label: '搜索',        icon: HS.icon.search },
    { id: 'privacy', label: '隐私与遮蔽',  icon: HS.icon.shield },
    { id: 'about',   label: '关于',        icon: HS.icon.info }
  ];
  let active = 'look';
  const syncers = [];   // 打开弹窗时从 HS.settings 回填

  function set(key, val) {
    HS.settings[key] = val;
    HS.store.save(HS.settings);
    HS.bus.emit('settings:change', { key, val });
  }

  /* ---------------- 控件 ---------------- */
  /** 设置行：左侧「图标 + 标题 + 说明」，右侧控件 */
  function row(title, desc, control, icon) {
    const r = u.el('div', { class: 'hs-set-row' });
    const label = u.el('div', { class: 'hs-set-label' });
    if (icon) label.appendChild(u.el('span', { class: 'hs-set-ico', 'aria-hidden': 'true' }, icon));
    label.appendChild(u.el('div', { class: 'hs-set-txt' },
      '<b>' + u.esc(title) + '</b>' + (desc ? '<i>' + u.esc(desc) + '</i>' : '')));
    r.appendChild(label);
    r.appendChild(control);
    return r;
  }

  /** 同上，但右侧放一个自定义控件盒（多行输入 + 提示那种） */
  function rowBox(title, desc, icon, box) {
    const r = u.el('div', { class: 'hs-set-row' });
    const label = u.el('div', { class: 'hs-set-label' });
    if (icon) label.appendChild(u.el('span', { class: 'hs-set-ico', 'aria-hidden': 'true' }, icon));
    label.appendChild(u.el('div', { class: 'hs-set-txt' },
      '<b>' + u.esc(title) + '</b><i>' + u.esc(desc) + '</i>'));
    r.appendChild(label);
    r.appendChild(box);
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
            v => HS.bus.emit('theme:set', v)), HS.icon.moon),
        row('检索结果初始模糊', '打开后**所有**作品的封面与角标都先糊上，悬停或点「点击显示」才露出。想排除猎奇 / R18G 与 AI 作品请用筛选面板里的两个开关',
          switchEl('blurCovers', v => HS.bus.emit('blurcovers:set', v)), HS.icon.image),
        row('动画强度', '「精简」关闭打字机效果，只保留状态变化；「关闭」全局禁用动效',
          selectEl('animLevel', [
            { value: 'full', label: '完整' },
            { value: 'lite', label: '精简' },
            { value: 'off', label: '关闭' }
          ], v => {
            document.documentElement.classList.toggle('hs-nomotion', v === 'off');
          }), HS.icon.zap)
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

    /* Pixiv：官方搜索接口经本地网关代取（i.pximg.net 有防盗链）。
       R-18 必须用你自己登录后的 PHPSESSID；不填时 pixiv 会把 r18 静默回落成全年龄，
       所以网关是按数据本身的 xRestrict / R-18 标签打标，不会把全年龄条目误标成 R-18。 */
    const pxMode = selectEl('pixivMode', [
      { value: 'all', label: '全年龄' },
      { value: 'r18', label: 'R-18（需 cookie）' }
    ], null);
    const pxCookie = u.el('input', {
      class: 'hs-input', type: 'password', placeholder: 'PHPSESSID=xxxx（可选）',
      autocomplete: 'off', style: 'min-width:260px;flex:1'
    });
    pxCookie.value = HS.settings.pixivCookie || '';
    pxCookie.addEventListener('change', () => set('pixivCookie', pxCookie.value.trim()));
    const pxTip = u.el('i', {}, 'cookie 只存在本机 localStorage；R-18 检索请自行确认已登录且内容合法');
    const pxRow = u.el('div', { class: 'hs-proxyrow' });
    pxRow.appendChild(pxMode);
    pxRow.appendChild(pxCookie);
    const pxBox = u.el('div', { style: 'display:grid;gap:6px;flex:1;min-width:280px' });
    pxBox.appendChild(pxRow);
    pxBox.appendChild(pxTip);

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
        row('每源结果数', '并行检索时每个信息源最多取回多少条', numberEl('perSource', 4, 40), HS.icon.layers),
        row('单源超时', '毫秒。超时即视为该源失败，不阻塞其它源', numberEl('timeoutMs', 3000, 30000), HS.icon.clock),
        row('每批加载数量', '结果单页展示，向下滚动到底时每次追加这么多张', numberEl('pageSize', 12, 200), HS.icon.sliders)
      ]),
      group('本地网关（推荐）', [
        rowBox('网关地址',
          '禁漫天堂的官方 App API（实时域名 + md5 token + AES-ECB 解密）、拷贝漫画（HMAC 签名）、哔咔（HMAC-SHA256 签名 + 登录 token）都必须带自定义请求头，浏览器受同源策略限制发不出去 —— 这正是 jasmine / venera 这类项目全是原生客户端的原因。随附的 tools/gateway.js 是零依赖 Node 网关，把签名与解密放在本机',
          HS.icon.plug, lgBox)
      ]),
      group('Pixiv', [
        rowBox('检索模式 / 登录 cookie',
          '官方搜索接口经本地网关代取（i.pximg.net 防盗链）。R-18 必须填你自己登录后的 PHPSESSID；不填时 pixiv 会把 r18 静默回落成全年龄，网关按数据本身打标，不会误标成 R-18。记得在筛选面板的「信息源」里把 Pixiv 勾上',
          HS.icon.image, pxBox)
      ]),
      group('CORS 代理', [
        rowBox('代理地址', '浏览器直连受限的站点需要通过代理中转；公共代理能看到你的查询内容',
          HS.icon.globe, proxyBox)
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
        row('遮蔽快捷键', '点击后按下你想要的组合键；支持单键（如 F2、Esc）', recBox, HS.icon.keyboard),
        row('切到后台自动遮蔽', '标签页失去焦点时自动启用遮蔽', switchEl('panicAutoOnHide'), HS.icon.eyeoff),
        row('遮蔽时替换标题与图标', '把标签页标题改为「新标签页」，避免被瞥见', switchEl('panicHideTitle'), HS.icon.tag)
      ]),
      group('数据', [
        row('本地数据', '所有设置只保存在本机 localStorage，不会上传任何服务器', (function () {
          const box = u.el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' });
          box.appendChild(exportBtn); box.appendChild(clearBtn); return box;
        })(), HS.icon.database)
      ])
    ];
  }

  function buildAbout() {
    const d = u.el('div', { class: 'hs-about' });
    d.innerHTML =
      '<p><b>hentai搜索 v' + HS.VERSION + '</b> — 一个纯前端的成人向同人志元数据聚合搜索界面。</p>' +
      '<ul>' +
      '<li>不托管、不缓存、不代理任何图片或作品文件，只索引第三方站点公开的元数据。</li>' +
      '<li>所有结果都在同一面：先铺一批，向下滚动继续追加，没有上一页 / 下一页。</li>' +
      '<li>检索会先判断查询意图（作品名 / IP 角色 / 体裁题材），再决定按标题还是按标签去查。</li>' +
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
      const b = u.el('button', {
        class: 'hs-tab', type: 'button', role: 'tab',
        'aria-selected': active === t.id ? 'true' : 'false'
      }, (t.icon ? '<span class="hs-tab-ico" aria-hidden="true">' + t.icon + '</span>' : '') + u.esc(t.label));
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
    /* 页脚（右下角）那枚「关闭」按钮已按需求移除：面板现在只有页头那一枚
       hs-icon-btn[data-close]，它的点击绑定仍是下面那条按选择器批量绑定的语句。
       页脚本身保留：它承担底部分隔线与下内边距，一起删会让面板内容贴底。 */
    modal.innerHTML =
      '<div class="hs-modal-card" role="document">' +
      '<div class="hs-modal-head"><span class="hs-head-ico" aria-hidden="true">' + HS.icon.gear + '</span><h2>设置</h2>' +
      '<button class="hs-icon-btn" type="button" data-close aria-label="关闭">' + HS.icon.close + '</button></div>' +
      '<div class="hs-modal-tabs" role="tablist"></div>' +
      '<div class="hs-modal-body"></div>' +
      '<div class="hs-modal-foot">' +
      '<span style="font-size:11.5px;color:var(--fg-3)">设置即时生效并保存在本机</span>' +
      '</div></div>';
    document.body.appendChild(modal);
    body = u.$('.hs-modal-body', modal);

    u.$$('[data-close]', modal).forEach(b => b.addEventListener('click', () => S.close()));
    modal.addEventListener('click', e => { if (e.target === modal) S.close(); });

    /* 顶栏那个齿轮按钮之前是**空的**（只有主题按钮会被注入图标），所以看起来"没有图标"。
       这里补上图标 + 文字标签，页脚那个也补图标。 */
    const sbBtn = u.$('#settings-btn');
    if (sbBtn) {
      if (!sbBtn.querySelector('svg')) sbBtn.innerHTML = HS.icon.gear + '<span>设置</span>';
      sbBtn.classList.add('hs-icon-btn-label');
    }
    /* 页脚那枚「设置」按钮已按用户要求移除；顶部栏的 #settings-btn 仍在，设置依然可达 */
    u.$('#settings-btn').addEventListener('click', e => { opener = e.currentTarget; S.open(); });

    /* 全局 Esc 关闭（若遮蔽键为 Esc，则由 panic 的捕获阶段优先处理） */
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !modal.hidden) { e.stopPropagation(); S.close(); }
    });
  };

})(window.HS);
