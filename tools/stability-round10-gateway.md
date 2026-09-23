# 第 10 轮 · 信息源连通性/稳定性修复报告

- 目标：让网关（`tools/gateway.js`）各信息源检索在真机上尽量稳定、成功率尽量高。
- 改动范围：**只改了 `tools/gateway.js`**（另新增 5 个 `tools/r10-*.js` 只读探针）。没有碰 `assets/**`、`index.html`、`tools/stability-check.js`、`tools/live-probe.js`；没有 `git commit`；没有碰你跑在 8788 上的旧网关。
- 复测方式：所有验证都走网关自己的 HTTP 接口（本沙箱直连外网被限：`api.mangadex.org` TLS 失败、`danbooru.donmai.us` DNS 失败，只有经网关的「直连 → DoH 钉 IP → 中继」才能碰上游）。
- 所有数字都是**实测**（`tools/stability-run/` 下的 json/md 是原始记录），没有一处「我觉得应该好了」。

---

## 0. 一句话结论

**7 个源里有 6 个的真实问题都找到了根因并改掉了**，其中 **danbooru 的「三层降级里最外层压根执行不到」是真 bug**（`/api/proxy` 把异常吞成 502，导致专门为 danbooru 写的 Cloudflare 兜底是死代码）；**lectormanga 从 0% 提到 58%（中文作品名译词兜底，实测火影忍者→Naruto 9 条命中）**；**ehentai 与 danbooru 从「假装 0 条 / 假报 502」变成如实报「网络层连不上」**，并且不再把整轮检索拖到 10s 以上。

唯一**在当前网络环境下无法真正连通**的是 **e-hentai 的搜索页**（三条腿全灭：原路 fetch failed、DoH 没给出能验真的 IP、中继冷却），已按你的要求 4 改成**capMs 内快速明确失败**（12 轮全部 ≤10ms 返回，不再每轮烧 5.4s）。

---

## 1. 口径先说清楚（否则会把数字读歪）

1. **压测表里「每源耗时」不等于网关耗时。** `tools/stability-check.js` 对某些源自带第二条腿：nhentai 会再直连 `nhentai.net/api/v2/search`、danbooru 会再自己直连一次、wnacg 会自己扫 11 个镜像。所以 after 表里 `nhentai max=12758ms`、`danbooru max=12011ms` 是**压测工具自己那条腿**的时间。网关侧现在都有硬预算，见第 4 节。
2. **绝对延迟受网络窗口影响极大。** 同一份代码，after4 是 67s/12 轮全部 ≤10s 的健康窗口，after6 是 111s/7 轮触 cap 的坏窗口；before 是 45s 的顺风窗口。所以本报告**以「失败形态的变化」为主、绝对耗时为辅**。
3. **`（失败）` 与 `有响应但0条` 是两种完全不同的失败**：前者是连不上/报错，后者是站点确实回了「没有这个结果」。第 8 轮报告里 ehentai 的 84 轮「空结果」和 lectormanga 的 88 轮「空结果」其实**混了这两种情况**，这正是要修的东西。

---

## 2. 逐源根因（附原始证据）

### 2.1 danbooru：0%，全是「假 502」 —— 真 bug，已修

**证据（before 压测第 3 节 + 单打）：**
```
danbooru  0%  硬失败 12  p50 14ms  max 5561ms   (失败)×12
×12  网关代理：HTTP 502
```
`p50 只有 14ms` 就是线索：真的去请求 danbooru 不可能 14ms 回来。

**根因（两层）：**
1. `tools/gateway.js:1492-1495` 的 `proxyFetch` 里有 `deadHosts` 短路：某个 host 近期失败过就**直接 throw**（`xxx 近期取源失败，已临时跳过（Ns 后可重试）`），`DEAD_MS=180e3`。danbooru 一旦失败一次，之后 3 分钟每次都是毫秒级 throw。
2. `/api/proxy` 原来是 `const r = await proxyFetch(...)`，**一 throw 就冒到顶部 sendErr → 502**，于是紧跟着那段「danbooru 命中 CF 挑战就走 `cfFetchWithSolver` 兜底」的代码**永远执行不到**（死代码）。这就是第 8 轮 65 次 `HTTP 403` / 33 次 `HTTP 502` 的来源。

**修法**：`tools/gateway.js:6390-6460`。先 `try/catch` 住 `proxyFetch` 的异常（`netErr`），再判断 `danJson = DANBOORU_CF_HOST_RE.test(stripHost(want)) && /\.json(\?|$)/i.test(want)`，兜底条件从 `r.status>=400 && …` 改成 **`danJson && (!r || r.status>=400)`**，并把已有响应作为 `pre:` 传给兜底；兜底也失败且 `!r` 时才回 502，错误文案里写明「danbooru 在当前出口被 Cloudflare 挑战、本机没有可用 Chrome」。

