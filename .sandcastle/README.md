# Sandcastle 官方 GitHub Agent 流程

来源：[`mattpocock/sandcastle`](https://github.com/mattpocock/sandcastle/tree/ed8e7164e0a5d65a0a98c6917508b45cd2de89a8)，固定提交 `ed8e7164e0a5d65a0a98c6917508b45cd2de89a8`。`UPSTREAM.json` 记录上游原始文件的 SHA-256，许可证保存在 `LICENSE.sandcastle`。

`agent-workflows/` 和 `.github/workflows/agent-*.yml` 使用该提交的官方流程：Explore、Implement、Review、Implement PR、Update Branch。未引入 `sandcastle init` 的其他模板。

## 项目适配

- 用 `shared/common.ts` 的 `codexAgent()` 替换官方 `claudeAgent()`；沿用现有 ChatGPT 订阅登录、模型配置和会话目录，禁止 API Key 回退。
- `.github/actions/codex-auth-restore/`、`codex-auth-save/` 及 `.github/scripts/subscription.cjs` 负责恢复、加密回存登录。所有模型流程共用 workflow 级并发组，回存完成后才发布和触发下一轮。回存也在任务失败时尝试执行；不传递明文认证 artifact。
- 使用仓库锁定的 Node/pnpm、`pnpm build` 和 `pnpm typecheck`；相对导入增加 `.js`，并适配 `exactOptionalPropertyTypes`，兼容本项目 TypeScript 配置。
- 项目编码规范见 `CODING_STANDARDS.md`。阶段 prompt 和结构化输出沿用上游，不再固定拼接 skills 或运行自定义的双轴审查。

普通实现由 Agent 提交，workflow 推送并创建草稿 PR。项目扩展支持父需求按原生依赖逐票实施，当前子票及父需求正文、评论共同提供上下文。审查、反馈修改、冲突处理和 Explore 沿用“先工作，再恢复会话提取结果”的方式。Explore 的发布 job 校验计划后才写入 GitHub。

## 拆票与依赖扩展

参考 [`mattpocock/course-video-manager@1558f6f`](https://github.com/mattpocock/course-video-manager/tree/1558f6fe107c9aba7d51d251d3b89c7c17c04404) 的拆票 prompt 和标签入口，增加 `agent:to-issues`、`agent:publish-tickets`、`agent:queued`。新增脚本位于 `agent-workflows/tickets/`；prompt 使用英文，通过 `gh issue view` 读取 GitHub PRD，输出与参考仓库一致的 slices 字段，并增加稳定 key 与 blockedBy。

与参考仓库的直接创建、同分支累积总 PR 不同，本项目先发布计划评论等待人工批准，确定性发布原生子 Issue 与依赖，每票独立 PR，合并后推进。计划来源指纹、拓扑校验及发布幂等由脚本处理；订阅认证仍先回存再发布。研究与固定源码链接见[调查记录](../docs/notes/course-video-manager-ticket-workflows.md)。

依赖关闭后的队列转交、实现后检查和 PR 审查可通过内置 `GITHUB_TOKEN` 的 `workflow_dispatch` 自动接续；父需求子票接续需要 `AGENT_PAT`。配置 PAT 时沿用标签事件，避免同时 dispatch。内部实现入口复查执行标签，审查入口额外核验开放状态和同仓库 PR；认证恢复与回存仍使用现有的 Secret 配置。

旧的统一任务协议、同分支 PRD 累积实现、定时架构提案没有恢复。历史 Issue 和标签不自动删除。

配置和入口见 [GitHub Actions](../docs/agents/github-actions.md)。更新上游时对照现有适配和本节扩展迁移。
