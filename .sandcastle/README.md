# Sandcastle 官方 GitHub Agent 流程

来源：[`mattpocock/sandcastle`](https://github.com/mattpocock/sandcastle/tree/ed8e7164e0a5d65a0a98c6917508b45cd2de89a8)，固定提交 `ed8e7164e0a5d65a0a98c6917508b45cd2de89a8`。`UPSTREAM.json` 记录上游原始文件的 SHA-256，许可证保存在 `LICENSE.sandcastle`。

`agent-workflows/` 和 `.github/workflows/agent-*.yml` 使用该提交的官方流程：Implement、Review、Implement PR、Update Branch。未引入 `sandcastle init` 的其他模板；Explore 与 implement-spec 入口已按项目需要移除。

## 项目适配

- `shared/common.ts` 的 `claudeAgent()` 使用官方 `sandcastle.claudeCode()`，通过 Anthropic 兼容端点（百度千帆 Token Plan）调用 Claude Code；认证只用 `ANTHROPIC_AUTH_TOKEN`，不使用订阅登录，也不回存登录态。
- 标签直接触发 workflow；每个 workflow 用 `concurrency` group 按 Issue 或 PR 串行，不同 Issue/PR 可以并行。同一父需求共享分支的子票通过 `AGENT_PAT` 重新贴 `agent:implement` 接续，没有持久队列或仓库级锁。
- 阶段 prompt 调用仓库固定版本的 `/to-tickets`、`/implement`、`/pr` 和 `/code-review`；项目规范统一在仓库根目录 `CODING_STANDARDS.md`。详细职责见 [skill-execution.md](../docs/agents/skill-execution.md)。
- 技能原文固定在 `.agents/skills/`，同时复制到 `.claude/skills/` 供 Claude Code 发现；两处内容必须一致（`pnpm test` 会校验）。根目录 `CLAUDE.md` 与 `AGENTS.md` 内容一致。
- QA 暂不接入 GitHub workflow：`agent:qa`、`agent:qa-only` 入口和脚本已移除，只保留 `.agents/skills/qa-only`（只读验收）与 `.agents/skills/qa`（验收失败后修复并复验）供本地 Claude 会话使用。
- CR 与分支更新保留 workflow 对应提交的 runner、依赖和 skill，在独立的 PR `worktree/` 中运行；旧 PR 无需包含新增命令。
- 实现会话末尾用 `/pr` 编写文案，workflow 创建或更新 Draft PR；没有独立的 write-pr 模型会话。
- 父需求按原生依赖逐票实施，共享分支与 PR。整体审查读取父需求及全部子票；合并 PR 后关闭父 Issue。

## 拆票与依赖扩展

参考 [`mattpocock/course-video-manager@1558f6f`](https://github.com/mattpocock/course-video-manager/tree/1558f6fe107c9aba7d51d251d3b89c7c17c04404)，`agent:to-issues` 直接创建原生子 Issue，并保留本项目的稳定 key、blockedBy、来源指纹与幂等恢复。创建子票后仍由维护者给父 Issue 加 `agent:implement` 开始实现。

`AGENT_PAT` 是必需配置：GITHUB_TOKEN 贴出的标签不会触发下游 workflow，父票接续、implement → CR 接续和依赖推进都依赖 PAT 重新贴标签。

配置、迁移与恢复见 [GitHub Actions](../docs/agents/github-actions.md)。旧调查结论保留在 [notes](../docs/notes/course-video-manager-ticket-workflows.md)。