**实测效果（after6 探针，`r10-probe-after6.json`）：**
```
[db-main]  200  597ms  len=19424  found="id"     ← 真数据（从未出现过的成功形态）
[db-safe]  200    2ms  len=19424                 ← 命中代理缓存
[db-safe-alt] 200 722ms len=3215 found="id"
```
同时**冷启动 5 连测**（`tools/r10-dan5.js`，每次换 tag 绕开缓存）如实记录：
```
[maid/cat_ears/swimsuit/glasses/school_uniform] 全部 403 CF挑战页（0.6–2.8s）  冷启动成功 0/5
```
→ 结论：**我改的那条兜底通道现在真的会执行**（before 它 100% 执行不到），冷启动能否过 CF 是**不稳定**的（0/5），所以压测里 danbooru 仍是 8.3%。**没有把它伪装成成功**。

> ⚠ 归属说明（避免虚报战功）：`r10-probe-after6.json` 里那次 `200 / 597ms / 19424 字节真 JSON` **不一定全是我这条路径的功劳**。当前 `tools/gateway.js` 里还有一段**我这次会话之外加进去的** danbooru 镜像适配器（`:3749-3900`，`BOORU_MIRRORS = tbib/xbooru` + `danbooruMirrorQuery()`，把 gelbooru 系的标签口径映射成 danbooru `posts.json` 的字段，见该处注释），它同样能让 `/api/proxy` 回真数据。**我这轮只负责「让 CF 兜底不再是死代码」这一半**；镜像那半不是我的改动（旁边还有 `:2064-2111` 的 Chrome `cfPinRules` 也一样）。两半都在文件里、都实测有效。

### 2.2 ehentai：16%（第 8 轮）→「11 轮空结果」其实大部分是连不上

**证据（探针 `eh-raw-zh`，直接打 `/api/ehentai/search`）：**
```
eh-search-zh  200 5434ms  （ok:true / 0 条）        ← 旧形态：把「连不上」说成「0 条」
eh-raw-zh     502 5415ms  取不到 e-hentai.org：原路：fetch failed；
                          直连强化：DoH 没给出能验真的 IP；
                          中继：中继全失败：allorigins 冷却中；allorigins-get 冷却中
```
**根因：**
1. e-hentai 的搜索页在当前出口**三条腿全灭**（真不可达，不是配置问题）。
2. 函数尾把「一次页面都没取到」和「取到页面但 0 条」混在一起，回 `ok:true + searchZero` → 前端显示「0 条结果」，用户/压测都以为站点只是没结果。
3. 预算形同虚设：三段各自的 timeout 之外，`outFetch` 内部还要串行跑「直连 × 多解析器 DoH 钉 IP × 2 个中继」，**实测冷启动 15875ms**（预算才 6000ms），整轮墙钟就是被它拖过 10s 的。

**修法（`tools/gateway.js:4924-5175` 区段）：**
- 新增 `EH_NET_COOLDOWN_MS = 180e3` 与 `ehNetDownUntil / ehNetDownWhy / ehNetDownEgress`（**断路器**）。
- `ehentaiSearch` 改成外层**硬闸**：`Promise.race([ehentaiSearchInner(query), guard])`，`guard` 在 `EH_BUDGET_MS+600` 时 reject；catch 里写断路器并返回 `ok:false`，文案明确写「这是**网络层**失败，不是「0 条结果」」。
- `:5015` 断路器命中时**毫秒级**返回同一结论（且校验 `egress` 没变，避免换了出口还拿旧结论）。
- 新增 `let gotPage = !!html`：搜索腿/中继腿/种子腿**任一**真取到页面就置 true；函数尾 `if (!gotPage)` → 报网络层失败（不再 `ok:true + searchZero`）。「真页面 + 0 条」才继续走 `searchZero`。
- 每段超时收紧：搜索腿 `Math.max(800, Math.min(EH_STEP_SEARCH, left()-300))`，中继腿条件 `left()>1800` + `Math.max(800, Math.min(EH_STEP_RELAY, left()-400))`，种子腿 `left()>1200`。

**实测效果（after6）：**
```
ehentai 0%  硬失败 0  有响应但0条 12  p50 8ms  p95 9ms  max 9ms
×1 连不上 E-Hentai（137 秒内不再重试）：…原路：fetch failed；直连强化：DoH 没给出能验真的 IP；中继：中继全失败…
```
→ 成功率还是 0%（**上游确实连不上，不编造成功**），但**耗时从 p50 5439ms 降到 8ms**，12 轮全部毫秒级、不再占用 cap，也不会再让用户以为「只是没搜到」。

### 2.3 lectormanga：12% → 58%（中文词的根本问题是「打到西语站」）

**证据：**
```
before 压测：lectormanga 0%  有响应但0条 12  p50 637ms
after4 探针：lm-en 10282ms（3 个域名 × 单域 12s）
```
**根因（两个）：**
1. **LectorManga 是西语站、只按标题匹配**，中文关键词打过去在服务端就是 0 条——这不是网络故障，是**语言问题**，所以表现为「有响应但 0 条」。
2. `lmFetchPage(selector, timeout)` 对 3 个域名各给 12s，**没有总死线**，最坏 36s（实测 10282ms），把整轮顶到 cap。

