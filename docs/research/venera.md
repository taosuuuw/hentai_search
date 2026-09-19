# Venera 如何检索中国漫画站点 —— 源码级调研报告

调研对象：<https://github.com/venera-app/venera>（Dart/Flutter 客户端，v1.6.3，**已 archive**；后继 <https://github.com/venera-app/venera-prime>）
所有结论均来自仓库真实源码文件；每条附来源 URL。**未能确认**的项已明确标注，未编造。

---

## 0. 结论速览（最重要的架构事实）

1. **主仓库 `venera-app/venera` 里没有任何一个漫画站的地址、接口或密钥。** 它是一个"漫画源引擎"：所有站点逻辑放在**独立的 JavaScript 插件仓库** `venera-app/venera-configs` 里，运行时由 `flutter_qjs`（QuickJS 绑定）执行。
   - 默认源列表地址（App 内 `settings['comicSourceListUrl']` 的默认值）：
     `https://cdn.jsdelivr.net/gh/venera-app/venera-configs@main/index.json`
     来源：<https://raw.githubusercontent.com/venera-app/venera/master/lib/foundation/appdata.dart>（文件末尾 `const _defaultSourceListUrl = "https://cdn.jsdelivr.net/gh/venera-app/venera-configs@main/index.json";`）
   - 源索引：<https://raw.githubusercontent.com/venera-app/venera-configs/main/index.json>
2. **所谓"绕过跨域"其实不存在**：Venera **没有 Web 构建目标**（仓库只有 `android/ ios/ linux/ macos/ windows/`，无 `web/`），HTTP 走 `dio` + `rhttp`（Rust）原生 socket，因此**完全不受浏览器同源策略/CORS 限制**。跨域只在"浏览器里跑 JS 插件"这个假设下才是问题，而这里是原生宿主执行 JS。
   来源：<https://raw.githubusercontent.com/venera-app/venera/master/pubspec.yaml>、<https://raw.githubusercontent.com/venera-app/venera/master/lib/network/app_dio.dart>
3. **只有 PicACG 和拷贝漫画需要"签名"**，两者算法、密钥字符串均已在本报告给出（见 §3、§4）。其余中文源（JM、wnacg、manhuagui、mxs、mh18、hcomic、manhuaren、jcomic）**没有任何 API key / HMAC / 签名**。
4. **镜像轮换有两套真实机制**：JM（远端 AES 加密域名列表）和 wnacg（抓取导航页）。见 §6。
5. **没有任何第三方"聚合 API"**。聚合搜索是**本地**把多个已安装源的结果并排显示。见 §7。
6. `喵绅士` **未收录**于 venera-configs 的 33 个源中。`mxs.js` 是**漫小肆**，不是喵绅士。

---

## 1. 仓库结构与插件机制

- 引擎仓库：`venera-app/venera`，Dart，GPL-3.0，11k★，**archived: true**（API 返回 `"archived":true`）。来源：<https://api.github.com/orgs/venera-app/repos>
- 源仓库：`venera-app/venera-configs`，**JavaScript**，848★，未归档。来源：<https://api.github.com/repos/venera-app/venera-configs>
- 插件被解析为 `ComicSource` 对象（`lib/foundation/comic_source/comic_source.dart` + `parser.dart`），暴露 `search` / `categoryComics` / `comic` / `favorites` / `explore` 等字段。
  来源：<https://raw.githubusercontent.com/venera-app/venera/master/lib/foundation/comic_source/comic_source.dart>
- 插件可用的宿主 API（`Network.get/post/put/delete/fetchBytes`、`HtmlDocument`、`Convert.md5/sha256/hmacString/decryptAesEcb/decodeBase64`、`UI`、`fetch`）：
  <https://raw.githubusercontent.com/venera-app/venera/master/doc/js_api.md>
  **关键**：`Network` 全部是原生调用（`sendMessage` 桥），`fetch` 只是 `Network.fetchBytes` 的包装，**不是浏览器 fetch**，所以没有 CORS 概念。
- 模板：<https://raw.githubusercontent.com/venera-app/venera-configs/main/_template_.js>

### index.json 中的 33 个源（中文相关）
`copy_manga`(拷贝漫画)、`copy_manga_multi_accounts`(拷贝漫画多账号)、`picacg`、`jm`(禁漫天堂)、`wnacg`(紳士漫畫)、`manhuagui`(漫画柜)、`mxs`(漫小肆)、`mh18`(18漫画)、`hcomic`(H-Comic)、`manhuaren`(漫画人)、`jcomic`(jcomic.net)、`ikmmh`(爱看漫)、`ykmh`(优酷漫画)、`zaimanhua`(再漫画)、`manwaba`(漫蛙吧)、`mh1234`(漫画1234)、`ccc`(CCC追漫台)、`goda`(GoDa漫画)、`hot_manga`(热辣漫画)、`happy`(嗨皮漫画)、`mycomic`、`baozi`(包子漫画)、`komiic`、`nhentai`、`ehentai`、`hitomi`、`manga_dex`、`comick`、`shonen_jump_plus`、`comic_walker`、`lanraragi`、`komga`、`kavita`
**无 `喵绅士`、无 `manhuagui` 的替代、无 `copymanga` 之外的拷贝源。**
来源：<https://raw.githubusercontent.com/venera-app/venera-configs/main/index.json>

