# 更新日志（CHANGELOG）

本项目以 Git 标签 / GitHub Releases 为发布口径：https://github.com/taosuuuw/hentai_search/releases

- 历史标签：`v3.2.0`、`v2.0.0`
- 旧分支 `1.0` / `1.9` / `2.0` 保留在仓库中，仅作对照，不再更新
- 3.0 分支上的工作已在本版归档，分支 `3.0` 同时更名为 `main`

---

## v3.3.0

3.2.0 之后的迭代归档。三条主线：

1. **启动就能看到结论** —— 一进页面就让网关把出口自检 / DoH 钉真 IP / 中继选择先跑掉，不再让用户用「第一次搜索」去付这笔探测钱；
2. **失败要说清是哪一种失败** —— 「网关没等到结论」与「被上游按出口 IP 限流封禁」是两件事，「封禁页」也不再被算成「成功地返回 0 条」；
3. **阅读器首屏更快** —— 首屏等图的那 1 秒多被提前藏进「等 JSON + 浏览器建 DOM」的时间里。

### 启动预热与可观测

- **新增 `/api/warm`**（`tools/gateway.js`）：把 `/api/diag` 那套出口自检提前到**弹出网页时**跑掉，顺手把阅读器要用的图片主机钉好 IP（只做 DNS + TLS 验真，不取内容）。三段并行、各自软超时、整段再套保险丝——**预热绝不能变成新的等待**：第一版把三段串起来写，真机实测 31.2 秒才回。刻意**不**对 e-hentai 发检索：取证显示它的封禁窗口正是重试刷出来的。
- **结论只认完整的那一份**：只有「每个目标都真拿到了结论」才允许写进 `/api/diag` 与预热共用的结论缓存（60 秒）；任何一项是硬超时（`unknown`）都不许冒充最终结论——把一次超时说成「连网关也打不通」正是误报的来源。
- **前端**（`assets/js/net.js`、`assets/js/app.js`）：网关一连上就让它预热，并且**先把网关探明、再做网络自检**，修掉「弹出网页时就看到『部分网点没有连接』」；标题栏也先认「网关到底在不在」，并把「这次没等到结论（unknown）」与「被出口 IP 封禁」分开讲。

### 阅读器提速

- **`/api/reader` 返回的同时预热首屏图**（`warmReaderImages`）：nhentai 一次 `/api/reader` 本身只要 455ms，但第一张图冷取要 1468ms——首屏那 1 秒多全花在图上。现在返回 JSON 时顺手把前 2 页图拉进代理缓存。预热是**投机性**的：失败一律吞掉，不进在途合并表、不写缓存，**也不许把主机拉进冷却**。
- **新增 `/api/prefetch`**：阅读器把「接下来几页」的取图地址一次性交给网关，网关按并发上限取回并填进**与 `/api/proxy` 完全同一份缓存**（缓存键刻意用同一把，否则预取全白做），用户真滑到那页就是毫秒级命中，中继/上游配额也不必重复烧。逐条吞错、有整批死线，绝不因预取失败影响主流程。
- **nhentai 的图库 JSON 预算重定标**：总预算 20000 → 10000ms，非私有腿再压 `legCap = 2000ms`。原来最坏路径会给两条 AllOrigins 各 4750ms（实测 12137ms 才回来），而这一发只是取一段 ~3KB 的 JSON。

### E-Hentai：把封禁讲清楚，并且不再每次搜索都重烧

