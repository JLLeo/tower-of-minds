# Tower of Minds

一款卡牌构筑 roguelike。玩家带着一副基础牌攀爬一座被围困的高塔，对手是分属不同派系、由 LLM 驱动的心智；牌在塔内通过融合与突变长成这一局独有的样子，部分牌结算时需要一次手上功夫的即时判定。

## Language

### World

**Tower**:
游戏世界：一座被围困的高塔，数个派系在其中彼此提防地争夺塔内之物。玩家是外来者。

**Floor**:
Tower 的一层，也是 Run 的推进单位。越往上，卷入派系争斗越深。

**Faction**:
Agent 的归属，同时也是一套 Base Card 的来源——每个 Faction 有自己的牌、自己的性格、自己的融合偏好。Faction 之间存在天然的利益冲突，不是所有 Agent 都只想杀玩家。名册在 Run 开始时由 Generation 一次定死，贯穿整座 Tower。

**Combatant**:
Encounter 中的一个战斗单位。

**Agent**:
一个 Faction 的持久心智，由 LLM 驱动，拥有自身目标与 Memory，贯穿整座 Tower。它在战斗中选 Intent、在融合时决定取舍与命名、在层间为自己构筑——这些出自同一个心智，不是几套互不相干的系统。
_Avoid_: NPC, bot, AI, 怪物, 敌人

**Intent**:
Agent 为下一回合选定的行动。引擎先算出合法动作集，Agent 只从中挑选——Intent 永远是引擎已经认可的动作之一。

**Memory**:
Agent 记住的、关于玩家做过什么的结构化事实条目：既包括玩家偏袒过谁，也包括玩家在它面前打出过哪些牌。在同一 Run 内跨 Encounter 持久，Run 结束即清空。玩家必须能在界面上查到它——看不见的 Memory 等于不存在。
_Avoid_: history, log, 上下文

**Standing**:
某个 Faction 对玩家的态度，由该派系相关的 Memory 推出。它累计、有阈值：跨过阈值才能拿到该派的高阶 Favor，也就是融合的机会。把所有 Faction 的 Standing 都做成负数是一条真实的失败路径。
_Avoid_: 声望, reputation, 好感度

### Run

**Run**:
从进入 Tower 到死亡或登顶的一次完整游玩，6 个 Floor，目标时长约 25 分钟。
_Avoid_: Game, session, 一局

**Encounter**:
一场多方混战。同场的少数几个 Combatant 分属敌对 Faction，它们之间也在开打；玩家集火谁、放过谁，本身就是表态。Encounter 不是"玩家对一队敌人"。
_Avoid_: 战斗, battle, combat

**Generation**:
Run 开始时由 LLM 一次性产出该局的**局势**：这座塔叫什么、Faction 之间因为什么结仇、各自想要什么。名册的**机械身份**（Faction 的 id）是固定的——Base Card 按 id 分组，改 id 会把牌池打散；变的只是名字、脾气、诉求与那条过节。它不产出规则——Atom 表、Base Card、判定窗口在所有 Run 中固定不变。
_Avoid_: 随机生成, procgen

**Boss**:
Tower 顶层等待玩家的对手：Standing 最低的那个 Faction 的首领。它是 Agent，但牌组与能力固定——可学的是它有什么牌，不可预测的是它这次怎么选。Run 的验收考试。

### Play

**Atom**:
效果的最小单位，也是这个游戏全部内容的来源。每个 Atom 有固定的效果与权重，Card 的费用由它所含 Atom 的权重推出。LLM 可以组合 Atom，永远不能发明 Atom。

**Forbidden Atom**:
只有 Mutation 能拿到的 Atom。权重为负，因此突变产物更强也更便宜，代价写在效果里。
_Avoid_: 诅咒, 负面原子

**Card**:
玩家打出的最小行动单位，由至多 4 个 Atom 组成。

**Base Card**:
只由核心 Atom 组成、可以带进 Run 的 Card。每个 Faction 约 10 张。融合与突变的产物不是 Base Card——它们只属于产生它们的那一局。

**Card Type**:
Card 的类别，由它的主导 Atom 推出，决定它触发哪种 Execution Check 原型——盾牌是格挡时机，攻击是节奏连击，法术是蓄力。类别在手感上就可区分。

**Deck**:
玩家在当前 Run 中拥有的全部 Card，随 Run 推进而改变。

**Loadout**:
进塔前从已解锁的 Base Card 中组好的那副牌，只能取自单个 Faction。它是 Deck 的起点。
_Avoid_: 起始牌组, preset

**Execution Check**:
Card 结算过程中插入的即时操作判定，其表现决定这次结算的强度。玩家的手上功夫在此进入 Encounter 的结果。每回合最多触发一次。

三种原型共用同一条规则：**在若干个指定时刻各按一次**，按得多准决定档位。差别在按几次、按在哪——格挡按一次，节奏连击按三次，蓄力按两次且中间要忍住。容差是每个原型自己的：它不能宽到把相邻的拍子连成一片。
_Avoid_: QTE, 小游戏, minigame

**Execution Grade**:
一次 Execution Check 的结果档位：Miss / Good / Perfect。Miss 只是打折，不会反噬。

判定轴的三个 Atom 改的正是这一步，因此 Execution Check 是构筑的一部分而不是平行系统：`steady` 放宽窗口，`focus` 把 Perfect 的倍率从 1.5 提到 2.0，`reflex` 把 Miss 兜成 Good（但兜不出 Perfect）。手不稳的人堆前两者，手稳的人堆 `focus`——同一套牌，两种玩法。

**Favor**:
Encounter 结束后，由玩家留下来的那一方提供的报酬：若干张可选的 Card，外加替他处理伤口。给多少取决于这一方还剩几个人。分阶——高阶 Favor 不是给一张牌，而是给一次 Fusion 的机会，所以融合是忠诚的回报，不是随手可得的东西。
_Avoid_: 战利品, reward, drop

**Fusion**:
把高阶 Favor 给出的 Card 与 Deck 中的一张合并成一张新 Card：Atom 合并，费用按权重重算。超过 4 个 Atom 时必须丢弃一个，由提供融合的那个 Faction 的 Agent 决定丢哪个、新卡叫什么——同样两张牌，找不同派系融，会得到不同的牌。
_Avoid_: 合成, craft

**Mutation**:
Fusion 超过 Atom 上限时，选择不丢弃而过载的结果。产物至少含一个 Forbidden Atom，由该 Faction 的 Agent 挑选。这是通往 Forbidden Atom 的唯一途径。
_Avoid_: 进化, 异变

**Parley**:
一种稀有 Card：不造成伤害，而是直接改变某个 Faction 的 Standing。站队的主要动词是打谁放谁，Parley 是它的显式补充。
_Avoid_: 交涉牌, 外交

**Player**:
玩家操作的那一个存在。Player 不是 Agent：他的行动由人决定，不由 LLM 决定。
_Avoid_: 角色, 主角, character

### Progression

**Unlock Ledger**:
跨 Run 唯一持久的东西：记录哪些 Base Card 可以进入 Loadout。它靠与派系相关的成就增长，因此想解锁就得去尝试不同的站队。除它之外没有任何东西跨 Run 保留。
_Avoid_: 存档, 图鉴, meta 进度
