# 一个 Faction 一个持久 Agent，所有 kind 共用一条管道

一个 Faction 对应一个持久 Agent：一份 Memory、一个性格、一个目标，贯穿整座 Tower。
它在战斗中选 Intent、在 Fusion 时决定取舍与命名、在层间为自己构筑——这几件事必须出自
**同一个心智**，否则玩家感受到的是几个不相干的系统，而不是一个对手。

机制上这是把已有的东西泛化一次，不是重写：

```
引擎  ->  AgentRequest[]（kind: intent | fusion | deckbuild | ...）
宿主  ->  按 (agent, kind) 组 prompt，调 provider，把响应原样送回
引擎  ->  按 kind 校验、非法即按 kind 回退到确定性选择
```

`IntentRequest -> intent_response -> 三条回退` 就是这条管道的第一个 kind。增加一个 AI 角色
等于增加一个 kind、一个校验器、一个确定性回退；suspend / validate / fallback 只写一次。
ADR-0001 的边界原样适用于每一种 kind——LLM 永远只在引擎给出的合法集里选。

Prompt 分三段，正好吃满 context cache：全局前缀（规则 + Atom 表 + Base Card）对所有 Agent
所有 kind 一致，Agent 段（性格 + 目标 + Memory）本局内共用，任务段每次不同。

## Considered Options

- **每个角色一个独立 Agent**（战斗 AI、融合 AI、构筑 AI）——被拒绝：它们会各说各话，
  玩家分辨不出那是一个对手还是一堆功能。
- **每个 Combatant 一个 Agent**——被拒绝：切片里每层只有 2–3 个单位，个体级记忆太稀薄，
  玩家感受不到累积；Faction 级则每一层都在加厚同一个对手。代价是同派单位之间不会内讧。

## Consequences

- 后来的人很容易把四个角色拆成四个独立系统，那会静默地毁掉这条设计。拆之前先读这条。
- 每种 kind 都必须有一个确定性回退，否则模型不可用时该角色会卡住整个 Run。
