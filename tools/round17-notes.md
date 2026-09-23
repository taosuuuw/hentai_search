# 第 17 轮工作笔记：四源退化 + pixiv 连接

> 临时工作笔记（收尾时并进正式报告）。记录「已改 / 已验 / 待办」，防止上下文压缩丢线索。

## 用户诉求（原话）
1. ehentai 总是不返回结果、绅士偶尔不返回结果
2. copymanga/jmcomic 这三处退化修复
3. pixiv 并未连接
硬要求：用 browser 插件亲自看网页。

## 已经落地的修改

### tools/gateway.js
- `DEAD_SITE_FIX` 拆成 `EH_DEAD_FIX` + `PIXIV_DEAD_FIX`（~2298-2330）：pixiv 报错里不再粘 e-hentai 段落；「怎么办」改成可执行动作（`--proxy http://127.0.0.1:端口` / `HTTPS_PROXY`）。校验：`cors.eu.org x0`。
- `ehBodyErr` 封禁分支重写（~5369-5396）：不再写死「中继（cors.eu.org）」；调用 `ehBanLeftMs(b)` 把上游倒计时写进文案。
- `ehHtml`（~5406-5415）：封禁页时 `ehBanUntil = Date.now() + banLeft + 3000`，正常 200 时清零。
- 新增 `ehBanUntil` / `ehBanLeftMs(body)`（`/ban expires in\s*([^.<]{1,80})/i` + h/m/s 求和）/ `ehDownMs()`（max(25s 或 180s, min(30min, 封禁剩余))）/ `ehDownSecs()`（~5870-5915）。
- 两处 `ehNetDownUntil = Date.now() + ehNetCooldownMs()` → `+ ehDownMs()`；两处文案的 `(ehNetCooldownMs()/1000)` → `ehDownSecs()`。
- `WN_READER_HOSTS` 重排（~4952-4965，注释带实测证据）：`['www.wnacg.com','wnacg.com','www.wnacg02.cc','www.wnacg03.cc','www.wnacg05.cc','www.wnacg01.cc','www.wn03.ru','www.wn04.ru','wnacg.ru','www.wn07.ru','www.wnacg.date']`。
- 新增 `WN_BATCH_MIN_MS = 1000`（~5110-5127）+ 根因注释：`per = Math.max(2000, …)` 的**地板与 left() 无关** ⇒ 第二批仍拿 2000ms ⇒ 跑到 ~9800ms ⇒ 撞死外层 `WN_HARD_MS = 8500`。
- `wnacgSearchInner` 收口：`if (left() < 1800) break;`（原 2500）；`per = Math.max(700, Math.min(WN_HOST_MS, left() - 700));`（原地板 2000）；`deadline: t0 + WN_BUDGET_MS - WN_BATCH_MIN_MS`。
- wnacg「真 0 条」与「源挂了」分开：`let pageOk`，`/gallary_item|aid-\d+|no-result|No\s*Results?/i` → `pageOk = true`；0 条抛 `path.split('?')[0] + ' 返回 0 条'`；`if (!merged.length && pageOk)` 返回 `{total:0, items:[], note:'…这一页确实 0 条结果…'}` 且**不写缓存**。
- wnacg 冷却文案去复读：`wnNetDownWhy = why.replace(/[?&][A-Za-z_]+=[^\s；)]*/g, '').replace(/\s+/g, ' ').slice(0, 160)`。
- copymanga：`COPY_ATTEMPT_MS = 7200`（旧 6000）、`COPY_HARD_MS = 7800`（旧 6500）；新增 `copySearchCache` / `COPY_CACHE_MS = 5*60e3`（键 `q|page|limit`，容量 60，raw 不读写，0 条不写缓存）；`copymangaSearch` catch 文案加「等 1–2 分钟再搜一次通常就通了」，`err.soft = 1`。

### assets/js/sources.js
- `ehentaiSearch`（~962-977）：`directAnswered = true` 从封禁判定**之前**挪到**之后**（旧写法「先置成功标志→下一行抛错→catch 吃掉→标志没回滚」⇒ 尾部 `return []` ⇒ UI 显示「✓ E-Hentai 返回 0 条」）。判定改 `/temporarily banned|Your IP address has been|excessive request rate/i`，抛 `'E-Hentai 按出口 IP 限流封禁（这不是「0 条结果」）'`。
- `wnacgSearch` 的 `gwWn`（~1795-1810）：`if (!res || !res.ok) return null;` → `const items = gwItems(...); if (!items.length) return []; return items;`（`[]` 是真值 ⇒ 短路掉「10 镜像 × 3 路径」的浏览器兜底）。
- `copymangaSearch`（:1230-1262）：新增源内预算 `const t0 = Date.now(); const TOTAL_MS = 8800; const leftMs = () => TOTAL_MS - (Date.now() - t0);`，`run` 超时 `Math.max(1500, Math.min(8200, leftMs() - 300))`（旧写死 7000）。

