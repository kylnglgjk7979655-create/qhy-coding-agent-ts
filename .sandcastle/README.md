# Sandcastle 官方 GitHub Agent 流程

来源：[`mattpocock/sandcastle`](https://github.com/mattpocock/sandcastle/tree/ed8e7164e0a5d65a0a98c6917508b45cd2de89a8)，固定提交 `ed8e7164e0a5d65a0a98c6917508b45cd2de89a8`。`UPSTREAM.json` 记录上游原始文件的 SHA-256，许可证保存在 `LICENSE.sandcastle`。

`agent-workflows/` 和 `.github/workflows/agent-*.yml` 使用该提交的官方流程：Explore、Implement、Review、Implement PR、Update Branch。未引入 `sandcastle init` 的其他模板。

## 项目适配

- `shared/common.ts` 的 `codexAgent()` 使用 Codex 订阅，认证由 `.github/actions/codex-auth-restore/`、`codex-auth-save/` 与 `.github/scripts/subscription.cjs` 管理。
- 标签入口先写入持久队列，队列持有仓库级订阅锁串行分发。登录态回存成功后才推送和发布；失败时也尝试回存。
- 阶段 prompt 调用仓库固定版本的 `$to-tickets`、`$implement`、`$pr` 和 `$code-review`；项目规范统一在仓库根目录 `CODING_STANDARDS.md`。详细职责见 [skill-execution.md](../docs/agents/skill-execution.md)。
- `agent:qa-only` 是项目自定义的独立验收入口，阶段 prompt 显式调用 `$qa-only`。只读运行、发布报告和证据，不修复、不提交、不改变 PR Ready 状态。
- 默认交付流程为 implement → CR → Ready，不自动触发 QA。QA skill、workflow 和标签入口保留，维护者准备好验收环境后按需使用。
- `agent:qa` 沿用阶段 prompt 编排：QA、implement、CR subagent 分别调用对应 skill。验收和审查只返回结果，prompt 负责安排修复及复验。手动触发后，QA 通过才标记 Ready；同一问题达到三次修复上限时，报告保留次数和未解决问题。本地可用 `pnpm agent:qa`，不推送或发布。
- CR、QA 与 QA Only 保留 workflow 对应提交的 runner、依赖和 skill，在独立的 PR `worktree/` 中运行；旧 PR 无需包含新增的 QA 命令。
- 实现会话末尾用 `$pr` 编写文案，workflow 创建或更新 Draft PR；没有独立的 write-pr 模型会话。
- 父需求按原生依赖逐票实施，共享分支与 PR。整体审查读取父需求及全部子票；合并 PR 后关闭父 Issue。

## 拆票与依赖扩展

参考 [`mattpocock/course-video-manager@1558f6f`](https://github.com/mattpocock/course-video-manager/tree/1558f6fe107c9aba7d51d251d3b89c7c17c04404)，`agent:to-issues` 直接创建原生子 Issue，并保留本项目的稳定 key、blockedBy、来源指纹与幂等恢复。已取消独立 publish-tickets 审批入口；创建子票后仍由维护者给父 Issue 加 `agent:implement` 开始实现。

有 PAT 时通过标签转交；没有时由内置 Token 写入持久队列并 dispatch。队列请求保存于来源 Issue/PR 的状态评论，立即调度和五分钟定时扫描均可恢复等待请求。

定时架构提案未启用。配置、迁移与恢复见 [GitHub Actions](../docs/agents/github-actions.md)。旧调查结论保留在 [notes](../docs/notes/course-video-manager-ticket-workflows.md)，不作为当前操作步骤。
