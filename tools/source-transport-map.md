# 信息源网络通路图（11 源勘察）

> 只读勘察，不改任何代码。所有结论都带真实行号；数字优先引仓库已有报告，不确定处标「未确认」。
> 关键词：**前端入口**（浏览器直连 vs 走本地网关 `/api/...`）、**网关内部试路径顺序**、**实际命中的那条腿**、**特殊约束**、**实测数据**。

---

## 0. 总表

| 源 | 前端入口 | 网关实际命中的通路 | 关键约束 | 实测成功率 / 延迟 |
|---|---|---|---|---|
| **mangadex** | 浏览器直连 `api.mangadex.org`（**无** `/api/mangadex/*` 路由）；网关腿只作 `/api/proxy` 兜底 | r12g：直连×10 + 网关代理×2；r11：直连×10 | 官方公开 API、可直连；固定请求成人分级 `contentRating[]=suggestive/erotica/pornographic` | r12g **91.7%**，p50 1640 / p95 7471 ms |
| **jmcomic** | 优先 `POST /api/jm/search`；无网关时退化浏览器 HTML 镜像竞速；纯编号走 `/api/reader` 直达 | 网关×12（网关内 = 官方 APP API，出站仍走环境/DoH/中继三层） | 官方 APP API 签名 `md5(ts+secret)` + AES-256-ECB 解 body；实时域名列表；10 个镜像竞速；`JM_BUDGET_MS` 11s | r12g **100%**，p50 1011 / p95 2842 ms |
| **copymanga** | **必须**网关 `POST /api/copymanga/search` | 网关×12（网关内 = API 节点并行竞速） | `x-auth-signature = sha256(secret, ts)` + `umstring`；`code 210` 反破解闸门可重试；节点动态发现；`COPY_HARD_MS` 6500ms | r12g **75%**（空3），p50 3022 / p95 6359 ms |
| **porncomic** | **必须**网关 `POST /api/porncomic/search` | 三通路「直连 → 本机 Chrome → 中继」；本环境实际命中 **本机 Chrome（CDP）** | 全站前置 Cloudflare 人机验证，Node 不执行 JS；依赖本机 Chrome/Edge + Node 22+ 全局 WebSocket；`PC_HARD_MS` 7500ms | r12g **8.3%**（空11），p50 7526 ms；r11 58.3% |
| **lectormanga** | **必须**网关 `POST /api/lectormanga/search` | 网关×12（网关内 = 3 个域名依次试，每个域名走三层） | 检索参数是 **`?search=` 不是 `?q=`**；西语站只按标题匹配；站点不发 CORS 头（浏览器必被跨域拦）；`LM_BUDGET_MS` 6500ms | r12g **58.3%**（空5），p50 3245 / p95 7501 ms |
| **pixiv** | **必须**网关 `POST /api/pixiv/search` | 网关×12，**全失败**；靠 180s 断路器毫秒级拒答 | 机房/数据中心出口一律 403（Cloudflare WAF `block_waf`），公共中继与自建中继**都**被挡；只有住宅/家宽出口可行；R-18 还要自填 `PHPSESSID` | r12g **0%**（空12），p50 **19ms**（断路器）；r11 0%，p50 15ms |
| **wnacg** | 优先 `POST /api/wnacg/search`；无网关时浏览器 10 镜像 × 3 路径 HTML 竞速 | 网关×12（网关内 = 镜像分批竞速 + 跟随 301 + 镜像记忆） | 纯 DNS 污染（假 IP 与真 IP 并存）；真能通的镜像由 DoH 钉真 IP 打通；`WN_BUDGET_MS` 12000 + `WN_HARD_MS` 8500 | r12g **100%**，p50 543 / p95 7430 ms；r11 100% |
| **nhentai** | 路线1 网关 `GET /api/nhentai/search`；路线2 浏览器直连 `nhentai.net/api/v2/search` | 网关×11 + 失败×1（r12g）；r11 网关×7 | 直连 TLS 被 SNI 重置，必须网关；**同出口 IP 限流 429 很敏感**（12 轮里 6 轮栽在这）；`NH_HARD_MS` 8000ms | r12g **91.7%**，p50 301 / p95 13457 ms；r11 58.3% |
| **ehentai** | 路线1 网关 `POST /api/ehentai/search`；路线2 浏览器直连 `?f_search=` | 网关×12（网关内三段：搜索 → 中继换出口 → `/torrents.php`）；本环境实际命中 **自建 private 中继** | 搜索侧**按出口 IP 限制**，机房 IP 恒空集；`RELAY_PREFERRED` 全表唯一一项；`HTTP 200 + content-length:0` 空壳软封锁；`EH_BUDGET_MS` 6000ms | r12g **100%**，p50 817 / p95 1853 ms；r11 0% |
| **danbooru** | 浏览器直连 `danbooru.donmai.us/posts.json`（**无** `/api/danbooru/*` 路由）；网关腿只作 `/api/proxy` 兜底 | r12g：**网关代理×12**（命中 `/api/proxy` 的 gelbooru 系镜像兜底 tbib/xbooru） | 匿名最多 2 个标签；主站本机三层全断（DNS 投毒 + CF 403 + allorigins 回 520/522）；网关只对 `.json` 走 Chrome 兜底 | r12g **100%**，p50 1111 / p95 1879 ms |
| **hitomi** | 浏览器直连 `hitomi.la/search.html`（注册表里 `off:true`，默认关） | 网关代理×12，但**永远 0 条** | 上游全站 JS 渲染，HTML 恒为 3–5KB 空壳；网关明写「检索暂不做」；只有图集阅读能走 CDN 的 `galleries/<id>.js` | r12g **0%**（空12），p50 326 ms；r11 0% |

数据来源：`tools/stability-report-r12g.md:23-33`（12 轮、9500ms cap、生成于 2026-09-23T10:42:59Z）与 `tools/gateway-round11-budget.md:73-83`（第 11 轮逐源）。「空 N」＝该源返回 0 条而非硬失败的轮数。

---

## 1. 前端入口的统一规则（`assets/js/net.js`）