- **封禁记忆在两条路之间共享**（`ehBanGate()`）：以前「点开一个 E-Hentai 作品（弹窗 / 阅读器）」学到的上游封禁只写给阅读器那条路，搜索路径的短路闸门只认网络层失败——于是接下来**每一次搜索**都把三条腿重烧一遍，烧满预算才失败，体感就是「每次搜索都要等」。现在两种记忆都算短路理由。
- **封禁与出口绑定**（`ehBanEgress`）：出口一变（用户开/关代理）就不再拿旧出口的封禁去挡新出口，恢复不需要重启网关。
- **熔断期间不走浏览器直连兜底**（`assets/js/sources.js`）：网关和浏览器在同一条出口上，网关已经判出「上游按出口 IP 限流」，浏览器直连面对的是同一面墙——实测这一路要白烧 4–5 秒然后同样失败。现在拿到熔断结论就立刻如实交差（UI 显示**带原因的失败**，不是「0 条结果」），把时间和预算还给别的源。
- **文案里不再出现倒计时**：用户明确要求别在每次搜索里看到「还要等多少秒」；剩余时间仍在结构化 `cooldown.secs` 里，前端要展示时自己决定怎么讲。
- **修「E-Hentai 返回 0 条」的假成功**：`directAnswered = true` 原先写在封禁判定**之前**，于是「取到了页面但那是封禁页」这条路上先置成功标志、下一行抛错被 catch 吃掉而标志没回滚，最后走到函数尾部返回空数组 ⇒ UI 显示「✓ E-Hentai 返回 0 条」。现在先判定、确认是**真页面**之后才置成功标志。
- **按上游自己的倒计时冷却**：不再每 25 秒撞一次，并把解封时刻记下来；`DEAD_SITE_FIX` 把 e-hentai 与 pixiv 拆开，两者的死因不同、修法也不同。

### 自建中继（首次入库）

本机出口上，`e-hentai` 与 `pixiv` **没有任何现成通路**：e-hentai.org 系统 DNS 直接 NXDOMAIN、DoH 给的候选 IP 带真 SNI 直连全超时；pixiv 的 DoH 给的是 Cloudflare 真段，带真 SNI 直连约 100ms 就被 ECONNRESET；15 条公共中继候选 × 2 个目标 = **0 成功**。唯一出路是自己的墙外中继，因此本版把整条链路补齐并入库：

- `tools/relay-setup.ps1` —— **一次性**向导（自动部署到 Cloudflare Pages / 粘贴已有地址 / 自己的 VPS / 本机自测 / 稍后再说），状态记在 `tools/.relay-setup.json`，以后每次启动自动跳过；非交互式启动绝不弹向导、绝不阻塞。
- `tools/relay-setup.js` —— 向导的判据与落盘（零依赖 CommonJS，可被断言测试），也是 macOS / Linux 的手动入口（`--set-relay=<地址> --key=<key>`）。
- `tools/relay-server.js` / `relay-worker.mjs` / `relay-deno.ts` —— 三种自建中继实现（VPS / 软路由、Cloudflare Workers・Pages、Deno Deploy）。
- `tools/relay-check.js`（93 条断言）与 `tools/relay-deploy.md`（为什么非自建不可 + 三种部署 + 验证 + 网关接线 + 实测记录）。
- `tools/relay.txt.example` —— 配置模板（真正的 `tools/relay.txt` **不入库**，`.gitignore` 已排除）。
- `tools/start-gateway.ps1` 起引擎**之前**调向导，新增 `-RelaySetup` / `-NoRelaySetup` / `-ResetRelaySetup`；就绪后读 `/api/ping` 的 `relays` 打印一行「自建中继：已启用 / 配了但网关没认出来 / 未配置 ⇒ e-hentai / pixiv 搜不到」，不用猜它认没认出来。
- 向导做**任何网络判断都走 node**：本机实测 PowerShell 5.1 的 `Invoke-WebRequest` 连不上任何外网 HTTPS（npm 源 / Cloudflare 全部报「基础连接已经关闭」），而同一时刻 Node 全部 200——用它判断可达性会得出错误结论。

### 信息源与出口

