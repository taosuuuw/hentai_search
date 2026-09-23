# 自建中继：为什么非它不可、怎么部署、怎么验证（2026-09-23 第 12 轮）

> 一句话：**e-hentai / pixiv 在本机出口上没有任何可用通路（含全部公共中继）**，
> 唯一出路是你自己的一台墙外中继。仓库里已经放好了三种「复制粘贴就能部署」的实现，
> 手工做法是三步：部署 → 设 key → 把地址填进 `tools/relay.txt`（然后重启网关）。
> **但手工也基本不用做了 —— 见下面的第 0 节：启动脚本里的一次性向导。**

---

## 0. 最省事：交给「启动脚本里的一次性向导」（推荐）

从这一版起，双击 `start-engine.cmd` **第一次启动**就会弹一次向导，选一项就完事。
**`[1]` 是推荐项**（菜单里标着 `★推荐★`，直接回车即选它）：

```
  ★[1] 是推荐选项★ 直接回车也能选它：本机全程自动做完，
    你只需要在弹出的浏览器里点一次「登录 / 授权」…
  [1] ★推荐★ 自动部署到 Cloudflare Pages（一键：5 项自检 → 登录 → 建项目 →
      部署 → 生成 key → 写入 Secret → 再部署 → 验证，只有「浏览器点一次登录」需要人工）
  请选择（直接回车 = 推荐项 [1]）：
```

「一步自动化」的边界（2026-09-23 用 `-DryRun` + 空行输入实测，打印
`→ 直接采用推荐项 [1]。` 后列出的完整链路）：
复制 Worker → `wrangler whoami`（**未登录就开浏览器授权 ← 唯一的常规人工点**）→
`pages project create` → `pages deploy` → `--gen-key` + `pages secret put` →
**再部署一次**（Secret 绑定到具体部署）→ 验证 `/__hs/ping` 与带 key 的代理请求 → 写 `relay.txt`。
除此之外只有「首次登录 CF 时的邮箱验证码」可能需要人。

| 选项 | 它替你做什么 |
|---|---|
| `[1]` ★推荐★ 自动部署到 Cloudflare Pages | 先用 node 检查前置条件（npm 源 / Cloudflare 面板 / `pages.dev` 是否可达，本机实测全通），把 `tools/relay-worker.mjs` 复制成 `tools/_relay-deploy/_worker.js`，跑 `npx wrangler@latest pages deploy`（首次会开浏览器让你登录一次），从输出里认出 `https://<项目名>.pages.dev`，自动生成 key 并尝试 `wrangler pages secret put HS_RELAY_KEY`，最后写 `tools/relay.txt` 并**当场验证** |
| `[2]` 我已经有中继地址 | 粘地址（与 key）→ 写 `tools/relay.txt` → 打 `/__hs/ping` 验证 →（可选）跑 `node tools/relay-check.js --live=1` |
| `[3]` 自己的 VPS / 软路由 | 打印要跑的中继命令（`node tools/relay-server.js --port=… --key=…`）、写地址、验证 |
| `[4]` 本机自测中继 | 同上但监听 `127.0.0.1`，脚本里明确警告：**同出口救不了被墙的站**，只用于验证向导与链路 |
| `[5]` 稍后再说 / 不再提醒 | 记状态：下次交互式启动再问 / 永久跳过 |

### 其他路径也能用吗（2026-09-23 逐条实测，不是推断）

