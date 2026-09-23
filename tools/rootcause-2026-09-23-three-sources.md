# 三源连通（ehentai / porncomic / pixiv）根因与修复 —— 2026-09-23

## 一句话结论

| 源 | 症状 | 真根因 | 状态 |
|---|---|---|---|
| porn-comic | 检索报 `PC_STICKY_MS is not defined`，时好时坏 | `tools/gateway.js` 里 `PC_BUDGET_MS` 那一行的块注释**漏写收尾符**，把下一行 `const PC_STICKY_MS = 10 * 60e3;` 整行吞进注释 ⇒ 该常量真的 undefined | **已修 + 已端到端验证** |
| ehentai | 连不上 | 本机网络层不可达（DNS 投毒 + SNI 按域名阻断 + 两站无 ECH + 15 条公共中继全挂） | 链路层无解；已做 6s 快速失败 + 180s 冷却 + 可照做的指引 + 替代源 |
| pixiv | 连不上 | 同上 | 已做 8s 预算 + 180s 冷却 + HTML 检测 + 指引 |

---

## 1. porn-comic：注释吞掉声明（真 bug，不是网络问题）

### 症状原文
```
porn-comic 没有取到结果（已试 2 条入口：/q/anal-1.html / /tags/anal.html）：
  /q/anal-1.html：PC_STICKY_MS is not defined；
  /tags/anal.html：PC_STICKY_MS is not defined
```

### 为什么它「时好时坏」
唯一使用处 `tools/gateway.js:2891`：
```js
if (pcLastGood.ch && (now - pcLastGood.at) < PC_STICKY_MS && CH[pcLastGood.ch]) {
```
`pcLastGood.ch` 初值是 `''`，所以**第一次检索会因短路而侥幸不炸**；
**只要某条通路走通过一次、`pcLastGood.ch` 被赋上值，下一次检索立刻 ReferenceError**。

⇒ 「重启网关就好了」只是把它退回短路状态，**不是修复**。这一点上一轮判断错了（误判为「8788 跑的是旧代码」）。

### 真根因
`tools/gateway.js:2787`（修复前）：
```js
const PC_BUDGET_MS = 8000;          /* 单次取页的总预算（第 8 轮 20000 → 8000）      ← 这里漏写收尾符
const PC_STICKY_MS = 10 * 60e3;     /* 「上次走通的那条路」有效期 */
```
后者的**整行**落进了前者的注释里，于是 `PC_STICKY_MS` 从未被声明。

### 为什么所有既有检查都没抓到
`node --check` 通过、`new vm.Script()` 通过 —— **注释本身完全合法**，它只是多吞了一行代码。
语法检查对这类事故结构性失明。

### 修复
在 `tools/gateway.js:2787` 补上注释收尾符。

### 验证（对真实进程，非静态读）
重启网关后连打三次 `/api/porncomic/search?q=anal`：

| 次序 | 耗时 | 结果 | 意义 |
|---|---|---|---|
| try1 | 23600ms | `via=chrome total=24` | 冷启动，Chrome 过 Cloudflare |
| try2 | 5945ms | `via=chrome total=24` | **这一发就是以前抛 ReferenceError 的那一发**（走 sticky 分支） |
| try3 | 2ms | `via=chrome total=24` | 结果缓存 |

---

## 2. ehentai / pixiv：链路层不可达（完整证据链）

| 探测手段 | 结果 |
|---|---|
| 系统 DNS | `e-hentai.org → 0.0.0.0`（沉洞）；`www.pixiv.net → 47.88.58.234`（疑污染）；`exhentai.org → 104.244.43.136`（Facebook 段） |
| DoH 拿到 IP 后带 SNI 握手 | `e-hentai.org` **ECONNRESET 228/226ms** ⇒ 按域名关键字阻断；`forums/repo/upld.e-hentai.org` 同样 ECONNRESET |
| HTTPS RR（type=65，ECH 的唯一入口） | `e-hentai.org` 与 `www.pixiv.net` 返回的记录里**都没有 `ech=` 参数**；而 Cloudflare 的 DoH（`cloudflare-dns.com` / `1.1.1.1`）本机 **ECONNRESET / TIMEOUT** ⇒ 连查 ECH 配置的通道都没有 |
| 公共中继 | 15 条全挂（allorigins、codetabs、jina、translate.goog、corsproxy(401 要 key)、cors.lol(429)、corsfix(400)、whateverorigin、htmldriven(证书过期)、thingproxy(ENOTFOUND)、yacdn(EAI_AGAIN) 等） |
| 本机 Chrome | `/api/porncomic/solve` 对两站都是 `{ok:false, reason:"Page.navigate 超时"}`，约 51s |

