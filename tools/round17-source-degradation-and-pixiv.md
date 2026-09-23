# 第 17 轮：e-hentai / 紳士漫畫 / 拷贝漫画·禁漫天堂 退化 + pixiv 连接 —— 修复报告

- 日期：2026-09-23（真机实测时间戳同）
- 网关版本：`GW_VERSION = '1.3.0'`（未升版）
- 回归基线：`node tools/check-all.js` = **9 套件 / 446 条断言 / 失败 0**（本轮开始时是 432 条）
- 原始工作笔记（逐条行号取证）：`tools/round17-notes.md`

## 一、用户诉求（原话）

> 1。ehentai总是不返回结果、绅士偶尔不返回结果
> 2.copymanga/jmcomic 这三处退化修复
> 3.pixiv并未连接
> 记得用browser插件自己去看网页

## 二、结论速览

| 诉求 | 结论 | 关键证据 |
| --- | --- | --- |
| ehentai 总是不返回结果 | **修好**（两个真凶，都在本地） | 静默 390s 后 478ms 拿到 26 条；浏览器实测 ✓ E-Hentai 8 条（4.44s） |
| 绅士（wnacg）偶尔不返回 | **结构性原因修好**；残余是镜像本身不稳 | 旧代码 8560ms 撞死 8500ms 硬闸；新代码 UI ✓ 8 条（3.20s） |
| copymanga 退化 | **上游故障，本地无解**；本地只修「把沉默伪装成超时」 | 三个官方节点连不带 q 的列表接口都回 200+空列表 |
| jmcomic 退化 | **真机未复现**（12 域名 11 通、80 条/次、UI 2.85s 8 条） | 逐域名实测表见 §5 |
| pixiv 并未连接 | **无代码解**，必须给网关一个住宅/家宽出口；本轮修掉两个副作用 | 16s 吊死 → 8432ms + 断路器 5ms；报错不再串台 e-hentai |
| 附带 | 首页横幅不再误报「先启动本地网关」（这条让用户以为源坏了） | 临时结论现在会说「本地网关已连接…检索会优先走网关」 |

## 三、诊断方法（可复现）

- **browser 插件真机操作**（用户硬要求）：Agent Window 打开 `http://127.0.0.1:8803/`，过 18+ 遮罩、真发搜索、看逐源状态与横幅文案。
- **只读探针**（`.tmp/_r17-*.js`，全部前台跑）：直打网关 `/api/*/search`，另用 `/api/copymanga/search?raw=1` 看上游原始 JSON。
- **隔离验证**：另起网关实例（8799/8801/8802/8803）跑新代码，**绝不碰用户那个 8788**（它是旧进程）。
- **回归**：`node tools/check-all.js`，本轮把 9 套件从 432 条断言加厚到 446 条。

## 四、需求 1a：e-hentai「总是不返回结果」—— 两个真凶都在本地

### 真凶 1：前端把「封禁页」当成成功（`assets/js/sources.js:962-977`）

旧顺序：先置 `directAnswered = true` → 下一行抛错 → 被 `catch` 吃掉 → 标志没回滚 → 函数尾部
`if (gwAnswered || directAnswered) return [];` ⇒ **UI 显示「✓ E-Hentai 返回 0 条」**。
用户看到的就是「总是不返回结果」。

改法：`directAnswered = true` 挪到**封禁判定之后**；判据 `/temporarily banned|Your IP address has been|excessive request rate/i`，
抛 `E-Hentai 按出口 IP 限流封禁（这不是「0 条结果」）`。

### 真凶 2：25s 冷却把「5 分钟封禁」刷成了常驻（`tools/gateway.js`）

- 旧代码确认网络层不可达后只锁 `EH_NET_COOLDOWN_MS`（公共中继 25s）⇒ **每 25 秒再撞一次已被封的出口**，
  上游倒计时被不断刷新，「封 5 分钟」实际变成常驻。
- 决定性证据（`.tmp/_r17-eh-await.js`，静默 390 秒不碰 e-hentai）：
  `[t+390s] 2026-09-23T15:00:39.705Z 478ms HTTP 200 bytes=70230 rows=26 banned=false`
  ⇒ **封禁是我们自己的重试刷出来的窗口**，冷却只需要按上游倒计时走。

