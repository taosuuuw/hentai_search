/* tools/relay-setup.js —— 自建中继「一次性设置」的状态机与工具（第 12 轮）
 *
 * 为什么需要它：
 *   e-hentai / pixiv 在本机出口无任何通路（含全部公共中继），只能自建一台墙外中继。
 *   但「部署中继」是一次性事件：做完一次，之后每次启动都不该再问。
 *   于是需要一个可靠的「状态」判据，而不是靠启动脚本每次猜。
 *
 * 它管两个文件（都在 .gitignore 里，绝不入库）：
 *   · tools/relay.txt           —— 网关读的配置：每行「地址[ 空格或| ]key」，# 为注释
 *   · tools/.relay-setup.json   —— 本机的设置状态（**绝不写 key**）
 *
 * 状态机（见 decide()）：
 *   relay.txt 里有可用条目          → silent（已配置，永远不再问）
 *   状态 skipped                    → silent（用户明确说过「不再提醒」）
 *   状态 configured 但 relay.txt 没了 → prompt（drift：配置丢了，重新问）
 *   状态 deferred                   → 交互式才重问；自动/非交互式静默跳过
 *   其余（未设置 / 状态损坏）        → 交互式问，非交互式静默跳过并记 deferred
 *
 * 用法（PowerShell 向导 tools/relay-setup.ps1 会调它；也可单独用）：
 *   node tools/relay-setup.js --status --interactive=1
 *   node tools/relay-setup.js --set-relay=https://x.pages.dev --key=abc --method=manual
 *   node tools/relay-setup.js --mark=deferred|skipped
 *   node tools/relay-setup.js --gen-key
 *   node tools/relay-setup.js --verify
 *   node tools/relay-setup.js --probe-hosting
 *   node tools/relay-setup.js --reset [--remove-relay]
 * 可选：--state=<路径> --relay-file=<路径>
 *
 * 零依赖，CommonJS。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_VERSION = 1;
const ROOT = path.resolve(__dirname, '..');
const DEFAULTS = {
  state: path.join(__dirname, '.relay-setup.json'),
  relayFile: path.join(__dirname, 'relay.txt')
};
const STATUSES = ['unset', 'deferred', 'skipped', 'configured'];
/* 验真 key 用的靶子：要**又快又稳又几乎不会被封**，而且必须走中继的代理腿（不是 /__hs/ping，
   那个端点按设计不需要 key）。mangadex 的 /ping 实测经中继 200/4B「pong」，是这里最合适的靶子。 */
const KEY_PROBE_URL = 'https://api.mangadex.org/ping';

/* ---------------- 纯函数（可被 tools/relay-check.js 直接断言） ---------------- */

/** 中继地址是否可用：http/https + 有主机名 + 无空白。本机地址算「本地中继」（能自测，但救不了被墙的站）。 */
function isValidRelayUrl(u) {
  if (typeof u !== 'string') return false;
  const s = u.trim();
  if (!s || /\s/.test(s)) return false;
  let parsed;
  try { parsed = new URL(s); } catch (e) { return false; }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  if (!parsed.hostname) return false;
  return true;
}

function isLocalRelayUrl(u) {
  try {
    const h = new URL(String(u).trim()).hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]' || h.endsWith('.local');
  } catch (e) { return false; }
}

/** 解析网关配置里的一行；空行与 # 注释返回 null。 */
function parseRelayLine(line) {
  if (typeof line !== 'string') return null;
  const s = line.trim();
  if (!s || s.startsWith('#')) return null;
  const m = s.split(/\s*\|\s*|\s+/);
  const url = m[0].trim();
  if (!isValidRelayUrl(url)) return null;
  const key = m.length > 1 ? m.slice(1).join(' ').trim().replace(/^["']|["']$/g, '') : '';
  return { url, key };
}

function readRelayFile(file) {
  const p = file || DEFAULTS.relayFile;
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return { exists: false, file: p, entries: [], url: '', key: '' }; }
  const entries = [];
  for (const line of text.split(/\r?\n/)) {
    const e = parseRelayLine(line);
    if (e) entries.push(e);
  }
  const first = entries[0] || { url: '', key: '' };
  return { exists: true, file: p, entries, url: first.url, key: first.key };
}

function formatRelayLine(url, key) {
  const u = String(url).trim();
  const k = (key == null ? '' : String(key)).trim();
  return k ? u + ' ' + k : u;
}

/** 写 tools/relay.txt（覆盖）。key 为空则只写地址，并在 note 里提醒中继是敞开的。 */
function writeRelayFile(file, url, key) {
  const p = file || DEFAULTS.relayFile;
  if (!isValidRelayUrl(url)) throw new Error('中继地址不合法（要 http/https 开头且不含空格）：' + url);
  const k = (key == null ? '' : String(key)).trim();
  const body = [
    '# 自建中继（由 tools/relay-setup.ps1 一次性向导写入；本文件含 key，已在 .gitignore 中，绝不入库）',
    '# 格式：地址[ 空格或 | ]key    改完要重启网关：tools\\start-gateway.ps1',
    formatRelayLine(url, k)
  ].join('\n') + '\n';
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, 'utf8');
  return { file: p, url, keyPresent: !!k, line: formatRelayLine(url, k) };
}

