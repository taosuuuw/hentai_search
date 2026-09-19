# Venera comic-source extraction report

Sources (raw URLs, fetched with `web_fetch`, HTTP 200, complete — no truncation):

1. https://raw.githubusercontent.com/venera-app/venera-configs/main/hcomic.js
2. https://raw.githubusercontent.com/venera-app/venera-configs/main/manhuaren.js
3. https://raw.githubusercontent.com/venera-app/venera-configs/main/mh18.js
4. https://raw.githubusercontent.com/venera-app/venera-configs/main/jcomic.js

Global note: **none** of the four files contains request signing, HMAC/hash, API keys, tokens, nonces, or timestamp signatures. No third-party aggregation API or proxy is used by any of them.

---

## 1. hcomic.js

### Identity
| field | value |
|---|---|
| class | `HComic extends ComicSource` |
| `name` | `"H-Comic"` |
| `key` | `"hcomic"` |
| `version` | `"1.0.0"` |
| `minAppVersion` | `"1.6.0"` |
| `url` | `"https://cdn.jsdelivr.net/gh/venera-app/venera-configs@main/hcomic.js"` |
| base URL constant | `baseUrl = "https://h-comic.com"` (plain instance field) |
| second hardcoded host | `https://h-comic.link` (image API, appears only inside `comic.loadInfo` / `loadEp`) |

### Search endpoint
HTML-scraped (SvelteKit), **not** a JSON API. HTTP **GET**.

```js
load: async (keyword, options, page) => {
    // Placeholder for search
    let url = `${this.baseUrl}/?q=${encodeURIComponent(keyword)}&tag=&page=${page}`;
    let html = await this.getHtml(url);
```

- Full template: `https://h-comic.com/?q=<encodeURIComponent(keyword)>&tag=&page=<page>`
- Query params: `q` (encoded keyword), `tag` (always empty string for search), `page`
- **No POST body.**
- Page numbering: **1-based** (`page` interpolated directly; default page 1).
- `maxPage` from `extractMaxPage`: regex `/name="page"[^>]*max="(\d+)"/`, else `1`.

### Parsing (HTML scraping, exact mechanics)
```js
let match = html.match(/data:\s*\[null,\s*(\{[\s\S]*?\})\s*\]\s*,\s*form:/);
```
Then unquoted-key repair + `JSON.parse`, fallback `new Function("return " + jsonStr)`:
```js
let fixedJsonStr = jsonStr.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":');
```
No CSS selectors are used in this file (no `querySelector`).

### Headers
Only one helper, used for **all** HTML requests (search, explore, category, comic info):
```js
async getHtml(url) {
    let res = await Network.get(url, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
```
No Referer, Origin, Host, cookie, token, or signature headers.

### Additional endpoints
- Explore: GET `https://h-comic.com` (homepage).
- Category list: GET `` `${this.baseUrl}${path}?page=${page}&q=` `` where `path` is `"/random"` (sort option `random-随机刷新`) or `"/"` (`latest-最近更新`), then `&tag=<encodeURIComponent(param)>` or `&tag=`.
- Comic info: GET `` `${this.baseUrl}/comics/${encodeURIComponent(title_temp)}/1?id=${realId}` `` — id is stored as `` `${c.id}|${title}` ``, split on `|`, default title segment `"view"`.
- Chapter (single-chapter source): chapter id encodes `` `${c.comic_source}|${c.media_id}|${c.num_pages}` `` and images are built as
```js
images.push(`https://h-comic.link/api/${source}/${mediaId}/pages/${i}`);
```
  Cover fallback: `` `https://h-comic.link/api/${c.comic_source}/${c.media_id}/pages/1` ``
- Categories / ranking / comments / login: `enableRankingPage: false`, ranking stub `return { comics: [], maxPage: 0 }`; comments and login **not present**.

### Image request headers
`comic.onImageLoad` / `onThumbnailLoad` are **not present** → image requests carry no custom headers from this plugin. Images are absolute `h-comic.link` URLs returned directly.

### Signing / encryption
- Signing/hashing: **not present**.
- Encryption: **not present**. The response is ordinary HTML containing a JS object literal, which the plugin extracts with the regex above and parses as JS.