改法（`tools/gateway.js`）：
- 新增 `ehBanUntil` / `ehBanLeftMs(body)`（`/ban expires in\s*([^.<]{1,80})/i` + 时/分/秒求和）/ `ehDownMs()`（`max(网络冷却, min(30min, 封禁剩余))`）/ `ehDownSecs()`（~5870-5915）。
- `ehHtml` 遇封禁页时 `ehBanUntil = Date.now() + banLeft + 3000`，正常 200 清零（~5406-5415）。
- 两处 `ehNetDownUntil = Date.now() + ehNetCooldownMs()` → `+ ehDownMs()`；两处文案 `(ehNetCooldownMs()/1000)` → `ehDownSecs()`。
- `ehBodyErr` 封禁文案重写（~5369-5396）：不再写死「中继（cors.eu.org）」，改为「封的是取页那一跳的出口」+ 上游倒计时 + `--proxy` 立刻恢复办法。

**验收**：浏览器真机搜索「催眠」→ `✓ E-Hentai 返回 8 条（4.44s）`。

## 五、需求 1b + 2：紳士漫畫（wnacg）「偶尔不返回结果」

### 根因：两层闸门错位，必然超预算（不是「偶发」）

- `per = Math.max(2000, Math.min(WN_HOST_MS, left() - 800))` 的**地板 2000ms 与 `left()` 无关**：
  第一批跑完 `left()` 只剩 400ms，但 `pickProbe` 的 deadline 判断是「7400 < 7800 ⇒ 还能再开一批」，
  第二批照样拿 2000ms 地板 ⇒ 整源跑到 ~9800ms，先撞死外层 `WN_HARD_MS = 8500` 的函数级硬闸。
  真机复现：搜「人妻」**8560ms ok:false「超过 8500ms 硬闸」**，而同一个词稍后又能出结果。
- 镜像索引不一致：`www.wnacg02.cc` 1511ms 就能应答，但它的索引里**没有**很多词 ⇒ 「镜像答了但 0 条」被误当成「源挂了」。

改法（`tools/gateway.js`）：
- 新增 `WN_BATCH_MIN_MS = 1000`（~5110-5127，含根因注释）；`wnacgSearchInner` 三处收口：
  `if (left() < 1800) break;`（原 2500）、`per = Math.max(700, Math.min(WN_HOST_MS, left() - 700))`（原地板 2000）、
  `deadline: t0 + WN_BUDGET_MS - WN_BATCH_MIN_MS`。
- `WN_READER_HOSTS` 重排（~4952-4965，注释带实测证据）：能出结果的只有 `www.wnacg.com`(4984ms/24 条) / `wnacg.com`(5241ms/24 条)
  / `www.wnacg02.cc`(1511ms 但另一个索引)；实测死的（12655ms 502 / 12-17s / 只是 `<title>Redirecting...</title>` 跳板页）排后面。
- 「真 0 条」与「源挂了」分开：新增 `pageOk`（`/gallary_item|aid-\d+|no-result|No\s*Results?/i`），
  真 0 条返回 `{total:0, items:[], note:'…这一页确实 0 条结果（不同镜像索引不一致）'}` 且 **不写缓存**（偶发空页若钉 5 分钟，用户会觉得镜像坏了）。
- 冷却文案去复读：`wnNetDownWhy = why.replace(/[?&][A-Za-z_]+=[^\s；)]*/g,'').replace(/\s+/g,' ').slice(0,160)`
  （旧实现把整句连关键词一起存下，搜「巨乳」时报错还在讲上一次的 `/search/?q=人妻`）。
- 前端 `assets/js/sources.js:1795-1810`：`gwWn` 语义拆分 —— `null`=网关没答复 / `[]`=答复了但 0 条。
  `[]` 在 JS 里是**真值**，旧写法会短路掉「10 镜像 × 3 路径」的浏览器兜底（本机直连这些域名全 fetch failed，兜底只白烧 ~10s）。

**验收**：
- 探针（新代码实例）：人妻 5258ms ok:true 24 条 host=www.wnacg.com；巨乳 1504ms 24 条；催眠 3392ms 24 条。
- 浏览器真机：`✓ 紳士漫畫 返回 8 条（3.20s）`。
- **诚实的残余**：镜像本身仍会在个别时刻抽风 —— 有一次实测 11 个候选全不可用（`www.wnacg.com：硬超时 7400ms`，
  同时私有中继对该站回 403、`www.wnacg02.cc` 索引里没那个词）。这不是本地代码能消掉的，靠 `WN_HOST_MS` 预算 + 30s 冷却自愈。

### jmcomic（禁漫天堂）：真机未复现「退化」

