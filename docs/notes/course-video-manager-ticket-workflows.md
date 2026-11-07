# course-video-manager 拆票与依赖执行调查

调查日期：2026-11-07。研究对象为参考仓库默认分支 `main` 的固定提交 [`1558f6fe107c9aba7d51d251d3b89c7c17c04404`](https://github.com/mattpocock/course-video-manager/commit/1558f6fe107c9aba7d51d251d3b89c7c17c04404)。本文记录源实现和本仓库需求之间的区别，不代表本仓库已经交付这些能力。

## 结论

参考仓库提供 `agent:to-issues`、父 Issue 的 `agent:implement` 以及 `agent:queued`，但它没有 `agent:publish-tickets` 审批发布阶段。它的父需求执行方式是在同一分支按子 Issue 顺序累积提交，全部完成后审查一个总 PR。原生依赖队列用于独立 Issue 或父需求之间，明确拒绝直接给子 Issue 排队。因而“待审批计划 → 批准发布 → 子任务原生依赖 → 各 PR 合并后推进”需要在参考实现上扩展，不能描述为直接复用已有完整流程。来源见[拆票 workflow](https://github.com/mattpocock/course-video-manager/blob/1558f6fe107c9aba7d51d251d3b89c7c17c04404/.github/workflows/agent-to-issues-prd.yml)、[父需求实现 workflow](https://github.com/mattpocock/course-video-manager/blob/1558f6fe107c9aba7d51d251d3b89c7c17c04404/.github/workflows/agent-implement-prd.yml)及[队列约定](https://github.com/mattpocock/course-video-manager/blob/1558f6fe107c9aba7d51d251d3b89c7c17c04404/docs/agents/queued-promotion.md)。

## 拆票入口与计划发布

- `issues: labeled` 且标签为 `agent:to-issues` 时启动，拒绝已有子 Issue 的需求或本身属于子 Issue 的需求。
- Agent 获取父需求正文和评论、领域术语、ADR 及代码背景，输出结构化 `slices`；每项只有标题、行为描述和验收标准，没有原生依赖字段。
- 包装脚本立即按顺序创建 Issue，再读取新 Issue 的 REST 整数 ID，调用 `POST /repos/{owner}/{repo}/issues/{parent}/sub_issues`，请求体为 `sub_issue_id`。这里保存的是执行计划的结果，没有独立“等待审批的计划评论”。
- 脚本按数组顺序挂接子 Issue，顺序就是后续执行顺序；正文不包含自动关闭指令。

来源：[workflow](https://github.com/mattpocock/course-video-manager/blob/1558f6fe107c9aba7d51d251d3b89c7c17c04404/.github/workflows/agent-to-issues-prd.yml)、[结构化输出与创建脚本](https://github.com/mattpocock/course-video-manager/blob/1558f6fe107c9aba7d51d251d3b89c7c17c04404/.sandcastle/to-issues-prd/to-issues-prd.ts)、[拆票 prompt](https://github.com/mattpocock/course-video-manager/blob/1558f6fe107c9aba7d51d251d3b89c7c17c04404/.sandcastle/to-issues-prd/prompt.md)。

本地交互 skill 则要求先确认粒度、顺序和拆合，再发布；这是本地技能的人审步骤，并没有被云端拆票 workflow 实现。来源：[项目拆票 skill](https://github.com/mattpocock/course-video-manager/blob/1558f6fe107c9aba7d51d251d3b89c7c17c04404/.claude/skills/to-issues-project/SKILL.md)。

## 父需求实现和自动接续

给有子 Issue 的父需求添加 `agent:implement` 后，普通实现 workflow 静默跳过，由父需求 workflow 接手。只接受一层父子结构；子 Issue 不能再有子 Issue。每次取子 Issue API 顺序中的首个开放子任务，没有读取这些子任务的 `blockedBy`。来源：[普通实现的形状检测](https://github.com/mattpocock/course-video-manager/blob/1558f6fe107c9aba7d51d251d3b89c7c17c04404/.github/workflows/agent-implement.yml)、[父需求检测与选择](https://github.com/mattpocock/course-video-manager/blob/1558f6fe107c9aba7d51d251d3b89c7c17c04404/.github/workflows/agent-implement-prd.yml)。

每轮从已有 `agent/prd-*` 分支继续，否则从 `main` 创建；普通推送保留累积提交。完成本轮后 workflow 立即关闭该子 Issue，创建或复用总草稿 PR。还有开放子任务就用 `AGENT_PAT` 给父需求重新添加 `agent:implement`；全部关闭后才给总 PR 添加 `agent:review`。因此这里子任务关闭表示“代码已在集成分支”，并不表示它已经合并到默认分支。来源：[推送、关闭、PR 复用和接续步骤](https://github.com/mattpocock/course-video-manager/blob/1558f6fe107c9aba7d51d251d3b89c7c17c04404/.github/workflows/agent-implement-prd.yml)。

Agent 本轮只处理指定子任务，同时读取父需求和兄弟任务；不重写先前提交，不自行关闭或推送。脚本允许零新增提交，因为前轮可能已经完成该子任务。失败时标记父需求 `agent:blocked` 并记录当前子任务和运行链接；解决后重新添加父需求执行标签，从保留分支继续。来源：[实现 prompt](https://github.com/mattpocock/course-video-manager/blob/1558f6fe107c9aba7d51d251d3b89c7c17c04404/.sandcastle/implement-prd/prompt.md)、[Agent 包装脚本](https://github.com/mattpocock/course-video-manager/blob/1558f6fe107c9aba7d51d251d3b89c7c17c04404/.sandcastle/implement-prd/implement-prd.ts)、[失败处理](https://github.com/mattpocock/course-video-manager/blob/1558f6fe107c9aba7d51d251d3b89c7c17c04404/.github/workflows/agent-implement-prd.yml)。

## 原生依赖队列

参考队列只监听 `issues: closed`，忽略本次关闭原因是 `not_planned` 的事件。通过 GraphQL `blocking` 找到依赖当前已关闭 Issue 的开放任务，再读取各候选的 `blockedBy`、标签和父关系：

- 没有 `agent:queued` 或已经 `agent:in-progress`：跳过。
- 是子 Issue：移除排队，添加阻塞标签并评论，要求改为操作父需求。
- 尚有开放 blocker：继续等待。
- 已无开放 blocker：再次读取排队标签，然后移除排队、评论并添加 `agent:implement`。

队列由人手动加入，普通 implement 并不会替阻塞任务检查依赖或自动转为排队。正文中的依赖文字和父子关系不构成执行依赖。来源：[队列 workflow](https://github.com/mattpocock/course-video-manager/blob/1558f6fe107c9aba7d51d251d3b89c7c17c04404/.github/workflows/agent-promote-queued.yml)、[队列文档](https://github.com/mattpocock/course-video-manager/blob/1558f6fe107c9aba7d51d251d3b89c7c17c04404/docs/agents/queued-promotion.md)。

GitHub 官方 REST 同时支持 `GET/POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by`，新增请求体为 `issue_id`，值是 blocker 的 REST 整数 ID。读取有分页，最大每页 100；读写分别需要 Issues read/write 权限。不能把 Issue 编号或 GraphQL node ID 代入 `issue_id`。来源：[GitHub Issue dependencies 官方文档](https://docs.github.com/en/rest/issues/issue-dependencies)。

## 幂等、接续及限制

以下是从代码可直接推导出的实现限制，供适配时判断：

1. 拆票创建中途失败会留下部分子 Issue，下次因已有子 Issue 被拒绝；原 workflow 提示人工清理后重试，没有逐票发布幂等标记。来源：[创建循环](https://github.com/mattpocock/course-video-manager/blob/1558f6fe107c9aba7d51d251d3b89c7c17c04404/.sandcastle/to-issues-prd/to-issues-prd.ts)和[失败评论](https://github.com/mattpocock/course-video-manager/blob/1558f6fe107c9aba7d51d251d3b89c7c17c04404/.github/workflows/agent-to-issues-prd.yml)。
2. 形状检测多处将 API 错误回退为空列表或零，可能把未知形状当作独立票；可靠适配应在读取失败时停止。来源：[普通实现检测](https://github.com/mattpocock/course-video-manager/blob/1558f6fe107c9aba7d51d251d3b89c7c17c04404/.github/workflows/agent-implement.yml)。
3. 队列没有定时扫描；任务在 blocker 已关闭后才加入队列，不会单凭标签事件启动。GraphQL 连接只取前 100 项，没有翻页。来源：[队列 workflow](https://github.com/mattpocock/course-video-manager/blob/1558f6fe107c9aba7d51d251d3b89c7c17c04404/.github/workflows/agent-promote-queued.yml)。
4. 跳过 `not_planned` 只检查触发关闭事件；候选任务的其他 blocker 仅按是否开放计数。因此某 blocker 早先以未计划关闭，另一 blocker 后来完成，队列仍可能推进。若需求规定只接受真正完成，应逐个校验关闭原因。来源同上。
5. 重新读取排队标签不能提供原子锁；两个任务可能都读取到旧状态。参考文档依靠下游开放 PR 检查兜底，而非严格串行领取。来源：[竞态说明](https://github.com/mattpocock/course-video-manager/blob/1558f6fe107c9aba7d51d251d3b89c7c17c04404/docs/agents/queued-promotion.md)。
6. 接续标签用 `AGENT_PAT` 才能触发下游。回退 `GITHUB_TOKEN` 可以添加标签，但需要人重新添加标签才能继续。来源：[队列和父需求接续代码](https://github.com/mattpocock/course-video-manager/blob/1558f6fe107c9aba7d51d251d3b89c7c17c04404/.github/workflows/agent-implement-prd.yml)。

## 本仓库可采用的适配方向

这是针对用户当前需求的设计建议，区别于上述参考源码事实：

- 在 bot 评论中保存完整结构化计划及来源指纹；`agent:to-issues` 只写计划，不创建子任务。`agent:publish-tickets` 代表对当前有效计划的人工批准，发布前核验来源没有变化。
- 确定性发布子任务与原生 blocker 关系，为每票写可恢复标记；重试只补齐未完成的创建、挂接和关系步骤。
- 父需求 `agent:implement` 选择依赖已真正完成的子任务，禁止默认将父 spec 整体交给普通实现；子任务执行必须再次检查 blocker，防止直接贴标签绕过依赖。
- 若各子任务独立 PR，则应等待前置实现合并或明确完成人工交付后推进，不能复制参考实现的“提交到集成分支即关闭”语义。
- `agent:queued` 在贴标签时及后续完成事件中都可检查；定时扫描作补偿。统一处理并发、分页、失败和已存在 PR，保留本仓库订阅认证的串行恢复与回存。

## 无 AGENT_PAT 时的内部接续

2026-11-07 补充核验：GitHub 官方明确将 `workflow_dispatch`、`repository_dispatch` 列为 `GITHUB_TOKEN` 事件不启动新运行规则的例外，这两类事件会创建运行。因此本仓库可以保留人工标签入口，在自动接续时使用内部 `workflow_dispatch`，不因缺少 `AGENT_PAT` 就要求新增 PAT。普通标签事件仍不会因 `GITHUB_TOKEN` 自动接续。来源：[Triggering a workflow from a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow)。

调用为 `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches`，其中 workflow ID 可用文件名，正文必须给出 `ref`，可附声明过的 `inputs`。所需权限为 Actions write，调用 job 应声明 `permissions: actions: write`，目标 workflow 须声明 `workflow_dispatch`。来源：[Create a workflow dispatch event](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)。

事件要求目标 workflow 文件已经存在于默认分支，因此这项能力合入默认分支后才可作为正式标签链路使用。来源：[workflow_dispatch 事件要求](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)。

适配建议：内部 dispatch 只传稳定的 Issue 标识，执行前重新读取当前标签、原生阻塞关系和已有 PR，确保它仍属于用户批准执行的 queued/implement 队列；调度不得仅凭输入标识绕过审批，也不能同时使用 PAT 标签接续和 dispatch 为同一任务启动两次运行。

