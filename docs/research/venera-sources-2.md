# Venera comic-source plugin facts: `manhuagui.js` and `mxs.js`

Sources (fetched with `web_fetch`, HTTP 200, full content, no truncation):
1. https://raw.githubusercontent.com/venera-app/venera-configs/main/manhuagui.js
2. https://raw.githubusercontent.com/venera-app/venera-configs/main/mxs.js

---

# File 1 — `manhuagui.js`

Source: https://raw.githubusercontent.com/venera-app/venera-configs/main/manhuagui.js

## Identity / constants

```js
class ManHuaGui extends ComicSource {
  name = "漫画柜";
  key = "ManHuaGui";
  version = "1.2.1";
  minAppVersion = "1.4.0";
  url = "https://cdn.jsdelivr.net/gh/venera-app/venera-configs@main/manhuagui.js";
  baseUrl = "https://www.manhuagui.com";
```

Also: `account.registerWebsite = "https://www.manhuagui.com/user/register"`.
No `settings` object: not present. No static API/URL constant other than `baseUrl`; the image host is hardcoded inline (see below).

## Search endpoint — HTML-scraped, GET, no body

```js
load: async (keyword, options, page) => {
  let url = ""
  if (options[0]) {
    let type = options[0].split("-")[0];
      if (type == '0') {
          url = `${this.baseUrl}/s/${keyword}_p${page}.html`;
      } else{
        url = `${this.baseUrl}/s/${keyword}_o${type}_p${page}.html`;
      }
  }else{
      url = `${this.baseUrl}/s/${keyword}_p${page}.html`;
  }
  let document = await this.getHtml(url);
```

- Method: **GET** (`Network.get` inside `getHtml`). No POST, no JSON body, no query params — the keyword is **raw-interpolated, not URL-encoded**.
- URL templates:
  - sort `0` / no option: `https://www.manhuagui.com/s/{keyword}_p{page}.html`
  - other sort: `https://www.manhuagui.com/s/{keyword}_o{type}_p{page}.html`
- Options:
```js
optionList: [
  {
    type: "select",
    options: ["0-最新更新", "1-最近最热","2-最新上架", "3-评分最高"],
    label: "sort",
    default: null,
  },
],
enableTagsSuggestions: false,
```
- Page convention: directly substituted as `_p{page}` → **1-based page number in the path**. Result count:
```js
let comicNum = resultCount.querySelectorAll("strong")[1].text;
comicNum = parseInt(comicNum);
// 每页10个
let maxPage = Math.ceil(comicNum / 10);
```
- Results parsed from `.book-result ul` → `li.cf`, each via `parseSearchComic` (selectors: `.book-detail dl dt a`, `.book-cover .bcover img`, `.tags.status span .red`, `.tags.status span .red:nth-child(2)`, `.book-score .score-avg strong`, `.tags a[href*='/author/']`, `.tags a[href*='/list/']`, `.intro span`).

## Headers actually sent on search (and all HTML GETs)

Search reuses `getHtml`; note the **absence of any User-Agent header** here:

```js
async getHtml(url) {
    let mhg_cookie = this.loadData("mhg_cookie");
    let headers = {
      accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
      "cache-control": "no-cache",
      pragma: "no-cache",
      priority: "u=0, i",
      "sec-ch-ua":
        '"Microsoft Edge";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "same-origin",
      "sec-fetch-user": "?1",
      "upgrade-insecure-requests": "1",
      Referer: "https://www.manhuagui.com/",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      cookie: mhg_cookie
    };
    let res = await Network.get(url, headers);
```

No Origin, no User-Agent, no API key/token/signature/nonce/time headers. `cookie` is `undefined` unless logged in.

## Additional endpoints

**Login** — POST form:
```js
let headers = {
  'content-type': 'application/x-www-form-urlencoded',
  'accept': 'application/json, text/javascript, */*; q=0.01',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  'cache-control': 'no-cache',
  'pragma': 'no-cache',
  'x-requested-with': 'XMLHttpRequest',
  'origin': this.baseUrl,
  'referer': `${this.baseUrl}/`,
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
};
let body = `txtUserName=${encodeURIComponent(username)}&txtPassword=${encodeURIComponent(password)}`;
let res = await Network.post(`${this.baseUrl}/tools/submit_ajax.ashx?action=user_login`, headers, body);
```
Extracts the `my=` cookie via `cookie.match(/my=([^;]+)/)` and stores `this.saveData('mhg_cookie', "my="+myCookie)`. `logout` = `this.deleteData('mhg_cookie')`.