12 个域名各用一个不同的词（避开缓存，cache key = `q|page|o`）：**11 通 / 1 空**，每次 80 条真结果。

| 域名 | 结果 | 域名 | 结果 |
| --- | --- | --- | --- |
| www.cdngwc.net（当时在用） | 80 条 | www.cdnhth.club | 80 条 |
| www.cdnhjk.net | 80 条 | www.cdnplaystation6.vip | 80 条 |
| www.cdngwc.cc | 80 条 | www.cdntwice.org | 80 条 |
| www.cdngwc.club | 80 条 | www.cdnsha.org | 80 条 |
| www.cdnbea.net | 80 条 | www.cdnaspa.cc | 80 条 |
| www.cdnhth.net | 80 条 | www.cdnntr.cc | **0 行**（唯一坏的） |

真实 `total`：催眠 8464、触手 5632、人妻 10000、巨乳 10000、泳装 9514、制服 2905、教师 2639、护士 1160、女仆 454、眼镜娘 97、丝袜 481。
浏览器真机：`✓ 禁漫天堂 返回 8 条（2.85s）`。
⇒ **jmcomic 侧没有可修的退化**；若你看到它不返回，请把当时的关键词告诉我，我按那个词复现（很可能是「某个词在它的库里确实少」或短时抖动）。

## 六、需求 2：拷贝漫画 —— ★上游静默空转，本地无解★

### 取证链（全部只读，同一条自建中继上同时刻做对照）

1. 4 组请求头（网关白名单 / 全量检索头带签名 / 阅读器 light 头 / 什么都不带）× 三节点 = **全部 `HTTP 200` + 83 字节
   `{"code":200,"message":"请求成功","results":{"list":[],"total":0}}`** ⇒ 签名与头转发**不是**根因。
2. 8 个词（人妻/巨人/催眠/巨乳/制服/触手/anal/「人妻 巨乳」）× 3 节点 = 24 次，**每一次 total=0**。
3. 明显有货的词（海贼王 / ワンピース / one piece / 火影忍者）也全 0；**连不带关键词的列表接口
   `/api/v3/comics?limit=5&offset=0&platform=3` 都是 total=0**（决定性：整站列表不可能真空）。
4. 换出口对照：direct `fetch failed`；`cors.eu.org` **HTTP 429**（53KB Cloudflare 限流页）；allorigins 500/超时；allorigins-get 502/47s。
5. 浏览器自己也打不开 `mangacopy.com`（标签变成 `chrome-extension://…/site_status_block_page.html`）。
6. 同一时刻同一条私有中继：**e-hentai 200 / 70KB、jm 80 条** ⇒ 本机网络与中继都正常。

⇒ 结论：这是**拷贝漫画自己的检索服务在静默空转**（形态是「200 + 空」，不是报错）。本地代码变不出结果。

### 本地能修的只有「把沉默伪装成超时」这件事（已修）

旧行为：`probeFn` 里 `if (!items.length) throw new Error('返回 0 条')` ⇒ 竞速把空答复当「节点不通」⇒
等其它节点跑到 7.5s 硬闸 ⇒ 用户只看到一句无信息量的「拷贝漫画节点竞速 硬超时 7500ms」。

改法（`tools/gateway.js`）：
- 新增 `raceFirstPrefer(hosts, probe, graceMs)` + `COPY_EMPTY_GRACE_MS = 1500`：
  **第一个「非空」答案立即胜**；空答案先记住并起 grace 定时器，期间无非空结果就用这份空包 settle；
  全部失败（既无空包也无成功）才 reject。
- `probeFn` 的 `throw new Error('返回 0 条')` 改成返回 `{ base, empty: true, pack: { …, note: '上游返回 0 条（HTTP 200 + 空列表）' } }`。
- 拿到 `got.empty` 时**复核一次不带关键词的列表接口**（判据 `/api/v3/comics?limit=5&offset=0&platform=3`），
  且复核受总预算约束：`rest = Math.min(3000, COPY_HARD_MS - 400 - (Date.now()-t0))`，`rest < 900` 就跳过复核并如实说明
  （踩过坑：第一版复核把自己顶到 **8018ms**，比原来的含糊超时更差）。
- `err.soft` 只在**不是**上游空转（`e.upstreamEmpty`）时才设 ⇒ 前端 `tryVariants` 不会把上游故障当「这一级没货」反复换词。
- 前端 `assets/js/sources.js:1230-1262`：源内预算 `TOTAL_MS = 8800` + `Math.max(1500, Math.min(8200, leftMs() - 300))`
  （旧写死 7000、且第一路烧完第二路重来 ⇒ 被聚合器 `RUN_CAP_MS = 9500` 丢弃，症状也是「偶尔不返回结果」）。