## 已验（第二个网关实例 `node tools/gateway.js --port 8799`，后台 job pwsh-34）
- **wnacg 修好**：人妻 5258ms ok:true 24 条 host=www.wnacg.com（旧 8560ms 撞死 8500ms 硬闸）；巨乳 1504ms 24 条；催眠 3392ms 24 条。
- **ehentai 正常**：anal 3402ms ok:true 25 条 via='search'。
- **jm 正常**：催眠 2961ms total=8464 80 条 host=www.cdnhjk.net。
- **copymanga 仍失败**：7513/7516/7514ms，ok:false「拷贝漫画节点竞速 硬超时 7500ms」。
- e-hentai 静默 390s 后实测：`478ms HTTP 200 bytes=70230 rows=26 banned=false` ⇒ **封禁是我们自己的重试刷出来的窗口**，冷却按倒计时走即可。

## ★copymanga 定论★
上游故障，不是本地代码：
- 三个官方节点对**任何**查询都回 `200 + {"code":200,"message":"请求成功","results":{"list":[],"total":0}}`（83B / 91B）。
- 连**不带 q 的列表接口** `/api/v3/comics?limit=5&offset=0&platform=3` 都是 total=0（决定性）。
- 8 词 × 3 节点 = 24 次全空；海贼王/ワンピース/one piece/火影忍者 全空；网页版 API 也空。
- 同一时刻同一条私有中继：e-hentai 200/70525B、jm 80 条 ⇒ 本机网络与中继正常。
- 4 组头（白名单 / 全量检索头 / 阅读器 light 头 / 无头）结果完全一样 ⇒ **签名与头转发不是根因**。
- 其它出口全灭：direct fetch failed、cors.eu.org 429、allorigins 500/超时、allorigins-get 502/47s。
- 浏览器也打不开 mangacopy.com（标签变成 `chrome-extension://…/site_status_block_page.html`）。
- 结论：**能修的只有「把沉默伪装成超时」这件事** —— 现在把「200 + 空」当节点失败，于是白等 7.5s 再报一句无信息量的硬超时。

## 待实施的 copymanga 修复方案（a-e，尚未落地）
- (a) 新增 `raceFirstPrefer(hosts, probe, graceMs)`：第一个**非空**答案立即胜；空答案先记住并起 `COPY_EMPTY_GRACE_MS`（~1500ms）定时器，期间无非空结果就用这份空包 settle；全部节点都失败（既无空包也无成功）才 reject。
- (b) `probeFn` 里 `if (!items.length) throw new Error('返回 0 条');`（tools/gateway.js:1959）改成返回 `{ base, empty: true, pack: { source:'copymanga', host: base, total: res.total || 0, items: [], note: '上游返回 0 条（HTTP 200 + 空列表）' } }`。
- (c) `copymangaSearchInner` 的 `got = await withHardTimeout(raceFirst(bases, …), left0 + 300, '拷贝漫画节点竞速')`（tools/gateway.js:1965）换成 `raceFirstPrefer(bases, h => probeFn(h, left0), COPY_EMPTY_GRACE_MS)`；`got.empty` 时抛**非 soft** 诊断错（说清三个节点 + /comics 列表都空、同一中继同一时刻 e-hentai 200/70KB、建议稍后重试或换源）。
- (d) `copymangaSearch` 的 catch 只在**不是** `e.upstreamEmpty` 时设 `err.soft = 1`（否则前端 `tryVariants` 会把上游故障当「这一级没货」反复换词）。
- (e) `COPY_ATTEMPT_MS=7200` / `COPY_HARD_MS=7800` 保持不变。

## 其它待办
- 补 `tools/gateway-check.js` 断言（wnacg 地板/0 条语义、copymanga 空答复、e-hentai 倒计时文案）。
- `node tools/check-all.js` 回归（基线 9 套件 / 432 断言 / 失败 0）。
- 浏览器端到端复验（要在**用户的 8788** 上，所以必须先重启网关）。
- **用户的 8788 仍是旧代码** ⇒ 收尾必须显眼告知「重启网关」。
- jmcomic 的「退化」症状仍没定位（实测健康：12 域名 11 通、80 条/次）。
- pixiv 无代码解：需用户挂代理（`PROXY_PORTS=[7897,7890,7891,10809,10808,1080,2080,8889,8118,20171,4780,1087]`、`EGRESS_TARGET='e-hentai.org:443'`、`ensureEgress()` tools/gateway.js:66-86，在 :7413 调用）。
- 首页横幅「先启动本地网关再点一次「检测」」措辞误导（网关其实在跑，那是浏览器直连探测）。
- 收尾：`job_kill pwsh-34`（我的 8799 实例）、停掉 browser session。

## 沙箱坑
- `git status` 被拒；`Get-CimInstance Win32_Process` 被拒。
- node 探针必须**前台**跑：带管道 `node x.js | Out-String` 报 `Program 'node.exe' failed to run: Access is denied`；后台 job 跑同一脚本会 exit 0 但无输出。
- 本机是 Windows PowerShell 5.1；`Select-String` 嵌引号会 ParserError，用 `node -e`。
- `tools/*.ps1` 必须带 UTF-8 BOM（write/edit 会剥掉 BOM）。