**Comic info** — GET `https://www.manhuagui.com/comic/{id}/` (HTML). Selectors: `.book-cont`, `.book-title h1`, `.book-title h2`, `.hcover img`, `#intro-all p`, `.detail-list span` (indices 0=年代, 1=地区, 3=类型, 4=作者, 7=状态, 8=更新时间), `.similar-list li`. Adult-gate path: if `#checkAdult` and `#__VIEWSTATE` exist, `decodeViewState` = `LZString.decompressFromBase64(viewStateValue)` and the decoded HTML is re-parsed for `.chapter`.

**Chapter images** — GET `https://www.manhuagui.com/comic/{comicId}/{epId}.html`, then the 5th `<script>` (`document.querySelectorAll("script")[4].innerHTML`) is unpacked:
```js
let imgDomain = `https://us.hamreus.com`;
let images = [];
for (let f of infos.files) {
  let imgUrl =
    imgDomain + infos.path + f + `?e=${infos.sl.e}&m=${infos.sl.m}`;
  images.push(imgUrl);
}
```
`infos` comes from `this.getImgInfos(script)` → `extractParams` (splits on `"}("` / `"))"`, param index 3 is LZString-base64 decompressed and split on `"|"`) → `formatData(...params)` (classic Dean Edwards p.a.c.k.e.r unpacker) → `extractFields` (regexes `/"files":\s*\[(.*?)\]/`, `/"path":\s*"([^"]+)"/`, `/"len":\s*(\d+)/`, `/"sl":\s*({[^}]+})/`).

**Comments list** — GET (JSON):
```js
let url = `${this.baseUrl}/tools/submit_ajax.ashx?action=comment_list&book_id=${comicId}&page_index=${page}`;
```
Headers: `accept: "application/json, text/javascript, */*; q=0.01"`, `accept-language: "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6"`, `cache-control: no-cache`, `pragma: no-cache`, `sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform`, `sec-fetch-dest: "empty"`, `sec-fetch-mode: "cors"`, `sec-fetch-site: "same-origin"`, `x-requested-with: "XMLHttpRequest"`, `Referer: ${this.baseUrl}/comic/${comicId}/`, `Referrer-Policy: "strict-origin-when-cross-origin"`. Page size 10 (`Math.ceil(data.total / 10)`). Comment id format `${comment.id}//${page}`; default avatar `https://cf.mhgui.com/images/default.png`.

**Send comment** — POST `.../tools/submit_ajax.ashx?action=comment_add`, headers add `cookie: mhg_cookie`, `dnt:1`, `origin: 'https://www.manhuagui.com'`, `'content-type': 'application/x-www-form-urlencoded; charset=UTF-8'`; body:
```js
bodyParams += `book_id=${comicId}&`;
// double-encode to match site submission behaviour
bodyParams += `txtContent=${encodeURIComponent(encodeURIComponent(content))}&`;
if (replyTo) {
    bodyParams += `to_comment_id=${replyTo.split('//')[0]}`;
}else{
    bodyParams += `to_comment_id=0`;
}
```

**Categories / ranking** (HTML):
- `categoryComics.load`: `${this.baseUrl}/list/${params}/${sort}_p${page}.html` where `params = [area, genre, age, status].filter(e => e != "").join("_")`; comics from `#contList > li`; maxPage from `.result-count strong[1]`.
- Ranking URL: `` `${this.baseUrl}/list/${option}_p${page}.html` `` with options `["-最新发布","update-最新更新","view-人气最旺","rate-评分最高"]`; comics from `#contList li` (via `parseComic`).
- Genre list `categories` + parallel `categoryParams` (39 pairs: `""`, `rexue`, `maoxian`, …, `heidao`). `enableRankingPage: false` on `category`, but `ranking` object is present.

**Favorites** (HTML): GET `${this.baseUrl}/user/book/shelf/${page}`, selectors `.dy_content_li`, `.dy_img a`, `.dy_r h3 a`, `.dy_r p`, `.flickr.right span` (regex `/共(\d+)记录/`, page size 20). Add: POST `${this.baseUrl}/tools/submit_ajax.ashx?action=user_book_shelf_add` with `book_id=${encodeURIComponent(comicId)}`; removal throws `'暂不支持取消收藏'`.

## Image / thumbnail headers (verbatim)

