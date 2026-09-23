# 检索稳定性实测分析（无 VPN / 网关直连出口）

> 测量者：子 agent（只测量，未改动任何现有文件）
> 被测对象：站点 http://127.0.0.1:8788 + 网关 `tools/gateway.js`（hs-gateway v1.3.0）
> 压测脚本：`tools/stability-check.js`（本轮新建）；原始数据 `tools/stability-report.json`、自动报表 `tools/stability-report.md`、补充轮 `tools/stability-run/extra-report.json`
> 用户诉求原文：「部分网点在无vpn的情况下会出现异常（比如绅士、ehentai，但绝不止），建议再次检查校验检索的高稳定性和高响应，至少100次都在10s内完成检索」

---

## 0. 结论摘要

| 问题 | 答案 |
| --- | --- |
| 100 轮里有几轮 ≤10s？ | **1 / 100**（唯一达标轮 #1，且因冒烟轮把网关缓存热过而受益，属污染样本）。整轮 p50 **14207ms**、p95 **16023ms**、max **16031ms** |
| 超 10s 的罪魁 | **ehentai 一家拖垮整轮**：99/100 轮里整轮最慢源都是 ehentai（p50 14206ms、99 轮 >10s） |
| ehentai 到底怎么了 | 100 轮**一条结果都没有**：39 轮吃满 16s 客户端超时；61 轮在 11–14s 后回 `ok:true` + `searchZero:true` + 0 条。三层通路全断（系统 DNS 污染 → 钉 IP 后 SNI 被 RST → 中继全冷却） |
| 除绅士/ehentai 还有谁「绝不止」 | **danbooru 0/100**（403 CF 挑战 68 次 / 502 deadHost 短路 30 次）、**pixiv 0/12**（HTTP 502，p50 **20.5s**）、**porncomic 0/12**（HTTP 502，2ms 快失败）、lectormanga 87% 空结果（中文词打西语站，属预期） |
| 绅士（wnacg）呢 | **100/100 成功，0 失败**，但固定 p50 **7409ms**，是整轮第二慢。它的「异常」更可能发生在**网关没在跑**的时候（见 §5.4） |
| 根因分类 | ①**本机系统 DNS 被污染/黑洞**（主因，7/20 域名 ENOENT、多个域名被投毒到 Facebook/Dropbox 段 IP）；②**e-hentai.org / www.pixiv.net 的 SNI/TLS 层被 RST**（钉对真 IP 也通不过）；③**danbooru IP 黑洞 + Cloudflare 挑战**，且网关 CF 兜底（Chrome）在当前测量环境里不可用；④**中继 allorigins 反复冷却**；⑤前端/网关预算设计让失败源把整轮拖到 16s |
| 能否做到「100 轮都 ≤10s」 | 能，但必须动 3 处预算（见 §7 P0）：把 ehentai 从 15s/13s 预算压到 ~6–8s；之后整轮上限由 wnacg 的 ~7.4s 决定，p95 有望落到 8–10s |

---

## 1. 测量环境（这决定了「无 VPN」这个前提成立）

100 轮跑完后重新抓取的 `/api/ping`（`tools/stability-run/final-ping.json`）原样关键字段：

```
egress: "直连（未检测到可用本地代理；被墙的站会走 DoH 钉 IP 或境内中继）"
egressDetail: {startup:false, startupProxy:"", liveProxy:"", mode:"direct",
               hostPlan:{"api.mangadex.org":"env","kemono.cr":"doh","api.copy2000.online":"env",
                          "nhentai.net":"doh","www.wnacg.com":"doh","hitomi.la":"doh",
                          "danbooru.donmai.us":"doh","lector-mangas.lat":"env","wnacg.com":"doh",
                          "api.mymemory.translated.net":"env","t.nhentai.net":"env","www.cdnhjk.net":"env"}}
doh: {servers:["dnspod","alidns","cloudflare","quad9"], cached:39, pinned:27}
relays: [{id:"allorigins",kind:"any",cooldownSec:15},{id:"allorigins-get",kind:"text",cooldownSec:0},{id:"i0.wp",kind:"image",cooldownSec:0}]
proxyCache: {entries:38, mb:7.8, ttlSec:300, deadHosts:2}
cfSolver: {available:false, failing:true, cooldownSec:44, renders:0, verified:false,
           lastError:"Chrome 没能启动（调试端口未就绪）。若网关在沙箱/受限环境里运行，请放行它启动浏览器进程"}
```