1. **尝试序列只有两条腿**：`net.buildAttempts`（`assets/js/net.js:158-194`）在**本地网关在线**时只构造「网关 → 直连」（`proxyFirst` 时反序），网关那条腿就是 `net.gateway.proxyUrl(url, url)` → `/api/proxy`（`assets/js/net.js:167-177`）。
   - 原因写在 `assets/js/net.js:152-157`：网关自己就有「DoH 钉真 IP / 境内中继」两层，用的还是同一批 AllOrigins；前端再并发打一遍会把 AllOrigins 打成 429，**两边同时全灭**。
   - 网关**不在线**时才展开记忆中的好代理 → 其余公共代理 → 直连（`assets/js/net.js:179-191`）。公共代理表只剩 3 条（`assets/js/net.js:95-99`：allorigins-raw / allorigins-json / local8080）；被淘汰的四条与原因记在 `assets/js/net.js:88-94`。
2. 所以「浏览器直连」的源（mangadex / danbooru / hitomi / jm 的 HTML 镜像 / wnacg 的浏览器兜底）**并非完全不经过网关** —— 它们的第一腿是直连，第二腿是网关的 `/api/proxy` 原样代取（`assets/js/net.js:168`、`assets/js/net.js:590-592`）。
3. `net.fetchSource`（`assets/js/net.js:220-282`）逐条试，剩余 <1200ms 就 break（`assets/js/net.js:238`）；全失败时用 `net.explainFailure`（`assets/js/net.js:298-315`）把「网关三层补偿」讲给用户听。
4. 前端聚合硬闸 `S.RUN_CAP_MS = 9500`（`assets/js/sources.js:2249`），到点未回的源按「超时跳过」如实报告并**丢弃迟到结果**（`assets/js/sources.js:2380`）。
   - ⚠ **文档与代码不一致**：`README.md:644` 仍写 `S.RUN_CAP_MS=22000`，已过期；网关里的注释也有一处引旧行号（`tools/gateway.js:3401` 写「`assets/js/sources.js:2231`」，实际是 `:2249`）。
5. `net.PROBEABLE`（`assets/js/net.js:340`）只含 `mangadex/nhentai/ehentai/jmcomic/copymanga/wnacg/hitomi/danbooru` —— **pixiv / porncomic / lectormanga 不在探针表里**。

---

## 2. 网关内部试路径顺序（`tools/gateway.js`）

### 2.1 通用三层补偿
`outFetch(url, opts)`（`tools/gateway.js:992-1208`）是统一出站入口，逐层：

| 层 | 名称 | 实现 | via 标记 | 证据 |
|---|---|---|---|---|
| ① | 原路直连 | 全局 `fetch` + 启动时探测到的本地代理 | `env` | `tools/gateway.js:1074-1094` |
| ② | DoH 钉 IP 直连强化 | 多解析器并取 → 带 SNI 逐个验真 → 钉住可用 IP → `node:https` 直连 | `doh` | `tools/gateway.js:1097-1111`；解析器表 `:229-234` |
| ③ | 中继代取 | 公共 / 自建 Cloudflare 中继，仅 GET、无签名头时可用 | `relay` | `tools/gateway.js:1114`；中继表 `:659-667` |

- 设计动机与实测依据：`tools/gateway.js:178-205`。要点：① 出口被粘死（VPN 一关每次请求先撞没人监听的端口）、② `wnacg.com` 与 `hitomi.la` 是**纯 DNS 污染**、③ `nhentai / E-Hentai / danbooru / kemono / i.pximg.net` 直连彻底不通（SNI 阻断）但 Cloudflare 中继境内可达。
- 无记忆时 `env` 与 `doh` **并行竞速**（Promise.any），只给赢的那条记通路（`tools/gateway.js:1160-1174`）；再兜底 `tierRelay` 并 `setPlan(host,'relay')`（`:1183-1189`）。每主机记忆 10 分钟（`PLAN_TTL`，`tools/gateway.js:235-241`）。
- ④ 额外一条：**http → https 升级重试**（`tools/gateway.js:1191-1202`）。
- 反向教训：上一版曾把「原路就通」的 mangadex 误记成 `doh`（`tools/gateway.js:1160-1174` 注释）。

### 2.2 中继候选与顺序
`RELAYS`（`tools/gateway.js:659-667`）：

```
private(自建, id=private) → cors-eu → allorigins → allorigins-get → i0.wp
```

- 自建中继从 `tools/relay.txt`（每行 `地址[ 空格或| key]`）或环境变量 `HS_GW_RELAY` 装载，**倒序 unshift 到数组最前**（`tools/gateway.js:623-651`、`:668-670`）。本机 `tools/relay.txt` 当前配了 1 条 `https://hs-relay-a7f3.pages.dev`（`tools/relay.txt:3`；该文件含 key，已在 `.gitignore`）。
- 公共四条各自定义：`cors-eu`（`kind:'any'`）、`allorigins`（`any`）、`allorigins-get`（`text`+json 解包）、`i0.wp`（**`kind:'image'`，只代取图片，不代取页面**）（`tools/gateway.js:659-667`）。
- **私有中继的三条特殊待遇**（`tools/gateway.js:617-621`）：排在公共中继前面、带 `x-hs-key`、**只有它允许转发 cookie 与签名头**（`PRIVATE_FORWARD_HDR`，`tools/gateway.js:654`）；公共中继遇到带 secret 头的请求整条跳过（`tools/gateway.js:801`）—— 这正是 pixiv R-18 走不通的根本原因。
- 冷却分档：`RELAY_COOLDOWN` 45s（429）、`RELAY_SOFT_COOLDOWN` 15s（5xx/超时）（`tools/gateway.js:722-723`）；并且第 12 轮起改为按 **(中继 × 目标主机)** 记账 —— `RELAY_HOST_DEAD_MS` 10 分钟、`RELAY_HOST_SOFT_MS` 90 秒、`RELAY_HOST_LIMIT_MS` 60 秒（`tools/gateway.js:683-685`、`:726`）。
  - 起因：私有腿排进 `relays[0]` 后 nhentai 从 58.3% 掉到 16.7%、e-hentai 只剩 8.3%，根因是「一荣俱荣、一损俱损」的全局冷却（`tools/gateway.js:672-682`）。

