# HS.CONCEPTS 全组体检表（自动生成 + 人工结论）

- 数据源：`assets/js/dict.js` 的 `HS.CONCEPTS`（122 组）与 `HS.TAG_ZH`（1711 条）
- 结论口径：**正确** / **应拆分**（组内是不同的概念）/ **应缩小**（组内是上位词吞下位词）/ **应保留原词不改写** / **存疑**（不动，等维护者拍板）
- 统计：应缩小 36 · 应拆分 7 · 正确 70 · 存疑 7 · 保留原词不改写 1 · 应缩小（「妖精」应保留原词不改写） 1

| # | key | zh | en | ja | aliases | 结论 | 依据 / 实测 |
|---|-----|----|----|----|---------|------|-------------|
| 1 | `breast` | 胸 | breasts | おっぱい | breast, breasts(ownZh=胸部), boobs, tits, おっぱい, 胸, 巨乳(zhVal←big breasts/large breasts), big breasts(ownZh=巨乳), large breasts(ownZh=巨乳), oppai | 应缩小 | zh=胸 是上位词，组里塞了「巨乳/big breasts/large breasts」这些下位词（TAG_ZH 里 big breasts→巨乳，自有一套）。**未改**：① 回归红线 ③ 明确冻结「巨乳」；② 实测这三个词走的是 core.js 的 GENRES（key=big breasts），CONCEPTS 里是够不着的死别名。实测 copymanga 巨乳 158 / 胸 47（改写后反而少 70%） |
| 2 | `foot` | 脚 | foot | 足 | foot, feet, footjob(ownZh=足交), 足, 脚, あし, 足コキ, 足交(zhVal←footjob) | 应拆分 | 「脚」是部位、「footjob/足交」是行为，两回事（TAG_ZH: footjob→足交）。**未改**：脚在回归红线里，且 ja 槽没有可靠对应。实测 copymanga 脚 114 / 足交 2 |
| 3 | `ass` | 臀 | ass | お尻 | ass, butt, buttocks, お尻, 尻, 臀, 屁股, 巨臀(zhVal←large ass), large ass(ownZh=巨臀) | 应缩小 | 与 breast 同型：「巨臀/large ass」（TAG_ZH: large ass→巨臀）是下位词塞进 zh=臀。**未改**：与 breast 是同一个决定，等维护者一起拍。实测 copymanga 臀 6 / 巨臀 102（改写后少 94%） |
| 4 | `mouth` | 口 | mouth | 口 | mouth, mouths, 口, くち, 口腔, 嘴 | 正确 | 口 / mouth / 口 / 口腔 / 嘴 同义 |
| 5 | `tongue` | 舌 | tongue | 舌 | tongue, 舌, した, 舌头, 舌吻(zhVal←french kiss), french kiss(ownZh=舌吻) | 应缩小 | 「french kiss/舌吻」是行为，塞进了「舌」这个部位组。未改（要拆就得新增槽位） |
| 6 | `hand` | 手 | hand | 手 | hand, hands, 手, て, てのひら, 手掌 | 正确 | 手 / hand / 手 / 手掌 同义 |
| 7 | `armpit` | 腋 | armpit | 腋 | armpit, armpits(ownZh=腋下), 腋, わき, 腋下(zhVal←armpits), 腋交(zhVal←armpit sex), armpit sex(ownZh=腋交) | 应缩小 | 「armpit sex/腋交」是行为，塞进了「腋」；TAG_ZH: armpit sex→腋交 |
| 8 | `belly` | 肚 | belly | お腹 | belly, stomach, お腹, 腹, 肚, 肚子, 腹部 | 正确 | 肚 / belly / stomach / お腹 同义 |
| 9 | `navel` | 肚脐 | navel | へそ | navel, belly button, へそ, 肚脐(zhVal←navel/belly button), へその緒 | 存疑 | 组里收了「へその緒」—— 日文意思是**脐带**，不是肚脐，疑似收错词。未改（可能是故意的同人说法） |
| 10 | `thigh` | 腿 | thigh | 太もも | thigh, thighs(ownZh=大腿), 太もも, 腿, 大腿(zhVal←thighs), 腿交(zhVal←thigh sex/intercrural), thigh sex(ownZh=腿交) | 应缩小 | 「thigh sex/腿交」是行为（TAG_ZH: thigh sex→腿交），塞进了「腿」 |
| 11 | `hair` | 头发 | hair | 髪 | hair, 髪, 头发, かみ, 长发(zhVal←long hair), long hair(ownZh=长发) | 应缩小 | 「long hair/长发」是下位词（TAG_ZH: long hair→长发），组 zh=头发 |
| 12 | `pussy` | 小穴 | pussy | まんこ | pussy, vagina, cunt, まんこ, 小穴(zhVal←pussy), 阴部, 膣, 阴道 | 正确 | pussy/vagina/cunt/まんこ/小穴/阴部/阴道 同义 |
| 13 | `penis` | 阴茎 | penis | ペニス | penis, cock, dick, ペニス, 阴茎(zhVal←penis), 肉棒, ちんこ, 鸡巴 | 正确 | penis/cock/dick/阴茎/肉棒 同义 |
| 14 | `nipple` | 乳头 | nipples | 乳首 | nipple, nipples, 乳首, 乳头(zhVal←nipples), ちくび, puffy nipples(ownZh=凸乳头) | 应缩小 | 「puffy nipples/凸乳头」是下位词（TAG_ZH: puffy nipples→凸乳头） |
| 15 | `womb` | 子宫 | womb | 子宮 | womb, uterus, cervix(ownZh=子宫颈), 子宮, 子宫(zhVal←womb/uterus), 子宫颈(zhVal←cervix) | 应缩小 | 「cervix/子宫颈」是子宫的一部分（TAG_ZH: cervix→子宫颈） |
| 16 | `skin` | 肤色 | skin | 肌 | dark skin(ownZh=黑皮), tanned(ownZh=晒黑), 褐色, 肌, 肤色, 黑皮(zhVal←dark skin), 晒黑(zhVal←tanned) | 应缩小 | zh=肤色 是上位词，组里是「dark skin/黑皮」「tanned/晒黑」这些具体属性（TAG_ZH 两者都有独立翻译）。实测 nhentai dark skin 50562 / tanned 82 |
| 17 | `nakadashi` | 中出 | creampie | 中出し | nakadashi, creampie, 中出(zhVal←nakadashi/creampie), 中出し, 内射(zhVal←cum in pussy), cum inside | 正确 | 中出 / 内射 / creampie / 中出し 同一概念（用户也认可这一组） |
| 18 | `paizuri` | 乳交 | paizuri | パイズリ | paizuri, titjob, titfuck, パイズリ, 乳交(zhVal←paizuri/titjob/titfuck), 乳夹(zhVal←nipple clamp), breast sex | 存疑 | 组里的「乳夹」在 TAG_ZH 里对应的是 nipple clamp（乳首夹），不是乳交；但实测 copymanga 乳夹 30 条首条是无关的「科技夾克」，两种解释都不干净。未改 |
| 19 | `anal` | 肛交 | anal | アナル | anal, anal sex, anaru, アナル, 肛交(zhVal←anal/anal sex), 肛门, 后庭 | 正确 | 肛交 / anal / アナル 同义 |
| 20 | `fellatio` | 口交 | fellatio | フェラ | fellatio(ownZh=吹箫), blowjob, oral, oral sex, フェラ, 口交(zhVal←oral/blowjob), 吹箫(zhVal←fellatio), 咥える | 应缩小 | 「oral / oral sex」比 fellatio 大（含舔阴），组却以 fellatio 为规范名；TAG_ZH: fellatio→吹箫（门槛已让它发自己的翻译）。未改数据 |
| 21 | `cunnilingus` | 舔阴 | cunnilingus | クンニ | cunnilingus, クンニ, 舔阴(zhVal←cunnilingus), 舐め, licking pussy | 正确 | 舔阴 / cunnilingus / クンニ 同义 |
| 22 | `handjob` | 手交 | handjob | 手コキ | handjob, hand job, 手コキ, 手交(zhVal←handjob/hand job), 撸管 | 正确 | 手交 / handjob / 手コキ 同义 |
| 23 | `masturbation` | 自慰 | masturbation | オナニー | masturbation, masturbate, onanii, オナニー, 自慰(zhVal←masturbation), 手淫 | 正确 | 自慰 / masturbation / オナニー 同义 |
| 24 | `deepthroat` | 深喉 | deepthroat | イラマチオ | deepthroat, irrumatio(ownZh=喉交), イラマチオ, イラマ, 深喉(zhVal←deepthroat), 喉交(zhVal←irrumatio) | 应缩小 | 「irrumatio/喉交」与 deepthroat 是两种技法（TAG_ZH: irrumatio→喉交） |
| 25 | `cum` | 精液 | semen | 精液 | semen, cum, sperm(ownZh=精子), ザーメン, 精液(zhVal←cum/semen), 精子(zhVal←sperm), 精 | 存疑 | 「sperm/精子」与「semen/精液」严格不是一回事（TAG_ZH 两者都有独立翻译）；门槛已把输入 sperm 改发「精子」 |
| 26 | `bukkake` | 颜射 | bukkake | ぶっかけ | bukkake, facial, ぶっかけ, 颜射(zhVal←bukkake/facial/cum on face), 射脸, cum on face | 正确 | 颜射 / bukkake / facial / ぶっかけ 同义 |
| 27 | `squirting` | 潮吹 | squirting | 潮吹き | squirting, female ejaculation, 潮吹き, 潮吹(zhVal←squirting/female ejaculation/squirt), 喷水 | 正确 | 潮吹 / squirting / 潮吹き 同义 |
| 28 | `kissing` | 接吻 | kissing | キス | kissing, kiss, キス, 接吻(zhVal←kissing), 亲吻 | 正确 | 接吻 / kissing / キス 同义 |
| 29 | `saliva` | 唾液 | saliva | 唾液 | saliva, drool, 唾液, 口水, よだれ | 正确 | 唾液 / saliva / よだれ 同义 |
| 30 | `sweat` | 汗水 | sweat | 汗 | sweat, sweating, 汗, 汗水, 汗だく | 正确 | 汗水 / sweat / 汗だく 同义 |
| 31 | `orgasm` | 高潮 | orgasm | 絶頂 | orgasm, climax, 絶頂, 高潮(zhVal←orgasm), イク | 正确 | 高潮 / orgasm / 絶頂 同义 |
| 32 | `ahegao` | 阿黑颜 | ahegao | アヘ顔 | ahegao, アヘ顔, 阿黑颜(zhVal←ahegao), 绝顶脸, o-face | 正确 | 阿黑颜 / ahegao / アヘ顔 同义 |
| 33 | `fisting` | 拳交 | fisting | フィスト | fisting, fist, フィスト, 拳交(zhVal←fisting), 拳入 | 正确 | 拳交 / fisting / フィスト 同义 |
| 34 | `pegging` | 女插男 | pegging | ペニバン | pegging, strapon, strap-on, ペニバン, 女插男(zhVal←pegging), 穿戴假具 | 正确 | 女插男 / pegging / strapon / ペニバン 同义 |
| 35 | `ntr` | 寝取 | netorare | 寝取られ | netorare, ntr, 寝取られ, 寝取(zhVal←netorare/ntr), 牛头人(zhVal←minotaur), ntr向 | 正确 | netorare/ntr/寝取 同义；「牛头人」是 zh 网络黑话，assets/dict/core.js 也这么登记（minotaur 的直译是巧合） |
| 36 | `netori` | 夺爱 | netori | 寝取り | netori, 寝取り, 夺爱(zhVal←netori), 横刀夺爱 | 正确 | 夺爱 / netori / 寝取り 同义（与 ntr 是不同视角，已各自成组） |
| 37 | `netorase` | 献妻 | netorase | 寝取らせ | netorase, 寝取らせ, 献妻(zhVal←netorase), 主动献妻 | 正确 | 献妻 / netorase / 寝取らせ 同义 |
| 38 | `cuckold` | 绿帽 | cuckold | 寝取られ男 | cuckold, cuckolding, 绿帽(zhVal←cuckold), 绿帽癖, 戴绿帽 | 正确 | 绿帽 / cuckold 同义。结构小疵：ja=寝取られ男 不在 aliases 里（不影响检索） |
| 39 | `cheating` | 出轨 | cheating | 浮気 | cheating, cheat, affair(ownZh=婚外情), 浮気, 出轨(zhVal←cheating), 不忠 | 正确 | 出轨 / cheating / 浮気 / affair 同义 |
| 40 | `rape` | 强暴 | rape | レイプ | rape, raped, non-consensual, レイプ, 强暴(zhVal←rape), 强奸, 性侵 | 正确 | 强暴 / rape / レイプ / non-consensual 同义 |
| 41 | `gangrape` | 轮奸 | gangbang | 輪姦 | gangbang, gang rape, 輪姦, 轮奸(zhVal←gangbang/gang rape), 轮暴 | 应拆分 | en=gangbang（群交）与 zh=轮奸 不是一回事（同意与否、参与者角色都不同）；输入「轮奸」在英文站会被换成 gangbang。**未改**：nhentai 限流（429）没拿到对照数据，先请维护者拍板 |
| 42 | `incest` | 乱伦 | incest | 近親相姦 | incest, 近親相姦, 乱伦(zhVal←incest), 近亲, 家族 | 存疑 | 「家族」是上位词（家族 ≠ 乱伦）；同组的 incest/近親相姦/乱伦 是对的 |
| 43 | `bondage` | 束缚 | bondage | 緊縛 | bondage, shibari(ownZh=绳缚), kinbaku, 緊縛, 束缚(zhVal←bondage), 捆绑, 绳缚(zhVal←shibari) | 存疑 | 「shibari/kinbaku/绳缚」是绳缚子类（TAG_ZH: shibari→绳缚），组以 bondage 为规范名 |
| 44 | `bdsm` | 虐恋 | bdsm | 調教 | bdsm, sm, sadomasochism, 調教, 虐恋(zhVal←bdsm), 调教(zhVal←sexual training) | 存疑 | ja=調教 与 BDSM 不严格同义；core.js 的 GENRES 里 bondage 组也含 bdsm，两处重叠 |
| 45 | `blindfold` | 眼罩 | blindfold | 目隠し | blindfold, 目隠し, 眼罩(zhVal←blindfold), 蒙眼 | 正确 | 眼罩 / blindfold / 目隠し 同义 |
| 46 | `gag` | 口塞 | gag | 猿轡 | gag, ball gag(ownZh=口球), muzzle, 猿轡, 口塞(zhVal←gag), 口球(zhVal←ball gag) | 应缩小 | 「ball gag/口球」是下位词（TAG_ZH: ball gag→口球） |
| 47 | `collar` | 项圈 | collar | 首輪 | collar, choker(ownZh=颈圈), 首輪, 项圈(zhVal←collar), 颈圈(zhVal←choker) | 正确 | 项圈 / choker / 首輪 同义 |
| 48 | `leash` | 牵绳 | leash | リード | leash, リード, 牵绳(zhVal←leash), 牵引绳 | 正确 | 牵绳 / leash / リード 同义 |
| 49 | `spanking` | 打屁股 | spanking | スパンキング | spanking, spank, スパンキング, 打屁股(zhVal←spanking), 掌掴 | 正确 | 打屁股 / spanking / スパンキング 同义 |
| 50 | `domination` | 支配 | domination | 支配 | domination, femdom(ownZh=女攻), maledom(ownZh=男攻), 支配(zhVal←domination), 女攻(zhVal←femdom), 男攻(zhVal←maledom), 主导 | 应拆分 | 「支配」是一般概念，组里塞了 femdom（女攻）与 maledom（男攻）这两个**相反**的具体概念，TAG_ZH 各自有独立翻译。另外 core.js 的 GENRES 里 femdom 是独立体裁，输入 femdom 会先命中 GENRES |
| 51 | `submission` | 服从 | submission | 服従 | submission, sub, femsub(ownZh=女受), malesub(ownZh=男受), 服従, 服从(zhVal←submission), 顺从 | 应拆分 | 同上：「服从」塞了 femsub（女受）与 malesub（男受）两个相反的具体概念（TAG_ZH 各自有独立翻译） |
| 52 | `hypnosis` | 催眠 | hypnosis | 催眠 | hypnosis, hypnotism, mind control(ownZh=精神控制), 催眠(zhVal←hypnosis), 催眠术, 精神控制(zhVal←mind control) | 正确 | 催眠 / hypnosis / mind control 在标签站上是同一批作品（「精神控制/洗脑」是它的子说法） |
| 53 | `mindbreak` | 精神崩坏 | mind break | 精神崩壊 | mind break, mindbreak, 精神崩壊, 精神崩坏(zhVal←mind break), 洗脑(zhVal←brainwashing) | 应缩小 | 「洗脑」在 TAG_ZH 里对应 brainwashing，而不是 mind break；assets/dict/core.js 又把「洗脑」指向 hypnosis → 两处口径不一致。未改（属跨文件的口径问题） |
| 54 | `timestop` | 时停 | time stop | 時間停止 | time stop(ownZh=时间停止), timestop, 時間停止, 时停, 时间停止(zhVal←time stop) | 正确 | 时停 / time stop / 時間停止 同义 |
| 55 | `exhibitionism` | 露出 | exhibitionism | 露出 | exhibitionism, exhibitionist, public nudity(ownZh=公共裸露), 露出(zhVal←exhibitionism), 暴露 | 存疑 | 「public nudity/公共裸露」是相关但不是同一标签；露出/exhibitionism 本身是对的 |
| 56 | `voyeurism` | 偷窥 | voyeurism | 盗撮 | voyeurism, voyeur, peeping, 盗撮, 偷窥(zhVal←voyeurism/peeping), 窥视, 偷看 | 正确 | 偷窥 / voyeurism / 盗撮 / peeping 同义 |
| 57 | `urination` | 放尿 | urination | 放尿 | urination, peeing, pee, 放尿(zhVal←urination/peeing), 排尿, 小便 | 正确 | 放尿 / urination / peeing 同义 |
| 58 | `omorashi` | 憋尿 | omorashi | おもらし | omorashi, desperation(ownZh=尿急), おもらし, 憋尿(zhVal←omorashi), 漏尿, 尿急(zhVal←desperation) | 应缩小 | 「desperation/尿急」是憋尿的下位状态（TAG_ZH: desperation→尿急） |
| 59 | `scat` | 粪便 | scat | スカトロ | scat, scatology, スカトロ, 粪便(zhVal←scat), 排泄 | 正确 | 粪便 / scat / スカトロ 同义 |
| 60 | `fart` | 放屁 | fart | おなら | fart, farting, おなら, 放屁(zhVal←fart), 屁 | 正确 | 放屁 / fart / おなら 同义 |
| 61 | `bestiality` | 兽交 | bestiality | 獣姦 | bestiality, animal sex, 獣姦, 兽交(zhVal←bestiality/zoophilia), 兽奸 | 正确 | 兽交 / bestiality / 獣姦 同义 |
| 62 | `tentacle` | 触手 | tentacle | 触手 | tentacle, tentacles, tentacle rape, 触手(zhVal←tentacle/tentacles), 触手責め | 正确 | 触手 / tentacle / 触手責め 同组没问题。提醒：输入「触手」实际命中 core.js 的 GENRES（key=monster），这个 CONCEPTS 组够不着触手 |
| 63 | `monster` | 怪物 | monster | モンスター | monster, orc(ownZh=兽人), goblin(ownZh=哥布林), モンスター, 怪物(zhVal←monster), 兽人(zhVal←orc/furry/anthro/kemono), 哥布林(zhVal←goblin), 魔物 | 应缩小 | 「怪物」里塞了 orc（兽人）与 goblin（哥布林）两个具体种族，TAG_ZH 各自有独立翻译。实测 nhentai monster 16150 / orc 2112 / goblin 2041 —— 输入 orc 会被换成 monster，混进一堆无关怪物 |
| 64 | `vore` | 吞食 | vore | 丸呑み | vore, unbirth(ownZh=胎内回归), 丸呑み, 吞食(zhVal←vore), 吞噬, 胎内回归(zhVal←unbirth) | 应缩小 | 「unbirth/胎内回归」是 vore 的一个子类（TAG_ZH: unbirth→胎内回归） |
| 65 | `guro` | 猎奇 | guro | グロ | guro, gore(ownZh=血腥), グロ, 猎奇(zhVal←guro), 血腥(zhVal←blood/gore), blood(ownZh=血腥) | 应缩小 | 「gore/血腥」「blood」是相近但不是同一标签（TAG_ZH: gore→血腥）；core.js 的 GENRES 里 guro 组同时含 ryona/gore，两处重叠 |
| 66 | `ryona` | 受虐 | ryona | リョナ | ryona, torture(ownZh=拷问), リョナ, 受虐(zhVal←ryona), 凌辱, 虐待 | 应缩小 | 「torture/拷问」是子类（TAG_ZH: torture→拷问）；注意 GENRES 的 guro 组也含 ryona |
| 67 | `slavery` | 奴隶 | slavery | 奴隷 | slavery, slave, 奴隷, 奴隶(zhVal←slave), 性奴 | 正确 | 奴隶 / slavery / 奴隷 同义 |
| 68 | `drugs` | 药物 | drugs | 薬物 | drugs, drug, aphrodisiac(ownZh=春药), 薬物, 药物(zhVal←drugs), 春药(zhVal←aphrodisiac) | 应缩小 | 「aphrodisiac/春药」是子类（TAG_ZH: aphrodisiac→春药） |
| 69 | `blackmail` | 胁迫 | blackmail | 脅迫 | blackmail, coercion, 脅迫, 胁迫(zhVal←blackmail), 要挟 | 正确 | 胁迫 / blackmail / 脅迫 同义 |
| 70 | `prostitution` | 卖淫 | prostitution | 売春 | prostitution, prostitute, brothel(ownZh=妓院), 売春, 卖淫(zhVal←prostitution), 妓女 | 应缩小 | 「brothel/妓院」是场所（TAG_ZH: brothel→妓院） |
| 71 | `sleeping` | 睡奸 | sleeping | 睡眠姦 | sleeping, sleep sex, unconscious(ownZh=昏迷), 睡眠姦, 睡奸(zhVal←sleeping), 昏迷(zhVal←unconscious) | 应缩小 | 「unconscious/昏迷」是状态，与「睡奸」不是同一标签；门槛已让输入 unconscious 发「昏迷」，实测 copymanga 睡奸 136 / 昏迷 51 且首条无关 —— 这个词的门槛结果反而更差，见报告「门槛代价」 |
| 72 | `slut` | 淫荡 | slut | ビッチ | slut, bitch, whore, ビッチ, 淫荡(zhVal←slut), 骚货 | 正确 | 淫荡 / slut / bitch / ビッチ 同义 |
| 73 | `virgin` | 处女 | virgin | 処女 | virgin, virginity, 処女, 处女(zhVal←virgin/virginity), 童贞 | 正确 | 处女 / virgin / 処女 同义 |
| 74 | `defloration` | 破处 | defloration | 処女喪失 | defloration, 処女喪失, 破处(zhVal←defloration), 初体验 | 正确 | 破处 / defloration / 処女喪失 同义 |
| 75 | `harem` | 后宫 | harem | ハーレム | harem, reverse harem(ownZh=逆后宫), ハーレム, 后宫(zhVal←harem), 逆后宫(zhVal←reverse harem) | 应缩小 | 「reverse harem/逆后宫」是另一类（TAG_ZH: reverse harem→逆后宫） |
| 76 | `orgy` | 群交 | orgy | 乱交 | orgy(ownZh=乱交), group sex, threesome(ownZh=三人行), 乱交(zhVal←orgy), 群交(zhVal←group sex), 多人 | 应缩小 | 「threesome/三人行」是子类（TAG_ZH: threesome→三人行）；orgy/乱交 本身同义 |
| 77 | `yuri` | 百合 | yuri | 百合 | yuri, lesbian(ownZh=女同), girls love, gl, 百合(zhVal←yuri), 女同(zhVal←lesbian) | 正确 | 百合 / yuri / lesbian / GL 同义 |
| 78 | `yaoi` | 耽美 | yaoi | ボーイズラブ | yaoi, bl, boys love, ボーイズラブ, 耽美(zhVal←yaoi), 男同(zhVal←gay) | 正确 | 耽美 / yaoi / BL / ボーイズラブ 同义 |
| 79 | `bara` | 壮汉耽美 | bara | バラ | bara(ownZh=肌肉耽美), gay manga, バラ, 壮汉耽美, 肌肉男同 | 正确 | 壮汉耽美 / bara / バラ 同义 |
| 80 | `loli` | 萝莉 | loli | ロリ | loli, lolicon(ownZh=萝莉控), ロリ, 萝莉(zhVal←loli), 萝莉控(zhVal←lolicon), 小女孩 | 应拆分 | 「lolicon/萝莉控」是偏好（对萝莉的性趣），不是「萝莉」本人；TAG_ZH 里 loli→萝莉、lolicon→萝莉控 是两条。**未改数据**：门槛已保证输入 lolicon 时 zh 槽发「萝莉控」，en/ja 槽仍会换成 loli（要不要拆组请拍板） |
| 81 | `shota` | 正太 | shota | ショタ | shota, shotacon(ownZh=正太控), ショタ, 正太(zhVal←shota), 正太控(zhVal←shotacon), 小男孩 | 应拆分 | 同上：shotacon/正太控 不是「正太」本人 |
| 82 | `futanari` | 扶他 | futanari | ふたなり | futanari, futa, dickgirl, ふたなり, 扶他(zhVal←futanari/dickgirl), 双性 | 正确 | 扶他 / futa / dickgirl / ふたなり 同义（TAG_ZH: dickgirl→扶他） |
| 83 | `trap` | 伪娘 | trap | 男の娘 | trap, otokonoko, tomgirl, crossdressing(ownZh=女装), 男の娘, 伪娘(zhVal←trap/tomgirl/otokonoko), 女装(zhVal←crossdressing) | 应拆分 | 「crossdressing/女装」是行为/装扮，与 trap（伪娘角色）不同；TAG_ZH: crossdressing→女装。门槛已保证 zh 槽发「女装」 |
| 84 | `genderbender` | 性转 | gender bender | 性転換 | gender bender, genderswap, gender transformation, 性転換, 性转(zhVal←gender bender), 变身(zhVal←transformation) | 正确 | 性转 / gender bender / genderswap / 性転換 同义 |
| 85 | `milf` | 熟女 | milf | 熟女 | milf, mature female(ownZh=成熟女性), mature woman, 熟女(zhVal←milf) | 正确 | **本次已修**：剔除 人妻 / 已婚女性 / married woman（那是婚姻状态），ja 由 人妻 改为 熟女。现在 milf/mature female/mature woman/熟女 四者同义 |
| 86 | `hitozuma` | 人妻 | 人妻 | 人妻 | 人妻, 已婚女性 | 保留原词不改写 | **本次新增**：人妻 = 已婚女性，与熟女拆开。HS.TAG_ZH 里查不到「人妻」的英文键（housewife=主妇、hotwife=淫妻、wife sharing=共享妻子 都不是），按「改写错比不改写更糟」的口径**三槽一律保留原词**：en/ja/zh 都填 人妻，实测各源发出的串就是 人妻 本身 |
| 87 | `pregnant` | 怀孕 | pregnant | 妊娠 | pregnant, pregnancy, impregnation(ownZh=播种), 妊娠, 怀孕(zhVal←pregnant), 孕妇, 播种(zhVal←impregnation) | 应缩小 | 「impregnation/播种」是行为（TAG_ZH: impregnation→播种），组以 pregnant 为规范名 |
| 88 | `lactation` | 泌乳 | lactation | 授乳 | lactation, breast milk(ownZh=母乳), 授乳, 泌乳(zhVal←lactation), 母乳(zhVal←breast milk), 喷乳 | 正确 | 泌乳 / lactation / breast milk / 母乳 同义 |
| 89 | `tomboy` | 假小子 | tomboy | ボク女 | tomboy, tomboyish, ボク女, 假小子(zhVal←tomboy), 男装女 | 正确 | 假小子 / tomboy / ボク女 同义 |
| 90 | `gyaru` | 辣妹 | gyaru | ギャル | gyaru, gal, ギャル, 辣妹(zhVal←gyaru) | 正确 | 辣妹 / gyaru / ギャル 同义 |
| 91 | `glasses` | 眼镜 | glasses | 眼鏡 | glasses, megane, 眼鏡, 眼镜(zhVal←glasses), めがね | 正确 | 眼镜 / glasses / megane / 眼鏡 同义 |
| 92 | `kemonomimi` | 兽耳 | kemonomimi | ケモミミ | kemonomimi, animal ears, cat ears(ownZh=猫耳), fox ears(ownZh=狐耳), ケモミミ, 兽耳(zhVal←kemonomimi/animal ears), 猫耳(zhVal←cat ears) | 应缩小 | 「cat ears/猫耳」「fox ears/狐耳」是具体耳型（TAG_ZH 各自有翻译），组以 kemonomimi（兽耳）为规范名 |
| 93 | `tail` | 尾巴 | tail | 尻尾 | tail, 尻尾, 尾巴(zhVal←tail), しっぽ | 正确 | 尾巴 / tail / 尻尾 同义 |
| 94 | `elf` | 精灵 | elf | エルフ | elf, エルフ, 精灵(zhVal←elf), 妖精(zhVal←fairy) | 应缩小（「妖精」应保留原词不改写） | 「妖精」在 TAG_ZH 里对应的是 fairy，不是 elf（且门槛只管 TAG_ZH 的**键**，管不到这种中文值别名）—— 正确做法是把 妖精 从 elf 组移出、让它原样发出（保留原词不改写）。**未改**：要给出独立的 en/ja 槽就得到 TAG_ZH 之外找词，先请维护者拍板。实测 copymanga 精灵 382 / 妖精 194 |
| 95 | `demon` | 恶魔 | demon | 悪魔 | demon, devil, succubus(ownZh=魅魔), 悪魔, 恶魔(zhVal←demon/devil), 魅魔(zhVal←succubus), 恶魔娘(zhVal←demon girl) | 应缩小 | 「succubus/魅魔」是具体种族（TAG_ZH: succubus→魅魔）。实测 nhentai demon 15956 / succubus 3374 |
| 96 | `vampire` | 吸血鬼 | vampire | 吸血鬼 | vampire, 吸血鬼(zhVal←vampire), ヴァンパイア | 正确 | 吸血鬼 / vampire / ヴァンパイア 同义 |
| 97 | `monstergirl` | 怪物娘 | monster girl | モンスター娘 | monster girl, モンスター娘, 怪物娘(zhVal←monster girl), 魔物娘 | 正确 | 怪物娘 / monster girl / モンスター娘 同义（与 monster 组不重叠） |
| 98 | `sizedifference` | 体型差 | size difference | 体格差 | size difference, giantess(ownZh=女巨人), miniguy(ownZh=小人), 体格差, 体型差(zhVal←size difference), 女巨人(zhVal←giantess), 小人(zhVal←miniguy) | 应缩小 | 「giantess/女巨人」「miniguy/小人」是具体题材（TAG_ZH 两者都有独立翻译），组以 size difference/体型差 为规范名。**实测最刺眼的一处**：nhentai 「size difference」只有 10 条，而 giantess 有 2816 条 —— 输入 giantess 在英文站等于把 99.6% 的结果丢掉。未改：拆出来要给 ja 槽一个新词（HS.TAG_ZH 不收日文），按「不要凭感觉造新词」留给维护者 |
| 99 | `schooluniform` | 校服 | school uniform | 制服 | school uniform, serafuku(ownZh=水手服), sailor uniform, 制服(zhVal←uniform), 校服(zhVal←school uniform/schoolgirl uniform), 水手服(zhVal←serafuku) | 应缩小 | 「serafuku/水手服」是子类（TAG_ZH: serafuku→水手服） |
| 100 | `gymuniform` | 运动服 | gym uniform | 体操服 | gym uniform, bloomers(ownZh=灯笼裤), buruma(ownZh=运动短裤), 体操服, 运动服(zhVal←gym uniform), 体育服 | 应缩小 | 「bloomers/灯笼裤」「buruma/运动短裤」是子类（TAG_ZH 各自有翻译） |
| 101 | `swimsuit` | 泳装 | swimsuit | 水着 | swimsuit, swimwear, bikini(ownZh=比基尼), school swimsuit(ownZh=死库水), 水着, 泳装(zhVal←swimsuit), 比基尼(zhVal←bikini), 死库水(zhVal←school swimsuit) | 应缩小 | 「bikini/比基尼」「school swimsuit/死库水」是子类（TAG_ZH 各自有翻译） |
| 102 | `maid` | 女仆 | maid | メイド | maid, maid outfit(ownZh=女仆装), メイド, 女仆(zhVal←maid), 女仆装(zhVal←maid outfit) | 正确 | 女仆 / maid / メイド 同义 |
| 103 | `kimono` | 和服 | kimono | 着物 | kimono, yukata(ownZh=浴衣), 着物, 和服(zhVal←kimono/japanese clothes), 浴衣(zhVal←yukata), 和装 | 应缩小 | 「yukata/浴衣」是子类（TAG_ZH: yukata→浴衣） |
| 104 | `chinadress` | 旗袍 | china dress | チャイナドレス | china dress, cheongsam, qipao, チャイナドレス, 旗袍(zhVal←china dress/cheongsam/qipao), 中国服 | 正确 | 旗袍 / china dress / cheongsam / qipao 同义 |
| 105 | `bunnygirl` | 兔女郎 | bunny girl | バニーガール | bunny girl, playboy bunny, バニーガール, 兔女郎(zhVal←bunny girl/bunnygirl) | 正确 | 兔女郎 / bunny girl / バニーガール 同义 |
| 106 | `stockings` | 丝袜 | stockings | ストッキング | stockings(ownZh=长袜), pantyhose(ownZh=连裤袜), thighhighs(ownZh=大腿袜), ストッキング, 丝袜, 长袜(zhVal←stockings), 大腿袜(zhVal←thighhighs), 连裤袜(zhVal←pantyhose) | 应缩小 | 「pantyhose/连裤袜」「thighhighs/大腿袜」是具体款式（TAG_ZH 各自有翻译）。门槛已让 zh 槽改发用户自己的词（长袜/连裤袜/大腿袜），不再一律换成「丝袜」 |
| 107 | `lingerie` | 内衣 | lingerie | 下着 | lingerie, underwear, bra(ownZh=胸罩), panties(ownZh=内裤), 下着, 内衣(zhVal←lingerie/underwear), 胸罩(zhVal←bra), 内裤(zhVal←panties) | 应缩小 | 「bra/胸罩」「panties/内裤」是子类（TAG_ZH 各自有翻译）。门槛已让 zh 槽改发「胸罩/内裤」 |
| 108 | `nude` | 裸体 | nude | 全裸 | nude, naked, completely nude(ownZh=全裸), undressing(ownZh=脱衣), 全裸(zhVal←completely nude), 裸体(zhVal←nude), 脱衣(zhVal←undressing) | 应缩小 | 「undressing/脱衣」是动作，不是「裸体」状态（TAG_ZH: undressing→脱衣） |
| 109 | `nun` | 修女 | nun | シスター | nun, シスター, 修女(zhVal←nun), 修道女 | 正确 | 修女 / nun / シスター 同义 |
| 110 | `witch` | 女巫 | witch | 魔女 | witch, 魔女, 女巫(zhVal←witch) | 正确 | 女巫 / witch / 魔女 同义 |
| 111 | `idol` | 偶像 | idol | アイドル | idol, アイドル, 偶像(zhVal←idol) | 正确 | 偶像 / idol / アイドル 同义 |
| 112 | `nurse` | 护士 | nurse | ナース | nurse, ナース, 护士(zhVal←nurse), 看护 | 正确 | 护士 / nurse / ナース 同义 |
| 113 | `twintails` | 双马尾 | twintails | ツインテール | twintails, twin tails, ツインテール, 双马尾(zhVal←twintails) | 正确 | 双马尾 / twintails / ツインテール 同义 |
| 114 | `ponytail` | 马尾 | ponytail | ポニーテール | ponytail, ポニーテール, 马尾(zhVal←ponytail), 单马尾 | 正确 | 马尾 / ponytail / ポニーテール 同义 |
| 115 | `fullcolor` | 全彩 | full color | フルカラー | full color, colored(ownZh=彩色), カラー, フルカラー, 全彩(zhVal←full color), 彩色(zhVal←colored) | 应缩小 | 「colored/彩色」比 full color 大（TAG_ZH: colored→彩色）。提醒：输入 full color/全彩 实际命中 core.js 的 GENRES，这个组够不着 |
| 116 | `uncensored` | 无修 | uncensored | 無修正 | uncensored, decensored(ownZh=去修), 無修正, 无修(zhVal←uncensored), 无码, 去修(zhVal←decensored) | 正确 | 无修 / uncensored / 無修正 同义（decensored/去修 是它的动词说法）。门槛把输入 decensored 的 zh 槽改成「去修」——这一条存疑，见报告「门槛代价」 |
| 117 | `censored` | 有修 | censored | 修正 | censored, mosaic censorship(ownZh=马赛克), 修正, 有修(zhVal←censored), 马赛克(zhVal←mosaic censorship), 有码 | 应缩小 | 「mosaic censorship/马赛克」是下位表现（TAG_ZH: mosaic censorship→马赛克） |
| 118 | `doujinshi` | 同人志 | doujinshi | 同人誌 | doujinshi, doujin(ownZh=同人), fanbook, 同人誌, 同人志(zhVal←doujinshi), 同人(zhVal←doujin) | 正确 | 同人志 / doujinshi / 同人誌 同义 |
| 119 | `oneshot` | 单篇 | oneshot | 読み切り | oneshot, one shot, short story(ownZh=短篇), 読み切り, 单篇(zhVal←oneshot), 短篇(zhVal←short story) | 正确 | 单篇 / oneshot / 読み切り 同义 |
| 120 | `anthology` | 选集 | anthology | アンソロジー | anthology, compilation(ownZh=合集), アンソロジー, 选集(zhVal←anthology), 合集(zhVal←compilation), 总集篇(zhVal←omnibus) | 正确 | 选集 / anthology / アンソロジー 同义；提醒 GENRES 里也有 anthology（key=anthology），会抢先 |
| 121 | `artbook` | 画集 | artbook | 画集 | artbook, art book, illustration book, 画集(zhVal←artbook), 原画集 | 正确 | 画集 / artbook / 画集 同义 |
| 122 | `webtoon` | 条漫 | webtoon | 縦読み | webtoon, long strip, longstrip, 縦読み, 条漫(zhVal←long strip/webtoon), 长条漫画 | 正确 | 条漫 / webtoon / long strip / 縦読み 同义 |

- 结论表覆盖检查：漏给的组 无；数据里多出的组 无