- `egressDetail.mode = "direct"`、`startupProxy/liveProxy` 皆空 → **本次 100 轮就是用户说的「无 VPN」条件**，第一手数据。
- `/api/diag`（`final-diag.json`）：mangadex ok/200/795ms/env、nhentai ok/200/489ms/doh、wnacg ok/200/505ms/doh、hitomi ok/200/950ms/doh、kemono ok/200/1842ms/doh、copymanga ok/200/3839ms/env、**danbooru ok(status:403)/705ms/doh**、jmcomic ok(status:403)/1519ms/env、**ehentai ok:false**（原路 fetch failed；DoH 没给出能验真的 IP；中继全失败）、**pixiv ok:false**（同上）。

### 污染与局限声明（必须打折看的地方）
1. **并发污染**：另一个 agent 同时在压测网关在线阅读/取图路径 → 绝对延迟可能被抬高（尤其 ehentai，检索与阅读共用一条串行闸门，见 §6.4）。**失败模式与鲁棒性结论不受影响**；无并发验收请用户自己再跑一遍（命令见 §8）。
2. **`cfSolver` 不可用是本轮测量环境的产物**：网关是被父 agent 在沙箱里 `node tools/gateway.js` 起的，Chrome 无法启动调试端口 → danbooru/porncomic 的「CF 挑战」兜底从未真正执行。**用户用 `start-engine.cmd` 正常启动时 cfSolver 可能可用**，这两个源的结论要按此打折（但注意到 `renders:0 / verified:false`，即便 `available:true` 时它也从未成功渲染过一次）。
3. 我的探针是 node（非浏览器）：对 **danbooru** 而言，真实前端的「浏览器直连」这条路（带 CF 通行证 + CORS）我无法复现，因此 danbooru 的失败结论成立范围 = 「node 直连 + 网关 /api/proxy」；浏览器直连那条路是否可行，取决于用户机器上 Chrome 的 DNS（见 §5.4）。

---

## 2. 一次「完整检索」到底发生了什么

- 前端默认启用 7 个源：`assets/js/core.js:45` → `['mangadex','nhentai','ehentai','jmcomic','wnacg','danbooru','lectormanga']`；`HS.sources.enabled()` 在 `assets/js/sources.js:2196`。hitomi 在注册表里 `off:true`（`assets/js/sources.js:2187`）。
- `HS.sources.run(opts)` 在 `assets/js/sources.js:2297`，全局硬上限 `S.RUN_CAP_MS = 22000`（`assets/js/sources.js:2212`），cap 命中报「超过 X 未返回，已跳过」（`assets/js/sources.js:2362`）。7 个源全部并发，谁慢谁决定整轮墙钟。
- 每源实际超时（复刻进 `tools/stability-check.js`）：

| 源 | 前端调用 | 前端超时 | 网关侧预算 |
| --- | --- | --- | --- |
| mangadex | `net.fetchSource`（直连→`/api/proxy`）`assets/js/sources.js:237-288` | per 9000 / budget 13000 | — |
| nhentai | `gwNh` `assets/js/sources.js:770-775`；失败回退 `nhDirect` 778-784 | **30000** | — |
| ehentai | `gwEh` 918 + 第二车道 927-955，`EH_BUDGET=15000` at 908 | **16000**（车道 2 用 `min(16000,left-500)`） | `EH_BUDGET_MS=13000`（`tools/gateway.js:4526`） |
| jmcomic | `assets/js/sources.js:1077-1081` | 16000 | `JM_BUDGET_MS=11000`（`tools/gateway.js:1003`） |
| wnacg | `gwWn` `assets/js/sources.js:1761-1762`；失败回退 `wnRound` 1695-1732 | 16000（内部 `leftMs()=13000-elapsed`） | `WN_BUDGET_MS=12000`（`tools/gateway.js:3861`） |
| danbooru | `net.fetchSource`（直连→`/api/proxy`）`assets/js/sources.js:1928-1931` | per 9000 / budget 13000 | — |
| lectormanga | `assets/js/sources.js:1360-1362` | 9000 | 12000（`tools/gateway.js:3001`） |
| （非默认）copymanga / pixiv / porncomic | `assets/js/sources.js:1217 / 1253 / 1292` | 35000 / 35000 / min(left,20000) | 20000（`tasks` 2649-2655） |

**关键结构性事实**：7 个源并发，整轮耗时 = 最慢源耗时。只要有一个源要等 15–16s，整轮就不可能 ≤10s。

---

## 3. 100 轮正式实测结果（`node tools\stability-check.js --rounds=100`）

