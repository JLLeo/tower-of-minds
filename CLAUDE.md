# Tower of Minds

## Workflow

功能开发遵循 grill → spec → tickets → implement → review 链路。完整流程见 `docs/agents/workflow.md`。

## Agent skills

### Issue tracker

Issues 和 specs 存放在 GitHub Issues，所有读写通过 `gh` CLI。See `docs/agents/issue-tracker.md`.

### Triage labels

使用五个 canonical triage roles 的默认 label 字符串，未做重命名。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context 布局：repo 根目录的 `CONTEXT.md` + `docs/adr/`。See `docs/agents/domain.md`.
