# Sandcastle 官方 GitHub Agent 流程

来源：[`mattpocock/sandcastle`](https://github.com/mattpocock/sandcastle/tree/ed8e7164e0a5d65a0a98c6917508b45cd2de89a8)，固定提交 `ed8e7164e0a5d65a0a98c6917508b45cd2de89a8`。`UPSTREAM.json` 记录上游原始文件的 SHA-256，许可证保存在 `LICENSE.sandcastle`。

`agent-workflows/` 和 `.github/workflows/agent-*.yml` 使用该提交的官方流程：Explore、Implement、Review、Implement PR、Update Branch。未引入 `sandcastle init` 的其他模板。

## 项目适配

- 用 `shared/common.ts` 的 `codexAgent()` 替换官方 `claudeAgent()`；沿用现有 ChatGPT 订阅登录、模型配置和会话目录，禁止 API Key 回退。
- `.github/actions/codex-auth-restore/`、`codex-auth-save/` 及 `.github/scripts/subscription.cjs` 负责恢复、加密回存登录。所有模型流程共用 workflow 级并发组，回存完成后才发布和触发下一轮。回存也在任务失败时尝试执行；不传递明文认证 artifact。
- 使用仓库锁定的 Node/pnpm、`pnpm build` 和 `pnpm typecheck`；相对导入增加 `.js`，并适配 `exactOptionalPropertyTypes`，兼容本项目 TypeScript 配置。
- 项目编码规范见 `CODING_STANDARDS.md`。阶段 prompt 和结构化输出沿用上游，不再固定拼接 skills 或运行自定义的双轴审查。

普通实现由 Agent 提交，workflow 推送并创建草稿 PR；有父 Issue 或子 Issue 的需求会被拒绝。审查、反馈修改、冲突处理和 Explore 沿用“先工作，再恢复会话提取结果”的方式。Explore 的发布 job 校验计划后才写入 GitHub。

现有 PRD 逐票实现、云端拆票与发布、依赖队列、定时架构提案、统一任务 JSON 协议均已退出执行链路。历史 Issue 和标签不自动删除，旧标签不再触发运行。

配置和入口见 [GitHub Actions](../docs/agents/github-actions.md)。更新上游时按上述适配项对照迁移，不重新引入额外任务框架。