| 选项 | 实测结论 |
|---|---|
| `[1]` 自动部署 | **端到端跑通**（见第 5 节的实录）：认得出「项目已存在 ⇒ 复用它」，部署两次（第二次为让 Secret 生效），写 Secret，**带 key 验真 HTTP 200**，保存**生产别名** `https://<项目名>.pages.dev` |
| `[2]` 粘贴已有地址 | 真跑过（配本机中继 `127.0.0.1:8790`）：写 `relay.txt` + `[OK] 中继活着：hs-relay v1.0.0（1520ms）` |
| `[3]` 自己的 VPS | 与 `[4]` **共用同一个函数**（只差提示语与保存的 `method` 标签：`vps` / `local-test`）。`tools/relay-server.js` 本身实测可用（`/__hs/ping` → `{"ok":true,"relay":"hs-relay","version":"1.0.0","keyRequired":true}`）；填**非回环**地址时不会在本机起服务，只做「保存 + 验证」 |
| `[4]` 本机自测 | **端到端跑通**：自动生成 key → 起 `node tools/relay-server.js --port=8790` → 写 `relay.txt` → `[OK] 中继活着：hs-relay v1.0.0（1556ms）`；`method: local-test` |
| `[5]` 稍后 / 不再提醒 | 真跑过：写 `status: skipped`，之后 `-Auto` 启动静默跳过 |

四个「保存」动作**一律先验证、后落盘**（`[2]/[3]/[4]` 一开始就是这样，`[1]` 是本轮统一过来的）：
验证不过就**一个字节都不改动**现有配置，并且把地址与 key 打出来，让你用 `[2]` 十秒粘进来（不用重新部署）。
旧顺序（先写 `relay.txt` 再验证）实测会**一次打错地址就静默冲掉已经跑通的中继** —— 那样以后启动还会自动跳过，
用户连"为什么坏了"都看不到。

**一次性语义**：状态记在 `tools/.relay-setup.json`（字段只有 `version/status/at/method/url/note`，**key 永不落盘**）；
只要 `tools/relay.txt` 里有可用条目，以后每次启动**静默跳过**，不再打扰你。

- 非交互式启动（被脚本 / 计划任务调用、输入被重定向）**绝不弹向导、绝不阻塞**，只记一笔「稍后再说」。
- `start-engine.cmd -RelaySetup` 强制重跑向导；`-ResetRelaySetup` 清掉「已完成」状态并重问；`-NoRelaySetup` 本次跳过。
- 看当前状态与判定理由：`node tools/relay-setup.js --status`（JSON，含 `decision.action/reason`）。
- 引擎就绪后启动器会读 `/api/ping` 打印一行「自建中继：已启用（private…）」或「未配置 ⇒ e-hentai / pixiv 搜不到」，不用猜。
- macOS / Linux 没有这个向导（向导是 PowerShell 脚本），手动等价命令：
  `node tools/relay-setup.js --set-relay=<地址> --key=<key>`，之后照常 `./start-engine.sh`。

下面第 1–3 节是「为什么非自建不可」与「手工怎么做」，想换实现、想完全自己掌控时看它。

---

## 1. 为什么非自建不可（全部为 2026-09-23 本机实测，不是推断）

| 目标 | 实测结果 | 结论 |
|---|---|---|
| 本机系统代理 | 注册表 `HKCU:\...\Internet Settings` 的 `ProxyEnable=0`（`ProxyServer=127.0.0.1:7897` 只是 Clash 卸载后的残留）；`netsh winhttp show proxy` = Direct access | 没有任何代理可用 |
| 本机代理端口 | 19 个常见端口（7890/7897/10809/…) 全部 `ECONNREFUSED` | 同上 |
| `e-hentai.org` | 系统 DNS 直接 **NXDOMAIN**；自带 DoH（dnspod / alidns / cloudflare / quad9…）给出的候选 IP 带**真 SNI** 直连**全部超时**（12s） | 直连死，且「DoH 钉 IP」这条万能解也无效 |
| `www.pixiv.net` | DoH 给出 `104.18.42.239`（Cloudflare **真段**），带真 SNI 直连 **~100ms 就被 `ECONNRESET`** —— 在 TLS 握手中按 SNI 关键字重置 | 同上 |
| 公共中继 | **15 条候选 × 2 目标 = 0 成功**：`cors.eu.org` 全局限流 429（53086B 错误页）、`api.allorigins.win` 不可达、`*.workers.dev` / `r.jina.ai` / `*.vercel.app` **域名本身**被墙 | 「公共中继」这条路在本机出口上物理不存在 |

取证脚本与原始输出（都在仓库里，可复跑）：

