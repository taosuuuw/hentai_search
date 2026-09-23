# 在线阅读逐源体检报告（tools/reader-src-check.js 生成）

- 生成时间：2026-09-22T17:59:59.584Z
- 网关：http://127.0.0.1:8788（`/api/ping` => {"name":"hs-gateway","version":"1.3.0","time":1790099999580,"sources":["jm","picacg","copymanga","kemono","porncomic","lectormanga","pixiv","nhentai","proxy","relay"],"xlate":true,"egress":"直连（未检测到可用本地代理；被墙的站会走 DoH 钉 IP 或境内中继）","egressDetail":{"startup":false,"startupProxy":"","liveProxy":"","mode":"direct","hostPlan":{"api.mangadex.org":"env","www.cdnbea.net":"env","kemono.cr":"env","api.copy2000…）
- 检索词：`fate`；每个来源的 id 都**先用它自己的检索接口真取一条**，取不到才用内置已知 id
- 每张图各取 **2 次**并比 sha256 前 12 位：两次不一致说明地址不稳定；`text/html` 或正文以 `<` 开头说明「回了错误页冒充图片」

## 汇总表

| 来源 | 检索取到的 id | /api/reader | 页数 | 首图（状态/字节/sha12/类型/耗时） | sha 稳定性 | 结论 / 失败原文 |
|---|---|---|---|---|---|---|
| MangaDex | 98e59ef6-c8da-4c89-afd1-9231f3c4a226 | ok · 3页 · 1.2s | 3 | 200 · 581309B · 3e6bd9f873ce · image/png · 4.3s | 稳定（两取同 sha） | 在线阅读可用 |
| nhentai | 683141 | ok · 13页 · 255ms | 13 | 200 · 441554B · 76e3f6f7dea8 · image/jpeg · 16ms | 稳定（两取同 sha） | 在线阅读可用 |
| E-Hentai | 4109923-e8a290c9df | ✗ 连不上 E-Hentai 图集页：取不到 e-hentai.org：原路：fetch failed；直连强化：DoH 没给出能验真的 IP；… | 0 | （没有页地址） | — | 连不上 E-Hentai 图集页：取不到 e-hentai.org：原路：fetch failed；直连强化：DoH 没给出能验真的 IP；中继：中继全失败：allorigins 冷却中；allorigins-get 冷… |
| Danbooru | — | — | — | — | — | 取不到 id —— 本来源本次没能体检 |
| 紳士漫畫 wnacg | 386748 | ok · 48页 · 708ms | 48 | 200 · 365562B · 569741567111 · image/webp · 5.9s | 稳定（两取同 sha） | 在线阅读可用 |
| Hitomi | — | — | — | — | — | 取不到 id —— 本来源本次没能体检 |
| Pixiv | 149872482 | ✗ 连不上 Pixiv：取不到 www.pixiv.net：直连强化：DoH 没给出能验真的 IP；原路：fetch failed；中继：中继全… | 0 | （没有页地址） | — | 连不上 Pixiv：取不到 www.pixiv.net：直连强化：DoH 没给出能验真的 IP；原路：fetch failed；中继：中继全失败：allorigins 冷却中；allorigins-get 冷却中 |
| 拷贝漫画 copymanga | fateanimals | ok · 24页 · 6.4s | 24 | 200 · 221844B · e53fc669a015 · image/jpeg · 1.4s | 稳定（两取同 sha） | 在线阅读可用 |
| 禁漫 jmcomic | 1474911 | ok · 45页 · 8.5s | 45 | 200 · 134150B · 957312ce98de · image/webp · 822ms | 稳定（两取同 sha） | 在线阅读可用 |
| porn-comic | 872078 | ✗ porn-comic 的正文页整站前置 Cloudflare，网关这次没能过验证：三条通路都没取到：chrome：Cloudflare 刚拒… | 0 | （没有页地址） | — | porn-comic 的正文页整站前置 Cloudflare，网关这次没能过验证：三条通路都没取到：chrome：Cloudflare 刚拒绝了验证，冷却中（还有 90 秒）：Chrome 没能启动（调试端口未就绪）。若… |
| LectorManga | fate-stay-night-full-color | ok · 62页 · 1.3s | 62 | 200 · 108626B · 44e647bf1c0c · image/webp · 4.9s | 稳定（两取同 sha） | 在线阅读可用 |

## 逐源细节

### MangaDex（source=mangadex）
- 判定：**在线阅读可用**
- id：`98e59ef6-c8da-4c89-afd1-9231f3c4a226` —— 来源：keywords（/api/proxy 直取上游检索接口）
- 检索取证：
  - keywords · `https://api.mangadex.org/manga?limit=2&title=fate` → HTTP 200 · 5932B · 717ms · id=`98e59ef6-c8da-4c89-afd1-9231f3c4a226`
- /api/reader `/api/reader?source=mangadex&id=98e59ef6-c8da-4c89-afd1-9231f3c4a226` → HTTP 200 · 1.2s · 1564B
  - ok=true · pages=3 · chapters=1 · title=`Invisible Fate`
- 页 1：上游目标 `https://cmdxd98sb0x3yprd.mangadex.network/data/28ea363876e8269d7054746829bfede8/1-3e6bd9f873cecdc878b5a1133fdefbf829a4fc033e66f7d855456441ac…`
  - 相对地址：`/api/proxy?url=https%3A%2F%2Fcmdxd98sb0x3yprd.mangadex.network%2Fdata%2F28ea363876e8269d7054746829bfede8%2F1-3e6bd9f873cecdc878b5a1133fdefbf829a4fc033e66f7d855456441ac033d8d.png&referer=https%3A%2F%2Fmangadex.org%2F`
  - 备用地址：`/api/proxy?url=https%3A%2F%2Fuploads.mangadex.org%2Fdata%2F28ea363876e8269d7054746829bfede8%2F1-3e6bd9f873cecdc878b5a1133fdefbf829a4fc033e66f7d855456441ac033d8d.png&referer=https%3A%2F%2Fmangadex.org%2F`
  - 第 1 次：HTTP 200 · 581309B · sha256前12=3e6bd9f873ce · image/png · 4.3s
  - 第 2 次：HTTP 200 · 581309B · sha256前12=3e6bd9f873ce · image/png · 4ms
  - 稳定性：两次一致 ✅
- 页 2：上游目标 `https://cmdxd98sb0x3yprd.mangadex.network/data/28ea363876e8269d7054746829bfede8/2-1ab3ad50cde345125d5321726ac55652b35781ff60f251bed1e951e139…`
  - 相对地址：`/api/proxy?url=https%3A%2F%2Fcmdxd98sb0x3yprd.mangadex.network%2Fdata%2F28ea363876e8269d7054746829bfede8%2F2-1ab3ad50cde345125d5321726ac55652b35781ff60f251bed1e951e139610c62.png&referer=https%3A%2F%2Fmangadex.org%2F`
  - 备用地址：`/api/proxy?url=https%3A%2F%2Fuploads.mangadex.org%2Fdata%2F28ea363876e8269d7054746829bfede8%2F2-1ab3ad50cde345125d5321726ac55652b35781ff60f251bed1e951e139610c62.png&referer=https%3A%2F%2Fmangadex.org%2F`
  - 第 1 次：HTTP 200 · 853665B · sha256前12=1ab3ad50cde3 · image/png · 3.6s
  - 第 2 次：HTTP 200 · 853665B · sha256前12=1ab3ad50cde3 · image/png · 11ms
  - 稳定性：两次一致 ✅