- **公共后备腿更短的上限**：`legCap` 让只取一小段文字/JSON 的请求不必给公共中继留满预算。
- **自检要有真死线**：`/api/warm` 与 `/api/diag` 的自检撞上上游限流时必须把封禁窗口记下来（`ehBanEgress`）；同时明确「直连被 Cloudflare 拦 ≠ 这个源不能用」（porn-comic 走本机 Chrome 那条腿就是为它准备的）。
- **wnacg 自检换镜像**：`www.wnacg.com` 首页实测 4900–7200ms，自检改打 `02.cc`。
- **中继不接拷贝漫画 API 节点**（`RELAY_BAD_HOSTS`）：实测中继对它们只回空壳，白烧配额。
- **禁漫域名复用**：5 分钟内优先复用上次选中的域名（`jmPickHost`），换域名时重试 `/chapter` 与章节模板。
- **批量预取的闸门与在途合并**：同一张图被两处同时要，只发一次。

### 界面

- **卡片 / 放大器的完整标签**（新增 `assets/js/cardtags.js`）：小卡片与大卡片原本只显示 1–2 个标签，因为两条路都不通——① 检索接口本身不带标签（nhentai 的 `/api/v2/search` 只回数字 `tag_ids`），② 带回来的被 `slice(0,16)` 再取前 6 截断。现在对**进入视口**的卡片按作品 id 从原站补一路**只用于展示**的标签，存进 `it.srcTags`（**绝不写回 `it.tags`**，避免连带改变同系列堆叠与跨源去重）。约束是硬性的：同一时刻最多 2 个在飞、同源两次请求至少隔 280ms、结果落 `localStorage` 30 天、某个源一旦 403/429/超时则**整源冷却 5 分钟**——宁可标签晚点出现，也不要把出口 IP 打黑（那会连检索一起拖垮）。网关离线 / 该源没有取法 / 缓存已命中 ⇒ 一个请求都不发；失败是静默的。
- **右下角「迅速回顶」**（新增 `assets/js/totop.js`）：滑动超过 `max(480px, 视口高度 × 0.6)` 才出现（太早出现会压住卡片右下角的操作区）；点击走自绘 rAF 340ms `easeOutCubic` 补间（原生 `scroll-behavior:smooth` 在长页面上要 600ms+）；补间期间用户自己一滚就立刻交还控制权；rAF 被挂起时另有兜底定时器，不会「点了没反应」；动效关闭时直接瞬移。
- **「汉化 / 中文」成为结果页的一个筛选位**（`assets/js/results.js` 的 `R.zhOnly`）。
- **跨语言词形补漏**（`assets/js/xlate.js`）：补上 `-ism ↔ -ist` 这组同词根不同词性（英/法）。
- **搜索框测光阴影层**（`index.html` 的 `.hs-sb-shade` + `assets/css/style.css`）。

### 回归校验套件（新增）

- **`node tools/check-all.js`**：一次跑完 **9 套断言、489 条**，全绿退出码 0。它把各套件源码在**同一进程**里用 `Module._compile` 编译成「非主模块」再取出 `main()` 调用（各套件都有 `require.main === module` 守卫且末尾 `process.exit`），临时接管 `console.log` / `process.exit`，只打印「每套 通过 N / 失败 M + 失败行」。
  套件：`concept-check`（词义 / 源 / 回归红线）、`cardtags-check`（卡面标签）、`scroll-check`（滚动到底 + 回顶）、`glass-check`（液态玻璃材质）、`reader-check`（阅读器缩放 / 拖动 / 退出）、`recent-check`（最近浏览记账 + 角标）、`dict-check`（黑话词典 + 打字提示）、`gateway-check`（网关出口 / 断路器 / 路由 / 注释吞代码）、`relay-check`（自建中继协议 / 转发 / 鉴权 / SSRF / 网关接入）。
- **一次性取证探针**（不进 `check-all`）：`live-probe.js`（零依赖真机探针，Chrome headless + CDP）、`reader-src-check.js`（在线阅读逐源体检：`/api/reader` 的 `pages[]` 与 `/api/proxy` 的字节两段分别验）、`query-send-check.js`（这一次检索到底给每个源发了什么词）、`alias-probe.js`（改词表前先量真实条数）、`cors-probe.js` / `eh-relay-probe.js`（E-Hentai 通路取证）。

### 文档与仓库卫生