- `tools/_relay-matrix.js` → `tools/_relay-matrix.json` / `tools/_relay-matrix-out.txt`（15 条公共中继矩阵）
- `tools/_doh-verify.js` → `tools/_doh-verify.json` / `tools/_doh-verify-out.txt`（DoH 逐 IP 带真 SNI 验真）
- `tools/_reach-map.js` → `tools/_reach-map.json` / `tools/_reach-map-out.txt`（可达性地图）
- `tools/_egress-probe.js`（本机代理端口 / DNS / 直连探测）

> 附带说明：`cors.eu.org` 是**共享出口**，它的 IP 已经被 e-hentai 连坐限流（HTTP 429），
> 即使偶尔能通也会因为「别人也在用」而不稳定 —— 这是公共中继的固有问题，不是它的 bug。

---

## 2. 三步搞定（约 5 分钟）

### 第 1 步：部署中继（三种实现任选一种，功能完全一样）

| 方案 | 文件 | 优点 | 注意 |
|---|---|---|---|
| **A. Cloudflare Pages（最推荐）** | `tools/relay-worker.mjs` | `*.pages.dev` 本机实测**可达**；免费；不用买域名 | 需要把文件内容作为 `_worker.js` 部署（Advanced Mode / wrangler） |
| B. Cloudflare Worker | `tools/relay-worker.mjs` | 部署最简单（在线粘贴） | ⚠ `*.workers.dev` **本机被墙**，必须再绑一个 Custom Domain 才能用 |
| C. Deno Deploy | `tools/relay-deno.ts` | GitHub 登录即可，免费额度够用 | `*.deno.dev` 在不在墙内要**实测** |
| D. VPS / 软路由 / 任意墙外 Node 18+ | `tools/relay-server.js` | 完全自己掌控；零依赖 | 需要一台墙外机器；本机跑**救不了被墙的站**（出口没变） |

方案 A 的具体做法（两种都行）：

```text
① 用 wrangler（推荐，命令行一步到位）
   建一个空目录，把 tools/relay-worker.mjs 复制成该目录下的 _worker.js
   npx wrangler pages deploy .            # 首次会让你登录 Cloudflare 并建项目
   → 得到 https://<项目名>.pages.dev

② 用网页控制台
   dash.cloudflare.com → Workers & Pages → Create → Pages → Upload assets
   → 建出项目后，在 Settings → Functions 里启用 Advanced Mode，粘贴 _worker.js 的内容 → Deploy
```

### 第 2 步：给中继设一个 key（**强烈建议**，不做的话任何人知道地址就能拿你的 IP 刷站）

Cloudflare：项目 → Settings → Variables and Secrets → 新增 **Secret** `HS_RELAY_KEY`，值随便一串随机字符。
Deno Deploy：Settings → Environment Variables → `HS_RELAY_KEY`。
VPS：启动时 `--key=<随机串>`。

### 第 3 步：告诉网关你的中继地址

把 `tools/relay.txt.example` 复制成 `tools/relay.txt`，写一行：

```text
https://<项目名>.pages.dev <你的key>
```

或者不改文件、用环境变量启动网关：`HS_GW_RELAY=https://<项目名>.pages.dev|<你的key>`。

**改完必须重启网关**（网关只在启动时读一次）。

---

## 3. 部署完怎么验证（三条，从快到全）

```powershell
# ① 中继自己在不在、出口 IP 是谁（目标站看到的就是这个 IP）
curl "https://<项目名>.pages.dev/__hs/ping?ip=1"
#   → {"ok":true,"relay":"hs-relay","version":"1.0.0","keyRequired":true,"egressIp":"…"}

# ② 从中继这条链路打真目标（本仓库工具，会自己读 tools/relay.txt）
node tools/relay-check.js --live=1

# ③ 网关侧：私有中继应排在第一条
curl http://127.0.0.1:8788/api/ping
#   → relays[0] = {"id":"private","private":true,…}
```

然后在前端搜 `e-hentai` 与 `pixiv`（R-18 模式需要你在「设置 → 信息源 → Pixiv」里填自己的 `PHPSESSID`）。