- 页 3：上游目标 `https://cmdxd98sb0x3yprd.mangadex.network/data/28ea363876e8269d7054746829bfede8/3-dccf1baeeac2fb27a8df1ef35e5e147359deb696b8eb24a5dc75486d40…`
  - 相对地址：`/api/proxy?url=https%3A%2F%2Fcmdxd98sb0x3yprd.mangadex.network%2Fdata%2F28ea363876e8269d7054746829bfede8%2F3-dccf1baeeac2fb27a8df1ef35e5e147359deb696b8eb24a5dc75486d409be071.png&referer=https%3A%2F%2Fmangadex.org%2F`
  - 备用地址：`/api/proxy?url=https%3A%2F%2Fuploads.mangadex.org%2Fdata%2F28ea363876e8269d7054746829bfede8%2F3-dccf1baeeac2fb27a8df1ef35e5e147359deb696b8eb24a5dc75486d409be071.png&referer=https%3A%2F%2Fmangadex.org%2F`
  - 第 1 次：HTTP 200 · 599032B · sha256前12=dccf1baeeac2 · image/png · 2.7s
  - 第 2 次：HTTP 200 · 599032B · sha256前12=dccf1baeeac2 · image/png · 23ms
  - 稳定性：两次一致 ✅

```json
{
  "id": "mangadex",
  "name": "MangaDex",
  "source": "mangadex",
  "q": "fate",
  "steps": [],
  "pageProbe": [
    {
      "idx": 0,
      "src": "/api/proxy?url=https%3A%2F%2Fcmdxd98sb0x3yprd.mangadex.network%2Fdata%2F28ea363876e8269d7054746829bfede8%2F1-3e6bd9f873cecdc878b5a1133fdefbf829a4fc033e66f7d855456441ac033d8d.png&referer=https%3A%2F%2Fmangadex.org%2F",
      "alt": "/api/proxy?url=https%3A%2F%2Fuploads.mangadex.org%2Fdata%2F28ea363876e8269d7054746829bfede8%2F1-3e6bd9f873cecdc878b5a1133fdefbf829a4fc033e66f7d855456441ac033d8d.png&referer=https%3A%2F%2Fmangadex.org%2F",
      "w": 0,
      "h": 0,
      "target": "https://cmdxd98sb0x3yprd.mangadex.network/data/28ea363876e8269d7054746829bfede8/1-3e6bd9f873cecdc878b5a1133fdefbf829a4fc033e66f7d855456441ac…",
      "fetch": {
        "status": 200,
        "ms": 4309,
        "bytes": 581309,
        "ct": "image/png",
        "sha": "3e6bd9f873ce",
        "htmlish": false,
        "empty": false,
        "error": "",
        "body": ""
      },
      "fetch2": {
        "status": 200,
        "ms": 4,
        "bytes": 581309,
        "ct": "image/png",
        "sha": "3e6bd9f873ce",
        "error": ""
      },
      "stable": true,
      "good": true
    },
    {
      "idx": 1,
      "src": "/api/proxy?url=https%3A%2F%2Fcmdxd98sb0x3yprd.mangadex.network%2Fdata%2F28ea363876e8269d7054746829bfede8%2F2-1ab3ad50cde345125d5321726ac55652b35781ff60f251bed1e951e139610c62.png&referer=https%3A%2F%2Fmangadex.org%2F",
      "alt": "/api/proxy?url=https%3A%2F%2Fuploads.mangadex.org%2Fdata%2F28ea363876e8269d7054746829bfede8%2F2-1ab3ad50cde345125d5321726ac55652b35781ff60f251bed1e951e139610c62.png&referer=https%3A%2F%2Fmangadex.org%2F",
      "w": 0,
      "h": 0,
      "target": "https://cmdxd98sb0x3yprd.mangadex.network/data/28ea363876e8269d7054746829bfede8/2-1ab3ad50cde345125d5321726ac55652b35781ff60f251bed1e951e139…",
      "fetch": {
        "status": 200,
        "ms": 3563,
        "bytes": 853665,
        "ct": "image/png",
        "sha": "1ab3ad50cde3",
        "htmlish": false,
        "empty": false,
        "error": "",
        "body": ""
      },
      "fetch2": {
        "status": 200,
        "ms": 11,
        "bytes": 853665,
        "ct": "image/png",
        "sha": "1ab3ad50cde3",
        "error": ""
      },
      "stable": true,
      "good": true
    },
    {
      "idx": 2,
      "src": "/api/proxy?url=https%3A%2F%2Fcmdxd98sb0x3yprd.mangadex.network%2Fdata%2F28ea363876e8269d7054746829bfede8%2F3-dccf1baeeac2fb27a8df1ef35e5e147359deb696b8eb24a5dc75486d409be071.png&referer=https%3A%2F%2Fmangadex.org%2F",
      "alt": "/api/proxy?url=https%3A%2F%2Fuploads.mangadex.org%2Fdata%2F28ea363876e8269d7054746829bfede8%2F3-dccf1baeeac2fb27a8df1ef35e5e147359deb696b8eb24a5dc75486d409be071.png&referer=https%3A%2F%2Fmangadex.org%2F",
      "w": 0,
      "h": 0,
      "target": "https://cmdxd98sb0x3yprd.mangadex.network/data/28ea363876e8269d7054746829bfede8/3-dccf1baeeac2fb27a8df1ef35e5e147359deb696b8eb24a5dc75486d40…",
      "fetch": {
        "status": 200,
        "ms": 2694,
        "bytes": 599032,
        "ct": "image/png",
        "sha": "dccf1baeeac2",
        "htmlish": false,
        "empty": false,
        "error": "",
        "body": ""
      },
      "fetch2": {
        "status": 200,
        "ms": 23,
        "bytes": 599032,
        "ct": "image/png",
        "sha": "dccf1baeeac2",
        "error": ""
      },
      "stable": true,
      "good": true
    }
  ],
  "verdict": "在线阅读可用",
  "note": "",
  "how": "keywords（/api/proxy 直取上游检索接口）",
  "probeId": "98e59ef6-c8da-4c89-afd1-9231f3c4a226",
  "searchSteps": [
    {
      "lane": "keywords",
      "search": "https://api.mangadex.org/manga?limit=2&title=fate",
      "gwUrl": "/api/proxy?url=https%3A%2F%2Fapi.mangadex.org%2Fmanga%3Flimit%3D2%26title%3Dfate&referer=https%3A%2F%2Fapi.mangadex.org%2F",
      "status": 200,
      "ms": 717,
      "bytes": 5932,
      "ct": "application/json",
      "error": "",
      "id": "98e59ef6-c8da-4c89-afd1-9231f3c4a226"
    }
  ],
  "reader": {
    "url": "/api/reader?source=mangadex&id=98e59ef6-c8da-4c89-afd1-9231f3c4a226",
    "status": 200,
    "ms": 1226,
    "bytes": 1564,
    "error": "",
    "httpError": false,
    "ok": true,
    "jsonError": "",
    "title": "Invisible Fate",
    "pages": 3,
    "chapters": 1,
    "note": ""
  },
  "wallMs": 12552
}
```

### nhentai（source=nhentai）
- 判定：**在线阅读可用**
- id：`683141` —— 来源：keywords（网关检索）
- 检索取证：
  - keywords · `/api/nhentai/search?q=fate&page=1` → HTTP 200 · 7882B · 2ms · id=`683141`
- /api/reader `/api/reader?source=nhentai&id=683141` → HTTP 200 · 255ms · 1968B
  - ok=true · pages=13 · chapters=0 · title=`taka-co - 被DQN殴打并遭寝取的源赖光 -`
- 页 1：上游目标 `https://i.nhentai.net/galleries/4199005/1.webp`
  - 相对地址：`/api/proxy?url=https%3A%2F%2Fi.nhentai.net%2Fgalleries%2F4199005%2F1.webp&referer=https%3A%2F%2Fnhentai.net%2F`
  - 第 1 次：HTTP 200 · 441554B · sha256前12=76e3f6f7dea8 · image/jpeg · 16ms
  - 第 2 次：HTTP 200 · 441554B · sha256前12=76e3f6f7dea8 · image/jpeg · 16ms
  - 稳定性：两次一致 ✅