### 2.3 自建中继（Cloudflare Pages）能通谁、不能通谁
实测真值表（`tools/relay-deploy.md:188-201`，`node tools/_relay-targets.js`）：

| 目标 | private 中继结果 |
|---|---|
| `e-hentai.org` | **200** / 66512B / 1716ms |
| `api.mangadex.org` | **200** / 472ms；`mangadex.org` 200 / 232ms |
| `porn-comic.com` | **200** / 54151B / 618ms |
| `hitomi.la` | **200** / 26690B |
| `api.copy-manga.com` | 404 |
| `nhentai.net` | 403（**仅 HTML 搜索页**，见下） |
| `danbooru.donmai.us` | 403 |
| `jmcomic` / `wnacg` | 403（wnacg 仅 17B） |
| `lectormanga.com` | 530 |
| `www.pixiv.net` | 403 / 372123B（Cloudflare WAF `block_waf`） |

- 同一结论在代码里落成 `PRIVATE_BLOCKED_HOSTS`（`tools/gateway.js:714-717`：`danbooru.donmai.us / www.wnacg.com / jmcomic.me / www.pixiv.net / lectormanga.com`），进程启动即预置 10 分钟退避（`:718-719`）。
- **重要更正**：不要按**域名**判死，要按**真实端点**判。`nhentai.net` 的 HTML 搜索页 403，但网关真正用的 JSON API 走私有腿是通的：`https://nhentai.net/api/v2/search?query=naruto` ⇒ 200 / 9822B / 826ms，`query=test` ⇒ 200 / 11358B / 386ms（`tools/gateway.js:706-712`）。移出黑名单后 nhentai 从 0% 回到可用（`tools/stability-report-r12e`）。教训：**探针要打代码里那一行 URL，不要打站点首页**（`tools/gateway.js:713`）。
- 私有中继对 e-hentai / mangadex / porncomic / hitomi 是 200（`tools/gateway.js:673-674`）。
- 而**公共**中继在本机出口上已知全灭：15 条候选 × 2 目标 = 0 成功；`cors.eu.org` 全局限流 429（53086B 错误页）、`api.allorigins.win` 不可达、`*.workers.dev` / `r.jina.ai` / `*.vercel.app` 域名本身被墙（`tools/relay-deploy.md:57-59`）。历史曾有一次 `cors.eu.org` 可用：e-hentai 8/8 成功、首页 268ms / 图集页 233ms / 大图 691ms（`tools/gateway.js:247-252`、`:2209-2213`）。
- 部署方式（免费、不用买域名）：`relay-worker.mjs` / `relay-deno.ts` / `relay-server.js` 三种实现，Cloudflare Pages 最省事（`tools/relay-deploy.md:79-82`、`tools/gateway.js:603-611`）；协议 `GET {base}/?url=&k=`，无 key / 错 key 403，`/__hs/ping` 免 key，带 SSRF 拒绝（`tools/relay-deploy.md:155-160`）。改完 `relay.txt` **必须重启网关**（只在启动时读一次，`tools/relay-deploy.md:113`、`:329`）。

### 2.4 本机 Chrome CDP 过 Cloudflare 挑战
- 动机：Node 不执行 JS，「Just a moment…」永远过不去（`tools/gateway.js:2317-2329`）。用 `--headless=new` + 真身 UA + 反自动化补丁，经 CDP WebSocket 取回渲染后的 HTML；Node 22+ 自带全局 WebSocket，零 npm 依赖（`tools/gateway.js:2317-2329`）。
- 可用性判定 `cfUnavailableReason()`（`tools/gateway.js:2488-2493`）：需要全局 WebSocket（Node 22+）、找得到本机 Chrome/Edge（`HS_CHROME` 可指定）、且没设 `HS_CF_SOLVER=0`。
  - ⚠ `/api/ping` 的 `cfSolver.available` **只说明可执行文件在不在**，在沙箱里照样是 `true`（`tools/gateway.js:2499-2503`），所以才另外暴露 `verified / failing / lastOkAt / lastErrorAt`（`tools/gateway.js:2501-2502`、`:6826`）。
- 挑战判定三层一起看：响应头 `cf-mitigated: challenge`、正文特征、状态码 403/429/503/520–527（`tools/gateway.js:2343-2351`、`cfIsChallenge` `:2373`）。
- 冷却：`CF_RENDER_TTL` 5 分钟、`CF_FAIL_COOLDOWN` 90s、`CF_FAIL_SOFT_COOLDOWN` 15s（第一次失败只罚 15 秒）（`tools/gateway.js:2330-2336`）。每次启动都用全新 profile，用完即删（`:2328`）。
- 统一入口 `cfFetchWithSolver`（`tools/gateway.js:3107-3153`）：先直连 → 是挑战页就 `cfRender`；`via` 只会是 `'http'` 或 `'chrome'`；**绝不把挑战页当正文返回**（`:3148-3152`）。
- 目前只有 **porn-comic 搜索**与 **danbooru 的 `.json` 接口**用这条腿（`tools/gateway.js:3160`、`:7088-7124`）。

---

## 3. 每源通路

### 3.1 mangadex —— 唯一"真·直连"的源
- **前端**：`mangadexSearch(ctx)`（`assets/js/sources.js:211-306`）纯浏览器 `HS.net.fetchSource('https://api.mangadex.org/manga?...', {json:true, allowProxy:true})`（`assets/js/sources.js:271-272`），**没有任何网关分支**。请求固定带 `contentRating[]=suggestive/erotica/pornographic`（`:243`）。
- **网关**：没有 `/api/mangadex/*` 搜索路由（路由表 `tools/gateway.js:6776-7130` 逐条可见）。网关只在两处碰 mangadex：`/api/proxy` 代取（第一腿失败时的兜底，`assets/js/net.js:168`）与 `/api/reader`（阅读器，`tools/gateway.js:3911` 白名单）。
- **实测**：r12g 91.7%，p50 1640 / p95 7471 / max 7471 ms，主要路径 **直连×10 + 网关代理×2**（`tools/stability-report-r12g.md:23`）；r11 83.3%，p50 1405 / max 13007，**直连×10**（`tools/gateway-round11-budget.md:73`）。私有中继对 `api.mangadex.org` 也是 200（`tools/relay-deploy.md:188-201`）。

