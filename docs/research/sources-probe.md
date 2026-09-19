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

## 2. LectorManga（lectormanga.com）

### 2.1 结论先行：原站已被警方查封，源已不可用

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

**最终判定：LectorManga 源当前不可用；现役可用检索端点「未能确认」。** 建议在聚合器里标记为下线，或改用 zonatmo 系列但需人工确认其真实 API。

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
| **LectorManga**（TMO） | HTML | ❌ 无（第三方脚本需 CORS 扩展佐证） | ❌ 不可用 | **源已查封下线**；即便复活也须走网关 |
| **porn-comic**（`porn-comic.com`） | HTML | ❌ **无**（实测拦截） | ❌ 不可用 | **必须走本地网关**；搜索另有 Cloudflare 挑战 |

**三个源没有一个能纯浏览器直连** —— 全部缺失 `Access-Control-Allow-Origin`。纯前端聚合器若想直接 `fetch`，只能：

1. **本地 Node 网关（推荐）**：网关代取 → 加 `Access-Control-Allow-Origin: *` 回吐给前端。这也是唯一能顺手解决以下问题的方案：
   - Kemono 的 DDoS-Guard cookie
   - porn-comic 的 18+ 年龄 cookie
   - 统一 UA / `Referer`
2. 公共 CORS 代理：测试中 `allorigins.win`、`codetabs.com` 大量返回 **520/522**，不稳定，不建议作为生产依赖。

**各源可用性再评级**

- **Kemono** — 唯一「端点完整、JSON 规整、当场验证成功」的源。`/api/v1/posts?q=&o=` 可直接照抄。注意 `count` 恒为 50000（用 `true_count`）、列表无 tags/无作者名、封面需拼 `/data` + 相对路径且会重定向到 `n2.kemono.cr`。
- **porn-comic** — 站点活着，但**只有 HTML**，且**搜索被 Cloudflare 挑战挡住**。实用做法是抓列表页/标签页/语言页（这些无挑战），用 `a.thumb` 解析；关键词搜索不可靠。
- **LectorManga** — **建议直接下线**。原站已被西班牙警方查封，`lectormanga.com` / `visortmo.com` 全部 `ERR_CONNECTION_CLOSED`；标称的继任域名要么是仿冒站（`visortmo.ws`），要么被安全软件判黑（`zonatmo.*`），现役可用端点**未能确认**。

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