- 页 2：上游目标 `https://i.nhentai.net/galleries/4199005/2.webp`
  - 相对地址：`/api/proxy?url=https%3A%2F%2Fi.nhentai.net%2Fgalleries%2F4199005%2F2.webp&referer=https%3A%2F%2Fnhentai.net%2F`
  - 第 1 次：HTTP 200 · 523666B · sha256前12=a6b6ad90e77f · image/jpeg · 2ms
  - 第 2 次：HTTP 200 · 523666B · sha256前12=a6b6ad90e77f · image/jpeg · 2ms
  - 稳定性：两次一致 ✅
- 页 3：上游目标 `https://i.nhentai.net/galleries/4199005/3.webp`
  - 相对地址：`/api/proxy?url=https%3A%2F%2Fi.nhentai.net%2Fgalleries%2F4199005%2F3.webp&referer=https%3A%2F%2Fnhentai.net%2F`
  - 第 1 次：HTTP 200 · 581915B · sha256前12=6109c40e995b · image/jpeg · 21ms
  - 第 2 次：HTTP 200 · 581915B · sha256前12=6109c40e995b · image/jpeg · 17ms
  - 稳定性：两次一致 ✅

```json
{
  "id": "nhentai",
  "name": "nhentai",
  "source": "nhentai",
  "q": "fate",
  "steps": [],
  "pageProbe": [
    {
      "idx": 0,
      "src": "/api/proxy?url=https%3A%2F%2Fi.nhentai.net%2Fgalleries%2F4199005%2F1.webp&referer=https%3A%2F%2Fnhentai.net%2F",
      "alt": "",
      "w": 1280,
      "h": 1796,
      "target": "https://i.nhentai.net/galleries/4199005/1.webp",
      "fetch": {
        "status": 200,
        "ms": 16,
        "bytes": 441554,
        "ct": "image/jpeg",
        "sha": "76e3f6f7dea8",
        "htmlish": false,
        "empty": false,
        "error": "",
        "body": ""
      },
      "fetch2": {
        "status": 200,
        "ms": 16,
        "bytes": 441554,
        "ct": "image/jpeg",
        "sha": "76e3f6f7dea8",
        "error": ""
      },
      "stable": true,
      "good": true
    },
    {
      "idx": 1,
      "src": "/api/proxy?url=https%3A%2F%2Fi.nhentai.net%2Fgalleries%2F4199005%2F2.webp&referer=https%3A%2F%2Fnhentai.net%2F",
      "alt": "",
      "w": 1280,
      "h": 1796,
      "target": "https://i.nhentai.net/galleries/4199005/2.webp",
      "fetch": {
        "status": 200,
        "ms": 2,
        "bytes": 523666,
        "ct": "image/jpeg",
        "sha": "a6b6ad90e77f",
        "htmlish": false,
        "empty": false,
        "error": "",
        "body": ""
      },
      "fetch2": {
        "status": 200,
        "ms": 2,
        "bytes": 523666,
        "ct": "image/jpeg",
        "sha": "a6b6ad90e77f",
        "error": ""
      },
      "stable": true,
      "good": true
    },
    {
      "idx": 2,
      "src": "/api/proxy?url=https%3A%2F%2Fi.nhentai.net%2Fgalleries%2F4199005%2F3.webp&referer=https%3A%2F%2Fnhentai.net%2F",
      "alt": "",
      "w": 1280,
      "h": 1796,
      "target": "https://i.nhentai.net/galleries/4199005/3.webp",
      "fetch": {
        "status": 200,
        "ms": 21,
        "bytes": 581915,
        "ct": "image/jpeg",
        "sha": "6109c40e995b",
        "htmlish": false,
        "empty": false,
        "error": "",
        "body": ""
      },
      "fetch2": {
        "status": 200,
        "ms": 17,
        "bytes": 581915,
        "ct": "image/jpeg",
        "sha": "6109c40e995b",
        "error": ""
      },
      "stable": true,
      "good": true
    }
  ],
  "verdict": "在线阅读可用",
  "note": "",
  "how": "keywords（网关检索）",
  "probeId": "683141",
  "searchSteps": [
    {
      "lane": "keywords",
      "search": "/api/nhentai/search?q=fate&page=1",
      "gwUrl": "/api/nhentai/search?q=fate&page=1",
      "status": 200,
      "ms": 2,
      "bytes": 7882,
      "ct": "application/json; charset=utf-8",
      "error": "",
      "items": 25,
      "id": "683141"
    }
  ],
  "reader": {
    "url": "/api/reader?source=nhentai&id=683141",
    "status": 200,
    "ms": 255,
    "bytes": 1968,
    "error": "",
    "httpError": false,
    "ok": true,
    "jsonError": "",
    "title": "taka-co - 被DQN殴打并遭寝取的源赖光 -",
    "pages": 13,
    "chapters": 0,
    "note": ""
  },
  "wallMs": 339
}
```

### E-Hentai（source=ehentai）
- 判定：**在线阅读不可用（/api/reader 没给出页地址）**
- id：`4109923-e8a290c9df` —— 来源：内置已知可用 id（检索这次没给出来）
- 检索取证：
  - keywords · `/api/ehentai/search?q=fate&page=1` → HTTP 200 · 954B · 1ms
  - fallback-path · `/api/ehentai/search?q=&page=1` → HTTP 200 · 242B · 14.4s · 上游错误=连不上 E-Hentai 流行榜：取不到 e-hentai.org：原路：fetch failed；直连强化：DoH 没给出能验真的 IP；中继：中继全失败：allorigins 冷却中；allorigins-get 冷却中
- /api/reader `/api/reader?source=ehentai&id=4109923-e8a290c9df` → HTTP 200 · 5.4s · 268B
  - ok=false · pages=0 · chapters=0 · title=``
  - error 原文：连不上 E-Hentai 图集页：取不到 e-hentai.org：原路：fetch failed；直连强化：DoH 没给出能验真的 IP；中继：中继全失败：allorigins 冷却中；allorigins-get 冷却中

```json
{
  "id": "ehentai",
  "name": "E-Hentai",
  "source": "ehentai",
  "q": "fate",
  "steps": [],
  "pageProbe": [],
  "verdict": "在线阅读不可用（/api/reader 没给出页地址）",
  "note": "连不上 E-Hentai 图集页：取不到 e-hentai.org：原路：fetch failed；直连强化：DoH 没给出能验真的 IP；中继：中继全失败：allorigins 冷却中；allorigins-get 冷却中",
  "how": "内置已知可用 id（检索这次没给出来）",
  "probeId": "4109923-e8a290c9df",
  "searchSteps": [
    {
      "lane": "keywords",
      "search": "/api/ehentai/search?q=fate&page=1",
      "gwUrl": "/api/ehentai/search?q=fate&page=1",
      "status": 200,
      "ms": 1,
      "bytes": 954,
      "ct": "application/json; charset=utf-8",
      "error": "",
      "items": 0,
      "id": ""
    },
    {
      "lane": "fallback-path",
      "search": "/api/ehentai/search?q=&page=1",
      "gwUrl": "/api/ehentai/search?q=&page=1",
      "status": 200,
      "ms": 14403,
      "bytes": 242,
      "ct": "application/json; charset=utf-8",
      "error": "",
      "upstreamError": "连不上 E-Hentai 流行榜：取不到 e-hentai.org：原路：fetch failed；直连强化：DoH 没给出能验真的 IP；中继：中继全失败：allorigins 冷却中；allorigins-get 冷却中",
      "ok": false,
      "id": ""
    }
  ],
  "reader": {
    "url": "/api/reader?source=ehentai&id=4109923-e8a290c9df",
    "status": 200,
    "ms": 5417,
    "bytes": 268,
    "error": "",
    "httpError": false,
    "ok": false,
    "jsonError": "连不上 E-Hentai 图集页：取不到 e-hentai.org：原路：fetch failed；直连强化：DoH 没给出能验真的 IP；中继：中继全失败：allorigins 冷却中；allorigins-get 冷却中",
    "title": "",
    "pages": 0,
    "chapters": 0,
    "note": ""
  },
  "wallMs": 19821
}
```

### Danbooru（source=danbooru）
- 判定：**取不到 id —— 本来源本次没能体检**
- id：`（无）` —— 来源：本次取不到真实 id
- 检索取证：
  - keywords · `https://danbooru.donmai.us/posts.json?limit=1&tags=fate` → HTTP 502 · 100B · 2ms