- **README**：版本元信息更新为 `3.3.0`；网关接口表补上 `/api/warm`、`/api/prefetch`；目录结构补上 `assets/js/cardtags.js`、`assets/js/totop.js` 与 `tools/` 下的全部校验套件与探针；启动器参数补上 `-RelaySetup` / `-NoRelaySetup` / `-ResetRelaySetup`，并新增「一次性设置：自建中继」一节。
- **`tools/` 下新增 20 余篇轮次取证与根因文档**（如 `round18-startup-stability-and-reader.md`、`reader-eh-rootcause.md`、`stability-report-r*.md`、`source-transport-map.md`、`relay-deploy.md`），把「怎么量出来的」和「为什么这么改」留在仓库里。
- **`.gitignore` 显式排除本机记录**：`.dsh/`、`.mnemon/`、`.wrangler/`、`tools/_*`（下划线临时产物）、`tools/stability-run/`、机器可读的测量输出（`*-truth-*.json` / `ui-diag.json` / `reader-zoom-*.json` 等）。仓库只留源码、文档、可复用的校验/探针脚本和中继实现。

### 升级注意

- **升级后重启一次网关**：预热结论、封禁记忆、在途合并、图片缓存都是**进程内**状态。
- `.dsh/`（工作区记忆技能）**不再入库**：它属于本机记录，已从仓库移除并加入 `.gitignore`；本地文件不受影响。
- 首次启动会**多问一次「自建中继」**（一次性）：不想配置就选「稍后再说」，或启动时加 `-NoRelaySetup`。不配置的话 `e-hentai` 与 `pixiv` 仍然搜不到——这是出口事实，不是本版的回归。
- 附带源码包 `hentai_search-3.3.0.zip` 由 `git archive` 从 `v3.3.0` 标签打出，与标签内容一致。

### 已知限制

见 README 的「已知限制」一节；本版未消除的限制主要有：porn-comic 依赖本机 Chrome 过 Cloudflare、紳士漫畫 / E-Hentai / Hitomi 为 HTML 解析（站点改版会失效）、禁漫部分章节的图片反混淆未实现、自建中继与境内公共中继都是限流资源、`e-hentai` / `pixiv` 依赖自建中继。

---

## v3.2.0

在 3.0 分支上完成、并随分支更名为 `main` 一并发布的首个版本。相对 3.0 的已提交状态（`NS.VERSION = 3.0.0`），本版把 3.0 分支上积累的整套改动正式归档。

### 检索与聚合

- **跨语言扩召回**（`assets/js/xlate.js`）：离线词典 0ms 出候选，在线机器翻译（网关 `/api/translate`，es 优先）与离线结果合并进同一次检索；新增 `X.stems()` 词干变体，修正「机器译文是名词、站点标题不是」的问题。
- **重新提交搜索 = 当场打断上一次**：网络层用 `AbortController` 作用域一次性断开在途请求，逻辑层用检索代次让旧链路在每个 `await` 后就地退出；修掉「旧检索把步骤追加到新检索的思维链上」与「旧 `finally` 清掉新检索的按钮状态」两个具体症状。
- **同系列堆叠重做判据**：封面指纹 / 命名结构（先剥 `[社团] (作者)` 与尾部卷号，再比对主干）/ 同名指纹（含中英文互译，整串相等）/ 同画师 token 相交 / 标题主干相同；明确**不用**「共同标签数」与「标题互相包含」两个会大面积误并的判据。
- **已知角色「角色优先」**：`item._charTier`（真角色 / 系列内容 / 字面子串 / 无关）+ `charFirst()` 稳定分区；汉化优先改为分区内的次级键，不再把翻译过的无关条目顶到真角色前面。

### 信息源与网关

