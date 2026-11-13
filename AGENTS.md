## Language

在本仓库新建或修改文档时默认使用中文；面向用户的回复也默认使用中文。用户明确要求其他语言，或交付物有指定语言约定时，按指定语言编写。

## 编码规范

新增、修改或审查代码前，读取并遵循 [编码规范](CODING_STANDARDS.md)。

## Agent skills

### Issue tracker

需求跟踪使用 GitHub Issues。查询、分诊或发布需求前读取 `docs/agents/issue-tracker.md`；配置或排查云端 Codex 自动实现时读取 `docs/agents/github-actions.md`。

### Triage labels

Use the default labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo. See `docs/agents/domain.md`.

### 仓库内 skills

使用 `.agents/skills/` 的已固定版本，不在 CI 临时下载；同一内容复制到 `.claude/skills/` 供 Claude Code 发现，两处必须保持一致。执行仓库 skill 前读取 [项目执行适配](docs/agents/skill-execution.md)：其中规定技能调用、自动拆票、人工 QA 与 CI 发布职责。上游原文及引用文件保留原语言，项目适配使用中文。
