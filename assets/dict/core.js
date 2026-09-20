/* ==========================================================================
   assets/dict/core.js — 黑话词典「核心层」（纯数据，不含逻辑）
   ---------------------------------------------------------------------------
   由项目维护者手工维护。词条**只用于产出提示**，绝不参与查询改写：
     · 判定是纯旁路，用户不点提示，发往上游的查询串一个字节都不会变（C1）。
     · 本文件是传统 <script>（非 ES Module），在首屏同步赋值 HS.LEXICON，
       所以 HS.dict.lookup() 在任何时刻都能立即回答，不必处理异步竞态。
     · 词典任何状态（缺失 / 损坏 / 版本旧）都不得影响检索行为（C4）。
   字段约定（本文件即契约，不依赖任何外部文档）：
     from 必填（用户可能输入的表面形式）；to 必填且只有一个键（concept / genre /
     series / character / term …）；kind 与 to 的键一致；label 给人看的中文；
     conf 0~1 先验置信度（**决定档位**，缺省 0.5 必落兜底档）；ambiguous=true 则
     永不主动提示；why 显示在 chip 的 title / aria 里。
   本层只收「公共黑话」；IP / 作品专属词条放 assets/dict/ip/*.json，按锚点门控。
   ========================================================================== */
(function (HS) {
  'use strict';
  if (!HS) return;

  HS.LEXICON = {
    schema: 1,
    ver: '2026.02.0',
    updated: '2026-02-14',

    /* 谐音 / 避讳归一化：把用户写法指向规范写法，规范写法的词条再走 entries。
       归一化只为「判定」服务，不产出给用户的词 —— 命中后回报的 from / span
       始终取自用户原文。 */
    homophone: {
      '社保': '射爆',
      '蛇爆': '射爆',
      '设爆': '射爆',
      '烧鸡': '骚鸡',
      '烧姬': '骚鸡',
      '炼铜': '恋童',
      '炼童': '恋童',
      '恋铜': '恋童'
    },

    /* 黑话词条：from 是用户在搜索框里可能输入的表面形式 */
    entries: [
      /* ---------- 谐音 / 避讳（概念） ---------- */
      { from: '社保', to: { concept: 'bukkake' }, kind: 'concept', label: '射爆 / 颜射', conf: 0.9, ambiguous: false, why: '「社保」是「射爆」的谐音，贴吧与群聊里的常用避讳', scope: 'zh-internet' },
      { from: '射爆', to: { concept: 'bukkake' }, kind: 'concept', label: '射爆 / 颜射', conf: 0.88, ambiguous: false, why: '「射爆」是「颜射」的夸张说法', scope: 'zh-internet' },
      { from: '骚鸡', to: { concept: 'slut' }, kind: 'concept', label: '骚鸡 / 淫荡', conf: 0.85, ambiguous: false, why: '「骚鸡」是对淫荡或主动挑逗一方的戏称', scope: 'zh-internet' },
      { from: '手冲', to: { concept: 'masturbation' }, kind: 'concept', label: '手冲 / 自慰', conf: 0.8, ambiguous: true, why: '「手冲」是「手淫」的谐音，但也是手冲咖啡', scope: 'zh-internet' },
      { from: '打飞机', to: { concept: 'masturbation' }, kind: 'concept', label: '打飞机 / 自慰', conf: 0.88, ambiguous: false, why: '「打飞机」是男性自慰的俗称', scope: 'zh-internet' },
      { from: '打手枪', to: { concept: 'masturbation' }, kind: 'concept', label: '打手枪 / 自慰', conf: 0.85, ambiguous: false, why: '「打手枪」是男性自慰的俗称', scope: 'zh-internet' },
      { from: '白浊', to: { concept: 'cum' }, kind: 'concept', label: '白浊 / 精液', conf: 0.85, ambiguous: false, why: '「白浊」是精液的书面化避讳说法', scope: 'zh-internet' },
      { from: '吞精', to: { concept: 'cum' }, kind: 'concept', label: '吞精 / 精液', conf: 0.8, ambiguous: false, why: '「吞精」指吞下精液，常与口交题材同现', scope: 'zh-internet' },
      { from: '圣水', to: { concept: 'urination' }, kind: 'concept', label: '圣水 / 放尿', conf: 0.85, ambiguous: false, why: '「圣水」是尿液的委婉说法', scope: 'zh-internet' },
      { from: '奶水', to: { concept: 'lactation' }, kind: 'concept', label: '奶水 / 泌乳', conf: 0.88, ambiguous: false, why: '「奶水」即乳汁，圈内用于泌乳题材', scope: 'zh-internet' },
      { from: '西瓜肚', to: { concept: 'pregnant' }, kind: 'concept', label: '西瓜肚 / 怀孕', conf: 0.85, ambiguous: false, why: '「西瓜肚」形容孕晚期圆滚的肚子', scope: 'zh-internet' },
      { from: '怀胎', to: { concept: 'pregnant' }, kind: 'concept', label: '怀胎 / 怀孕', conf: 0.85, ambiguous: false, why: '「怀胎」即怀孕', scope: 'zh-internet' },
      { from: '素股', to: { concept: 'thigh' }, kind: 'concept', label: '素股 / 腿交', conf: 0.85, ambiguous: false, why: '「素股」是日式说法，指大腿夹持的性行为', scope: 'ja-internet' },
      { from: '口爆', to: { concept: 'fellatio' }, kind: 'concept', label: '口爆 / 口交', conf: 0.8, ambiguous: false, why: '「口爆」指在口中射精，归入口交题材', scope: 'zh-internet' },

      /* ---------- NTR / 关系 ---------- */
      { from: '牛头人', to: { concept: 'ntr' }, kind: 'concept', label: 'NTR / 寝取', conf: 0.95, ambiguous: false, why: '「牛头人」是 netorare 的中文谐音简称', scope: 'zh-internet' },
      { from: '黄毛', to: { concept: 'netori' }, kind: 'concept', label: '黄毛 / NTR 第三者', conf: 0.75, ambiguous: false, why: '「黄毛」是 NTR 题材里抢走女主的男性角色的代号', scope: 'zh-internet' },
      { from: '小三', to: { concept: 'cheating' }, kind: 'concept', label: '小三 / 出轨', conf: 0.78, ambiguous: true, why: '「小三」指插足他人关系的第三者，也可能只是昵称', scope: 'zh-internet' },
      { from: '隔壁老王', to: { concept: 'cheating' }, kind: 'concept', label: '隔壁老王 / 出轨', conf: 0.8, ambiguous: false, why: '「隔壁老王」是网络段子里出轨对象的代称', scope: 'zh-internet' },

      /* ---------- 性癖 / 极端题材 ---------- */
      { from: '恶堕', to: { concept: 'mindbreak' }, kind: 'concept', label: '恶堕 / 精神崩坏', conf: 0.85, ambiguous: false, why: '「恶堕」指角色被调教到精神崩坏、主动堕落', scope: 'zh-internet' },
      { from: '恶坠', to: { concept: 'mindbreak' }, kind: 'concept', label: '恶堕 / 精神崩坏', conf: 0.75, ambiguous: false, why: '「恶坠」是「恶堕」的常见错写', scope: 'zh-internet' },
      { from: '洗脑', to: { concept: 'hypnosis' }, kind: 'concept', label: '洗脑 / 催眠', conf: 0.8, ambiguous: false, why: '「洗脑」常用来指催眠系题材', scope: 'zh-internet' },
      { from: '重口', to: { concept: 'guro' }, kind: 'concept', label: '重口 / 猎奇', conf: 0.7, ambiguous: true, why: '「重口」泛指猎奇与 R18G，程度因圈子而异', scope: 'zh-internet', risk: 'r18g' },
      { from: '断肢', to: { concept: 'guro' }, kind: 'concept', label: '断肢 / 猎奇', conf: 0.85, ambiguous: false, why: '「断肢」属 R18G 猎奇表现', scope: 'zh-internet', risk: 'r18g' },
      { from: '肢解', to: { concept: 'guro' }, kind: 'concept', label: '肢解 / 猎奇', conf: 0.85, ambiguous: false, why: '「肢解」属 R18G 猎奇表现', scope: 'zh-internet', risk: 'r18g' },
      { from: '猎奇向', to: { concept: 'guro' }, kind: 'concept', label: '猎奇向 / R18G', conf: 0.82, ambiguous: false, why: '「猎奇向」指以猎奇为主的 R18G 作品', scope: 'zh-internet', risk: 'r18g' },
      { from: '冰恋', to: { concept: 'guro' }, kind: 'concept', label: '冰恋 / 猎奇', conf: 0.7, ambiguous: true, why: '「冰恋」指恋尸一类的极端题材', scope: 'zh-internet', risk: 'r18g' },
      { from: '人兽', to: { concept: 'bestiality' }, kind: 'concept', label: '人兽 / 兽交', conf: 0.85, ambiguous: false, why: '「人兽」即人与兽之间的性行为', scope: 'zh-internet' },
      { from: '下药', to: { concept: 'drugs' }, kind: 'concept', label: '下药 / 药物', conf: 0.85, ambiguous: false, why: '「下药」是药物题材的常见开场', scope: 'zh-internet' },
      { from: '春药', to: { concept: 'drugs' }, kind: 'concept', label: '春药 / 药物', conf: 0.85, ambiguous: false, why: '「春药」指催情药物题材', scope: 'zh-internet' },
      { from: '迷奸', to: { concept: 'sleeping' }, kind: 'concept', label: '迷奸 / 睡奸', conf: 0.75, ambiguous: false, why: '「迷奸」指让人失去意识后发生的性行为', scope: 'zh-internet' },
      { from: '睡眠姦', to: { concept: 'sleeping' }, kind: 'concept', label: '睡眠姦 / 睡奸', conf: 0.85, ambiguous: false, why: '「睡眠姦」是睡奸的日式写法', scope: 'ja-internet' },
      { from: '绳艺', to: { concept: 'bondage' }, kind: 'concept', label: '绳艺 / 束缚', conf: 0.85, ambiguous: false, why: '「绳艺」是同好圈对绳缚的雅称', scope: 'zh-internet' },
      { from: '尾随', to: { concept: 'voyeurism' }, kind: 'concept', label: '尾随 / 偷窥', conf: 0.72, ambiguous: false, why: '「尾随」指跟踪偷窥一类的桥段', scope: 'zh-internet' },
      { from: '偷拍', to: { concept: 'voyeurism' }, kind: 'concept', label: '偷拍 / 偷窥', conf: 0.85, ambiguous: false, why: '「偷拍」是偷窥题材的常见设定', scope: 'zh-internet' },
      { from: '男娘', to: { concept: 'trap' }, kind: 'concept', label: '男娘 / 伪娘', conf: 0.85, ambiguous: false, why: '「男娘」是近年的伪娘 / 女装男性叫法', scope: 'zh-internet' },
      { from: '女装', to: { concept: 'genderbender' }, kind: 'concept', label: '女装 / 性转', conf: 0.7, ambiguous: true, why: '「女装」在圈内指男性女装，但也是普通词', scope: 'zh-internet' },
      { from: '双性', to: { concept: 'futanari' }, kind: 'concept', label: '双性 / 扶他', conf: 0.78, ambiguous: false, why: '「双性」指同时具有两性特征的角色', scope: 'zh-internet' },
      { from: '蕾丝边', to: { concept: 'yuri' }, kind: 'concept', label: '蕾丝边 / 百合', conf: 0.85, ambiguous: false, why: '「蕾丝边」是 lesbian 的音译，指百合题材', scope: 'zh-internet' },
      { from: '御姐', to: { concept: 'milf' }, kind: 'concept', label: '御姐 / 熟女', conf: 0.85, ambiguous: false, why: '「御姐」指成熟强势的年长女性', scope: 'zh-internet' },
      { from: '人妻', to: { concept: 'hitozuma' }, kind: 'concept', label: '人妻', conf: 0.78, ambiguous: true, why: '「人妻」指已婚女性（婚姻状态），与「熟女」（年长 / 成熟女性）不是同一概念（2026-02 从 milf 组拆出 hitozuma 组）；仅作兜底提示，不主动弹', scope: 'zh-internet' },

      /* ---------- 服饰 / 造型 ---------- */
      { from: '白丝', to: { concept: 'stockings' }, kind: 'concept', label: '白丝 / 丝袜', conf: 0.85, ambiguous: false, why: '「白丝」指白色丝袜', scope: 'zh-internet' },
      { from: '黑丝', to: { concept: 'stockings' }, kind: 'concept', label: '黑丝 / 丝袜', conf: 0.88, ambiguous: false, why: '「黑丝」指黑色丝袜', scope: 'zh-internet' },
      { from: '吊带袜', to: { concept: 'stockings' }, kind: 'concept', label: '吊带袜 / 丝袜', conf: 0.85, ambiguous: false, why: '「吊带袜」是丝袜的一种', scope: 'zh-internet' },
      { from: '过膝袜', to: { concept: 'stockings' }, kind: 'concept', label: '过膝袜 / 丝袜', conf: 0.88, ambiguous: false, why: '「过膝袜」指长度过膝的袜子', scope: 'zh-internet' },
      { from: '绝对领域', to: { concept: 'stockings' }, kind: 'concept', label: '绝对领域 / 丝袜', conf: 0.78, ambiguous: false, why: '「绝对领域」指过膝袜与裙摆之间露出的一段大腿', scope: 'zh-internet' },
      { from: '死库水', to: { concept: 'swimsuit' }, kind: 'concept', label: '死库水 / 泳装', conf: 0.9, ambiguous: false, why: '「死库水」是 school swimsuit 的空耳', scope: 'zh-internet' },
      { from: '裸围', to: { concept: 'nude' }, kind: 'concept', label: '裸围 / 裸体', conf: 0.8, ambiguous: false, why: '「裸围」指只穿围裙的裸体造型', scope: 'zh-internet' },
      { from: '裸围裙', to: { concept: 'nude' }, kind: 'concept', label: '裸围 / 裸体', conf: 0.8, ambiguous: false, why: '「裸围裙」指只穿围裙的裸体造型', scope: 'zh-internet' },
      { from: '童贞', to: { concept: 'virgin' }, kind: 'concept', label: '童贞 / 处女', conf: 0.82, ambiguous: false, why: '「童贞」指没有性经验，男女通用', scope: 'ja-internet' },
      { from: '兽娘', to: { concept: 'monstergirl' }, kind: 'concept', label: '兽娘 / 怪物娘', conf: 0.85, ambiguous: false, why: '「兽娘」指带兽类特征的女性角色', scope: 'zh-internet' },
      { from: '恶魔娘', to: { concept: 'demon' }, kind: 'concept', label: '恶魔娘 / 恶魔', conf: 0.8, ambiguous: false, why: '「恶魔娘」指恶魔属性的女性角色', scope: 'zh-internet' },
      { from: '精灵耳', to: { concept: 'elf' }, kind: 'concept', label: '精灵耳 / 精灵', conf: 0.8, ambiguous: false, why: '「精灵耳」指尖长的精灵族耳朵', scope: 'zh-internet' },

      /* ---------- 身体 ---------- */
      { from: '巨根', to: { concept: 'penis' }, kind: 'concept', label: '巨根 / 阴茎', conf: 0.88, ambiguous: false, why: '「巨根」指尺寸夸张的阴茎', scope: 'ja-internet' },
      { from: '大奶', to: { concept: 'breast' }, kind: 'concept', label: '大奶 / 胸部', conf: 0.8, ambiguous: false, why: '「大奶」是大胸的口语说法', scope: 'zh-internet' },
      { from: '美臀', to: { concept: 'ass' }, kind: 'concept', label: '美臀 / 臀部', conf: 0.8, ambiguous: false, why: '「美臀」是对臀部的赞美说法', scope: 'zh-internet' },
      { from: '蜜桃臀', to: { concept: 'ass' }, kind: 'concept', label: '美臀 / 臀部', conf: 0.78, ambiguous: false, why: '「蜜桃臀」形容圆翘的臀部', scope: 'zh-internet' },
      { from: '白虎', to: { concept: 'pussy' }, kind: 'concept', label: '白虎 / 小穴', conf: 0.7, ambiguous: true, why: '「白虎」指无毛的阴部，但也是普通词与神兽名', scope: 'zh-internet' },

      /* ---------- 无修 / 有修 ---------- */
      { from: '步兵', to: { concept: 'uncensored' }, kind: 'concept', label: '步兵 / 无修', conf: 0.78, ambiguous: true, why: '「步兵」指无码作品，与「骑兵」相对', scope: 'zh-internet' },
      { from: '骑兵', to: { concept: 'censored' }, kind: 'concept', label: '骑兵 / 有修', conf: 0.75, ambiguous: true, why: '「骑兵」指有码作品，与「步兵」相对', scope: 'zh-internet' },
      { from: '无码', to: { concept: 'uncensored' }, kind: 'concept', label: '无码 / 无修', conf: 0.88, ambiguous: false, why: '「无码」即没有马赛克 / 修正', scope: 'zh-internet' },
      { from: '有码', to: { concept: 'censored' }, kind: 'concept', label: '有码 / 有修', conf: 0.88, ambiguous: false, why: '「有码」即带有马赛克 / 修正', scope: 'zh-internet' },
      { from: '本子', to: { concept: 'doujinshi' }, kind: 'concept', label: '本子 / 同人志', conf: 0.85, ambiguous: false, why: '「本子」是圈内对同人志的俗称', scope: 'zh-internet' },
      { from: '雷神', to: { character: 'raiden shogun' }, kind: 'character', label: '雷电将军', conf: 0.5, ambiguous: true, why: '「雷神」在二次元语境下指雷电将军，但与通用词「雷神」冲突，不可武断', scope: 'zh-internet' },

      /* ---------- 作品 / IP 俗称（指向 core 里已有的系列名） ---------- */
      { from: '车万', to: { series: 'touhou project' }, kind: 'series', label: '东方 Project', conf: 0.92, ambiguous: false, why: '「车万」是「东方」的拆字梗', scope: 'zh-internet' },
      { from: 'fgo', to: { series: 'fate grand order' }, kind: 'series', label: 'Fate/Grand Order', conf: 0.92, ambiguous: false, why: '「fgo」是 Fate/Grand Order 的通用缩写', scope: 'zh-internet' },
      { from: '砍口垒', to: { series: 'kantai collection' }, kind: 'series', label: '舰队Collection', conf: 0.85, ambiguous: false, why: '「砍口垒」是「艦これ」的空耳', scope: 'zh-internet' },
      { from: '舰c', to: { series: 'kantai collection' }, kind: 'series', label: '舰队Collection', conf: 0.78, ambiguous: true, why: '「舰c」指舰队Collection，也可能被理解成别的舰系游戏', scope: 'zh-internet' },
      { from: '舰b', to: { series: 'azur lane' }, kind: 'series', label: '碧蓝航线', conf: 0.78, ambiguous: true, why: '「舰b」指碧蓝航线（Azur Lane）', scope: 'zh-internet' },
      { from: '少前', to: { series: 'girls frontline' }, kind: 'series', label: '少女前线', conf: 0.85, ambiguous: false, why: '「少前」是《少女前线》的简称', scope: 'zh-internet' },
      { from: '舟游', to: { series: 'arknights' }, kind: 'series', label: '明日方舟', conf: 0.85, ambiguous: false, why: '「舟游」是《明日方舟》的简称', scope: 'zh-internet' },
      { from: '碧蓝档案', to: { series: 'blue archive' }, kind: 'series', label: '碧蓝档案', conf: 0.85, ambiguous: false, why: '「碧蓝档案」是 Blue Archive 的常用中文名', scope: 'zh-internet' },
      { from: '蔚蓝档案', to: { series: 'blue archive' }, kind: 'series', label: '碧蓝档案', conf: 0.82, ambiguous: false, why: '「蔚蓝档案」是 Blue Archive 的另一译名', scope: 'zh-internet' },
      { from: '崩三', to: { series: 'honkai impact' }, kind: 'series', label: '崩坏3', conf: 0.85, ambiguous: false, why: '「崩三」是《崩坏3》的圈内简称', scope: 'zh-internet' },
      { from: '崩铁', to: { series: 'honkai star rail' }, kind: 'series', label: '崩坏：星穹铁道', conf: 0.85, ambiguous: false, why: '「崩铁」是《崩坏：星穹铁道》的简称', scope: 'zh-internet' },
      { from: '星铁', to: { series: 'honkai star rail' }, kind: 'series', label: '崩坏：星穹铁道', conf: 0.85, ambiguous: false, why: '「星铁」是《崩坏：星穹铁道》的简称', scope: 'zh-internet' },
      { from: '术力口', to: { series: 'vocaloid' }, kind: 'series', label: 'VOCALOID', conf: 0.8, ambiguous: false, why: '「术力口」是「ボカロ」的空耳', scope: 'zh-internet' },
      { from: 'v家', to: { series: 'vocaloid' }, kind: 'series', label: 'VOCALOID', conf: 0.8, ambiguous: false, why: '「V家」指 VOCALOID 系列', scope: 'zh-internet' },
      { from: 'ボカロ', to: { series: 'vocaloid' }, kind: 'series', label: 'VOCALOID', conf: 0.85, ambiguous: false, why: '「ボカロ」是 VOCALOID 的日文简称', scope: 'ja-internet' },
      { from: 'ホロライブ', to: { series: 'hololive' }, kind: 'series', label: 'hololive', conf: 0.85, ambiguous: false, why: '「ホロライブ」即 hololive', scope: 'ja-internet' },
      { from: 'にじさんじ', to: { series: 'nijisanji' }, kind: 'series', label: 'Nijisanji', conf: 0.85, ambiguous: false, why: '「にじさんじ」即 Nijisanji', scope: 'ja-internet' },
      { from: '邦邦', to: { series: 'bang dream' }, kind: 'series', label: 'BanG Dream!', conf: 0.8, ambiguous: false, why: '「邦邦」是 BanG Dream! 的圈内叫法', scope: 'zh-internet' },
      { from: '妮姬', to: { series: 'nikke' }, kind: 'series', label: 'NIKKE', conf: 0.85, ambiguous: false, why: '「妮姬」是《胜利女神：妮姬》的简称', scope: 'zh-internet' },
      { from: '蓝色监狱', to: { series: 'blue lock' }, kind: 'series', label: '蓝色监狱', conf: 0.85, ambiguous: false, why: '「蓝色监狱」是 Blue Lock 的中文名', scope: 'zh-internet' },
      { from: '间谍过家家', to: { series: 'spy x family' }, kind: 'series', label: '间谍过家家', conf: 0.88, ambiguous: false, why: '「间谍过家家」是 SPY×FAMILY 的中文名', scope: 'zh-internet' },
      { from: '鬼灭', to: { series: 'kimetsu no yaiba' }, kind: 'series', label: '鬼灭之刃', conf: 0.88, ambiguous: false, why: '「鬼灭」是《鬼灭之刃》的简称', scope: 'zh-internet' },
      { from: '咒术回战', to: { series: 'jujutsu kaisen' }, kind: 'series', label: '咒术回战', conf: 0.88, ambiguous: false, why: '「咒术回战」是 Jujutsu Kaisen 的中文名', scope: 'zh-internet' },
      { from: '我英', to: { series: 'my hero academia' }, kind: 'series', label: '我的英雄学院', conf: 0.82, ambiguous: false, why: '「我英」是《我的英雄学院》的简称', scope: 'zh-internet' },
      { from: '电锯人', to: { series: 'chainsaw man' }, kind: 'series', label: '电锯人', conf: 0.88, ambiguous: false, why: '「电锯人」是 Chainsaw Man 的中文名', scope: 'zh-internet' },
      { from: '推子', to: { series: 'oshi no ko' }, kind: 'series', label: '我推的孩子', conf: 0.75, ambiguous: false, why: '「推子」是《我推的孩子》的简称', scope: 'zh-internet' },
      { from: '孤独摇滚', to: { series: 'bocchi the rock' }, kind: 'series', label: '孤独摇滚', conf: 0.85, ambiguous: false, why: '「孤独摇滚」是 Bocchi the Rock! 的中文名', scope: 'zh-internet' },
      { from: '莉可莉丝', to: { series: 'lycoris recoil' }, kind: 'series', label: 'Lycoris Recoil', conf: 0.78, ambiguous: false, why: '「莉可莉丝」是 Lycoris Recoil 的音译', scope: 'zh-internet' },
      { from: 'sao', to: { series: 'sword art online' }, kind: 'series', label: '刀剑神域', conf: 0.88, ambiguous: false, why: '「SAO」是 Sword Art Online 的缩写', scope: 'zh-internet' },
      { from: '俺妹', to: { series: 'oreimo' }, kind: 'series', label: '我的妹妹哪有这么可爱', conf: 0.85, ambiguous: false, why: '「俺妹」是《俺の妹がこんなに可愛いわけがない》的简称', scope: 'zh-internet' },
      { from: '路人女主', to: { series: 'saekano' }, kind: 'series', label: '路人女主的养成方法', conf: 0.82, ambiguous: false, why: '「路人女主」是 Saekano 的中文简称', scope: 'zh-internet' },
      { from: '五等分', to: { series: 'gotoubun' }, kind: 'series', label: '五等分的新娘', conf: 0.85, ambiguous: false, why: '「五等分」是《五等分的新娘》的简称', scope: 'zh-internet' },
      { from: '更衣人偶', to: { series: 'dress up darling' }, kind: 'series', label: '更衣人偶坠入爱河', conf: 0.82, ambiguous: false, why: '「更衣人偶」是《その着せ替え人形は恋をする》的中文名', scope: 'zh-internet' },
      { from: '骨王', to: { series: 'overlord' }, kind: 'series', label: 'Overlord', conf: 0.85, ambiguous: false, why: '「骨王」指 Overlord 的主角安兹', scope: 'zh-internet' },
      { from: '小圆', to: { series: 'madoka magica' }, kind: 'series', label: '魔法少女小圆', conf: 0.82, ambiguous: false, why: '「小圆」指《魔法少女小圆》的主角鹿目圆', scope: 'zh-internet' },
      { from: '魔圆', to: { series: 'madoka magica' }, kind: 'series', label: '魔法少女小圆', conf: 0.8, ambiguous: false, why: '「魔圆」是《魔法少女小圆》的简称', scope: 'zh-internet' },
      { from: 'eva', to: { series: 'neon genesis evangelion' }, kind: 'series', label: '新世纪福音战士', conf: 0.9, ambiguous: false, why: '「EVA」是新世纪福音战士的缩写', scope: 'zh-internet' },
      { from: '龙珠', to: { series: 'dragon ball' }, kind: 'series', label: '龙珠', conf: 0.9, ambiguous: false, why: '「龙珠」是 Dragon Ball 的中文名', scope: 'zh-internet' },
      { from: '海贼王', to: { series: 'one piece' }, kind: 'series', label: '海贼王', conf: 0.9, ambiguous: false, why: '「海贼王」是 ONE PIECE 的中文名', scope: 'zh-internet' },
      { from: '火影', to: { series: 'naruto' }, kind: 'series', label: '火影忍者', conf: 0.9, ambiguous: false, why: '「火影」是《火影忍者》的简称', scope: 'zh-internet' },
      { from: '死神', to: { series: 'bleach' }, kind: 'series', label: '死神', conf: 0.78, ambiguous: true, why: '「死神」指 BLEACH，但也是普通词', scope: 'zh-internet' },
      { from: '宝可梦', to: { series: 'pokemon' }, kind: 'series', label: '宝可梦', conf: 0.9, ambiguous: false, why: '「宝可梦」是 Pokémon 的官方中文名', scope: 'zh-internet' },
      { from: '口袋妖怪', to: { series: 'pokemon' }, kind: 'series', label: '宝可梦', conf: 0.85, ambiguous: false, why: '「口袋妖怪」是 Pokémon 的旧译名', scope: 'zh-internet' },
      { from: '塞尔达', to: { series: 'zelda' }, kind: 'series', label: '塞尔达传说', conf: 0.9, ambiguous: false, why: '「塞尔达」是 The Legend of Zelda 的中文简称', scope: 'zh-internet' },
      { from: '怪猎', to: { series: 'monster hunter' }, kind: 'series', label: '怪物猎人', conf: 0.85, ambiguous: false, why: '「怪猎」是《怪物猎人》的简称', scope: 'zh-internet' },
      { from: '黑魂', to: { series: 'dark souls' }, kind: 'series', label: '黑暗之魂', conf: 0.85, ambiguous: false, why: '「黑魂」是 Dark Souls 的简称', scope: 'zh-internet' },
      { from: '老头环', to: { series: 'elden ring' }, kind: 'series', label: '艾尔登法环', conf: 0.88, ambiguous: false, why: '「老头环」是艾尔登法环的民间叫法', scope: 'zh-internet' },
      { from: '血源', to: { series: 'bloodborne' }, kind: 'series', label: '血源诅咒', conf: 0.85, ambiguous: false, why: '「血源」是 Bloodborne 的简称', scope: 'zh-internet' },
      { from: '撸啊撸', to: { series: 'league of legends' }, kind: 'series', label: '英雄联盟', conf: 0.85, ambiguous: false, why: '「撸啊撸」是 LoL 的中文谐音叫法', scope: 'zh-internet' },
      { from: 'lol', to: { series: 'league of legends' }, kind: 'series', label: '英雄联盟', conf: 0.75, ambiguous: true, why: '「lol」可能指英雄联盟，也是常见的笑声缩写', scope: 'zh-internet' },
      { from: '瓦罗兰特', to: { series: 'valorant' }, kind: 'series', label: '特战英豪', conf: 0.82, ambiguous: false, why: '「瓦罗兰特」是 VALORANT 的音译', scope: 'zh-internet' },
      { from: '街霸', to: { series: 'street fighter' }, kind: 'series', label: '街头霸王', conf: 0.85, ambiguous: false, why: '「街霸」是《街头霸王》的简称', scope: 'zh-internet' },
      { from: '死或生', to: { series: 'dead or alive' }, kind: 'series', label: '死或生', conf: 0.85, ambiguous: false, why: '「死或生」是 Dead or Alive 的中文名', scope: 'zh-internet' },
      { from: '马里奥', to: { series: 'super mario' }, kind: 'series', label: '超级马里奥', conf: 0.9, ambiguous: false, why: '「马里奥」是 Super Mario 的主角名', scope: 'zh-internet' },
      { from: '卡比', to: { series: 'kirby' }, kind: 'series', label: '星之卡比', conf: 0.85, ambiguous: false, why: '「卡比」是 Kirby 的中文名', scope: 'zh-internet' },
      { from: '斯普拉遁', to: { series: 'splatoon' }, kind: 'series', label: '斯普拉遁', conf: 0.85, ambiguous: false, why: '「斯普拉遁」是 Splatoon 的官方中文名', scope: 'zh-internet' },
      { from: '喷射战士', to: { series: 'splatoon' }, kind: 'series', label: '斯普拉遁', conf: 0.82, ambiguous: false, why: '「喷射战士」是 Splatoon 的民间译名', scope: 'zh-internet' },
      { from: '火纹', to: { series: 'fire emblem' }, kind: 'series', label: '火焰纹章', conf: 0.85, ambiguous: false, why: '「火纹」是《火焰纹章》的简称', scope: 'zh-internet' },
      { from: '女神异闻录', to: { series: 'persona' }, kind: 'series', label: '女神异闻录', conf: 0.85, ambiguous: false, why: '「女神异闻录」是 Persona 的中文名', scope: 'zh-internet' },
      { from: '数码宝贝', to: { series: 'digimon' }, kind: 'series', label: '数码宝贝', conf: 0.85, ambiguous: false, why: '「数码宝贝」是 Digimon 的中文名', scope: 'zh-internet' },
      { from: '游戏王', to: { series: 'yugioh' }, kind: 'series', label: '游戏王', conf: 0.88, ambiguous: false, why: '「游戏王」是 Yu-Gi-Oh! 的中文名', scope: 'zh-internet' },
      { from: '来打', to: { series: 'kamen rider' }, kind: 'series', label: '假面骑士', conf: 0.75, ambiguous: false, why: '「来打」是 rider 的空耳', scope: 'zh-internet' },
      { from: '凹凸曼', to: { series: 'ultraman' }, kind: 'series', label: '奥特曼', conf: 0.85, ambiguous: false, why: '「凹凸曼」是奥特曼的谐音梗', scope: 'zh-internet' },
      { from: '高达', to: { series: 'gundam' }, kind: 'series', label: '高达', conf: 0.9, ambiguous: false, why: '「高达」是 Gundam 的中文名', scope: 'zh-internet' },
      { from: '钢弹', to: { series: 'gundam' }, kind: 'series', label: '高达', conf: 0.85, ambiguous: false, why: '「钢弹」是 Gundam 的台译名', scope: 'zh-internet' },
      { from: '超时空要塞', to: { series: 'macross' }, kind: 'series', label: '超时空要塞', conf: 0.85, ambiguous: false, why: '「超时空要塞」是 Macross 的中文名', scope: 'zh-internet' },
      { from: '崩崩崩', to: { series: 'honkai impact' }, kind: 'series', label: '崩坏3', conf: 0.68, ambiguous: true, why: '「崩崩崩」是《崩坏3》的玩梗叫法', scope: 'zh-internet' },

      /* ---------- IP 名首字母缩写（拼音 / 英文） ----------
         这一组是**跨 IP 的公共简称**，按目录分层规则留在核心层（而不是塞进各 IP 包）：
         核心层首屏同步就绪，不依赖任何包的懒加载。缩写短、通用、歧义大，一律
         压到 low 档（conf < 0.85 或 ambiguous: true），只在 0 结果时兜底提示，
         绝不主动改写查询；懒加载触发词另在 ip/index.json 与各包 anchors 里登记。
         改档位只需改 conf / ambiguous。 */
      { from: 'mrfz', to: { series: 'arknights' }, kind: 'series', label: '明日方舟', conf: 0.88, ambiguous: false, why: '「明日方舟」的拼音首字母缩写（Ming Ri Fang Zhou），社区通用；与「明日方舟」本身一样指向 arknights', scope: 'zh-internet' },
      /* fgo 在 §作品俗称 已有条目（conf 0.92 / 主动档），此处不重复登记。 */
      { from: 'ys', to: { series: 'genshin' }, kind: 'series', label: '原神', conf: 0.6, ambiguous: true, why: '「原神」的拼音首字母缩写（Yuan Shen）；两字母极短，也常被写作「永生 / 耶稣」等，只作兜底', scope: 'zh-internet' },
      { from: 'sr', to: { series: 'honkai star rail' }, kind: 'series', label: '崩坏：星穹铁道', conf: 0.6, ambiguous: true, why: 'Star Rail 的英文缩写（也常被当成拼音缩写写）；两字母极短，也常被写作「虽然 / 少女」等，只作兜底', scope: 'zh-internet' },
      { from: 'xt', to: { series: 'honkai star rail' }, kind: 'series', label: '崩坏：星穹铁道', conf: 0.6, ambiguous: true, why: '「星穹铁道」的拼音首字母缩写（Xing Qiong Tie Dao）；两字母极短，只作兜底', scope: 'zh-internet' },
      { from: 'hsr', to: { series: 'honkai star rail' }, kind: 'series', label: '崩坏：星穹铁道', conf: 0.6, ambiguous: true, why: 'Honkai: Star Rail 的英文缩写；与「高速铁路」等缩写冲突，只作兜底；包内同名条已删除，避免跨层降档', scope: 'zh-internet' },
      { from: 'zzz', to: { series: 'zenless zone zero' }, kind: 'series', label: '绝区零', conf: 0.6, ambiguous: true, why: 'Zenless Zone Zero 的英文缩写；也是「睡觉」的网络拟声，只作兜底（绝区零的检索名是 zenless zone zero，见包内说明）；包内同名条已删除，避免跨层降档', scope: 'zh-internet' },
      { from: 'jql', to: { series: 'zenless zone zero' }, kind: 'series', label: '绝区零', conf: 0.6, ambiguous: true, why: '「绝区零」的拼音首字母缩写（Jue Qu Ling）；三字母也易与其它缩写混淆，只作兜底', scope: 'zh-internet' },
      { from: 'wuwa', to: { series: 'wuwa' }, kind: 'series', label: '鸣潮', conf: 0.6, ambiguous: true, why: 'Wuthering Waves 的英文缩写，社区通用；包内同名条（to.term）已删除，改由本层统一成 series，避免跨层降档', scope: 'zh-internet' },
      { from: 'mc', to: { series: 'wuwa' }, kind: 'series', label: '鸣潮', conf: 0.55, ambiguous: true, why: '「鸣潮」的拼音首字母缩写（Ming Chao）；两字母也常指《我的世界》等，只作兜底', scope: 'zh-internet' },
      { from: 'bh3', to: { series: 'honkai impact' }, kind: 'series', label: '崩坏3', conf: 0.7, ambiguous: true, why: '「崩坏3」的英文缩写（Honkai Impact 3rd）；纯字母数字缩写易与其它编号冲突，只作兜底；崩坏3 没有独立 IP 包，故不登记为任何包的锚点', scope: 'zh-internet' },
      { from: 'bbb', to: { series: 'honkai impact' }, kind: 'series', label: '崩坏3', conf: 0.6, ambiguous: true, why: '「崩壞3」的英文缩写 BBB（Bug、Bug、Bug 的玩梗叫法）；只作兜底；崩坏3 没有独立 IP 包，故不登记为任何包的锚点', scope: 'zh-internet' }
    ],

    /* 锚点表（**兜底注册表**）：命中锚点才知道该去拉哪个 IP 包。
       懒加载的触发词主来源是 assets/dict/ip/index.json 清单；这张表只在清单缺失 /
       未就绪 / 坏掉时兜底，以及承接「清单里没有登记的包」。两边都命中时合并去重。
       注意：锚点同时是**该包的加载触发词** —— 只有触发词命中才会 pending → load()，
       所以包内那些「离开本 IP 就没有意义」的黑话本身也必须登记（清单或本表里），
       否则单独搜「小火龙」永远不会去拉 arknights 包。
       普通词、多义词不要登记在这里：那会让无关查询去拉包。 */
    anchors: {
      '明日方舟': 'arknights',
      'arknights': 'arknights',
      'アークナイツ': 'arknights',
      '粥游': 'arknights',
      '小火龙': 'arknights',
      '阿米驴': 'arknights',
      '银老板': 'arknights',
      '原神': 'genshin',
      'genshin': 'genshin',
      'genshin impact': 'genshin',
      '椰羊': 'genshin',
      '小吉祥草王': 'genshin',

      /* 2026-09-21 追加：本轮新增的缩写 / 昵称触发词，与 ip/index.json 主路径保持一致。
         缩写（mrfz / ys / sr / xt / hsr / jql / wuwa / mc）都是「跨 IP 的公共简称」，
         登记在这里既能让清单失效时仍能触发懒加载，也避免为了一个缩写去改 6 个包文件；
         图图 / 图图姐 / 2226 与马大姐则会随各自 IP 包走主路径，这里同步一份兜底。
         同轮收紧：删掉 'zzz'（通用缩写），见下方注释。 */
      'mrfz': 'arknights',
      '图图': 'arknights',
      '图图姐': 'arknights',
      '2226': 'arknights',
      '马大姐': 'arknights',
      'ys': 'genshin',
      'sr': 'starrail',
      'xt': 'starrail',
      'hsr': 'starrail',
      /* 'zzz': 'zenless' 已于 2026-09-21 删除：`zzz` 是通用缩写（也是「睡觉」的拟声），
         登记为触发词会让任何含它的查询白拉 zenless 包。词条仍在 entries 里
         （to.series，low 档），只是不再触发加载；锚点也同时从 ip/zenless.json 与
         ip/index.json 移除。恢复方法：把它加回两边并重新生成 ip/index.json。 */
      'jql': 'zenless',
      'wuwa': 'wuwa',
      'mc': 'wuwa'
      /* bh3 / bbb（崩坏3）与 fgo 没有对应的 IP 包：不登记触发词，避免无关查询去拉别人的包。
         它们的词条仍留在 entries 里（命中后作 0 结果时的兜底说明）。 */
    }
  };
})(window.HS);
