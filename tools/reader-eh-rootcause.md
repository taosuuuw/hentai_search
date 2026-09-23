# E-Hentai 在线阅读「加载不出图片」根因取证（2026-09-23 测）

结论先行：**取图管道本身是好的，坏的是出口。** `e-hentai.org` 在本机解析链路上被沉洞到 `0.0.0.0`，
所以「图集页 HTML」这一关永远过不去；而图床 `*.hath.network` 解析正常、直连可用，
`/api/proxy` 取图实测 **HTTP 200 / image/jpeg / 237188B / sha256前12=b313a632ad6f**。
`/api/reader?source=ehentai` 返回 `ok:false · pages=0`（取不到图集页），阅读器因此没有任何可显示的页地址。

> 取证手段：`tools/eh-relay-probe.js`（新建，零依赖）+ `node -e` 单发 + `Resolve-DnsName` + `tools/reader-src-check.js`。
> 逐源原始结果在 `tools/reader-report.md`（11 源，1204 行）。

## 1. 出口层实测（本机，不经网关）

`Get-Date` = 2026-09-23 02:16:05，`Resolve-DnsName -Type A`：

| 主机 | 解析结果 | 说明 |
|---|---|---|
| `e-hentai.org` | **0.0.0.0** | 沉洞（block-sinkhole），不是 GFW 那种假 IP。`0.0.0.0` 连接立即失败 ⇒ 网关报「原路：fetch failed」（实测 39ms 就失败） |
| `www.pixiv.net` | `114.43.24.59` | 有真 IP，但 TLS/SNI 过不去 ⇒ 网关报「直连强化：DoH 没给出能验真的 IP」 |
| `sjyqamp.liyxcqbusacd.hath.network`（本次真实图床节点） | `77.93.157.244` | 正常，直连 TLS 可用 |
| `api.allorigins.win` | `104.21.38.59, 172.67.219.140` | 中继本身可达 |

`C:\Windows\System32\drivers\etc\hosts` 里**没有** hentai / pixiv / hath / `0.0.0.0` 任何条目
⇒ 这个沉洞来自解析链路（本机 DNS 或运行它的沙箱策略），不是 hosts 文件。

## 2. 网关侧失败原话（E-Hentai）

图集页（3 轮、间隔 50s，三轮回的**逐字相同**）：

```
GET /api/proxy?url=https%3A%2F%2Fe-hentai.org%2Fg%2F4109923%2Fe8a290c9df%2F&referer=https%3A%2F%2Fe-hentai.org%2F
→ HTTP 502 · 192B · ~5433ms · content-type: application/json
  {"ok":false,"error":"取不到 e-hentai.org：原路：fetch failed；直连强化：DoH 没给出能验真的 IP；中继：中继全失败：allorigins 冷却中；allorigins-get 冷却中"}
```

```
GET /api/proxy?url=https%3A%2F%2Fe-hentai.org%2F&referer=…   → 502 · 94B · 1ms
  {"error":"e-hentai.org 近期取源失败，已临时跳过（45s 后可重试）"}     （proxyFetch 的 deadHosts 冷却）

GET /api/proxy?url=https%3A%2F%2Fs3.hath.network%2F&referer=https%3A%2F%2Fe-hentai.org%2F → 502 · 215B · 15835ms
  {"error":"取不到 s3.hath.network：…；中继：中继全失败：allorigins 连不上：timeout；allorigins-get 连不上：timeout"}
```

阅读器接口：

```
GET /api/reader?source=ehentai&id=4109923-e8a290c9df
→ HTTP 200(JSON) · ok=false · pages=0 · 5.4s
  error: 连不上 E-Hentai 图集页：取不到 e-hentai.org：原路：fetch failed；直连强化：DoH 没给出能验真的 IP；中继：中继全失败：allorigins 冷却中；allorigins-get 冷却中
```

`/api/diag` 同一时刻：`ehentai ok:false (12395ms)`、`pixiv ok:false (13650ms)`，其余 nhentai/wnacg/hitomi/mangadex/jmcomic/copymanga/kemono 全 ok。

