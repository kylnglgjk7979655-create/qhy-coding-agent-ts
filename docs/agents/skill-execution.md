# 仓库 skill 与 workflow 的执行约定

执行仓库内 `.agents/skills/` 的固定版本，来源及本地定制见 `UPSTREAM.json`；CI 不临时下载。需求跟踪见 [issue-tracker.md](issue-tracker.md)，操作与恢复见 [github-actions.md](github-actions.md)。

## 阶段职责

- **拆票**：父 Spec 放在 GitHub Issue 正文，补充要求写评论。`agent:to-issues` 调用 `$to-tickets`，输出带稳定 key 和 blockedBy 的 slices。认证回存成功后，独立发布 job 校验需求未变化，自动创建原生子 Issue 与阻塞关系；无需审批标签。拆票不会启动实现。
- **实现**：`agent:implement` 调用 `$implement`，支持独立 Issue、子 Issue 和父需求。父需求按原生依赖逐票实施，共用一个分支和 Draft PR。每张子票成功推送后以 completed 关闭，下一票无需等待 PR 合并。
- **并行实现**：父 Issue 已有开放子任务及原生依赖时，可用 `agent:implement-spec` 调用仓库内 `implement-spec`、`tdd` 和 `code-review`，在单次 Codex 会话中并行委派子代理实施；该入口不拆票，也不调用逐票流程。它仍作为一个任务进入持久队列，仓库级订阅锁继续串行调度会话。
- **PR 文案**：实现会话在代码、检查及提交完成后调用 `$pr`。按 skill 的 Summary、Evidence、Merge Danger 模板写出中文 PR 元数据文件；证据来自实际执行，未运行的检查和人工 QA 如实注明。workflow 校验文件并创建或更新 PR。父需求共享 PR 始终包含 `Closes #父编号`，合并到 main 后由 GitHub 自动关闭父 Issue。
- **整体审查**：全部子票 completed 后排队调用 `$code-review`，比较基准为 main。上下文显式包含父 PRD、全部子票的正文、状态与评论，按整份需求验收；独立 Issue 按自身验收。审查可修复并提交并发布 COMMENT。implement 发起的整体审查成功后自动排队 `agent:qa`，QA 通过后才标记 Ready；手动添加 `agent:review` 的审查不接续 QA，保持审查后标记 Ready。
- **按需 QA Only**：同仓库开放 PR 添加 `agent:qa-only`，独立 prompt 显式调用固定的 `$qa-only`。Spec 沿用 parent issue、相关 sub-issues 的正文与评论，比较基准为 main；先生成 QA plan，再运行产品并保存证据。Agent 只验收和报告，workflow 发布结果与 artifact，不修复、不提交、不推送，也不改变 PR Ready 状态。该标签独立运行，不作为 implement 自动接续的入口。
- **QA**：PR 添加 `agent:qa`，或由 implement 发起的 CR 成功后自动接续；`pnpm agent:qa` 使用 QA 阶段 prompt，分别启动 QA、implement 和 CR subagent，在 fresh context 中显式运行 `$qa-only`、`$implement` 和 `$code-review`。QA 与 CR skill 只返回验收结果或 findings，修复由 prompt 交给 implement subagent；修改后再审查和复验。同一问题最多三次修复（含 CR 后修复），达到上限时在报告中写明未通过、尝试次数和剩余问题。Agent 提交修复；workflow 回存认证后推送、发布报告和证据，仅通过时标记 Ready；fail / blocked 保留报告并标记 blocked，不自动重试。本地命令不推送或发布。`implement-spec` 暂不接续此阶段。
- **PR 反馈修改**：PR 评论后加 `agent:implement`；需要改代码时调用 `$implement`，workflow 发布提交与回复。
- **分支更新**：`agent:update-branch` 合并最新基准；有冲突才调用 Agent。
- **Explore**：批量调查开放的 explore Issue，独立 apply job 校验、发布结论及转交。手动入口默认 dry-run。

## 规范与交付

新增、修改和审查代码统一读取根目录 [CODING_STANDARDS.md](../../CODING_STANDARDS.md)，领域词汇来自 `GLOSSARY.md`，相关决策来自 `docs/adr/`。完成前执行 `pnpm check` 并修复失败；CI 另外运行 `pnpm demo:test`。代码检查不代表人工 QA 已执行。

CR、QA 与 QA Only 的 runner、prompt 和 skill 使用 workflow 对应的固定版本；产品规范、代码及运行入口来自独立检出的 PR 工作目录。Agent 负责代码与提交；workflow 负责推送、PR、标签和评论。PR 仍由维护者决定合并，本次取消的是拆票审批和父 Issue 的单独关闭验收，不是 PR 合并控制。

## 调度

所有标签请求由持久队列保存，仓库级订阅锁串行执行认证恢复、模型运行、登录态回存及发布。普通 `agent:implement` 父需求最多一个活动子票；`agent:implement-spec` 可在单次锁定的会话内并行委派已有子任务。`ready-for-agent` 只表示需求准备完成；`agent:queued` 表示依赖等待及执行授权。not_planned 不算依赖完成；失败需人工重新授权。PAT 不可用或未配置时的处理见操作文档。
