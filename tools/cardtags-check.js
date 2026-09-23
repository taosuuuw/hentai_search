#!/usr/bin/env node
/*
 * cardtags.js 的接线自检（纯本地、不联网）
 * ---------------------------------------------------------------------------
 * 固化一条教训：**代码改了但发出去的请求没变**是常态（LESSONS §3-13），
 * 所以「卡片标签补全」这种「一个源一条通路」的东西必须证明**每个源实际打到哪个接口、
 * 参数是什么、回来怎么映射**，而不是读一遍代码就宣布能用。
 *
 * 用法： node tools/cardtags-check.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { loadSite } = require('./concept-check-shim.js');

const ROOT = path.resolve(__dirname, '..');

const env = loadSite([
  'assets/js/core.js', 'assets/js/dict.js', 'assets/js/net.js',
  'assets/js/sources.js', 'assets/js/cardtags.js'
]);
const HS = env.HS;

/* ---------------------------------------------------------------------------
 * 第二个沙箱：词典层（dict-hint + 本地 IP 包）+ 排序层（results.js）+ 绅士源。
 * ⑤ bug A（单字角色检索排序）与 ⑥ bug B（绅士标签）都在这上面验。
 * fetch 只读仓库里的文件（assets/dict/**），网关响应全部手工构造 —— 一个上游都不打。
 * ------------------------------------------------------------------------- */
const env2 = loadSite([
  'assets/js/core.js', 'assets/js/dict.js', 'assets/dict/core.js',
  'assets/js/dict-hint.js', 'assets/js/net.js', 'assets/js/sources.js', 'assets/js/results.js'
]);
env2.fetch = function (url) {
  const rel = String(url).replace(/^\.?\//, '').split('?')[0];
  try {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    return Promise.resolve({
      ok: true, status: 200,
      text: () => Promise.resolve(text),
      json: () => Promise.resolve(JSON.parse(text))
    });
  } catch (e) {
    return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve(''), json: () => Promise.reject(e) });
  }
};
const HS2 = env2.HS;

if (!HS.cardTags) { console.error('FAIL: HS.cardTags 没挂上（cardtags.js 没被加载？）'); process.exit(1); }

const calls = [];
HS.net.gateway.ok = true;
HS.net.gateway.get = async function (path, params) {
  calls.push({ path: path, params: params });
  if (path === '/api/tags') {
    return { ok: true, source: params.source, tags: ['日不落', '雌懸浮', '蘿莉'] };
  }
  const url = String((params || {}).url || '');
  if (url.indexOf('/api/v2/galleries/') >= 0) {
    return { tags: [
      { type: 'tag', name: 'big breasts' }, { type: 'language', name: 'english' },
      { type: 'character', name: 'Nian' }, { type: 'category', name: 'doujinshi' }
    ] };
  }
  if (url.indexOf('pixiv.net/ajax/illust/') >= 0) {
    return { body: { tags: { tags: [{ tag: 'ネプテューヌ' }, { tag: '寝る' }] } } };
  }
  if (url.indexOf('mangadex.org/manga/') >= 0) {
    return { data: { attributes: { tags: [{ attributes: { name: { en: 'Comedy' } } }] } } };
  }
  return {};
};

let bad = 0;
function ok(name, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + name + (extra ? '   ' + extra : ''));
  if (!cond) bad++;
}