**验收**（浏览器真机，3.41s 就给出诚实结论，旧代码这里是 7.5s 的含糊硬超时）：

> ✕ 拷贝漫画 失败：拷贝漫画取数失败：拷贝漫画上游返回空结果（HTTP 200 + 空列表，不是超时、也不是节点不通）：
> 候选节点（4 个：api.copy-manga.com / t66y.com / api.copy2000.online / api.mangacopy.com）都答了，
> 但连不带关键词的列表接口 /api/v3/comics 也是 0 条，而同一时刻同一条自建中继取 E-Hentai / 禁漫天堂都正常
> ⇒ 是拷贝漫画自己的检索服务在静默空转。稍后再试，或先用禁漫天堂 / 紳士漫畫 / nhentai

**未修的小瑕疵**：候选节点里混进了 `t66y.com` —— `copyApiBase(true)` 的节点发现把跳转/拦截页里的域名当成了 API 节点
并持久化到 `state.copyApiHint`。只是多一个必然失败的候选，不影响结果，但文案难看，建议下一轮收紧发现判据。

## 七、需求 3：pixiv —— 真因是出口性质，不是代码

- 链路：本机 DNS 被投毒 + TLS 按域名关键字阻断（DoH 钉 IP / ECH 都试过，`fetch failed`）。
- **决定性**：pixiv 对**数据中心出口**一律 403（正文是 Cloudflare WAF 的 `block_waf` 页；
  自建 CF Pages 中继实测 `private HTTP 403 / 372KB`）。所以「换中继」这条路在原理上就不通，**必须要住宅/家宽出口**。
- 交付物是**可执行动作**（写进 `PIXIV_DEAD_FIX`）：启动加 `--proxy http://127.0.0.1:你的端口`，或先设 `HTTPS_PROXY`
  （网关会自动探测 `7897/7890/7891/10809/10808/1080/2080/8889/8118/20171/4780/1087`），重启网关即通。
  R-18 检索另需在「设置 → 信息源 → Pixiv」填自己的 `PHPSESSID`。替代源：danbooru / kemono / nhentai。

本轮顺手修掉的两个副作用：
1. **报错串台**：`DEAD_SITE_FIX` 拆成 `EH_DEAD_FIX` + `PIXIV_DEAD_FIX`（~2298-2330）——
   旧代码两者共用一段，pixiv 搜不到时错误里会粘上整段「e-hentai 已经由自建中继打通…」。
   现在 pixiv 的报错 `has_ehentai_text = false`。
2. **16 秒吊死**：`/api/pixiv/search` 路由**没有函数级硬闸**（对比 ehentai/wnacg/copymanga 的 `*SearchInner` 都自带），
   只把 `timeout: PIXIV_BUDGET_MS (8000)` 传给 `outFetch`，而 outFetch 的超时是**逐层**的（原路→DoH→中继），
   实测被串行腿拖到 **15926ms**。
   改法：`withHardTimeout(outFetch(...), PIXIV_BUDGET_MS + 400, 'Pixiv 取数')`，并让链路层判据正则含 `|硬超时`
   （否则硬闸不触发冷却，每次搜索白烧 8.4s）。
   **实测**：第 1 次 8432ms 返回（含 `PIXIV_DEAD_FIX`），第 2 次 **5ms**（断路器 180s 冷却接管）。

## 八、附带修复：首页横幅的误报（它就是「源坏了」错觉的来源之一）

- 旧代码在 `assets/js/net.js:394-403`（两个分支）无论网关在不在，都写「先启动本地网关再点一次「检测」」。
  真机（网关明明在跑、E-Hentai / 紳士漫畫 都能搜到）横幅却这么写 ⇒ 用户以为源坏了。
- 机制：`assets/js/app.js:966` 的网探针 260ms 就启动，早于 `:968` 的 `probeGateway`（680ms），
  所以**临时结论**经常在 `GW.ok` 还是 false 时就落地；而 `app.js:109` 的 `gwHelps` 依赖 `gatewayTiers`（要等 `/api/diag`）⇒ 标题也一起退化。
