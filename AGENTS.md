## Language

在本仓库新建或修改文档时默认使用中文；面向用户的回复也默认使用中文。用户明确要求其他语言，或交付物有指定语言约定时，按指定语言编写。

## Agent skills

### Issue tracker

本地需求与规格存放在 `.scratch/`；GitHub Actions 传入的 Issue 是该轮任务的需求来源。根据任务入口读取 `docs/agents/issue-tracker.md`；配置或排查云端 Codex 自动实现时读取 `docs/agents/github-actions.md`。

### Triage labels

Use the default labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo. See `docs/agents/domain.md`.