**修法（`tools/gateway.js:2996 / 3102-3160`）：**
- 新增 `LM_BUDGET_MS = 6500`（放在 `LM_DOMAINS` 旁），`lectormangaSearch` 里 `const lmDeadline = Date.now() + LM_BUDGET_MS`。
- `lmFetchPage(selector, timeout, deadline)` 新增第三参：给了就按**剩余时间**分配单域超时（`remain<900` 直接跳过该域名）。
- 新增**中文译词兜底**：`canLocalize = !!term && !extra && /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(term)`；首轮原词 0 条且 `canLocalize` 时，用 `/api/translate`（MyMemory 通道）拿西语/英语候选，逐个重搜，命中就返回并把译文写进 `query` 与 `note`；都不中则返回原来的空结果。
- 译词重试本身也被死线夹住：`RETRY_BUDGET=4000`，`retryLeft() = max(0, min(4000-(now-t0), lmDeadline-now))`，`<900` 就 `break`；`xlMs` 也按剩余时间收（**修掉 after5 里 lm-zh 8286ms 越线**）。

**实测效果：**
- 直接打接口（`/api/lectormanga/search?q=火影忍者`）：**9 条/1497ms**；`海贼王`→One Piece 6 条/1482ms；`进击的巨人`→Attack on Titan 2 条/1565ms。标签类中文词仍无效（`巨乳`→Tetas grandes 0 条）——如实保留 0 条。
- after6 压测：**lectormanga 58.3%、硬失败 0、p50 2632ms、max 6149ms（不再越 9s）**，而 before 是 0%。

### 2.4 nhentai：50% → 66.7%（健康窗口 100%）——上游 429 限流

**证据：**
```
×6 网关:nhentai 检索失败：nhentai 返回 HTTP 429（上游限流了，等几分钟再搜） / 直连:直连：fetch failed
```
**根因**：上游对同一出口 IP 限流（429），旧代码**一次就放弃**；另一个隐患是一条腿能烧到 20s（`outFetch({timeout:20000})`），可能顶穿整轮预算。

**修法（`tools/gateway.js:1578-1625`）**：新增 `NH_BUDGET_MS = 6800` + `nhLeft()`；`nhTry` 的超时改为 `Math.max(2500, Math.min(20000, nhLeft()))`；遇 429/5xx 时按 `Retry-After`（缺省 1200ms，夹在 400–2500ms）**退避后重试一次**，且只在 `nhLeft()-wait >= 1800` 时才重试，否则如实报错。

**实测效果**：after4（健康窗口）**nhentai 100%**；after6（限流窗口）66.7%，4 次硬失败全是 429 原文透传。**上游限流没法从网关根治**，只能退避 + 快速如实报错。

### 2.5 wnacg：100%，但「11 个镜像全灭」时会烧 14023ms

**证据（after3 那个坏窗口 + 你自己的复测）：**
```
wnacg 0%  硬失败 12  p50 14023ms
绅士漫画未返回结果（已试 3 条路径 / 11 个镜像：候选主机全不可用（11 个）：
www.wnacg.com：绅士镜像 www.wnacg.com 硬超时 7400ms…）
```
**根因**：镜像竞速**没有总死线**，全灭时要把 3 条路径 × 11 个镜像都试完才回结果。

**修法（`tools/gateway.js:4185 / 4285-4290 / 4313 / 4372`）**：新增 `WN_HARD_MS = 8500` 与 `WN_NET_COOLDOWN_MS = 30e3` + `wnNetDownUntil/Why`；`wnacgSearch` 改名 `wnacgSearchInner`，外层加**断路器 + 硬闸**（`Promise.race`，到 8500ms 抛 `超过 8500ms 硬闸（镜像竞速的总耗时超过预算）`），镜像全灭分支先写断路器再抛错（软失败标记 `e.soft=1`），30s 内后续请求毫秒级返回同一结论。

**实测效果**：after4 **wnacg 100%（p50 491ms、max 7423ms）**，after6 仍 100%（p50 377ms）；坏窗口里最坏耗时从 14023ms 收到硬闸内。

### 2.6 mangadex：91.7%（不改代码）

**证据**：`before 91.7%（1 轮 0 条）`、after6 `91.7%（1 轮 0 条，另 1 轮 9570ms 超时）`。唯一失败形态是**上游自己超时或真的 0 条**，网关侧是直连（`直连×11 / 网关代理×1`），**没有任何可修的网关逻辑**。如实报告，不动它。

### 2.7 jmcomic：全程 100%，未改。

---

## 3. before / after 数字对比

原始文件：`tools/stability-run/r10-gw-before.md`（before）、`r10-gw-after6.md`（after，最终代码）、`r10-gw-after4.md`（after，健康窗口）。命令统一为
`node tools/stability-check.js --base=http://127.0.0.1:8801 --rounds=12 --capMs=9500`（7 源并发、151 个真实检索词轮转）。

