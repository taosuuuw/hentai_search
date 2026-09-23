/* ==========================================================================
   fix-2026-09-23-net-and-reader.md —— 两件事的修复记录
   --------------------------------------------------------------------------
   ① ehentai / pixiv 的「不靠代理」网络通路
   ② 在线阅读左右翻页模式的「放大缩小不改变位置 + 任意倍率拖拽」

   用法：这是记录文件（不是脚本）。要复验请跑：
     node tools/cors-probe.js --gw=8788        # ① 的通路取证
     node tools/reader-cover-steps.js         # ② 的形状矩阵（经 live-probe）
     node tools/check-all.js                  # 全量回归
   ========================================================================== */

# 2026-09-23 修复记录：非代理通路 + 阅读器缩放/拖拽

## 一、先测量，再动手（这一轮最重要的教训）

**上一轮的全绿是被旧进程骗出来的。**

真机测量前先确认「浏览器拿到的到底是哪份代码」，本轮实测踩到：

| 入口 | 服务的 reader.js | 有 `anchorPageEl()` 吗 | 横图放大漂移 |
|---|---|---|---|
| `:8788`（用户一直用的那个） | 86 715 B · 1 495 行 | **没有** | **147.81px** |
| `:8799`（本轮新起，同一份磁盘代码） | 111 140 B · 1 996 行 | 有 | **0.14px** |

`:8788` 上的网关进程 **PID 6552 起于 08:25:58**，早于所有 reader 改动
（`reader.js` 写盘 07:33、本轮编辑 09:21）⇒ 它跑的是旧码。
沙箱里 `netstat` / `Get-NetTCPConnection` 被拒（不是返回空），
所以「服务的是哪份代码」只能**用行为证据**判定：直接比字节数 + 查特征函数名。

```powershell
# 判据（比 PING 可靠）：服务的字节数必须等于磁盘上的字节数
(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8788/assets/js/reader.js).RawContentLength
(Get-Item assets/js/reader.js).Length
```

⇒ **改完前端一定要重启网关并复验字节数**，否则测的是上一版的幽灵。

---

## 二、① ehentai：**不需要代理，已经通了**

### 2.1 新通路：`https://cors.eu.org/<完整 URL>`

路径式语法（`?url=` 与 `/api` 两种写法实测都回 500）。本机无代理、无 VPN 实测：

| 目标 | 结果 | 耗时 |
|---|---|---|
| `https://e-hentai.org/` 首页 | 200 · 66 139 B | 268–787ms（**8/8 全成功**） |
| `/g/<gid>/<token>/` 图集页 | 200 · 20 114 B（解析出 20 条 `/s/` 链接） | 233–783ms |
| `/?f_search=fate&f_apply=Apply+Filter` 搜索页 | 200 · 67 612 B（真结果） | ~320ms |
| `/s/<ptoken>/<gid>-<n>` 页 | 200 · 4 662 B（含 `<img id="img">`） | ~223ms |
| 大图 `https://<node>.hath.network/…/x/0` | 200 · 237 188 B · `image/jpeg` | 691ms |
| 5 个不同 URL 并发 | 全 200，未触发限流 | 821ms |

**大图 `sha=b313a632ad6f`，与 `tools/reader-eh-rootcause.md` 记的那张逐字节一致** ——
证明这是同一条内容通路，不是「取到了某个别的页面」。

对照同日 AllOrigins：`/raw` 16.2s 回 520/522、`/get` 5.4–5.9s 才回 200（第 3 次 500）。
⇒ cors.eu.org 是唯一能进 12s 预算的那条腿。

### 2.2 真正的坑不是通路，是**预算被白烧**

修之前 `/api/diag` 的原文：

```
ehentai: { ok: true, ms: 10978, via: 'relay' }
```

**中继其实成功了**，但 `ehentaiSearch` 的硬闸是 6000ms ⇒ 成功那一次也被自己掐死，
用户看到的是「E-Hentai 永远连不上」。

机制：`outFetch` 三条腿是**串行**的（原路 → 直连强化 → 中继），
而 e-hentai 的前两条在本机**注定失败**，DoH 那条还要烧 5.4s 做多候选 TLS 验真
（全部 `ECONNRESET`），轮到中继时只剩「预算 − 5.4s」。