---

## 4. 网关侧是怎么接上的（本轮改动，全部带行号，方便以后复查）

`tools/gateway.js`：

| 位置 | 改动 |
|---|---|
| `PRIVATE_RELAY`（`const PRIVATE_RELAY = (function loadPrivateRelays()…`，紧邻 `const RELAYS = [` 之前） | 启动时读 `tools/relay.txt`（每行 `地址[ 空格或\| key]`，`#` 注释）与 `HS_GW_RELAY`（逗号分隔、`地址\|key`）；地址含 `{url}` 则替换，否则自动追加 `?url=<encoded>[&k=<key>]` |
| `RELAYS` 之后 | `PRIVATE_RELAY.slice().reverse().forEach(r => RELAYS.unshift(r))` —— 私有中继**排到公共中继前面** |
| `relayFetch()` | 凭据闸门放宽：带 `cookie/signature/authorization/…` 的请求，只有在**配置了自建中继**时才允许走中继；否则维持原来的「中继转不了（也不该把你的签名交给第三方）」 |
| `relayFetchOnce()` | 新增 `needSecret` + `if (needSecret && !rel.private) continue` —— **带凭据的请求绝不给公共中继**；新增 `reqHeaders`：私有腿带 `x-hs-key`，并按白名单把 `cookie / referer / accept-language / user-agent / x-requested-with / accept` 以 `x-hs-h-<名字>` 转给中继（`PRIVATE_FORWARD_HDR`） |
| `/api/ping` 的 `relays` | 每条带 `private: !!r.private`，一眼看出哪条是你自己的 |
| 启动日志 | 配了：打印私有中继的 id → 地址；没配：**如实说明**「自建中继未配置，e-hentai / pixiv 在当前出口上仍无通路」并指向本文件 |

前端（`assets/js/*`）**不需要改**：它只跟网关说话，通路选择全在网关侧。

中继三种实现共用的协议（谁部署都得满足，`tools/relay-check.js` 会逐条验）：

| 项 | 约定 |
|---|---|
| 取数 | `GET {base}/?url=<encodeURIComponent(目标)>&k=<key>`；也支持路径式 `GET {base}/<目标原样>` |
| 鉴权 | `?k=<key>` 或请求头 `x-hs-key`；设了 key 就必须带，否则 403（`/__hs/ping` 例外，方便你在浏览器里确认部署成功） |
| 转发请求头 | `x-hs-h-cookie` / `x-hs-h-referer` / `x-hs-h-user-agent` …（仅白名单） |
| 响应头 | `x-hs-relay: hs-relay/<版本>`、`x-hs-final: <上游最终 URL>`、`access-control-allow-origin: *` |
| 安全 | 只允许 http(s)；拒绝内网 IP / `localhost` / `*.local` / `169.254.169.254` 等（SSRF）；Node 版还会解析域名再校验一次 |
| 健康检查 | `GET {base}/__hs/ping[?ip=1]`（`ip=1` 会回报中继自己的出口 IP） |

---

## 5. 本轮验收记录（本机集成实测）

临时把 `tools/relay.txt` 指向本机中继 `http://127.0.0.1:8790` 后重启网关：

1. `/api/ping` 的 relays 第一条变成 `private  private=True`，其后仍是 `cors-eu / allorigins / allorigins-get / i0.wp` —— **注册与排序都对**。
2. 网关启动自检里出现 `private HTTP 502（中继自己打不到上游…）`，且排在 `cors-eu …429` 与 `allorigins 连不上` **之前** —— **私有腿确实被优先使用**。
3. pixiv 带 cookie 请求：`中继全失败：private 连不上：timeout；cors-eu 冷却中；allorigins 不支持带 cookie/签名头的请求（只有自建中继可以）` —— **凭据路由判据生效：公共中继被明确跳过**。
4. e-hentai 搜索：`中继全失败：private 冷却中；cors-eu 冷却中；allorigins 连不上：timeout` —— 私有腿仍在第一位。
5. 删掉 `tools/relay.txt` 重启后：relays 回到 4 条公共中继，行为与改前**完全一致**（不配就零影响）。

