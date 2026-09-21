# 三站点检索接口调研报告

> 调研时间：2026-09-19 · 全部结论基于**真实请求实测**，未实测的一律标注「未能确认」。

## 0. 本次测试环境的硬限制（影响验证手段，必须先说明）

| 通道 | 状态 | 说明 |
|---|---|---|
| pwsh `Invoke-RestMethod` / `curl.exe` → HTTP(80) | ✅ 可用 | `http://example.com` 返回 200 |
| pwsh → HTTPS(443) | ❌ **全部超时** | 连 `https://example.com` 都超时，无法用 curl 验证任何 HTTPS 端点 |
| 本机 DNS | 部分被屏蔽 | `kemono.su` = NXDOMAIN；`kemono.party` → `0.0.0.0`；`lectormanga.com`/`visortmo.com`/`zonatmo.com` 无法解析 |
| 用户 Chromium（真实浏览器） | ✅ 正常出网 | **本报告的 CORS 结论与 DOM 结构全部由它实测** |
| harness `web_fetch` | ✅ 可 HTTPS | 但**不返回响应头**，故无法用它判断 CORS |

**关键方法论**：CORS 无法用 `web_fetch` 判断（拿不到头）。做法是——本地起 Node 静态服务器（`origin = http://127.0.0.1:8791`），在页面里用 `fetch(url, {mode:'cors'})` 打真实站点，再从浏览器 console 读拦截原因。这是最终判定依据。

---

## 1. Kemono（kemono.su 系列）

### 1.1 可直接复制的端点

```
GET https://kemono.cr/api/v1/posts?q=<关键词>&o=<偏移量>
```

真实可复制示例（**实测 HTTP 200，返回 JSON**）：

```
https://kemono.cr/api/v1/posts?q=naruto&o=0
https://kemono.cr/api/v1/posts?q=test&o=0
```

- `q` = 关键词（必填，支持日文/中文）
- `o` = offset 偏移量（分页）；**每页固定 50 条**，实测追加 `&limit=3` 被服务端忽略
- 无 `q` 时 `/api/v1/posts` 返回全站最新

### 1.2 返回体：JSON

顶层结构（实测原文）：

```json
{
  "count": 50000,
  "true_count": 80014,
  "posts": [ { ... }, { ... } ]
}
```

**结果数组路径：`posts`**

⚠️ 注意：`count` 是**硬上限 50000**（恒为 50000），真实命中总数在 `true_count`。做分页时不要用 `count`。

### 1.3 字段映射（逐条实测）

| 需求 | 字段名 | 说明 |
|---|---|---|
| id | `posts[].id` | 字符串，如 `"146540447"` |
| 标题 | `posts[].title` | 完整标题 |
| 作者 | `posts[].user` | **只有 creator ID，没有作者名** |
| 平台 | `posts[].service` | `patreon` / `fanbox` / `pixiv` … |
| 封面图 | `posts[].file.path` | **相对路径**，如 `/20/b1/20b1e6….jpg` |
| 附件 | `posts[].attachments[].path` | 同款相对路径；`name` 是文件名 |
| 发布时间 | `posts[].published` | `"2025-12-23T21:54:41"` |
| 匹配片段 | `posts[].substring` | 搜索高亮片段（常为空串） |
| 标签 tags | — | **列表端点不返回 tags；未能确认** |

**派生 URL（需自行拼接）**

- 详情页：`https://kemono.cr/{service}/user/{user}/post/{id}`
- 封面图：`https://kemono.cr/data{file.path}`
  - ⚠️ 实测该图片 URL 会 **302 跨域重定向到 `https://n2.kemono.cr`**（图片实际由 n2 子域托管）。直接请求 `https://n2.kemono.cr/data{path}` 在测试中返回 `fetch failed`（疑似防盗链），**未能确认**是否需带 `Referer`。
- `file` 可能是空对象 `{}`（无封面），需判空。

### 1.4 请求头

**不需要任何自定义头**。实测无自定义 UA 直接 200。

但注意：站点前置 **DDoS-Guard**（响应头 `Server: ddos-guard`，会下发 `__ddg1_`~`__ddg10_` cookie）。测试中第三方服务（hackertarget）抓取时被挑战页拦住，而直连正常 —— 说明存在**按客户端指纹触发挑战**的行为，网关端建议带常规浏览器 UA。

### 1.5 CORS 结论：❌ 不返回 ACAO，必须走网关

浏览器实测原始报错（决定性证据）：