修法 `RELAY_PREFERRED`（`tools/gateway.js`）：把「直连+DoH 恒失败、中继恒成功」
的主机预先标成 `relay`，进门直奔中继；并且**失败后不回头补跑**那两条死腿。

### 2.3 修后实测（用户端口 8788，无代理）

| 操作 | 修前 | 修后 |
|---|---|---|
| 首搜 `q=fate` | 6641ms **失败** | **1022ms** ok · 10 条 |
| `q=asuna` | 失败 | **267ms** ok · 5 条 |
| `q=genshin` | 失败 | **310ms** ok · 5 条 |
| `q=blue archive` | 失败 | **320ms** ok · 5 条 |
| 同一词再搜 | — | 1–3ms（进程内 5 分钟缓存） |
| `/api/reader` 图集 | 失败 | ok · 40 页 |
| 封面图 6 条 | 失败 | **6/6 可解码**（WebP/RIFF） |

### 2.4 顺手堵的坑：cors.eu.org 的**假 200**

上游报错时它**不转发上游状态码**，而是回 `200` + 一小段错误文案。实测：

```
/g/9999999999/xxxxxxxxxx/  →  HTTP 200 · 172B
body: "Gallery not found. If you just added this gallery, you may have to wait…"
```

不拦的话调用方会把「Gallery not found」当成**正常图集页** —— 页面能解析但一条 `/s/` 链接都没有，
于是上报成「这个图集没有内容」，用户看到的是「没货」而不是「没取到」。
判据是**短正文（<2000B）+ 已知错误话术 + 没有链接**三条同时成立
（只用长度会误伤真实的 `/s/` 页 —— 实测 4662B）。

### 2.5 pixiv：**这条通路解决不了，原因是另一个**

```
cors.eu.org + https://www.pixiv.net/**  →  一律 HTTP 403 · 373 085 B
```

那 373 KB 不是 Cloudflare 挑战页，是 **pixiv 自己的 WAF 拦截页**，正文里的原文：

- `block_waf: { title: "ブロックされました", description: "あなたの環境からは{{service}}にアクセスできません。" }`
- `"あなたの環境からはpixivにアクセスできません。"`

⇒ **pixiv 按「机房 / 数据中心 IP」封中继的出口**，
与「本机被墙（DNS 污染 + TLS RST）」是**两个不同的墙**。换中继解决不了：
中继自己的 IP 也在 pixiv 的黑名单里。所以 `RELAY_PREFERRED` **刻意不包含 pixiv**
（预置成 relay 只会把「三条腿全灭」换成「一条腿必灭」，还丢掉 DoH 的报错细节）——
`gateway-check.js` 里有一条反向断言守着这件事。

pixiv 现状（诚实结论）：直连 → `ECONNRESET`；DoH 钉 IP → 全部 `ECONNRESET`；
15 条公共中继 → 全灭；cors.eu.org → 403 WAF。**没有非代理通路。**

### 2.6 ⚠ cors.eu.org 的运维约束：**出口是共享的，会被 e-hentai 限流封禁**

这是本通路唯一的软肋，必须记下来（2026-09-23 实测踩到）。

cors.eu.org 是**公共中继**，它取 e-hentai 的那一跳用的是**它自己的出口 IP**，
而且那个 IP 被很多人共用。**请求频率一高，e-hentai 就会封它**，
回 `HTTP 200` + **243 B** 的错误页（又是一次「假 200」）：

```
This IP address has been temporarily banned due to an excessive request rate.
This probably means you are using automated mirroring/harvesting software…
```

同一时刻的取证：

| 目标 | 结果 |
|---|---|
| `/`、`/popular`、`/?f_search=…`、`/g/…`、`/s/…` | 200 · **243 B**（封禁页） |
| `/news.php` | 200 · **48 394 B** 真页面 |

⇒ 是**按路径/频率的部分封禁**，不是整站不可达，也不是本机被墙。

**本轮就是被自己的探针打出来的**：`cors-probe.js` 的连打测试 + 阅读器首次
逐页取 40 个 `/s/` 页（每页都要过中继）+ 反复的 `/api/diag`。教训：