浏览器 `<img src="/api/proxy?…">` 拿到的是 **502 + application/json**，所以只会变成裂图、看不到原因
（`/api/proxy` 按设计只对 danbooru 的 `.json` 做 Chrome 兜底，图片不做兜底，见 `tools/gateway.js:5908-5957` 注释）。

## 3. 对照实验：取图管道是**好的**（关键证据）

`node tools/eh-relay-probe.js`（图集页 → `/s/` 页 → `<img id="img">` 大图，逐段记录）：

| 段 | 通路 | 结果 |
|---|---|---|
| 图集页 HTML | 直连 | `fetch failed`（39ms） |
| 图集页 HTML | allorigins raw | **HTTP 200 · 20263B · 2925ms**（真图集页，title `… - E-Hentai Galleries`，从中解析出 20 条 `/s/<ptoken>/<gid>-<n>`） |
| `/s/4109923-1` HTML | 直连 | `fetch failed`（2ms） |
| `/s/4109923-1` HTML | allorigins raw ×3 | 522 · 20701ms / 522 · 21904ms / 520 · 10780ms |
| `/s/4109923-1` HTML | allorigins-get | **HTTP 200 · 4709B · 6483ms**（从中抠出 `<img id="img">`） |
| 大图 `sjyqamp…hath.network:25136/…/1.jpg` | **直连本机** | **HTTP 200 · image/jpeg · 1780ms · sha b313a632ad6f** |
| 大图 | allorigins | **HTTP 200 · 237188B · 23179ms · sha b313a632ad6f**（第二遍 19405ms，同 sha） |
| 大图 | **本机网关 `/api/proxy`** | **HTTP 200 · image/jpeg · 237188B · 2512ms · sha b313a632ad6f；第二次 4ms（proxyCache）· 同 sha** |
| 大图 | i0.wp（图片专用中继） | HTTP 400 · 49B `Error 0004. Unable to load the image.` ×2 |
| `https://e-hentai.org/` | i0.wp | HTTP 400 · 37B（同上） |

⇒ 真实大图 URL（含 `keystamp=…;fileindex=…;xres=org`、带 25136 端口）被网关原样取回并正确服务，
`ehPageImage` 解析 / `readerProxyUrl` 包装 / `proxyFetch` / `/api/proxy` 全链路**无缺陷**。

AllOrigins 健康度（本轮 17 次尝试）：多数是自己 edge 的 500/520/522 且耗时 10–23s，只有少数 200
（图集页 2.9s / 7.4s）⇒ 唯一通用中继正处于劣化状态，无法支撑一次开卷需要的 2+N 次请求。

## 4. 为什么网关连「试一下中继」的机会都很小

- `proxyFetch` 的 `timeout` 是 12000ms（`tools/gateway.js:1477-1531`），`outFetch` 里三级阶梯的
  中继腿被 `left() = Math.max(2500, ms - 已耗时)` 夹住（`tools/gateway.js:707-870`）。
- 实测「直连强化」这条腿自己就要吃掉 ~5.4s（系统 DNS 秒回 → DoH 落定 → raceTls ~2.5s → sleep 400ms → 再 raceTls ~2.5s），
  于是轮到中继时只剩 `max(2500, 12000-5400) = 2500ms`，**比实测最快的一次中继成功（2925ms）还短**。
- `relayState` 冷却按 relay id **全局**（`RELAY_COOLDOWN=45e3`），任何主机把 allorigins 打到失败，
  就会让 allorigins 对所有主机冷却 45s —— 这解释了为什么错误文本常是「冷却中」而不是「timeout」。
- E-Hentai 阅读器是 N+1：`readerEhentai`（`tools/gateway.js:4197-4295`）要逐页拉 `/s/` 页解析真实大图，
  最多 `EH_MAX_PAGES = 40`，且 `EH_THROTTLE_MS = 300` 全局串行 —— 一次开卷 ≥ 2+N 次 e-hentai.org HTML 请求。

## 5. 改了什么

