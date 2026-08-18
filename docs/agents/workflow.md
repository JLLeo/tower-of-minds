# 开发流程

这份文档描述本仓库如何使用 [mattpocock skills](https://github.com/vinvcn/mattpocock-skills-zh-CN)（中文本地化版）从零推进一个功能。

Skills 安装在用户级目录 `~/.claude/skills/`，对所有仓库全局生效；但**配置是每仓库一份**，也就是 `CLAUDE.md` 的 `## Agent skills` 块和本目录下的 `issue-tracker.md`、`triage-labels.md`、`domain.md`。

---

## 阶段 0 — 每个新 repo 的一次性接线

```bash
gh repo create <name> --private --clone   # gh auth login 全局只需做一次
cd <name>
```

然后在 Claude Code 中运行：

```
/setup-matt-pocock-skills
```

> **顺序很关键**：先接好 git remote 再跑这个 skill。它读 `git remote -v` 来推断并推荐 issue tracker；没有 remote 时会退化为推荐 local markdown。

产出：`CLAUDE.md` 的 `## Agent skills` 块 + `docs/agents/{issue-tracker,triage-labels,domain}.md`。之后所有 skill 都从这里读取配置。

---

## 主链路

| # | 命令 | 做什么 | 产出 |
| --- | --- | --- | --- |
| 1 | `/grill-with-docs` | 追问式访谈，顺带建立领域文档 | 共同理解 + `CONTEXT.md` / ADR |
| 2 | `/to-spec` | 综合已讨论内容，**不再提问** | issue 形式的 spec，打 `ready-for-agent` |
| 3 | `/to-tickets` | 拆成 vertical slices 并声明依赖边 | 一组 issues |
| 4 | `/implement` | 按 ticket 实现 | 代码 + commit |
| 5 | `/code-review` | 双轴审查 | findings |

完成一个 ticket 后回到第 3 步的下一个 —— **frontier** 即所有 blocker 都已关闭的那些 ticket。

### 1. `/grill-with-docs` — 对齐

整套流程的核心。它把你的想法建成一棵 **design tree**，按 **round** 推进：每轮抛出一批编号问题，**每题附带推荐答案**，你答完才进入下一轮。

规则是「**事实归 agent，决策归你**」：任何能从 filesystem 或工具查到的事实，由 agent 派 sub-agent 自行确认，不占用你的注意力；只有真正的取舍才交给你。

当 **frontier 为空**（design tree 每个分支都走到底，没有任何被默默假设的东西）时才结束。在你确认达成共同理解之前，它不会动手。

不需要建领域文档时，可用更轻的 `/grill-me`。

### 2. `/to-spec` — 定稿

**不做访谈**，只综合当前对话与 codebase 理解。发布前会先与你确认打算在哪些 **test seams** 上测试 —— seam 越少越好，理想数量是一个，且优先复用现有 seam。

spec 模板固定：Problem Statement / Solution / User Stories / Implementation Decisions / Testing Decisions / Out of Scope / Further Notes。不写具体 file path 或 code snippet，因为它们很快过时。

### 3. `/to-tickets` — 拆解

拆分原则是 **tracer bullet**：

- 每个 ticket 是**竖切**（贯穿 schema → API → UI → tests 的窄而完整路径），不是横切某一层
- 完成后可独立 demo 或验证
- 大小必须塞得进一个 fresh context window
- prefactoring 排在最前

每个 ticket 显式声明 **blocking edges**。拆分方案会先以编号列表交给你审阅，你批准后才发布到 tracker。

**唯一例外是 wide refactor**（rename column、retype shared symbol 这类一次改动波及成千上万 call site 的机械变更）：不强行竖切，改走 **expand → migrate 分批 → contract**，靠旧形式暂留来保证每批 CI 都是 green。

### 4. `/implement` — 实现

传入 spec 或 ticket。它会：

- 尽量在预先约定的 seams 上使用 `/tdd`
- 定期 typecheck、定期跑单个测试文件，最后跑全量测试套件
- **完成后自动调用 `/code-review`**
- 提交到当前 branch

### 5. `/code-review` — 审查

需要一个 **fixed point**（commit SHA、branch、tag、`main`、`HEAD~5` 等），对 `git diff <fixed-point>...HEAD` 做双轴审查，两轴作为**并行 sub-agent** 运行以避免 context 互相污染：

- **Standards** —— 本仓库记录的编码规范，外加一组固定的 Fowler code smell 兜底基线（仓库自己的规范优先级更高）
- **Spec** —— 是否忠实实现了来源 issue / spec

---

## Skill 的两种调用方式

### User-invoked（只能人工敲，模型不会自动调用）

`/grill-me` `/grill-with-docs` `/to-spec` `/to-tickets` `/implement` `/triage` `/wayfinder`
`/handoff` `/ask-matt` `/teach` `/wait-what` `/to-questionnaire`
`/improve-codebase-architecture` `/setup-matt-pocock-skills`

> **主链路五步全部属于这一类** —— 不主动敲就不会发生。

### Model-invoked（人工可敲，agent 也会在合适时机自动调用）

`/tdd` `/code-review` `/domain-modeling` `/grilling` `/research` `/prototype`
`/diagnosing-bugs` `/codebase-design` `/resolving-merge-conflicts` `/setup-pre-commit`
`/git-guardrails-claude-code` `/wizard` `/writing-for-agents` `/scaffold-exercises`
`/migrate-to-shoehorn`

---

## 偏离主线的场景

| 场景 | 用什么 |
| --- | --- |
| 想法太大，单个 session 装不下 | `/wayfinder` —— 先在 tracker 上建 **decision map**，逐个解决「必须先定下来」的问题，路清晰后再进 `/to-spec` |
| 缺少外部事实 | `/research` —— 对照一手来源调研，结果存成仓库中的 markdown |
| 拿不准设计手感 | `/prototype` —— 一次性原型，只为回答一个设计问题 |
| 有人提了 issue 或 external PR | `/triage` —— 走五个 canonical role 的状态机 |
| 缺陷或性能回退 | `/diagnosing-bugs` |
| 模块接口需要重新设计 | `/codebase-design` |
| context 快满了要交接 | `/handoff` |

---

## 领域文档

`/domain-modeling` 不需要手动调用 —— 它由 `/grill-with-docs` 自动带起，并且**懒创建**：第一个术语被敲定时才创建 `CONTEXT.md`，第一个 ADR 需要出现时才创建 `docs/adr/`。

不要提前手写这些文件。消费规则见 [`domain.md`](./domain.md)。

---

## 最短起手式

新项目从零开始，实际只需主动敲三次：

```
/grill-with-docs     # 说一两句想法，然后老实回答追问
/to-spec             # 谈拢之后
/to-tickets          # spec 发布之后
```

此后每个 ticket 一轮 `/implement`。
