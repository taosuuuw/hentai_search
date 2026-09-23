# 阅读器：放大后图片跑位 + 任意倍率拖拽 —— 修复记录

## 用户提的两个问题（原话）
1. 「在线阅读放大后图片位置会改变，我希望保持在原位，并且不会影响缩小图片。」
2. 「在线阅读放大和缩小包括100%，或则说任何大小下都要实现按住鼠标拖拽图片的功能。」

---

## 一、先测量，再动手

真机木偶（CDP + **真鼠标事件**，不是合成事件）：

| 脚本 | 覆盖 |
|---|---|
| `tools/ui-truth-steps.js` | 横向单页 `dir='h'` |
| `tools/reader-zoom-steps.js` | **纵向连续 `dir='v'`（默认模式，用户症状最可能出处）** + 横向对照 |

用法：
```powershell
$env:HS_RD_TAG='v3'
node tools/live-probe.js --steps=tools/reader-zoom-steps.js --w=1280 --h=900 --wait=1500
```
产出：`tools/reader-zoom-v1.json` / `-v2.json` / `-v3.json`、`tools/ui-truth-cur1.json`。
（跑 `live-probe.js` 需要 danger-full-access —— Chrome 在 workspace-write 下会被沙箱杀掉。）

**测量手法（这一点决定了能不能测出真问题）：**
不是量「图片矩形变没变」，而是**给视口正中那张图的某个物理分数点打 pin，缩放后量这个点跑到哪**（dx / dy / d）。
这才是用户说「位置变了」时看到的东西；图片矩形本身在缩放时必然变大，量它只会得出噪音。

---

## 二、根因：纵向模式几乎**完全没有**锚点补偿

1. `currentPageEl()` 只认 `.hs-rd-pg.is-cur`，而**纵向模式从来没有人写这个类** ⇒ 恒为 `null`
   ⇒ `zoomAnchor()` 直接 `return null` ⇒ 纵向放大**一点补偿都没有**。
2. `zoomAnchorApply()` 老代码在横向模式下横向走 `hBoxFor`（对），纵向却走 `vBoxFor`；
   h 模式下 `vBoxFor` 的候选（`.hs-rd-scroll` / `.hs-rd-col`）全是 `overflow:hidden`、零余量，
   兜底返回的元素**根本不滚** ⇒ 纵向补偿是空操作。
   
   ⇒ 用户看到的「左右翻页模式下放缩还是位移」，就是这两条叠加。

而横向单页模式本来补偿是对的（实测中心锚点漂移 0.16–0.27px），
所以只测横向**永远测不出这个 bug** —— 这也是为什么非要新写一个纵向脚本。

---

## 三、修复（`assets/js/reader.js`）

| 位置 | 改动 |
|---|---|
| `anchorPageEl()` :842 | 新增。取**真正盖住视口正中**的那一页（没有页盖住正中就取中心最近的一页），不再依赖 `.is-cur` |
| `zoomAnchor()` :861 | 锚点改用 `anchorPageEl()`，返回视口正中对应的分数点 `(fx, fy)` |
| `zoomAnchorApply(a)` :884 | 统一用 `scrollPair()` 解 x / y 两个滚动盒（函数注释里写明了老代码为什么错） |
| `zoomAnchorResidual(a)` :902 | 页盒滚不动时用位移补残差，并夹在「画面仍盖住页盒」的区间内（页盒 `overflow:hidden`，顶出去会把画面裁掉一条） |
| `markCurV(i)` :1346 | 纵向模式把 `.is-cur` 标到 `currentIndex()` 那一页（横向由 `paintHPage()` 负责）—— 补上第 1 条根因 |
| `setZoom(v, quiet)` :938 | **刻意不对 `next === S.zoom` 早退**（否则点 100% 会跳回正中） |

## 四、拖拽（任意倍率）

| 位置 | 行为 |
|---|---|
| `panPrepareShift(e)` :1568 | 分两分支：有余量就走滚动（`scrollLeft = pan.l - dx`），**两轴都没余量才走图片 transform** |
| `panStart(e)` :1596 | **不要求已放大**、不排除 `img` / `a` —— 满足「100% 也要能拖」 |
| `panEnd()` :1658 | 抬手**保留**位移（旧版 220ms 弹回） |
| `clearPanShift()` :1556 | 换倍率 / 换页 / 重开时清零 |
| 配套 | `softPan()` :1533 橡皮筋、`panShiftApply()` :1548 写 `translate3d`、`scrollPair()` :1515 解滚动盒 |

原生图片拖拽（浏览器那个「拖出一张幽灵图」）另有处理，与本次无关：
`img.draggable = 'false'`（`assets/js/reader.js`）+ CSS `-webkit-user-drag: none`（`assets/css/style.css`）。

---

## 五、回归

`tools/reader-check.js` **42 条**（原 38 条，本轮新增 4 条）。

⚠ 该套件的断言主要是**源码文本级**（`read` / `codeOnly` / `fnBody`），全绿 ≠ 真机行为正确。
所以这次是「源码断言 + 真机木偶测量」两层一起上：源码断言防回归，真机 JSON 取证证明行为。

`node tools/check-all.js` ⇒ 8 套件 / 302 条断言全绿（含 `gateway-check.js`）。