### Domain mirror rotation
- **Not present.** Single hardcoded `baseUrl = "https://h-comic.com"` plus the separate hardcoded image host `https://h-comic.link`.
- Link handling: `link: { domains: ['h-comic.com'], linkToId: ... }` with regexes `/id=(\d+)/` and `/\/comics\/([^/]+)/`.

### Aggregation / proxy
**Not present** (no third-party API). `h-comic.link` is the site's own image API host, used directly for chapter image URLs.

---

## 2. manhuaren.js

### Identity
| field | value |
|---|---|
| class | `ManHuaRen extends ComicSource` |
| `name` | `"漫画人"` |
| `key` | `"manhuaren"` |
| `version` | `"1.0.0"` |
| `minAppVersion` | `"1.6.0"` |
| `url` | `"https://cdn.jsdelivr.net/gh/venera-app/venera-configs@main/manhuaren.js"` |
| base URL | getter: `get baseUrl() { return "https://www.manhuaren.com"; }` |

### Search endpoint
HTML-scraped **GET**, no body:
```js
let url = `${this.baseUrl}/search?title=${encodeURIComponent(keyword)}&language=1&page=${page}`;

let res = await Network.get(url, this._buildHeaders());
```
- Full template: `https://www.manhuaren.com/search?title=<encodeURIComponent(keyword)>&language=1&page=<page>`
- Params: `title`, `language=1`, `page`
- Page numbering: **1-based** (`page` passed through unchanged).
- `maxPage`: `let maxPage = comics.length > 0 ? page + 1 : page;` (no real last-page detection).

### Search request headers (exact object)
```js
_buildHeaders() {
    return {
        'user-agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
        'accept': '*/*',
        'accept-encoding': 'gzip, deflate, br, zstd',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'sec-ch-ua': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"',
        'host': 'www.manhuaren.com'
    }
}
```

### Search result parsing (CSS selectors)
`new HtmlDocument(res.body)`; container `.book-list > li`; link `item.querySelector('.book-list-info > a')` (href used **as the comic id**, made absolute); title `.book-list-info-title`; cover `.book-list-cover-img` (`src`, `//` prefixed → `https:`); desc `.book-list-info-desc`; tags `.book-list-info-bottom-item`; status `.book-list-info-bottom-right-font`.

### Additional endpoints
- Explore: GET `https://www.manhuaren.com/` with `_buildHeaders()`; selectors `.index-banner li`, `.manga-list`, `.manga-list-title`, `.manga-list-2-title`, `.manga-list-1-tip`, `.manga-list-2-tip`, `.manga-list-1-cover-logo-font`.
- Category list: **POST** `application/x-www-form-urlencoded`:
```js
let res = await Network.post(url, categoryHeaders, body);
```
  URL: `` `${this.baseUrl}/${path}/dm5.ashx` `` with `path` = `manhua-list` + optional `-tag<tag>` + `-<statusOpt>` + `-<sortOpt>` (e.g. `manhua-list-tag31-st1-s2`).
  Exact body:
```js
let body = `action=getclasscomics&pageindex=${pageIndex}&pagesize=${pageSize}&categoryid=0&tagid=${encodeURIComponent(tagId)}&status=${statusNum}&usergroup=0&pay=-1&areaid=0&sort=${sortNum}&iscopyright=0`;
```
  with `let pageIndex = Math.max(0, (parseInt(page) || 1));`, `let pageSize = 21;`, `tagId` default `'0'`, `statusNum` from option `st(\d+)`, `sortNum` from option `s(\d+)`. Category response is JSON: `data.UpdateComicItems`, `data.Count`; `maxPage` computed as `Math.ceil(total / perPage) + 1`.
  Category headers: `accept: application/json, text/javascript, */*; q=0.01`, `content-type: application/x-www-form-urlencoded; charset=UTF-8`, `host: www.manhuaren.com`, `origin: <baseUrl>`, `referer: <baseUrl>/<path>/`, `x-requested-with: XMLHttpRequest`, plus accept-encoding/language/cache-control/connection/pragma/sec-fetch-* and iPhone Safari UA `Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1`.
