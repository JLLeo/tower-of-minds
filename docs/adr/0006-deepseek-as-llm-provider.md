# LLM 供应商用 DeepSeek，但供应商本身是配置项

Agent 的每回合 Intent 决策走 `deepseek-v4-flash`，Run 开局的 Generation 走 `deepseek-v4-pro`。

选它的理由是成本差了一个数量级：按每 Run 约 250 次 Agent 调用估算，flash 约 $0.2–0.4 一局（开启 context caching 后约 $0.17），而同样规模用 Claude Opus 5 约 $5 一局。Intent 选择是"从合法动作集里挑一个 + 说一句台词"的小任务，配不上旗舰模型的单价；而这个游戏的成本是按回合线性增长的，单价差异会被放大 250 倍。DeepSeek 在国内直连，对 2.5 秒的回合预算也有实际帮助。

所有调用走一层薄适配器，模型 id 与供应商是配置项。DeepSeek 同时提供 OpenAI 与 Anthropic 两种 API 格式（`https://api.deepseek.com` / `https://api.deepseek.com/anthropic`），换供应商应该是改配置，不是改架构。

## Consequences

- DeepSeek 未文档化严格的 schema 约束解码，因此引擎**必须**校验返回的 Intent 是否落在合法动作集内，非法即退回启发式选择。ADR-0001 已经要求了这条退路，这里只是把它从可选变成必需。
- 峰时价是闲时的两倍（峰时为 UTC 01:00–04:00 与 06:00–10:00，即北京时间 09:00–12:00 与 14:00–18:00）——正好覆盖开发时段，估算成本时按峰时算。
- cache hit 的输入价约为 cache miss 的 1/31，所以"共享规则前缀 + 每 Agent 私有后缀"的 prompt 结构不是优化，是必须。
- 每回合的延迟没有官方承诺值，2.5 秒预算必须实测，不能假设。