| 源 | before 成功率 | after 成功率 | before 硬失败/0条 | after 硬失败/0条 | before p50/max | after p50/max |
| --- | --- | --- | --- | --- | --- | --- |
| mangadex | 91.7% | 91.7% | 0 / 1 | 0 / 1 | 782 / 3992 | 673 / 9570 |
| nhentai | **50%** | **66.7%**（健康窗口 100%） | 6 / 0 | 4 / 0 | 307 / 512 | 261 / 12758\* |
| ehentai | **8.3%** | 0%（**12 轮全部毫秒级如实报错**） | 0 / 11 | 0 / 12 | 893 / 6205 | **8 / 9** |
| jmcomic | 100% | 100% | 0 / 0 | 0 / 0 | 465 / 1405 | 893 / 1991 |
| wnacg | 100% | 100% | 0 / 0 | 0 / 0 | 552 / 7426 | 377 / 7421 |
| danbooru | **0%**（全 502 假错） | **8.3%**（1 次真数据 775ms） | 12 / 0 | 11 / 0 | **14** / 5561 | 694 / 12011\* |
| lectormanga | **0%** | **58.3%** | 0 / 12 | **0 / 5** | 637 / 1548 | 2632 / 6149 |

\* = 该 max 是 `tools/stability-check.js` **自己那条直连腿**的耗时，不是网关耗时（见第 1 节口径）。网关侧现都有硬预算：nhentai 6800ms、wnacg 8500ms、lectormanga 6500ms、ehentai 6600ms 硬闸 + 180s 断路器。

整轮墙钟：before `45s / 12 轮全部 ≤10s / 0 轮触 cap`；after6 `111s / 12 轮全部 ≤10s / 7 轮触 cap`（坏窗口 + 压测工具自身的慢直连腿）。**「≤10s 轮数」两轮都是 12/12**，没有变差。

探针对照（`r10-probe-before.json` → `r10-probe-after6.json`，同名 case 可直接 diff）：

| case | before | after |
| --- | --- | --- |
| eh-search-zh | 200 / 5434ms / 假「0 条」 | 200 / 5480ms / **明确 ok:false** |
| eh-search-en（第二次） | 200 / 3ms | 200 / **3ms**（断路器生效） |
| eh-raw-zh | 502 / 5415ms | 502 / 5415ms（同样如实） |
| db-main | **502 / 6088ms** 或 403+Just a moment | **200 / 597ms / 真 JSON 19KB**（窗口好时） |
| lm-zh | 200 / 0 条 | 200 / **2394ms**（译词兜底） |
| lm-en | **10282ms** | **480ms** |
| nh-zh | 200 / 1405ms | 200 / **269ms** |
| wn-zh / wn-en | 4552 / 7417ms | 4361 / 7411ms |

---

## 4. 仍然做不到的源（如实说明，没有伪装）

| 源 | 现状 | 原因 | 现在的行为 |
| --- | --- | --- | --- |
| **ehentai** | 成功率仍 0% | 上游搜索页在本机出口**三层全灭**：原路 `fetch failed`、DoH 拿不到能验真的 IP、两个中继都在冷却 | 180 秒断路器 + 6.6s 硬闸，**毫秒级明确报错**，文案写明「这是网络层失败，不是 0 条」；期间不再拖慢其它源 |
| **danbooru** | 8.3%（窗口好时能出真数据） | `danbooru.donmai.us` 在当前出口被 Cloudflare 挑战（403 + `Just a moment` 挑战页），本机没有可用 Chrome 去过挑战 | CF 兜底分支现已**真的会执行**；过不去就 403 如实回（不再假 502） |
| **nhentai** | 66.7%（限流窗口） | 上游对同一出口 IP 429 限流 | 退避重试一次 + 6.8s 预算，429 原文透传 |
| **lectormanga** | 58.3% | 西语站只按标题匹配，**中文标签词**（如「巨乳」）译过去也确实 0 条 | 中文作品名可用译词兜底命中；标签词如实回 0 条 |

**关于 danbooru 的镜像选项**：我自己的判断是「换镜像会让永久链接失真、先不做」——因为实测可达的同源镜像只有 `safebooru.org`(892ms)、`tbib.org`(1004ms)、`xbooru.com`(4571ms)、`yande.re`(8255ms)，它们**不复刻 danbooru 的 post id**，而 `assets/js/sources.js:1959` 把永久链接硬编码成 `https://danbooru.donmai.us/posts/` + `p.id`。不过**当前 `tools/gateway.js:3749-3900` 里已经有一段不属于本会话的镜像适配器**（`BOORU_MIRRORS = tbib/xbooru`，把 gelbooru 系字段映射成 danbooru `posts.json` 的形状，并明确排除 `safebooru`——因为它的 rating 恒为 safe，会被前端「只要成人向」的过滤条件滤成 0 条，属于假成功）。那段适配器与我的 CF 兜底修复**并存且互补**，你要不要留由你决定；我的报告不替它背书。

---

## 5. ⚠ 必须告知你的一件事：这个工作区里**同时还有别的 round-10 活动在改同一个文件**