- Comic info: GET `<id>` (absolute-ized: `/x` → `baseUrl + x`) with `_buildHeaders()`. Selectors `p.detail-main-info-title`, `span.normal-top-title`, `.detail-main-cover img`, `.detail-main-cover .cover-img img`, `.detail-main-info-author a`, `meta[name="Author"]`, `.detail-list-title-1` (status), `.detail-desc`, `meta[name="Description"]`, `.detail-main-info-class a`, `.detail-list-title-3` (updateTime), `.detail-main-info-star` with `class.match(/star-(\d+)/i)`, `.detail-selector .detail-selector-item` + `onclick.match(/titleSelect\(.*?,.*?, *['"](.*?)['"]\)/)`, `a.chapteritem`. Recommended list parsed by regex:
```js
let recPattern = /<li[^>]*class=["'][^"']*(?:list-comic|rec|recommend)[^"']*["'][^>]*>[\s\S]*?<a[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<img[^>]*src=["']([^"']+)["'][^>]*>[^<]*<\/a>[\s\S]*?<a[^>]*>\s*([^<]+)\s*<\/a>/gi;
```
  `mid` extracted with, in order: `/mid["\s:]*(\d+)/i`, `/var mid = (\d+)/i`, `/mid=(\d+)/i`, `/var DM5_MID = (\d+)/i`, `/var COMIC_MID=(\d+)/i`; `subId` = `mid` or `'73225'`.
- Chapter images: GET `` `${epId}/` `` (epId is an absolute chapter URL) with `_buildHeaders()`.
- Comic comments: GET `` `${this.baseUrl}/manhua-${comicId}/pagerdata.ashx?d=${Date.now()}&pageindex=${requestPage - 1}&pagesize=767&mid=${subId}&t=4` `` — comment pagination is **0-based**. Headers: `host`, `referer: <baseUrl>/manhua-<comicId>/`, `x-requested-with: XMLHttpRequest`, Android UA as above.
- Chapter comments: GET `` `https://www.manhuaren.com/showcomment/pagerdata.ashx?d=${Date.now()}&pageindex=${requestPage}&pagesize=20&cid=${cid}&t=9` `` — 1-based. `cid` from `epId.match(/m(\d+)/)` else `/(\d+)\/?$/`. Referer `https://www.manhuaren.com/showcomment/?cid=<cid>`, iPhone UA.
- Login: **not present** (`likeComic` is an empty stub).

### Image request headers (exact object)
```js
return {
    'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    //'Host': host || '',
    'Pragma': 'no-cache',
    'Referer': referer || (this.baseUrl + '/'),
    'Sec-Fetch-Dest': 'image',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'cross-site',
    'Sec-Fetch-Storage-Access': 'active',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36',
    'sec-ch-ua': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
    'sec-ch-ua-mobile': '?1',
    'sec-ch-ua-platform': '"Android"'
}
```
`Host` is **commented out** (host computed but unused). `Referer` = chapter URL when absolute, else `baseUrl + epId`, else `baseUrl + '/'`. `onThumbnailLoad` uses referer `baseUrl + '/'`.

### Encryption / obfuscation (present — Dean Edwards packer)
`loadEp` finds a `<script>` whose `innerHTML.includes('eval(function(p,a,c,k,e,d)')` and unpacks it with this exact function:
```js
let decrypt = (p, a, c, k) => {
    let e = (c) => (c < a ? '' : e(parseInt(c / a))) + ((c = c % a) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
    let d = {};
    while (c--) d[e(c)] = k[c] || e(c);
    return p.replace(/\b\w+\b/g, w => d[w] || w);
};
```
Parameter extraction: `script.indexOf("}('") + 3`, boundary `script.substring(pStart).match(/',(\d+),(\d+),'/)`, key dict `script.substring(kContentStart, kEnd).split('|')` where `kEnd = script.indexOf("'.split", kContentStart)`. Images from `decrypted.match(/\[(.*?)\]/)` split on `,`, quotes stripped, filtered to `startsWith('http')`. No key strings or auth tokens are involved.

### Domain mirror rotation
**Not present.** Single hardcoded base URL. No domain list, no fallback domains.

### Aggregation / proxy
**Not present.**

---

## 3. mh18.js