- **不要为了取证连续猛打 cors.eu.org**。要连打测稳定性就只打 **`/news.php`
  或首页 6 次**（本轮就是这么做的，那一次没触发），别把图集页 + `/s/` 页串起来猛刷。
- 这条封禁**按小时计**，会自动解封；用户侧不需要做任何事（不是他的 IP 被封）。
- 网关已经把这种响应**识别成「限流封禁」并如实报错**（`ehBodyErr`，
  `tools/gateway.js:4691`），不会伪装成「0 条结果」；180s 冷却期内毫秒级返回同一结论。
  本轮顺手把这条错误文案改准了：原来写「封了当前出口 IP……换一个出口代理再试」，
  会把人引到「去换代理」这条错路上 —— 现在明确写清**封的是取页那一跳的出口（中继的共享出口）、
  不是用户的 IP，等它自动解封即可**。

**替代中继：本轮把能找到的都试了，没有能替它的**（各打 1 次，均未取到真 e-hentai 内容）：

| 候选 | 结果 |
|---|---|
| `cors.bridged.cc` / `api.corsfix.com` / `corsproxy.eu.org` / `cors.red` | `fetch failed`（连不上） |
| `cloudflare-cors-anywhere.*.workers.dev` / `*.zibri.workers.dev` / `goxcors.herokuapp.com` | timeout（worker 域被墙） |
| `proxy.corsfix.com` | 400 `invalid_origin`（要 Origin 头） |
| `corsfix.com/?url=` | 200 · 85 142 B，但**不是** e-hentai 内容（它自己的页面） |
| `whateverorigin` / `cors.sh` / `corsfix.com/` | 200/404 但正文不是目标内容 |
| `allorigins /get` | 522/520 · 12–20s（所以它在表里只能当后备，进不了 6s 预算） |

⇒ cors.eu.org 目前是**唯一**可行的非代理通路。若要摆脱「共享出口被连坐」这个风险，
唯一稳的路子是**自建一个中继**（Cloudflare Worker 免费额度 10 万请求/天，
`github.com/Zibri/cloudflare-cors-anywhere`），出口就归自己 —— 但那需要用户有 CF 账号，
本轮没做（见「没做的部分」）。

### 2.8 ⚠⚠ 最重要的运维结论：cors.eu.org 是**免费配额**，会被跑干

这是本轮最值钱的一条发现，也解释了为什么「一会儿能用、一会儿不能用」。

把它的 429 正文扒开看，不是 e-hentai 在限流，是 **cors.eu.org 自己被 Cloudflare 掐了**：

```
HTTP 429 · 53086 B · server: cloudflare · cf-ray: …-AMS
<title>This website has been temporarily rate limited | cors.eu.org | Cloudflare</title>
<h2 class="cf-subheadline">Error 1027</h2>
<p class="cf-error-description">You cannot access this site because the owner has
   reached their plan limits. Check back later once…</p>
```

**Cloudflare Error 1027 = 「站点所有者用完了套餐额度」**。
也就是说：cors.eu.org 跑在**免费套餐**上，我们这一轮的取证 + 阅读器逐页取 `/s/`
把它打到了当日/当窗口的额度上限，之后**所有**请求都回 429，跟 e-hentai 是否封禁无关。

⇒ 这条通路的性质要说清楚：**能用，但不是稳的**。它适合「偶尔查一次」，
不适合「阅读器一次拉 40 页」这种量。缓解办法（本轮已落地）：
逐腿分预算 + 429 立即 45s 冷却 + 报错写明是哪条中继在限流（见 2.7 ④）。

**两个候选都试过了，都不比它好：**

| 候选 | 实测 |
|---|---|
| `api.cors.lol` | 第一次 1112ms **拿到真 e-hentai 首页**（61 825B），但**紧接着就 429**，连打 5 次全 429（20B）—— 比 cors.eu.org 更早触发，不可用 |
| `allorigins /raw` | 此刻能取到真页面（61 825B），但耗时 **19 888ms**，是 cors.eu.org 的 ~70 倍，进不了 6s 预算 |