```json
{
  "id": "danbooru",
  "name": "Danbooru",
  "source": "danbooru",
  "q": "fate",
  "steps": [],
  "pageProbe": [],
  "verdict": "取不到 id —— 本来源本次没能体检",
  "note": "",
  "how": "本次取不到真实 id",
  "probeId": "",
  "searchSteps": [
    {
      "lane": "keywords",
      "search": "https://danbooru.donmai.us/posts.json?limit=1&tags=fate",
      "gwUrl": "/api/proxy?url=https%3A%2F%2Fdanbooru.donmai.us%2Fposts.json%3Flimit%3D1%26tags%3Dfate&referer=https%3A%2F%2Fdanbooru.donmai.us%2F",
      "status": 502,
      "ms": 2,
      "bytes": 100,
      "ct": "application/json; charset=utf-8",
      "error": "",
      "id": ""
    }
  ],
  "wallMs": 3
}
```

### 紳士漫畫 wnacg（source=wnacg）
- 判定：**在线阅读可用**
- id：`386748` —— 来源：keywords（网关检索）
- 检索取证：
  - keywords · `/api/wnacg/search?q=fate&page=1` → HTTP 200 · 8311B · 7.4s · id=`386748`
- /api/reader `/api/reader?source=wnacg&id=386748` → HTTP 200 · 708ms · 10411B
  - ok=true · pages=48 · chapters=0 · title=`嗖嗖soso - Kiara Sessyoin`
- 页 1：上游目标 `http://img5.qy0.ru/data/3867/48/0001.webp?verify=1790100000-NbsH3S7Wsu61xt5qpwjBPCGxCwR2MbuRApixKtN9ljg`
  - 相对地址：`/api/proxy?url=http%3A%2F%2Fimg5.qy0.ru%2Fdata%2F3867%2F48%2F0001.webp%3Fverify%3D1790100000-NbsH3S7Wsu61xt5qpwjBPCGxCwR2MbuRApixKtN9ljg&referer=https%3A%2F%2Fwww.wnacg.com%2Fphotos-index-aid-386748.html`
  - 第 1 次：HTTP 200 · 365562B · sha256前12=569741567111 · image/webp · 5.9s
  - 第 2 次：HTTP 200 · 365562B · sha256前12=569741567111 · image/webp · 2ms
  - 稳定性：两次一致 ✅
- 页 2：上游目标 `http://img5.qy0.ru/data/3867/48/0002.webp?verify=1790100000-xEzJ8RB9GeiRHaL-gGWLjrWXKbuXE3WHePknz7vsRTY`
  - 相对地址：`/api/proxy?url=http%3A%2F%2Fimg5.qy0.ru%2Fdata%2F3867%2F48%2F0002.webp%3Fverify%3D1790100000-xEzJ8RB9GeiRHaL-gGWLjrWXKbuXE3WHePknz7vsRTY&referer=https%3A%2F%2Fwww.wnacg.com%2Fphotos-index-aid-386748.html`
  - 第 1 次：HTTP 200 · 869792B · sha256前12=b10b767ae3ad · image/webp · 1.1s
  - 第 2 次：HTTP 200 · 869792B · sha256前12=b10b767ae3ad · image/webp · 7ms
  - 稳定性：两次一致 ✅
- 页 3：上游目标 `http://img5.qy0.ru/data/3867/48/0003.webp?verify=1790100000-lGrK3nxa7fGI_1IVqf6zt2OLgqXOJC0oBCjOT4c7eEE`
  - 相对地址：`/api/proxy?url=http%3A%2F%2Fimg5.qy0.ru%2Fdata%2F3867%2F48%2F0003.webp%3Fverify%3D1790100000-lGrK3nxa7fGI_1IVqf6zt2OLgqXOJC0oBCjOT4c7eEE&referer=https%3A%2F%2Fwww.wnacg.com%2Fphotos-index-aid-386748.html`
  - 第 1 次：HTTP 200 · 354586B · sha256前12=6ddc52604732 · image/webp · 564ms
  - 第 2 次：HTTP 200 · 354586B · sha256前12=6ddc52604732 · image/webp · 3ms
  - 稳定性：两次一致 ✅

```json
{
  "id": "wnacg",
  "name": "紳士漫畫 wnacg",
  "source": "wnacg",
  "q": "fate",
  "steps": [],
  "pageProbe": [
    {
      "idx": 0,
      "src": "/api/proxy?url=http%3A%2F%2Fimg5.qy0.ru%2Fdata%2F3867%2F48%2F0001.webp%3Fverify%3D1790100000-NbsH3S7Wsu61xt5qpwjBPCGxCwR2MbuRApixKtN9ljg&referer=https%3A%2F%2Fwww.wnacg.com%2Fphotos-index-aid-386748.html",
      "alt": "",
      "w": 0,
      "h": 0,
      "target": "http://img5.qy0.ru/data/3867/48/0001.webp?verify=1790100000-NbsH3S7Wsu61xt5qpwjBPCGxCwR2MbuRApixKtN9ljg",
      "fetch": {
        "status": 200,
        "ms": 5914,
        "bytes": 365562,
        "ct": "image/webp",
        "sha": "569741567111",
        "htmlish": false,
        "empty": false,
        "error": "",
        "body": ""
      },
      "fetch2": {
        "status": 200,
        "ms": 2,
        "bytes": 365562,
        "ct": "image/webp",
        "sha": "569741567111",
        "error": ""
      },
      "stable": true,
      "good": true
    },
    {
      "idx": 1,
      "src": "/api/proxy?url=http%3A%2F%2Fimg5.qy0.ru%2Fdata%2F3867%2F48%2F0002.webp%3Fverify%3D1790100000-xEzJ8RB9GeiRHaL-gGWLjrWXKbuXE3WHePknz7vsRTY&referer=https%3A%2F%2Fwww.wnacg.com%2Fphotos-index-aid-386748.html",
      "alt": "",
      "w": 0,
      "h": 0,
      "target": "http://img5.qy0.ru/data/3867/48/0002.webp?verify=1790100000-xEzJ8RB9GeiRHaL-gGWLjrWXKbuXE3WHePknz7vsRTY",
      "fetch": {
        "status": 200,
        "ms": 1137,
        "bytes": 869792,
        "ct": "image/webp",
        "sha": "b10b767ae3ad",
        "htmlish": false,
        "empty": false,
        "error": "",
        "body": ""
      },
      "fetch2": {
        "status": 200,
        "ms": 7,
        "bytes": 869792,
        "ct": "image/webp",
        "sha": "b10b767ae3ad",
        "error": ""
      },
      "stable": true,
      "good": true
    },
    {
      "idx": 2,
      "src": "/api/proxy?url=http%3A%2F%2Fimg5.qy0.ru%2Fdata%2F3867%2F48%2F0003.webp%3Fverify%3D1790100000-lGrK3nxa7fGI_1IVqf6zt2OLgqXOJC0oBCjOT4c7eEE&referer=https%3A%2F%2Fwww.wnacg.com%2Fphotos-index-aid-386748.html",
      "alt": "",
      "w": 0,
      "h": 0,
      "target": "http://img5.qy0.ru/data/3867/48/0003.webp?verify=1790100000-lGrK3nxa7fGI_1IVqf6zt2OLgqXOJC0oBCjOT4c7eEE",
      "fetch": {
        "status": 200,
        "ms": 564,
        "bytes": 354586,
        "ct": "image/webp",
        "sha": "6ddc52604732",
        "htmlish": false,
        "empty": false,
        "error": "",
        "body": ""
      },
      "fetch2": {
        "status": 200,
        "ms": 3,
        "bytes": 354586,
        "ct": "image/webp",
        "sha": "6ddc52604732",
        "error": ""
      },
      "stable": true,
      "good": true
    }
  ],
  "verdict": "在线阅读可用",
  "note": "",
  "how": "keywords（网关检索）",
  "probeId": "386748",
  "searchSteps": [
    {
      "lane": "keywords",
      "search": "/api/wnacg/search?q=fate&page=1",
      "gwUrl": "/api/wnacg/search?q=fate&page=1",
      "status": 200,
      "ms": 7415,
      "bytes": 8311,
      "ct": "application/json; charset=utf-8",
      "error": "",
      "items": 24,
      "id": "386748"
    }
  ],
  "reader": {
    "url": "/api/reader?source=wnacg&id=386748",
    "status": 200,
    "ms": 708,
    "bytes": 10411,
    "error": "",
    "httpError": false,
    "ok": true,
    "jsonError": "",
    "title": "嗖嗖soso - Kiara Sessyoin",
    "pages": 48,
    "chapters": 0,
    "note": ""
  },
  "wallMs": 15754
}
```

