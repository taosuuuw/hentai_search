'use strict';
/* ==========================================================================
   tools/live-probe.js —— 零依赖真机探针（Chrome headless + CDP over Node 内置 WebSocket）
   --------------------------------------------------------------------------
   为什么要有它：本项目有一批**只能靠真机**才能判定的问题（图片是不是真取回来了、
   拖拽/缩放有没有位移、角标到底看不看得见、光的走向对不对），而 agent 会话里的
   browser_* 工具不一定在。这个脚本只依赖三样都在的东西：
     · Chrome 可执行文件（默认 C:\Program Files\Google\Chrome\Application\chrome.exe，
       可用环境变量 HS_CHROME 覆盖）
     · Node ≥ 22 的内置 WebSocket / fetch（本机 v24.21.0 已确认）
     · 本机网关（默认 http://127.0.0.1:8788/）

   用法：
     node tools/live-probe.js --eval "document.title"
     node tools/live-probe.js --eval "HS.recent.count()" --wait=2500
     node tools/live-probe.js --file=probe.js --shot=.tmp/shot.png
     node tools/live-probe.js --steps=steps.js      # Node 侧步骤：真鼠标事件 + 重载
     node tools/live-probe.js --eval "..." --keep      # 不杀 Chrome（排障）

   参数：
     --url=…       打开哪个地址（默认 http://127.0.0.1:8788/）
     --eval=…      载入后执行的 JS 表达式；**必须返回可 JSON 序列化的值**
     --file=…      JS 文件（与 --eval 二选一，写多行脚本用这个）
     --steps=…     Node 侧步骤脚本，module.exports = async ({cdp,evaluate,shot,reload,mouse,sleep,log}) => 结果
                   （真鼠标事件在 mouse.move/down/up，用于复现拖拽；页面内脚本做不到）
     --wait=ms     载入完成后再等多久（默认 800；网关聚合检索要几秒，按需给大）
     --shot=path   跑完后截视口图写到这个路径（相对路径相对仓库根）
     --w=, --h=    视口尺寸（默认 1280x900）
     --port=       调试端口（默认 9333）
     --keep        结束后不杀 Chrome、不删 profile

   注意：Chrome 需要不被文件沙箱限制（本机 workspace-write 下 Mojo/Crashpad 会拿到 0x5 拒绝访问
   而立刻自毁）；跑本工具时要用不受限模式。Chrome 进程 stdio 用 'ignore'，CDP 走 HTTP/WS。
   ========================================================================== */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const p = '--' + name + '=';
  const hit = process.argv.slice(2).find(a => a.indexOf(p) === 0);
  return hit ? hit.slice(p.length) : def;
}
function flag(name) { return process.argv.slice(2).indexOf('--' + name) >= 0; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const ROOT = path.join(__dirname, '..');
const CHROME = process.env.HS_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = parseInt(arg('port', '9333'), 10);
const TARGET_URL = arg('url', 'http://127.0.0.1:8788/');
const VW = parseInt(arg('w', '1280'), 10);
const VH = parseInt(arg('h', '900'), 10);
const WAIT = parseInt(arg('wait', '800'), 10);
const SHOT = arg('shot', '');
const KEEP = flag('keep');
const FILE = arg('file', '');
const EXPR = arg('eval', '');
const STEPS = arg('steps', '');   /* Node 侧步骤脚本：能发真鼠标事件、能重载页面 */

const PROFILE = path.join(ROOT, '.tmp', 'chrome-probe-' + PORT);
const PORT_FILE = path.join(PROFILE, 'DevToolsActivePort');

async function waitJson(url, ms) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch (e) { /* 还没起来 */ }
    if (Date.now() - t0 > ms) throw new Error('等 ' + url + ' 超时（' + ms + 'ms）');
    await sleep(120);
  }
}

/** --remote-debugging-port=0 时，真实端口写在 profile 的 DevToolsActivePort 第一行 */
async function waitPortFile(child, ms) {
  const t0 = Date.now();
  for (;;) {
    if (fs.existsSync(PORT_FILE)) {
      const p = (fs.readFileSync(PORT_FILE, 'utf8').split('\n')[0] || '').trim();
      if (p) return p;
    }
    if (child.exitCode !== null) throw new Error('Chrome 提前退出（exit ' + child.exitCode + '）');
    if (Date.now() - t0 > ms) throw new Error('等 DevToolsActivePort 超时（' + ms + 'ms）');
    await sleep(200);
  }
}

/** 极简 CDP 客户端：按 id 配对，事件可 await */
function makeCdp(ws) {
  let seq = 0;
  const pending = new Map();
  let waiters = [];
  ws.addEventListener('message', ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error('CDP ' + p.method + ' 报错：' + JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) {
      const keep = [];
      waiters.forEach(w => { if (w.method !== msg.method) { keep.push(w); return; } clearTimeout(w.timer); w.resolve(msg.params); });
      waiters = keep;
    }
  });
  return {
    send(method, params) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        try { ws.send(JSON.stringify({ id, method, params: params || {} })); }
        catch (e) { pending.delete(id); reject(e); return; }
        setTimeout(() => {
          if (pending.has(id)) { pending.delete(id); reject(new Error('CDP ' + method + ' 超时（30s）')); }
        }, 30000);
      });
    },
    waitEvent(method, ms) {
      return new Promise((resolve, reject) => {
        const w = { method, resolve };
        w.timer = setTimeout(() => { waiters = waiters.filter(x => x !== w); reject(new Error('等事件 ' + method + ' 超时（' + ms + 'ms）')); }, ms);
        waiters.push(w);
      });
    }
  };
}