- 总耗时 **1388s（23.1 分钟）**，每轮换词（151 个真实检索词轮转），网关在一次都没掉线。
- 整轮：**≤10s = 1/100**；>10s = 99/100；触及 22000ms 全局 cap = **0 轮**（说明拖时间的是 ehentai 自己的 16s 客户端超时，不是全局 cap）。
- min / p50 / p95 / max / avg = **2126 / 14207 / 16023 / 16031 / 13876 ms**。
- 「本轮最慢源」计数：**ehentai 99 次、mangadex 1 次**。
- 超 10s 的 99 轮呈两种交替形态：
  - 形态 A（61 轮，11.2–14.3s）：ehentai 在 11–14s 后返回 `ok:true + searchZero:true + 0 条`（网关走完 search→relay→torrents 三段后放弃）；
  - 形态 B（38 轮，14.1–16.0s）：ehentai 直接吃满前端 16000ms 超时 → `ok:false`。
  - 逐轮明细（词、整轮 ms）见 `tools/stability-report.md` 第 19 行起的表格。

### 每源统计（100 轮）

| 源 | 成功率 | 硬失败 | 有响应但 0 条 | p50 | p95 | max | avg | >10s 轮 | 实际走的通路 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| mangadex | 79% | 0 | 21 | 1269 | 7657 | 11374 | 2318 | 2 | 直连 94 / 网关代理 6 |
| nhentai | **100%** | 0 | 0 | 442 | 1351 | 4548 | 601 | 0 | 网关 100 |
| ehentai | **0%** | 0 | **100** | **14206** | 16022 | 16030 | 13854 | **99** | 网关 100 |
| jmcomic | 99% | 0 | 1 | 1012 | 3903 | 6398 | 1432 | 0 | 网关 100 |
| wnacg（绅士） | **100%** | 0 | 0 | **7409** | 7433 | 8019 | 5173 | 0 | 网关 100（镜像回退一次都没触发） |
| danbooru | **0%** | **100** | 0 | 662 | 5444 | 9015 | 1148 | 0 | 全失败 |
| lectormanga | 12% | 0 | 88 | 1439 | 6186 | 9006 | 2113 | 0 | 网关 100 |

### 错误原文（汇总自每源记录的原始错误字符串）

| 源 | 次数 | 错误原文 |
| --- | --- | --- |
| ehentai | 39 | `超时`（前端 16000ms 客户端超时） |
| ehentai | 61 | `via=search,searchZero;…;0 条`（网关返回 ok:true，附 `searchZero:true`） |
| danbooru | 68 | `网关代理：HTTP 403`（Cloudflare 挑战页） |
| danbooru | 30 | `网关代理：HTTP 502`（deadHost 冷却短路） |
| danbooru | 2 | `网关代理：超时` |
| lectormanga | 1 | `超时` |

`mangadex` 的 21 次不是错误，是 `HTTP 200 但 0 条`（中文标题直接打 mangadex 的预期毛刺）；`jmcomic` 1 次 0 条同理。

---

## 4. 补充 12 轮：`--extra=1`（覆盖非默认源 copymanga / pixiv / porncomic）

| 源 | 成功率 | p50 | p95 | max | >10s | 错误原文 |
| --- | --- | --- | --- | --- | --- | --- |
| copymanga | **100%** (12/12) | 2076 | 12918 | 12918 | 1 | — |
| **pixiv** | **0%** (0/12) | **20478** | 21025 | 21025 | **12** | `HTTP 502` ×11、`超时` ×1 |
| **porncomic** | **0%** (0/12) | 15 | 17371 | 17371 | 1 | `HTTP 502` ×12 |
| 其余 7 源 | 与 §3 一致 | — | — | — | — | ehentai 12/12 失败、danbooru 12/12 `403`、lectormanga 12/12 0 条 |

整轮 p50/p95/max = **20480 / 21028 / 21028ms**，12 轮全部 >10s —— **pixiv 比 ehentai 更致命**：它要 20.5s 才失败，而前端给 pixiv 的超时是 **35000ms**（`assets/js/sources.js:1253`），所以真实用户会**干等 20 秒然后拿到一个 `HTTP 502`**。
`porncomic` 是 2ms 内快速 502（连网络都没走）：

```
{"ok":false,"error":"porn-comic 没有取到结果（已试 2 条入口：/q/test-1.html / /tags/test.html）：
 /q/test-1.html：三条通路都没取到：chrome：连续 3 次起不来，已熔断 11 分钟（避免每次检索都空等）；
 /tags/test.html：… chrome：连续 3 次起不来，已熔断 11 分钟 …"}
```

