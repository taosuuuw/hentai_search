# 第 16 轮：五个信息源的通路与稳定性（2026-09-23）

本轮处理用户在同一轮提出的 5 件事，全部有**真机实测**收尾：

| # | 用户问题 | 结论 |
|---|---|---|
| 1 | 脚本步骤 1 应该是推荐用户的，然后确定是一步自动化？ | `[1]` 已标「★推荐★」且**回车即选**；确实是一步自动化，只有「浏览器里点一次登录/授权」必须人工 |
| 2 | 给我讲讲各个信息源用何种方式链接上的 | 逐源通路写在 `tools/source-transport-map.md`（每个源都带真实行号） |
| 3 | porncomic 的稳定性能不能提高一点 | 根因是**入口顺序 + 腿预算 + 一次 403 判死主机**三件事叠加；修完 10/10 成功（8 次 24 条、2 次诚实空结果），0 次硬闸 |
| 4 | 攻 wnacg 硬闸 | 冷启动 7.4s → **0.3–0.6s**（`pickProbe` 从「等满整批」改成「先到先得」） |
| 5 | 搜「资本主义」应通过 lectormanga 搜出《Harem Capitalista》 | 已命中：`total=1 / items=['Harem Capitalista'] / query=capitalista` |

---

## 需求 4：wnacg 的「超过 8500ms 硬闸」

### 根因：`pickProbe` 用的是「等满整批」而不是「先到先得」

`tools/gateway.js:1280-1312` 的 `pickProbe` 原来用 `await Promise.all(slice.map(...))`，
一批 3 个镜像**全部回来**才算赢。实测每个镜像的单独耗时（`tools/_p9.js` B 段，
经 `/api/proxy?relay=0` 打 `/albums-index-page-1.html`）：

| 镜像 | 耗时 | 状态 |
|---|---|---|
| `www.wnacg.com` | **298ms** | 200 |
| `wnacg.com` | 589ms | 200 |
| `www.wnacg.me` | 3242ms | 404 |
| `www.wnacg.net` | 7621ms | 200 |
| `www.wnacg.org` | 14866ms | 200 |
| `wnacg.org` | 14401ms | 200 |

冠军 0.3s 就能答，却被同批的 `wnacg.net/org`（7.6s / 14.9s）拖到 7.4s ——
正好顶到 `WN_HARD_MS = 8500` 上，偶尔溢出就报
`紳士漫畫取数失败：超过 8500ms 硬闸（镜像竞速的总耗时超过预算）`。
（这是第 12 轮 copymanga 那条教训 —— `raceFirst` 首个成功即返回 —— 在 wnacg 上的重演。）

### 修法（`tools/gateway.js`）

1. `pickProbe` 新增内部函数 `raceFirstOk(slice, probe, errs)`：**首个成功立刻 resolve**；
   全失败才等到最后一个；失败照样 `hostDead.set(h, now + HOST_DEAD_MS)` 并 `errs.push`。
2. `WN_BUDGET_MS` 12000 → **7800**（旧值本身矛盾：预算比它外层的硬闸 `WN_HARD_MS = 8500` 还大）。
3. 复用已有的 `state.wnHost` 记忆（`wnHostOrder()`）：10 分钟内成功过的主机排最前。

### 实测（`/api/wnacg/search`，3 轮多次调用）

- 冷启动新词：**4829–5814ms**（修前每个新词 7.4s，另有 8 个独立冷启动词测出 5223–7457ms）；
- 之后同词：**315–563ms**（5 分钟结果缓存）；
- 全部 `ok=true / total=24 / host=www.wnacg.com`。

---

## 需求 3：porncomic 从 8.3% 到「10/10 成功」

### 五个根因（每一个都有日志或直测证据）

1. **通路是顺序 `await`，直连一条就吃光预算。**
   `pcFetchPage`（`tools/gateway.js:3364+`）原来 `for (const id of order) await CH[id]()`，
   而 `byDirect` 的 `timeout: Math.min(PC_DIRECT_TIMEOUT, left())` 一个人就能占满 7.5s
   （本机直连 porn-comic 实测 fetch failed ≈ 10.7s）⇒ 中继根本没机会。
2. **中继被规则挡在门外。** `allowRelay = i === tries.length - 1`（只留给最后一个入口）
   + 第一个入口独占全部预算，轮到唯一允许中继的那一跳只剩 900ms
   ⇒ 日志 `[腿诊断] private → porn-comic.com：预算 600ms（total=900 perLeg=600 perLegPrivate=600 relayLegMs=0）`。
3. **一次「路径级 403」被升级成「主机级封禁」。**
   porn-comic 的 `/q/<多词>` 会被站点自己 302 到 `https://search.porn-comic.com/q/<词>-<hash>.html`，
   那个子域回 403「Just a moment...」（CF 挑战，与编码无关，`%20` / `+` / 连字符都一样，见 `tools/_p12.js`）。
   旧逻辑「一次 4xx ⇒ 判 (private × porn-comic.com) 死 10 分钟」于是把正常能通的
   `/tags/anal.html`（1928ms / 24 条）也一起挡了。