async function main() {
  const got = {};
  function grab(src, id) {
    /* ★回调可能是**同步**的★（命中缓存时 enrich 立刻 done）—— 所以回调里绝不能引用
       enrich 的返回值（那会在赋值前被访问，TDZ 报错）。这里只靠回调本身判定成功。 */
    return new Promise(resolve => {
      const started = HS.cardTags.enrich({ source: src, id: id }, t => { got[src] = t; resolve(true); });
      if (started === false) resolve(false);
    });
  }

  /* ① 走网关 /api/tags 的三个源 */
  await grab('jmcomic', '480715');
  await grab('copymanga', 'cxgxl');
  await grab('ehentai', '4109923-e8a290c9df');
  const tagsCalls = calls.filter(c => c.path === '/api/tags');
  ok('jmcomic / copymanga / ehentai 都走网关 /api/tags',
    tagsCalls.length === 3 && tagsCalls.map(c => c.params.source).join(',') === 'jmcomic,copymanga,ehentai',
    JSON.stringify(tagsCalls.map(c => c.params.source + ':' + c.params.id)));
  ok('jmcomic 回来了 3 个标签', (got.jmcomic || []).length === 3, JSON.stringify(got.jmcomic));

  /* ② 走 /api/proxy 的三个源 + Referer 必须显式带 */
  await grab('nhentai', '682554');
  await grab('mangadex', '5cfad028-38b1-4f50-a282-70ac438fa91a');
  await grab('pixiv', '149099335');
  const proxyCalls = calls.filter(c => c.path === '/api/proxy');
  ok('nhentai / mangadex / pixiv 都走 /api/proxy', proxyCalls.length === 3,
    JSON.stringify(proxyCalls.map(c => String(c.params.url).replace(/^https:\/\//, '').slice(0, 26))));
  ok('每个 /api/proxy 都显式带了 referer',
    proxyCalls.every(c => /^https?:\/\//.test(String(c.params.referer || ''))),
    JSON.stringify(proxyCalls.map(c => c.params.referer)));
  ok('nhentai：丢掉 language / category，保留 tag / character',
    JSON.stringify(got.nhentai) === JSON.stringify(['big breasts', 'Nian']), JSON.stringify(got.nhentai));
  ok('mangadex：取 name.en', JSON.stringify(got.mangadex) === JSON.stringify(['Comedy']), JSON.stringify(got.mangadex));
  ok('pixiv：body.tags.tags[].tag', JSON.stringify(got.pixiv) === JSON.stringify(['ネプテューヌ', '寝る']), JSON.stringify(got.pixiv));

  /* ③ 没有取法的源：一个请求都不发 */
  const before = calls.length;
  const w = await grab('wnacg', '12345');
  ok('wnacg（未接）不发任何请求、回调不触发', w === false && calls.length === before, 'enrich 返回 ' + w);
  ok('has() 与 SRC 表一致', HS.cardTags.has('jmcomic') === true && HS.cardTags.has('wnacg') === false &&
    HS.cardTags.has('nhentai') === true);

  /* ④ 缓存：同一个作品第二次不再打上游 */
  const before2 = calls.length;
  await grab('jmcomic', '480715');
  ok('第二次同一个作品命中缓存（不再发请求）', calls.length === before2 && (got.jmcomic || []).length === 3);

  /* ======================================================================
     ⑤ bug A：单字角色检索要把「角色本人的作品」排到前面
     用户原话：「游戏角色的单字检索貌似总是无法首先展示角色的作品，需要修正」。
     两个机制性原因（都在 results.js，全部用真实代码路径验，条目是手工构造的假条目）：
       · 「年」这类写法的角色作品（年と私 / 年の秘書）原先因为**假名算粘连**被判成「系列档」；
       · 「林」这类只在懒加载 IP 词典里的单字名，core.js 根本不认识 ⇒ 角色档完全不生效，
         噪声（林檎 / 森林浴）反而靠系列命中的字面分支拿到 +9。
     ====================================================================== */
  {
    const B = HS2, uB = B.u, RB = B.results, SB = B.sources;
    const mkB = (source, id, title, tags) => SB.mk({ source: source, id: String(id), title: title, tags: tags || [], nsfw: true });
    let reloads = 0, rendered = null;
    RB.render = function (res) { reloads++; rendered = res; };   /* 拦下重画：node 里没有真 DOM */
    function rank(q, items) {
      RB.q = q; RB.f = {}; RB.intent = uB.classifyQuery(q);
      RB.page = 1; RB.appendMode = false; RB.streaming = false;
      const raw = [{ ok: true, items: items.map(x => x) }];
      RB.raw = raw;
      RB.items = RB.combine(raw, q, {});
      const out = RB.applyView();
      return { raw: raw, out: out, tiers: out.map(it => it._charTier), titles: out.map(it => it.title) };
    }

    /* ---- 「林」：core.js 的 5 个名字之外的单字名（只有 IP 词典里有） ---- */
    const lin = () => [
      mkB('jmcomic', 910004, '森林浴', []),
      mkB('wnacg', 910005, '[明日方舟] 適当な日常', ['明日方舟']),
      mkB('nhentai', 910003, '林檎の誘惑', []),
      mkB('jmcomic', 910002, '[アークナイツ] 林と過ごす夜', ['アークナイツ']),
      mkB('nhentai', 910001, "Lin's Night Shift (Arknights)", ['arknights'])
    ];
    const cold = rank('林', lin());
    ok('林（词典包还没到）：一个区都不分、旧次序不动（冷查询不把无关结果排乱）',
      cold.tiers.join('') === '00000', JSON.stringify(cold.tiers));
    ok('林（词典包还没到）：角色本人的英文写法仍排在最后（就是 bug A 的现象）',
      cold.titles[cold.titles.length - 1] === "Lin's Night Shift (Arknights)", cold.titles.join(' | '));

    /* 冷启动时 combine 里已经请了一次懒加载：等它回来 */
    await new Promise(resolve => setTimeout(resolve, 200));
    ok('单字的词典包由「结果里出现的系列写法」触发懒加载（裸单字不是锚点）',
      (B.dict.loaded() || []).indexOf('arknights') >= 0, JSON.stringify(B.dict.loaded()));
    ok('词典到齐后自动重排一次（R.render 被回调）', reloads >= 1, 'reloads=' + reloads);
    ok('重排用的是同一次检索的原始响应（R.raw）', rendered === cold.raw);

    const warm = rank('林', lin());
    ok('林（词典到齐）：角色本人的作品进「真角色档」并占了前两名',
      warm.tiers.slice(0, 2).join('') === '33' &&
      /林と過ごす夜/.test(warm.titles[0]) && /Lin's Night Shift/.test(warm.titles[1]),
      JSON.stringify(warm.titles));
    ok('林（词典到齐）：系列泛内容 / 字面命中都排在角色作品之后',
      warm.titles.slice(2).every(t => /適当|林檎|森林浴/.test(t)), JSON.stringify(warm.tiers));

    /* ---- 「年」：core.js 里就有的角色（与词典无关） ---- */
    const nian = () => [
      mkB('nhentai', 900007, 'Totally Unrelated Comic', ['big breasts']),
      mkB('nhentai', 900006, '2026年7月号', []),
      mkB('jmcomic', 900005, '[無修正] 年上の彼女', []),
      mkB('wnacg', 900004, '[明日方舟] アーミヤと博士', ['明日方舟']),
      mkB('jmcomic', 900003, '[アークナイツ] 年の秘書', ['アークナイツ']),
      mkB('wnacg', 900002, '[明日方舟] 年と私', ['明日方舟']),
      mkB('nhentai', 900001, "Nian's Sex Addiction (Arknights)", ['arknights'])
    ];
    const ny = rank('年', nian());
    ok('年：日文写法（年と私 / 年の秘書）与英文写法都进真角色档，占了前三名',
      ny.tiers.slice(0, 3).join('') === '333', JSON.stringify(ny.tiers));
    ok('年：年上 / 2026年7月号 仍留在字面档（放宽的是假名粘连，不是汉字粘连）',
      ny.tiers[4] === 1 && ny.tiers[5] === 1 && ny.tiers[6] === 0, JSON.stringify(ny.tiers));
    ok('非角色查询（明日方舟）一个区都不分：排序口径与本轮修改前一致',
      rank('明日方舟', nian()).tiers.join('') === '0000000');
    ok('查询「年上」不会被当成角色「年」（词典命中必须整串相等）',
      rank('年上', nian()).tiers.join('') === '0000000');

    /* ---- 「锏」：词典里有单字条目（degenbrecher） ---- */
    const jian = rank('锏', [
      mkB('jmcomic', 920001, '黑騎士の日常', []),
      mkB('wnacg', 920003, '[明日方舟] 適当な日常', ['明日方舟']),
      mkB('nhentai', 920002, "Degenbrecher's Blow (Arknights)", ['arknights'])
    ]);
    ok('锏：词典条目 degenbrecher → 英文写法的作品进真角色档并升到第一',
      jian.tiers[0] === 3 && /Degenbrecher/.test(jian.titles[0]),
      JSON.stringify(jian.tiers) + ' ' + jian.titles.join(' | '));

    /* ---- 已知缺口：山 / 黑 在 assets/dict 里没有单字条目（该目录只读） ---- */
    const shan = rank('山', [
      mkB('jmcomic', 930001, '山奥の温泉', []),
      mkB('nhentai', 930002, "Mountain's Embrace (Arknights)", ['arknights'])
    ]);
    ok('已知缺口：山 / 黑 在词典里没有单字条目 → 仍不分档（assets/dict 只读，本轮无法覆盖）',
      shan.tiers.join('') === '00', JSON.stringify(shan.tiers));
  }

  /* ======================================================================
     ⑥ bug B：绅士（wnacg）大小卡片的作品标签
     两个根因：
       · 浏览器解析 wnParse 原先只写 `strip`（只有分类索引检索才有值）⇒ 关键词检索恒无标签；
       · 网关条目只有分类号 `cate`，前端读的是 r.cats / r.tags ⇒ 字段名不同，被静默丢掉。
     这两条都只改 assets/js/sources.js（卡片/放大器吃的就是 it.tags，见 results.js 的
     `(it.srcTags && it.srcTags.length) ? it.srcTags : it.tags`）。
     ====================================================================== */
  {
    const SB = HS2.sources;
    const blk1 = '<li class="gallary_item"><div class="pic_box cate-7">' +
      '<a href="/photos-index-aid-123.html" title="[中文] 測試本"><img data-src="//img.wn/1.jpg"></a></div>' +
      '<div class="gallary_item_bot"><p class="gallary_title"><a href="/photos-index-aid-123.html">[中文] 測試本</a></p>' +
      '<p class="gallary_tags"><a href="/albums-index-tag-%E4%B8%AD%E6%96%87.html">中文</a>' +
      '<a href="/albums-index-tag-%E5%B7%A8%E4%B9%B3.html"></a></p></div></li>';
    const blk2 = '<li class="gallary_item"><div class="pic_box"><a href="/photos-index-aid-456.html">' +
      '<img data-src="//img.wn/2.jpg"></a></div><p class="gallary_title">' +
      '<a href="/photos-index-aid-456.html">没有标签的一条</a></p></li>';
    ok('wnacg：分类号 cate-N 映射成与分类索引同一个标签词（cate-7 → oneshot）',
      JSON.stringify(SB.wnTags(blk1, '')) === JSON.stringify(['oneshot', '中文', '巨乳']),
      JSON.stringify(SB.wnTags(blk1, '')));
    ok('wnacg：标签链接文字为空时用地址里的标签名（decodeURIComponent 解出「巨乳」）',
      SB.wnTags(blk1, '').indexOf('巨乳') >= 0);
    ok('wnacg：分类索引检索的 strip 仍排在最前，且不重复',
      JSON.stringify(SB.wnTags(blk1, 'hanman')) === JSON.stringify(['hanman', 'oneshot', '中文', '巨乳']),
      JSON.stringify(SB.wnTags(blk1, 'hanman')));
    ok('wnacg：标签只来自本条作品自己的块（邻条没有标签时不会串味）',
      JSON.stringify(SB.wnTags(blk2, '')) === '[]', JSON.stringify(SB.wnTags(blk2, '')));
    const child = { outerHTML: '<a href="/photos-index-aid-123.html">[中文] 測試本</a>', parentElement: null };
    const parent = { outerHTML: blk1, parentElement: null };
    child.parentElement = parent;
    ok('wnacg：wnBlockTags 从标题节点往上找到自己那一块（最多 3 层）',
      JSON.stringify(SB.wnBlockTags(child, '')) === JSON.stringify(['oneshot', '中文', '巨乳']),
      JSON.stringify(SB.wnBlockTags(child, '')));
    ok('wnacg：往上 3 层都没有标签时退回节点自身（不会一路爬到列表容器）',
      JSON.stringify(SB.wnBlockTags({ outerHTML: blk2, parentElement: null }, '')) === '[]');

    const src = fs.readFileSync(path.join(ROOT, 'assets/js/sources.js'), 'utf8');
    ok('wnacg：浏览器路径的两处 push 都已接线到 wnBlockTags（静态）',
      (src.match(/tags: wnBlockTags\(a, strip\)/g) || []).length === 2 &&
      src.indexOf('strip ? [strip] : []') < 0);

    /* 网关路径：假响应里带分类号（tools/gateway.js 的 wnParseItems 就是这么回的） */
    let gwCalled = 0;
    HS2.net.gateway = {
      ok: true,
      get: function () {
        gwCalled++;
        return Promise.resolve({ ok: true, items: [
          { id: '123', title: '[中文] 測試本', cover: '', cate: '7' },
          { id: '124', title: '没有分类号的一条', cover: '' }
        ] });
      }
    };
    const got = await SB.byId.wnacg.search({ q: '中文', f: {}, limit: 3, intent: HS2.u.classifyQuery('中文') });
    ok('wnacg：网关条目只用 /api/wnacg/search 一次就够（不打上游，假响应）', gwCalled === 1, 'gwCalled=' + gwCalled);
    ok('wnacg：网关条目的 cate 字段 → 标签（字段名不同这条根因）',
      JSON.stringify((got[0] || {}).tags) === JSON.stringify(['oneshot']) &&
      (got[0].cats || []).indexOf('oneshot') >= 0,
      JSON.stringify(got.map(it => it.tags)));
    /* 注意：cats 里的 comic 是 sources.js:29-34 的 inferCats 兜底推断（既有的、与本次改动无关的
       行为：没有 tags/cats/pages 时补一个 comic），所以这里只断言「不会凭空多出分类号标签」。 */
    ok('wnacg：没有 cate 的条目不会凭空多出分类号标签（cats 仍只由既有的 inferCats 推断）',
      JSON.stringify((got[1] || {}).tags) === '[]' && (got[1].cats || []).indexOf('oneshot') < 0,
      JSON.stringify(got.map(it => it.tags)) + ' ' + JSON.stringify(got.map(it => it.cats)));
  }

  console.log(bad ? ('\n' + bad + ' 条断言失败') : '\n全部通过');
  process.exit(bad ? 1 : 0);
}
/* 守卫：直接 `node tools/cardtags-check.js` 才跑；被 require（tools/check-all.js 汇总跑）
   时只交出 main，避免同一进程里被自动跑一次、再被调用一次 = 断言翻倍且互相污染。 */
if (require.main === module) main().catch(e => { console.error(e && e.stack || e); process.exit(1); });
module.exports = { main };