→ 「绝不止绅士和 ehentai」成立：**ehentai、danbooru、pixiv、porncomic 四个源 100% 不可用**，lectormanga 87–100% 空结果（预期），mangadex 有约 20% 空结果毛刺。

---

## 5. 根因分类（含逐条证据）

### 5.1 主因①：本机系统 DNS（system resolver）被污染/黑洞 — 证据最强
`node tools\stability-run\netroot.js` 与 `dnsmirror.js`，同机系统 DNS vs 加密 DNS（DoH）对照：

| 域名 | 系统 DNS | DoH(dnspod) | 结论 |
| --- | --- | --- | --- |
| e-hentai.org | **ENOENT（解析不存在）** | 172.66.140.62, 172.66.132.196 | 系统 DNS 被污染 |
| danbooru.donmai.us | **ENOENT** | 98.159.108.61 | 同上 |
| nhentai.net | **ENOENT** | 104.26.4.188 等 | 同上（网关靠 DoH 救活） |
| hitomi.la | **ENOENT** | 185.165.169.231 | 同上（网关靠 DoH 救活） |
| www.wnacg.com | **ENOENT** | 185.45.6.103 | 同上（网关靠 DoH 救活） |
| www.pixiv.net | **157.240.17.36（Facebook 段，投毒）** | 172.64.145.17 | 系统 DNS 返回假 IP |
| exhentai.org | **ENOENT** | — | 同 e-hentai |
| api.mangadex.org（对照） | 45.129.229.1/2（与 DoH 一致） | 同 | 干净 → 这解释了 mangadex 直连 94/100 成功 |
| g.e-hentai.org | 118.107.180.216 | — | 可疑/过期 |
| www.wnacg05.cc / wnacg.com / wnacg.ru / www.wn04.ru | 31.13.106.4 / 31.13.112.4 / 157.240.21.9 / 199.59.149.237（**Facebook/Twitter 段，投毒**） | — | 绅士镜像池里 4–5 个域名被投毒 |
| www.wn03.ru / www.wnacg01.cc / www.wnacg02.cc / www.wnacg03.cc / www.wnacg.date | 172.67.x / 203.161.33.22 / 103.224.182.208 / 172.239.x / 104.21.x（看起来是真的） | — | 绅士镜像池里这几个是真 IP |
| cloudflare DoH（cloudflare-dns.com） | — | **fetch failed（不可达）** | 网关 `doh.servers` 里的 cloudflare/quad9 在国内根本用不上，只有 dnspod/alidns 有效 |

**这条是「原路：fetch failed」的直接原因**，也是为什么网关必须靠 DoH 钉 IP 才能救活 nhentai/wnacg/hitomi。

### 5.2 主因②：e-hentai.org / www.pixiv.net 的 SNI/TLS 层被 RST（钉对真 IP 也过不去）
`node tools\stability-run\pinprobe.js`——强制用 DoH 解析出的真 IP 建 TLS（SNI=真实域名）：

| 目标 | 钉的 IP | 结果 |
| --- | --- | --- |
| e-hentai.org | 172.66.140.62（Cloudflare 真 IP） | **ECONNRESET 245ms**（握手被重置） |
| e-hentai.org | 172.66.132.196 | **ECONNRESET 225ms** |
| e-hentai.org | 108.160.166.148（alidns 给的投毒 IP） | timeout 8016ms |
| www.pixiv.net | 172.64.145.17（真 IP） | **ECONNRESET 96ms** |
| www.pixiv.net | 199.59.148.97 | timeout 8008ms |
| danbooru.donmai.us | 98.159.108.61 / 199.96.59.19 | 双双 timeout 8016ms（IP 黑洞，TCP 层就被丢） |
| nhentai.net（对照） | 104.26.4.188 | **HTTP 200，12473 字节真 JSON，2021ms** |
| hitomi.la（对照） | 185.165.169.231 | **HTTP 200，921ms** |
| www.wnacg.com（对照） | 185.45.6.103 | timeout 8010ms（网关用的是别的 IP/镜像，所以它没事） |

→ 对照组证明**「DoH 钉 IP」这条路本身有效**（nhentai/hitomi 拿到了真数据）；e-hentai / pixiv 是**钉对了 IP 也被 RST**，属 SNI 关键字封锁，网关再怎么写也过不去。danbooru 是 IP 黑洞。