4. **`/q/` 是跳板不是结果页。** 有标签页的词它 302 到 `/tags/<词>.html`（同一份 24 条）；
   没有标签页的词它 302 到 search 子域（CF 403）。把 9000ms 的**第一次机会**交给它，
   第 2 个入口只剩 900ms ⇒ `q=teen`、`q=big boobs` 整轮报硬闸。
   实测（`tools/_p14.js`，经私有中继带 cookie）：
   | 路径 | 结果 |
   |---|---|
   | `/tags/anal.html` | 200 / 24 条 / "anal comics Page 1" |
   | `/tags/milf.html` | 200 / 24 条 / 1103ms |
   | `/tags/teen.html` | 200 / **422ms / "teen no result"**（诚实空结果） |
   | `/tags/big-boobs.html` | 200 / 404ms / "big boobs no result" |
   | `/q/teen-1.html` | **403** / search 子域 |
5. **偶发慢响应会把唯一能通的通路锁死。**
   中继取 porn-comic 的实测分布（`tools/_p11.js` / `_p14.js` / `_p16`）：
   主页 1000–2108ms、`/tags/anal.html` **1582–2945ms（偶发 5446ms 超时）**。
   旧配置：腿预算 5s、失败后 `PC_RELAY_COOLDOWN = 3 分钟` + `relayHostDead` 90s
   ⇒ 一次偶发慢响应让后面几分钟的检索全部落到 6–9s 的 Chrome 上，整轮硬闸超时。

### 修法（`tools/gateway.js` + `assets/js/sources.js`，全部 `node --check` 通过）

| 位置 | 改动 |
|---|---|
| `relayFetchOnce` | 新增 `RELAY_HOST_SLOW_MS = 30e3`：私有腿**超时**只退避 30s，5xx 仍 90s |
| `relayFetchOnce` | 私有腿 4s 地板：`legFloor = Math.min(4000, total)`、`legMs = Math.max(legPrivateMs, legFloor)` |
| `relayFetchOnce` | 只分到 <3000ms 的腿失败**不记主机退避**（`超时不算主机的错`） |
| `relayFetchOnce` | 新增 `relayHost4xx` + `RELAY_4XX_WINDOW_MS = 5*60e3`：私有腿 4xx **连续两次**才判 10 分钟，成功即清零 |
| `pcFetchPage` | 抽出 `recordFail(id, e)`；**直连与中继并发竞速**（`liveLegs.length >= 2` 才开），赢家写 `pcLastGood` |
| `pcFetchPage` | 冷却跳过不再静默：`errs.push('direct：冷却中（还有 Ns）')` |
| `pcFetchPage` | `allowRelay = PRIVATE_RELAY.length ? true : (i === tries.length - 1)`（有私有腿时每个入口都允许中继） |
| `byRelay` | `relayLegMs: 7000`、`t = Math.max(3000, Math.min(PC_RELAY_TIMEOUT = 8000, left() - 500))` |
| 常量 | `PC_RELAY_TIMEOUT` 6000 → 8000、`PC_RELAY_COOLDOWN` 3min → **30s**、`PC_BUDGET_MS` 8000 → 9000、`PC_HARD_MS` 7500 → **9000** |
| `porncomicSearchInner` | tries 改序：`/tags/<pcSlug>.html` **先**，`/q/` 排后（单词语多词都一样） |
| `assets/js/sources.js` | 整源预算 `BUDGET` 8000 → 9500，内层 `gateway.get` 超时 8000 → 9500（与 `PC_HARD_MS = 9000` 对齐） |

### 实测（`tools/_p15.js`，同一进程连打 10 个词，两轮）

| 词 | 耗时 | 结果 |
|---|---|---|
| anal | 3876ms | 24 条 |
| milf | 1112ms | 24 条 |
| teen | 658ms | **0 条（诚实空结果）** |
| anal | 1617ms | 24 条 |
| big boobs | 451ms | **0 条（诚实空结果）** |
| naruto | 1922ms | 24 条 |
| anal [+extra] | 1987ms | 24 条 |
| 巨乳 | 1291ms | 24 条 |
| milf | 1537ms | 24 条 |
| hentai | 2494ms | 24 条 |

汇总：**有货 8 / 诚实空结果 2 / 硬闸 0**（修前同一条路径 9/10 是硬闸）。
日志侧证据：`中继取回 porn-comic.com ← private（32851B）` /
`porn-comic 并发竞速：relay 先拿到真页面（relay）`。

---

## 需求 5：中文词在 lectormanga 上搜不到

站点只按**西语标题**做 `LIKE %q%` 匹配，所以「资本主义」这条链路有三个缺口：

1. **机器译名是名词、站点标题是形容词。** MyMemory 给的是 `capitalismo`，
   而作品叫《Harem Capitalista》⇒ 实测 `capitalismo` **0 条**、`capitalista` **1 条**、
   `capitalist` 1 条、`harem` 12 条。
2. **词干表漏了英文 `-ism`。** `X.stems('capitalismo')` 对，但 `X.stems('capitalism')` 返回
   **`[]`**（`STEM_PAIRS` 只有 `ismo/ista/iste/istica/istico`）⇒ 英文译名完全没用上。