**结论：Node / Chrome / DoH 钉 IP / 公共中继 / ECH 五条路全试过，本机网络下无任何技术通道。**
唯一解是用户侧挂代理。

---

## 3. 已落地的「不可达也要好用」

### 快速失败，不再把整轮检索拖死
- **ehentai**：`EH_BUDGET_MS = 6000` 硬闸 + `EH_NET_COOLDOWN_MS = 180e3` 冷却 + **出口感知**（换了出口立刻放行重试）。实测 6612ms 如实失败，之后毫秒级。
- **pixiv**：`PIXIV_BUDGET_MS = 8000`（旧值 15000 因三条腿串行实测被拖到 17.5s）+ 180s 冷却 + **HTML 检测**（中继会剥掉 Referer，pixiv 的 `/ajax/` 于是回登录页 HTML，对被请求为 `.json` 的端点这属于链路层失败）+ 出口感知 + **只对链路层拉闸**（HTTP 4xx / 0 条结果不冷却，否则挂上代理后会被自己误锁 180 秒）。实测 try1 10354ms → try2 2ms。
- **前端预算**：pixiv 7000ms、ehentai 6000ms（`assets/js/sources.js`）⇒ 用户感知上限就是这两个数，网关侧多出的时间在后台跑完并落下断路器。

### 错误文案给出出路
`tools/gateway.js` 新增 `DEAD_SITE_FIX`，说明死因并给出两条可执行路径（挂代理 / 用替代源），
并点名实测可达的替代源：**ehentai → nhentai / wnacg / hitomi**，**pixiv → danbooru / kemono**。

---

## 4. 回归保护：`tools/gateway-check.js`

6600+ 行的网关此前**没有任何回归套件**（grep 确认没有别的 check 读它）。新增 `tools/gateway-check.js`（21 条）并注册进 `tools/check-all.js` ⇒ 8 个套件、302 条断言全绿。

其中两条最值钱：

1. **注释：块注释没有吞掉下一行声明**
   判据三道闸：整行落在块注释里 + 长得像声明（缩进 ≤ 8 格）+ **该名字在「去注释后的活代码」里完全没有声明**。
   第三道闸是精度关键：文档注释里举例的代码通常引用真实存在的名字，所以它能把误报基本清零（首版只按「缩进 ≤ 2 格」判，既漏函数体内的声明、又容易误报）。
2. **注释：检测器自证能报警**
   把第 11 轮那次事故的**原样**喂给检测器，必须点名 `SWALLOWED_ONE`。
   没有这条，上面那条 PASS 只证明「没找到东西」，证明不了「检测器有眼睛」——这正是上一轮差点被蒙过去的地方。

---

## 5. 三条方法论教训

1. **语法检查抓不住「注释吞代码」**，必须单独设卡，而且**检测器必须自证**。
2. **「重启就好了」是危险结论。** 重启会把 bug 推回「未初始化 / 短路」状态从而掩盖它。遇到「重启即好」，必须解释清楚静态读为什么看不出问题；**解释不通，那个解释就是错的**（本次上一轮正是如此）。
3. **沙箱里 `netstat` / `Get-NetTCPConnection` 可能静默返回空**，`Stop-Process` 于是根本没杀到人，「重启」看起来像没在跑。
   ⇒ 重启后必须用**行为证据**验证（例：同一请求连打两次，看第二发是否仍走缓存/sticky 路径），不能只看 ping。

---

## 6. 边界与后续

- ehentai / pixiv 的直连恢复**只可能来自用户侧代理**：
  `node tools/gateway.js --port 8788 --proxy http://127.0.0.1:7897`，或先设 `HTTPS_PROXY` 环境变量。
  断路器已做出口感知，挂上代理后**无需重启网关**即可恢复。
- 若想让启动脚本原生支持代理，可给 `tools/start-gateway.ps1` 增加 `-Proxy` 参数透传。
- 本轮新增的 `tools/rootcause-2026-09-23-three-sources.md` 与 `tools/gateway-check.js` 是配套的：前者记「为什么」，后者防「再犯」。