---

## 2. 各中文源的搜索端点（逐源，全部可复制）

### 2.1 禁漫天堂 18comic / JM —— `jm.js` v1.4.0
来源：<https://raw.githubusercontent.com/venera-app/venera-configs/main/jm.js>

**搜索（真实端点）**
```js
keyword = keyword.trim()
keyword = encodeURIComponent(keyword)
keyword = keyword.replace(/%20/g, '+')          // 空格 -> '+'
let url = `${this.baseUrl}/search?search_query=${keyword}&o=${options[0]}`
if (page > 1) url += `&page=${page}`
```
排序 `o` 取值：`mr`(最新) `mv`(总排行) `mv_m`(月) `mv_w`(周) `mv_t`(日) `mp`(最多图片) `tf`(最多喜欢)；每页 80 条（`maxPage = Math.ceil(total/80)`）。

**鉴权头（不是 HMAC，是 md5 时间戳）**
```js
const jmAuthKey = "18comicAPPContent"
let token = Convert.md5(Convert.encodeUtf8(`${time}${jmAuthKey}`))
// headers:
{ "token": Convert.hexEncode(token),
  "tokenparam": `${time},${JM.jmVersion}`,          // JM.jmVersion = "2.0.16"
  "Authorization": "Bearer",
  "X-Requested-With": JM.jmPkgName,                 // JM.jmPkgName = "com.example.app"
  "Origin": "https://localhost",
  "Referer": "https://localhost/",
  "User-Agent": "Mozilla/5.0 (Linux; Android 10; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36" }
```
`time = Math.floor(Date.now()/1000)`。

**响应解密（AES-ECB）**
```js
let kJmSecret = "185Hcomic3PAPP7R"
// key = hex(md5(utf8(`${time}${kJmSecret}`)))
let res = this.convertData(json.data, `${time}${kJmSecret}`)   // base64 -> AES-ECB -> utf8
```
`convertData` 用 `Convert.decryptAesEcb`，再截取第一个 `{`/`[` 到最后一个 `}`/`]`。

**其它端点**：`/promote?page=0`（首页）、`/categories/filter?o=&c=&page=`、`/week`、`/week/filter?id=&type=&page=`、`/album?id=`、`/chapter?id=`、`/login`(POST)、`/favorite`、`/favorite_folder`、`/like`、`/comment`、`/forum?mode=manhua&aid=&page=`、`/daily?user_id=`、`/daily_chk`(POST)、`/setting?app_img_shunt=N&express=`（取图片分流 `img_host`）。

**图片**：默认 `static imageUrl = "https://cdn-msp.jmapinodeudzn.net"`；封面 `${imageUrl}/media/albums/${id}_3x4.jpg`，内页 `${imageUrl}/media/photos/${albumId}/${imageName}`。
**图片切割还原（JM 著名的乱序）**在 `onImageLoad` 内实现：`scrambleId = 220980`，分档 `268850`、`421926`；`epId > 421926` 时 `num = (charCode(md5(epId+pictureName) 十六进制最后一位) % 10)*2+2`，否则 `%8*2+2`；再按块从下往上拼。

### 2.2 拷贝漫画 copymanga —— `copy_manga.js` v1.4.2
来源：<https://raw.githubusercontent.com/venera-app/venera-configs/main/copy_manga.js>

**基址是运行时动态发现的**（不是硬编码）：
```js
const url = "https://api.copy-manga.com/api/v3/system/network2?platform=3"
// res.json().results.api[0][0]  ->  this.settings.base_url
```
静态默认值：`static defaultApiUrl = 'api.copy2000.online'`（用时拼 `https://`）。

**搜索（两种模式，由设置 `search_api` 切换）**
```js
// 默认 baseAPI
`${apiUrl}/api/v3/search/comic?limit=30&offset=${(page-1)*30}&q=${encodeURIComponent(keyword)}&q_type=${q_type}`
// 可选 webAPI
`${apiUrl}${CopyManga.searchApi}` + 同样的 query string
// static searchApi = "/api/kb/web/searchb/comics"
```
`searchApi` 会被 `refreshSearchApi()` 动态刷新：抓 `https://www.copy20.com/search`，正则 `/const countApi = "([^"]+)"/`。
`q_type` 选项：`""`(全部) `name` `author` `local`。