### 真机部署实录（2026-09-23，Cloudflare Pages，一次跑通）

| 项 | 值 |
|---|---|
| Pages 项目 | `hs-relay-a7f3`（生产别名 **`https://hs-relay-a7f3.pages.dev`**；每次部署另有 `<hash>.hs-relay-a7f3.pages.dev`，别名始终指最新） |
| 上传内容 | `tools/relay-worker.mjs` → 复制为 `tools/_relay-deploy/_worker.js`（9120B） |
| 部署命令 | `npx --yes wrangler@latest pages deploy tools/_relay-deploy --project-name=hs-relay-a7f3 --commit-dirty=true --branch=main` |
| key | 生成 32 位口令 → `wrangler pages secret put HS_RELAY_KEY --project-name=hs-relay-a7f3`（写入 `tools/relay.txt`，key 不进仓库） |
| 健康检查 | `GET https://hs-relay-a7f3.pages.dev/__hs/ping?ip=1` → `{"ok":true,"relay":"hs-relay","version":"1.0.0","keyRequired":true,"egressIp":"2a06:98c0:3600::103"}`（出口是 Cloudflare 边缘） |
| 网关认领 | 重启后 `/api/ping` → `relays[0] = {id:"private", private:true, cooldownSec:0, blockedHosts:N}` |

⚠ **Pages 的 Secret 只对「之后的新部署」生效**（实测踩到）：第一次 `pages deploy` 之后再 `secret put`，
`__hs/ping` 仍然报 `keyRequired:false` —— key 形同虚设。**写完 Secret 必须再部署一次**，向导里已改成自动补部署。

**逐目标可达性真值表**（同一个中继 + key，node 口径实测；命令：`node tools/_relay-targets.js`）：

| 目标 | 结果 | 说明 |
|---|---|---|
| e-hentai.org | **200 / 66512B / 1716ms** | 本机唯一通路，需求 3 的突破口 |
| api.mangadex.org / mangadex.org | **200**（472ms / 232ms） | 可用 |
| porn-comic.com | **200 / 54151B / 618ms** | 可用 |
| hitomi.la | 200 / 26690B | 只是 JS 壳（检索本来就不可用） |
| api.copy-manga.com 等 | 404（根路径） | 说明链路通，业务端点才有效 |
| nhentai.net | **403**（5764B） | 目标按**机房 IP** 挡 |
| danbooru.donmai.us | **403**（5823B） | 同上 |
| jmcomic / wnacg | **403** | 同上（wnacg 只回 17B） |
| lectormanga.com | 530 | CF 源站错误 |
| www.pixiv.net | **403 / 372123B** | Cloudflare WAF 的 block_waf 页 —— **机房出口对 pixiv 无解** |

⇒ 结论：自建中继把 **e-hentai** 彻底打通（网关实测 `naruto` 411ms/25 条、`巨乳` 397ms/25 条），
**pixiv 光靠机房中继不行**（要住宅/家宽出口，且 R-18 还要用户自己的 PHPSESSID）。

### 私有腿带来的连带故障与修法（同一天发现并修掉，共三处）

私有腿排进 `relays[0]` 之后第一次 12 轮压测**反而变差**：nhentai 58.3% → **16.7%**、e-hentai 只剩 **8.3%**，
错误原文是 `中继全失败：private 冷却中；cors-eu 冷却中；…`。
根因：旧逻辑把「上游 4xx」只记一行错误、把 5xx/超时记成**整条中继**的 15–45s 全局冷却，
于是「pixiv / nhentai 被 403、502」会把同一轮里的 e-hentai 一起拖下水。

修法（`tools/gateway.js`，三处，一次比一次深）：

1. **4xx / 私有 5xx 只惩罚那一对**：新增 (中继 × 目标主机) 记忆 —— 4xx（429 除外）= 目标按出口 IP
   拒绝了这条腿 ⇒ 该 (中继, 主机) 10 分钟内不再互相尝试；私有中继的 5xx ⇒ 只对**那个主机**退避 90s。
   `/api/ping` 用 `blockedHosts` 报出每条腿被挡掉的主机数。