- **新增 `/api/wnacg/search`**：紳士漫畫分批竞速镜像（每批 3 个，先到先得）+ 跟随镜像重定向 + 记住最近成功镜像与失败主机冷却 + 5 分钟结果缓存；前端优先走它，取不到才退回浏览器那套 HTML 竞速。
- **接入 LectorManga**（西语站 `lector-mangas.lat`，检索参数是 `?search=` 而非 `?q=`），网关在线时自动启用。
- **porn-comic 三条通路重排**为「直连 → 本机 Chrome 过 Cloudflare → 境内中继」，加**通路记忆**（10 分钟）、**单次取页总预算 20 秒**、挑战页 4.5 秒判死；空结果只认**站点自述**（标题出现 `no result`）。
- **E-Hentai 区分两种「搜不到」**：出口 IP 限制，与限流空壳（`HTTP 200 + content-length: 0`）。空壳一律判失败并改经中继换出口，识别到空壳后该主机进 60 秒冷却；不够才退到 `/torrents.php?search=` 兜底。
- **出口三层在运行期重判**（原路代理 → DoH 多解析器钉真 IP → 境内中继）：代理中途挂掉自动改走直连，代理回来也会被认出来，两种情况都**不需要重启网关**。

### 界面与阅读

- **新增「最近浏览」**：顶栏时钟入口，按「今天 / 昨天 / 日期」分组，只在真的进入某个作品（放大卡片 / 在线阅读）时记账，仅存本机 `localStorage`（`hs.recent.v1`，上限 200 条 / 60 天）。
- **联想泡泡不再压住思维链**：顺序固定为「搜索框 → 联想泡泡 → 思维链 → 结果」，由 `suggest.js` 按实测几何把思维链顶下去。
- **阅读器**：左右单页模式下缩放改作用在图片盒子上（作用在 `img` 上会被 `overflow:hidden` 裁掉且没有滚动范围）；任意缩放都能按住拖动平移；章节下拉不再用 `scrollIntoView` 把页面顶跑。
- **封面加载**：候选链改为「所有 http(s) 封面：直连 → 网关兜底」，删除主机白名单（白名单失败是安静的，新源 / 换图床就永久单腿）；卡片 / 收藏 / 历史缩略图一律 `loading="eager"`（lazy 在文档非前台时会把 load 事件压住，整片网格停在占位图）。
- **新增 `?coverdiag=1` 封面账本**（`assets/js/dev/coverdiag.js`），把「哪条腿成功」变成可数的数字。

### 跨平台与运行环境

- 三个平台入口行为一致（停旧引擎 → 起新引擎 → 等 `/api/ping` → 自检 `/api/reader` → 开浏览器）：Windows `start-engine.cmd`、macOS `start-engine.command`、Linux `start-engine.sh`。
- 零依赖、零构建不变：`require()` 只用 Node 内置模块（`child_process crypto dns fs http https os path tls zlib`），没有 `package.json`，无需安装任何东西。

### 升级注意

- **升级后必须重启一次网关进程**：出口不再粘死的逻辑只在新进程里生效。三个启动器都会自己停旧起新。
- Node **18+** 可跑；CDP / Cloudflare 通路（porn-comic、被 CF 拦的 danbooru）需要 Node **22+**（依赖全局 `WebSocket`）。
- 页面仍是传统 `<script>` 顺序加载（非 ES Module），`file://` 直接打开也能搜；**在线阅读必须经本地网关**。
- 出口的「原路」一层要真正走本地代理，需要 Node **24+**（`NODE_USE_ENV_PROXY=1` 仅在 undici v24+ 生效）；18–23 上会静默直连，此时由第 ② / ③ 层补偿。

### 文档

- README 元信息更新为 `branch: main` / `version: 3.2.0`，并修正仓库自述。
- 历史上文档里遗留的「3.1」「4.0」字样统一为 **3.2.0**（只改字样，正文结论与代码未改动）。

### 已知限制

见 README 的「已知限制」一节；本版未消除的限制主要有：porn-comic 依赖本机 Chrome 过 Cloudflare、紳士漫畫 / E-Hentai / Hitomi 为 HTML 解析（站点改版会失效）、禁漫部分章节的图片反混淆未实现、境内中继是限流资源。