**签名头（HMAC-SHA256）**
```js
let secret = "M2FmMDg1OTAzMTEwMzJlZmUwNjYwNTUwYTA1NjNhNTM="
let ts = Math.floor(Date.now()/1000).toString()
let sig = Convert.hmacString(Convert.decodeBase64(secret), Convert.encodeUtf8(ts), "sha256")
// 注意：base64 解码后的 32 字节才是 HMAC key，message 是十进制时间戳字符串
```
完整头：
```js
{ "User-Agent": `COPY/3.0.6`, "source": "copyApp", "deviceinfo": ..., "device": ..., "pseudoid": ...,
  "dt": `YYYY.MM.DD`, "platform": "3", "referer": `com.copymanga.app-3.0.6`, "version": "3.0.6",
  "Accept": "application/json", "region": copyRegion,
  "authorization": `Token${token ? " " + token : ""}`,
  "umstring": "b4c89ca4104ea9a97750314d791520ac",
  "x-auth-timestamp": ts, "x-auth-signature": sig }
```
**其它端点**：`/api/v3/login`(POST form)、`/api/v3/h5/homeIndex`、`/api/v3/ranks?limit=30&offset=&type=1&audience_type=&date_type=`、`/api/v3/comics?limit=30&offset=&ordering=&theme=&top=`、`/api/v3/comic2/{path_word}?in_mainland=true&request_id=&platform=3`、`/api/v3/comic/{id}/group/{group}/chapters?limit=100&offset=`、`/api/v3/comic/{id}/chapter2/{epId}?...`（图片质量改写 `c${imageQuality}x.webp`）、`/api/v3/comments`、`/api/v3/member/collect/comic`。
**第三方辅助端点**：request-id 取 `https://marketing.aiacgn.com/api/v2/adopr/query3/?format=json&ident=200100001` → `results.request_id`。

### 2.3 哔咔 PicACG —— `picacg.js` v1.0.6
来源：<https://raw.githubusercontent.com/venera-app/venera-configs/main/picacg.js>（详见 §3）

**搜索端点（注意：不是 `/api/v2/comics/search`）**
```js
POST `${base_url}/comics/advanced-search?page=${page}`
body: JSON.stringify({ keyword: keyword, sort: options[0] })   // sort: dd/da/ld/vd
```
`base_url` 默认 `https://picaapi.picacomic.com`。
其它：`/auth/sign-in`(POST)、`/comics/random`、`/comics?page=&s=dd`、`/comics/leaderboard?tt=H24|D7|D30&ct=VC`、`/comics/{id}`、`/comics/{id}/eps?page=`、`/comics/{id}/order/{epId}/pages?page=`、`/comics/{id}/recommendation`、`/comics/{id}/comments?page=`、`/comments/{id}/childrens?page=`、`/comics/{id}/favourite`、`/users/favourite?page=&s=`。图片只需 `user-agent: okhttp/3.8.1`。

### 2.4 紳士漫畫 wnacg —— `wnacg.js` v1.0.5
来源：<https://raw.githubusercontent.com/venera-app/venera-configs/main/wnacg.js>

**搜索（纯 HTML 抓取，无 API）**
```js
let url = `${this.baseUrl}/search/?q=${encodeURIComponent(keyword)}&f=_all&s=create_time_DESC&syn=yes`
if (page !== 0) url += `&p=${page}`
```
`baseUrl` 来自设置：域名 0 = 自定义（默认 `wnacg.com`），1–3 来自刷新得到的列表（见 §6）。**请求头传 `{}`**，无 Referer/UA/签名。
解析：`div.grid div.gallary_wrap > ul.cc > li`，总数 `p.result > b`，每页 24。
其它端点：`/albums.html`、`/albums-index-cate-5.html` 等分类、`/albums-favorite_ranking-type-{day|week|month}[-page-N].html`、`/photos-index-page-1-aid-{id}.html`、`/photos-gallery-aid-{id}.html`（图片用正则 `//[^"]+/[^"]+\.[^"]+` 从 HTML 抠出）、`/users-check_login.html`(POST)、`/users-save_fav-id-{comicId}.html`(POST)。

### 2.5 漫画柜 manhuagui —— `manhuagui.js` v1.2.1
来源：<https://raw.githubusercontent.com/venera-app/venera-configs/main/manhuagui.js>

**搜索（HTML 抓取，关键词不编码）**
```js
// 无排序
`https://www.manhuagui.com/s/${keyword}_p${page}.html`
// 有排序
`https://www.manhuagui.com/s/${keyword}_o${type}_p${page}.html`   // type 0/1/2/3
```
`baseUrl = "https://www.manhuagui.com"`（硬编码，无镜像）。每页 10 条。
GET 头**没有 User-Agent**：`accept`, `accept-language`, `cache-control`, `pragma`, `priority`, `sec-ch-ua*`, `sec-fetch-*`, `upgrade-insecure-requests`, `Referer: https://www.manhuagui.com/`, `Referrer-Policy`, `cookie: mhg_cookie`。
JSON 端点仅 `/tools/submit_ajax.ashx?action=user_login|comment_list|comment_add|user_book_shelf_add`。
章节图片：第 5 个 `<script>` 经 LZString `decompressFromBase64` + Dean Edwards p.a.c.k.e.r 解包 → `https://us.hamreus.com` + path + file + `?e=${sl.e}&m=${sl.m}`。
**无签名、无加密响应、无镜像轮换、无聚合 API。**

### 2.6 漫小肆 mxs（**不是喵绅士**）—— `mxs.js` v1.0.0
来源：<https://raw.githubusercontent.com/venera-app/venera-configs/main/mxs.js>