2. **私有腿「超时/连不上」也只记 (中继, 主机)**（第二次压测 10:15Z，`tools/stability-report-r12b.md`：
   ehentai 8.3%、nhentai 33.3%）：超时那一支原本还在写全局软冷却 15s，nhentai/pixiv 的一次超时
   就把 private 冻住，而 e-hentai 只有它能走。现在 `if (rel.private)` ⇒ 只对 `tHost` 退避 90s；
   公共中继保持原来的全局 15s（它们的失败多半是自己的问题）。
3. **预置「私有腿打不通的主机」真值表**：光靠「撞了才知道」不够 —— 每轮都拿必败请求去撞
   nhentai/danbooru/wnacg/jmcomic/pixiv/lectormanga，把 Cloudflare 边缘打到回
   `429 {"error":"Rate limit exceeded"}`（31B），private 于是吃 **45s 全局** 冷却。
   `PRIVATE_BLOCKED_HOSTS` 在启动时把这 6 个主机写成 (private, 主机) 退避（TTL 同样 10 分钟，
   所以换了住宅出口重启后会重新尝试）。此后 private 的额度只花在它真能通的站
   （e-hentai / mangadex / porncomic / hitomi）。

离线断言套件（新增，已并入 `tools/check-all.js`）：

```text
node tools/relay-check.js     # 95 条断言（带 --live=1 是 97 条：多两条真目标打真网络）：
                              # 三份实现的协议标记 + 真起进程的端到端
                              #（转发 / 头白名单 / key 鉴权 / 跟随 302 / 404 透传 /
                              #  64KB 正文完整性 / SSRF 五种拒绝 / 网关接入点 /
                              #  (中继 × 主机) 退避：4xx 不冷却整条中继、私有 5xx 与超时
                              #  都只退避该主机、预置真值表、blockedHosts 上报 /
                              #  第 ④ 节「一次性设置」：地址校验、relay.txt 覆盖写、
                              #  状态文件字段（不含 key）、decide() 五分支、BOM 约束、
                              #  Secret 之后必须补部署、keyIgnored 告警、
                              #  先验证后落盘（四处）、8000002 复用、参数括号拼、
                              #  临时文件写 Secret、带 key 的验真、warn 优先、
                              #  向导 CLI 端到端 --set-relay / --status / --reset）
node tools/check-all.js       # 9 套件全绿
                              #（concept 41 / cardtags 33 / scroll 39 / glass 70 / reader 49 /
                              #  recent 28 / dict 28 / gateway 43 / relay 95）
```

### 一次性向导的真机验收（2026-09-23，全部实跑过）

| 场景 | 命令 / 输入 | 结果 |
|---|---|---|
| 非交互式不阻塞 | `'' \| powershell -File tools\relay-setup.ps1 -Auto` | 退出码 0、**没有任何输出**、不等待输入 |
| 选项 1 的自动部署 | DryRun 下输入 `1` 再 `q` | 前置检查 5 项全通：`npm-registry 200 2209ms` / `npm-mirror 200 732ms` / `cf-dashboard 403 585ms` / `cf-api 400 651ms` / `pages-apex 200 2298ms`，随后打印 3 行 `[DryRun] 会执行：…` |
| 选项 5 跳过 | 输入 `5` 再选 `2`（不再提醒） | 状态写成 `{"status":"skipped"}`，之后 `-Auto` 启动静默跳过 |
| 选项 2 真写入 | 先起 `node tools/relay-server.js --port=8790 --key=localtestkey1`，再喂 `2` / `http://127.0.0.1:8790` / `localtestkey1` / `n` | `已写入 tools\relay.txt（249 字节）`、`[OK] 中继活着：hs-relay v1.0.0（1520ms）`（出口 IP 报 `read ECONNRESET`：本机打不到 ipify，不影响中转）、状态 `configured`，下次启动静默 |
| 网关认领 | `powershell -File tools\start-gateway.ps1 -NoBrowser` | 打印 `自建中继：已启用（private，排在全部公共中继之前）`；`/api/ping` 的 `relays[0].private = true` |
| 还原 | `node tools/relay-setup.js --reset --remove-relay` 后重启 | 打印 `自建中继：未配置 ⇒ e-hentai / pixiv 搜不到。配置方法：tools\start-gateway.ps1 -RelaySetup`；relays 回到 4 条公共，行为与不配时完全一致 |

