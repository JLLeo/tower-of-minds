# 跨 Run 持久的只有 Unlock Ledger

一个 Run 结束时，除了 Unlock Ledger（哪些 Base Card 可以进入 Loadout），其余一切都清空：
Memory、Standing、Deck、融合与突变的产物、Generation 给出的局势，全部不跨局。

写下这条是因为 Unlock Ledger 是这个项目第一次允许状态跨越 Run 边界，而这种口子一旦开了
就会自己变大——"顺便记一下上局的死因""顺便让 Boss 记得你"，每一条单独看都合理，合起来
就把 roguelike 变成了养成游戏。ADR-0003 已经明确拒绝过跨 Run 的 Memory，这条把同样的
拒绝扩展到其余一切，并且把唯一的例外写死。

例外之所以是 Unlock Ledger，是因为它解锁的只有 **Base Card**：进塔的起点仍然是一副由核心
Atom 组成的牌，融合与突变的产物永远留在产生它们的那一局。玩家跨局积累的是**选择的余地**，
不是**已经变强的牌**。

## Consequences

- 融合与突变的产物不能被带进下一个 Run，也不进 Unlock Ledger。
- 解锁条件与派系挂钩，因此重玩动机接在站队系统上，而不是另开一条平行的磨。
- 平衡要面对两个极端：新手的初始 Loadout，和全解锁玩家的 Loadout，塔里的对手要同时应付。