### 5.3 主因③：Cloudflare 挑战 + CF 兜底失效（danbooru / porncomic）
- `/api/proxy?url=https://danbooru.donmai.us/posts.json?limit=1` 实测 → **HTTP 403，正文 5883 字节全是 CF 的 `<title>Just a moment...</title>` 挑战页**（`tools/stability-run/probe-dan.json`）；`/api/diag` 里 danbooru 也是 `status:403 via:doh`。
- 网关本来有 CF 兜底（`tools/gateway.js:5908-5944`，用本机 Chrome 过挑战），但 **100 轮里它一次都没生效**：`/api/ping` 的 `cfSolver` 从起始的 `available:true` 变成结束时的 **`available:false, failing:true, cooldownSec:44, lastError:"Chrome 没能启动（调试端口未就绪）…"**，`renders:0 / verified:false`。
- 更糟的是**代码路径本身还会把兜底绕过去**：`tools/gateway.js:1485-1488` 的 deadHosts 冷却**直接 throw**，异常走外层 catch（`tools/gateway.js:5962-5965`）→ `sendErr`（`tools/gateway.js:5626`）→ **502**，而 CF 兜底的触发条件要求 proxyFetch **返回** `status>=400`——抛异常时它根本没机会跑。这解释了 100 轮里 danbooru `403`（68 次）与 `502`（30 次）交替出现的形态。

### 5.4 绅士（wnacg）为什么本轮反而正常 / 什么时候会异常
- 网关在线时：wnacg **100/100 成功，0 失败**，p50 7409ms（`WN_BUDGET_MS=12000`，3 镜像批量探测，`WN_HOST_MS=7000`）。它只是**慢**，不失败；而且 `wnRound` 浏览器镜像回退**一次都没触发**。
- 但用户报的症状是「无 vpn 时绅士异常」——最可能的场景是**网关没在跑**（我接手这个工作区时 8788 确实没有监听）。此时前端只能走浏览器直连镜像回退（`assets/js/sources.js:1695-1732`，10 个域名 × 3 条路径乱战），而 §5.1 显示绅士镜像池里 `www.wnacg.com` 是 ENOENT、`wnacg.com / wnacg.ru / www.wn04.ru / www.wnacg05.cc` 被投毒到 Facebook/Twitter 段 IP → **只有 wn03.ru / wnacg01/02/03.cc / wnacg.date 这几个域名有戏**，于是表现为「有时候能出、有时候转半天没结果」。
- 这条是**推断**（我没有也无法在网关关闭状态下测，硬约束禁止我停网关）；建议用户自己在关网关的状态下点一次绅士确认。

### 5.5 中继（relay）在并发下反复冷却 —— 出口不稳的那一半
网关错误原文（`tools/stability-run/probe-eh.json`、`probe-pixiv.json`）反复出现：

```
中继：中继全失败：allorigins 冷却中；allorigins-get 冷却中
```

`/api/ping` 里 `allorigins.cooldownSec=15`、`proxyCache.deadHosts=2`。allorigins 是**公共免费中继**，在「另一个 agent 并发压测取图」的压力下极易 429/超时 → 进冷却 → e-hentai/pixiv 唯一的绕行出口也没了。**这条是并发污染直接相关、但即使无并发也不稳的常态风险**。

### 5.6 网关自己给出的定性（原样引用 `/api/ehentai/search` 返回的 note）

```
搜索侧本次没取到页面（连不上 E-Hentai 搜索：取不到 e-hentai.org：原路：fetch failed；
直连强化：ECONNRESET；中继：中继全失败：allorigins 冷却中；allorigins-get 冷却中）。
E-Hentai 这次没给出搜索结果。两种已知原因：① **出口 IP 被搜索侧限制**（机房/数据中心 IP 常见，页面正常、搜索恒空）；
② **限流软封锁**（上游回「HTTP 200 + 0 字节」的空壳，连续请求就会触发，和请求头、cookie 无关）。
… 网关已自动改经境内中继用**另一个出口 IP** 重试过；要稳定搜索，建议把系统代理切到住宅出口节点。
兜底入口 /torrents.php?search=test 这次也没返回条目。
```

即：ehentai 的问题**同时**是「本机出口被 DNS/SNI 封锁」+「E-Hentai 搜索侧对该出口 IP 恒空」两件事叠加，网关的三段兜底全都救不回来。

---

## 6. 代码级机制（为什么失败源会把整轮拖到 16s / 为什么只能看到 HTTP 502）

1. **`outFetch` 的分层超时可以叠加**（`tools/gateway.js:707-870`）：`const ms = opts.timeout||15000`（709）、`const left = () => Math.max(2500, ms-(Date.now()-t0))`（712）——**`left()` 有 2500ms 下限、永不归零**；而它串行跑 ① tierEnv（753-773）② tierDoh `pinHost` + hsRequest（776-790）③ tierRelay（793）④ http→https 递归整个 outFetch（857-864）。EH 第一段 `EH_STEP_SEARCH=8000` 时，最坏 ≈ 8000+5000+2500+2500 ≈ **18s**，而调用方 `ehentaiSearch` 以为只花 8s。**这是 ehentai 16s 超时的根本原因。**
2. **ehentaiSearch 三段串行、全部失败也不抛**（`tools/gateway.js:4645-4752`，`EH_BUDGET_MS=13000`）：第 1 段搜索（8s）→ 第 2 段 relayOnly 换出口（4.5s）→ 第 3 段 `/torrents.php`（4.5s）；失败返回 `ok:true + searchZero:true`。所以前端看到的是「成功但 0 条」，而不是错误。
3. **前端 ehentai 还有第二条车道**（`assets/js/sources.js:908-955`）：`EH_BUDGET=15000`，只要 `items.length < limit && left() > 2500` 就再发一次「整串当标题」请求，超时 `max(2000,min(16000,left-500))`。空结果情况下这等于**白白再加一次等待**。
4. **检索与阅读共用一条串行闸门**：`ehSerial`（`tools/gateway.js:4073-4082`，相邻请求间隔 ≥ `EH_THROTTLE_MS=300`）的唯一使用者是 `ehHtml`（4114-4135），而 `ehHtml` 同时服务阅读路径（4207/4225/4235/4269/5596，timeout 12–20s）和**搜索**（4687/4712/4731）。→ **用户在读 ehentai 图集时，检索请求要排队等前面的 12–20s 图集请求，排队时间不计入 `EH_BUDGET_MS`**。这正是本轮并发压测下 ehentai 更糟的原因。
5. **路由错误风格不一致**：`/api/ehentai/search`（`tools/gateway.js:5762-5773`）、`/api/nhentai/search`（5781-5797）、`/api/wnacg/search`（5864-5873）**自带 try/catch，失败也回 HTTP 200 + `{ok:false,error}`**；而 `/api/lectormanga/search`（5804）、`/api/jm/search`（5841）、`/api/porncomic/search`（5799）、`/api/copymanga/search`（5859）、`/api/pixiv/search`（5814）**没有 try/catch**，抛出即 502。前端 `HS.net.gateway.get`（`assets/js/net.js:502-598`）只拿到 `new Error(j.error || 'HTTP '+status)` → 用户看到的就是干巴巴的 `HTTP 502`。
6. **lectormanga 的 0 条不是故障**：西语站按标题匹配（`tools/gateway.js:3012-3043` 及 3045-3059 的设计说明：`?search=人妻→0 条`、`?search=naruto→9 条`），前端本应先经 xlate 词典 + `/api/translate` 造西/英候选串。

---

## 7. 修复建议（按性价比排序，**均为建议，我一行都没改**）

> 目标校准：用户要求「≥100 次都在 10s 内」。当前整轮 = 最慢源；**只要 ehentai 还被允许跑到 13–16s，这个目标永远不可能达成**。因此 P0 就是把失败源的等待时间压进预算。

### P0-1 网关保持运行（0 代码，最高性价比）
证据：网关在线时 nhentai 100%、wnacg 100%、hitomi/jmcomic 99–100%，靠的就是 DoH 钉 IP 绕过 §5.1 的系统 DNS 污染；网关一关，这些域名在系统 DNS 里直接 ENOENT。→ 在 `start-engine.cmd` 里把网关作为默认启动项，并在前端 header 做「网关未运行」的醒目提示（`assets/js/net.js:502-598` 的 `GW.probe` 已有探测能力）。

### P0-2 把 ehentai 的等待预算砍到 6–8s（直接决定 10s 目标能否达标）
- 前端 `assets/js/sources.js:908` `const EH_BUDGET = 15000;` → **6000**；`assets/js/sources.js:918` 的 `gwEh(...,16000)` → **8000**；`assets/js/sources.js:927-933` 第二车道在「第 1 段已返回 searchZero」时**直接跳过**（现在会白等一轮）。
- 网关 `tools/gateway.js:4526` `EH_BUDGET_MS = 13000` → **6000**；并在 `ehentaiSearch`（`tools/gateway.js:4645-4752`）里**第 1 段搜索为空且 relay 不可用时立即返回**，不要白跑第 2、3 段（各 4.5s）。
- 预期收益：ehentai 从 13–16s 降到 ≤8s 后，整轮上限由 wnacg 的 ~7.4s 决定，p95 有望在 8–10s，**「100 轮 ≤10s」才第一次有可能**。

### P0-3 给 `outFetch` 加真正的总 deadline（治本）
`tools/gateway.js:709` / `:712`（`outFetch`）：把 `const left = () => Math.max(2500, ms-(Date.now()-t0))` 改成毫秒级真 deadline（`const dl = t0+ms; const left = () => Math.max(0, dl-Date.now())`），并在每层开始前判断剩余量、不足就跳过该层；`pinHost` 的 `Math.min(5000, ms)`（`tools/gateway.js:776`）也要纳入同一个预算。否则任何调用方给的超时都只是「第一层的超时」。

### P1-1 五个路由补 try/catch，统一返回 200 + `{ok:false,error}`（最便宜）
`tools/gateway.js` 的 `case '/api/pixiv/search'`（5814）、`case '/api/porncomic/search'`（5799）、`case '/api/lectormanga/search'`（5804）、`case '/api/jm/search'`（5841）、`case '/api/copymanga/search'`（5859）——照抄 `/api/ehentai/search`（5762-5773）的 try/catch 写法。收益：用户看到的从 `HTTP 502` 变成可读中文原因；前端也能区分「源故障」与「网关故障」。

### P1-2 pixiv 也要限时（现在 20.5s 才失败）
`pixivSearch` 侧没有硬 deadline（前端给 35000ms，`assets/js/sources.js:1253`）。既然 `www.pixiv.net` 钉 IP 后 **ECONNRESET 96ms**（§5.2），应让它在 6–8s 内失败并把原因（SNI 被重置）写进 error；同时前端把 pixiv 超时从 35000 降到 10000 以内。

### P1-3 deadHosts 冷却不要绕过 CF 兜底
`tools/gateway.js:1477-1516`（`proxyFetch`）的 `deadHosts` 短路（1485-1488）应改为**返回一个带标记的失败响应**（而不是 throw），或在 `/api/proxy`（`tools/gateway.js:5908-5956`）里调整判断顺序：**先给 CF 兜底一次机会**（5918-5944），兜底也失败再用 deadHost 冷却快速失败。另：`cfSolver` 不可用时，`/api/ping`（`tools/gateway.js:5662`）已经在报 `cfSolver.available=false`，前端设置页应把这条显示给用户，而不是让人以为「danbooru 坏了」。

### P2-1 ehentai 的读图/检索分闸（或给搜索让路）
`tools/gateway.js:4073-4082` 的 `ehSerial` 是全局串行链，`ehHtml`（4114-4135）同时服务阅读（12–20s）与搜索。建议给搜索一条独立闸门（或低优先级跳队），否则「一边读图一边检索」必然超时。

### P2-2 绅士（wnacg）提速 + 镜像池体检
`wnacgSearch`（`tools/gateway.js:3950-4024`）固定 ~7.4s：`WN_HOST_MS=7000` + 3 镜像批量 + 3 条路径。在 ehentai 被压到 8s 后，wnacg 就成为新的 p95 瓶颈。建议：① 把「镜像可用性探测结果」缓存起来（现在只缓存搜索结果，换词场景等于没缓存）；② 前端 `WN_DOMAINS`（`assets/js/sources.js:1568-1571`）里 `www.wnacg.com / wnacg.com / wnacg.ru / www.wn04.ru / www.wnacg05.cc` 已被投毒或 NXDOMAIN（§5.1），应从回退池里降权/剔除，减少无谓的镜像乱战。

### P3 用户侧网络（不改代码）
① 把 Windows 的 DNS 换成 DoH（如 `https://doh.pub/dns-query`；实测 dnspod/alidns 可用，`cloudflare-dns.com` 在本网络不可达）；② 若要 ehentai 搜索可用，网关自己的建议是「切到住宅出口节点」——因为它需要的是一个**没被 E-Hentai 搜索侧拉黑、且没被 RST 的出口 IP**。