(async function main() {
  if (!fs.existsSync(CHROME)) throw new Error('找不到 Chrome：' + CHROME + '（可用 HS_CHROME 覆盖）');
  if (!EXPR && !FILE && !STEPS) throw new Error('至少给一个 --eval= / --file= / --steps= / --shot=');
  let expr = EXPR;
  if (FILE) expr = fs.readFileSync(path.isAbsolute(FILE) ? FILE : path.join(ROOT, FILE), 'utf8');

  fs.mkdirSync(PROFILE, { recursive: true });
  try { fs.rmSync(PORT_FILE, { force: true }); } catch (e) { /* 别读上一次留下的旧端口 */ }
  console.log('[probe] Chrome headless 起（profile=' + PROFILE + '，调试端口由系统分配）');
  const child = spawn(CHROME, [
    '--headless=new',
    /* 端口 0 = 系统分配，再从 profile 里的 DevToolsActivePort 读回来。
       固定端口（--remote-debugging-port=9333）在这台机器上实测起不来；网关也是
       用 port=0 + 读这个文件（tools/gateway.js:2046 / 2070），照抄才稳。 */
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    '--user-data-dir=' + PROFILE,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-blink-features=AutomationControlled', '--mute-audio',
    '--window-size=' + VW + ',' + VH, '--lang=zh-CN',
    'about:blank'
  ], { stdio: 'ignore' });
  child.on('error', e => console.error('[probe] Chrome 进程起不来：' + ((e && e.message) || e)));

  let ws = null;
  try {
    const dbgPort = await waitPortFile(child, 20000);
    console.log('[probe] 调试端口 ' + dbgPort + ' 就绪');
    const ver = await waitJson('http://127.0.0.1:' + dbgPort + '/json/version', 8000);
    console.log('[probe] ' + (ver.Browser || 'Chrome') + ' 就绪');
    const list = await (await fetch('http://127.0.0.1:' + dbgPort + '/json/list')).json();
    const page = list.filter(t => t.type === 'page')[0];
    if (!page) throw new Error('/json/list 里没有 page 目标');

    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket 连不上 ' + page.webSocketDebuggerUrl)), { once: true });
    });
    const cdp = makeCdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: false });

    const loaded = cdp.waitEvent('Page.loadEventFired', 45000);
    await cdp.send('Page.navigate', { url: TARGET_URL });
    await loaded;
    console.log('[probe] load 事件已到：' + TARGET_URL + '，再等 ' + WAIT + 'ms');
    await sleep(WAIT);

    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', {
        expression: '(function(){ return (' + expression + '); })()',
        returnByValue: true, awaitPromise: true
      });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error('eval 抛出：' + ((d.exception && (d.exception.description || d.exception.value)) || d.text));
      }
      return r.result.value;
    };
    const shot = async (p) => {
      const cap = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const out = path.isAbsolute(p) ? p : path.join(ROOT, p);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(cap.data, 'base64'));
      console.log('[probe] 截图 → ' + out);
      return out;
    };
    const reload = async () => {
      const loaded = cdp.waitEvent('Page.loadEventFired', 45000);
      await cdp.send('Page.reload', { ignoreCache: false });
      await loaded;
    };
    /* 真鼠标事件（CDP Input）：站内拖拽/缩放走 Pointer Events，Chrome 会从
       Input.dispatchMouseEvent 合成 pointerdown/move/up，所以能真复现手感。 */
    const mouse = {
      move: (x, y, o) => cdp.send('Input.dispatchMouseEvent', Object.assign({
        type: 'mouseMoved', x: Math.round(x), y: Math.round(y), button: 'none', buttons: (o && o.buttons) || 0, pointerType: 'mouse'
      }, (o && o.extra) || {})),
      down: (x, y, o) => cdp.send('Input.dispatchMouseEvent', Object.assign({
        type: 'mousePressed', x: Math.round(x), y: Math.round(y), button: (o && o.button) || 'left', buttons: 1, clickCount: 1, pointerType: 'mouse'
      }, (o && o.extra) || {})),
      up: (x, y, o) => cdp.send('Input.dispatchMouseEvent', Object.assign({
        type: 'mouseReleased', x: Math.round(x), y: Math.round(y), button: (o && o.button) || 'left', buttons: 0, clickCount: 1, pointerType: 'mouse'
      }, (o && o.extra) || {}))
    };
    const log = (m) => console.log('[steps] ' + m);

    if (expr) {
      const r = await evaluate(expr);
      console.log('[probe] eval 结果 ↓');
      console.log(JSON.stringify(r, null, 2));
    }

    if (STEPS) {
      const stepsPath = path.isAbsolute(STEPS) ? STEPS : path.join(ROOT, STEPS);
      const fn = require(stepsPath);
      if (typeof fn !== 'function') throw new Error('--steps 文件要 module.exports 一个 async 函数');
      const out = await fn({ cdp, evaluate, shot, reload, mouse, sleep, log, url: TARGET_URL });
      console.log('[probe] steps 结果 ↓');
      console.log(JSON.stringify(out, null, 2));
    }

    if (SHOT) await shot(SHOT);
  } finally {
    if (ws) { try { ws.close(); } catch (e) { /* ignore */ } }
    if (!KEEP) {
      try { child.kill(); } catch (e) { /* ignore */ }
      await sleep(400);
      try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch (e) { /* profile 可能被占用 */ }
    } else {
      console.log('[probe] --keep：Chrome 留着（pid ' + child.pid + '，profile ' + PROFILE + '）');
    }
  }
  process.exit(0);
})().catch(err => {
  console.error('[probe] 失败：' + ((err && err.stack) || err));
  process.exit(1);
});
