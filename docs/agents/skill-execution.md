# 仓库 skill 与官方 workflow 的执行约定

`.agents/skills/UPSTREAM.json` 固定 skill 来源和版本，上游原文完整保存；本地快照的用户定制单独记录在 `localSnapshots`。用户选择以 Sandcastle 官方 GitHub workflow 为准，继续使用 Codex 订阅；本文件据此替代旧的项目调度约定。

## 本地 skills

需求跟踪使用 GitHub Issues，操作约定见 [issue-tracker.md](issue-tracker.md)。手动调用 skills 时使用仓库固定版本，不在 CI 临时下载；领域词汇来自 `GLOSSARY.md`，相关决策来自 `docs/adr/`。

`ready-for-agent` 表示准备完成，不触发 GitHub 实现。`ready-for-human` 表示需要人工处理。本地规格编写、拆票和人工 QA 可以继续使用 skills；云端由固定 prompt 实现下述标签审批流程，不要求在无人值守运行中向用户发问。

## GitHub workflow

云端使用 `.sandcastle/agent-workflows/` 内固定版本的官方阶段脚本和 prompt，不固定拼接 skills，不添加自定义的 Standards/Spec 独立审查会话。各阶段 prompt 明确当前任务、项目上下文、验证和交付方式。

- 父 spec 放在 GitHub Issue 正文和评论。`agent:to-issues` 读取 GitHub 需求与代码，只生成待审批评论；`agent:publish-tickets` 是人工批准，确定性创建子任务和原生阻塞关系。
- `agent:implement` 支持独立 Issue、子 Issue 及父需求。父需求选择依赖已完成的子票，子票依次提交到同一分支和草稿 PR；全部完成后整体审查，不将整份父需求交给普通实现。
- `agent:queued` 持久化实现授权，直接前置 Issue 以 completed 关闭时检查并推进；前置票须以 completed 关闭；同一父需求的共享草稿 PR 不阻塞后续子票，其他开放实现 PR 仍阻塞。失败票留待人工重试，not_planned 不算完成，父需求不自动关闭。
- 实现、审查、反馈修改由 Agent 在当前分支提交；workflow 负责推送、PR、标签和评论。
- 普通实现不要求结构化 JSON；审查、反馈修改、冲突处理及 Explore 先完成工作，再恢复会话提取结果。拆票按参考仓库直接输出 slices，校验失败在同会话修正；计划来源指纹由包装脚本维护，不交给模型生成。
- Explore 批量只读调查，独立 apply job 校验并发布评论、转交标签和关闭重复 Issue；添加 `agent:explore` 即授权这一完整流程。手动入口默认 dry-run。
- 提交前按官方 prompt 运行 `pnpm typecheck` 和相关聚焦测试；推送实现分支前，`Agent Implement` 还会运行与 `Check` 相同的 `pnpm check` 和 `pnpm demo:test`。人工 QA 仍需人实际执行，代码检查不代表人工 QA 已通过。
- PR 审查发布 COMMENT 并标记 Ready，由人决定是否合并。普通实现 PR 的 `Closes #编号` 在合并时关闭 Issue。

Codex 订阅的认证恢复、刷新回存和串行使用保持现有适配，具体配置见 [github-actions.md](github-actions.md)。拆票与队列是在官方流程上恢复的有限扩展；旧的统一任务协议、外层提交发布、定时架构提案没有恢复。