### Hitomi（source=hitomi）
- 判定：**取不到 id —— 本来源本次没能体检**
- id：`（无）` —— 来源：本次取不到真实 id
- 检索取证：
  - keywords · `https://hitomi.la/search.html?query=fate` → HTTP 200 · 3687B · 963ms

```json
{
  "id": "hitomi",
  "name": "Hitomi",
  "source": "hitomi",
  "q": "fate",
  "steps": [],
  "pageProbe": [],
  "verdict": "取不到 id —— 本来源本次没能体检",
  "note": "",
  "how": "本次取不到真实 id",
  "probeId": "",
  "searchSteps": [
    {
      "lane": "keywords",
      "search": "https://hitomi.la/search.html?query=fate",
      "gwUrl": "/api/proxy?url=https%3A%2F%2Fhitomi.la%2Fsearch.html%3Fquery%3Dfate&referer=https%3A%2F%2Fhitomi.la%2F",
      "status": 200,
      "ms": 963,
      "bytes": 3687,
      "ct": "text/html; charset=UTF-8",
      "error": "",
      "id": ""
    }
  ],
  "wallMs": 963
}
```

### Pixiv（source=pixiv）
- 判定：**在线阅读不可用（/api/reader 没给出页地址）**
- id：`149872482` —— 来源：内置已知可用 id（检索这次没给出来）
- 检索取证：
  - keywords · `/api/pixiv/search?q=fate&page=1` → HTTP 502 · 214B · 10.6s · 上游错误=Pixiv 请求失败：取不到 www.pixiv.net：直连强化：DoH 没给出能验真的 IP；原路：fetch failed；中继：中继全失败：allorigins 冷却中；allorigins-get 冷却中
- /api/reader `/api/reader?source=pixiv&id=149872482` → HTTP 200 · 10.7s · 245B
  - ok=false · pages=0 · chapters=0 · title=``
  - error 原文：连不上 Pixiv：取不到 www.pixiv.net：直连强化：DoH 没给出能验真的 IP；原路：fetch failed；中继：中继全失败：allorigins 冷却中；allorigins-get 冷却中

```json
{
  "id": "pixiv",
  "name": "Pixiv",
  "source": "pixiv",
  "q": "fate",
  "steps": [],
  "pageProbe": [],
  "verdict": "在线阅读不可用（/api/reader 没给出页地址）",
  "note": "连不上 Pixiv：取不到 www.pixiv.net：直连强化：DoH 没给出能验真的 IP；原路：fetch failed；中继：中继全失败：allorigins 冷却中；allorigins-get 冷却中",
  "how": "内置已知可用 id（检索这次没给出来）",
  "probeId": "149872482",
  "searchSteps": [
    {
      "lane": "keywords",
      "search": "/api/pixiv/search?q=fate&page=1",
      "gwUrl": "/api/pixiv/search?q=fate&page=1",
      "status": 502,
      "ms": 10569,
      "bytes": 214,
      "ct": "application/json; charset=utf-8",
      "error": "",
      "upstreamError": "Pixiv 请求失败：取不到 www.pixiv.net：直连强化：DoH 没给出能验真的 IP；原路：fetch failed；中继：中继全失败：allorigins 冷却中；allorigins-get 冷却中",
      "ok": false,
      "id": ""
    }
  ],
  "reader": {
    "url": "/api/reader?source=pixiv&id=149872482",
    "status": 200,
    "ms": 10660,
    "bytes": 245,
    "error": "",
    "httpError": false,
    "ok": false,
    "jsonError": "连不上 Pixiv：取不到 www.pixiv.net：直连强化：DoH 没给出能验真的 IP；原路：fetch failed；中继：中继全失败：allorigins 冷却中；allorigins-get 冷却中",
    "title": "",
    "pages": 0,
    "chapters": 0,
    "note": ""
  },
  "wallMs": 21229
}
```

### 拷贝漫画 copymanga（source=copymanga）
- 判定：**在线阅读可用**
- id：`fateanimals` —— 来源：keywords（网关检索）
- 检索取证：
  - keywords · `/api/copymanga/search?q=fate&page=1` → HTTP 200 · 8494B · 22.6s · id=`fateanimals`
- /api/reader `/api/reader?source=copymanga&id=fateanimals` → HTTP 200 · 6.4s · 4115B
  - ok=true · pages=24 · chapters=1 · title=`Fate Animals · 铁血的007`
  - note：拷贝漫画官方 APP API（节点 api.copy2000.online，HMAC 签名，章节接口用 in_mainland/request_id 口径、图片接口是 chapter2，页顺序按 words 还原）。章节清单已按分组翻页取全（每组每页 100 章）。
- 页 1：上游目标 `https://sf.mangafunb.fun/f/fateanimals/b3e2a/16403927589502/c1500x.jpg`
  - 相对地址：`/api/proxy?url=https%3A%2F%2Fsf.mangafunb.fun%2Ff%2Ffateanimals%2Fb3e2a%2F16403927589502%2Fc1500x.jpg&referer=https%3A%2F%2Fwww.copy20.com%2F`
  - 第 1 次：HTTP 200 · 221844B · sha256前12=e53fc669a015 · image/jpeg · 1.4s
  - 第 2 次：HTTP 200 · 221844B · sha256前12=e53fc669a015 · image/jpeg · 1ms
  - 稳定性：两次一致 ✅
- 页 2：上游目标 `https://sf.mangafunb.fun/f/fateanimals/b3e2a/16403927617380/c1500x.jpg`
  - 相对地址：`/api/proxy?url=https%3A%2F%2Fsf.mangafunb.fun%2Ff%2Ffateanimals%2Fb3e2a%2F16403927617380%2Fc1500x.jpg&referer=https%3A%2F%2Fwww.copy20.com%2F`
  - 第 1 次：HTTP 200 · 90518B · sha256前12=e7b52bcfd6a9 · image/jpeg · 609ms
  - 第 2 次：HTTP 200 · 90518B · sha256前12=e7b52bcfd6a9 · image/jpeg · 1ms
  - 稳定性：两次一致 ✅
- 页 3：上游目标 `https://sf.mangafunb.fun/f/fateanimals/b3e2a/16403927627618/c1500x.jpg`
  - 相对地址：`/api/proxy?url=https%3A%2F%2Fsf.mangafunb.fun%2Ff%2Ffateanimals%2Fb3e2a%2F16403927627618%2Fc1500x.jpg&referer=https%3A%2F%2Fwww.copy20.com%2F`
  - 第 1 次：HTTP 200 · 90641B · sha256前12=d56f17909016 · image/jpeg · 622ms
  - 第 2 次：HTTP 200 · 90641B · sha256前12=d56f17909016 · image/jpeg · 1ms
  - 稳定性：两次一致 ✅

