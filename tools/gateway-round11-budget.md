# 第 11 轮 · 需求 3「所有信息源稳定 + 高速」预算整改记录

> 目标（用户原话）：「所有信息源都应该正常连接检索，并且具有高稳定性和高速响应」。
> 本文只讲**检索链路的时间预算与如实报错**，阅读器（需求 1/2）见
> `tools/reader-zoom-anchor-round11.md`。
> 所有数字都是本机真机实测，`tools/stability-report*.md` 是原始报告。

---

## 0. 一句话结论

改前：30 轮里有 **26 轮撞满前端 9.5s 聚合闸**，copymanga p50 **17.3s**（结果全部被丢弃）、
nhentai 成功率 **43.3%**、porn-comic 最长 **20s**。
改后（12 轮验收）：**12/12 轮都在 10s 内**，copymanga **0% → 75%**（p50 1642ms）、
porn-comic 的失败被封在 7.5s 内、nhentai 在网关侧被 8s 硬闸如实截断。
另有两条**环境死路**（e-hentai、pixiv）与一条**上游改版**（hitomi 全站 JS 渲染）
不是代码能修的，本文如实划界，并把「假成功」改成「有原因的失败」。

---

## 1. 基线（改前，`tools/stability-report.md`，30 轮 × 11 源，cap 9500ms）

| 指标 | 改前 |
| --- | --- |
| 整轮 ≤10s | **4 / 30**（26 轮撞满 9500ms） |
| min / p50 / p95 / max / avg | 6197 / 9507 / 9515 / 9537 / 9261 ms |
| nhentai | 43.3%，max **19019ms** |
| copymanga | p50 **17319ms**、max 21000ms（>9.5s ⇒ 结果永远被丢弃） |
| porn-comic | 25%，max **20010ms** |
| ehentai / pixiv | 0%（出口 IP 限制 / 缺用户自己的 PHPSESSID） |
| hitomi | 报 100%（**探针误报**，见第 6 节） |

---

## 2. 根因：每一层都「软」，叠起来必然超预算

1. **前端聚合器是硬闸**：`assets/js/sources.js:2236` `S.RUN_CAP_MS = 9500`；
   到点未回的源标成「超时跳过」，**迟到的结果直接丢弃**
   （`assets/js/sources.js:2362` `if (drop()) return null;` 与 `:2373-2386`）。
2. **网关每层都是软超时**：拷贝漫画原来只有一句 `timeout: 12000` 串行试节点，
   而且「节点发现」`copyApiBase()` 还跑在预算计时**之前**——
   实测发现接口自己就要 1.9~3.7s，于是整条路 3000+5489+4337 ≈ **12.8s**，
   任何硬闸都形同虚设。
3. **前端超时值和网关预算不对齐**：nhentai 前端给 30s（`assets/js/sources.js:777` 原值），
   而聚合器 9.5s 就丢弃 —— 30s 纯属白等，还把真实错误埋在「超时」里。
4. **失败信息失真**：`/api/proxy` 把异常吞成 502（第 10 轮已修）、
   拷贝漫画「所有节点都失败」时看不到**每个节点各自的**原因（本轮修）。

---

## 3. 改动清单（5 处）

| # | 位置 | 改动 |
| --- | --- | --- |
| 1 | `tools/gateway.js:1550` `copymangaSearch` | 外套函数级硬闸 `COPY_HARD_MS + 200 = 6700ms`（前端单次 7000ms，`assets/js/sources.js:1232-1234`），错误带 `err.soft = 1` |
| 2 | `tools/gateway.js:1571` `raceFirst` | 新增「第一个成功者胜」的竞速。**不能**用 `pickProbe`：它用 `Promise.all` 等整批落地，批里有一个 10.7s 才失败的死节点，2.2s 就成功的那个也要陪跑到底 |
| 3 | `tools/gateway.js:1590` `copymangaSearchInner` | 所有候选节点（上次跑通的 → 上次发现的 → 3 个内置兜底）**同时**发出去竞速；节点发现改为**关键路径之外**（结果只写 `state.copyApiHint` 给下一次用） |
| 4 | `tools/gateway.js:1406` `copyApiBase(asHint)` | 新增 `asHint` 参数：发现结果只记 hint，**绝不改写** `state.copyApi`（那是「上次真跑通」的节点，比未验证的发现结果可信） |
| 5 | `tools/gateway.js:1795 / :3046`、`assets/js/sources.js:770-777` | nhentai 网关硬闸 8000ms、porn-comic 硬闸 7500ms；前端 nhentai 超时 **30000 → 9000ms**（对齐 9.5s 聚合闸，让它有时间把真实错误带回来） |