---

## 8. 复现方法（无并发验收请照这个跑）

```powershell
cd X:\harness\hentai_search
# 1) 确认网关在线（用户自己启动的实例；本脚本不会启停它）
curl.exe -s http://127.0.0.1:8788/api/ping
curl.exe -s -m 90 -o tools\stability-run\diag.json http://127.0.0.1:8788/api/diag
# 2) 100 轮（约 23 分钟，7 个默认源）
node tools\stability-check.js --rounds=100
# 3) 覆盖非默认源（copymanga/pixiv/porncomic）
node tools\stability-check.js --rounds=12 --extra=1 --out=tools\stability-run\extra-report.json
# 4) 看汇总（不要给 node 接管道/重定向，沙箱下会拿不到输出）
node tools\stability-run\summarize.js
# 5) 根因探针（只读，各几秒）
node tools\stability-run\netroot.js      # 系统 DNS vs DoH vs TLS/SNI
node tools\stability-run\pinprobe.js     # 钉 DoH 真 IP 直连
node tools\stability-run\dnsmirror.js    # 绅士镜像池 DNS 体检
```

---

## 9. 未覆盖 / 已知局限

1. **无并发基线未跑**：本轮全程有另一个 agent 压测取图/阅读，绝对延迟可能被抬高（ehentai 尤其明显，因为它和阅读共用 `ehSerial`）。用户要求「至少 100 次都在 10s 内」的验收请在无并发时重跑 §8 第 2 步。
2. **网关关闭场景未测**（硬约束禁止我停网关）：§5.4 的绅士结论是 DNS 证据支撑的推断，不是实测。
3. **`cfSolver` 不可用是沙箱启动产物**：danbooru / porncomic 在用户自己正常启动的网关下可能好一些；但 `renders:0 / verified:false` 说明它从未成功验证过，仍值得单独查一次。
4. **node ≠ 浏览器**：mangadex/danbooru 的「直连」是 node 的直连；浏览器带 CORS/CF 通行证的行为可能与本轮表现不同。
5. **hitomi（off:true）与 picacg/kemono/translate 等未纳入**：不属于站点默认启用的「检索」路径。