- 改法：
  - `assets/js/net.js`：partial / restricted(domestic) 两分支改成
    `(GW.ok ? '本地网关已连接，正在用它逐个目标自检（DoH 钉真 IP / 中继），结论稍后自动更新—— 浏览器直连不通 ≠ 这些源搜不到，检索会优先走网关。' : '先启动本地网关…')`；
    restricted(global) 追加 `(GW.ok ? '（本地网关已连接，检索会优先走网关）' : '')`。
  - `assets/js/net.js` 新增 **pre-check**：网探针组装文案之前，若 `!GW.ok && !GW._probedAt` 就先
    `await Promise.race([GW.probe(true), 1.2s 超时])`（首次探过后不再重试）—— 光靠 `GW.ok` 条件不够，
    因为被墙目标在本机 11-16ms 就失败，临时文案常常赶在 680ms 的网关探测之前组装完。
  - `assets/js/app.js:113-118`：标题也认 `gwLive = !!(HS.net.gateway && HS.net.gateway.ok)`
    （否则会出现「描述说网关已连接、标题叫你先试网关」的自相矛盾）。
- **真机证据**（8803，hard reload 后 ~1.2s 抓到的临时结论）：
  - 描述行：「本机网络正常，但目标站点浏览器直连全部失败（典型的 DNS 污染 / 区域限制）。**本地网关已连接，正在用它逐个目标自检，结论稍后自动更新；检索会优先走网关。**」
  - 最终结论（约 8s 后）：「部分目标站点不可达（其余已由本地网关打通）」+「6/7 个目标站点可达（其中 4 个由本地网关打通：mangadex、nhentai、wnacg、hitomi），其余（Danbooru）连网关也打不通…」

## 九、验收与回归

- `node tools/check-all.js` = **9 套件全绿 / 446 条断言 / 失败 0**：
  concept 41 · cardtags 33 · scroll 39 · glass 70 · reader 49 · recent 28 · dict 28 · **gateway 65** · relay 93。
- 本轮新增/加强的断言（`tools/gateway-check.js` 第 17 轮 F/G 节 + D 节 pixiv 三条）：EH 封禁倒计时与文案、
  EH/PIXIV_DEAD_FIX 拆分、pixiv 函数级硬闸、前端 ehentai 判定顺序、前端 wnacg `null`/`[]` 拆分、
  前端 copymanga 源内预算、wnacg 批次地板与真 0 条语义、copymanga `raceFirstPrefer` 与列表复核、横幅 GW.ok 分支与 pre-check。
- `tools/relay-check.js`：旧的 EH 冷却断言按 `ehDownMs` 语义更新；4 条「设置向导 CLI」在本沙箱下
  `spawnSync` 报 **EPERM**（禁止用管道捕获子进程输出），改成**如实 SKIP**而不是伪装 FAIL。
- 浏览器端到端（真机）：`✓ 禁漫天堂 8 条 2.85s / ✓ 紳士漫畫 8 条 3.20s / ✓ E-Hentai 8 条 4.44s /
  ✓ LectorManga 4.58s / ✓ nhentai 4.63s / ✓ Danbooru 5.59s / ✕ 拷贝漫画 3.41s（诚实报错）`，汇总「已收到 45 条 · 完成源 6/7」。

## 十、你需要手动做的两件事

1. **重启网关**：你现在浏览器里的 `127.0.0.1:8788` 还是**旧进程**（前端静态文件与网关逻辑都是旧的），
   所以本轮修复在你看到这份报告时**还没生效**。关掉那个进程，重新跑 `node tools/gateway.js`（或 `start-engine.cmd`），
   再刷新页面。（本轮所有真机验收都是在另起的 8801/8802/8803 实例上做的，没有动你的 8788。）
2. **pixiv 要一个住宅/家宽出口**：给网关加 `--proxy http://127.0.0.1:你的端口`，或先设 `HTTPS_PROXY` 再启动。
   没有这个出口，pixiv 在原理上就连不上（数据中心 IP 一律 403）。R-18 还要填 `PHPSESSID`。

## 十一、遗留 / 下一轮可做

- `t66y.com` 混进 copymanga 候选节点（节点发现判据太松，会把拦截页里的域名当 API 节点）。
- 拷贝漫画上游若恢复，本地无需再改；若长期空转，可考虑在 UI 上把该源标注为「上游故障」而不是每次报错。
- 紳士漫畫的镜像抖动只能靠冷却自愈；若要更进一步，可把 `www.wnacg02.cc`（快但索引不同）单独标注为「索引 A/B」。
- 用户 8788 重启后建议再跑一次浏览器端到端（本轮已在同源新实例上验过）。