### 选项 `[1]` 端到端实录（2026-09-23 第二次跑，四个修正一次性验证）

输入 `1` + 项目名 `hs-relay-a7f3`（`cmd /c "powershell -File tools\relay-setup.ps1 -Force -AssumeInteractive < in.txt"`，
`in.txt` 两行就是 `1` / `hs-relay-a7f3`），退出码 0：

```text
[OK] cf-api        HTTP 400  658ms          ← 前置检查走 node，不再用 PS 的 Invoke-WebRequest
已登录。  hs-relay-a7f3
创建 / 确认 Pages 项目 hs-relay-a7f3 …
项目 hs-relay-a7f3 已经存在 ⇒ 直接复用它（重跑向导时的正常情况，不是错误）。     ← ⑧ ⑩ 生效
执行：npx --yes wrangler@latest pages deploy …\tools\_relay-deploy --project-name=hs-relay-a7f3 --commit-dirty=true
部署完成：https://6e54e38e.hs-relay-a7f3.pages.dev
为它设一个 key（访问口令）：<32 位随机串，已写进 relay.txt，本文档不留明文>
  已尝试写入 Secret（成功与否看上面输出 / 控制台里有没有 HS_RELAY_KEY）
  再部署一次，让刚写的 Secret 生效（Pages 的 Secret 只影响之后的部署）…
  验证中继是否活着（/__hs/ping）：https://hs-relay-a7f3.pages.dev      ← ⑨ 优先验生产别名
  [OK] 中继活着：hs-relay v1.0.0（787ms）
       中继出口 IP：2a06:98c0:3600::103  ← 目标站看到的就是这个 IP
       key 已验真：带 key 的代理请求 HTTP 200（210ms）                    ← ⑦ 生效
已写入 …\tools\relay.txt：https://hs-relay-a7f3.pages.dev  （key 已设置）
```

重启网关后的**真机验收**（临时脚本，跑完已清理）：

| 项 | 结果 |
|---|---|
| `/api/ping` 的 relays[0] | `{"id":"private","private":true,"cooldownSec":0,"blockedHosts":5}`，其后 4 条公共中继 |
| 网关搜 e-hentai `naruto` | **200 / 769ms / 12 条** |
| 网关搜 e-hentai `巨乳` | **200 / 356ms / 12 条** |
| `node tools/relay-check.js --live=1` | **97 条断言全绿**，其中 `真目标：https://e-hentai.org/ 经私有中继` PASS；pixiv 那条按预期记 `419：机房出口固定 403（Cloudflare WAF）` |
| 网关搜 wnacg | 这一轮 `超过 8500ms 硬闸`（镜像竞速超预算，与本文件无关的老问题，见 `tools/stability-report-r12*.md`） |