**真正稳的做法（留给用户决定）：自建一个 Cloudflare Worker 当私有中继。**
免费额度 10 万请求/天、出口独立、不受别人用量影响。
`workers.dev` 域在本机不可达（实测 timeout），所以要么绑自有域名，
要么在能访问 `workers.dev` 的网络里部署 —— 这需要用户的 CF 账号，属于「需要用户动手」，
本轮没有擅自做。

### 2.7 顺着封禁挖出来的三个真 bug（都已修 + 已上断言）

封禁把「错误路径」跑了个遍，因此暴露出三处一直存在、但平时看不见的缺陷：

**① `/api/diag` 把封禁页当健康。** 它原来只判 `r.status < 500`，于是封禁期照样报
`ehentai: { ok: true, status: 200, ms: 711 }` —— 页面据此显示「E-Hentai 可达」，
用户去搜却是全空。这是本仓库**第三次**踩同一类坑（AllOrigins 空壳 200、
cors.eu.org 假 200、e-hentai 封禁 200），于是这次把判据**收敛成一份共享实现**：

```js
const TRAP_MARK = /temporarily banned|excessive request rate|gallery not found|access denied|bad gateway|not found\.\s*If you just added/i;
function isTrapBody(buf) {           // 小响应才算：>2048B 一律当内容
  if (!buf || !buf.length) return true;
  if (buf.length > 2048) return false;
  return TRAP_MARK.test(buf.slice(0, 1200).toString('utf8'));
}
```

三处共用它：`/api/diag` 的健康判定、`relayFetchOnce` 的假 200 闸。
**并且它只在 `rel.fakeOk` 类（文本）中继上开启** —— 图片中继（i0.wp）绝不能读正文，
真图片的前几字节就可能匹配到关键字，会把好图判成坏图。
`gateway-check.js` 有一条**用真函数跑 8 个真实样本**的自证
（封禁页 / Gallery not found / 空壳 判真；真页面 / 真图片 / 小 JSON / 上游自己的 404 判假）。
> 其中「上游自己的 404 页要**放行**」这条当时把判据写错过一次 ——
> 那是真实状态，不是中继在骗人；只有 cors.eu.org 那句特定话术才算陷阱。

**② 错误文案复读。** 真机原文：

```
连不上 E-Hentai：连不上 E-Hentai 搜索：取不到 e-hentai.org：中继：…
```

`ehHtml` 抛出来的话**已经自带**「连不上 E-Hentai 搜索：…」前缀，调用方又拼了一次。
两个出口（硬闸 catch / `!gotPage`）都改成判「有没有说过连不上」再决定拼不拼。

**③ `DEAD_SITE_FIX` 已经过时。** 它还在写「直连无解；挂上代理即可恢复」——
在 e-hentai 已经有中继通路的今天，这句话会把人引到「去挂代理」这条**错的自救方向**。
现在改成：讲清 e-hentai 平时由 cors.eu.org 代取（不需要代理），
**这里失败通常是中继也被限流**，等一会儿自动解封；想立刻恢复才挂代理。

**④ 中继冷却时白烧预算（两处，都修了）。**

`RELAY_PREFERRED` 的语义是「这台主机的原路与 DoH **实测恒失败**」，
所以中继一断，剩下的路一条都不可能通。可有两处在死腿上白花时间：

1. **冷启动第一发仍然跑竞速。** `plan === 'relay'` 那一支只在「已经有记忆」时生效，
   而 `hostPlan` 是**进程内存** —— 每次重启后的第一发都是 `!plan`，
   于是照样掉进 env/DoH 竞速，DoH 那腿做多解析器 × 多候选 IP 的 TLS 验真，100% 白烧。
   ⇒ 改成 `RELAY_PREFERRED` 的主机**第一次也只走中继**。
2. **中继腿是串行的，而每条腿原来都拿 `o.timeout` 全量** ⇒ 「腿数 × 全量超时」，
   实测能拖到 60s。这是 `outFetch` 里 `leg()` 早就修过的同一个毛病，中继腿没跟着修。
   ⇒ 逐腿分预算：`perLeg = clamp(total / 腿数, 600, 18000)`。

