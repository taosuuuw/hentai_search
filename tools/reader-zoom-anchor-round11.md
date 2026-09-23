# 第 11 轮：阅读器（左右翻页 h 模式）缩放保位 + 任意大小拖拽 —— 定稿记录

日期：2026-09-23　范围：`assets/js/reader.js` + `tools/reader-check.js` + 新探针
验收方式：真机 Chrome（CDP 真鼠标）实测 + `node tools/check-all.js` 回归

## 一、用户提的两条需求与实测口径

| 需求 | 判定口径 | 结果 |
|---|---|---|
| 1. 任意大小图片都能按住拖 | 真鼠标按下→移动→抬起，量「被按住的那个内容点」是否跟着鼠标走（逐轴 ≤8px） | **10/10 跟手**（50% / 100% / 140% / 300%，含在图片外空白处按下） |
| 2. 放大缩小位置不变 | 锚点钉在**视口正中 (640,450)**，量「缩放前落在该点的内容点」缩放后漂了多远（<4px） | 纯缩放 110 点 **最大 1.61px**；先拖再缩放 **最大 3.7px** |

关键：口径必须是「视口中心不变量」。早先用「按画面分数钉锚点」量，会把**固有放大位移**（离中心越远的点本来就按 (分数−0.5)×Δ尺寸 走掉，那是「变大」不是 bug）算成缺陷，导致误判。偏心屏幕点 (1000,700) 只作参考量：179.6px，符合「钉中心口径下的固有放大」。

## 二、改了什么（`assets/js/reader.js`）

1. **`paintZoom()` 不再 `clearPanShift()`**（`assets/js/reader.js:787` 起）
   换倍率必须**保住**用户拖到的位置；复位动作只留给换页 `goToIndex()`（`assets/js/reader.js:1396`）与重新打开 `RD.open()`（`assets/js/reader.js:1866`，在 `paintZoom()` 之前显式调用一次）。
   根因：100% 且 h 模式时页盒两轴余量为 0 ⇒ 拖拽只能走 `<img>` 的 transform 档（`panPrepareShift`：`pan.shift = !pan.sx && !pan.sy`）；旧 `paintZoom()` 清位移 + 把 `panOffset` 归零，画面瞬间弹回正中，随后 `zoomAnchorApply()` 想用 scrollLeft 补而 scrollLeft 已是 0 ⇒ 5 种形状全部漂 47.7~49.6px。

2. **`zoomAnchorResidual()` 的 gap 夹取加「这一轴确实盖住页盒」的前提**（`assets/js/reader.js` 约 947-963 行）
   ```js
   const coverX = p.left <= b.left + 0.5 && p.left + p.w >= b.right - 0.5;
   const coverY = p.top  <= b.top  + 0.5 && p.top  + p.h >= b.bottom - 0.5;
   if (!allowX) dx = panOffset.x;
   else if (coverX) dx = Math.max(Math.min(gx, hx), Math.min(Math.max(gx, hx), dx));
   ```
   理由：画面比页盒小的那一轴（≤100% 的留白轴）本来就没有「盖住」可言，硬夹会把位移拉回 0 —— 实测 100% 拖 (130,95) → 300% → 缩回 100%：竖图漂 **45.18px**、横图漂 **105.76px**（横图 x 轴正好填满页盒 ⇒ 夹取区间塌成 [0,0]，130px 位移被整个抹掉），修后 100% 那一步 **0.31px**。

## 三、验收证据（`tools/reader-anchor-offcenter-steps.js`，1280×900，h 模式）

形状：portrait 1000×1400 / landscape 1600×900 / square 1200×1200 / ultrawide 2400×700 / tiny 420×300

- **A 纯缩放**（100→300→50 全档 110 点）：最大 **1.61px**（landscape@300%），超 4px 清单为空 ⇒ 需求 2 成立。
- **B 先拖 (130,95) 再缩放全档**：最大 **3.7px**（landscape@300%）；跨回 100% 那一步 **0.31px**（修前 45.18 / 105.76）。
- **D 真鼠标拖拽**：10 次 0 次不跟手（50/100/140/300% + 图外空白处按下）⇒ 需求 1 成立。
- A′ 偏心屏幕点观察量 179.6px（固有放大，不作判据）。
- C 裁切只在 `dragBack@100%` 报 45.1 / 106.1 —— 用户自己把图拖到页盒外、超出部分被容器裁掉，符合拖拽语义（y 向留白 25px，拖 95px 就有 70px 出去）。

复现：
```powershell
# 全量（约 6 分钟，需 danger-full-access：workspace-write 下 Chrome/node 会被沙箱拒）
node tools/live-probe.js --url=http://127.0.0.1:8788/ --steps=tools/reader-anchor-offcenter-steps.js --w=1280 --h=900 --wait=1500 *> tools/_anchor-out2.txt
# 快速模式（只跑 B 前 4 档，约 40 秒）：先 $env:HS_QS='1'
node tools/check-all.js      # 8 套件 / 329 条断言，失败 0
```
输出留档：`tools/_anchor-out.txt`、`tools/_anchor-out2.txt`、`tools/_ab-before.txt`、`tools/_ab-after.txt`、`tools/_ab-after2.txt`。

## 四、回归断言（`tools/reader-check.js`，49 条）

- 新增 `const open = codeOnly(fnBody(JS, 'RD.open'));`；`fnBody()` 正则加可选 `async`：`(?:function\s+N\s*\(|N\s*=\s*(?:async\s+)?function\s*\()`（不加取不到 `RD.open = async function (item)` 的函数体）。
- `缩放：换倍率**不再**清拖拽位移` ⇒ `!/clearPanShift\(\)/.test(paintZoom)`。
- `复位只发生在换页 / 重新打开` ⇒ `/clearPanShift\(\)/.test(goToIndex) && /clearPanShift\(\)/.test(open)`。
- 新增 `夹取前先判「这一轴盖住页盒了吗」`（覆盖 coverX/coverY 与 `else if (coverX)/(coverY)` 写法）。
- `node tools/check-all.js` ⇒ concept 41 / cardtags 33 / scroll 39 / glass 70 / **reader 49** / recent 28 / dict 28 / gateway 41，**失败 0**。

## 五、给下一轮的入口 / 已知边界

- 若用户仍报「没效果」，第一嫌疑是**浏览器标签页还跑着修复前的旧 JS**：`index.html` 的 19 个 `<script src="assets/js/*.js">` 没有版本查询串，静态资源是 `Cache-Control: no-cache` 但**页面不刷新就不会重取** ⇒ 请硬刷新（Ctrl+F5）或重开页面。
- v 模式（上下滚动）的缩放漂移未在本次范围内（用户明确说「左右翻页的模式」），第二发探针曾记录 v 模式有 98~797px 的漂移。
- 本轮未做需求 3（11 个信息源的连通率/延迟/稳定性）。