### 3.2 jmcomic（禁漫）—— 官方 APP API + 签名 + AES
- **前端**：`jmcomicSearch`（`assets/js/sources.js:1541-1580`）顺序 = 编号直达 → `gwReady()` 时 `jmViaGateway` → 兜底 `jmFetch` HTML 镜像竞速（`:1550-1569`）。`jmViaGateway` 打 `POST /api/jm/search`（`:1090-1094`，超时 16000ms）。
- **网关内**：`jmSearch`（`tools/gateway.js:1429-1484`）→ `jmPickHost`（记住的域名 5 分钟内直接用，`:1334-1338`；否则 `jmResolveHost` 用 pickProbe 批量 3 个域名探测，`:1315-1325`）→ `jmApi` → `outFetch`（三层，见 2.1）。
- **签名算法**：`token = md5(timestamp + '18comicAPPContent')`、`tokenparam = '<ts>,<appVersion>'`、响应 `data` 是 `AES-256-ECB(base64)`，密钥 `md5(timestamp + '185Hcomic3PAPP7R')`（`tools/gateway.js:1210-1219`）；版本 `2.0.16`。实时域名列表来自 `https://rup4a04-c02.tos-cn-hongkong.bytepluses.com/newsvr-2025.txt`，base64 → AES-ECB → `JSON.Server[]`，缓存 6 小时（`tools/gateway.js:1226-1238`）。9 个 CDN 兜底域名见 `:1220-1224`。
- **约束**：`JM_BUDGET_MS = 11000` 整段上限（`tools/gateway.js:1341`），预算耗尽就把已有结论返回；HTML 镜像侧 `JM_DOMAINS` 6 个 + `raceFetch` <300 字节算失败（`assets/js/sources.js:1440`、`:1455-1483`）。
- **实测**：r12g **100%**，p50 1011 / p95 2842 ms（`tools/stability-report-r12g.md:26`）；r11 91.7%，p50 1248 / max 11893（`tools/gateway-round11-budget.md:76`）。私有中继对 jmcomic **403**（`tools/relay-deploy.md:188-201`）。

### 3.3 copymanga（拷贝）—— HMAC 签名 + 节点竞速
- **前端**：`copymangaSearch`（`assets/js/sources.js:1223-1244`）**必须先有网关**（`:1225` 明写「拷贝漫画需要本地网关来签名」），打 `POST /api/copymanga/search`，前端超时 7000ms（`:1232-1234`）。注册表里 `weight 0.5` + `last:true`（`assets/js/sources.js:2160-2170`）。
- **网关内**：`copymangaSearch` 外套 `COPY_HARD_MS = 6500` 硬闸（`tools/gateway.js:1733`、`:1746-1761`）→ `copymangaSearchInner`（`:1786`）候选节点 = 上次跑通的 + 上次发现的 hint + 内置兜底 `['api.copy2000.online','api.mangacopy.com','api.copy-manga.com']`（`:1795-1799`），**全部并行竞速、谁先成功用谁**（`raceFirst`，`:1767-1784`）；节点发现 `/api/v3/system/network2` **不在关键路径上**，结果只留给下次（`COPY_DISCOVER_MS = 5000`，`:1742`、`:1801-1806`）。
- **签名**：`x-auth-timestamp` + `x-auth-signature = sha256(b64(COPY_SECRET_B64), ts)`，另带 `umstring / source:copyApp / platform:3 / version:3.0.6 / region:1`（`tools/gateway.js:1619-1633`）。
- **约束**：`code 210` 是**可重试**的反破解限流闸（`tools/gateway.js:1679-1681`）；阅读器那条线要另一套头（`region:'0'` + deviceinfo/device/pseudoid/dt）并串行 + 最小间隔 1200ms（`:1635-1665`）。
- **实测**：r12g 75%（空3），p50 3022 / p95 6359 ms（`tools/stability-report-r12g.md:30`）；r11 75%，p50 1642（`tools/gateway-round11-budget.md:80`）。节点真机数值：发现接口 3548ms 但返回的 `t66y.com` 打签名检索 **10697ms 后 fetch failed**；真正能用的是内置兜底 `api.copy-manga.com` 2179ms / `api.copy2000.online` 3984ms（`tools/gateway-round11-budget.md:108-113`、`tools/gateway.js:1734-1741`）。私有中继对 `api.copy-manga.com` 404、`lectormanga` 530（`tools/relay-deploy.md:188-201`）。

### 3.4 porncomic —— 唯一真正需要 Chrome CDP 的搜索源
- **前端**：`porncomicSearch`（`assets/js/sources.js:1292-1349`）**必须网关**（`:1294`），`BUDGET = 8000`，打 `POST /api/porncomic/search`（`:1311-1313`）。
- **网关内三条通路**：`pcFetchPage`（`tools/gateway.js:3279-3396`）顺序 = **直连 → 本机 Chrome → 中继**（`const order = opts.allowRelay === false ? ['direct','chrome'] : ['direct','chrome','relay']`，`:3346`）。中继**默认不参与**，只有「这是最后一个入口」才放行（`:3343-3345`、`:3445`）；上一次走通的那条腿在 10 分钟内优先（`PC_STICKY_MS`，`:3245`、`:3348-3351`）。
  - 理由写在 `tools/gateway.js:3341-3345`：直连最便宜、**Chrome 是本环境下唯一真能出数的通路**、公共中继现在整条链在超时，夹在中间只会吃光预算。