### Identity
| field | value |
|---|---|
| class | `MH18 extends ComicSource` |
| `name` | `"18漫画"` |
| `key` | `"mh18"` |
| `version` | `"1.0.0"` |
| `minAppVersion` | `"1.4.0"` |
| `url` | `"https://cdn.jsdelivr.net/gh/venera-app/venera-configs@main/mh18.js"` |
| base URL | getter from user setting: `return \`https://${this.loadSetting("domains")}\`;` |
| setting | `settings = { domains: { title: "域名", type: "input", default: "18mh.org" } }` |

### Search endpoint
HTML-scraped **GET**, **no custom headers** (note: it does *not* pass `this.headers`):
```js
load: async (keyword, options, page) => {
  const res = await Network.get(`${this.baseUrl}/s/${keyword}?page=${page}`);
```
- Full template: `https://<domains>/s/<keyword>?page=<page>` — keyword is **not** URL-encoded.
- Params: `page`
- Page numbering: **1-based**.
- `maxPage`: `parseInt(document.querySelectorAll("button.text-small").pop().text.replaceAll("\n", "").replaceAll(" ", ""))`, `catch → 1`.

### Result parsing (selectors)
```js
for (let item of doc.querySelectorAll(".pb-2")) {
  result.push(new Comic({
    id: item.querySelector("a").attributes["href"],
    title: item.querySelector("h3").text,
    cover: item.querySelector("img").attributes["src"]
  }))
}
```

### Headers (exact object)
```js
get headers() {
    return {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0",
      "Referer": this.baseUrl
    };
}
```
No Origin, Host, token, cookie or signature headers. Image requests: `onThumbnailLoad` returns `{ headers: this.headers }`; **`onImageLoad` is not present**.

### Additional endpoints
- Explore: GET `this.baseUrl` with `this.headers`; selectors `.pb-unit-md .slicarda`, `.cardlist`, `.hometitle h2`.
- Category list: GET `` `${this.baseUrl}${params}/page/${page}` `` with `this.headers`; `maxPage` parsed from last `button.text-small`. Category params are paths like `/manga`, `/manga-genre/hanman`, `/manga-tag/duoren`.
- Comic info: GET `id` (prefixed with `this.baseUrl` when relative) — **no headers**. Selectors `.text-xl` (title, `.split("   ")[0]`), `.object-cover` (`src`), `p.text-medium` (description), `div.py-1` (per-index: `a > span` → 作者, `a > span` → 类型, `a` → 标签, `#`/spaces stripped), `#mangachapters` attribute `data-mid`, recommends `div.cardlist > div.pb-2`.
- Chapter list: GET `` `${this.baseUrl}/manga/get?mid=${mangaId}&mode=all&t=${Date.now()}` `` with `this.headers`; parses `.chapteritem` → `a[data-ms]@a[data-cs]` as id, `.chaptertitle` as title.
- Chapter images: GET `` `${this.baseUrl}/chapter/getcontent?m=${ids[0]}&c=${ids[1]}` `` with `this.headers`; images from `#chapcontent img`, preferring attribute `data-src` over `src`.
- Ranking/comments/login: `enableRankingPage: false`; ranking, comments and login **not present**.

### Signing / encryption
**Not present.** No keys, hashes, or encrypted responses. (`t=${Date.now()}` is a plain cache-buster, not a signature.)

### Domain mirror rotation
- **No rotation and no domain list.** One user-editable single domain string; `baseUrl` = `https://` + setting value; hardcoded **fallback/default domain: `"18mh.org"`**. No fetching of a mirror list from any URL.

### Aggregation / proxy
**Not present.**

---

## 4. jcomic.js

### Identity
| field | value |
|---|---|
| module const | `const JCOMIC_BASE = "https://jcomic.net";` |
| module const | `const JCOMIC_REFERER = JCOMIC_BASE + "/";` |
| class | `JComic extends ComicSource` |
| `name` | `"jcomic.net"` |
| `key` | `"jcomic"` |
| `version` | `"1.0.0"` |
| `minAppVersion` | `"1.4.6"` |
| `url` | `"https://cdn.jsdelivr.net/gh/venera-app/venera-configs@main/jcomic.js"` |
| base URL helper | `_buildUrl(path)` prepends `JCOMIC_BASE` unless the path already starts with `http://`/`https://` |

