# 仓库 skill 与 workflow 的执行约定

执行仓库内 `.agents/skills/` 的固定版本，来源及本地定制见 `UPSTREAM.json`；CI 不临时下载。同一份内容复制到 `.claude/skills/` 供 Claude Code 发现，两处必须一致（`pnpm test` 校验）。需求跟踪见 [issue-tracker.md](issue-tracker.md)，操作与恢复见 [github-actions.md](github-actions.md)。

## 阶段职责

- **拆票**：父 Spec 放在 GitHub Issue 正文，补充要求写评论。`agent:to-issues` 调用 `/to-tickets`，输出带稳定 key 和 blockedBy 的 slices。独立发布 job 校验需求未变化，自动创建原生子 Issue 与阻塞关系；无需审批标签。拆票不会启动实现。
- **实现**：`agent:implement` 调用 `/implement`，支持独立 Issue、子 Issue 和父需求。父需求按原生依赖逐票实施，共用一个分支和 Draft PR。每张子票成功推送后以 completed 关闭，下一票无需等待 PR 合并。
- **PR 文案**：实现会话在代码、检查及提交完成后调用 `/pr`。按 skill 的 Summary、Evidence、Merge Danger 模板写出中文 PR 元数据文件；证据来自实际执行，未运行的检查和人工 QA 如实注明。workflow 校验文件并创建或更新 PR。父需求共享 PR 始终包含 `Closes #父编号`，合并到 main 后由 GitHub 自动关闭父 Issue。
- **整体审查**：全部子票 completed 后调用 `/code-review`，比较基准为 main。上下文显式包含父 PRD、全部子票的正文、状态与评论，按整份需求验收；独立 Issue 按自身验收。审查可修复并提交并发布 COMMENT，完成后标记 PR Ready。
- **PR 反馈修改**：PR 评论后加 `agent:implement`；需要改代码时调用 `/implement`，workflow 发布提交与回复。
- **分支更新**：`agent:update-branch` 合并最新基准；有冲突才调用 Agent。

## QA 的当前边界

GitHub workflow 暂不接入 QA：`agent:qa`、`agent:qa-only` 的 workflow 和脚本已移除。`.agents/skills/qa-only` 与 `.agents/skills/qa` 仍保留，可在本地 Claude 会话中通过 `/qa-only` 执行只读验收，或用 `/qa` 在验收失败后批量修复并复验、全绿后做一次 CR。以后恢复入口时再补 workflow 和自动化测试。

## 规范与交付

新增、修改和审查代码统一读取根目录 [CODING_STANDARDS.md](../../CODING_STANDARDS.md)，领域词汇来自 `GLOSSARY.md`，相关决策来自 `docs/adr/`。完成前执行 `pnpm check` 并修复失败；CI 另外运行 `pnpm demo:test`。代码检查不代表人工 QA 已执行。

CR 的 runner、prompt 和 skill 使用 workflow 对应的固定版本；产品规范、代码及运行入口来自独立检出的 PR 工作目录。Agent 负责代码与提交；workflow 负责推送、PR、标签和评论。PR 仍由维护者决定合并。

## 调度

标签直接触发 workflow；每个 workflow 用 `concurrency` group 按 Issue 或 PR 串行，不同 Issue/PR 可以并行。没有持久队列或仓库级锁。同一父需求最多一个活动子票。`ready-for-agent` 只表示需求准备完成；`agent:queued` 表示依赖等待及执行授权。not_planned 不算依赖完成；失败需人工重新授权。接续依赖 `AGENT_PAT` 重新贴标签，见操作文档。