```json
{
  "id": "copymanga",
  "name": "拷贝漫画 copymanga",
  "source": "copymanga",
  "q": "fate",
  "steps": [],
  "pageProbe": [
    {
      "idx": 0,
      "src": "/api/proxy?url=https%3A%2F%2Fsf.mangafunb.fun%2Ff%2Ffateanimals%2Fb3e2a%2F16403927589502%2Fc1500x.jpg&referer=https%3A%2F%2Fwww.copy20.com%2F",
      "alt": "",
      "w": 0,
      "h": 0,
      "target": "https://sf.mangafunb.fun/f/fateanimals/b3e2a/16403927589502/c1500x.jpg",
      "fetch": {
        "status": 200,
        "ms": 1368,
        "bytes": 221844,
        "ct": "image/jpeg",
        "sha": "e53fc669a015",
        "htmlish": false,
        "empty": false,
        "error": "",
        "body": ""
      },
      "fetch2": {
        "status": 200,
        "ms": 1,
        "bytes": 221844,
        "ct": "image/jpeg",
        "sha": "e53fc669a015",
        "error": ""
      },
      "stable": true,
      "good": true
    },
    {
      "idx": 1,
      "src": "/api/proxy?url=https%3A%2F%2Fsf.mangafunb.fun%2Ff%2Ffateanimals%2Fb3e2a%2F16403927617380%2Fc1500x.jpg&referer=https%3A%2F%2Fwww.copy20.com%2F",
      "alt": "",
      "w": 0,
      "h": 0,
      "target": "https://sf.mangafunb.fun/f/fateanimals/b3e2a/16403927617380/c1500x.jpg",
      "fetch": {
        "status": 200,
        "ms": 609,
        "bytes": 90518,
        "ct": "image/jpeg",
        "sha": "e7b52bcfd6a9",
        "htmlish": false,
        "empty": false,
        "error": "",
        "body": ""
      },
      "fetch2": {
        "status": 200,
        "ms": 1,
        "bytes": 90518,
        "ct": "image/jpeg",
        "sha": "e7b52bcfd6a9",
        "error": ""
      },
      "stable": true,
      "good": true
    },
    {
      "idx": 2,
      "src": "/api/proxy?url=https%3A%2F%2Fsf.mangafunb.fun%2Ff%2Ffateanimals%2Fb3e2a%2F16403927627618%2Fc1500x.jpg&referer=https%3A%2F%2Fwww.copy20.com%2F",
      "alt": "",
      "w": 0,
      "h": 0,
      "target": "https://sf.mangafunb.fun/f/fateanimals/b3e2a/16403927627618/c1500x.jpg",
      "fetch": {
        "status": 200,
        "ms": 622,
        "bytes": 90641,
        "ct": "image/jpeg",
        "sha": "d56f17909016",
        "htmlish": false,
        "empty": false,
        "error": "",
        "body": ""
      },
      "fetch2": {
        "status": 200,
        "ms": 1,
        "bytes": 90641,
        "ct": "image/jpeg",
        "sha": "d56f17909016",
        "error": ""
      },
      "stable": true,
      "good": true
    }
  ],
  "verdict": "在线阅读可用",
  "note": "",
  "how": "keywords（网关检索）",
  "probeId": "fateanimals",
  "searchSteps": [
    {
      "lane": "keywords",
      "search": "/api/copymanga/search?q=fate&page=1",
      "gwUrl": "/api/copymanga/search?q=fate&page=1",
      "status": 200,
      "ms": 22639,
      "bytes": 8494,
      "ct": "application/json; charset=utf-8",
      "error": "",
      "items": 30,
      "id": "fateanimals"
    }
  ],
  "reader": {
    "url": "/api/reader?source=copymanga&id=fateanimals",
    "status": 200,
    "ms": 6357,
    "bytes": 4115,
    "error": "",
    "httpError": false,
    "ok": true,
    "jsonError": "",
    "title": "Fate Animals · 铁血的007",
    "pages": 24,
    "chapters": 1,
    "note": "拷贝漫画官方 APP API（节点 api.copy2000.online，HMAC 签名，章节接口用 in_mainland/request_id 口径、图片接口是 chapter2，页顺序按 words 还原）。章节清单已按分组翻页取全（每组每页 100 章）。"
  },
  "wallMs": 31599
}
```

### 禁漫 jmcomic（source=jmcomic）
- 判定：**在线阅读可用**
- id：`1474911` —— 来源：keywords（网关检索）
- 检索取证：
  - keywords · `/api/jm/search?q=fate&page=1` → HTTP 200 · 28273B · 888ms · id=`1474911`
- /api/reader `/api/reader?source=jmcomic&id=1474911` → HTTP 200 · 8.5s · 8144B
  - ok=true · pages=45 · chapters=0 · title=`[B_Meow个人汉化][YaM (くなびし)] 乱性エロイカ (Fate/Extra) [中国翻译] [DL版]`
  - note：禁漫官方 APP API（www.cdnhjk.net）：/chapter 给页文件名 + 整条 series，/chapter_view_template 给 scramble_id=220980（模板里的 imghost=https://cdn-msp.jmapiproxy1.cc）。这本 aid 1474911 ≥ scramble_id，图片是**分块打乱**的：前端按站点自己的算法（块数 = md5(aid+page) 末位 ASCII 决定 → 分块上下颠倒）用 canvas 还原后才显示。
- 页 1：上游目标 `https://cdn-msp.jmapiproxy1.cc/media/photos/1474911/00001.webp`
  - 相对地址：`/api/proxy?url=https%3A%2F%2Fcdn-msp.jmapiproxy1.cc%2Fmedia%2Fphotos%2F1474911%2F00001.webp&referer=https%3A%2F%2F18comic.vip%2F`
  - 第 1 次：HTTP 200 · 134150B · sha256前12=957312ce98de · image/webp · 822ms
  - 第 2 次：HTTP 200 · 134150B · sha256前12=957312ce98de · image/webp · 1ms
  - 稳定性：两次一致 ✅
- 页 2：上游目标 `https://cdn-msp.jmapiproxy1.cc/media/photos/1474911/00002.webp`
  - 相对地址：`/api/proxy?url=https%3A%2F%2Fcdn-msp.jmapiproxy1.cc%2Fmedia%2Fphotos%2F1474911%2F00002.webp&referer=https%3A%2F%2F18comic.vip%2F`
  - 第 1 次：HTTP 200 · 123756B · sha256前12=403fd7029859 · image/webp · 1.5s
  - 第 2 次：HTTP 200 · 123756B · sha256前12=403fd7029859 · image/webp · 1ms
  - 稳定性：两次一致 ✅
- 页 3：上游目标 `https://cdn-msp.jmapiproxy1.cc/media/photos/1474911/00003.webp`
  - 相对地址：`/api/proxy?url=https%3A%2F%2Fcdn-msp.jmapiproxy1.cc%2Fmedia%2Fphotos%2F1474911%2F00003.webp&referer=https%3A%2F%2F18comic.vip%2F`
  - 第 1 次：HTTP 200 · 4176B · sha256前12=3419336abf57 · image/webp · 258ms
  - 第 2 次：HTTP 200 · 4176B · sha256前12=3419336abf57 · image/webp · 0ms
  - 稳定性：两次一致 ✅