**7 个硬编码镜像**（仅用户手动选择 + "检测"按钮，**无自动轮换**）：
`https://www.mxshm.top`(默认) `https://www.jjmhw1.top` `https://www.jjmh.top` `https://www.jjmh.cc` `https://www.wzd1.cc` `https://www.wzdhm1.cc` `https://www.ikanwzd.cc`
```js
get baseUrl() { return this.loadSetting("domains"); }
// 搜索：GET `${baseUrl}/search?keyword=${encodeURIComponent(keyword)}`   // 无分页，maxPage 恒为 1
```
唯一请求头：`User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/120.0.0.0 Safari/537.36`。
其它：`/update?page=`、`/rank`、`/booklist?tag=&area=&end=&page=`、`/book/{id}`、`/chapter/{epId}`。

### 2.7 18漫画 mh18 —— `mh18.js` v1.0.0
来源：<https://raw.githubusercontent.com/venera-app/venera-configs/main/mh18.js>

```js
const res = await Network.get(`${this.baseUrl}/s/${keyword}?page=${page}`)   // 关键词未编码，且不传 headers
// get baseUrl() { return `https://${this.loadSetting("domains")}` }  default: "18mh.org"
headers getter = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0",
                   "Referer": this.baseUrl }   // 仅 explore/category/chapter 使用
```
章节列表 `/manga/get?mid={mangaId}&mode=all&t={Date.now()}`（`t` 是防缓存，**不是签名**）；章节图 `/chapter/getcontent?m=&c=`。**无签名、无镜像列表、无聚合 API。**

### 2.8 H-Comic / 漫画人 / jcomic
来源：<https://raw.githubusercontent.com/venera-app/venera-configs/main/hcomic.js>、<https://raw.githubusercontent.com/venera-app/venera-configs/main/manhuaren.js>、<https://raw.githubusercontent.com/venera-app/venera-configs/main/jcomic.js>

- **hcomic** v1.0.0：`baseUrl = "https://h-comic.com"`；搜索 `GET https://h-comic.com/?q=${encodeURIComponent(kw)}&tag=&page=${page}`；只发 `User-Agent`；解析 SvelteKit 内联 JS 字面量 `data: [null, {...}]`（正则 + 去引号键名修复 + `JSON.parse`，失败回退 `new Function`）；章节图在**另一个域名** `https://h-comic.link/api/${source}/${mediaId}/pages/${i}`；无签名。
- **manhuaren** v1.0.0：`baseUrl = "https://www.manhuaren.com"`；搜索 `GET /search?title=${enc(kw)}&language=1&page=${page}`，头含 `host: www.manhuaren.com` + Android Chrome UA；**唯一会用 POST 的中文源**：分类 `POST ${baseUrl}/{path}/dm5.ashx`，body `action=getclasscomics&pageindex=&pagesize=21&categoryid=0&tagid=&status=&usergroup=0&pay=-1&areaid=0&sort=&iscopyright=0`；章节图需 Dean Edwards packer 解包；注释表情里有一条**被注释掉的** `// 'Host': host || ''`。
- **jcomic** v1.0.0：`https://jcomic.net`；搜索 `GET /search/${encodeURIComponent(kw)}`（第 1 页）或 `/search/${enc(kw)}/${page}`（第 2 页起，分页是**路径段**不是 query）；**全部请求只带 `referer: https://jcomic.net/`**；无签名。

---

## 3. PicACG 的请求签名 —— 确切算法与密钥（重点）