- 我**没有写入**的情况下，`tools/gateway.js` 的 mtime 自己变过（`06:26:06 → 06:29:09 → 06:29:15`），会话里也两次出现 `cannot edit … file changed since it was read`。
- `tools/stability-run/` 与 `tools/` 下存在**一批不是本会话产出的 round-10 文件**，而且**和我自己的文件交错在同一分钟内**：`r10-boormirror.js`(6:16:06)、`r10-mirror2.js`(6:17:57)、`r10-mirror3.js`(6:21:40)、`r10-tbib-thumb.js`(6:22:16)、`r10-eh-hosts.js`(6:22:16)、`r10-danprobe.js`(6:33:27)、`r10-tbib-check.js`(6:34:09)、`r10-gw-final.md`(6:37:18)、`r10-lead-after*.json`(6:27-6:38)、`r10-mirrorload.js`(6:38:59)。（我自己的是 `r10-probe.js`、`r10-booru.js`、`r10-reach.js`、`r10-relay.js`、`r10-dns.js`、`r10-dan5.js`、`r10-probe-after*.json`、`r10-gw-before/after*.md`。）
- 代码里 `:2064-2111`（Chrome `--host-resolver-rules` 钉 IP）与 `:3749-3900`（danbooru 镜像适配器）也标着「第 10 轮」，但**不在我的改动清单里**（我是子 agent，只改「信息源稳定性」这一块，本沙箱起不了 Chrome）。现场同时有 3 个 node 进程。
- 结论：**第 10 轮很可能有 lead/其它 sibling 在同一个工作区并行改 `tools/gateway.js`**。我的 7 处改动在最后一次 `grep` 时都还在，最终复测也是在最终文件上跑的；但**重启前请确认锚点还在**（见第 8 节第 5 条），以免两边的改动相互覆盖。

---

## 6. 改动清单（全部在 `tools/gateway.js`，都可回滚）

`grep -n "第 10 轮" tools/gateway.js` 可看到全部锚点。分组如下：

| # | 位置（最终文件实测行号） | 改了什么 |
| --- | --- | --- |
| 1 | `:1578-1625` | nhentai：`NH_BUDGET_MS=6800` + 429/5xx 按 `Retry-After` 退避重试一次（注释 `:1582`） |
| 2 | `:2996` | 新增 `LM_BUDGET_MS=6500` |
| 3 | `:3075-3079` | `lmFetchPage(selector, timeout, deadline)` 新增死线参数（`remain<900` 跳过该域名、单域超时按剩余时间收） |
| 4 | `:3102 / 3116 / 3124 / 3148-3160` | lectormanga：`canLocalize` 中文译词兜底 + `lmDeadline` 总死线 + `RETRY_BUDGET=4000` + `xlMs` 夹住译词超时 |
| 5 | `:4185 / 4285-4290 / 4313 / 4372` | wnacg：`WN_NET_COOLDOWN_MS=30e3` + `WN_HARD_MS=8500`、`wnacgSearch` 外层断路器+硬闸、`wnacgSearchInner`、镜像全灭分支写断路器后快速失败 |
| 6 | `:4924-4929 / 5031-5037 / 5060 / 5074 / 5114 / 5122 / 5146 / 5165 / 5170` | ehentai：`EH_NET_COOLDOWN_MS=180e3` 断路器（带 egress 校验）、`ehentaiSearch` 外层硬闸、`ehentaiSearchInner`、每段超时收紧、`gotPage` 区分「网络层失败」与「真 0 条」 |
| 7 | `:6390 / 6404-6420 / 6453-6460` | `/api/proxy`：`try/catch` 住 `proxyFetch` 异常 + `danJson = DANBOORU_CF_HOST_RE.test(...) && /\.json(\?|$)/i.test(...)`，兜底条件改 `(!r \|\| r.status>=400)`，不再把 danbooru 的 CF 兜底吞成 502 |

语法检查：每次改完都跑 `node --check tools/gateway.js` → `exit=0`。

新增的只读探针（`tools/` 下，不影响网关）：`r10-probe.js`（16 条固定 case，出 json）、`r10-booru.js`（12 个 booru 候选）、`r10-dns.js`、`r10-reach.js`（DNS/SNI 可达性）、`r10-relay.js`（中继实测）、`r10-dan5.js`（danbooru 冷启动 5 连测）、`r10-show.js`。

---

## 7. 你需要动手做的事

1. **重启网关新代码才生效**（我起的 8801 测试网关已收掉，你 8788 上跑的仍是旧代码）：
   - `start-engine.cmd`，或
   - `powershell -File tools/start-gateway.ps1`，或
   - 手动 `node tools/gateway.js --port 8788`（注意：**必须空格分隔**，`--port=8801` 这种写法网关不认，会退回 8788）。
2. 重启后想自查，可打：`/api/ping`（活着）、`/api/diag`（每个源现在到底通不通、靠哪一层通）、`/api/ehentai/search?q=巨乳`（应看到明确的「连不上 E-Hentai…网络层失败」而不是「0 条」）。
3. 若之后网络环境变化（挂上能用的 VPN/代理），ehentai 的 180s 断路器会因出口变化自动重新探测（短路条件里带了 egress 校验），不用手动清。
4. 是否要把 danbooru 换成可达镜像，需要你拍板（我列了代价，见 4 节末）。

## 8. 剩余风险