```
Access to fetch at 'https://kemono.cr/api/v1/posts?q=test&o=0' from origin
'http://127.0.0.1:8791' has been blocked by CORS policy:
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

`/api/v1/posts`、`/api/v1/creators.txt`、`/api/v1/account/favorites` 三个端点**全部**同样被拦。

→ **纯浏览器 `fetch` 直连取不到数据，必须由本地 Node 网关代取后再转发。**

### 1.6 镜像 / 域名（实测）

| 域名 | 实测结果 |
|---|---|
| `kemono.cr` | ✅ **可用，API 正常**（本报告所有数据来源） |
| `kemono.su` | ❌ DNS NXDOMAIN（本机被屏蔽） |
| `kemono.party` | ❌ DNS 解析为 `0.0.0.0`（被屏蔽） |
| `kemono.onl`、`kemono.wtf`、`kemono.today`、`kemono.it.com`、`kemono.sbs`、`kemono.cv` | ❌ **不是镜像**，是 SEO 内容农场（返回"kemono 是什么意思"的介绍长文） |

**建议**：网关里做 `kemono.cr` → `kemono.su` → `kemono.party` 的域名轮换，并对失败做降级。

---

## 2. LectorManga（TMO 系 / 现役 lector-mangas.lat）

> 【4.0 更正】本节原来的结论是「源已不可用，建议下线」。**上游事实仍然成立**
> （`visortmo.com` / `zonatmo.com` 确实随 2026-04 西警方查封下线，DNS 都不解析了），
> 但结论过期了：西语圈这一支换了域名继续运营，现役可用端点是 **`lector-mangas.lat`**。
> 4.0 已按新端点接入为信息源（见 2.7），下面 2.1–2.6 保留原始调研记录以备追溯。

### 2.1 结论先行（原记录）：TMO 原站已被警方查封

- 西班牙《EL PAÍS》2026-04-22：[《Cae Tumangaonline: la Policía Nacional desmantela la mayor plataforma de piratería de manga en español》](https://elpais.com/cultura/2026-04-22/cae-tumangaonline-la-policia-nacional-desmantela-la-mayor-plataforma-de-pirateria-de-manga-en-espanol.html) —— 西警方捣毁 TMO。
- Reddit r/AnimeEspanol 2026-03：[zonatmo.com 已倒](https://www.reddit.com/r/AnimeEspanol/comments/1s3r63j/zonatmocom_se_convirti%C3%B3_a_zonatmoto/)、[TMO 复活了吗](https://www.reddit.com/r/AnimeEspanol/comments/1s314ah/revivio_tmo/)。
- **本机实测**：`lectormanga.com` 与 `visortmo.com` 均为 `ERR_CONNECTION_CLOSED`（浏览器也连不上）。

### 2.2 身份确认：LectorManga == TuMangaOnline (TMO)

[hakuneko 的 `LectorManga.mjs`](https://github.com/manga-download/hakuneko/blob/master/src/web/mjs/connectors/LectorManga.mjs) 完整继承 `TuMangaOnline`，仅覆盖 `this.url = 'https://lectormanga.com'`；而 `TuMangaOnline.mjs` 的 base 是 `https://visortmo.com`。两者是同一套代码、同一后端，**域名每年轮换**。

### 2.3 历史端点格式（有源码依据，但**未能在现役域名上验证**）