function genKey(len) {
  const n = Math.max(12, Math.min(96, parseInt(len, 10) || 32));
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** 状态文件读：坏文件/坏版本一律当 unset（并保留 raw 以便诊断）。 */
function readState(file) {
  const p = file || DEFAULTS.state;
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {
    return { file: p, exists: fs.existsSync(p), corrupt: fs.existsSync(p), version: STATE_VERSION, status: 'unset', at: '', method: '', url: '' };
  }
  const status = STATUSES.indexOf(raw && raw.status) >= 0 && raw.status !== 'unset' ? raw.status : 'unset';
  const version = (raw && raw.version) || STATE_VERSION;
  return {
    file: p, exists: true, corrupt: false, version,
    status: version === STATE_VERSION ? status : 'unset',
    at: (raw && raw.at) || '', method: (raw && raw.method) || '', url: (raw && raw.url) || ''
  };
}

/** 状态文件写：**只允许这几个字段**，key 永远不落这里。 */
function writeState(file, patch) {
  const p = file || DEFAULTS.state;
  const cur = readState(p);
  const next = {
    version: STATE_VERSION,
    status: STATUSES.indexOf(patch && patch.status) >= 0 ? patch.status : cur.status,
    at: new Date().toISOString(),
    method: (patch && patch.method) || cur.method || '',
    url: (patch && patch.url) || cur.url || '',
    note: (patch && patch.note) || ''
  };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

/**
 * 启动时该不该弹向导。
 * @returns {{action:'prompt'|'silent', reason:string, detail:string}}
 */
function decide(opts) {
  const o = opts || {};
  const relayOk = !!o.relayConfigured;
  const status = (o.state && o.state.status) || 'unset';
  const interactive = !!o.interactive;
  if (o.force) return { action: 'prompt', reason: 'forced', detail: '用户显式要求重跑向导' };
  if (relayOk) return { action: 'silent', reason: 'relay-configured', detail: '中继已配置，这一步是一次性的，不再询问' };
  if (status === 'skipped') return { action: 'silent', reason: 'state-skipped', detail: '用户选择过「不再提醒」' };
  if (status === 'configured') return { action: 'prompt', reason: 'drift-config-missing', detail: '上次配置过中继，但现在找不到配置文件了' };
  if (status === 'deferred') return interactive
    ? { action: 'prompt', reason: 'deferred-reask', detail: '上次选了「稍后再说」' }
    : { action: 'silent', reason: 'deferred-auto', detail: '非交互式启动，不打断' };
  return interactive
    ? { action: 'prompt', reason: 'first-run', detail: '还没配置过中继' }
    : { action: 'silent', reason: 'first-run-auto', detail: '非交互式启动，不打断（下次交互式启动会问）' };
}

/* ---------------- 运行期小工具 ---------------- */

function fetchWithTimeout(url, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms || 10000);
  return fetch(url, {
    signal: ac.signal, redirect: 'follow',
    headers: { 'User-Agent': 'hs-relay-setup/1.0', Accept: '*/*' }
  }).finally(() => clearTimeout(timer));
}

async function verifyRelay(url, key, ms) {
  const base = String(url).trim().replace(/\/+$/, '');
  const target = base + '/__hs/ping?ip=1';
  const t0 = Date.now();
  try {
    const r = await fetchWithTimeout(target, ms || 12000);
    let j = null; let text = '';
    try { text = await r.text(); } catch (e) { }
    try { j = JSON.parse(text); } catch (e) { }
    const out = {
      ok: r.status === 200 && !!j && j.ok !== false,
      status: r.status, ms: Date.now() - t0,
      relay: (j && j.relay) || '', version: (j && j.version) || '',
      keyRequired: j ? !!j.keyRequired : null,
      /* ★key 没生效就得说话★：写了 key 而中继报 keyRequired:false ⇒ Secret 没生效
         （Cloudflare Pages 的 Secret 只对**之后的新部署**生效，2026-09-23 实测过一次：
          第一次部署之后 secret put，ping 仍是 keyRequired:false，重新部署才变 true）。 */
      keyIgnored: !!key && !!j && !j.keyRequired,
      warn: (!!key && !!j && !j.keyRequired)
        ? '中继说 keyRequired:false：你给了 key 但它没生效。Pages 的 Secret 只对之后的新部署生效 —— 重新部署一次（wrangler pages deploy …）再验证；否则中继对任何知道地址的人开放。'
        : '',
      egressIp: (j && j.egressIp) || '', egressIpError: (j && j.egressIpError) || '',
      keySent: !!key,
      body: text.slice(0, 300)
    };
    /* ★key 必须**真的能用**才算过★（2026-09-23 实测的坑）：`/__hs/ping` 按设计**不需要 key**，
       所以它永远证明不了 key 对不对。当天真发生了一次：向导用 `$key | & npx … pages secret put`
       把 key 写进 CF，secret put 报 Success、ping 也报 keyRequired:true，但用这个 key 打中继
       一律 403 —— 只 ping 的验证完全发现不了，向导于是把一份**用不了的 key** 写进 relay.txt。
       所以：中继说需要 key 且调用方给了 key 时，再打一次**带 key 的代理请求**验真。 */
    if (key && out.keyRequired) {
      const t0k = Date.now();
      try {
        const rk = await fetchWithTimeout(base + '/?url=' + encodeURIComponent(KEY_PROBE_URL) + '&k=' + encodeURIComponent(key), ms || 12000);
        const bk = await rk.text();
        out.keyOk = rk.status === 200;
        out.keyStatus = rk.status;
        out.keyMs = Date.now() - t0k;
        out.keyBody = bk.slice(0, 120);
        if (!out.keyOk) {
          out.ok = false;
          out.warn = 'key 不对：中继对带这个 key 的代理请求回了 HTTP ' + rk.status + '（正文：' +
            bk.slice(0, 80).replace(/\s+/g, ' ') + '）—— 重新设一次 Secret 再部署，或换一个 key。';
        }
      } catch (e) {
        out.keyOk = false; out.ok = false;
        out.keyMs = Date.now() - t0k;
        out.warn = 'key 验真没打通：' + ((e && e.message) || String(e));
      }
    } else if (key) {
      out.keyOk = null; /* 中继不需要 key ⇒ 由 keyIgnored 那条 warn 负责说话 */
    }
    return out;
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, err: (e && e.message) || String(e), cause: (e && e.cause && (e.cause.code || e.cause.message)) || '' };
  }
}