---

## 10. 第 8 轮修复后复测（本节由修复方追加）

按 §7 的 P0/P1 清单改了代码并重启网关后重跑（**无并发基线**）：

| 指标 | 修复前（本节 §1–§2） | 修复后 |
| --- | --- | --- |
| ≤10s 轮数 | **1 / 100**（唯一达标那轮还靠热缓存） | **100 / 100** |
| 整轮 min/p50/p95/max | 2126 / 14207 / 16023 / 16031 ms | **1471 / 6763 / 9516 / 9521 ms** |
| 整轮总耗时 | 1386s | 777s |

改动（都在前端 + 网关两侧，`node tools/check-all.js` 与基线逐字一致）：

1. **P0-2 预算收窄**：`assets/js/sources.js:910` `EH_BUDGET 15000 → 6000`、首调 `16000 → max(2000, min(6000, left()-400))`；`tools/gateway.js:4533` `EH_BUDGET_MS 13000 → 6000`（`EH_STEP_*` 同步收窄）；copymanga / pixiv 的网关单次 `35000 → 7000`；porn-comic 预算 `20000 → 8000`、网关 `PC_BUDGET_MS 20000 → 8000`。
2. **P0-3 真 deadline**：`tools/gateway.js:712` 去掉 `Math.max(2500, …)` 下限 → `left()` + `leg(max)=max(900, min(max, left()))`，四条腿（原路 / 直连强化 / 中继 / https 升级）共用同一个 `t0`，不再各自重置预算（旧行为让 `timeout:8000` 实测拖到 14–18s）。
3. **P0 全局硬闸**：`assets/js/sources.js:2212` `S.RUN_CAP_MS 22000 → 9500`。到点未回的源按「超时跳过」如实标注，已回来的结果照常渲染 —— 用户侧检索用时从此有硬上限。
4. **P1-1 路由口径统一**：`/api/{porncomic,lectormanga,pixiv,jm,copymanga,kemono}/search` 补 try/catch，失败改回 `HTTP 200 + {ok:false,error}`；`assets/js/sources.js:1013` `gwItems()` 把 `res.error` 原样抛出 → 用户看到的是可读原因，不再是 `HTTP 502`。

另附真机复核（浏览器里连跑 15 轮真实检索，`.tmp/steps-stability.js`）：站点自报「用时」最大 **9.39s**（全部 < 9.5s 硬闸），探针墙钟 14/15 ≤10s（唯一 10020ms 那轮站点自报 9.39s，多出来的 ~0.6s 是探针等文本稳定的检测开销）。

复测报告：`tools/stability-report-round8.json` / `tools/stability-report-round8.md`（100 轮原始明细）。