常量：`COPY_ATTEMPT_MS = 6000`、`COPY_HARD_MS = 6500`、`COPY_DISCOVER_MS = 5000`（`tools/gateway.js:1533-1546`）。
`HOST_DEAD_MS = 90e3`（`tools/gateway.js:1068`）不变：失败节点 90s 冷却，避免同一轮反复撞。

---

## 4. 复测（`tools/stability-report-r11b.md`，12 轮 × 11 源，2026-09-23T07:59:53Z）

整轮：**12 / 12 ≤10s**（cap 只被轮 1、3、11 触及）；
min / p50 / p95 / max / avg = **4764 / 6396 / 9525 / 9525 / 7143 ms**。

| 源 | 成功率 | 硬失败 | 有响应 0 条 | p50 | p95 | max | 主要路径 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| mangadex | 83.3% | 1 | 1 | 1405 | 13007 | 13007 | 直连×10 |
| nhentai | 58.3% | 5 | 0 | 577 | 12656 | 12656 | 网关×7 |
| ehentai | 0% | 0 | 12 | 10 | 3892 | 3892 | 网关×12 |
| jmcomic | 91.7% | 0 | 1 | 1248 | 11893 | 11893 | 网关×12 |
| wnacg | **100%** | 0 | 0 | 1654 | 7535 | 7535 | 网关×12 |
| danbooru | **100%** | 0 | 0 | 927 | 3087 | 3087 | 网关代理×12 |
| lectormanga | 50% | 0 | 6 | 4465 | 5819 | 5819 | 网关×12 |
| copymanga | **75%** | 0 | 3 | 1642 | 6359 | 6359 | 网关×12 |
| pixiv | 0% | 0 | 12 | 15 | 10702 | 10702 | 网关×12 |
| porncomic | 58.3% | 0 | 5 | 6303 | 7564 | 7564 | 网关×12 |
| hitomi | 0% | 0 | 12 | 458 | 1447 | 1447 | 网关代理×12 |

> `max` 列有 >10s 的值（mangadex 13007 / jmcomic 11893 / nhentai 12656）是**源自己的**耗时；
> 该轮仍在 9.5s 聚合闸内结束（迟到结果被丢弃，用户不会干等）。这是聚合器设计如此。

逐源观察：
- **copymanga 0% → 75%**：9/12 拿到真实结果，p50 1642ms。
  3 次空是上游限流（原文 `Request was throttled. Expected available in 6 seconds.`），
  已按既有规则给该节点 90s 冷却。
- **porn-comic**：成功时 6.3s 左右；4 次失败全是「超过 7500ms 硬闸」——
  **失败也是有答复的失败**（改前是 20s 空转）。
- **nhentai**：成功的 p50 只有 577ms，5 次硬失败全写在错误里
  （`原路：fetch failed；直连强化：DoH 没给出能验真的 IP；中继：cors-eu 冷却中`）——
  上游/中继波动，不是代码问题；网关 8s 硬闸保证它不再拖整轮。
- **ehentai**：12/12「有响应但 0 条」，错误原文是中继 429
  （`cors-eu 中继自己限流了（HTTP 429，53086B）`）。出口 IP 被 e-hentai 限流 ⇒ 见第 7 节。

---

## 5. 拷贝漫画这一段弯路（如实记录）

第一版我把「节点发现」砍到 1200ms 并保留「失败就清节点缓存」，结果 **0/12 全失败**。
真机取证（`tools/_copy-probe.js`，直连、不过网关）证明是我错了：

```
发现接口 api.copy2000.online/api/v3/system/network2 : 3548ms，返回节点 t66y.com
t66y.com            + 签名检索 : 10697ms 后 fetch failed   ← 发现结果在这台机器上根本不可用
api.copy2000.online + 签名检索 :  3984ms  HTTP200 code200 items=4   ← 能用
api.copy-manga.com  + 签名检索 :  2179ms  HTTP200 code200 items=4   ← 能用（最快）
api.mangacopy.com   + 签名检索 :   277ms  fetch failed
```

三个结论直接决定了最终写法：
1. **发现接口是红鲱鱼**：它花 3.5s 告诉你一个不能用的节点 ⇒ 必须挪出关键路径。
2. **能用的内置节点要 2.2~4.0s 才回话**：旧写法给竞速窗口 2543ms，
   正好把 3984ms 的那个掐死 ⇒ 单节点超时必须给足（现在 `COPY_ATTEMPT_MS = 6000`）。
3. **不能用 `pickProbe`（`Promise.all` 等整批）**：死节点 t66y.com 会让 2.2s 的成功陪跑 10.7s
   ⇒ 新增 `raceFirst` 谁先成功用谁。

复测（冷启动 + 连打 4 次，`/api/copymanga/search`）：
`5147ms ok items=4 host=api.copy-manga.com` / `2462ms items=4 host=api.copy2000.online` /
`4902ms items=30 total=158` / `2756ms items=30 total=195`。

