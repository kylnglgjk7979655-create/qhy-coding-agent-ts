## Language

在本仓库新建或修改文档时默认使用中文；面向用户的回复也默认使用中文。用户明确要求其他语言，或交付物有指定语言约定时，按指定语言编写。

## 编码规范

新增、修改或审查代码前，读取并遵循 [编码规范](CODING_STANDARDS.md)。

## PR 提交门槛

- **GitHub Actions**：当 `GITHUB_ACTIONS=true` 且当前任务由仓库 workflow 的阶段 prompt 启动时，由 workflow 的发布步骤按阶段职责创建、更新或发布 PR，无需另行请求用户授权。
- **本地及来源无法确认的会话**：只有用户明确要求发 PR 时，Agent 才可创建或发布 PR。Draft PR 同样需要用户授权。

本地创建 PR 前，自动对分支 HEAD 运行仓库 PR Review（Claude Code 用 `/review-pr`，Codex 用 `$pr-review`）。GitHub Actions 中，`agent:implement` 交付实现和 Draft PR，`agent:review` 独立运行 PR Review 并负责将草稿标为 Ready。修复问题后对新的 HEAD 重跑，所有适用项通过后才可发布本地 PR 或将云端草稿标为 Ready。确实不适用的项记为 `SKIP` 并说明原因。

## 验证证据

- 涉及 UI 操作时，在运行中的界面执行受影响的流程，截取关键状态并对照预期检查截图。终端界面同样适用。
- 涉及端到端测试时，录制实际运行过程，覆盖从进入流程、执行操作到观察最终结果。
- 在对应 PR 评论中附上截图和录屏，或贴出审查者可以打开的链接。注明验证的提交、场景与结果。缺少适用的证据时报告 `BLOCKED` 并说明原因。云端交付证据由 `agent:review` 采集，workflow 发布。

## Agent skills

### Issue tracker

需求跟踪使用 GitHub Issues。查询、分诊或发布需求前读取 `docs/agents/issue-tracker.md`；配置或排查云端 Agent 自动实现时读取 `docs/agents/github-actions.md`。

### Triage labels

Use the default labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repo. See `docs/agents/domain.md`.

### 仓库内 skills

使用 `.agents/skills/` 的已固定版本，不在 CI 临时下载；同一内容复制到 `.claude/skills/` 供 Claude Code 发现，两处必须保持一致。执行仓库 skill 前读取 [项目执行适配](docs/agents/skill-execution.md)：其中规定技能调用、自动拆票、人工 QA 与 CI 发布职责。上游原文及引用文件保留原语言，项目适配使用中文。