实测效果（冷启动第一发，中继不可用时的失败路径）：

| | 墙钟 | 拿到的信息 |
|---|---|---|
| 修前 | **6648ms** | 只有一句「超过 6000ms 硬闸」，**真正原因被截断** |
| 修后 | **5081ms** | 完整：哪条中继、什么状态、冷却多久、正文 |

顺带把 429 的文案补全：中继限流时回的是**它自己的 HTML 错误页**，
原来只写「限流/报错（HTTP 429）」，看不出是谁在限流；现在带上一小段正文：

```
cors-eu 中继自己限流了（HTTP 429，53086B）：冷却 45s｜正文= <!doctype html> <!--[if lt IE 7]>…
allorigins 连不上：timeout；allorigins-get 连不上：timeout
```

> ⚠ 注意 cors.eu.org 有**两道不同的限流**，别混为一谈：
> ① **e-hentai 封中继的出口**（243B「temporarily banned」，按小时）；
> ② **中继自己限流**（429 + 它自己的 HTML，冷却 45s）。
> 本轮探针把两道都打出来过。

---

## 三、② 阅读器：横图放大跳位（只有横图中招）

### 3.1 症状与取证

新写了 `tools/reader-cover-steps.js`（形状 × 方向矩阵，经 `tools/live-probe.js` 跑真鼠标）。
为什么必须新写：上一轮的 `reader-zoom-steps.js` **只用 1000×1400 的竖图**，
而横图的可滚余量结构与竖图完全不同（横图 y 轴装得下、x 轴装不下）。

修前实测（真机，1280×900）：

| 形状 | h 模式 100%→120% 漂移 | 走的档 |
|---|---|---|
| 竖图 1000×1400 | 0.19px | 滚动 |
| 方图 1200×1200 | 0.20px | 滚动 |
| **横图 1600×900** | **13.51px** | 滚动 + **transform** |

且 `tf=translate3d(0px, 13.8px, 0)` —— 有位移被写到了 `<img>` 上。

### 3.2 根因：不是夹取公式错，是**分工错**

`serc` 那一步其实**做对了**。逐帧取证（临时插桩，已撤）：

```
apply-before : picTop=114.52  picH=840.38  ty=523.71  cy=450  fy=0.4869
apply-after  : wantY=73.71  scrollTop 0 → 74   (页盒 roomY=166)
residual-p0  : dRaw={dx:-0.03, dy:0.29}          ← 滚动之后只剩 0.29px 误差
               gRaw={gx:116, hx:-98, gy:13.76, hy:19.10}
               clamped={dx:-0.03, dy:13.76}      ← 夹取区间 [13.76, 19.10] 不含 0
               moved=true
```

`zoomAnchorApply()` 的滚动把锚点落到了**离正中 0.29px**，
紧接着 `zoomAnchorResidual()` 第一遍量到「画面自然位置在页盒上沿之上 13.76px」，
而夹取区间两端**同号**（`[13.76, 19.10]`）—— 于是把 13.76px 的向下位移写到 `<img>` 上，
**把已经对齐的画面硬推下去**。

### 3.3 修法

残差先问「这一轴滚动还有没有余量」（`a.roomX` / `a.roomY` 由 `zoomAnchorApply` 记回锚点）：

- 该轴缩放后**有余量**（`>1px`）⇒ 误差交给滚动，残差**不动这一轴**；
- 余量为 0（≤100% 两轴都滚不动、或已滚到尽头）⇒ 才由位移补足。

**逐轴**判断而不是整体跳过：横图 120% 时 x 有余量（给滚动）、y 没有（给残差），
正是需要分开处理的组合。

### 3.4 修后实测（9 个 形状×方向 组合全绿）

| 形状 | h 模式最大漂移 | v 模式最大漂移 |
|---|---|---|
| 竖图 | 0.20px | 1.51px |
| 横图 | **0.29px**（修前 13.51） | 1.51px |
| 方图 | 0.20px | 1.51px |

**全局最大漂移 1.51px**（修前 147.8px），肉眼不可见量级。

拖拽（真鼠标 `Input.dispatchMouseEvent`，判据 = 同一张图的屏幕位移）：