1. **绝对延迟随网络窗口剧烈波动**（同一份代码 67s 与 166s 两种窗口），成功率单次跑波动 ±2 个轮次，不能拿一次 12 轮当铁证——这也是我跑了 6 轮 after 的原因。
2. **ehentai 在本环境仍是 0%**，只是从「假 0 条 + 每轮 5.4s」变成「真失败 + 毫秒级」。要真出结果，需要一条能过 e-hentai 的出口（代理/VPN 或可用的中继）。
3. **ehentai 的 180s 断路器偏保守**：这 3 分钟内即使出口恢复也不会重试。若你觉得恢复太慢，把 `:4929` 的 `EH_NET_COOLDOWN_MS` 调小即可（例如 `60e3`），代价是每次冷启动多烧 5.4s。
4. **danbooru 的 CF 兜底不稳定**（冷启动 0/5，偶发 200），这是 Cloudflare 侧决定的，网关无法保证；文件里另有镜像适配器（`:3749-3900`，非本会话改动）提供第二条路。
5. 第 5 节的**并发写入风险**：同一工作区还有别的 round-10 改动在写 `tools/gateway.js`。重启前请先 `node --check tools/gateway.js` 并 `grep -n "第 10 轮" tools/gateway.js`，确认上面第 6 节的 7 组锚点还在。

---

# 附录 A（第二轮 · 同日更晚 · danbooru 主战场）

> ⚠️ 本附录由**同日第二个 round-10 会话**追加，正文 §1-§8 原样保留不改。两份报告写的是**同一文件的不同区块**，合起来才是完整改动。正文里若干行号已被本轮改动**整体下移**，见 A.5。

## A.1 本轮只动了两件事：danbooru 的镜像兜底链、nhentai 再加一次退避

正文 §8 第 4 条说「danbooru 的 CF 兜底不稳定（冷启动 0/5），网关无法保证；另有镜像适配器（`:3749-3900`，非本会话改动）」。本轮把那条镜像链**修通并实测 12/12 = 100%**，所以「danbooru 要不要留、镜像要不要换」这个待拍板项可以结案：**保留，它就是 danbooru 现在的主路径。**

三个根因（都有原始证据）：

**(1) 空正文被误判为「主机挂了」**（决定性）
- 原始证据：网关日志反复出现 `↑ 上游回空正文（HTTP 200）：{"date":…,"server":"cloudflare",…}`；即 tbib/xbooru 回 **HTTP 200 + 0 字节**。
- 旧链路后果：空正文被 `outFetch` 的 `guardEmpty`（`tools/gateway.js:748-757`，`EMPTY_SHELL_COOLDOWN=60e3` 在 `:1444`）当失败 → 60 秒空壳冷却 → 之后每次请求都「刚被空壳拒过，冷却中」→ 主机进 `deadHosts`（日志 `tbib.org 近期取源失败，已临时跳过（45s 后可重试）`）→ 镜像梯队全灭 → 转回原链 `danbooru.donmai.us`（CF 403）→ `cfFetchWithSolver` 起本机 Chrome → `Chrome 没能启动（调试端口未就绪）`+90 秒冷却 → 单发磨到 12009~12017ms 后失败（12 轮里 tbib 只成功过第 1 轮）。
- 性质判定：**gelbooru 系 dapi 对「没有这个标签」的答复就是 200 + 0 字节**（不是 `[]`），**不是限流**。证据 `tools/stability-run/r10-mirrorload.json`：同样的两个镜像用 6 个**存在的英文标签**连打 12 发 —— **tbib 12/12 成功、空壳 0、平均 12 条（冷 253~831ms）；xbooru 12/12 成功、平均 12 条（冷 201~220ms）**，20 秒后第二遍全部命中缓存 1~3ms。
- 修法：`booruMirrorPage(m, tagStr, qy, budgetMs)`（`tools/gateway.js:3856`）改用 `proxyFetch(url, 'https://'+m.host+'/', {allowEmpty:true, timeout: budgetMs||4500})`，把「200+空正文」如实当作**该页 0 条**返回 `[]`，不再触发空壳冷却、不再拉黑主机。

**(2) 中文词在英文标签库里当然是 0 条**
- 压测工具送的是中文（巨乳/人妻/催眠/…），tbib/xbooru 标签库是英文 ⇒ 全是空壳。
- 修法：新增词典 `BOORU_CJK_TAGS`（`tools/gateway.js:3933`，30 条**实测验证过**的词条）+ `booruTagDict(tags)`（`:3947`，按 `/\s,、，+/` 切词、**每个词都命中才返回**、多词空格连接 = dapi AND 语法）+ `booruTagToEnglish(tags, budget, tried)`（`:3970`，词典未命中才走机器翻译 `xlateOne`，译文与已试候选重复则丢弃）。`danbooruMirrorFetch`（`:3990`）候选顺序 = **词典标签 → 原词 → 机器译文**，命中即停，`Date.now()-tAll > 7000` 提前收手。
- 英文查询行为**逐字节不变**（`booruTagDict` 对英文返回空串 ⇒ 候选表里只有原词）。
- 词典只用实测**存在**的标签：big_breasts / breasts / wife / milf / married / cheating / netorare / hypnotic / hypnosis / hypnotism / tentacles / maid / megane / glasses / swimsuit / pantyhose / black_thighhighs / nurse / teacher / miko / sister / kimono（`tools/stability-run/r10-tagcheck.json`、`r10-tagcheck2.json`）。实测**不存在/拿不到**：glasses_girl / swimwear / black_pantyhose / shrine_maiden / older_sister / onee-san / onee_san / yukata / stockings / thighhighs。
- 机器翻译单独用只有约一半命中（人妻→`wife_and_husband`、眼镜娘→`glasses_female` 都是 0 条），所以词典优先。