### 3.1 venera 插件版实现（`picacg.js`，逐字）
```js
static defaultApiUrl = "https://picaapi.picacomic.com"
apiKey = "C69BAF41DA5ABD1FFEDC6D2FEA56B";

createSignature(path, nonce, time, method) {
    let data = path + time + nonce + method + this.apiKey
    let key = '~d}$Q7$eIni=V)9\\RK/P.RM4;9[7|@/CA}b~OW!3?EV`:<>M7pddUBL5n|0/*Cn'
    let s = Convert.encodeUtf8(key)
    let h = Convert.encodeUtf8(data.toLowerCase())
    return Convert.hmacString(s, h, 'sha256')
}

buildHeaders(method, path, token) {
    let uuid = createUuid()
    let nonce = uuid.replace(/-/g, '')
    let time = (new Date().getTime() / 1000).toFixed(0)
    let signature = this.createSignature(path, nonce, time, method.toUpperCase())
    return {
        "api-key": "C69BAF41DA5ABD1FFEDC6D2FEA56B",
        "accept": "application/vnd.picacomic.com.v1+json",
        "app-channel": this.loadSetting('appChannel') || "3",
        "authorization": token ?? "",
        "time": time,
        "nonce": nonce,
        "app-version": "2.2.1.3.3.4",
        "app-uuid": "defaultUuid",
        "image-quality": this.loadSetting('imageQuality') || "original",
        "app-platform": "android",
        "app-build-version": "45",
        "Content-Type": "application/json; charset=UTF-8",
        "user-agent": "okhttp/3.8.1",
        "version": "v1.5.4",
        "signature": signature,
        "http_client": "dart:io",
    }
}
```

**算法（文字化）**
```
signature = HMAC_SHA256(
    key     = '~d}$Q7$eIni=V)9\RK/P.RM4;9[7|@/CA}b~OW!3?EV`:<>M7pddUBL5n|0/*Cn'  (原始 ASCII 字节),
    message = lowercase( path + time + nonce + METHOD + "C69BAF41DA5ABD1FFEDC6D2FEA56B" )
)
```
- `time`：Unix 秒（字符串）
- `nonce`：UUID 去掉连字符（32 位 hex）
- `METHOD`：大写（`GET`/`POST`）
- `path`：**包含 query string**，且**不含** `https://picaapi.picacomic.com/` 前缀。例：签名路径是 `comics?page=1&s=dd`、`comics/advanced-search?page=1`、`auth/sign-in`。
- 输出：十六进制字符串

### 3.2 独立交叉验证（同作者早期客户端 `wgh136/PicaComic`，Dart 原生实现）
来源：<https://raw.githubusercontent.com/wgh136/PicaComic/master/lib/network/picacg_network/headers.dart>
```dart
var apiKey = "C69BAF41DA5ABD1FFEDC6D2FEA56B";

String createSignature(String path, String nonce, String time, String method) {
  String key = path + time + nonce + method + apiKey;
  String data =
      '~d}\$Q7\$eIni=V)9\\RK/P.RM4;9[7|@/CA}b~OW!3?EV`:<>M7pddUBL5n|0/*Cn';
  var s = utf8.encode(key.toLowerCase());
  var f = utf8.encode(data);
  var hmacSha256 = Hmac(sha256, f);     // key = f  = 上面那个密钥串
  var digest = hmacSha256.convert(s);   // data = s  = 小写拼接串
  return digest.toString();
}
```
**两处实现完全一致**（HMAC key = 密钥串，message = 小写拼接串），可信度极高。
该文件的头列表还多一条 **`"Host": "picaapi.picacomic.com"`**，`"version": "v1.4.1"`（venera 新版是 `v1.5.4`）。
其搜索实现同样是 `POST $apiUrl/comics/advanced-search?page=$page`，body `{"keyword": ..., "sort": ...}`。
来源：<https://raw.githubusercontent.com/wgh136/PicaComic/master/lib/network/picacg_network/methods.dart>

### 3.3 关于你提到的 `/api/v2/comics/search?keyword=` 与"picacg app token"
- **在 venera 的 `picacg.js` 与 `wgh136/PicaComic` 中都不存在 `/api/v2/...` 路径。** 两者都用 v1 基址 `https://picaapi.picacomic.com` + `/comics/advanced-search?page=N`（POST，body 带 `keyword`）。
- 因此 "venera 用 `/api/v2/comics/search?keyword=`" 这一说法 **未能确认，且在源码中不成立**。
- `api/v2/...` 属于哔咔官方 2.x App / 其他第三方客户端所用的较新接口族 —— 这一点**未能确认**（本会话搜索未取到可引用的权威源码；Bing zh-CN 结果无有效技术来源）。若需要，请以某个具体第三方客户端的源码为准再核。
- "picacg app token"：**除上面给出的 `apiKey` 常量外，venera 中没有别的全局 app token**。真正的 `authorization` 值来自登录：`POST /auth/sign-in` body `{"email":..., "password":...}` → `json.data.token`，随后存本地并以 `"authorization": token` 发送（未登录时发空串）。**不存在像 18comic 那样的 `"18comic"` 式静态 token 字符串。**

**请求头名字汇总（你问的）**：`api-key`、`authorization`、`time`、`nonce`、`signature`、`accept`、`app-channel`、`app-version`、`app-uuid`、`app-platform`、`app-build-version`、`image-quality`、`version`、`user-agent`、`Content-Type`、`Host`（仅 PicaComic 版显式设置）。

---

## 4. 拷贝漫画的签名（唯一另一个需要签名的中文源）

```js
let secret = "M2FmMDg1OTAzMTEwMzJlZmUwNjYwNTUwYTA1NjNhNTM="   // base64
let sig = Convert.hmacString(Convert.decodeBase64(secret), Convert.encodeUtf8(ts), "sha256")
// 头：x-auth-timestamp: ts,  x-auth-signature: sig
// 固定串：umstring: "b4c89ca4104ea9a97750314d791520ac"
```
来源：<https://raw.githubusercontent.com/venera-app/venera-configs/main/copy_manga.js>
注意语义：`Convert.hmacString(key, value, hash)` → **第 1 个参数是 key**，第 2 个是 message（见 `doc/js_api.md`）。所以 HMAC key = base64 解码后的 32 字节，message = 十进制秒级时间戳字符串。

---

## 5. 跨域 / CORS 与"客户端直连需要哪些头"

### 5.1 为什么不存在跨域问题
- 仓库无 `web/` 目录（树中只有 `android/ assets/ debian/ doc/ fastlane/ ios/ lib/ linux/ macos/ patch/ test/ windows/`）。来源：<https://api.github.com/repos/venera-app/venera/git/trees/master?recursive=1>
- `pubspec.yaml` 目标平台为 Android/iOS/Linux/macOS/Windows；HTTP 栈为 `dio` + `rhttp`（Rust）+ `flutter_qjs`（QuickJS）。
  来源：<https://raw.githubusercontent.com/venera-app/venera/master/pubspec.yaml>
- `RHttpAdapter.fetch()` 直接调用 `rhttp.Rhttp.request`（原生 socket），无浏览器同源检查。
  来源：<https://raw.githubusercontent.com/venera-app/venera/master/lib/network/app_dio.dart>
- JS 插件的 `Network.*` 通过 `sendMessage` 走原生桥，`fetch` 只是 `Network.fetchBytes` 的包装。
  来源：<https://raw.githubusercontent.com/venera-app/venera/master/doc/js_api.md>
- **默认 UA**：若插件未指定 UA，App 会补 `User-Agent: venera/v${App.version}`。
  来源：`app_dio.dart`（`if (options.headers['User-Agent'] == null && ...) options.headers['User-Agent'] = "venera/v${App.version}";`）
- 全局默认网页 UA 常量：`webUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/119.0.0.0 Safari/537.36"`。
  来源：<https://raw.githubusercontent.com/venera-app/venera/master/lib/foundation/consts.dart>

### 5.2 各源实际需要的头（"客户端直连"清单）
| 源 | Referer | Origin | User-Agent | Host | 其它 |
|---|---|---|---|---|---|
| JM 18comic | `https://localhost/` | `https://localhost` | Android Chrome 130 webview | 无 | `token`/`tokenparam`/`X-Requested-With: com.example.app` |
| PicACG | 无 | 无 | `okhttp/3.8.1` | `picaapi.picacomic.com`（仅 PicaComic 显式） | `api-key`/`time`/`nonce`/`signature`/`authorization` |
| copyManga | `com.copymanga.app-3.0.6`（非 URL 形式） | 无 | `COPY/3.0.6` | 无 | `x-auth-timestamp`/`x-auth-signature`/`umstring` |
| wnacg | 无 | 无 | 无（App 补 `venera/vX`） | 无 | — |
| manhuagui | `https://www.manhuagui.com/` | 无 | **无** | 无 | cookie `my=...` |
| mxs | 无 | 无 | Chrome 120 Win | 无 | — |
| mh18 | `this.baseUrl`（仅部分请求） | 无 | Firefox 144 Win | 无 | — |
| manhuaren | `<baseUrl>/` 或章节页 | `<baseUrl>`（仅分类 POST） | Android/iOS UA | `www.manhuaren.com` | `x-requested-with` |
| jcomic | `https://jcomic.net/` | 无 | 无 | 无 | — |
| hcomic | 无 | 无 | Chrome 120 Win | 无 | — |

**图片请求头**由插件的 `comic.onImageLoad` / `onThumbnailLoad` 返回，例如 JM 用 `getImgHeaders()`（`Referer: https://localhost/`、`X-Requested-With: com.example.app`、Android UA），PicACG 只给 `user-agent: okhttp/3.8.1`，manhuagui 给一套 `sec-fetch-dest: image` 的头且带 `Referer: https://www.manhuagui.com/`。

### 5.3 客户端层面的"绕过"能力（真正的鲁棒性来源）
全部在 `lib/network/app_dio.dart`：
- **代理**：设置项 `proxy`（`direct` / `system` / 自定义串），`lib/network/proxy.dart` 读取；`RHttpAdapter` 把它传给 `rhttp.ProxySettings.proxy(...)`。Linux 下 `proxy = "No Proxy"` 直接返回 null。
- **DNS 覆写**：`settings['enableDnsOverrides']` + `settings['dnsOverrides']` → `rhttp.DnsSettings.static(overrides: ...)`。这用于把被污染的域名强行指到可用 IP。
- **SNI 开关 / 忽略证书**：`TlsSettings(sni: settings['sni'] != false, verifyCertificates: settings['ignoreBadCertificate'] != true)`。
- **Cloudflare 挑战处理**：拦截器检测响应头 `cf-mitigated: challenge` → 抛 `CloudflareException` → `passCloudflare()` 打开内嵌 WebView（桌面端 `DesktopWebview`），等挑战通过后把 `cf_clearance` 等 cookie 写入 cookie jar，并**把 WebView 的 UA 记为后续请求的 UA**。
  来源：<https://raw.githubusercontent.com/venera-app/venera/master/lib/network/cloudflare.dart>
- **登录用 WebView**（`loginWithWebview`）同理，可把 cookie 与 `window.localStorage` 回灌给插件（`source.data['_localStorage']`）。
  来源：<https://raw.githubusercontent.com/venera-app/venera/master/lib/pages/comic_source_page.dart>

---

## 6. 镜像域名轮换机制（域名列表在哪里）

### 6.1 JM（禁漫天堂）—— 远端加密列表 + 内置兜底
```js
static fallbackServers = [
    "www.cdntwice.org",
    "www.cdnsha.org",
    "www.cdnaspa.cc",
    "www.cdnntr.cc",
];

async refreshApiDomains(showConfirmDialog) {
    let url = "https://rup4a04-c02.tos-cn-hongkong.bytepluses.com/newsvr-2025.txt"
    let domainSecret = "diosfjckwpqpdfjkvnqQjsik"
    let res = await fetch(url, { headers: this.baseHeaders });
    let data = this.convertData(await res.text(), domainSecret)
    let json = JSON.parse(data)
    servers = json["Server"].slice(0, 4)
    // ...
}
convertData(input, secret) {
    let key = Convert.encodeUtf8(Convert.hexEncode(Convert.md5(Convert.encodeUtf8(secret))))
    let data = Convert.decodeBase64(input)
    let decrypted = Convert.decryptAesEcb(data, key)
    ... // 再截取 JSON
}
```
- 刷新时机：`init()` 中若 `refreshDomainsOnStart`（**默认 true**）则自动刷新；也可在设置里手动"Refresh Domain List"。
- 使用方式：`settings['apiDomain']`（1–4）→ `JM.apiDomains[index-1]` → `https://{domain}`。
- **注意**：主文件里**没有** `static apiDomains = [...]` 的定义（`get baseUrl()` 直接读 `JM.apiDomains`）。所以 `apiDomains` 完全依赖 `refreshApiDomains()` / `overwriteApiDomains(domains)` 赋值；失败时用 `fallbackServers`。这是一个**易踩的实现细节**（若刷新被墙且从未赋值，`baseUrl` 会是 `https://undefined`）。
- 图片域名另有轮换：`GET {baseUrl}/setting?app_img_shunt={1..4}&express=` → `img_host`，写入 `JM.imageUrl`；默认 `https://cdn-msp.jmapinodeudzn.net`。

### 6.2 紳士漫畫 wnacg —— 抓导航站首页提取链接
```js
let url = "https://wn01.link/"
let res = await fetch(url)
let document = new HtmlDocument(html)
let links = document.querySelectorAll("a[href]")
// 用正则 /^https?:\/\/([^\/]+)/ 提取域名，
// 排除 wn01.link / google.cn / cdn-cgi，去重
// 失败则回落到 Wnacg.domains（当前值），默认自定义域名 'wnacg.com'
```
刷新时机：`refreshDomainsOnStart` 默认 true。使用：`settings['domainSelection']`（0=自定义 `domain0`，1..N=抓取到的列表）。

### 6.3 拷贝漫画 —— 换的是"API 基址"
`GET https://api.copy-manga.com/api/v3/system/network2?platform=3` → `results.api[0][0]` 覆盖 `settings.base_url`。这是**权威 API 下发节点**，比抓网页可靠。

### 6.4 漫小肆 mxs —— 只有硬编码 7 个镜像，无自动轮换
见 §2.6。`domainCheck` 只是一个手动测延迟的 callback。

### 6.5 mh18 —— 单个可编辑域名字符串，默认 `18mh.org`，无镜像列表。

---

## 7. 是否使用公开聚合 API？

**没有。** 具体证据：

- **聚合搜索是本地并发**：`lib/pages/aggregated_search_page.dart` 读取 `appdata.settings['searchSources']`（用户勾选的源 key），对每个源各自调用其 JS 插件的 `searchPageData.load` / `loadNext`，在同一个滚动页面里**分段并排**显示（每个源一个 `_SliverSearchResult`）。没有任何中间服务器。
  来源：<https://raw.githubusercontent.com/venera-app/venera/master/lib/pages/aggregated_search_page.dart>
- **Headless 模式是本地 CLI，不是 HTTP API**：`venera --headless updatescript all` / `updatesubscribe` / `webdav up|down`，输出 `[CLI PRINT] {...}` JSON。**没有对外 HTTP 端点**。
  来源：<https://raw.githubusercontent.com/venera-app/venera/master/doc/headless_doc.md>、<https://raw.githubusercontent.com/venera-app/venera/master/lib/headless.dart>
- 逐源核查（jm/copy_manga/picacg/wnacg/manhuagui/mxs/mh18/hcomic/manhuaren/jcomic）：**均无第三方聚合/代理 API**，全部直连目标站点。

**唯一用到的"公开第三方端点"清单（都不是漫画聚合，而是基础设施/发现类）：**
| 用途 | 确切端点 | 出处 |
|---|---|---|
| 源列表分发（CDN） | `https://cdn.jsdelivr.net/gh/venera-app/venera-configs@main/index.json` | `lib/foundation/appdata.dart` |
| 每个插件的自更新 URL | `https://cdn.jsdelivr.net/gh/venera-app/venera-configs@main/{fileName}.js` | 各 JS 文件的 `url = ...` |
| JM 域名下发 | `https://rup4a04-c02.tos-cn-hongkong.bytepluses.com/newsvr-2025.txt`（base64+AES-ECB，密钥 `diosfjckwpqpdfjkvnqQjsik`） | `jm.js` |
| JM 图片分流 | `{baseUrl}/setting?app_img_shunt=N&express=` → `img_host` | `jm.js` |
| 拷贝 API 节点下发 | `https://api.copy-manga.com/api/v3/system/network2?platform=3` | `copy_manga.js` |
| 拷贝 request_id | `https://marketing.aiacgn.com/api/v2/adopr/query3/?format=json&ident=200100001` | `copy_manga.js` |
| 拷贝网页搜索 API 发现 | `https://www.copy20.com/search`（正则 `const countApi = "([^"]+)"`） | `copy_manga.js` |
| wnacg 域名发现 | `https://wn01.link/`（HTML 链接提取） | `wnacg.js` |
| AltStore 源 | `https://raw.githubusercontent.com/venera-app/venera/master/alt_store.json` | 仓库根 |
| PicACG 注册页 | `https://manhuabika.com/pregister/?` | `picacg.js` |
| 漫画柜参考图域名 | `https://us.hamreus.com` + `?e=&m=` | `manhuagui.js` |

---

## 8. 无法确认 / 明确不存在

| 项目 | 结论 |
|---|---|
| venera 使用 `/api/v2/comics/search?keyword=` | **源码中不存在**。venera 与 PicaComic 均为 `POST /comics/advanced-search?page=N`（body `{keyword, sort}`）。v2 接口族归属官方 2.x App/其他第三方 —— **未能确认**（无可引用来源） |
| PicACG 除 `apiKey` 外的全局 app token | **不存在**。`authorization` 来自 `/auth/sign-in` 返回的 `data.token` |
| 喵绅士 | **venera-configs 未收录**（`mxs.js` 是"漫小肆"，不同站点） |
| marc 之外的 HMAC 密钥字符串 | 已给出全部两处：PicACG HMAC key、copyManga base64 secret。其余 8 个中文源**无签名** |
| 独立第三方聚合 API | **不存在** |
| `manhuagui` 的 LZString/p.a.c.k.e.r 密钥 | 无独立密钥；LZString 用标准 `keyStrBase64`，packer 是 Dean Edwards 标准算法 |

---

## 9. 参考来源 URL（全部为源码/官方 API）

**引擎（venera-app/venera，master）**
- 仓库总览：<https://api.github.com/repos/venera-app/venera>
- 文件树：<https://api.github.com/repos/venera-app/venera/git/trees/master?recursive=1>
- `lib/network/app_dio.dart`：<https://raw.githubusercontent.com/venera-app/venera/master/lib/network/app_dio.dart>
- `lib/network/proxy.dart`：<https://raw.githubusercontent.com/venera-app/venera/master/lib/network/proxy.dart>
- `lib/network/cloudflare.dart`：<https://raw.githubusercontent.com/venera-app/venera/master/lib/network/cloudflare.dart>
- `lib/foundation/appdata.dart`：<https://raw.githubusercontent.com/venera-app/venera/master/lib/foundation/appdata.dart>
- `lib/foundation/consts.dart`：<https://raw.githubusercontent.com/venera-app/venera/master/lib/foundation/consts.dart>
- `lib/foundation/comic_source/comic_source.dart`：<https://raw.githubusercontent.com/venera-app/venera/master/lib/foundation/comic_source/comic_source.dart>
- `lib/pages/comic_source_page.dart`：<https://raw.githubusercontent.com/venera-app/venera/master/lib/pages/comic_source_page.dart>
- `lib/pages/aggregated_search_page.dart`：<https://raw.githubusercontent.com/venera-app/venera/master/lib/pages/aggregated_search_page.dart>
- `doc/js_api.md`：<https://raw.githubusercontent.com/venera-app/venera/master/doc/js_api.md>
- `doc/headless_doc.md`：<https://raw.githubusercontent.com/venera-app/venera/master/doc/headless_doc.md>
- `pubspec.yaml`：<https://raw.githubusercontent.com/venera-app/venera/master/pubspec.yaml>
- `alt_store.json`：<https://raw.githubusercontent.com/venera-app/venera/master/alt_store.json>

**源仓库（venera-app/venera-configs，main）**
- `index.json`：<https://raw.githubusercontent.com/venera-app/venera-configs/main/index.json>
- `jm.js`：<https://raw.githubusercontent.com/venera-app/venera-configs/main/jm.js>
- `picacg.js`：<https://raw.githubusercontent.com/venera-app/venera-configs/main/picacg.js>
- `copy_manga.js`：<https://raw.githubusercontent.com/venera-app/venera-configs/main/copy_manga.js>
- `wnacg.js`：<https://raw.githubusercontent.com/venera-app/venera-configs/main/wnacg.js>
- `manhuagui.js`：<https://raw.githubusercontent.com/venera-app/venera-configs/main/manhuagui.js>
- `mxs.js`：<https://raw.githubusercontent.com/venera-app/venera-configs/main/mxs.js>
- `mh18.js`：<https://raw.githubusercontent.com/venera-app/venera-configs/main/mh18.js>
- `hcomic.js`：<https://raw.githubusercontent.com/venera-app/venera-configs/main/hcomic.js>
- `manhuaren.js`：<https://raw.githubusercontent.com/venera-app/venera-configs/main/manhuaren.js>
- `jcomic.js`：<https://raw.githubusercontent.com/venera-app/venera-configs/main/jcomic.js>
- `_template_.js` / `_venera_.js`：<https://raw.githubusercontent.com/venera-app/venera-configs/main/_template_.js>

**交叉验证（同作者早期原生客户端）**
- `wgh136/PicaComic` `lib/network/picacg_network/headers.dart`：<https://raw.githubusercontent.com/wgh136/PicaComic/master/lib/network/picacg_network/headers.dart>
- `wgh136/PicaComic` `lib/network/picacg_network/methods.dart`：<https://raw.githubusercontent.com/wgh136/PicaComic/master/lib/network/picacg_network/methods.dart>

**生态/镜像信息（次要，搜索结果）**
- 后继仓库 venera-prime：<https://github.com/venera-app/venera-prime>（同一 org；`venera` 本体已 `archived: true`）
- 第三方 fork：<https://github.com/CyrilPeng/venera-next>
- 第三方哔咔客户端（可作 v2 接口参考候选）：<https://github.com/raoxwup/haka_comic>