- **约束**：全站前置 Cloudflare 人机验证，上游不发 `cf_clearance`，每个新 URL 都要自己过一次（`tools/gateway.js:2325-2327`）；Chrome 连续 3 次起不来就熔断 15 分钟（`PC_CHROME_FAIL_LIMIT` `:3210`、`PC_CHROME_COOLDOWN` `:3211`）；`PC_HARD_MS = 7500`（`:3244`）。
- **入口路径**：`/q/{词}-{页}.html`（302 到 `/tags/` 或 search 子域）→ `/tags/{词}.html` → `/language/…` → `/h/`（`tools/gateway.js:3157-3158`、`:3426-3429`）；站点把空结果写进 title（`no result`），一到就如实回 0 条（`:3478-3486`）。
- **实测**：r12g **8.3%**（空11），p50 7526 / p95 7566 ms，11 轮都是「超 7500ms 硬闸」（`tools/stability-report-r12g.md:32`、`:51`）；r11 58.3%，p50 6303（`tools/gateway-round11-budget.md:82`）。`README.md:706-707` 记：命中 6–7 秒、二次走缓存 2ms、无结果 18 秒 200+0 条、挑战页 4.5 秒判死。私有中继对 `porn-comic.com` **200 / 54151B / 618ms**（`tools/relay-deploy.md:188-201`）—— 中继其实能通，只是被排到最后兜底。

### 3.5 lectormanga —— 服务端渲染，最简单的一条
- **前端**：`lectormangaSearch`（`assets/js/sources.js:1364-1434`）**必须网关**（`:1365`），打 `POST /api/lectormanga/search`，超时 9000ms（`:1379-1381`）。检索参数是 **`?search=` 不是 `?q=`**（`:1351-1353`）；站点**不返回 `Access-Control-Allow-Origin`**，浏览器直连必被跨域拦（`:1355`）。中文关键词先做本地化阶梯（`HS.xlate.offline` 0ms / `HS.xlate.expand` 硬超时 2.5s，`:1384-1425`）。
- **网关内**：`lmFetchPage`（`tools/gateway.js:3612-3633`）按 `LM_DOMAINS = ['lector-mangas.lat','lectormangass.com','lectormangaa.com']`（`:3528`）**依次**试，每个域名走 `outFetch` 三层；整条调用共用 `LM_BUDGET_MS = 6500` 死线（`:3530`、`:3660`）。
- **兜底**：中文词在西语站 0 条时用机译再打一次，给 4000ms 总预算（`tools/gateway.js:3649-3656`、`:3682-3691`）。
- **实测**：r12g **58.3%**（空5），p50 3245 / p95 7501 ms（`tools/stability-report-r12g.md:29`）；r11 50%，p50 4465（`tools/gateway-round11-budget.md:79`）。私有中继对 `lectormanga.com` **530**（`tools/relay-deploy.md:188-201`），所以这条源在私有腿上没救。

### 3.6 pixiv —— 机房出口结构性不可达
- **前端**：`pixivSearch`（`assets/js/sources.js:1247-1283`）**必须网关**（`:1248`），还要 `/api/ping` 的 `sources` 里含 `pixiv`（否则报「网关是旧进程」，`:1251-1254`）；打 `POST /api/pixiv/search`，带 `settings.pixivCookie`（`:1271-1273`）。
- **网关内**：`pixivSearch`（`tools/gateway.js:2224-2315`）打官方 `/ajax/search/artworks/<词>?…&mode=r18|all`（`:2235-2237`），出站仍是 `outFetch` 三层（`:2247`）。
- **约束（结构性）**：pixiv 对**数据中心出口**一律 403 —— 正文是 Cloudflare WAF 的 `block_waf` 页，**自建中继的出口同样被挡**（实测 private HTTP 403 / 372123B）（`tools/gateway.js:2218-2220`、`tools/relay-deploy.md:188-201`）；`RELAY_PREFERRED` 注释明确**不要**把 `www.pixiv.net` 列进来（`tools/gateway.js:261-264`）。想通只能把中继换到**住宅/家宽出口**，且 R-18 还要带用户自己的 `PHPSESSID`（`tools/gateway.js:2219-2220`）。另外公共中继会剥掉 Referer，`/ajax/` 于是回 HTML 登录页（`:2252-2256`）。
- **断路器**：真·网络层失败后 `PIXIV_NET_COOLDOWN_MS = 180e3` 内毫秒级返回同一结论，出口一变立刻失效（`tools/gateway.js:2196`、`:2227-2231`、`:2263-2267`）。预算 `PIXIV_BUDGET_MS = 8000`（`:2200`）。
- **实测**：r12g **0%**（空12），p50 **19ms** —— 19ms 就是断路器命中，不是真请求（`tools/stability-report-r12g.md:31`）；失败原文：「原路 timeout；直连强化 DoH 没给出能验真的 IP；中继全失败，private 已记『被 www.pixiv.net 按出口 IP 挡』」（`:48-49`）；r11 0%，p50 15ms（`tools/gateway-round11-budget.md:81`）。前端注释同口径：本机出口「钉到真 IP 后 TLS 96ms 就被 RST」，**12 轮 p50 20478ms 全 502**（`assets/js/sources.js:1268-1270`）。

### 3.7 wnacg（紳士）—— 纯 DNS 污染，靠 DoH 钉真 IP
- **前端**：`wnacgSearch`（`assets/js/sources.js:1754-1854`）优先网关 `POST /api/wnacg/search`（`:1780-1781`，超时 16000ms）；浏览器兜底 `wnRound`（`:1714-1752`）= 3 条候选路径 × `S.wnacgDomains()` 10 个镜像，`raceFetch ms:7000 budget:10000`。
- **网关内**：`wnacgSearch` 外套 `WN_HARD_MS = 8500` 硬闸 + 全镜像不可达时 30 秒短冷却（`tools/gateway.js:4826-4827`、`:4923-4944`）；`wnacgSearchInner`（`:4946`）按 `wnSearchPaths`（3 条路径，`:4902-4916`）逐条 `pickProbe` 竞速镜像，单镜像 `WN_HOST_MS = 7000`、整段 `WN_BUDGET_MS = 12000`（`:4816-4817`）。
- **约束**：`www.wnacg.com` 是**纯 DNS 污染**（系统 DNS 给假 IP，带 SNI 直连真 IP 就 200），靠 DoH 钉真 IP 打通（`tools/gateway.js:188-189`、`:7196`）。网关能跟 301/302、记最近成功镜像、失败主机冷却、结果缓存 5 分钟（`assets/js/sources.js:1767-1773`）。
- **实测**：r12g **100%**，p50 543 / p95 7430 ms（`tools/stability-report-r12g.md:27`）；r11 100%，p50 1654 / max 7535（`tools/gateway-round11-budget.md:77`）。`README.md:368` 记：不挂代理实测命中 `www.wnacg.com`（DoH 打通），`.date` 301 回它；`wnacg01/02/03/05.cc`、`wn07.ru` 被 SNI 阻断。私有中继对 wnacg **403 / 17B**（`tools/relay-deploy.md:188-201`）。