---

## 6. hitomi：先修探针，再如实报错

- **探针误报**：`tools/stability-check.js` 原来判 `class="gallery-content"` 出现即算成功，
  但空壳页里**也有这个类名** ⇒ 每轮都报 ✅100%。已改成只认真实作品链接
  （`/g/<数字>`、`galleryThumb`、作品页路径三选一；`tools/stability-check.js:314-331`）。
- **上游事实**（`tools/_hitomi-probe.js` / `_hitomi-probe2.js`，直连 + 经网关各测一遍）：
  - `hitomi.la/search.html?query=naruto` 与 `?query=zzzznothing` 返回**字节相同**的 3687B 页，
    `/g/` 链接 0 个、`galleryThumb` 0 个、正文里连查询词都没有；
  - root / `tag/*-all.html` 一律 5789B 空壳，同样 0 个作品链接（`index.html`、`popular.html` 是 404）；
  - 直连 hitomi.la 全部 `fetch failed`（DNS/SNI 阻断），只有走网关中继才 200；
  - 对照组（经同一个网关代理取 mangadex `title=naruto` vs `title=bleach`，12976B vs 25928B）
    证明**代理没有吞掉 query 参数**——是 hitomi 自己返回空壳。
  - `tools/gateway.js:5111-5140` 早就记过同一件事：「hitomi.la 的 HTML 页面是纯 JS 壳子……
    网关没有执行 JS 的能力 —— 故 hitomi 的**检索**暂不做」。
- **因此**：`assets/js/sources.js:1886` 从「静默 `return []`」改为**如实抛错**
  （`hitomi.la 已改为 JS 渲染，HTML 里没有任何结果链接（该源检索暂不可用）`），
  适配器 `desc`/`flags` 也改成「⚠️ 上游已改为 JS 渲染……（`assets/js/sources.js:2216-2220`）」。
  hitomi 本来就 `off: true`（默认不开），在线阅读仍走 CDN 的 `galleries/<id>.js`，不受影响。

---

## 7. 环境死路（代码解决不了，如实划界）

| 源 | 状态 | 真正原因 | 需要什么才能修 |
| --- | --- | --- | --- |
| e-hentai | 搜索 0 条（12/12） | 出口 IP 被 e-hentai 限流/封禁；公共中继 cors.eu.org 被连坐 429 | 换出口（你的住宅/境外代理），或自建 CF Worker 中继（需你的 CF 账号） |
| pixiv | 连不上（12/12） | 出口 IP 被封 + R-18 需要**你自己的** `PHPSESSID` | 本机可用代理 + 你在设置里填 PHPSESSID |
| hitomi | 检索 0 条 | 上游全站 JS 渲染，静态 HTML 无结果 | 需要执行 JS 或逆向其 JS API（价值低，默认关闭） |

---

## 8. 复现命令

```powershell
# 1) 语法 + 全量回归（8 套件 329 条）
node --check tools/gateway.js ; node --check assets/js/sources.js
node tools/check-all.js

# 2) 压测（必须等号形式；本机沙箱下 node 需要 danger-full-access）
node tools/stability-check.js --rounds=12 --extra=1 --base=http://127.0.0.1:8788 --out=tools/stability-report-r11b.json

# 3) 拷贝漫画节点取证 / hitomi 空壳取证
node tools/_copy-probe.js "无修正"
node tools/_hitomi-probe.js ; node tools/_hitomi-probe2.js

# 4) 改了 tools/gateway.js 之后**必须重启引擎**（否则跑的还是旧进程）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\start-gateway.ps1 -NoBrowser
```

---

## 9. 给下一轮的入口 / 没做的事

- **没做**：给 e-hentai / pixiv 造通路（需要用户的代理或 CF 账号，属需用户决定）；
  hitomi 的 JS API 逆向（默认关闭的实验性源，ROI 低）。
- **没做**：把 `tools/stability-check.js` 加进 `tools/check-all.js` 的 `SUITES`
  （它是**联网**压测，进回归套件会让「离线也能跑全绿」失效；现在仍是手动工具）。
- **可优化但没动**：copymanga 被上游限流时（`Expected available in 6 seconds`）
  目前只能靠 90s 节点冷却；若想更稳，可以给检索结果加 2~5 分钟的短缓存
  （绅士漫画已有 5 分钟缓存 `assets/js/sources.js` 那条路径可作参照）。
- **回归断言**：`tools/gateway-check.js` 不含拷贝漫画内部结构断言（本轮改法没有对应断言），
  若下一轮再动 `copymangaSearchInner`，建议先补一条「不得用 `pickProbe` 串批等整批」的断言。