**(3) 缩略图扩展名写死**
- 原始证据：`thumbnail_<md5hash>.jpg` → 404、`/samples/...` 全 404；而 `thumbnail_<image>` 里的 `image` 字段**已经带扩展名**（`tools/stability-run/r10-tbib-check.json`）。
- 修法：`booruRowUrls`（`tools/gateway.js:3811`）把缩略图扩展名**强制 .jpg**：`const stem = img.replace(/\.[a-z0-9]+$/i,''); const thumb='https://'+m.host+'/thumbnails/'+dir+'/thumbnail_'+stem+'.jpg'`。修完封面 12/12 可用（image/jpeg，个别 image/png）。

**成人向补救**（前端 `assets/js/results.js:857-858`：默认成人向模式 `out = out.filter(i => i.adult !== false)`，safe/general 全被滤掉 ⇒ 用户看到 0 卡）：镜像这一页**有内容但一条 q/e 都没有**时，补打一次 `tags + ' rating:explicit'`（tbib 实测认：`maid rating:explicit` → 20 条全 explicit）。

**nhentai 再加一次退避**：把正文 §6 第 1 条的「退避重试**一次**」改成**最多两次**（`NH_WAITS = [900, 2600]`，`tools/gateway.js:1608`；`NH_BUDGET_MS=6800` 在 `:1589`），仍受总预算夹住；`nhLeft()-wait < 1800` 就 break 并如实报错；取页函数改名 `nhTryFetch` 避免与计数器撞名。

## A.2 before / after（同一个 `tools/stability-check.js`，12 轮、capMs=9500、7 源并发、12 个中文词）

before = `node tools/stability-check.js --base=http://127.0.0.1:8801 --rounds=12 --capMs=9500 --out=tools/stability-run/r10-gw-before.json`（22:11:24Z）
after = 同命令换 `--base=http://127.0.0.1:8825 --out=tools/stability-run/r10-gw-after2.json`（22:46:23Z）

| 源 | before 成功率 | before p50/max | after 成功率 | after p50/max | 说明 |
| --- | --- | --- | --- | --- | --- |
| **danbooru** | **0%**（12 硬失败） | 14 / 5561ms | **100%**（0 硬失败 0 空） | 748 / 1256ms | 路径「网关代理×12」，全部 tbib.org 12 条 |
| nhentai | 50%（6 硬失败=429） | 307 / 512ms | 83.3%（2 硬失败=429） | 277 / 6637ms | 两次退避后仍有残留限流 |
| ehentai | 8.3%（11 空） | 893 / 6205ms | 0%（12 空，但已是「明确的网络层失败」） | 4 / 6621ms | 本机不可达，见 A.4 |
| lectormanga | 0%（12 空） | 637 / 1548ms | 58.3%（0 硬失败 5 空） | 2437 / 5777ms | 连通正常，空是「中文词无对应作品」 |
| mangadex | 91.7%（1 空） | 782 / 3992ms | 91.7%（1 空） | 566 / 732ms | 直连 |
| jmcomic | 100% | 465 / 1405ms | 100% | 815 / 2044ms | |
| wnacg | 100% | 552 / 7426ms | 100% | 1640 / 7438ms | |
| **7 源平均** | **50.0%** | 整轮 p50 1150ms | **76.2%** | 整轮 p50 4306ms | |

整轮：before 12/12 ≤10s、0 轮触 cap、min/p50/p95/max = 723/1150/7428/7428ms；after **12/12 ≤10s、0 轮触 cap**、min/p50/p95/max/avg = 1766/4306/7454/7454/5173ms。
after 的整轮 p50 反而变大是**成分效应**：before 里 danbooru/nhentai 是「毫秒级失败」（danbooru p50 14ms = deadHosts 短路），把分位拉低了。

## A.3 逐源原始错误原文