/** 部署面自检：本机能不能拿到 wrangler（npm 源）、能不能登录 Cloudflare。 */
async function probeHosting(ms) {
  const targets = [
    { id: 'npm-registry', url: 'https://registry.npmjs.org/wrangler', need: 'npx wrangler 要先从 npm 源下载' },
    { id: 'npm-mirror', url: 'https://registry.npmmirror.com/wrangler', need: '国内镜像（npm 源不通时备选）' },
    { id: 'cf-dashboard', url: 'https://dash.cloudflare.com/', need: '浏览器里登录 Cloudflare' },
    { id: 'cf-api', url: 'https://api.cloudflare.com/client/v4/', need: 'wrangler 调 CF API' },
    { id: 'pages-apex', url: 'https://pages.dev/', need: '中继网址将来要能被网关取到' }
  ];
  const out = [];
  for (const t of targets) {
    const t0 = Date.now();
    let rec = { id: t.id, url: t.url, need: t.need, ok: false, status: 0, ms: 0, err: '' };
    try {
      const r = await fetchWithTimeout(t.url, ms || 10000);
      rec.status = r.status;
      rec.ok = r.status > 0 && r.status < 500;
      try { await r.arrayBuffer(); } catch (e) { }
    } catch (e) {
      rec.err = (e && e.message) || String(e);
      rec.cause = (e && e.cause && (e.cause.code || e.cause.message)) || '';
    }
    rec.ms = Date.now() - t0;
    out.push(rec);
  }
  return out;
}

/* ---------------- CLI ---------------- */

function argValue(name) {
  const pre = '--' + name + '=';
  for (const a of process.argv.slice(2)) if (a.startsWith(pre)) return a.slice(pre.length);
  return null;
}
function hasFlag(name) { return process.argv.slice(2).indexOf('--' + name) >= 0; }

function paths() {
  return {
    state: argValue('state') || process.env.HS_RELAY_STATE || DEFAULTS.state,
    relayFile: argValue('relay-file') || process.env.HS_RELAY_FILE || DEFAULTS.relayFile
  };
}

function relayConfiguredFromEnv() {
  const raw = (process.env.HS_GW_RELAY || '').trim();
  if (!raw) return false;
  return raw.split(',').some((s) => isValidRelayUrl(s.split('|')[0]));
}