> 工程约束（向导踩过并已修，改这个脚本前务必知道）：
> ① **`tools/*.ps1` 必须带 UTF-8 BOM** —— Windows PowerShell 5.1 对无 BOM 文件按 GBK 解码，
> 中文全角字符会吃掉字符串结束引号、整个脚本 ParserError（`Unexpected token 'Red'`）；
> `edit`/`write` 工具会剥掉 BOM，改完要重补，`start-gateway.ps1` 里也有自动补 BOM 的自愈逻辑。
> ② **参数名绝不能叫 `$Args`**（PowerShell 自动变量，`@Args` 会 splat 成空数组）。
> ③ **数组 splat 会被当成位置参数**（`& $s @('-Auto','-Port','8788')` 报
> `Cannot convert value "-Auto" to type "System.Int32"`）——必须用哈希表 splat。
> ④ 逗号比 `+` 结合更紧：`@('a' + $x, 'b' + $y)` 会被拍成一个字符串，每段要各自加括号。
> ⑤ 所有网络可达性判断**一律走 node**（本机 PS 5.1 的 `Invoke-WebRequest` 连不上任何外网 HTTPS）。
> ⑥ **写 Secret 绝不能用 `$key | & npx … pages secret put`**（第 15 处修正）：实测存进去的**不是 `$key`** ——
> `secret put` 照样报 `Success! Uploaded secret HS_RELAY_KEY`、`/__hs/ping` 也报 `keyRequired:true`，
> 但用这个 key 打中继**一律 403**（key 的 10 种变形 `+\r/+\n/+\r\n/×2/×5/前后空格/双引号/前置 CRLF` 也全 403）。
> 确定性的写法：把 key 写进**无换行**的临时文件，再用 `cmd /c "… pages secret put HS_RELAY_KEY --project-name=<项目> < 文件"`，
> 写完立刻删（实测同一份 key 这样写进去，带 key 的代理请求立刻 200/`pong`）。worker 侧不做 `trim`
> （`tools/relay-worker.mjs:106` 的 `const cfgKey = String((env && (env.HS_RELAY_KEY || env.RELAY_KEY)) || '');`）。
> ⑦ **`/__hs/ping` 按设计不需要 key**，所以「只 ping」的验证**永远证明不了 key 对不对**：
> `--verify` 现在会在中继报 `keyRequired:true` 且调用方给了 key 时，**再带 key 打一次代理请求**
> （靶子 `KEY_PROBE_URL = 'https://api.mangadex.org/ping'`），key 不对就把 `ok` 置 false 并给出中文 warn ——
> 于是「先验证、后落盘」这道闸门真能拦住「把一份用不了的 key 写进 relay.txt」。
> ⑧ **`$ErrorActionPreference = 'Stop'` 会吃掉 stderr 捕获**：`& npx … 2>&1 | Out-String` 一碰到 stderr 就跳 `catch`，
> `$pc` 只剩第一行，读不到 `already exists` / `8000002`（隔离复现：去掉 try/catch 后 `LEN=892 MATCH=True`）。
> 做法：临时切回 `Continue` 再 `2>&1`。（`*>` 落文件这条也试过：只拿到 48B 的 wrangler banner，不可靠。）
> ⑨ **wrangler 的输出里只有本次部署的哈希 URL**（`https://<hash>.<项目>.pages.dev`），
> **生产别名 `<项目>.pages.dev` 一个字都没有** ⇒ 想存别名只能自己拼；别名永远指向最新生产部署，也更好记。
> ⑩ 「项目已存在」（CF 错误码 `8000002`）是**重跑向导时的正常情况**：翻译成「直接复用它」继续往下走，不是失败。

---

## 6. 如实说明的边界（没做到的、做不到的）

- **本机无法验证真正的跨越效果**：本机中继与本机同出口，物理上救不了被墙的目标。
  决定性验证必须在**你部署之后**做：`node tools/relay-check.js --live=1`。
- **pixiv R-18 仍然需要你自己的 `PHPSESSID`**（这是 pixiv 的硬要求，任何中继都替代不了）。
  本轮的变化是：那张 cookie **现在真的能经自建中继发到 pixiv 了** —— 之前公共中继会被整条跳过，
  所以 R-18 永远只能拿到全年龄结果（pixiv 会静默回落）。
- **e-hentai 可能按出口 IP 封中继**：Cloudflare 的出口 IP 池比 `cors.eu.org` 那种共享出口大得多，
  通常更稳；真被封时换一个部署区域/再部署一个即可（配置支持多条私有中继，会按书写顺序竞速）。
- **`tools/relay.txt` 只在网关启动时读一次**，改完要重启网关。
- **安全**：中继会把你的出口 IP 暴露给目标站，所以务必设 `HS_RELAY_KEY`、不要公开地址；
  `tools/relay.txt` 已加进 `.gitignore`（带 key 等同凭据）。