### 3.8 nhentai —— 网关代取 + 出口 IP 限流
- **前端**：`nhentaiSearch`（`assets/js/sources.js:791-836`）路线 1 = `GET /api/nhentai/search`（`:776-777`，超时 9000ms）；路线 2 = 直连 `https://nhentai.net/api/v2/search?query=…`（`:783-789`）。直连在本机被 **TLS 重置**（「基础连接已经关闭：接收时发生错误」），所以必须网关（`assets/js/sources.js:308-316`、`tools/gateway.js:1966-1968`）。
- **网关内**：`nhentaiSearch` 外套 `NH_HARD_MS = 8000` 硬闸（`tools/gateway.js:1991-2006`）；`nhentaiSearchInner`（`:2008`）预算 `NH_BUDGET_MS = 6800`（`:2023`），带 **429 退避重试**（最多两次，`NH_WAITS = [900, 2600]`，尊重 `Retry-After` 但上限 3500ms，`:2037-2053`）。
- **约束**：nhentai 对同一出口 IP 的限流很敏感 —— 本机机房 IP 连搜十几次就开始稳定回 429 并持续几分钟；12 轮压测里 6 轮栽在 429（`tools/gateway.js:2016-2019`）。v2 只返回数字 `tag_ids`（v1 `/api/gallery/*` 已 403、`/api/v2/tags` 已 404），所以 tags 恒为空（`tools/gateway.js:1969-1970`）。
- **私有中继**：HTML 搜索页 403，但**代码真正用的 JSON API 端点 200**（naruto ⇒ 200/9822B/826ms）—— 见 2.3（`tools/gateway.js:706-712`）。
- **实测**：r12g **91.7%**，p50 301 / p95 13457 ms，1 次硬失败（网关超 8000ms 硬闸 / 直连 fetch failed）（`tools/stability-report-r12g.md:24`、`:39`）；r11 58.3%，p50 577 / max 12656（`tools/gateway-round11-budget.md:74`）。

### 3.9 ehentai —— 按出口 IP 限流，靠私有中继换脸
- **前端**：`ehentaiSearch`（`assets/js/sources.js:902-976`）路线 1 = `POST /api/ehentai/search`（`:924-926`），`EH_BUDGET = 6000`（`:915`）；路线 2 = 直连 `https://e-hentai.org/?f_search=…&f_apply=Apply+Filter`（`:955`），命中封禁正则就报「E-Hentai 拒绝了当前出口 IP」（`:963`）。
- **网关内三段**（`ehentaiSearchInner`，`tools/gateway.js:5721-`）：
  1. 正常搜索（`EH_STEP_SEARCH = 4000`，`:5543`、`:5760-5795`）；
  2. 空集 → **换出口 IP 经中继再搜一次**（`EH_STEP_RELAY = 2500`，`:5544`、`:5797-5818`，`relayOnly:true`）；
  3. 仍 0 条 → `/torrents.php?search=<词>` 种子兜底（`EH_STEP_TORRENT = 2500`，`:5545`、`:5820-`）。
  整段受 `EH_BUDGET_MS = 6000` 夹住（`:5537`），每段开跑前先看 `left()`，不够就跳过。
- **约束**：**搜索侧按出口 IP 认脸** —— 同一个词本机机房出口返回 `No hits found`，经中继却拿到 25 条真结果（`tools/gateway.js:5797-5800`）；`RELAY_PREFERRED` 全表**只有 `e-hentai.org` 一条**（`:261-264`），即「原路与 DoH 实测恒失败、第一次也直接走中继、跳过竞速」（`:1147-1159`）。另有 `HTTP 200 + content-length:0` 空壳软封锁（via `1.1 varnish`），与请求头/cookie 无关，空壳后主机 60 秒冷却（`tools/gateway.js:1061-1068`、`README.md:695-699`）。
- **网络层冷却**：`ehNetCooldownMs()` 有私有中继时 25 秒，否则 180 秒（`tools/gateway.js:5572-5590`）。起因：r12d 有私有腿时 e-hentai 91.7%，r12e 掉到 16.7% —— 仅因某轮一次网络失败就把冷却推到 3 分钟，后面 10 轮全是 14ms 的空结果（p50 14ms 就是它）。
- **实测**：r12g **100%**，p50 817 / p95 1853 ms（`tools/stability-report-r12g.md:25`）；r11 **0%**，p50 10ms（那轮还没打通私有腿，`tools/gateway-round11-budget.md:75`）。私有腿打通后：`naruto` 411ms / 25 条、`巨乳` 397ms / 25 条（`tools/relay-deploy.md:203-204`）；更早一次真机实测 `via=relay` 成功要 **10978ms**，被前端 6000ms 硬闸自己掐死（`tools/gateway.js:247-252`）。
- 本机取证（`assets/js/sources.js:838-857`）：出口 `127.0.0.1:7897` / IP 54.255.249.22，`?f_search=chinese` ⇒ 5443B/0 条、`?f_search=a` ⇒ 5392B/0 条、`/tag/chinese` ⇒ 5444B/0 条；同一出口的非搜索入口全部正常（`/` 25 条、`/popular` 64 条、`/toplist.php` 40 条）；本机 Chrome 打开同一搜索 URL 也是 `No hits found`。