```json
{
  "id": "jmcomic",
  "name": "禁漫 jmcomic",
  "source": "jmcomic",
  "q": "fate",
  "steps": [],
  "pageProbe": [
    {
      "idx": 0,
      "src": "/api/proxy?url=https%3A%2F%2Fcdn-msp.jmapiproxy1.cc%2Fmedia%2Fphotos%2F1474911%2F00001.webp&referer=https%3A%2F%2F18comic.vip%2F",
      "alt": "",
      "w": 0,
      "h": 0,
      "target": "https://cdn-msp.jmapiproxy1.cc/media/photos/1474911/00001.webp",
      "fetch": {
        "status": 200,
        "ms": 822,
        "bytes": 134150,
        "ct": "image/webp",
        "sha": "957312ce98de",
        "htmlish": false,
        "empty": false,
        "error": "",
        "body": ""
      },
      "fetch2": {
        "status": 200,
        "ms": 1,
        "bytes": 134150,
        "ct": "image/webp",
        "sha": "957312ce98de",
        "error": ""
      },
      "stable": true,
      "good": true
    },
    {
      "idx": 1,
      "src": "/api/proxy?url=https%3A%2F%2Fcdn-msp.jmapiproxy1.cc%2Fmedia%2Fphotos%2F1474911%2F00002.webp&referer=https%3A%2F%2F18comic.vip%2F",
      "alt": "",
      "w": 0,
      "h": 0,
      "target": "https://cdn-msp.jmapiproxy1.cc/media/photos/1474911/00002.webp",
      "fetch": {
        "status": 200,
        "ms": 1519,
        "bytes": 123756,
        "ct": "image/webp",
        "sha": "403fd7029859",
        "htmlish": false,
        "empty": false,
        "error": "",
        "body": ""
      },
      "fetch2": {
        "status": 200,
        "ms": 1,
        "bytes": 123756,
        "ct": "image/webp",
        "sha": "403fd7029859",
        "error": ""
      },
      "stable": true,
      "good": true
    },
    {
      "idx": 2,
      "src": "/api/proxy?url=https%3A%2F%2Fcdn-msp.jmapiproxy1.cc%2Fmedia%2Fphotos%2F1474911%2F00003.webp&referer=https%3A%2F%2F18comic.vip%2F",
      "alt": "",
      "w": 0,
      "h": 0,
      "target": "https://cdn-msp.jmapiproxy1.cc/media/photos/1474911/00003.webp",
      "fetch": {
        "status": 200,
        "ms": 258,
        "bytes": 4176,
        "ct": "image/webp",
        "sha": "3419336abf57",
        "htmlish": false,
        "empty": false,
        "error": "",
        "body": ""
      },
      "fetch2": {
        "status": 200,
        "ms": 0,
        "bytes": 4176,
        "ct": "image/webp",
        "sha": "3419336abf57",
        "error": ""
      },
      "stable": true,
      "good": true
    }
  ],
  "verdict": "在线阅读可用",
  "note": "",
  "how": "keywords（网关检索）",
  "probeId": "1474911",
  "searchSteps": [
    {
      "lane": "keywords",
      "search": "/api/jm/search?q=fate&page=1",
      "gwUrl": "/api/jm/search?q=fate&page=1",
      "status": 200,
      "ms": 888,
      "bytes": 28273,
      "ct": "application/json; charset=utf-8",
      "error": "",
      "items": 80,
      "id": "1474911"
    }
  ],
  "reader": {
    "url": "/api/reader?source=jmcomic&id=1474911",
    "status": 200,
    "ms": 8547,
    "bytes": 8144,
    "error": "",
    "httpError": false,
    "ok": true,
    "jsonError": "",
    "title": "[B_Meow个人汉化][YaM (くなびし)] 乱性エロイカ (Fate/Extra) [中国翻译] [DL版]",
    "pages": 45,
    "chapters": 0,
    "note": "禁漫官方 APP API（www.cdnhjk.net）：/chapter 给页文件名 + 整条 series，/chapter_view_template 给 scramble_id=220980（模板里的 imghost=https://cdn-msp.jmapiproxy1.cc）。这本 aid 1474911 ≥ scramble_id，图片是**分块打乱**的：前端按站点自己的算法（块数 = md5(aid+page) 末位 ASCII 决定 → 分块上下颠倒）用 canvas 还原后才显示。"
  },
  "wallMs": 12036
}
```

### porn-comic（source=porncomic）
- 判定：**在线阅读不可用（/api/reader 没给出页地址）**
- id：`872078` —— 来源：内置已知可用 id（检索这次没给出来）
- 检索取证：
  - keywords · `/api/porncomic/search?q=fate&page=1` → HTTP 502 · 690B · 17.4s · 上游错误=porn-comic 没有取到结果（已试 2 条入口：/q/fate-1.html / /tags/fate.html）：/q/fate-1.html：三条通路都没取到：direct：取不到 porn-comic.com：原路：timeout；直连强化：DoH 没给出能验真的 IP；中继：这条请求带自定义签名头，中继转不了（也不该把你的签名交给第三方）；chrome：Chrome 没能启动（调试端…
- /api/reader `/api/reader?source=porncomic&id=872078` → HTTP 200 · 2ms · 668B
  - ok=false · pages=0 · chapters=0 · title=``
  - error 原文：porn-comic 的正文页整站前置 Cloudflare，网关这次没能过验证：三条通路都没取到：chrome：Cloudflare 刚拒绝了验证，冷却中（还有 90 秒）：Chrome 没能启动（调试端口未就绪）。若网关在沙箱/受限环境里运行，请放行它启动浏览器进程；relay：中继全失败：allorigins 冷却中；allorigins-get 冷却中 —— 页地址只能从条目页 HTML 里读，所以这次给不出 pages（正文图 CDN 本身不需要 CF，实测 200 image/webp 可用）；可以稍后重试（CF 失败后有 90 秒冷却），或换一个出口代理。

```json
{
  "id": "porncomic",
  "name": "porn-comic",
  "source": "porncomic",
  "q": "fate",
  "steps": [],
  "pageProbe": [],
  "verdict": "在线阅读不可用（/api/reader 没给出页地址）",
  "note": "porn-comic 的正文页整站前置 Cloudflare，网关这次没能过验证：三条通路都没取到：chrome：Cloudflare 刚拒绝了验证，冷却中（还有 90 秒）：Chrome 没能启动（调试端口未就绪）。若网关在沙箱/受限环境里运行，请放行它启动浏览器进程；relay：中继全失败：allorigins 冷却中；allorigins-get 冷却中 —— 页地址只能从条目页 HTML 里读，所以这次给不出 pages（正文图 CDN 本身不需要 CF，实测 200 image/webp 可用）；可以稍后重试（CF 失败后有 90 秒冷却），或换一个出口代理。",
  "how": "内置已知可用 id（检索这次没给出来）",
  "probeId": "872078",
  "searchSteps": [
    {
      "lane": "keywords",
      "search": "/api/porncomic/search?q=fate&page=1",
      "gwUrl": "/api/porncomic/search?q=fate&page=1",
      "status": 502,
      "ms": 17417,
      "bytes": 690,
      "ct": "application/json; charset=utf-8",
      "error": "",
      "upstreamError": "porn-comic 没有取到结果（已试 2 条入口：/q/fate-1.html / /tags/fate.html）：/q/fate-1.html：三条通路都没取到：direct：取不到 porn-comic.com：原路：timeout；直连强化：DoH 没给出能验真的 IP；中继：这条请求带自定义签名头，中继转不了（也不该把你的签名交给第三方）；chrome：Chrome 没能启动（调试端口未就绪）。若网关在沙箱/受限环境里运行，请放行它启动浏览器进程；/tags/fate.html：总预算耗尽，未尝试。可用手段：直连 / 境内中继 / 本机 Chrome 过验证 —— 三者都失败时多为出口 IP 被 CF 记恨，换个节点再试",
      "ok": false,
      "id": ""
    }
  ],
  "reader": {
    "url": "/api/reader?source=porncomic&id=872078",
    "status": 200,
    "ms": 2,
    "bytes": 668,
    "error": "",
    "httpError": false,
    "ok": false,
    "jsonError": "porn-comic 的正文页整站前置 Cloudflare，网关这次没能过验证：三条通路都没取到：chrome：Cloudflare 刚拒绝了验证，冷却中（还有 90 秒）：Chrome 没能启动（调试端口未就绪）。若网关在沙箱/受限环境里运行，请放行它启动浏览器进程；relay：中继全失败：allorigins 冷却中；allorigins-get 冷却中 —— 页地址只能从条目页 HTML 里读，所以这次给不出 pages（正文图 CDN 本身不需要 CF，实测 200 image/webp 可用）；可以稍后重试（CF 失败后有 90 秒冷却），或换一个出口代理。",
    "title": "",
    "pages": 0,
    "chapters": 0,
    "note": ""
  },
  "wallMs": 17419
}
```

### LectorManga（source=lectormanga）
- 判定：**在线阅读可用**
- id：`fate-stay-night-full-color` —— 来源：keywords（网关检索）
- 检索取证：
  - keywords · `/api/lectormanga/search?q=fate&page=1` → HTTP 200 · 8808B · 1.5s · id=`fate-stay-night-full-color`