**`tools/gateway.js` 一个字节都没改。** 能证明的代码级缺陷一个都没找到：失败点全部在出口与中继，
而取图/包装/代理/缓存这一段已被第 3 节的对照实验证明健康。候选修复与放弃理由：

| 候选 | 结论 | 理由 |
|---|---|---|
| A. 把 `proxyFetch` 的 `timeout` 从 12000 抬到 25–30s，好让中继腿真正跑完 | **放弃** | ① 本轮 AllOrigins 17 次里多数是它自己 edge 的 500/520/522，抬预算只是把「快速失败」变成「20–30s 后失败」；② 一次开卷要 2+N 次 HTML 请求，即便成功也要几分钟，与「高响应」相反；③ 这个 timeout 是 `/api/proxy` 共用的，会连累检索侧（另一个 agent 负责的稳定性）；④ 网关是用户进程、我不得重启，改完无法在本会话内证实有效 —— 违反「能证明的才修」 |
| B. 给 `/api/proxy` 图片路径加「声明是图却回 HTML/JSON 就判失败」的内容校验 | **放弃** | 实测失败已经是 502+application/json，不是 200+HTML，对本案零效果 |
| C. `readerEhentai` 在常规 `ehHtml` 失败后补一次 `relayOnly` 重试 | **未采纳**（仅记录） | 机理可证（中继预算 2.5s < 实测最快成功 2925ms，走 relayOnly 能拿到完整预算），但实测中继成功率仅约 1/4、单次 6–23s，而一次开卷要 2+N 次请求 ⇒ 结果只会是「很慢且大量缺页」，且同样无法在本会话验证 |

本轮只动了 harness（都不进 `check-all` 的套件表，不影响真值）：

- `tools/reader-src-check.js`：11 源体检 harness。修了自测暴露的取 id 问题 —— MangaDex 检索改
  `https://api.mangadex.org/manga?limit=2&title=<q>`（带 `contentRating[]` 多值会被上游回 HTTP 400）；
  Hitomi 改用 nozomi（`https://ltn.gold-usergeneratedcontent.net/index-english.nozomi`，条目是 4 字节大端 gallery id，
  新增 `pickBin: b => String(b.readUInt32BE(0))`）；Danbooru 加 `fixed:'8000000'`（CF 在 id 解析前就失败，id 任意）。
- `tools/eh-relay-probe.js`（新建）：把图集页 → `/s/` 页 → hath 大图分开取证，见第 3 节；`--gw <url>` 模式
  直接打本机网关 `/api/proxy`，与浏览器 `<img>` 同一条路。

回归确认：`node tools/check-all.js` = concept-check **39 通过 / 2 失败**（两条都是既有 termFor 红线失败）、
cardtags 33/0、scroll 39/0、glass 62/0、reader 32/0、dict 28/0，exit 1 —— 与基线真值逐字一致。

## 6. 还剩什么没解决

1. **E-Hentai 在线阅读在本出口打不开**：`e-hentai.org → 0.0.0.0` 拿不到图集页 ⇒ `/api/reader` 给不出 pages。
   图床与取图管道均正常，所以只有把「页面出口」修好才有意义：给网关配可用出口
   （`node tools/gateway.js --proxy http://127.0.0.1:7897`，或先设 `HTTPS_PROXY` 再启动；
   `start-engine.cmd -GatewayArgs '--proxy','http://127.0.0.1:7897'`），或解除解析链路上的 `0.0.0.0` 沉洞。
2. **Pixiv** 同因（`DoH 没给出能验真的 IP`）。
3. **Danbooru / porn-comic** 卡在「Chrome 没能启动（调试端口未就绪）」——大概率是网关跑在受限环境里的测量伪像，
   需要真实桌面会话；本次检索侧也没取到真实 id（`posts.json` 被 CF 挑战页挡下，`search.html` 是纯 JS 壳）。
4. **本会话无法验证任何 `tools/gateway.js` 改动**：8788 是用户进程，不许重启；若后续采纳候选 A/C，必须重启网关后重跑
   `tools/reader-src-check.js --only=ehentai` 才算证据。