```js
onImageLoad: (url, comicId, epId) => {
  return {
    headers: {
      accept:
        "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8,en-GB;q=0.7,en-US;q=0.6",
      "cache-control": "no-cache",
      pragma: "no-cache",
      priority: "i",
      "sec-ch-ua":
        '"Microsoft Edge";v="137", "Chromium";v="137", "Not/A)Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "image",
      "sec-fetch-mode": "no-cors",
      "sec-fetch-site": "cross-site",
      "sec-fetch-storage-access": "active",
      Referer: "https://www.manhuagui.com/",
      "Referrer-Policy": "strict-origin-when-cross-origin",
    },
  };
},
```
`onThumbnailLoad` returns a similar object but `sec-fetch-dest: "document"`, `sec-fetch-mode: "navigate"`, `sec-fetch-site: "none"`, `sec-fetch-user: "?1"`, `upgrade-insecure-requests: "1"`, `priority: "u=0, i"`, and **no Referer**. Neither image header set contains Origin, Cookie, User-Agent, Host, API key, token, signature, nonce, or time header.

## Signing / hashing / encryption

- Request signing/hashing: **not present**. No MD5/SHA/HMAC, no key string, no nonce/time headers.
- Response encryption: **not present** as crypto. The only encoding layers are (a) the p.a.c.k.e.r-packed inline `<script>` for chapter images and (b) LZString `decompressFromBase64` (`keyStrBase64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="`) used for `#__VIEWSTATE` (adult chapter list) and inside `extractParams`.
- Image URLs carry `?e={infos.sl.e}&m={infos.sl.m}` tokens read straight out of the page's packed script — no client-side computation.

## Domain mirror rotation / fallbacks

- **Not present.** Single hardcoded `baseUrl = "https://www.manhuagui.com"`; no domain list, no remote list URL, no rotation logic. The image host `https://us.hamreus.com` is a hardcoded inline literal.
- Site is HTML-scraped (not JSON API), except the `submit_ajax.ashx` JSON endpoints listed above.

## Aggregation API / third-party proxy

**Not present.** No aggregation or proxy endpoint; only `www.manhuagui.com` plus the `us.hamreus.com` image CDN.

---

# File 2 — `mxs.js`

Source: https://raw.githubusercontent.com/venera-app/venera-configs/main/mxs.js

## Identity / constants

```js
class MXS extends ComicSource {
    // 漫画源基本信息
    name = "漫小肆";
    key = "mxs";
    version = "1.0.0";
    minAppVersion = "1.5.0";
    url = "https://cdn.jsdelivr.net/gh/venera-app/venera-configs@main/mxs.js";
```

- No static `baseUrl` constant; it is a **setting getter**:
```js
get baseUrl() {
    return this.loadSetting("domains");
}
```
- No `account`/login: **not present**. No `favorites`: **not present**. No `apiUrl`: not present.

## Domain list — hardcoded in `settings`, not fetched

```js
settings = {
    // 域名选择功能
    domains: {
        title: "选择域名",
        type: "select",
        options: [
            { value: "https://www.mxshm.top", text: "mxshm.top" },
            { value: "https://www.jjmhw1.top", text: "jjmhw1.top" },
            { value: "https://www.jjmh.top", text: "jjmh.top" },
            { value: "https://www.jjmh.cc", text: "jjmh.cc" },
            { value: "https://www.wzd1.cc", text: "wzd1.cc" },
            { value: "https://www.wzdhm1.cc", text: "wzdhm1.cc" },
            { value: "https://www.ikanwzd.cc", text: "ikanwzd.cc" }
        ],
        default: "https://www.mxshm.top"
    },
```
- Source of the list: **hardcoded in the file**; no remote URL, no parsing, no regex. User picks one via the `select` setting; `loadSetting("domains")` yields the chosen value (default `https://www.mxshm.top`).
- `domainCheck` is a `callback` setting button ("检测") that does `Network.get(currentDomain)` with a 10 s `setTimeout` and reports latency or `❌ 连接失败，可能需要 🚀`. No automatic rotation.

## Search endpoint — HTML-scraped, GET, no body, no pagination

```js
search = {
    // 搜索漫画
    load: async (keyword, options, page) => {
        const url = `${this.baseUrl}/search?keyword=${encodeURIComponent(keyword)}`;
        const doc = await this.fetchDocument(url);
        const comics = this.parseComicList(doc.querySelectorAll(".mh-item"));
        
        doc.dispose();
        return {
            comics: comics,
            maxPage: 1
        };
    },
    enableTagsSuggestions: false
};
```
- Method: GET. Query param: `keyword` (URL-encoded via `encodeURIComponent`). No POST body, no JSON.
- Page convention: **no page parameter at all**; `page` is ignored and `maxPage: 1` is always returned.
- No `optionList` for search: **not present**.

