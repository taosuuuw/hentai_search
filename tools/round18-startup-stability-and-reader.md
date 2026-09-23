# 第 18 轮：起始页测光 · 四源检索稳定性 · 阅读器取图 · 弹窗横幅

> 用户诉求（m01015，原话四点）：
> 1. 起始页细框的微光在两头消失后，搜索框对应的测光光照感应该暗下来
> 2. 拷贝漫画、E-Hentai、porn-comic、MangaDex 检索稳定性不够好，一段时间内搜索时好时坏。需要提高它们的稳定性，**从弹出网页开始**
> 3. 在线阅读读取图片速度偏慢，需要更快的读取，并且减少读取失败的概率
> 4. 弹出网页进入初始页顶部会有「部分网点没有连接」的提示框，希望杜绝这种情况，保证弹出页面时网点都是连接好的而不是要等一会

改动文件：`assets/css/style.css`、`assets/js/net.js`、`assets/js/app.js`、`assets/js/sources.js`、`assets/js/reader.js`、`tools/gateway.js`、`tools/gateway-check.js`。
回归：`node tools/check-all.js` = **9 套件 / 471 条断言 / 失败 0**。

---

## 需求① 搜索框测光与细框微光**同相位**地两头变暗（已完成，带数字验收）

### 改了什么
- `assets/css/style.css:569-570` 灯层 `.hs-searchbar::after` 从单动画改成双动画：`animation: hs-box-glow 3.6s ease-in-out infinite alternate, hs-meter-dim 3.6s ease-in-out infinite alternate;`
- `assets/css/style.css:587-592` 新增 `@keyframes hs-meter-dim`：`0%` → `var(--sb-meter-floor)`、`18%`/`82%` → `var(--sb-meter-peak)`、`100%` → floor（相位照抄细框微光 `hs-line-glow`）
- `assets/css/style.css:635-636` 阴影层 `.hs-sb-shade` 同样挂 `hs-box-glow + hs-shade-dim`；`assets/css/style.css:643-649` 新增 `@keyframes hs-shade-dim`
- 峰值/地板全部做成令牌（`--sb-meter-peak/.floor`、`--sb-shade-peak/.floor`），`assets/css/style.css:593` 浅色主题另有一组
- **刻意没动** `::before` 的 opacity：那一层是补面（盖住 8px 缝），改它的 opacity 会把缝闪出来

### 数字验收
`node tools/live-probe.js --url=http://127.0.0.1:8804/ --steps=.tmp/_r18-env-steps.js --w=1280 --h=900 --wait=1500`
（动画 `pause()` + 钉 `currentTime`，按 `.hs-searchbar` 矩形裁图算平均亮度）

| t | ::after opacity | shade | 平均亮度 |
|---|---|---|---|
| 0 | 0.30 | 0.26 | **50.18** |
| 450 | – | – | 53.49 |
| 900 | – | – | 58.49 |
| 1350 | – | – | 64.25 |
| 1800 | – | – | 66.96 |
| 2700 | – | – | 58.45 |
| 3600 | 0.30 | 0.26 | **50.25** |

- `minPlatformLum=58.45`、`maxEndLum=50.25` ⇒ **dropAtEnds=8.21**（两头确实更暗）
- A/B（把地板强行抬到峰值 = 旧行为）t=0 亮度 52.32 vs 有包络 50.18 ⇒ **gain=2.14**（差异来自包络本身）
- verdict 四条全 true：`endsAreDimmer` / `bothLayersDimAtEnds` / `peakIsFullOnPlatform` / `envelopeIsTheCause`

---

## 需求②④ 「从弹出网页开始」就把网点连好（预热 + 不误报）

### 网关新增 `/api/warm`（tools/gateway.js）
- `diagProbe(timeoutMs)` 从 `/api/diag` 的内联表抽成公用函数：逐目标 `withHardTimeout(outFetch(...), timeoutMs + 900)`（outFetch 的 timeout 是**逐层**的，传 6000 不等于 6 秒内有结论）+ 硬超时标 `unknown`
- `/api/warm` 三段**并行**且各自软超时：`diagProbe(WARM_PROBE_MS=5000)` / `Promise.all(WARM_PIN_HOSTS.map(h => pinHost(h, 1800)))` / `warmUpstreamCheck()`，整段再套 `WARM_TOTAL_MS=9000`
- `WARM_PIN_HOSTS = ['api.mangadex.org','uploads.mangadex.org','e-hentai.org','www.wnacg.com','api.copy2000.online']`
- **只有 `full`（没有 unknown 目标）才写 `diagCache`** —— 「没等到结论」不许冒充最终结论
- 教训：第一版把三段串行写，真机 **31.2 秒**才回 —— 预热绝不能变成新的等待；改成并行后 6019ms