### Search endpoint
HTML-scraped **GET**, one header only:
```js
const encoded = encodeURIComponent(kw);
const path = page === 1 ? `/search/${encoded}` : `/search/${encoded}/${page}`;
const url = this._buildUrl(path);

const resp = await Network.get(url, { referer: JCOMIC_REFERER });
```
- Full templates: `https://jcomic.net/search/<encodeURIComponent(keyword)>` (page 1) and `https://jcomic.net/search/<encodeURIComponent(keyword)>/<page>` (page > 1)
- Query params: **none** — pagination is a path segment.
- **No POST body.**
- Page numbering: **1-based**, and **page 1 omits the `/<page>` segment** (`if (!page) page = 1;`). Empty keyword returns `{ comics: [], maxPage: 1 }` without a request.
- `maxPage`: `parseMaxPage(doc)` — `ul.pagination` → all `a`, `parseInt(a.text.trim(), 10)`, max (default `1`).

### Result parsing (selectors)
```js
const cards = doc.querySelectorAll(
  'div.row.col-lg-4.col-md-6.col-xs-12, div.row.col-md-6.col-xs-12'
);
```
Per card: link `a[href^="/eps/"], a[href^="/page/"]` (id = 2nd path segment, `decodeURIComponent`), cover `img.comic-thumb` (`src`), title `p.comic-title` trimmed by `trimTitle` (cuts at last `" ("`), authors `a[href^="/author/"] button`, tags `a[href^="/cat/"] button` (fallback `a[href^="/cat/"]` text), date `p.comic-date`. `language: "zh-Hant"`.

### Headers
Search/explore/category/info/chapter requests: **only** `{ referer: JCOMIC_REFERER }` i.e. `referer: "https://jcomic.net/"`. No User-Agent, Origin, Host, token, or signature.
Image requests:
```js
onImageLoad: (url, comicId, epId) => { return { url, headers: { referer: JCOMIC_REFERER } }; },
onThumbnailLoad: (url) => { return { url, headers: { referer: JCOMIC_REFERER } }; },
```

### Additional endpoints
- Explore: `type: "multiPageComicList"`, category `最近更新` → `/cat/<encodeURI("最近更新")>` (page 1) or `/cat/<...>/<page>`.
- Category list: `/cat/<encodeURI(param)>` or `/cat/<encodeURI(param)>/<page>`, same headers; `optionList: []`, `ranking: null`.
- Comic info: GET `https://jcomic.net/eps/<encodeURI(id)>`; info block `div.row.col-md-6.col-xs-12`; title `p.comic-title` (total pages from `/\((\d+)\)/` on the raw title); cover `img.comic-thumb`; authors/categories as above; chapters from `a[href^="/page/"]` filtered by `parseIdFromHref(href) === id`, ep id = 3rd path segment.
- Chapter images: GET `https://jcomic.net/page/<encodeURI(comicId)>` + (`/<encodeURIComponent(epId)>` when epId present); images from `img.comic-thumb` `src`.
- Ranking / comments / login: **not present**.
- Link handling: `link: { domains: ["jcomic.net"], linkToId: url => /https?:\/\/jcomic\.net\/(?:eps|page)\/([^\/?#]+)(?:\/[^\/?#]+)?/ }`.

### Signing / encryption
**Not present** — no keys, hashes, tokens, or encrypted/decrypted responses.

### Domain mirror rotation
**Not present.** Hardcoded single base `https://jcomic.net`; no domain list, no fallback domains.

### Aggregation / proxy
**Not present.**

---

## Cross-file summary

| | hcomic | manhuaren | mh18 | jcomic |
|---|---|---|---|---|
| search method | GET (HTML) | GET (HTML) | GET (HTML) | GET (HTML) |
| search page base | 1 | 1 | 1 | 1 (path segment, absent on p1) |
| search headers | UA only | 10 headers incl. `host` | **none** | `referer` only |
| keyword encoding | `encodeURIComponent` | `encodeURIComponent` | none | `encodeURIComponent` |
| POST anywhere | no | yes (`dm5.ashx`, form-urlencoded) | no | no |
| signing / keys / tokens | no | no | no | no |
| encrypted payload | no (JS literal regex + eval fallback) | yes (packer unpack in `loadEp`) | no | no |
| domain list / rotation | no | no | single user setting, default `18mh.org` | no |
| third-party API/proxy | no (`h-comic.link` is the site's own image API) | no | no | no |
