/* ==========================================================================
   _tmp_shim.js — 只在本地验证脚本里用：把 core.js / dict.js / sources.js
   这三个「传统 <script>」原样装进一个最小浏览器环境里跑（零依赖，用 node:vm）。
   它不参与站点运行，也不改任何站点文件。
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

function stub(name) {
  const t = function () { return stub(name + '()'); };
  return new Proxy(t, {
    get(_, k) {
      if (k === 'then') return undefined;
      if (k === 'toString') return () => name;
      if (k === 'length') return 0;
      return stub(name + '.' + String(k));
    },
    set() { return true; },
    apply() { return stub(name + '()'); }
  });
}

function makeEnv() {
  const storeMap = new Map();
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.console = console;
  sandbox.navigator = { platform: 'Win32', userAgent: 'node-harness', language: 'zh-CN' };
  sandbox.location = {
    href: 'http://127.0.0.1:8788/', origin: 'http://127.0.0.1:8788',
    protocol: 'http:', hostname: '127.0.0.1', port: '8788', pathname: '/', search: '', hash: ''
  };
  sandbox.localStorage = {
    getItem: k => (storeMap.has(String(k)) ? storeMap.get(String(k)) : null),
    setItem: (k, v) => { storeMap.set(String(k), String(v)); },
    removeItem: k => { storeMap.delete(String(k)); },
    clear: () => storeMap.clear(),
    key: i => Array.from(storeMap.keys())[i] || null,
    get length() { return storeMap.size; }
  };
  sandbox.sessionStorage = sandbox.localStorage;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.setInterval = setInterval;
  sandbox.clearInterval = clearInterval;
  sandbox.requestAnimationFrame = cb => setTimeout(() => cb(0), 0);
  sandbox.cancelAnimationFrame = () => {};
  sandbox.requestIdleCallback = cb => setTimeout(() => cb({ didTimeout: false }), 0);
  sandbox.URL = URL;
  sandbox.URLSearchParams = URLSearchParams;
  sandbox.DOMException = DOMException;
  sandbox.TextEncoder = TextEncoder;
  sandbox.TextDecoder = TextDecoder;
  sandbox.AbortController = AbortController;
  sandbox.fetch = () => Promise.reject(new Error('harness: fetch 已禁用'));
  sandbox.document = stub('document');
  sandbox.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.getComputedStyle = () => stub('style');
  vm.createContext(sandbox);
  return sandbox;
}

/** 依次加载真实站点脚本（顺序与 index.html 一致：core → dict → sources） */
function loadSite(files) {
  const env = makeEnv();
  /* 与 index.html 的实际顺序一致（net.js 必须在 sources.js 之前） */
  const list = files || ['assets/js/core.js', 'assets/js/dict.js', 'assets/js/net.js', 'assets/js/sources.js'];
  list.forEach(rel => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(src, env, { filename: rel });
  });
  return env;
}

/** 记录式假网络：抓住适配器真正拼出来的 URL，不真的发请求 */
function installNetworkSpy(HS) {
  const calls = [];
  const snap = {};
  if (HS.net) {
    snap.fetchSource = HS.net.fetchSource;
    snap.gwGet = HS.net.gateway && HS.net.gateway.get;
    snap.gwUrl = HS.net.gateway && HS.net.gateway.url;
    HS.net.fetchSource = async function (url, o) {
      calls.push({ via: 'fetchSource', url: String(url) });
      throw new Error('spy: fetchSource 已拦截');
    };
    if (HS.net.gateway) {
      HS.net.gateway.get = async function (p, params) {
        const qs = params ? new URLSearchParams(params).toString() : '';
        calls.push({ via: 'gateway', url: p + (qs ? '?' + qs : '') });
        throw new Error('spy: gateway 已拦截');
      };
      if (typeof HS.net.gateway.url === 'function') {
        HS.net.gateway.url = function (p, params) {
          const qs = params ? new URLSearchParams(params).toString() : '';
          return p + (qs ? '?' + qs : '');
        };
      }
    }
  }
  return { calls, restore() { if (HS.net) { HS.net.fetchSource = snap.fetchSource; if (HS.net.gateway) { HS.net.gateway.get = snap.gwGet; HS.net.gateway.url = snap.gwUrl; } } } };
}

module.exports = { ROOT, loadSite, installNetworkSpy, makeEnv };