- /api/reader `/api/reader?source=lectormanga&id=fate-stay-night-full-color` → HTTP 200 · 1.3s · 14086B
  - ok=true · pages=62 · chapters=1 · title=`Fate Stay Night Full Color`
  - note：LectorManga（lector-mangas.lat）：作品页 Astro SSR 的 #chapters-list 一次给全量章节清单（实测 naruto 700 话 / tower-of-god 1040 话，服务端渲染、无分页截断），章节页取 class 含 reader-page-img 的 <img src> 当页地址，图床 media.ikigaicomics.lat 必须经 /api/proxy 代取。本次这一话读到 62 页。
- 页 1：上游目标 `https://media.ikigaicomics.lat/capitulos/20316/01M348QE2DKBJGRCMZ89SQGHDT/page_001.webp`
  - 相对地址：`/api/proxy?url=https%3A%2F%2Fmedia.ikigaicomics.lat%2Fcapitulos%2F20316%2F01M348QE2DKBJGRCMZ89SQGHDT%2Fpage_001.webp&referer=https%3A%2F%2Flector-mangas.lat%2Fcomics%2Ffate-stay-night-full-color%2Fcapitulo-1`
  - 第 1 次：HTTP 200 · 108626B · sha256前12=44e647bf1c0c · image/webp · 4.9s
  - 第 2 次：HTTP 200 · 108626B · sha256前12=44e647bf1c0c · image/webp · 1ms
  - 稳定性：两次一致 ✅
- 页 2：上游目标 `https://media.ikigaicomics.lat/capitulos/20316/01M348QE2DKBJGRCMZ89SQGHDT/page_002.webp`
  - 相对地址：`/api/proxy?url=https%3A%2F%2Fmedia.ikigaicomics.lat%2Fcapitulos%2F20316%2F01M348QE2DKBJGRCMZ89SQGHDT%2Fpage_002.webp&referer=https%3A%2F%2Flector-mangas.lat%2Fcomics%2Ffate-stay-night-full-color%2Fcapitulo-1`
  - 第 1 次：HTTP 200 · 180292B · sha256前12=fee6c901a904 · image/webp · 3.6s
  - 第 2 次：HTTP 200 · 180292B · sha256前12=fee6c901a904 · image/webp · 1ms
  - 稳定性：两次一致 ✅
- 页 3：上游目标 `https://media.ikigaicomics.lat/capitulos/20316/01M348QE2DKBJGRCMZ89SQGHDT/page_003.webp`
  - 相对地址：`/api/proxy?url=https%3A%2F%2Fmedia.ikigaicomics.lat%2Fcapitulos%2F20316%2F01M348QE2DKBJGRCMZ89SQGHDT%2Fpage_003.webp&referer=https%3A%2F%2Flector-mangas.lat%2Fcomics%2Ffate-stay-night-full-color%2Fcapitulo-1`
  - 第 1 次：HTTP 200 · 79634B · sha256前12=1b58b6fd119f · image/webp · 2.2s
  - 第 2 次：HTTP 200 · 79634B · sha256前12=1b58b6fd119f · image/webp · 1ms
  - 稳定性：两次一致 ✅

```json
{
  "id": "lectormanga",
  "name": "LectorManga",
  "source": "lectormanga",
  "q": "fate",
  "steps": [],
  "pageProbe": [
    {
      "idx": 0,
      "src": "/api/proxy?url=https%3A%2F%2Fmedia.ikigaicomics.lat%2Fcapitulos%2F20316%2F01M348QE2DKBJGRCMZ89SQGHDT%2Fpage_001.webp&referer=https%3A%2F%2Flector-mangas.lat%2Fcomics%2Ffate-stay-night-full-color%2Fcapitulo-1",
      "alt": "",
      "w": 0,
      "h": 0,
      "target": "https://media.ikigaicomics.lat/capitulos/20316/01M348QE2DKBJGRCMZ89SQGHDT/page_001.webp",
      "fetch": {
        "status": 200,
        "ms": 4877,
        "bytes": 108626,
        "ct": "image/webp",
        "sha": "44e647bf1c0c",
        "htmlish": false,
        "empty": false,
        "error": "",
        "body": ""
      },
      "fetch2": {
        "status": 200,
        "ms": 1,
        "bytes": 108626,
        "ct": "image/webp",
        "sha": "44e647bf1c0c",
        "error": ""
      },
      "stable": true,
      "good": true
    },
    {
      "idx": 1,
      "src": "/api/proxy?url=https%3A%2F%2Fmedia.ikigaicomics.lat%2Fcapitulos%2F20316%2F01M348QE2DKBJGRCMZ89SQGHDT%2Fpage_002.webp&referer=https%3A%2F%2Flector-mangas.lat%2Fcomics%2Ffate-stay-night-full-color%2Fcapitulo-1",
      "alt": "",
      "w": 0,
      "h": 0,
      "target": "https://media.ikigaicomics.lat/capitulos/20316/01M348QE2DKBJGRCMZ89SQGHDT/page_002.webp",
      "fetch": {
        "status": 200,
        "ms": 3608,
        "bytes": 180292,
        "ct": "image/webp",
        "sha": "fee6c901a904",
        "htmlish": false,
        "empty": false,
        "error": "",
        "body": ""
      },
      "fetch2": {
        "status": 200,
        "ms": 1,
        "bytes": 180292,
        "ct": "image/webp",
        "sha": "fee6c901a904",
        "error": ""
      },
      "stable": true,
      "good": true
    },
    {
      "idx": 2,
      "src": "/api/proxy?url=https%3A%2F%2Fmedia.ikigaicomics.lat%2Fcapitulos%2F20316%2F01M348QE2DKBJGRCMZ89SQGHDT%2Fpage_003.webp&referer=https%3A%2F%2Flector-mangas.lat%2Fcomics%2Ffate-stay-night-full-color%2Fcapitulo-1",
      "alt": "",
      "w": 0,
      "h": 0,
      "target": "https://media.ikigaicomics.lat/capitulos/20316/01M348QE2DKBJGRCMZ89SQGHDT/page_003.webp",
      "fetch": {
        "status": 200,
        "ms": 2213,
        "bytes": 79634,
        "ct": "image/webp",
        "sha": "1b58b6fd119f",
        "htmlish": false,
        "empty": false,
        "error": "",
        "body": ""
      },
      "fetch2": {
        "status": 200,
        "ms": 1,
        "bytes": 79634,
        "ct": "image/webp",
        "sha": "1b58b6fd119f",
        "error": ""
      },
      "stable": true,
      "good": true
    }
  ],
  "verdict": "在线阅读可用",
  "note": "",
  "how": "keywords（网关检索）",
  "probeId": "fate-stay-night-full-color",
  "searchSteps": [
    {
      "lane": "keywords",
      "search": "/api/lectormanga/search?q=fate&page=1",
      "gwUrl": "/api/lectormanga/search?q=fate&page=1",
      "status": 200,
      "ms": 1527,
      "bytes": 8808,
      "ct": "application/json; charset=utf-8",
      "error": "",
      "items": 24,
      "id": "fate-stay-night-full-color"
    }
  ],
  "reader": {
    "url": "/api/reader?source=lectormanga&id=fate-stay-night-full-color",
    "status": 200,
    "ms": 1320,
    "bytes": 14086,
    "error": "",
    "httpError": false,
    "ok": true,
    "jsonError": "",
    "title": "Fate Stay Night Full Color",
    "pages": 62,
    "chapters": 1,
    "note": "LectorManga（lector-mangas.lat）：作品页 Astro SSR 的 #chapters-list 一次给全量章节清单（实测 naruto 700 话 / tower-of-god 1040 话，服务端渲染、无分页截断），章节页取 class 含 reader-page-img 的 <img src> 当页地址，图床 media.ikigaicomics.lat 必须经 /api/proxy 代取。本次这一话读到 62 页。"
  },
  "wallMs": 13549
}
```