| 场景 | 结果 |
|---|---|
| h 100% 拖 (130,95) | `dl=130, dt=95` **完全跟手**（走 transform，因两轴无余量） |
| h 100% 反向拖 (-170,-130) | 跟手 |
| h 140% 拖 (150,105) / (-180,-140) | 跟手（走页盒滚动，`scrollLeft` 163→343） |
| v 100% 拖 (130,95) | `dt=95` 跟手 |
| v 100%/140% 拖到边界 | 被 root 滚动余量夹住（拖到容器边缘就停 —— 那正是「拖到底」） |

⇒ 用户的两条要求都成立：**任意倍率（含 100%、80%）都能按住拖**，且**缩放不改变观看位置**。

---

## 四、本轮新增/改动的文件

| 文件 | 改动 |
|---|---|
| `tools/gateway.js` | `RELAYS` 加 `cors-eu`（排第一）+ `fakeOk` 假 200 识别；`RELAY_PREFERRED` 预置通路；`outFetch` 读它；启动日志补说明 |
| `assets/js/reader.js` | `zoomAnchorApply` 记 `roomX/roomY`；`zoomAnchorResidual` 逐轴判余量 |
| `tools/gateway-check.js` | 39→**41 条**：cors-eu 接线、假 200 检测器自证与反向、pixiv 不在 RELAY_PREFERRED、isTrapBody 真函数自证 8 例、逐腿分预算、429 文案 |
| `tools/reader-check.js` | 47 条（+5）：横图跳位的四道防线 + 判据自证 |
| `tools/cors-probe.js` | **新增**：① 的通路取证探针（带结论行，全绿才 exit 0） |
| `tools/reader-cover-steps.js` | **新增**：② 的形状 × 方向矩阵（经 `live-probe.js` 跑） |

回归：`node tools/check-all.js` ⇒ **8 套件 / 327 条断言全绿**（reader 42→47、gateway 21→41）。

## 五、给下一轮的入口

```powershell
# ① 通路是否还在（会打真网络，~30s）
node tools/cors-probe.js --gw=8788
# ② 阅读器形状矩阵（需要 danger-full-access，Chrome 在 workspace-write 下会被沙箱杀掉）
node tools/live-probe.js --url=http://127.0.0.1:8788/ --steps=tools/reader-cover-steps.js --w=1280 --h=900 --wait=1500
# ③ 全量回归（不需要网络、不需要浏览器）
node tools/check-all.js
```

**没做的部分（明确划界）：**
- 没给 pixiv 造非代理通路 —— 不是没试，是**客观不存在**（见 2.5）。
- **没自建中继**。cors.eu.org 是公共共享出口，会被 e-hentai 连坐封禁（见 2.6）。
  要彻底摆脱这一点只能自建（Cloudflare Worker，免费额度 10 万/天），
  但那要用户自己的 CF 账号与一次部署，属于「需要用户动手」的决定，本轮没擅自做。
- 没动 `/api/reader` 取 40 页要 13.9s 这件事：网关侧实测 2ms（命中了 4 分钟缓存），
  慢的是**每个图集的首次**逐页取 `/s/`；旧预算 `EH_MAX_PAGES=40` 与串行闸门都没碰，
  它不属于本轮两条需求，留作下一轮的观察项。

## 六、本轮踩到的两个「假象」（都值得记）

1. **旧进程 = 旧代码**。`:8788` 上的网关是 08:25:58 起的进程，服务的是**旧 reader.js**
   （86 715 B / 带 LF 行尾），而磁盘上早就是 111 140 B / CRLF 的新版。
   沙箱里 `netstat` 与 `Get-NetTCPConnection` **被拒**（不是返回空），
   所以只能靠「比对服务字节数 vs 磁盘字节数」判定，别信 `PING` 通不通。
2. **假 200 有两种，长相完全不同**。
   - cors.eu.org 把**上游报错**当 200 交回来：172 B「Gallery not found.」（已拦，见 2.4）；
   - e-hentai 把**限流封禁**也回成 200：243 B「temporarily banned」（网关早已识别，见 2.6）。
   两者都**不是** `!r.ok` 能拦住的，判据必须看**正文**。