### 3.10 danbooru —— 前端直连，实际靠网关 `/api/proxy` 的镜像兜底
- **前端**：`danbooruSearch`（`assets/js/sources.js:1986-2011`）打 `https://danbooru.donmai.us/posts.json?limit=…&tags=…&page=`，`fetchSource({json:true, allowProxy:true})`（`:1960-1963`）—— **没有网关搜索分支**。`danLadder` **匿名最多 2 个标签**（超过直接 400），只取前 2 段（`:1936-1944`）。
- **网关**：无 `/api/danbooru/*` 路由；但它出现在 `/api/proxy`（第一腿失败后的兜底）。`/api/proxy` 对 `*.donmai.us` 且路径以 `/posts.json` 结尾的请求**先试可达镜像**（`tools/gateway.js:7062-7075`、`danbooruMirrorQuery` `:4314-4323`）：
  - `BOORU_MIRRORS`（`tools/gateway.js:4305-4309`）= `tbib.org`（图片不需代理，直连 0.7~1.1s）+ `xbooru.com`（必须改写为网关相对代理地址）；
  - gelbooru 系的 `tags/rating/图片字段` → danbooru `posts.json` 形状，前面前端适配器一行不用改（`tools/gateway.js:4301-4303`）；
  - 刻意**不采用** `safebooru.org`：它回 200 但 `rating` 恒为 safe，前端默认只要成人向 → 全部被过滤，是「假成功」（`tools/gateway.js:4298-4300`）。
- **约束**：主站本机三层全断 —— 系统 DNS 被投毒（ENOENT）、`doh.pub` 给的 210.56.51.192 带 SNI 握手也超时、中继腿 allorigins 回 520/522（`tools/gateway.js:4285-4290`）；同 zone 的 safebooru/betabooru 能解析到真 CF IP 但一律 403 + Just a moment（`:4287-4289`）。网关侧 403 时只对 **`.json` 接口**做一次 Chrome 兜底（渲染 JSON 查看器 → 抠回 JSON 原文，`:7088-7124`），图片不在 `/api/proxy` 里救（`:7095-7096`）。
- **实测**：r12g **100%**，p50 1111 / p95 1879 ms，主要路径 **网关代理×12**（`tools/stability-report-r12g.md:28`）；r11 100%，p50 927 / max 3087，同样是网关代理×12（`tools/gateway-round11-budget.md:78`）。私有中继对 `danbooru.donmai.us` **403**（`tools/relay-deploy.md:188-201`），已在预置黑名单里（`tools/gateway.js:714-717`）。

### 3.11 hitomi —— 上游改成 JS 渲染，检索本质做不了
- **前端**：`hitomiRound`（`assets/js/sources.js:1864-1908`）直连 `https://hitomi.la/search.html?query=…`（`fetchSource({allowProxy:true,proxyFirst:true})`）；取不到 `div.gallery-content` 且没有任何作品链接时**抛错**「hitomi.la 已改为 JS 渲染，HTML 里没有任何结果链接（该源检索暂不可用）」（`:1886`）。注册表里 `off:true`（默认关）、flags `['实验性','检索暂不可用']`（`assets/js/sources.js:2215-2220`）。
- **网关侧**：**明确不实现检索**（`tools/gateway.js:5336-5339`）：免费检索入口 `/search.html?query=…`、`/index-chinese.html`、`/alltags.html` 返回的都是 3–5KB 空 JS 壳，真正的检索要走 nozomi 二进制索引（浏览器里用 Range 请求 + 二分），网关没有执行 JS 的能力。网关只做**在线阅读**：图集数据取自 CDN `https://ltn.gold-usergeneratedcontent.net/galleries/<id>.js`，图片在 `{a1|a2}.gold-usergeneratedcontent.net`（`tools/gateway.js:5308-5342`）。
- **约束**：`hitomi.la` 与 wnacg 同属**纯 DNS 污染**，DoH 钉真 IP 可通（`tools/gateway.js:188-189`）。私有中继对 `hitomi.la` 是 **200 / 26690B**（`tools/relay-deploy.md:188-201`）—— 通路是通的，是**上游不再吐 HTML 结果**。
- **实测**：r12g **0%**（空12），p50 326 ms，主要路径「网关代理×12」（`tools/stability-report-r12g.md:33`）；r11 0%，p50 458（`tools/gateway-round11-budget.md:83`）。取证：`query=naruto` 与 `query=zzzznothing` 同为 3687B、`/g/` 链接 0 个；`root` / `tag` 页恒 5789B；对照组 mangadex 12976B vs 25928B（`tools/gateway-round11-budget.md:134-138`、`assets/js/sources.js:1856-1862`）。

---

## 4. 环境死路与真实边界

**当前网络（本机、Windows、出口走探测到的本地代理 127.0.0.1:7897）下，本质上打不通的：**

| 站点 | 死因（实测） | 证据 |
|---|---|---|
| `www.pixiv.net` | **结构性**：对数据中心出口一律 403（Cloudflare WAF `block_waf`）。本机原路 timeout、DoH 拿不到能验真的 IP、公共与自建中继**都** 403。只有住宅/家宽出口 + 用户自己的 `PHPSESSID` 才有解 | `tools/gateway.js:2207-2221`、`tools/relay-deploy.md:188-201`、`tools/stability-report-r12g.md:31,48-49` |
| `danbooru.donmai.us`（主站） | 系统 DNS 投毒（ENOENT）→ `doh.pub` 的 210.56.51.192 带 SNI 握手超时 → allorigins 回 520/522，**三层全断**；同 zone 的 safebooru/betabooru 403 + Just a moment | `tools/gateway.js:4285-4290` |
| `hitomi.la`（检索） | 不是网络死路 —— 上游把**检索**改成 JS 渲染，HTML 里恒无结果；网关不执行 JS，故不做 | `tools/gateway.js:5336-5339`、`assets/js/sources.js:1886` |
| `nhentai.net`（HTML 页） | SNI 阻断 + CF HTML 路由 403（JSON API 端点例外，见下） | `tools/gateway.js:1966-1968`、`:706-712` |
| `e-hentai.org`（搜索侧） | **按出口 IP 认脸**：本机机房出口恒空集（`?f_search=chinese` ⇒ 5443B/0 条），非搜索入口同一出口正常 | `assets/js/sources.js:838-857`、`tools/gateway.js:5797-5800` |
| 公共 CORS 中继 | 本机出口全灭：15 条候选 × 2 目标 = 0 成功；`cors.eu.org` 429、`allorigins` 不可达、`*.workers.dev` / `r.jina.ai` / `*.vercel.app` 域名本身被墙 | `tools/relay-deploy.md:57-59` |
| 本机所有本地代理端口 | 19 个端口全 `ECONNREFUSED`（VPN 关掉后每次请求先撞没人监听的端口，日志 `ms=5` 的 `fetch failed`）| `tools/relay-deploy.md:56`、`tools/gateway.js:178-205` |