### 前端（assets/js/app.js / assets/js/net.js）
- boot 顺序反转：`probeGateway(false)` 120ms → `probeNow(true,false)` 300ms（旧的是网探针 260ms 早于网关 680ms，临时结论常常先落地）
- `GW.warm()`（net.js）：先 `probe` 探活再打 `/api/warm`，写 `_gwDiag/_gwTiers/_gwUpstream` 并 `emit('net:warm')`
- `showBanner`：`probe.provisional && gwLive` ⇒ 直接 `hidden = true; return;`（弹窗阶段一律不弹横幅）
- 网探针**自己补一次网关检测**（组装文案前，若 `!GW.ok && !GW._probedAt`，最多等 1.2s）
- 自检的 `unknown`（并行自检下 wnacg/hitomi 常报 5.9s 硬超时，而 `/api/diag` 里都 OK）与 `banned`（E-Hentai 上游限流）从 `blocked` 清单里摘出去
- 自检目标修正：wnacg 从 `www.wnacg.com`（实测 4900–7200ms，5 秒预算下只等到硬超时 ⇒ 误报「连网关也打不通」）换成 `www.wnacg02.cc`（1511ms 有应答）

### Danbooru 自检误报（需求④ 的最后一条误报）
- 定因：`danbooru.donmai.us` 直连必被 Cloudflare 挡（**这个站的常态**），它的检索本来就走 tbib/xbooru 镜像；`/api/diag` 只打直连 ⇒ 每次开机约 16 秒后横幅必弹「Danbooru 连网关也打不通」，而同一时刻网关日志写着 `danbooru 镜像兜底：tbib ← tags=… → 8 条`
- 修复（`diagProbe` 内、`Promise.all` 的 map 回调末尾）：直连失败后补一次**有界**镜像自检
  `withHardTimeout(danbooruMirrorFetch({ tags:'solo', limit:1, page:1 }), Math.max(2500, Math.min(timeoutMs, 5000)), 'Danbooru 镜像自检')`
  成功则 `ok:true, via:'mirror:'+mvia, mirror:true`，失败只记 `mirrorError`（不改变结论）
- 实测：`danbooru ok/mirror:tbib/1535ms`

### 真机结果（需求④ 达成）
`node tools/live-probe.js --url=http://127.0.0.1:8804/ --steps=.tmp/_r18-banner-steps.js --w=1280 --h=900 --wait=600`（最终构建）
- 120 tick / 18.0s：`banner.visibleFrames = 0`、临时阶段可见帧 0、`hasMisleadingText=false`
- 末帧 chip「目标可达」、`finalVerdict='ok'`

---

## 需求② 四个源各自的稳定性

### MangaDex —— 首搜慢是冷启动，不是缺陷
- `/api/ping` 45ms；`hostPlan` 里 `api.mangadex.org:"env"`（直连）
- proxy 首轮 2244/1207/514/475/2268ms；**同一个词连打三次 = 2ms/2ms/2ms（缓存）**；本机原生直连对照 1265ms/463ms
- `.tmp/_r18-mdwarm.js`：nowarm 冷启动 1st search 958ms → 其后 223ms；warm 模式 1st search 581ms → 202ms
- ⇒ 那两次 6502/8415ms = 首次定通路 + DoH 钉 IP，叠加 MangaDex 上游本身的 0.5–2.3s 抖动；`/api/warm` 在开机时把这一次冷启动吸收掉（这正是需求②「从弹出网页开始」）
- `assets/js/sources.js`：`mdFirst = HS.net.browserBlocked('mangadex')` ⇒ 两处 `proxyFirst`

### 拷贝漫画 —— 第 17 轮的「上游整体空转」结论是**错的**，已推翻并修复
决定性取证（同一秒三方并发，`.tmp/_r18-copy-decisive.js`）：
| 通路 | 结果 |
|---|---|
| 网关 `/api/copymanga/search?q=水着&raw=1` | 518ms `ok=Y total=0`（它当时走的是中继） |
| 自建中继直取两个节点（带签名头） | 1153/883ms `total=0` |
| **本机直连同两个节点** | 2946/2810ms `HTTP 200 code=200 total=2186 list=30` |