async function main() {
  const P = paths();
  const relay = readRelayFile(P.relayFile);
  const state = readState(P.state);
  const envRelay = relayConfiguredFromEnv();
  const relayConfigured = relay.entries.length > 0 || envRelay;

  if (hasFlag('status')) {
    const interactive = argValue('interactive') === '1';
    const d = decide({ relayConfigured, state, interactive, force: hasFlag('force') });
    process.stdout.write(JSON.stringify({
      ok: true,
      relayConfigured,
      relayUrl: relay.url || '',
      relayFromEnv: envRelay,
      relayKeyPresent: !!relay.key,
      relayEntries: relay.entries.length,
      relayFile: P.relayFile,
      relayFileExists: relay.exists,
      stateFile: P.state,
      state: { status: state.status, version: state.version, at: state.at, method: state.method, url: state.url, corrupt: !!state.corrupt },
      interactive,
      decision: d
    }, null, 2) + '\n');
    return 0;
  }

  if (hasFlag('probe-hosting')) {
    const res = await probeHosting(parseInt(argValue('ms'), 10) || 10000);
    process.stdout.write(JSON.stringify({ ok: res.every((r) => r.ok), targets: res }, null, 2) + '\n');
    return res.every((r) => r.ok) ? 0 : 3;
  }

  if (hasFlag('gen-key')) {
    process.stdout.write(genKey(argValue('key-len')) + '\n');
    return 0;
  }

  if (hasFlag('verify')) {
    if (!relay.url) { process.stdout.write(JSON.stringify({ ok: false, err: '还没有配置中继（缺 ' + P.relayFile + '）' }, null, 2) + '\n'); return 1; }
    const key = argValue('key') != null ? argValue('key') : relay.key;
    const res = await verifyRelay(argValue('url') || relay.url, key, parseInt(argValue('ms'), 10) || 12000);
    process.stdout.write(JSON.stringify(res, null, 2) + '\n');
    return res.ok ? 0 : 1;
  }

  if (argValue('set-relay') != null) {
    const url = String(argValue('set-relay')).trim();
    const key = (argValue('key') || '').trim();
    const method = argValue('method') || 'manual';
    if (!isValidRelayUrl(url)) {
      process.stdout.write(JSON.stringify({ ok: false, err: '中继地址不合法：' + url + '（要 http/https 开头、不含空格）' }, null, 2) + '\n');
      return 1;
    }
    const w = writeRelayFile(P.relayFile, url, key);
    const st = writeState(P.state, { status: 'configured', method, url, note: key ? '' : '无 key（中继对任何知道地址的人开放，建议补上）' });
    process.stdout.write(JSON.stringify({ ok: true, wrote: w, state: st, local: isLocalRelayUrl(url) }, null, 2) + '\n');
    return 0;
  }

  if (argValue('mark') != null) {
    const status = String(argValue('mark')).trim();
    if (STATUSES.indexOf(status) < 0 || status === 'unset') {
      process.stdout.write(JSON.stringify({ ok: false, err: 'mark 只能是 configured / deferred / skipped' }, null, 2) + '\n');
      return 1;
    }
    const st = writeState(P.state, { status, method: argValue('method') || '', url: argValue('url') || '', note: argValue('note') || '' });
    process.stdout.write(JSON.stringify({ ok: true, state: st }, null, 2) + '\n');
    return 0;
  }

  if (hasFlag('reset')) {
    const removed = [];
    try { fs.unlinkSync(P.state); removed.push(P.state); } catch (e) { }
    if (hasFlag('remove-relay')) { try { fs.unlinkSync(P.relayFile); removed.push(P.relayFile); } catch (e) { } }
    process.stdout.write(JSON.stringify({ ok: true, removed, note: hasFlag('remove-relay') ? '' : 'relay.txt 保留（只清了设置状态，下次启动会重新问）' }, null, 2) + '\n');
    return 0;
  }

  process.stdout.write([
    'tools/relay-setup.js —— 自建中继一次性设置的判据与落盘（给 tools/relay-setup.ps1 用）',
    '',
    '  --status [--interactive=1]      输出状态与「该不该弹向导」的判定（JSON）',
    '  --set-relay=<url> [--key=<k>]   写入 tools/relay.txt 并标记 configured',
    '  --mark=deferred|skipped         只改设置状态',
    '  --gen-key [--key-len=32]        生成一个中继 key',
    '  --verify [--url=] [--key=]      打 <中继>/__hs/ping?ip=1 验证',
    '  --probe-hosting                 检查 npm 源 / Cloudflare 是否可达（自动部署的前置条件）',
    '  --reset [--remove-relay]        清除设置状态（便于重新走一遍向导）',
    '',
    '可选：--state=<路径> --relay-file=<路径>'
  ].join('\n') + '\n');
  return 0;
}

module.exports = {
  STATE_VERSION, STATUSES, DEFAULTS,
  isValidRelayUrl, isLocalRelayUrl, parseRelayLine, formatRelayLine,
  readRelayFile, writeRelayFile, readState, writeState, decide,
  genKey, verifyRelay, probeHosting, relayConfiguredFromEnv
};

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((e) => {
    process.stderr.write('relay-setup 出错：' + ((e && e.stack) || e) + '\n');
    process.exit(1);
  });
}