**有解的：**

- **e-hentai**：自建 Cloudflare Pages 中继（`relays[0]` = private）打通，实测搜索 400ms 出 25 条（`tools/gateway.js:2216-2217`、`tools/relay-deploy.md:203-204`）。只要中继临时不可用就会退回「如实报错」，重试或看 relays 冷却即可。
- **nhentai**：走网关 JSON API 端点，私有腿 200（`tools/gateway.js:706-712`）。**注意别按域名把它列进黑名单。**
- **danbooru**：走 `/api/proxy` 的 gelbooru 系镜像（tbib / xbooru），r12g 100%（`tools/gateway.js:4305-4323`、`tools/stability-report-r12g.md:28`）。
- **wnacg / hitomi（阅读）**：纯 DNS 污染，DoH 钉真 IP 即通（`tools/gateway.js:188-189`）。
- **porncomic**：中继其实能通（200 / 54151B / 618ms），本环境真正靠得住的还是**本机 Chrome CDP 过验证**（`tools/relay-deploy.md:188-201`、`tools/gateway.js:3341-3345`）。
- **提升自建中继出口**：把 `tools/relay.txt` 指到住宅/家宽出口并**重启网关**，pixiv 与 danbooru 这类「按机房 IP 封」的站才会被重新尝试（`tools/gateway.js:703-705`、`tools/relay-deploy.md:113,329`）。

**两条跨源教训（值得记住）：**

1. **探针要打代码里那一行 URL，不要打站点首页** —— nhentai 首页 403 但 API 200，差点被误判成死站（`tools/gateway.js:706-713`）。
2. **冷却必须按 (中继 × 目标主机) 记账** —— 全局冷却会让「pixiv/nhentai 被 403」把只有中继一条腿的 e-hentai 一起拖下水，实测 e-hentai 只剩 8.3%（`tools/gateway.js:672-682`、`tools/stability-report-r12b.md`）。

---

## 5. 附录：kemono

kemono 在网关有端点 `GET /api/kemono/search`（`tools/gateway.js:6898`），但它**不是本应用的检索源** —— `assets/js/sources.js` 的 `REG`（`assets/js/sources.js:2147-2221`）里没有它，前端也不会调用。仅此一句。

---

## 6. 数据来源与已知不一致

| 文件 | 用途 | 关键行 |
|---|---|---|
| `assets/js/net.js` | 前端尝试序列、网关腿、聚合 | `:95-99`、`:152-194`、`:220-282`、`:298-315`、`:340`、`:590-592` |
| `assets/js/sources.js` | 11 源注册表与各源检索函数 | `:2147-2221`、`:2249`、`:2380`；各源见第 3 节 |
| `tools/gateway.js` | 三层出站、中继表、CF 求解器、各源网关实现 | 见第 2、3 节逐条行号 |
| `tools/stability-report-r12g.md` | **最新**逐源成功率/延迟/主要路径（12 轮、9500ms cap） | `:14`、`:16-17`、`:23-33`、`:39`、`:46`、`:48-49`、`:51`、`:58-69` |
| `tools/gateway-round11-budget.md` | 第 11 轮基线 vs 复测、逐源预算与硬闸、节点/镜像取证 | `:26-30`、`:55`、`:59`、`:69`、`:73-83`、`:104-138` |
| `tools/relay-deploy.md` | 公共中继全灭证据、私有中继逐目标真值表、部署/联调 | `:56-59`、`:79-82`、`:99-101`、`:105-113`、`:155-160`、`:168-171`、`:178-186`、`:188-204`、`:208-232`、`:244-246`、`:271-290`、`:329` |
| `README.md` | 信息源章节、取源顺序、逐源 caveat | `:363-375`、`:383-386`、`:644`、`:653-661`、`:686`、`:695-700`、`:706-707`、`:716-719` |
| `tools/reader-zoom-anchor-round11.md` | **不相关** —— 该文件是缩放/拖拽几何（真机 Chrome CDP 真鼠标），第 `:61` 行明确写「本轮未做需求 3（11 个信息源的连通率/延迟/稳定性）」 | `:4`、`:11`、`:28`、`:35`、`:42`、`:60-61` |

**已知不一致（照实记，未改动）：**

1. `README.md:644` 写 `S.RUN_CAP_MS=22000`，代码实际是 `9500`（`assets/js/sources.js:2249`）。
2. `tools/gateway.js:3401` 引用的 `assets/js/sources.js:2231` 是旧行号，实际 `S.RUN_CAP_MS` 在 `:2249`、`drop()` 在 `:2380`。
3. 注册表里 `hitomi` 的 `weight 0.95` + `off:true` 并存（`assets/js/sources.js:2215-2220`）；`S.allForUI` 仍保留它以在 UI 里显示（`:2238-2240`）。
4. `tools/relay-deploy.md:188-201` 把 `nhentai.net` 标成 403（打的是 HTML 页），与 `tools/gateway.js:706-712`（打 JSON API ⇒ 200）不矛盾但口径不同 —— 引用时务必写清打的是哪个路径。