## Headers sent (all requests)

```js
async fetchDocument(url) {
    const res = await Network.get(url, {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    });
    
    if (res.status !== 200) {
        throw `请求失败: ${res.status}`;
    }
    
    return new HtmlDocument(res.body);
}
```
Only `User-Agent` on both search and image requests. **No Referer, Origin, Host, Accept, Cookie, API key, token, signature, nonce, or time header** anywhere in the file. (`Network.get(currentDomain)` in `domainCheck` passes no headers at all.)

## Additional endpoints (all GET + HTML)

| Purpose | URL |
|---|---|
| Explore | `this.baseUrl` (homepage) |
| Recently updated | `` `${this.baseUrl}/update?page=${page}` `` |
| Ranking | `` `${this.baseUrl}/rank` `` (no pagination) |
| Category/tag | `` `${this.baseUrl}/booklist?tag=${encodeURIComponent(tag)}&area=${area}&end=${end}&page=${page}` `` |
| Comic info | `` `${this.baseUrl}/book/${id}` `` |
| Chapter images | `` `${this.baseUrl}/chapter/${epId}` `` |
| Comments | `` `${this.baseUrl}/book/${comicId}` `` (comments scraped from the detail page — no dedicated comments API) |

Ranking options (from `optionLoader`): `["new-新书榜","popular-人气榜","end-完结榜","recommend-推荐榜"]`, mapped by `{"new":"新书榜","popular":"人气榜","end":"完结榜","recommend":"推荐榜"}` and matched against `.mh-list.col3.top-cat li` → `.title`. Category options: 地区 `["-全部","1-韩国","2-日本","3-台湾"]`, 状态 `["-全部","0-连载","1-完结"]`; defaults `area = options[0] || "-1"`, `end = options[1] || "-1"`.

Key selectors: covers are constructed, not scraped — `` `${this.baseUrl}/static/upload/book/${id}/cover.jpg` ``. Chapters: `#detail-list-select li a` (`chapterId = chapterUrl.split("/").pop()`). Comments: `.view-comment-main .postlist li.dashed`. Max page: `.pagination a[href*='page=']` with `/page=(\d+)/`.

**Chapter images** (host is rewritten to the selected mirror):
```js
const imageElems = doc.querySelectorAll("img.lazy");
for (let img of imageElems) {
    const src = img.attributes?.["data-original"];
    const image = src.replace(/https?:\/\/[^\/]+/, this.baseUrl);
    if (image) images.push(image);
}
```
If `images.length === 0` it throws `"本章中未找到图片"`.

## Signing / hashing / encryption / response encryption

- Request signing, hashing, key strings, nonce, time headers: **not present**.
- Response encryption/decryption: **not present** — plain HTML parsed with `new HtmlDocument(res.body)`.
- No LZString, no packer unpacking, no crypto.

## Aggregation API / third-party proxy

**Not present.** All requests go directly to the mirror chosen in `settings.domains`.

---

## Cross-file summary

| Item | manhuagui.js | mxs.js |
|---|---|---|
| class / name / key | `ManHuaGui` / 漫画柜 / `ManHuaGui` | `MXS` / 漫小肆 / `mxs` |
| version / minAppVersion | `1.2.1` / `1.4.0` | `1.0.0` / `1.5.0` |
| base URL | constant `https://www.manhuagui.com` | `settings.domains` (7 hardcoded mirrors, default `https://www.mxshm.top`) |
| search | GET `/s/{keyword}_p{page}.html` or `/s/{keyword}_o{sort}_p{page}.html`, 1-based `page`, 10/page | GET `/search?keyword=…`, no page |
| POST body for search | none | none |
| signing / crypto | none (LZString decode + p.a.c.k.e.r unpack only) | none |
| encrypted responses | no | no |
| aggregation API / proxy | not present | not present |
| comments | JSON AJAX `submit_ajax.ashx?action=comment_list/comment_add` | scraped from detail page |
| login | `submit_ajax.ashx?action=user_login`, `my=` cookie | not present |
| image host | `https://us.hamreus.com` + `?e=…&m=…` | mirror host rewrite from `data-original` |
