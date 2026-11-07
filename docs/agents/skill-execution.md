# 仓库 skill 与官方 workflow 的执行约定

`.agents/skills/UPSTREAM.json` 固定 skill 来源和版本，上游原文完整保存；本地快照的用户定制单独记录在 `localSnapshots`。用户选择以 Sandcastle 官方 GitHub workflow 为准，继续使用 Codex 订阅；本文件据此替代旧的项目调度约定。

## 本地 skills

本地需求仍放在 `.scratch/`，布局见 [issue-tracker.md](issue-tracker.md)。手动调用 skills 时使用仓库固定版本，不在 CI 临时下载；领域词汇来自 `GLOSSARY.md`，相关决策来自 `docs/adr/`。

`ready-for-agent` 表示准备完成，不触发 GitHub 实现。`ready-for-human` 表示需要人工处理。本地规格编写、拆票和人工 QA 可以继续使用 skills，但不再对应自动发布工单或 PRD 逐票执行的云端入口。

## GitHub workflow

云端使用 `.sandcastle/agent-workflows/` 内固定版本的官方阶段脚本和 prompt，不固定拼接 skills，不添加自定义的 Standards/Spec 独立审查会话。各阶段 prompt 明确当前任务、项目上下文、验证和交付方式。

- 普通实现只接受独立 Issue；有父 Issue 或子 Issue 时按官方 MVP 拒绝。
- 实现、审查、反馈修改由 Agent 在当前分支提交；workflow 负责推送、PR、标签和评论。
- 普通实现不要求结构化 JSON；其他阶段先完成工作，再恢复会话提取结果。
- Explore 批量只读调查，独立 apply job 校验并发布评论、转交标签和关闭重复 Issue；添加 `agent:explore` 即授权这一完整流程。手动入口默认 dry-run。
- 提交前按官方 prompt 运行 `pnpm typecheck` 和相关聚焦测试；完整项目验证由 `Check` 执行。人工 QA 仍需人实际执行，代码检查不代表人工 QA 已通过。
- PR 审查发布 COMMENT 并标记 Ready，由人决定是否合并。普通实现 PR 的 `Closes #编号` 在合并时关闭 Issue。

Codex 订阅的认证恢复、刷新回存和串行使用是模型适配，具体配置见 [github-actions.md](github-actions.md)。旧的统一任务协议、外层提交发布、PRD 调度、云端拆票确认、依赖队列和定时架构提案均已移除。
