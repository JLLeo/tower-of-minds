# Tower of Minds

一款以卡牌构筑为主体的 roguelike。玩家逐层攀爬一座被围困的高塔，对手是由 LLM 驱动、分属不同派系、各自带着目标行动的角色；部分卡牌在结算时会插入一次需要手上功夫的即时判定。

## Language

### World

**Tower**:
游戏世界：一座被围困的高塔，数个派系在其中彼此提防地争夺塔内之物。玩家是外来者。

**Floor**:
Tower 的一层，也是 Run 的推进单位。越往上，卷入派系争斗越深。

**Faction**:
Agent 的归属。Faction 之间存在天然的利益冲突——不是所有 Agent 都只想杀玩家。名册在 Run 开始时由 Generation 一次定死，贯穿整座 Tower：每个 Floor 的 Agent 都从同一份名册里来。

**Agent**:
Tower 中由 LLM 驱动、拥有自身目标与记忆的存在。区别于按固定脚本行动的东西——如果它的下一步不需要 LLM 决定，它就不是 Agent。
_Avoid_: NPC, bot, AI, 怪物, 敌人

**Player**:
玩家操作的那一个存在。Player 不是 Agent：他的行动由人决定，不由 LLM 决定。切片阶段 Player 没有身份，所有 Faction 对他的初始 Standing 都是 0。
_Avoid_: 角色, 主角, character

**Intent**:
Agent 为下一回合选定的行动。引擎先算出合法动作集，Agent 只从中挑选——Intent 永远是引擎已经认可的动作之一。

**Memory**:
Agent 记住的、关于玩家做过什么的结构化事实条目。在同一 Run 内跨 Encounter 持久，Run 结束即清空。玩家必须能在界面上查到它——看不见的 Memory 等于不存在。
_Avoid_: history, log, 上下文

**Standing**:
某个 Faction 对玩家的态度，由该派系相关的 Memory 推出。它累计、有阈值：跨过阈值才能拿到该派的高阶 Favor。把所有 Faction 的 Standing 都做成负数是一条真实的失败路径。
_Avoid_: 声望, reputation, 好感度

### Run

**Run**:
从进入 Tower 到死亡或登顶的一次完整游玩，目标时长 10–20 分钟。
_Avoid_: Game, session, 一局

**Encounter**:
一场多方混战。同场的少数几个 Agent 分属敌对 Faction，它们之间也在开打；玩家集火谁、放过谁，本身就是表态。Encounter 不是"玩家对一队敌人"。
_Avoid_: 战斗, battle, combat

**Generation**:
Run 开始时由 LLM 一次性产出该局的**局势**：有哪几个 Faction、它们因为什么结仇、各自想要什么。它不产出规则——卡池、数值、判定窗口在所有 Run 中固定不变。与 Agent 在 Run 过程中的决策是两回事，不要混用。
_Avoid_: 随机生成, procgen

### Play

**Card**:
玩家在 Run 中打出的最小行动单位，也是构筑的最小单位。

**Deck**:
玩家在当前 Run 中拥有的全部 Card 的集合，随 Run 推进而改变。

**Card Type**:
Card 的类别，决定它触发哪种 Execution Check 原型——盾牌是格挡时机，攻击是节奏连击，法术是蓄力。类别在手感上就可区分。

**Execution Check**:
Card 结算过程中插入的即时操作判定，其表现决定这次结算的强度。玩家的手上功夫在此进入 Encounter 的结果。每回合最多触发一次。
_Avoid_: QTE, 小游戏, minigame

**Execution Grade**:
一次 Execution Check 的结果档位：Miss / Good / Perfect。Miss 只是打折，不会反噬。

**Favor**:
Encounter 结束后，由玩家在场上偏袒过的 Faction 提供的 Card 奖励，分阶——高阶 Favor 需要 Standing 跨过阈值，且取决于你保下的该派 Agent 是否活着。构筑因此与站队绑定：你能拿到什么牌，取决于你帮了谁、帮得够不够彻底。
_Avoid_: 战利品, reward, drop

**Boss**:
Tower 顶层等待玩家的对手：Standing 最低的那个 Faction 的首领。它是 Agent，但牌组与能力固定——可学的是它有什么牌，不可预测的是它这次怎么选。Run 的验收考试：前面几层的站队与构筑选择在这里被一次性结算。

**Parley**:
一种稀有 Card Type：不造成伤害，而是直接改变某个 Faction 的 Standing——示好或挑拨。站队的主要动词是打谁放谁，Parley 是它的显式补充。
_Avoid_: 交涉牌, 外交