- 中继对这三个 API 节点**恒回空壳**：18 发（3 节点 × 3 词 × {检索接口, 无关键词列表接口}）全部 `code=200 total=0 list=0`
- IP 级取证（`.tmp/_r18-copy-ip.js`）：系统 DNS 只有 `171.244.199.189`（带 SNI 验真通过，证书是真的）；同一域名同一套签名头**一次给 2186、另一次给 0**，耗时 0.4–11s ⇒ **上游本身在摇摆**；Cloudflare 那两个 IP 直接 TLS handshake failure（SSL alert 40）
- 双重危害：空壳是**合法 200 JSON**，会被 `setPlan(host,'relay')` 永久钉住（直到重启），而且先到先得会挤掉真结果
- 修复（tools/gateway.js）：
  1. `RELAY_BAD_HOSTS = new Set(['api.copy-manga.com','api.copy2000.online','api.mangacopy.com'])`：这三个主机禁止走中继，且**已粘在中继上的旧计划就地清掉**（`if (noRelay && plan === 'relay') { plan = ''; setPlan(host, ''); }`）
  2. `COPY_EMPTY_GRACE_MS` **1500 → 3000**（真答案实测要 2.8–2.9s，宽限太短会自己把真结果丢掉）
  3. 第一轮全空**再竞速一轮**（`retryBudget = COPY_HARD_MS - 500 - elapsed`，不顶穿兜底）
- 修复后真机：copymanga **3/3**（水着 3330ms total=2186 / ナース 3067ms total=1123 / メイド 333ms total=646；修复前 メイド 是 `ok=N 上游返回空结果`）

### porn-comic
- 旧实现**成功也不缓存** ⇒ 新增 `pcSearchCache`（5 分钟，键 `q|page|extra`，上限 60）
- 与拷贝漫画共用一层负缓存 `SW_FAIL_MS = 45e3`（只给这两个源；E-Hentai/紳士漫畫 有更精确的断路器，套这层会盖掉「还有 N 秒解封」）
- 真机：porncomic **3/3**（827/494/546ms，via=relay，24/24/23 条）；同一个词第二次 2ms `cached:true`

### E-Hentai —— 无代码解，只能如实报告 + 不再自伤
- 封的是**取页那一跳的出口**（自建 Cloudflare Pages 中继的共享机房 IP），实测倒计时 12000–13440 秒
- 修复：`diagProbe` 撞上封禁要**记住**（日志 `自检撞上 E-Hentai 限流封禁：N 秒内不再重试`）并在窗口内跳过 e-hentai 自检与检索 —— 第 17 轮的根因正是「每 25 秒一次的重试把 5 分钟封禁刷成常驻」
- 真机：ehentai 0/3（第 1 发 1117–1216ms 报封禁，其后 1–3ms「1800 秒内不再重试」）

### 四源复测汇总（预热后的网关，`.tmp/_r18-stability.js`）
| 源 | 成功率 | 耗时 | 备注 |
|---|---|---|---|
| copymanga | **3/3** | 333/3067/3330ms | total 2186/1123/646 |
| porncomic | **3/3** | 494/546/827ms | via relay，24/24/23 条 |
| mangadex | **3/3** | 312/849/3760ms | 各 8 条 |
| ehentai | 0/3 | 1–1216ms | 上游按共享中继出口封禁（倒计时上限 1800s） |

---

## 需求③ 阅读器更快、失败更少

### 三条改动
1. `proxyFetch` **在途合并**（tools/gateway.js）：同一把缓存键的并发请求只发一次（旧实现只有「完成后写缓存」，阅读器并发取同一张图时会重复打上游）
2. 新增 `/api/prefetch`：`PRE_MAX=24` / `PRE_CONC=4` / `PRE_HARD_MS=12000`，能把页盒里的 `/api/proxy?url=…&referer=…` **拆回同一把缓存键**（否则预取写进去、取图又各算一把，白预取）
3. `assets/js/reader.js`：章节数据就绪后按窗口预取后面几页（`PA_LOOKAHEAD` / `PA_MIN_GAP_MS`，只预取一次、有节流）