来源：[NOBORU-parsers `[ES]TumangaOnline.lua`](https://github.com/Creckeryop/NOBORU-parsers/blob/master/parsers/%5BES%5DTumangaOnline.lua)

```
{base}/filterList?alpha=<关键词>&sortBy=views&asc=false&page=<页码>      # 搜索
{base}/filterList?sortBy=views&asc=false&page=<页码>                      # 热门
{base}/filterList?alpha=<字母>&sortBy=name&asc=true&page=<页码>           # 按字母
{base}/filterList?alpha=&cat=<tagId>&sortBy=name&asc=true&page=<页码>     # 按标签
{base}/latest-release?page=<页码>                                         # 最新
{base}/library?title=<关键词>&page=<页码>                                 # 搜索页（HTML）
```

- 返回体：**HTML**
- 列表 CSS 选择器（源码正则 `<a href="([^"]*)" class="thumbnail">…src='([^']*)' alt='([^']*)'>`）→ **`a.thumbnail`**，从 `href` / `img[src]` / `alt` 取详情链接 / 封面 / 标题
- 标签 ID 表（`Acción=1, Aventura=2, Comedia=3, Drama=5, Ecchi=6 … Boys love=43`）源码内有完整映射

### 2.4 请求头（旧版 API 实测所需，仅供参考）

[旧 tumangaonline API 客户端](https://github.com/riojano0/manga-scrapper/blob/master/tu-manga-online-scrapper.py) 使用：

```
GET https://www.tumangaonline.com/api/v1/imagenes?idManga={}&idScanlation={}&numeroCapitulo={}
Accept: application/json, text/plain, */*
Referer: https://www.tumangaonline.com/
X-Requested-With: XMLHttpRequest
Cache-mode: no-cache
```

即 **TMO 系必须带 `Referer` + `X-Requested-With`**（防盗链）。该域已废弃，现役域名未确认。

### 2.5 CORS 结论：❌ 不返回 ACAO

第三方下载脚本作者明确说明：*"Requires 'Allow CORS' extension with 'Access-Control-Allow-Origin' mode set to `*` in options page for script to work"* —— 见 [gist](https://gist.github.com/hiroshil/6c4360a56dd37a788646c468fe2ef7fc)。即**源站不返回 ACAO**，必须靠扩展/代理改写。

### 2.6 镜像 / 继任域名（实测）

| 域名 | 实测结果 |
|---|---|
| `lectormanga.com` | ❌ `ERR_CONNECTION_CLOSED` |
| `visortmo.com` | ❌ `ERR_CONNECTION_CLOSED` |
| `zonatmo.com` | ❌ DNS 失败 / HTTP 错误码 |
| `zonatmo.org` | ⚠️ `/library?title=` → **404**（架构与 TMO 不同）；浏览器访问被 McAfee WebAdvisor 拦截 |
| `zonatmo.net` | ⚠️ HTTP 200 但为 JS SPA；浏览器访问被 McAfee WebAdvisor 拦截，**未能确认**其 API |
| `visortmo.ws` | 🚨 **仿冒站**：内容为模板假数据（"El Monarca de las Sombras"、"Academia de Magia" 等），**不要接入** |

**原判定：TMO 系旧域名（lectormanga.com / visortmo.com / zonatmo.com）全部不可用。**
（4.0 更正：同名的现役站换了域名，见 2.7。）

---

### 2.7 【4.0 新增】现役端点实测：`lector-mangas.lat`

| 项 | 实测结果 |
|---|---|
| `lector-mangas.lat` | ✅ **HTTP 200**，Cloudflare 前置但有完整服务端渲染（列表 / 详情 / 标签 / 排行） |
| `lectormangass.com` | 301 → `https://lector-mangas.lat/` |
| `lectormangaa.com` | 301 → `lectormangass.com` → `lector-mangas.lat` |
| `lectormangas.com` | 🚨 **域名停放页**（parklogic 广告路由，`router.parklogic.com`），**不是漫画站** |
| `lectormanga.com` | ❌ DNS 无解析 |
| `lectormanga.net` | ❌ 301 → `choto.click/vx/...`（停放/跳转） |
| `zonatmo.net` | ⚠️ HTTP 200 但是另一套 SPA，与 TMO 无关，未采用 |
| `visortmo.net` | ❌ DNS 无解析 |

**检索端点（实测推导，务必照抄）**

```
GET https://lector-mangas.lat/comics?search=<关键词>&page=<页码>       ✅ 真的过滤
GET https://lector-mangas.lat/comics?q=<关键词>                        ❌ 被忽略，返回全库第一页
```

- 🚨 **站点自己的 JSON-LD 里写的是 `SearchAction: /comics?q={search_term_string}`，那是错的。**
  实测 `?q=naruto` 与不带参数**返回完全相同的 24 张卡片**；`?search=fate` 则 24 条全是 Fate 系。
  接源时只认 `search=`。
- 无关键词时 `GET /comics` 也能用（返回最新列表）。
- 空结果：`?search=<不存在的词>` 返回一张正常渲染、只是没有卡片的列表页（无「no result」标题，
  所以**不能**把「真页面 + 0 条」当成解析失败）。

**列表解析（已实测的 DOM 结构）**

```html
<div id="directory-results"><div class="row manga-grid">
  <div class="col-md-6 col-lg-6 col-xl-4 col-12">      <!-- 每张卡片 -->
    … "8 Capítulos" …                                   <!-- 章节数（不是页数） -->
    <a href="/comics/<slug>" class="card-cover-link" title="标题">
      <img src="https://api.zerocomics.net/storage/series/portadas/<id>.webp" …>
```

- **必须只在 `#directory-results` 这一段里抓**：页面顶部还有整块「Clasificación」排行，
  用的也是 `/comics/<slug>` 链接；不切范围会把排行当成检索结果。
- 封面图在 `api.zerocomics.net`（独立 CDN，不带 CF 挑战）。
- 详情页 `/comics/<slug>`；分类入口 `/comics/genre/<slug>`、`/comics/status/<slug>`。

**请求头与 CORS**

- 常规浏览器请求头即可（实测无 cookie、无 Referer 要求、无 CF 挑战）。
- ❌ **不返回 `Access-Control-Allow-Origin`**（带 `Origin` 实测）⇒ 浏览器 `fetch` 直连必被拦，
  只能经本地网关或公共代理，与 kemono / porn-comic 同一类。

**落地**：网关 `/api/lectormanga/search`（三个域名轮换）→ 前端 `lectormanga` 适配器；
网关在线时自动启用。

---

## 3. porn-comic（候选域名逐个实测）

### 3.1 候选域名裁决

| 域名 | 实测结果 | 可用性 |
|---|---|---|
| **`porn-comic.com`** | ✅ 存活，完整列表/详情/标签页，月访约 510 万 | **✅ 最适合被检索** |
| `porncomics.com` | ❌ DNS 解析到 `127.0.0.1`（本地被劫持/屏蔽） | 不可用 |
| `porncomix.com` | ❌ 域名停放，301 跳转 `litcares.com` 广告 | 不可用 |
| `porncomic.com` | ❌ 停放页（`window.location.href="/lander"`） | 不可用 |

### 3.2 可直接复制的端点（HTML 站，非 JSON）

```
https://porn-comic.com/                       # 首页/最新
https://porn-comic.com/index-2.html           # 第 n 页（n>=2）
https://porn-comic.com/h/                     # 漫画列表（More）
https://porn-comic.com/hentai                 # 图集
https://porn-comic.com/gif                    # 动画
https://porn-comic.com/western                # 西部漫画
https://porn-comic.com/cos                    # Cosplay
https://porn-comic.com/hot/                   # 排行
https://porn-comic.com/tags/<tag>.html        # 标签，如 /tags/full-color.html、/tags/ntr.html
https://porn-comic.com/language/<lang>.html   # 语言，如 /language/chinese.html
https://porn-comic.com/circle/<name>.html     # 社团，如 /circle/ai-generated.html
https://porn-comic.com/h/<id>.html            # 漫画详情
https://porn-comic.com/hentai/<id>.html       # 图集详情
https://porn-comic.com/gif/<id>.html          # 动画详情
```

**搜索端点**（实测推导）：

```
https://porn-comic.com/q/<关键词>-<页码>.html
```

→ 服务端 **302** 到 `https://search.porn-comic.com/q/<关键词>-<页码>-<hash>.html`

- 实测：提交 `zzqqxx` 后落地
  `https://search.porn-comic.com/q/zzqqxx-1-6f35ff94f19f3933a4e310990dedb5ca.html`
- `<hash>` 是**服务端按查询词确定性生成**的（同一关键词两次得到同一 hash），所以客户端只需请求 `porn-comic.com/q/{q}-{page}.html` 即可，无需自行计算。
- 🚨 **`search.porn-comic.com` 有 Cloudflare 挑战**：实测停在「正在进行安全验证 / Just a moment...」，自动化环境无法通过 → **搜索功能对程序化访问基本不可用**。

**已排除的错误猜测（实测）**

| 试探 | 结果 |
|---|---|
| `https://porn-comic.com/search/?q=naruto` | **404** |
| `https://porn-comic.com/search/` | 非搜索端点 |
| `https://porn-comic.com/anime/<slug>.html` | 作品专题页：已存在的（`/anime/naruto.html`）可访问；**不存在的返回 404**，不是通用搜索 |
| `https://porn-comic.com/api/cover18.html?ajax=1` | 返回 **18+ 年龄确认 HTML**，不是 JSON API |

### 3.3 返回体：**HTML**（站点是自制 PHP，无公开 JSON API）

**现役可用的 CSS 选择器**（从真实 DOM 摘录，原样可抄）：

```html
<a href="/h/872078.html"
   title="[idoraa] Flynn Rider's Break Time | 弗林雷德的休息时间 [Chinese] [李士奇汉化]"
   class="thumb">
  <img width="222" height="282"
       alt="[idoraa] Flynn Rider's Break Time | ...[Chinese] [李士奇汉化]"
       src="https://file3.acgnngca.com/re/nh2/2026091617/thumb_500_425_4185264_1.webp">
</a>
```

| 需求 | 选择器 | 取值 |
|---|---|---|
| 详情页 URL | `a.thumb` | `href` （如 `/h/872078.html`） |
| 标题 | `a.thumb` | `title`（或内层 `img[alt]`） |
| 封面图 | `a.thumb img` | `src`（**绝对 URL**，独立 CDN 域） |
| 日期 / 语言 / 分类 | 同一 `li` 内的文本节点 | 如 `09-19`、`中文`、`Manga` |

```js
// 推荐抓法：先全量取 a.thumb，再用 href 正则过滤掉推荐位
const items = [...document.querySelectorAll('a.thumb')]
  .filter(a => /^\/(h|hentai|gif)\/\d+\.html$/.test(a.getAttribute('href')))
  .map(a => ({
    url:   'https://porn-comic.com' + a.getAttribute('href'),
    title: a.getAttribute('title') || a.querySelector('img')?.alt,
    cover: a.querySelector('img')?.src
  }));
```

- 列表条目外层包裹容器的 class **未能确认**（observer 只暴露为 `list`，且工具不支持按 CSS 选择器取 HTML 片段）—— 故上表用 `a.thumb` 这一**已验证存在**的锚点，不编造 `ul.xxx`。
- 图片 CDN 域名（实测出现）：`file.acgnngca.com`、`file2.acgnngca.com`、`file3.acgnngca.com`、`m.acgnfl.com`、`gif.acgnngca.com`

### 3.4 请求头

浏览器常规访问即可（实测首页、`/h/`、详情、搜索均正常）。有 **18+ 年龄门**：首次访问会出现 "I am already 18 years old or older"，点击后写 cookie 放行 —— **网关需保存该 cookie**，否则只能拿到年龄确认页。

### 3.5 CORS 结论：❌ 不返回 ACAO

浏览器实测原始报错：

```
Access to fetch at 'https://porn-comic.com/' from origin 'http://127.0.0.1:8791'
has been blocked by CORS policy:
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

`/`、`/anime/naruto.html`、`/api/cover18.html?ajax=1` 全部同样被拦。

→ **必须走本地网关中转。** 且搜索还得额外过 Cloudflare 挑战。

### 3.6 镜像 / 域名

- 该站与中文站 `acgxmh.com` 关联（页面底部互相链接），图片走 `acgnngca.com` / `acgnfl.com` CDN 集群。
- 未见可靠镜像域名；`www.porn-comic.com` 与裸域等价（hreflang 互指）。**未能确认**存在可用镜像。

---

## 4. 总结：哪些能纯浏览器直连，哪些必须走本地网关

| 源 | 返回体 | CORS `Access-Control-Allow-Origin` | 纯浏览器 `fetch` 直连 | 结论 |
|---|---|---|---|---|
| **Kemono**（`kemono.cr`） | JSON | ❌ **无**（实测拦截） | ❌ 不可用 | **必须走本地网关** |
| **LectorManga**（现役 `lector-mangas.lat`） | HTML | ❌ 无（实测） | ❌ 不可用 | **必须走本地网关**；无 CF 挑战、无 cookie，网关一次请求即回（4.0 已接入） |
| **porn-comic**（`porn-comic.com`） | HTML | ❌ **无**（实测拦截） | ❌ 不可用 | **必须走本地网关**；搜索另有 Cloudflare 挑战 |

**三个源没有一个能纯浏览器直连** —— 全部缺失 `Access-Control-Allow-Origin`。纯前端聚合器若想直接 `fetch`，只能：

1. **本地 Node 网关（推荐）**：网关代取 → 加 `Access-Control-Allow-Origin: *` 回吐给前端。这也是唯一能顺手解决以下问题的方案：
   - Kemono 的 DDoS-Guard cookie
   - porn-comic 的 18+ 年龄 cookie
   - 统一 UA / `Referer`
2. 公共 CORS 代理：测试中 `allorigins.win`、`codetabs.com` 大量返回 **520/522**，不稳定，不建议作为生产依赖。

**各源可用性再评级**

- **Kemono** — 唯一「端点完整、JSON 规整、当场验证成功」的源。`/api/v1/posts?q=&o=` 可直接照抄。注意 `count` 恒为 50000（用 `true_count`）、列表无 tags/无作者名、封面需拼 `/data` + 相对路径且会重定向到 `n2.kemono.cr`。
- **porn-comic** — 站点活着，但**只有 HTML**，且 `/q/` 会 302 到 `search.porn-comic.com`（CF 挑战）。
  网关用「直连 → 本机 Chrome 过验证 → 境内中继」三条通路取页（4.0 起顺序如此，见 3.7），
  拿到页面后用 `a.thumb` 解析。**关键词搜索是可用的**（前提是本机 Chrome 起得来），
  只是无结果的关键词会先撞一次挑战再落到 `/tags/` 的「no result」页。
- **LectorManga** — 4.0 起**已接入**。旧结论（TMO 系被查封、建议下线）对旧域名成立，但现役站换了域名：
  `lector-mangas.lat` 实测 200、服务端渲染、无 CF 挑战，检索参数是 **`?search=`**（站点 JSON-LD 写的 `?q=` 无效）。
  不返回 CORS 头 ⇒ 走本地网关。详见第 2.7 节。

---

## 3.7 【4.0 新增】porn-comic「经常超时无返回」的归因与通路顺序修正

**症状**：porn-comic 经常整源超时、界面报「超过 22s 未返回」，用户看不到任何结果。

**逐层实测（2026-09-21，本机出口，`tools/gateway.js` 打点日志）**

| 通路 | 实测 | 耗时 |
|---|---|---|
| 直连 | HTTP 403（CF 挡），一次就够 | **< 1s** |
| 境内中继（allorigins / allorigins-get） | 两个中继**都超时**；而中继内部是「每个中继各给一份 timeout」⇒ 总开销 = timeout × 中继条数 | **16–20s（纯浪费）** |
| 本机 Chrome 过验证 | 能出真页面；`/q/fate-1.html` → 25 个 `a.thumb`、`/q/naruto-1.html` → 25 个 | **6–9s** |

旧顺序是「直连 → 中继 → Chrome」，于是**一次成功检索** = 0.5s + 20s + 6s ≈ **26.5s**，
而前端聚合器的硬上限是 22 秒（`assets/js/sources.js` 的 `RUN_CAP_MS`）——
结果被砍掉，表现就是「经常超时无返回」。**毛病不在 Chrome 慢，在于每次都先把 20 秒喂给了中继。**

**修正（4.0）**

1. 通路顺序改为 **直连 → 本机 Chrome → 境内中继**（中继退到最后当兜底）；
2. 中继超时 20s → 6s，且**人均一份剩余预算**（`floor((left-1000)/中继数)`），不再吃满全线；
   中继失败冷却 60s → 3 分钟（整条链在超时，不是偶发 522）；
3. **通路记忆**：记住上次走通的那条，10 分钟内先走它（Chrome 通了一次，后续直接 6–7 秒）；
4. **总预算**：单次取页 ≤20s，挑战页 4.5s 判死（不再空转到 timeout），
   `cfRender` 也吃剩余预算（旧版它自带 40s，实测跑出过「预算 19s、实际 45s」的破口）；
5. **无结果只认站点自述**：`/tags/<词>.html` 渲染后的 `<title>` 就是 `"<词> no result"`，
   认到它才回「0 条」；「真页面 + 0 个 a.thumb」不算（可能是骨架页或改版），继续试下一个入口；
6. **渐进渲染**：列表页的网格是异步补上的，1s 时 `innerHTML=13509B` 却 **0 个作品链接**，
   而页面标题已经是 "naruto comics Page 1"。所以新增「就绪判据 + 稳定判据」：
   条目数/正文规模连续 1.2 秒不变才抓（只判「有没有列表」会抓到只含 1 条的真页面）。

**改后实测**

| 场景 | 改前 | 改后 |
|---|---|---|
| `fate` 冷启动 | 26.5s（常被 22s 上限砍掉） | **6–7s，24 条** |
| `fate` 二次（同 URL） | 26.5s | **2ms（CF 缓存）** |
| `中文` 关键词 | 5.7s | 7–8s，24 条 |
| 无结果 `zzqqxxqqzz` | **60.5s → HTTP 502** | **18s → HTTP 200 + `empty: true`（站点自述 no result）** |
| 无结果之后紧接一次检索 | 被残留冷却堵死 | 6.5s，24 条（冷却绕行） |

**仍未解决（已知）**：`/tags/<词>.html` 这类标签页在 headless Chrome 里渲染出**零个作品锚点**
（标题正常，如 `"hiten comics Page 1"`），所以像 `hiten` 这种「`/q/` 也 302 到标签页」的词，
本站就是取不到结果 —— 这是站点行为，不是解析器的问题。真页面 + 0 条 + 无 no result 时
上层如实报「结构里没有作品链接」，**不谎报 0 条**。

---

## 5. 无 VPN 环境的可达性分层实测（2026-09-21，本次修复的全部依据）

> 调研工具：`node tools/netprobe.js`（分层体检）、`node tools/netprobe.js --relay`（中继池实测）、
> `node tools/netprobe.js --url <地址>`（单地址直取）、`node tools/proxy-selftest.js`（出口自愈回归）。
> 环境：本机**没有**运行任何 VPN / 本地代理（`7897` 等端口全部关闭、系统代理关闭），
> 因此这一节量到的就是「无 VPN」的真实链路。

### 5.1 「打不开」有四种死法，修法完全不同

`netprobe` 把每一站拆成四层量：**系统 DNS → DoH 候选 → TCP 握手 → 带 SNI 的 TLS+HTTP**。

| 站点 | 系统 DNS | 真 IP（DoH 来源） | 判定 | 可修 |
|---|---|---|---|---|
| `api.copy2000.online`（拷贝漫画 API） | ✅ 真 IP | 171.244.199.189（dnspod） | 直连可用 | 本来就通 |
| `www.cdnbea.net` / `www.cdnhjk.net`（禁漫 APP 接口） | ✅ 真 IP | 172.67.168.110 | 直连可用 | 本来就通 |
| `cdn-msp*.jmapiproxy*.cc`（禁漫图床） | ✅ 真 IP | Cloudflare | 直连可用 | 本来就通 |
| `sf.mangafunb.fun`（拷贝漫画图床） | ✅ 真 IP | Cloudflare | 直连可用 | 本来就通 |
| `www.wnacg.com`（紳士漫畫） | ❌ 污染 | 104.20.44.182 / 172.66.175.138（dnspod/墙外） | **DNS 污染** | ✅ DoH |
| `hitomi.la` | ❌ 污染 | 185.165.169.231（dnspod） | **DNS 污染** | ✅ DoH |
| `www.wn03.ru`（紳士镜像） | ✅ 真 IP | Cloudflare | 直连可用 | 本来就通 |
| `nhentai.net` | ❌ 无解析 | 172.67.74.203（dnspod / 墙外 Google） | 混合 | ✅ DoH 或中继 |
| `e-hentai.org` | ❌ 污染 | 172.66.132.196（墙外 Google） | **SNI 阻断** | ✅ 中继 |
| `danbooru.donmai.us` | ❌ 污染 | 104.26.10.39（墙外 Google） | **SNI 阻断** | ✅ 中继 |
| `kemono.cr` | ✅ 真 IP | 190.115.31.240 | **SNI 阻断**（TCP 通、TLS 被重置） | ✅ 中继 |
| `www.wnacg01.cc` / `wnacg02.cc` | ✅ 真 IP | — | **SNI 阻断** | 只能中继（且中继回的是垃圾） |
| `i.pximg.net` / `porn-comic.com` | ❌ | — | 整段不可达 | ✅ 中继（图片另需 Referer，仍可能失败） |

**结论 1（最重要）**：禁漫 / 拷贝漫画的**接口与图床本来就直连可用** —— 无 VPN 下它们之所以全废，
根因是网关的**出口在进程启动时被粘死**（见 5.3），不是站点被墙。

**结论 2**：`hitomi.la` 同一个域名，**阿里 DNS 给 202.160.128.14（假的）、腾讯 DoH 给 185.165.169.231（真的，✓200）**，
而且同一个解析器前后两次的答案也会变（`hitomi.la` 第二次两边都给污染值）。
⇒ DoH 必须**多解析器并取候选**，且候选**必须用「带 SNI 能否握手」验真**，不能信任何单一解析器。

**结论 3**：验真必须用**证书校验打开**的口径。反例：墙外 DNS 把 `api.copy-manga.com` 解析到
`api.copy2000.online` 的 IP 上，宽松验真会「成功」并钉住这个 IP，之后每一次真实请求都必然 TLS 失败。

### 5.2 中继池实测（`--relay`，全部为境内**直连可达**的中继）

被墙站的内容可以由墙外的中继带回来，前提是**中继自身在境内可达**：

| 中继 | 文字 / JSON | 图片 | 实测结论 |
|---|---|---|---|
| `api.allorigins.win/raw?url=` | ✅ nhentai API 真回 JSON、e-hentai 首页 63KB | ✅ e-hentai favicon / nhentai 缩略图 | **采用**（会限流 → 429，必须带冷却） |
| `api.allorigins.win/get?url=` | ✅（包在 `contents` 里，慢 4–7s） | — | 备用 |
| `i0.wp.com/<host>/<path>` | ❌ | ✅ nhentai 缩略图 112KB jpeg | **采用**（仅图片） |
| `wsrv.nl` / `images.weserv.nl` | ❌ | ❌ `400 Domain or TLD blocked by policy` | **不采用**（屏蔽成人域名） |
| `corsproxy.io` | ❌ `401`（改成要 API key） | ❌ | **不采用** |
| `api.codetabs.com` | ❌ SNI 阻断（TCP 通、TLS 重置） | ❌ | **不采用** |
| `cors.isomorphic-git.org` | ❌ `403` 拒绝代取 | ❌ | **不采用** |
| `thingproxy.freeboard.io` | ❌ 连不上 | ❌ | **不采用** |
| `corsproxy.org` / `whateverorigin` | ⚠️ 返回的是自己的包装页（内容不可信） | ❌ | **不采用** |

**结论 4**：中继是**限流资源**。一次「镜像竞速」式检索（绅士 10 个域名 × 3 条路径）会把
AllOrigins 打成 `429`，之后**整条中继腿对所有人失效**（网关日志：
`中继取回 www.wnacg01.cc ← allorigins（13B）` → 紧接着 `429`）。
因此最终实现里加了三道闸：**响应缓存（5 分钟 / 64MB 上限）+ 双档冷却（限流 45s、真不可达 3 分钟）
+ 网关在线时前端不再叠加公共 CORS 代理链**。

### 5.3 根因取证：出口粘死

旧实现在 `ensureEgress()` 里探测本地代理端口，命中就把 `HTTPS_PROXY` 写进环境变量**重启自己**，
此后**再不重判**。用 `tools/proxy-selftest.js` 复现（起一个本机 CONNECT 代理，再把它关掉）：

```
场景 A：启动时锁定的代理端口是死的（--proxy http://127.0.0.1:7897）
  → 旧实现：每一次请求都先撞那个没人监听的端口，日志里是 ms=5 的 fetch failed
            （连本来直连就通的禁漫 APP 接口 / 拷贝漫画 API 一起被废）
  → 新实现：自动改走直连强化，10 个源全部可达，禁漫检索 11s 内出结果
```

### 5.4 http → https：同一个地址、两种协议、两种结果

绅士漫画的正文图给的是 **`http://img5.qy0.ru/...?verify=...`**：

```
node tools/netprobe.js --url "http://img5.qy0.ru/data/3863/81/0001.jpg?verify=…"
  FAIL http://img5.qy0.ru/…   → ECONNRESET            229ms
  OK   https://img5.qy0.ru/…  → HTTP 200 image/jpeg   150802B
```

**结论 5**：明文 HTTP 的 Host 头会被拦成 `ECONNRESET`，而**同一 URL 换 https 就正常**。
所以 `outFetch` 在三层都失败后**必须再试一次 https 变体**（这不是猜，是同地址的对照实测）。

### 5.5 修复后：无 VPN 端到端实测（前端 UI + 网关接口双验证）

| 能力 | 禁漫天堂 | 拷贝漫画 | 紳士漫畫 | nhentai | E-Hentai |
|---|---|---|---|---|---|
| 检索 | ✅ `total=5683` items=80 | ✅ `total=216` items=10 | ✅ 前端「紳士漫畫 9 条」 | ✅ `total=23881` items=25 | ✅ items=25（经中继，**不再退化成 torrents**） |
| 在线阅读 | ✅ 275 页，正文 webp 72KB | ✅ 24 页，正文 jpeg 221KB | ✅ 90 页，正文 jpeg 150KB / webp 163KB | ✅ 16 页，正文 webp 267KB | 逐页 N+1（本机只验证到搜索层） |
| 封面 | ✅ `cdn-msp.jmapiproxy3.cc` 直连 200 | ✅ `sf.mangafunb.fun` 200 | ✅ `t1/t3/t4.qy0.ru` 200 | ✅ 经网关中继 200 | 经中继 |

一次真实界面检索：**35 条结果 / 成功源 4→5（7 个源）/ 首次 36.8s、第二次 10.7s**
（第二次变快来自「通路记忆 + 响应缓存 + 死镜像长冷却」；会话内首次仍会付 DoH/中继的探测成本）。

**仍未打通（如实记录，不粉饰）**：`www.wnacg01/02/03/05.cc`、`wnacg.ru`、`wn04.ru` 这几个镜像是
**SNI 阻断**，中继取回来的是垃圾页（13B / 985B），所以它们永远是失败的候选 ——
绅士漫画实际靠 `www.wnacg.com`（DoH 打通）与 `www.wn03.ru`（直连就通）撑着。
danbooru 的**接口**在当前出口仍被 Cloudflare 403（网关侧要本机 Chrome 过验证，
沙箱里 Chrome 起不来），只有图片 CDN 直连可用。

---

## 6. 第二轮实测：四个「老是失败」的真因（2026-09-21 深夜）

> 这一轮全部结论都有对照实验，不是推测。工具同上（`netprobe.js` / `proxy-selftest.js`），
> 网关为 `tools/gateway.js` v1.2.x。

### 6.1 E-Hentai：上游回「HTTP 200 + content-length: 0」的空壳（最隐蔽的一处）

网关日志里抓到原始响应头（这是判断依据，不是猜的）：

```
↑ 上游回空正文（HTTP 200）：{"date":"Mon, 21 Sep 2026 04:45:21 GMT",
 "content-type":"text/html; charset=UTF-8","content-length":"0","connection":"keep-alive",
 "server":"cloudflare","x-varnish":"842344983","age":"0","via":"1.1 varnish (Varnish/6.0)",
 "accept-ranges":"bytes","strict-transport-security":"max-age=31536000; preload;","cf-cache-status":"D…"}
```

- 响应来自 **E-Hentai 自己的 Varnish**（`via: 1.1 varnish`、`x-varnish`），
  `content-length: 0` 是上游**明确决定不发正文**。
- 触发条件是**出口 IP 的请求频率**：同一个出口连着请求几次之后开始回空壳，停一两分钟又恢复。
  对照实验（同一网关、同一查询方式，只改 cookie）：

  | 请求 | 结果 |
  |---|---|
  | `?q=fate&cookie=nw=1` | `ok=false`（空壳） |
  | `?q=naruto&cookie=nw=1` | `ok=false`（空壳） |
  | `?q=bleach&cookie=nw=1` | `ok=false`（空壳） |
  | `?q=onepiece`（不带 cookie） | `ok=false`（空壳） |
  | `?q=gundam`（不带 cookie） | `ok=false`（空壳） |

  ⇒ **和 cookie / 请求头无关，就是按出口限流**。恢复后同一条链路实测能拿到
  `/` 62746B 真页面、`?f_search=fate` **25 条真结果**（`via=search`，不需要中继）。
- 另外发现一个会加重它的细节：网关原来给所有 `node:https` 请求写死
  `accept-encoding: identity`（图省事）。改成如实协商 `gzip, deflate, br` 后，
  同一个出口第一次请求就拿到了 62746B 真页面 —— 不再把自己伪装成"不接收压缩的异常客户端"。

**修法（三层）**：① `outFetch` 里 **200 + 0 字节 = 失败**（`guardEmpty`），绝不再当成
"成功但没内容"；② 识别到空壳就给这台主机记 **60 秒空壳冷却**，冷却期直接换中继出口（另一个 IP），
不再硬撞；③ 文案如实说明「① 出口 IP 被搜索侧限制 ② 限流软封锁」两种原因与该等多久/该做什么。

> 这一条正是「E-Hentai 老是说搜不到」的主因：旧代码把空壳当成**成功返回的空结果**，
> 于是页面显示「搜索侧在当前出口 IP 下返回空集」—— 一个听起来很确定、其实是误判的结论。

### 6.2 通用坑：301/302 不跟随，等于把源判死

`node:http(s)` 不像 `fetch` 那样自动跟重定向，而这两个站的**正常应答就是 3xx**：

| 实测 | 结果 |
|---|---|
| `www.wn03.ru/` | `301 → https://www.wn07.ru/`（而 wn07.ru 又被 SNI 阻断 → 死路） |
| `www.wnacg.date/search/?…` | `301 → www.wnacg.com/…`（**跟过去就是好页面**） |
| `porn-comic.com/q/fate-1.html` | `302 →` 规范化地址（跟过去是 39833B 的真检索页） |

不跟的后果不只是"少一个候选"：`/api/proxy` 会把 301 原样回给浏览器，浏览器再去请求
`Location` 里的上游地址（跨域必失败），整个源就表现为"取不到"。修法：`hsRequest` 与中继层
都自己跟随（上限 5 跳 / 3 跳，只跟 GET），并把每一跳记进日志。

### 6.3 porn-comic：中继能取到**真**页面，之前的「CF 挑战」是误判

早期用 `challenge-platform` 这个字符串判断"是不是 CF 挑战页"，实测**正常页面里也会引用这个脚本**，
于是把真页面误判成挑战页。改判据（先认列表特征 `a.thumb` / `/h/<id>.html`，都没有再谈挑战）之后：

| 入口 | 经中继的结果 |
|---|---|
| `/language/chinese.html` | HTTP 200，30720B，title 正常，38 个 `/h/` 链接、24 个 thumb，**挑战标记全 0** |
| `/tags/fate.html` | HTTP 200，18273B，真页面（但该页只是标签索引，几乎没有作品链接） |
| `/q/fate-1.html` | 302 → 跟随 → HTTP 200，39833B，25 个 thumb |

⇒ porn-comic **不需要 Chrome 也能取**：中继（境内直连可达、出口在墙外）就能拿到真页面。
所以三条通路的顺序改成 **直连 → 中继 → 本机 Chrome**，任一条失败只罚自己
（直连 5 分钟、中继 60 秒），不影响另外两条。CF 首次失败也改成只罚 15 秒（环境性失败才 90 秒）。
开着 VPN 实测（用户环境）：`/api/porncomic/search?q=fate` → **24 条**。

### 6.4 紳士漫畫：镜像池的真实状态与「网关侧检索」

`netprobe` 逐域名实测（无 VPN 环境）：

| 域名 | 判定 |
|---|---|
| `www.wnacg.com` | DNS 污染，**DoH 给真 IP → ✓200**（最可靠的一个入口） |
| `www.wnacg.date` | ✓301 → `www.wnacg.com`（跟随即可用） |
| `www.wn03.ru` | ✓301 → `www.wn07.ru`，而 **wn07 被 SNI 阻断** → 死路 |
| `www.wnacg01/02/03/05.cc`、`wnacg.ru`、`wn04.ru`、`wnacg.com`（不带 www） | SNI 阻断 / 全 IP 不可达 |
| 经中继取回 `www.wnacg01.cc` → 13B；`www.wnacg02.cc` → 985B | **垃圾页，等于白烧中继配额** |

⇒ 前端原来「10 镜像 × 3 路径全量竞速」的做法，一次检索最多 30 个上游请求、还要烧中继配额。
改成网关侧 `/api/wnacg/search`：**分批竞速（每批 3 个）**、跟随重定向、记住最近成功的镜像、
失败主机冷却、结果缓存 5 分钟。实测 `q=fate → host=www.wnacg.com, 24 条`（首次 16s，冷 DoH；
第二次 1.5s；缓存命中 24ms），封面全部拿到（`t4.qy0.ru`，直连 ✓200）。

> 顺带记一个正则坑：检索结果页会把命中词高亮成 `<em>`，而**高亮写在 `alt` 属性里** ——
> `alt="…(<em>Fate</em>)…"` 中的 `>` 会让 `<img[^>]*src="…"` 提前收尾，封面永远空。
> 必须直接找资源地址本身（要求以 `//` 或 `http` 开头，借以排除站点 logo 的 `data:` URI）。

### 6.5 界面：联想泡泡盖住思维链

实测几何（1386×725 视口）：搜索条容器 `#search-wrap` y=358 高 61（底边 419），
思维链 `#chain-panel` y=435 高 70（底边 505），而泡泡层默认 `top: calc(100% + 10px)`
落在 y≈429 —— 正好压住思维链第一行。修法：思维链**底边**仍在泡泡默认位置之下时，
把泡泡整体让到它下面（并用 `ResizeObserver` 跟随思维链长高）；思维链不可见时清掉内联样式、
完全回到 CSS 默认。实测修复后泡泡 y=512.95 > 思维链底边 504.75，不再重叠。

---

## 附：复现用的验证脚本

本轮 CORS 判定所用的本地测试页（浏览器打开后自动跑 7 个跨域 `fetch` 并把结果写进 DOM）：

```js
const targets = [
  ['kemono.cr API',        'https://kemono.cr/api/v1/posts?q=test&o=0'],
  ['porn-comic home',      'https://porn-comic.com/'],
  ['porn-comic anime pg',  'https://porn-comic.com/anime/naruto.html'],
  ['porn-comic api cover', 'https://porn-comic.com/api/cover18.html?ajax=1'],
  // ...
];
for (const [name, url] of targets) {
  try {
    const r = await fetch(url, { mode: 'cors', credentials: 'omit' });
    console.log(name, 'OK', r.status, r.headers.get('access-control-allow-origin'));
  } catch (e) { console.log(name, 'FAIL', e.message); }
}
// 然后在 DevTools console 读 "blocked by CORS policy: No 'Access-Control-Allow-Origin'"
```

## 附：未能确认项清单（不编造）

1. Kemono post **tags** 字段名 —— 列表端点不含 tags，creator/post 详情端点返回 `application/octet-stream`，未能读取。
2. Kemono **作者名 / 头像** —— creator 端点（`/api/v1/{service}/user/{id}`）同样返回 octet-stream，未能确认字段。
3. Kemono 图片是否需 `Referer` —— `n2.kemono.cr` 直连 `fetch failed`，原因未定位。
4. LectorManga/TMO **现役域名与端点** —— 原站查封，继任站被安全扩展拦截。
5. porn-comic 列表条目**外层容器 class** —— 工具无法按 CSS 选择器取片段，故只用已验证的 `a.thumb`。
6. porn-comic **是否存在可用镜像** —— 未发现。
7. porn-comic 搜索页在**非自动化环境**下能否过 Cloudflare —— 人工浏览器应可过，程序化未通过。