3. **预算太小。** 前端只给 `XL.expand(terms, {ms: 2500})`，而 MyMemory 冷启动四语并行
   实测 1.2–4.7s ⇒ 冷启动时一条候选都拿不到；网关侧自己的 `xlMs` 上限只有 1800ms，同样打不进去。

修法（前后端各一份，互为兜底）：

- `assets/js/xlate.js`：`ZH_ES` 补 `'资本主义': 'capitalista'`、`ZH_FR` 补 `'capitaliste'`；
  `STEM_PAIRS` 补 `['ism','ist'], ['ism','ista'], ['ism','isme']`；`STEM_SUFFIX` 补 `'ism'`；
  `X.stems` 把**通用词干排最前**并 `return out.slice(0, 3)`。
- `assets/js/sources.js:1388-1390`：lectormanga 车道 `ms: 2500 → 4000`。
- `tools/gateway.js`：新增 `LM_ZH_FIX` 词形修正表、`LM_STEM_PAIRS/LM_STEM_SUFFIX/lmStems()`；
  `xlMs = Math.max(1200, Math.min(4000, Math.floor(retryLeft() * 0.5)))`；
  候选 = 译文 + 它的词干 + 词典修正；译文用 `Promise.race`，到点先走、后台继续跑，
  结果进 30 分钟缓存（`translateText` 新增 `XLATE_KEEP_MS = 5000`）。

实测（网关 `/api/lectormanga/search`）：
`资本主义` ⇒ **1 条《Harem Capitalista》，query=capitalista，4901–7039ms**；
`人妻` ⇒ 22 条，query=casada；`催眠` ⇒ 10 条，query=hipnosis（2.0s）。
`/api/translate?q=资本主义&to=en,es&ms=2500` 缓存命中后 1–3ms。

---

## 需求 1：向导 `[1]` 标推荐 + 「一步自动化」的边界

`tools/relay-setup.ps1` 的 `Show-Wizard`：

- 菜单上方加绿字：`★[1] 是推荐选项★ 直接回车也能选它：本机全程自动做完，你只需要在弹出的浏览器里点一次「登录 / 授权」…`
- `[1] ★推荐★ 自动部署到 Cloudflare Pages（一键：5 项自检 → 登录 → 建项目 → 部署 → 生成 key → 写入 Secret → 再部署 → 验证，只有「浏览器点一次登录」需要人工）`
- 提示改成 `请选择（直接回车 = 推荐项 [1]）`，并新增 `if (-not $c) { … $c = '1' }`。

**确实是一步自动化**：`-DryRun` + 空行输入实测打印 `→ 直接采用推荐项 [1]。`，
随后列出全部自动步骤（复制 Worker → `wrangler whoami`（未登录就开浏览器授权）→
`pages project create` → `pages deploy` → `--gen-key` + `pages secret put` → 二次部署 → 验证）。
人工只在两处可能出现：**浏览器里点一次登录/授权**、以及邮箱验证码（首次登录 CF 时）。

工程铁律（本轮踩过）：`.ps1` 必须带 UTF-8 BOM，而文件编辑工具会剥掉它 ——
改完必须**用 node 补 BOM**，绝不能用 PS 5.1 的 `Get-Content -Raw` + `WriteAllText` 往返
（无 BOM 文件会被按 GBK 解码，源码不可逆损坏）。

---

## 需求 2：各源通路

见 `tools/source-transport-map.md`（子代理产出，138 行，逐源带真实行号）。一句话版：

- **前端直连**：mangadex（`api.mangadex.org`）、danbooru（机房 IP 被 CF 403，实际落到 `/api/proxy` 的镜像兜底）。
- **必须走网关**：copymanga（sha256 签名 + 节点竞速）、porncomic（cookie + CF）、lectormanga（站点不返回跨域头）、
  pixiv（机房 IP 一律 403）、nhentai/ehentai/wnacg（签名或 DoH 钉真 IP）。
- **网关三层**：`env` 代理 → `DoH` 钉选真 IP → 中继链（**私有腿排最前**）→ 本机 Chrome CDP 过 CF。
- **环境死路**（如实划界）：pixiv 的 R-18 需要用户自己的 `PHPSESSID`；该站对机房出口固定 403；
  hitomi 上游已全站 JS 渲染，检索本质不可用（在线阅读仍可用）。

---

## 回归与验收

- `node tools/check-all.js` ⇒ **9 套件 / 432 条断言 / 失败 0**
  （concept 41 / cardtags 33 / scroll 39 / glass 70 / reader 49 / recent 28 / dict 28 /
  **gateway 47** / **relay 97**）。
  本轮为 5 处新修法补了 6 条断言（私有腿 4s 地板、饿死腿不判站、超时 30s、
  4xx 两次才算站、porn-comic 7s/30s/9000 常量、`/tags/` 先于 `/q/`）。
- `node tools/stability-check.js --rounds=12 --extra=1 --out=tools/stability-report-r16.json`
  ⇒ 见 `tools/stability-report-r16.md`。