**danbooru**
- before（12 轮全是）：`网关代理：HTTP 502`（同轮还有 `danbooru.donmai.us` CF 403 → `Chrome 没能启动（调试端口未就绪）`）
- after（12 轮全绿）：HTTP 200、12 行、`mirror=tbib.org`、262~1256ms、封面 12/12 image/*
- 反例（不该用的镜像）：`safebooru.donmai.us` → 403 `Just a moment...`（5.9KB CF 挑战页）；`gelbooru.com` → 502 `取不到 gelbooru.com：…原路：fetch failed；直连强化：DoH 没给出能验真的 IP；中继：中继全失败：allorigins 连不上：timeout；allorigins-get 连不上：timeout`；`yande.re` 0/12 全 502（`取不到 yande.re：原路：fetch failed；…`，首打 19790ms）

**ehentai**（`tools/stability-run/r10-probe-after.json`）
- `/api/ehentai/search` → 200 但 `{"ok":false,"source":"ehentai","via":"none","total":0,"items":[],"cached":false,"ms":0,"error":"连不上 E-Hentai（110 秒内不再重试）：连不上 E-Hentai 搜索：取不到 e-hentai.org：原路：fetch failed；直连强化：DoH 没给出能验真的 IP；中继：中继全失败：allorigins 冷却中；allorigins-get 冷却中"}`
- `/api/proxy?url=https://e-hentai.org/…` → 502 5419ms `取不到 e-hentai.org：原路：fetch failed；…`；随后 502 2ms `e-hentai.org 近期取源失败，已临时跳过（45s 后可重试）`
- `/api/diag` → `ehentai {"ok":false,"ms":14428,"error":"…"}`；`pixiv` 同样 false/15478ms

**lectormanga**（连通正常，是「没数据」不是「连不上」）
- zh：200 2460ms `{"source":"lectormanga","host":"lector-mangas.lat","total":0,"items":[],"via":"env","empty":true,"query":"巨乳"}`
- en：200 539ms `total:9`（naruto）

**wnacg / nhentai / jmcomic / mangadex**：200（`www.wnacg.com` 24 条、nhentai 3379 条、jmcomic 10000 条）

## A.4 仍然不通的源 + 为什么 + 你能做什么

1. **ehentai = 本机网络层不可达，不是代码问题。** 证据链（全部本轮实测）：
   - `tools/stability-run/r10-dns.json`：系统 DNS 对 `e-hentai.org` **ENOENT**；DoH（doh.pub）能给真 CF IP `172.66.140.62 / 172.66.132.196`；但带 SNI 做 TLS → **ECONNRESET（237ms）= 按 SNI 关键字阻断** ⇒ 钉 IP 这条路**永远走不通**。exhentai.org 解析是投毒值（Twitter 段 104.244.43.136 / 69.63.190.26）→ timeout。cloudflare-dns.com / quad9 / dns.google 的 DoH 全 timeout；alidns 返回投毒值。
   - 中继：15 个公共中继只有 `allorigins` 曾成功取到 `https://e-hentai.org/`（HTTP 200、63167B 真页面），但**耗时 16682ms ≫ 9.5s 预算**且极不稳定，其余全灭（12.5s 超时 / 401 需 key / 429 / 400 / ENOTFOUND）。
   - 网关内已有书面证据：从境外出口（AWS 54.255.249.22）E-Hentai 搜索对**任何** query/UA/header/cookie/浏览器都返回 `No hits found`，而 `/`、`/popular`、`/toplist.php`、`/torrents.php?search=` 都正常。
   - ⇒ **你需要挂一个能过 e-hentai 的代理/VPN**（或在网关侧配置可用中继）。本机现有三条腿（直连 / DoH 钉 IP / 公共中继）全都到不了。
2. **lectormanga 不是故障**：它是**纯西语站**，中文词自然 0 条（`q=naruto` → 9 条）。网关已加「中文词取机器译文再打一次」兜底，但译文命中率有限。看到 lectormanga 无结果时，换西语/英文词即可。
3. **nhentai 偶发 429**：上游限流，已做 2 次退避 + 缓存，成功率 50% → 83.3%。剩余 2 次属上游行为，等几分钟再搜即可。
4. **danbooru 现在 100%**（走 tbib.org 镜像），但它是第三方镜像，标签库是英文的，中文词靠网关词典 + 机器翻译。词典没收录的新词可能仍 0 条 —— 需要时把词加进 `BOORU_CJK_TAGS`（`tools/gateway.js:3933`）。

## A.5 请你注意（重要）

- **必须重启网关**：你浏览器里跑的 8788 仍是**旧代码**。`start-engine.cmd`，或 `powershell -File tools/start-gateway.ps1`，或手动 `node tools/gateway.js --port 8788`（**端口必须空格分隔**，`--port=8788` 这种写法网关不认）。
- **行号整体下移**：本轮在 danbooru 区块插了约 110 行，正文 §6 表格的行号已漂移，例如 nhentai `:1578-1625` → `:1589-1620`、`/api/proxy` `:6390-6460` → `:6488-6503`；文件现为 **6660 行**。用 `grep -n "第 10 轮" tools/gateway.js` 重新对锚点最稳。
- **踩坑记录（做取证时别踩）**：用 `/api/proxy` 打一个**不存在的标签**（普通路径没传 `allowEmpty`）会把「200+空正文」当失败，主机进 45s 黑名单，之后一串请求全 502/124B。批量取证要等 45s 或换新实例。
- 本轮验证实例：`http://127.0.0.1:8825`（后台 job pwsh-219，可关）。本轮新增只读探针：`r10-danprobe.js`（按前端 `assets/js/sources.js:1941-1966` 的拼法判据 + 真拉封面）、`r10-mirrorload.js`（镜像抗压）、`r10-tagcheck.js`（标签存在性）、`r10-tbib-check.js`（缩略图扩展名）。
- 每次改完都跑 `node --check tools/gateway.js` → `exit=0`。

## A.6 一行摘要

**danbooru 从 0%（12 轮全 502）修到 100%（12 轮全 200、12 条、p50 748ms），7 源平均成功率 50.0% → 76.2%，整轮 12/12 全部 ≤10s；ehentai 经证据判定为本机网络层不可达（SNI 阻断 + 中继全不可用），需你提供代理/VPN。**