### 禁漫阅读器（`readerJmcomic`，tools/gateway.js:6955 起）
- ① `/chapter` 拿不到文件名时**换域名重试**（候选来自 `jmHostsList()`，最多 3 个；每个候选各自记失败原因，全失败时一并写进错误）
- ② **模板也换域名重试**（模板只依赖 `view`；域名在抖时会出现「/chapter 有文件名、模板没有 scramble_id」）
- ③ 优先复用 5 分钟内记住的 APP 域名（`jmPickHost()`），不再每次都跑一整轮 `jmResolveHost()` 探测
- 错误文案不再一言断定「接口可能改版了」：改成「不一定是『接口改版』，更像这一跳的瞬时故障：已试 …；稍后重试，或换个出口代理」

### 计时（临时插桩，已移除）
| 阶段 | 冷 | 热 |
|---|---|---|
| `/chapter` | 2043ms | **296ms** |
| 模板 | +292ms | +296ms |
| 图床探通（最大单项） | +1449ms | +1240ms |

图床那 1.2–1.4s 不是白花：它同时把禁漫 CDN 的 IP 钉好，后面的取图才是几百毫秒级。

### 端到端验收
`node tools/live-probe.js --url=http://127.0.0.1:8804/ --steps=.tmp/_r18-reader-steps.js --w=1280 --h=900 --wait=1500`（jmcomic #1475643）
- `firstDecodedAt`：4529ms（第 17 轮）→ 3669ms → **3309ms**（最终构建）
- 47 个页盒、6 张在途图、预取 1 次 6 条、入缓存 6、解码 6、`brokenFailed = 0`
- verdict：`prefetchCalled / prefetchFilled / multiplePagesDecoded / noBrokenImages` 全 true

### 一次「假失败」的澄清（也是需求③ 要修的误导文案）
某次 live-probe 报「没能取回页面 / 禁漫这一话没有返回任何图片文件名（接口可能改版了）」，而**同一时刻**手动直测同一本是 `200 + 47 页` ⇒ 那次是瞬时故障（探针正跑在网关被 pixiv/danbooru 中继重试打满的窗口里）。这条文案本身就是第 ① 项要修的东西。

---

## 回归与验收
- `node tools/check-all.js`：concept 41 / cardtags 33 / scroll 39 / glass 70 / reader 49 / recent 28 / dict 28 / **gateway 90** / relay 93 = **471 条断言，失败 0**
- `tools/gateway-check.js` 新增第 18 轮断言：需求① 包络 4 条、需求②④ 预热与横幅 13 条、需求③ 阅读器/预取 6 条、拷贝漫画通路 4 条、Danbooru 镜像自检 1 条、禁漫阅读器 3 条
- 教训：**改常量前先 grep 它有没有被断言写死** —— `COPY_EMPTY_GRACE_MS` 从 1500 改 3000 直接把 F 节第 17 轮那条断言打成 FAIL

---

## 需要用户手动做的
1. **重启网关**：你那个 `8788` 是旧进程，本轮所有改动（预热、横幅、禁漫阅读器、拷贝漫画通路）都要重启才会生效
2. **pixiv**：必须自备住宅 / 家宽出口（`--proxy http://127.0.0.1:端口` 或 `HTTPS_PROXY`；R-18 另需 `PHPSESSID`）。数据中心 IP 与公共中继一律 403/429，**没有代码解**
3. **E-Hentai**：共享中继出口被上游限流封禁（当前倒计时上限 1800s），只能等窗口或换自己的出口；网关现在会如实报倒计时，并且**在窗口内不再自己刷新封禁**
4. **拷贝漫画**：上游本身在摇摆（同一 IP 0.4–11s、有时 total=0）。代码已做到「不把一次空当结论」+「不让恒空的中继冒充答案」，但消除不了上游抖动

## 遗留 / 已知瑕疵
- copymanga 候选节点里混进 `t66y.com`（`copyApiBase` 的节点发现把跳板域名持久化进了 `state.copyApiHint`）
- `/api/warm` 在并行自检下常 `full=false`（wnacg/hitomi/kemono/pixiv 撞 5.9s 硬超时）⇒ 那一次不写 `diagCache`，属预期行为
- 阅读器 `firstDecodedAt` 3309ms 的大头是禁漫图床那一次冷探测；要再快得让 `pinHost` 支持同区（同 registrable domain）复用已验证 IP
- 沙箱：node 探针不要接管道（`Program 'node.exe' failed to run: Access is denied`）；`tools/live-probe.js` 需要 `danger-full-access`
